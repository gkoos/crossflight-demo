/**
 * Load generator for the Crossflight demo.
 *
 * Fires CONCURRENCY requests for one product key at the same time, then reports
 * that round from three independent observers, so the result cannot be an
 * artefact of any single one of them:
 *
 *   1. the responses          which request ran the loader, and the upstream
 *                             call id that every payload carries
 *   2. the upstream service   how many product calls it actually served
 *                             (its own counter, read around the round)
 *   3. each api instance      flights opened, owned and waited, requests shared
 *                             in-process, loader executions (GET /stats)
 *
 * Usage:
 *   CONCURRENCY=20 PRODUCT_ID=42 npm run load
 *   ROUNDS=2 npm run load         # round 2 runs against a warm cache
 *   NO_COALESCING=1 npm run load  # control run: the same load without Crossflight
 */
import { fetch } from 'undici'

const API_URL = process.env.API_URL ?? 'http://localhost:3000'
const UPSTREAM_URL = process.env.UPSTREAM_URL ?? 'http://localhost:3001'
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 20)
const PRODUCT_ID = process.env.PRODUCT_ID ?? '42'
const ROUNDS = Number(process.env.ROUNDS ?? 1)
const NO_COALESCING = process.env.NO_COALESCING === '1'
const KEY = `product:${PRODUCT_ID}`

interface ApiResponse {
  instance: string
  ranLoader: boolean
  loaderMs?: number
  product: {
    id: string
    name: string
    price: string
    fetchedAt: string
    upstreamCallId: number
    fetchedBy: string
  }
}

interface UpstreamStats {
  total: number
  byProduct: Record<string, number>
  delayMs: number
}

interface InstancesIndex {
  instances: string[]
}

/** Mirrors the per-key counters an API instance serves on GET /stats. */
interface KeyCounters {
  requests: number
  flights: number
  ownedFlights: number
  waitingFlights: number
  cacheHits: number
  sharedInProcess: number
  loaderRuns: number
  loaderMs: number
  waitedMs: number
  bypassed: number
  failures: number
}

interface InstanceStats {
  instance: string
  cacheTtlMs: number
  keys: Record<string, KeyCounters>
}

type Outcome = { ok: true; body: ApiResponse } | { ok: false; error: string }

/** Everything one round produced, from all three observers. */
interface Round {
  number: number
  elapsedMs: number
  responses: ApiResponse[]
  failures: string[]
  loaders: ApiResponse[]
  loaderInstances: string[]
  slowestLoaderMs: number
  callIds: number[]
  fetchers: string[]
  instanceIds: string[]
  responsesByInstance: Map<string, number>
  countersById: Map<string, KeyCounters>
  mismatchedInstances: string[]
  upstreamBefore: number | undefined
  upstreamAfter: number | undefined
  measuredCalls: number | undefined
}

const isOk = (outcome: Outcome): outcome is Extract<Outcome, { ok: true }> => outcome.ok

/** Reads a JSON endpoint, returning undefined when it is unreachable. */
async function getJson<T>(url: string): Promise<T | undefined> {
  try {
    const response = await fetch(url)

    return response.ok ? ((await response.json()) as T) : undefined
  } catch {
    return undefined
  }
}

/** The instance list the load balancer exposes, or [] when it has none. */
async function fetchInstanceIds(): Promise<string[]> {
  const index = await getJson<InstancesIndex>(`${API_URL}/instances`)
  return index?.instances ?? []
}

/** The upstream's own count of calls for this product, or undefined without a counter. */
async function upstreamCallsForProduct(): Promise<number | undefined> {
  const stats = await getJson<UpstreamStats>(`${UPSTREAM_URL}/stats`)
  return stats ? (stats.byProduct[PRODUCT_ID] ?? 0) : undefined
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

const formatIds = (ids: number[]): string => {
  const sorted = [...ids].sort((a, b) => a - b)

  if (sorted.length === 0) return 'none'
  if (sorted.length === 1) return `#${sorted[0]}`
  if (sorted.length <= 6) return sorted.map(id => `#${id}`).join(', ')

  return `#${sorted[0]} … #${sorted[sorted.length - 1]} (${plural(sorted.length, 'id')})`
}

const zeroCounters = (): KeyCounters => ({
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

const sumCounters = (list: KeyCounters[]): KeyCounters => {
  const total = zeroCounters()

  for (const counters of list) {
    for (const field of Object.keys(counters) as Array<keyof KeyCounters>) {
      total[field] += counters[field]
    }
  }

  return total
}

/** How one instance served its share of the round, from its own counters. */
const describeCounters = (counters: KeyCounters): string => {
  const parts: string[] = []

  if (counters.bypassed > 0) {
    parts.push(`coalescing bypassed, ${plural(counters.loaderRuns, 'loader')} ran here`)
  }
  if (counters.ownedFlights > 0) {
    const loader =
      counters.loaderRuns > 0
        ? `, its loader took ${counters.loaderMs}ms`
        : ' (the cache was already filled by then)'
    parts.push(`${plural(counters.ownedFlights, 'flight')} acquired the lease${loader}`)
  }
  if (counters.waitingFlights > 0) {
    parts.push(`${plural(counters.waitingFlights, 'flight')} waited ${counters.waitedMs}ms for another instance`)
  }
  if (counters.sharedInProcess > 0) {
    parts.push(`${counters.sharedInProcess} joined an in-process flight`)
  }
  if (counters.cacheHits > 0) {
    parts.push(`${plural(counters.cacheHits, 'flight')} read the cache without waiting`)
  }
  if (counters.failures > 0) {
    parts.push(plural(counters.failures, 'failure'))
  }

  if (parts.length === 0) {
    return counters.requests === 0 ? 'no requests for this key' : 'nothing recorded'
  }

  return parts.join(' · ')
}

const indent = (text: string): string =>
  text
    .split('\n')
    .map(line => `    ${line}`)
    .join('\n')

async function collectRound(number: number, knownInstances: string[]): Promise<Round> {
  console.log(`\n─── Round ${number} · ${CONCURRENCY} simultaneous requests for ${KEY} ───`)

  // Zero every instance's counters first, so what is read back below describes
  // this round only, then note where the upstream's counter stood.
  await Promise.all(knownInstances.map(id => getJson(`${API_URL}/instances/${id}/stats?reset=1`)))
  const upstreamBefore = await upstreamCallsForProduct()

  const startedAt = Date.now()
  const outcomes = await Promise.all(
    Array.from({ length: CONCURRENCY }, () =>
      fetch(`${API_URL}/product/${PRODUCT_ID}`, {
        headers: NO_COALESCING ? { 'x-no-coalescing': '1' } : {},
      })
        .then(async response => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`)
          }

          return (await response.json()) as ApiResponse
        })
        .then(body => ({ ok: true as const, body }))
        .catch(error => ({ ok: false as const, error: String(error) }))
    )
  )
  const elapsedMs = Date.now() - startedAt
  const upstreamAfter = await upstreamCallsForProduct()

  const responses = outcomes.filter(isOk).map(outcome => outcome.body)
  const failures = outcomes.filter(outcome => !outcome.ok).map(outcome => outcome.error)

  const responsesByInstance = new Map<string, number>()
  for (const response of responses) {
    responsesByInstance.set(response.instance, (responsesByInstance.get(response.instance) ?? 0) + 1)
  }

  const loaders = responses.filter(response => response.ranLoader)
  const callIds = [...new Set(responses.map(response => response.product.upstreamCallId))]

  // Counters are per instance, so an instance that got no traffic at all is
  // reported as well - it is the one that did nothing. Each reply names the
  // instance that produced it, which must be the one that was asked: a load
  // balancer that answers from a stale address would otherwise label the
  // numbers with the wrong process.
  const stats = await Promise.all(
    knownInstances.map(id => getJson<InstanceStats>(`${API_URL}/instances/${id}/stats`))
  )
  const countersById = new Map<string, KeyCounters>()
  const mismatchedInstances: string[] = []

  knownInstances.forEach((id, index) => {
    const reply = stats[index]

    if (!reply) return

    if (reply.instance !== id) {
      mismatchedInstances.push(`${id} → answered by ${reply.instance}`)
      return
    }

    const counters = reply.keys[KEY]

    if (counters) countersById.set(id, counters)
  })

  return {
    number,
    elapsedMs,
    responses,
    failures,
    loaders,
    loaderInstances: [...new Set(loaders.map(response => response.instance))].sort(),
    slowestLoaderMs: loaders.reduce((slowest, loader) => Math.max(slowest, loader.loaderMs ?? 0), 0),
    callIds,
    fetchers: [...new Set(responses.map(response => response.product.fetchedBy))].sort(),
    instanceIds: knownInstances.length > 0 ? knownInstances : [...responsesByInstance.keys()].sort(),
    responsesByInstance,
    countersById,
    mismatchedInstances,
    upstreamBefore,
    upstreamAfter,
    measuredCalls:
      upstreamBefore === undefined || upstreamAfter === undefined
        ? undefined
        : upstreamAfter - upstreamBefore,
  }
}

function printReport(round: Round): void {
  if (round.failures.length > 0) {
    console.log(`\n  Failed requests: ${round.failures.length}`)
    for (const error of round.failures) console.log(`    ✘ ${error}`)
  }

  // --- 1. what the responses themselves say ---
  console.log('\n  Responses')
  console.log(
    `    ${round.responses.length}/${CONCURRENCY} succeeded in ${round.elapsedMs}ms`
  )
  console.log(
    `    served by ${round.instanceIds
      .map(id => `${id} ${round.responsesByInstance.get(id) ?? 0}`)
      .join(' · ')}`
  )
  console.log(
    round.loaders.length === 0
      ? `    no response ran the loader — ${KEY} was already cached`
      : `    ${plural(round.loaders.length, 'response')} ran the loader (${round.loaderInstances.join(', ')}, ` +
        `${round.slowestLoaderMs}ms) — the other ${round.responses.length - round.loaders.length} reused its result`
  )
  console.log(
    `    every response carries upstream call id ${formatIds(round.callIds)}, fetched by ` +
      `${round.fetchers.join(', ') || 'nobody'}`
  )

  // --- 2. what the upstream itself counted ---
  console.log('\n  Upstream (its own counter for this product)')
  console.log(
    round.measuredCalls === undefined
      ? `    not measured — no counter at ${UPSTREAM_URL}/stats (set UPSTREAM_URL)`
      : `    ${plural(round.measuredCalls, 'call')}, counter ${round.upstreamBefore} → ${round.upstreamAfter}`
  )

  // --- 3. what each instance counted ---
  console.log(`\n  Per instance (its own counters for ${KEY})`)

  if (round.countersById.size > 0) {
    for (const id of round.instanceIds) {
      console.log(
        `    ${id}  ${plural(round.responsesByInstance.get(id) ?? 0, 'request')} · ` +
          describeCounters(round.countersById.get(id) ?? zeroCounters())
      )
    }
  }

  if (round.mismatchedInstances.length > 0) {
    for (const mismatch of round.mismatchedInstances) {
      console.log(`    ⚠ ${mismatch} — restart nginx so it re-resolves the api containers`)
    }
    console.log('    ⚠ counters are incomplete, so they are not added up below')
  } else if (round.countersById.size === 0) {
    console.log(`    not available — no /instances index at ${API_URL}`)
  } else {
    const total = sumCounters([...round.countersById.values()])

    if (total.bypassed > 0) {
      console.log(
        `    ${plural(total.bypassed, 'request')} bypassed Crossflight, so there is nothing to account for`
      )
    } else {
      const accounted = total.flights + total.sharedInProcess + total.cacheHits
      const balanced = accounted === total.requests

      console.log(
        `    ${plural(total.requests, 'request')} accounted for: ${plural(total.flights, 'flight')} + ` +
          `${total.sharedInProcess} joined in-process + ${plural(total.cacheHits, 'straight cache hit')} ` +
          `${balanced ? '✔' : `✘ ${accounted} ≠ ${total.requests}`}`
      )

      // A flight that waited for another instance can still end up acquiring the
      // lease afterwards, so these two counts are not disjoint.
      if (total.flights > 0) {
        const both = total.ownedFlights + total.waitingFlights > total.flights
        console.log(
          `    of the ${plural(total.flights, 'flight')}: ${total.ownedFlights} acquired the lease, ` +
            `${total.loaderRuns} ran a loader, ${total.waitingFlights} waited for another instance` +
            `${both ? ' (a flight can wait and then acquire)' : ''}`
        )
      }
    }
  }

  printVerdict(round)
}

function printVerdict(round: Round): void {
  const callsText =
    round.measuredCalls === undefined ? 'not measured' : plural(round.measuredCalls, 'upstream call')

  if (NO_COALESCING) {
    console.log('\n  Control run (Crossflight switched off)')
    console.log(
      `    · ${plural(round.responses.length, 'request')} → ${plural(round.loaders.length, 'loader execution')} → ${callsText}`
    )
    console.log(`    · every response fetched for itself: call ids ${formatIds(round.callIds)}`)
    console.log('    · this is the stampede Crossflight is there to prevent')
    return
  }

  console.log('\n  Checks')

  if (round.loaders.length === 1) {
    console.log(
      `    ✔ one loader execution (${round.loaderInstances[0]}, ${round.slowestLoaderMs}ms) served all ` +
        `${plural(round.responses.length, 'response')}`
    )
  } else if (round.loaders.length === 0) {
    console.log(`    ✔ no loader ran: ${KEY} was still cached, so nothing had to be fetched`)
  } else {
    console.log(
      `    ✘ ${plural(round.loaders.length, 'loader execution')} (${round.loaderInstances.join(', ')}) — ` +
        'coalescing did not hold, check the api logs'
    )
  }

  if (round.measuredCalls === undefined) {
    console.log('    · upstream calls not measured: point UPSTREAM_URL at the upstream service')
  } else if (round.measuredCalls === round.loaders.length) {
    console.log(
      round.measuredCalls === 0
        ? '    ✔ the upstream served no calls at all: the warm cache did the work'
        : `    ✔ the upstream served ${plural(round.measuredCalls, 'call')}, counted independently and ` +
            `matching ${plural(round.loaders.length, 'loader execution')}`
    )
  } else {
    console.log(
      `    ✘ the upstream served ${plural(round.measuredCalls, 'call')} but the instances report ` +
        `${plural(round.loaders.length, 'loader execution')}`
    )
  }

  if (round.callIds.length === 1) {
    console.log(
      `    ✔ one upstream call id (${formatIds(round.callIds)}) across every response — they all reused one value`
    )
  } else {
    console.log(
      `    ✘ ${plural(round.callIds.length, 'different upstream call id')} across the responses ` +
        `(${formatIds(round.callIds)}) — they did not reuse one value`
    )
  }

  if (round.countersById.size > 0 && round.mismatchedInstances.length === 0) {
    const total = sumCounters([...round.countersById.values()])

    if (total.loaderRuns !== round.loaders.length) {
      console.log(
        `    ✘ the instances counted ${plural(total.loaderRuns, 'loader execution')} but ` +
          `${plural(round.loaders.length, 'response')} say they ran one`
      )
    }

    const countedRequests = total.requests + total.bypassed

    if (countedRequests !== round.responses.length) {
      console.log(
        `    ✘ the instances counted ${plural(countedRequests, 'request')} for this key but ` +
          `${plural(round.responses.length, 'response')} came back`
      )
    }
  }
}

async function main(): Promise<void> {
  const upstream = await getJson<UpstreamStats>(`${UPSTREAM_URL}/stats`)
  const instances = await fetchInstanceIds()

  console.log('Crossflight load demo')
  console.log(`  API:         ${API_URL} (nginx)`)
  console.log(
    `  Upstream:    ${UPSTREAM_URL}${upstream?.delayMs ? ` (${upstream.delayMs}ms per call)` : ''}`
  )
  console.log(`  Instances:   ${instances.join(', ') || 'unknown (no /instances index)'}`)
  console.log(`  Key:         ${KEY}`)
  console.log(`  Concurrency: ${CONCURRENCY}`)
  console.log(`  Rounds:      ${ROUNDS}`)

  if (NO_COALESCING) {
    console.log('  Mode:        Crossflight bypassed — this run is the baseline to compare against')
  }

  for (let round = 1; round <= ROUNDS; round++) {
    const collected = await collectRound(round, instances)
    printReport(collected)

    if (round === 1 && collected.responses.length > 0) {
      console.log('\n  Sample response')
      console.log(indent(JSON.stringify(collected.responses[0], null, 2)))
    }

    if (round < ROUNDS) {
      // The cache TTL is 10s by default, so the next round starts warm.
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }

  console.log('\nDone.')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
