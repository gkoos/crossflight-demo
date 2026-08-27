/**
 * Load generator for the Crossflight demo.
 *
 * Usage:
 *   CONCURRENCY=20 PRODUCT_ID=42 API_URL=http://localhost:3000 node --experimental-strip-types src/load.ts
 *
 * Fires CONCURRENCY requests simultaneously for the same product key and
 * prints which API instances served them and how many upstream calls were made.
 */
import { fetch } from 'undici'

const API_URL = process.env.API_URL ?? 'http://localhost:3000'
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 20)
const PRODUCT_ID = process.env.PRODUCT_ID ?? '42'
const ROUNDS = Number(process.env.ROUNDS ?? 1)

interface ApiResponse {
  instance: string
  product: {
    id: string
    name: string
    price: string
    fetchedAt: string
    upstreamRequest: number
  }
}

async function fireRound(round: number): Promise<void> {
  console.log(`\n─── Round ${round}: ${CONCURRENCY} concurrent requests for product ${PRODUCT_ID} ───`)

  const start = Date.now()

  const requests = Array.from({ length: CONCURRENCY }, () =>
    fetch(`${API_URL}/product/${PRODUCT_ID}`)
      .then(r => r.json() as Promise<ApiResponse>)
      .then(body => ({ ok: true as const, body }))
      .catch(error => ({ ok: false as const, error: String(error) }))
  )

  const results = await Promise.all(requests)
  const elapsed = Date.now() - start

  const successes = results.filter(r => r.ok)
  const failures = results.filter(r => !r.ok)

  if (failures.length > 0) {
    console.log(`\nFailed requests: ${failures.length}`)
    failures.forEach(f => !f.ok && console.log(` • ${f.error}`))
  }

  // Tally upstream request numbers — if Crossflight is working, all
  // responses should share the same low upstreamRequest number from the
  // single loader that ran. Without Crossflight every request has a unique number.
  const upstreamHits = new Set(
    successes.filter(r => r.ok).map(r => r.ok && r.body.product?.upstreamRequest)
  )

  const instanceCounts = new Map<string, number>()
  for (const r of successes) {
    if (!r.ok) continue
    const inst = r.body.instance ?? 'unknown'
    instanceCounts.set(inst, (instanceCounts.get(inst) ?? 0) + 1)
  }

  console.log(`\nResults (${elapsed}ms total):`)
  console.log(`  Requests sent:      ${CONCURRENCY}`)
  console.log(`  Successful:         ${successes.length}`)
  console.log(`  Upstream calls made: ${upstreamHits.size}  ← should be 1 with Crossflight`)
  console.log(`  Upstream request #s: ${[...upstreamHits].join(', ')}`)
  console.log(`\n  Responses by API instance:`)
  for (const [inst, count] of [...instanceCounts].sort()) {
    console.log(`    api:${inst}  →  ${count} responses`)
  }

  if (successes.length > 0) {
    const sample = successes[0]
    if (sample.ok) {
      console.log(`\n  Sample product: ${JSON.stringify(sample.body.product, null, 2)}`)
    }
  }
}

async function main(): Promise<void> {
  console.log(`Crossflight load demo`)
  console.log(`  API:         ${API_URL}`)
  console.log(`  Product ID:  ${PRODUCT_ID}`)
  console.log(`  Concurrency: ${CONCURRENCY}`)
  console.log(`  Rounds:      ${ROUNDS}`)

  for (let i = 1; i <= ROUNDS; i++) {
    await fireRound(i)
    if (i < ROUNDS) {
      // Small gap between rounds so cache TTL doesn't interfere across rounds
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }

  console.log('\nDone.')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
