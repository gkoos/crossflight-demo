import express from 'express'

const app = express()
const PORT = process.env.PORT ?? 3001
const DELAY_MS = Number(process.env.DELAY_MS ?? 500)

let requestCount = 0

app.get('/product/:id', async (req, res) => {
  const { id } = req.params
  const n = ++requestCount

  console.log(`[upstream] request #${n} for product ${id} — waiting ${DELAY_MS}ms`)
  await new Promise(resolve => setTimeout(resolve, DELAY_MS))

  const product = {
    id,
    name: `Product ${id}`,
    price: (Number(id) * 9.99).toFixed(2),
    fetchedAt: new Date().toISOString(),
    upstreamRequest: n,
  }

  console.log(`[upstream] response #${n} for product ${id}`)
  res.json(product)
})

app.listen(PORT, () => {
  console.log(`upstream listening on :${PORT} (delay: ${DELAY_MS}ms)`)
})
