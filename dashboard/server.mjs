import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
import path from 'node:path'

const app = express()
const PORT = process.env.PORT || 8787
const DATA_FILE = path.resolve('../kuaixun_v2.json')
const MODEL_CONFIG_FILE = path.resolve('../model_config.json')

app.use(cors())
app.use(express.json())

function loadData() {
  const raw = fs.readFileSync(DATA_FILE, 'utf8')
  return JSON.parse(raw)
}

function toTime(value) {
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? 0 : t
}

function ensureModelConfig() {
  if (!fs.existsSync(MODEL_CONFIG_FILE)) {
    fs.writeFileSync(
      MODEL_CONFIG_FILE,
      JSON.stringify({ provider: 'doubao', baseUrl: '', apiKey: '', model: '', enabled: false }, null, 2),
    )
  }
}

function loadModelConfig() {
  ensureModelConfig()
  return JSON.parse(fs.readFileSync(MODEL_CONFIG_FILE, 'utf8'))
}

function saveModelConfig(input) {
  const current = loadModelConfig()
  const incomingApiKey = String(input?.apiKey || '').trim()
  const next = {
    provider: 'doubao',
    baseUrl: String(input?.baseUrl || '').trim(),
    apiKey: incomingApiKey || String(current?.apiKey || '').trim(),
    model: String(input?.model || '').trim(),
    enabled: Boolean(input?.enabled),
  }
  fs.writeFileSync(MODEL_CONFIG_FILE, JSON.stringify(next, null, 2))
  return next
}

function exposeConfig(cfg) {
  return {
    provider: cfg.provider || 'doubao',
    baseUrl: cfg.baseUrl || '',
    apiKey: cfg.apiKey || '',
    hasApiKey: Boolean(cfg.apiKey),
    model: cfg.model || '',
    enabled: Boolean(cfg.enabled),
  }
}

async function testDoubaoConnection(cfg) {
  const baseUrl = String(cfg.baseUrl || '').replace(/\/$/, '')
  const apiKey = String(cfg.apiKey || '').trim()
  const model = String(cfg.model || '').trim()
  if (!(cfg.enabled && baseUrl && apiKey && model)) {
    throw new Error('豆包配置不完整，请检查启用状态、Base URL、API Key、模型 ID')
  }

  const startedAt = Date.now()
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages: [{ role: 'user', content: '只回复OK' }],
    }),
  })

  const elapsedMs = Date.now() - startedAt
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`豆包连接失败（HTTP ${res.status}）：${text.slice(0, 300)}`)
  }

  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {}

  return {
    status: res.status,
    model: parsed?.model || model,
    latencyMs: elapsedMs,
    preview: String(parsed?.choices?.[0]?.message?.content || text).slice(0, 300),
  }
}

function getPendingItems() {
  const data = loadData()
  const medias = ['theblockbeats', 'techflow', 'odaily']
  const result = {}

  for (const media of medias) {
    const items = (data[media]?.items || [])
      .filter((item) => item.reviewed === true && item.passed === 1)
      .sort((a, b) => toTime(b.published_at) - toTime(a.published_at))
      .map((item) => {
        const aiTitle = item.ai_title || item.title
        const aiBody = item.ai_body || item.content
        const hasAiOptimized = Boolean(item.ai_title && item.ai_body)

        return {
          media: item.media,
          id: item.id,
          title: item.title,
          summary: item.summary,
          content: item.content,
          link: item.link,
          original_link: item.original_link,
          is_featured: item.is_featured,
          published_at: item.published_at,
          review_reason: item.review_reason,
          rewritten_title: item.rewritten_title,
          rewritten_content: item.rewritten_content,
          ai_title: aiTitle,
          ai_body: aiBody,
          has_ai_optimized: hasAiOptimized,
        }
      })
    result[media] = items
  }

  return result
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.get('/api/news', (_req, res) => {
  res.json({ ok: true, data: getPendingItems() })
})

app.get('/api/news/:media', (req, res) => {
  const media = req.params.media
  const data = getPendingItems()
  if (!(media in data)) {
    return res.status(404).json({ ok: false, message: 'media not found' })
  }
  res.json({ ok: true, data: data[media] })
})

app.get('/api/model-config', (_req, res) => {
  const config = loadModelConfig()
  res.json({ ok: true, data: exposeConfig(config) })
})

app.post('/api/model-config', (req, res) => {
  const saved = saveModelConfig(req.body || {})
  res.json({ ok: true, data: exposeConfig(saved) })
})

app.post('/api/model-config/test', async (req, res) => {
  try {
    const merged = saveModelConfig(req.body || {})
    const result = await testDoubaoConnection(merged)
    res.json({ ok: true, message: '豆包连接成功', data: result })
  } catch (error) {
    res.status(400).json({ ok: false, message: error instanceof Error ? error.message : String(error) })
  }
})

app.listen(PORT, () => {
  console.log(`flash-news dashboard api running on http://localhost:${PORT}`)
})
