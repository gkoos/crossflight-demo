import express from 'express'
import { caching } from 'cache-manager'
import { redisInsStore } from 'cache-manager-ioredis-yet'
import { Redis } from 'ioredis'
import { fetch } from 'undici'
import { createCrossflight } from 'crossflight'
import type { CrossflightEvent } from 'crossflight'
import { cacheManagerAdapter } from 'crossflight/adapters/cache-manager'
import { redisCoordinator } from 'crossflight/coordinators/redis'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
const UPSTREAM_URL = process.env.UPSTREAM_URL ?? 'http://localhost:3001'
const PORT = process.env.PORT ?? 3000
const TTL_MS = Number(process.env.TTL_MS ?? 10_000)
const INSTANCE_ID = process.env.INSTANCE_ID ?? Math.random().toString(36).slice(2, 6)

/**
 * This instance's own view of one cache key, served on GET /stats. Every number
 * is either counted while the request is handled (`requests`, `loaderRuns`,
 * `bypassed`) or taken from a Crossflight event, so the load demo can report the
 * round from the instances' side instead of inferring it from timings.
 */
interface KeyCounters {
  /** Requests handled here through Crossflight. */
  requests: number
  /** Flights opened here because the cache had nothing (event: `miss`). */
  flights: number
  /** Flights that acquired the lease and ran a loader here (event: `ownership_acquired`). */
  ownedFlights: number
  /** Flights that found another instance owning the key (event: `distributed_join`). */
  waitingFlights: number
  /** Requests served straight from the cache, with no wait (event: `hit`, `waitedMs` 0). */
  cacheHits: number
  /** Requests that joined a flight already open here (event: `local_join`). */
  sharedInProcess: number
  /** Loader executions started here, counted at the loader itself. */
  loaderRuns: number
  /** Duration of the last loader execution here, in ms. */
  loaderMs: number
  /** Longest distributed wait reported for the key, in ms. */
  waitedMs: number
  /** Requests that skipped Crossflight on purpose (control runs). */
  bypassed: number
  /** Flights that ended in an error here (event: `failed`). */
  failures: number
}

const emptyCounters = (): KeyCounters => ({
  requests: 0,
  flights: 0,
  ownedFlights: 0,
  waitingFlights: 0,
  cacheHits: 0,
  sharedInProcess: 0,
  loaderRuns: 0,
  loaderMs: 0,
  waitedMs: 0,
  bypassed: 0,
  failures: 0,
})

const countersByKey = new Map<string, KeyCounters>()

const countersFor = (key: string): KeyCounters => {
  let counters = countersByKey.get(key)

  if (!counters) {
    counters = emptyCounters()
    countersByKey.set(key, counters)
  }

  return counters
}

const log = (tag: string, key: string, note: string) => {
  console.log(`[api:${INSTANCE_ID}] ${tag.padEnd(10)} key=${key} — ${note}`)
}

/** One log line per Crossflight event, which is also what feeds the counters. */
const recordEvent = (event: CrossflightEvent): void => {
  const counters = countersFor(event.key)

  switch (event.type) {
    case 'hit': {
      const waitedMs = event.waitedMs ?? 0

      if (waitedMs > 0) {
        counters.waitedMs = Math.max(counters.waitedMs, waitedMs)
        log('CACHE HIT', event.key, `another instance filled it after ${waitedMs}ms`)
      } else {
        counters.cacheHits += 1
        log('CACHE HIT', event.key, 'served from the cache')
      }
      break
    }

    case 'miss':
      counters.flights += 1
      log('CACHE MISS', event.key, 'nothing cached, opening a flight')
      break

    case 'local_join':
      counters.sharedInProcess += 1
      log('SHARED', event.key, 'joining the flight already open in this process')
      break

    case 'distributed_join':
      counters.waitingFlights += 1
      log('WAITING', event.key, 'another instance owns the flight')
      break

    case 'ownership_acquired':
      counters.ownedFlights += 1
      log('OWNER', event.key, 'acquired the lease, running the loader')
      break

    case 'completed': {
      const waitedMs = event.waitedMs ?? 0
      counters.waitedMs = Math.max(counters.waitedMs, waitedMs)
      const waited = waitedMs > 0 ? `, waited ${waitedMs}ms first` : ''
      log('COMPLETED', event.key, `flight finished in ${event.durationMs}ms${waited}`)
      break
    }

    case 'failed':
      counters.failures += 1
      log('FAILED', event.key, `error=${String(event.error)}`)
      break

    case 'fallback':
      log('FALLBACK', event.key, `coordination failed (${String(event.reason)}), loading anyway`)
      break

    case 'wait_exhausted':
      log('GAVE UP', event.key, `still contended after ${event.attempts} waits`)
      break

    case 'cancelled':
      log('CANCELLED', event.key, `reason=${String(event.reason)}`)
      break

    case 'renewal_failed':
      log('LEASE LOST', event.key, `error=${String(event.error)}`)
      break
  }
}

async function main() {
  // --- Cache (cache-manager backed by Redis via ioredis) ---
  const cacheRedis = new Redis(REDIS_URL)
  const cacheStore = await caching(redisInsStore(cacheRedis, { ttl: TTL_MS }))

  // --- Coordinator (separate Redis connection for crossflight leases) ---
  const coordinatorRedis = new Redis(REDIS_URL)
  const coordinator = redisCoordinator(coordinatorRedis, { namespace: 'demo:coord' })

  // --- Crossflight ---
  const crossflight = createCrossflight({
    cache: cacheManagerAdapter(cacheStore),
    coordinator,
    defaultTtlMs: TTL_MS,
    onEvent: recordEvent,
  })

  // --- Express ---
  const app = express()

  app.get('/product/:id', async (req, res) => {
    const { id } = req.params
    const key = `product:${id}`
    const counters = countersFor(key)

    // Facts about this one request: whether its own loader produced the value
    // (so this response paid for the upstream call) and how long that took.
    let ranLoader = false
    let loaderMs = 0

    const loadProduct = async (signal?: AbortSignal) => {
      ranLoader = true
      const startedAt = Date.now()

      try {
        const response = await fetch(`${UPSTREAM_URL}/product/${id}`, {
          signal,
          // Names the process that did the fetching, so the value itself says
          // which instance its single loader execution belonged to.
          headers: { 'x-instance': INSTANCE_ID },
        })

        if (!response.ok) {
          throw new Error(`upstream ${response.status} for product ${id}`)
        }

        return await response.json()
      } finally {
        loaderMs = Date.now() - startedAt
        counters.loaderRuns += 1
        counters.loaderMs = loaderMs
      }
    }

    try {
      let product: unknown

      if (req.get('x-no-coalescing') === '1') {
        // Control run: the same stack with crossflight.wrap() skipped, so every
        // request fetches for itself. The upstream call count it produces is
        // the baseline the coalesced run is measured against.
        counters.bypassed += 1
        log('BYPASS', key, 'coalescing switched off for this request')
        product = await loadProduct()
      } else {
        counters.requests += 1
        product = await crossflight.wrap(key, loadProduct)
      }

      res.json({
        instance: INSTANCE_ID,
        ranLoader,
        loaderMs: ranLoader ? loaderMs : undefined,
        product,
      })
    } catch (error) {
      console.error(`[api:${INSTANCE_ID}] error for product ${id}:`, error)
      res.status(502).json({ error: String(error) })
    }
  })

  app.get('/healthz', (_req, res) => res.json({ ok: true, instance: INSTANCE_ID }))

  // This instance's own counters. The load demo reads them through nginx's
  // /instances/<name>/ routes, so one round can be reported per instance.
  //
  // `?reset=1` clears the counters after reading them, which is how the load
  // demo makes each round start from zero; a plain read changes nothing.
  app.get('/stats', (req, res) => {
    const keys = Object.fromEntries(countersByKey)

    if (req.query.reset === '1') {
      countersByKey.clear()
    }

    res.json({ instance: INSTANCE_ID, cacheTtlMs: TTL_MS, keys })
  })

  const server = app.listen(PORT, () => {
    console.log(`[api:${INSTANCE_ID}] listening on :${PORT}`)
    console.log(`[api:${INSTANCE_ID}] upstream=${UPSTREAM_URL} redis=${REDIS_URL} ttl=${TTL_MS}ms`)
  })

  process.on('SIGTERM', async () => {
    console.log(`[api:${INSTANCE_ID}] shutting down`)
    server.close()
    await crossflight.close()
    cacheRedis.disconnect()
    coordinatorRedis.disconnect()
    process.exit(0)
  })
}

main().catch(error => {
  console.error('Failed to start:', error)
  process.exit(1)
})
