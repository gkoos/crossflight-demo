import express from 'express'
import { caching } from 'cache-manager'
import { redisInsStore } from 'cache-manager-ioredis-yet'
import { Redis } from 'ioredis'
import { fetch } from 'undici'
import { createCrossflight } from 'crossflight'
import { cacheManagerAdapter } from 'crossflight/adapters/cache-manager'
import { redisCoordinator } from 'crossflight/coordinators/redis'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
const UPSTREAM_URL = process.env.UPSTREAM_URL ?? 'http://localhost:3001'
const PORT = process.env.PORT ?? 3000
const TTL_MS = Number(process.env.TTL_MS ?? 10_000)
const INSTANCE_ID = process.env.INSTANCE_ID ?? Math.random().toString(36).slice(2, 6)

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
    onEvent: event => {
      const tag = `[api:${INSTANCE_ID}]`
      if (event.type === 'hit') {
        console.log(`${tag} CACHE HIT  key=${event.key}`)
      } else if (event.type === 'miss') {
        console.log(`${tag} CACHE MISS key=${event.key}`)
      } else if (event.type === 'ownership_acquired') {
        console.log(`${tag} OWNER      key=${event.key} — running loader`)
      } else if (event.type === 'distributed_join') {
        console.log(`${tag} WAITING    key=${event.key} — another instance is loading`)
      } else if (event.type === 'completed') {
        console.log(`${tag} COMPLETED  key=${event.key} in ${event.durationMs}ms`)
      } else if (event.type === 'failed') {
        console.log(`${tag} FAILED     key=${event.key} error=${String(event.error)}`)
      }
    },
  })

  // --- Express ---
  const app = express()

  app.get('/product/:id', async (req, res) => {
    const { id } = req.params
    const key = `product:${id}`

    try {
      const product = await crossflight.wrap(key, async () => {
        const response = await fetch(`${UPSTREAM_URL}/product/${id}`)
        if (!response.ok) {
          throw new Error(`upstream ${response.status} for product ${id}`)
        }
        return response.json()
      })

      res.json({ instance: INSTANCE_ID, product })
    } catch (error) {
      console.error(`[api:${INSTANCE_ID}] error for product ${id}:`, error)
      res.status(502).json({ error: String(error) })
    }
  })

  app.get('/healthz', (_req, res) => res.json({ ok: true, instance: INSTANCE_ID }))

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
