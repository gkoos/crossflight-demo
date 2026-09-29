/**
 * The slow upstream the API instances fetch from: every `GET /product/:id`
 * waits DELAY_MS before answering and counts one real call. There is no
 * Crossflight here — this is the load the instances are meant to collapse into
 * a single call.
 */
import express from 'express'

/**
 * The payload `GET /product/:id` hands to the API instances, which cache it
 * verbatim. The load demo reads these fields back out of their responses.
 */
interface Product {
  id: string
  name: string
  price: string
  fetchedAt: string
  /** The upstream call that produced this payload. Coalesced responses all
   * carry the same id; without coalescing each response gets its own. */
  upstreamCallId: number
  /** The API instance whose loader paid for this call. */
  fetchedBy: string
}

/** What `GET /stats` reports: real calls so far, per product, and the delay. */
interface UpstreamStats {
  total: number
  byProduct: Record<string, number>
  delayMs: number
}

const app = express()
const PORT = process.env.PORT ?? 3001
const DELAY_MS = Number(process.env.DELAY_MS ?? 500)

// Counts real product fetches only. `/healthz` (the compose healthcheck) and
// `/stats` (read by the load demo) deliberately leave it alone, so the number
// the demo reports is always real work - a probe would make it meaningless.
let upstreamCalls = 0
const callsByProduct = new Map<string, number>()

app.get('/healthz', (_req, res) => {
  res.json({ ok: true })
})

app.get('/stats', (_req, res) => {
  const stats: UpstreamStats = {
    total: upstreamCalls,
    byProduct: Object.fromEntries(callsByProduct),
    delayMs: DELAY_MS,
  }

  res.json(stats)
})

app.get('/product/:id', async (req, res) => {
  const { id } = req.params
  const callId = ++upstreamCalls
  callsByProduct.set(id, (callsByProduct.get(id) ?? 0) + 1)

  // The API instance whose loader paid for this call identifies itself, so
  // every response can be traced back to the process that did the work.
  const fetchedBy = req.get('x-instance') ?? 'unknown'

  console.log(
    `[upstream] call #${callId} for product ${id} from ${fetchedBy} — waiting ${DELAY_MS}ms`
  )
  await new Promise(resolve => setTimeout(resolve, DELAY_MS))

  const product: Product = {
    id,
    name: `Product ${id}`,
    price: (Number(id) * 9.99).toFixed(2),
    fetchedAt: new Date().toISOString(),
    upstreamCallId: callId,
    fetchedBy,
  }

  console.log(`[upstream] call #${callId} answered for product ${id}`)
  res.json(product)
})

app.listen(PORT, () => {
  console.log(`upstream listening on :${PORT} (delay: ${DELAY_MS}ms)`)
  console.log('[upstream] counted: GET /product/:id - GET /healthz and GET /stats are not counted')
})
