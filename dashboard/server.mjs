import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const app = express()
const PORT = process.env.PORT || 8787
const DATA_FILE = path.resolve('../kuaixun_v2.json')
const DATA_LOCK_FILE = path.resolve('../.kuaixun_v2.lock')
const MODEL_CONFIG_FILE = path.resolve('../model_config.json')
const REWRITE_PROMPT_FILE = path.resolve('../template/rewrite_prompt.md')
const SCORING_PROMPT_FILE = path.resolve('../template/scoring_prompt.md')
const AUTO_DRAFT_STATE_FILE = path.resolve('../chainthink_auto_draft_state.json')
const POLLERCTL_SCRIPT_FILE = path.resolve('../scripts/pollerctl.mjs')
const ENV_LOCAL_FILE = path.resolve('.env.local')
const AUTO_DRAFT_INTERVAL_MS = 30_000
const MEDIA_PRUNE_THRESHOLD = 100
const MEDIA_PRUNE_KEEP = 50
const MEDIA_KEYS = ['theblockbeats', 'techflow', 'odaily']
const MEDIA_LABELS = {
  theblockbeats: '律动',
  techflow: '深潮',
  odaily: 'Odaily',
}
let autoDraftTimer = null
let autoDraftTickRunning = false

app.use(cors())
const execFileAsync = promisify(execFile)

app.use(express.json())



function parseEnvFile(content = '') {
  const result = {}
  for (const rawLine of String(content).split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index === -1) continue
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

function loadLocalEnvConfig() {
  const envFile = fs.existsSync(ENV_LOCAL_FILE) ? parseEnvFile(fs.readFileSync(ENV_LOCAL_FILE, 'utf8')) : {}
  return {
    token: String(envFile.CHAINTHINK_TOKEN || process.env.CHAINTHINK_TOKEN || process.env.CHAINTHINK_TEST_TOKEN || '').trim(),
    hasToken: Boolean(envFile.CHAINTHINK_TOKEN || process.env.CHAINTHINK_TOKEN || process.env.CHAINTHINK_TEST_TOKEN),
    baseUrl: String(envFile.CHAINTHINK_BASE_URL || process.env.CHAINTHINK_BASE_URL || 'https://api-v2.chainthink.cn').trim(),
    xUserId: String(envFile.CHAINTHINK_X_USER_ID || process.env.CHAINTHINK_X_USER_ID || '').trim(),
    xAppId: String(envFile.CHAINTHINK_X_APP_ID || process.env.CHAINTHINK_X_APP_ID || '101').trim(),
    userId: String(envFile.CHAINTHINK_DEFAULT_USER_ID || process.env.CHAINTHINK_DEFAULT_USER_ID || '3').trim(),
    asUserId: String(envFile.CHAINTHINK_DEFAULT_AS_USER_ID || process.env.CHAINTHINK_DEFAULT_AS_USER_ID || '3').trim(),
    origin: String(envFile.CHAINTHINK_ORIGIN || process.env.CHAINTHINK_ORIGIN || 'https://admin.chainthink.cn').trim(),
    referer: String(envFile.CHAINTHINK_REFERER || process.env.CHAINTHINK_REFERER || 'https://admin.chainthink.cn/').trim(),
  }
}

function saveLocalEnvConfig(input = {}) {
  const current = fs.existsSync(ENV_LOCAL_FILE) ? parseEnvFile(fs.readFileSync(ENV_LOCAL_FILE, 'utf8')) : {}
  const next = {
    ...current,
    CHAINTHINK_TOKEN: String(input.token || '').trim(),
    CHAINTHINK_BASE_URL: String(input.baseUrl || 'https://api-v2.chainthink.cn').trim(),
    CHAINTHINK_X_USER_ID: String(input.xUserId || '').trim(),
    CHAINTHINK_X_APP_ID: String(input.xAppId || '101').trim(),
    CHAINTHINK_DEFAULT_USER_ID: String(input.userId || '3').trim(),
    CHAINTHINK_DEFAULT_AS_USER_ID: String(input.asUserId || '3').trim(),
    CHAINTHINK_ORIGIN: String(input.origin || 'https://admin.chainthink.cn').trim(),
    CHAINTHINK_REFERER: String(input.referer || 'https://admin.chainthink.cn/').trim(),
  }
  const lines = [
    '# Local private env for dashboard ChainThink integration',
    ...Object.entries(next).filter(([, value]) => String(value).length > 0).map(([key, value]) => `${key}=${value}`),
  ]
  fs.writeFileSync(ENV_LOCAL_FILE, `${lines.join('\n')}\n`)
  return loadLocalEnvConfig()
}

function getChainthinkEnv() {
  const local = loadLocalEnvConfig()
  return {
    baseUrl: String(process.env.CHAINTHINK_BASE_URL || local.baseUrl || 'https://api-v2.chainthink.cn').trim(),
    publishPath: String(process.env.CHAINTHINK_PUBLISH_PATH || '/ccs/v1/admin/content/publish').trim(),
    token: String(process.env.CHAINTHINK_TOKEN || process.env.CHAINTHINK_TEST_TOKEN || local.token || '').trim(),
    xAppId: String(process.env.CHAINTHINK_X_APP_ID || local.xAppId || '101').trim(),
    xUserId: String(process.env.CHAINTHINK_X_USER_ID || local.xUserId || '').trim(),
    defaultUserId: String(process.env.CHAINTHINK_DEFAULT_USER_ID || local.userId || '3').trim(),
    defaultAsUserId: String(process.env.CHAINTHINK_DEFAULT_AS_USER_ID || local.asUserId || '3').trim(),
    origin: String(process.env.CHAINTHINK_ORIGIN || local.origin || 'https://admin.chainthink.cn').trim(),
    referer: String(process.env.CHAINTHINK_REFERER || local.referer || 'https://admin.chainthink.cn/').trim(),
  }
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function toParagraphHtml(text = '') {
  const lines = String(text || '').split(/\n+/).map((line) => line.trim()).filter(Boolean)
  if (!lines.length) return '<p></p>'
  return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')
}

function buildChainthinkDraftPayload(input) {
  const title = String(input?.title || '').trim()
  const text = String(input?.text || '').trim()
  const link = String(input?.link || '').trim()
  if (!title) throw new Error('标题不能为空')
  if (!text) throw new Error('正文不能为空')
  return {
    id: '0',
    info: {
      ...(link ? { link } : {}),
      ...(input?.coverImage ? { cover_image: String(input.coverImage).trim() } : {}),
    },
    is_translate: true,
    translation: {
      'zh-CN': {
        title,
        text: toParagraphHtml(text),
        abstract: '',
      },
    },
    type: 7,
    admin_detail: {},
    strong_content_tags: {},
    chain_is_calendar: false,
    chain_calendar_time: Math.floor(Date.now() / 1000),
    chain_calendar_tendency: 0,
    is_push_bian: 2,
    content_pin_top: 0,
    is_public: false,
    user_id: String(input?.userId || '3'),
    chain_fixed_publish_time: 0,
    as_user_id: String(input?.asUserId || '3'),
    is_chain: true,
    chain_airdrop_time: 0,
    chain_airdrop_time_end: 0,
  }
}

async function publishChainthinkDraft(input) {
  const env = getChainthinkEnv()
  if (!env.token) throw new Error('未配置 CHAINTHINK_TOKEN / CHAINTHINK_TEST_TOKEN，无法发布草稿')
  const url = `${env.baseUrl.replace(/\/$/, '')}${env.publishPath}`
  const coverImage = input?.imageUrl ? await uploadChainthinkCoverFromUrl(String(input.imageUrl)) : ''
  const body = buildChainthinkDraftPayload({
    ...input,
    coverImage,
    userId: env.defaultUserId,
    asUserId: env.defaultAsUserId,
  })
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'X-App-Id': env.xAppId,
      'x-token': env.token,
      'x-user-id': env.xUserId,
      Origin: env.origin,
      Referer: env.referer,
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch {}
  if (!res.ok) throw new Error(`ChainThink 草稿发布失败（HTTP ${res.status}）：${text.slice(0, 300)}`)
  if (parsed && parsed.code !== 0) throw new Error(parsed.message || parsed.msg || `ChainThink 草稿发布失败，code=${parsed.code}`)
  return parsed || { code: 0, raw: text }
}


async function uploadChainthinkCoverFromUrl(imageUrl) {
  const env = getChainthinkEnv()
  if (!imageUrl) return ''
  const scriptPath = path.resolve('./scripts/upload_cover.py')
  const helperPath = path.resolve('./scripts/compute_crc64.cjs')
  if (!fs.existsSync(scriptPath) || !fs.existsSync(helperPath)) {
    throw new Error('缺少 ChainThink 图片上传脚本，无法上传配图')
  }
  const { stdout, stderr } = await execFileAsync('python3', [scriptPath, imageUrl], {
    env: {
      ...process.env,
      CHAINTHINK_TOKEN: env.token,
      CHAINTHINK_USER_ID: env.xUserId,
      CHAINTHINK_BASE_URL: env.baseUrl,
      CHAINTHINK_X_APP_ID: env.xAppId,
      CHAINTHINK_ORIGIN: env.origin,
      CHAINTHINK_REFERER: env.referer,
    },
    maxBuffer: 10 * 1024 * 1024,
  })
  const coverUrl = String(stdout || '').trim()
  if (!coverUrl) {
    throw new Error((stderr || 'ChainThink 图片上传失败').trim())
  }
  return coverUrl
}

function loadData() {
  const raw = fs.readFileSync(DATA_FILE, 'utf8')
  return JSON.parse(raw)
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

async function withDataLock(ownerLabel, fn) {
  const owner = { pid: process.pid, task: ownerLabel, started_at: new Date().toISOString() }
  while (true) {
    try {
      fs.writeFileSync(DATA_LOCK_FILE, JSON.stringify(owner), { flag: 'wx' })
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let existing = null
      try {
        existing = JSON.parse(fs.readFileSync(DATA_LOCK_FILE, 'utf8'))
      } catch {}
      if (existing?.pid && pidAlive(existing.pid)) {
        await sleep(100)
        continue
      }
      try {
        fs.unlinkSync(DATA_LOCK_FILE)
      } catch {}
    }
  }

  try {
    return await fn()
  } finally {
    try {
      fs.unlinkSync(DATA_LOCK_FILE)
    } catch {}
  }
}

function toTime(value) {
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? 0 : t
}

function defaultAutoDraftState() {
  return {
    enabled: false,
    interval_ms: AUTO_DRAFT_INTERVAL_MS,
    worker_running: false,
    last_checked_at: '',
    last_published_at: '',
    last_published_key: '',
    last_error: '',
    total_published: 0,
  }
}

function loadAutoDraftState() {
  const defaults = defaultAutoDraftState()
  if (!fs.existsSync(AUTO_DRAFT_STATE_FILE)) return defaults
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTO_DRAFT_STATE_FILE, 'utf8'))
    return {
      ...defaults,
      ...parsed,
      enabled: Boolean(parsed?.enabled),
      interval_ms: AUTO_DRAFT_INTERVAL_MS,
      worker_running: Boolean(parsed?.worker_running),
      total_published: Number(parsed?.total_published || 0),
    }
  } catch {
    return defaults
  }
}

function saveAutoDraftState(patch = {}) {
  const next = {
    ...loadAutoDraftState(),
    ...patch,
    interval_ms: AUTO_DRAFT_INTERVAL_MS,
  }
  fs.writeFileSync(AUTO_DRAFT_STATE_FILE, JSON.stringify(next, null, 2))
  return next
}

function findItem(data, media, id) {
  return (data?.[media]?.items || []).find((item) => String(item.id) === String(id)) || null
}

function buildDraftPayloadFromItem(item) {
  return {
    title: String(item.ai_title || item.title || '').trim(),
    text: String(item.ai_body || item.content || item.summary || '').trim(),
    link: String(item.original_link || item.link || '').trim(),
    imageUrl: String(normalizeImageUrl(item) || '').trim(),
  }
}

function isEligibleForAutoDraft(item) {
  return (
    typeof item?.ai_score === 'number' &&
    item.ai_score >= 85 &&
    Boolean(String(item.ai_title || '').trim()) &&
    Boolean(String(item.ai_body || '').trim()) &&
    !String(item.chainthink_draft_published_at || '').trim() &&
    !String(item.chainthink_draft_publish_inflight_at || '').trim()
  )
}

function getAutoDraftCandidate(data) {
  const medias = ['theblockbeats', 'techflow', 'odaily']
  const rows = []
  for (const media of medias) {
    for (const item of data?.[media]?.items || []) {
      if (!isEligibleForAutoDraft(item)) continue
      rows.push(item)
    }
  }
  rows.sort((a, b) => toTime(b.published_at) - toTime(a.published_at))
  return rows[0] || null
}

async function reserveDraftPublish(media, id, mode) {
  return await withDataLock(`draft:reserve:${mode}`, async () => {
    const data = loadData()
    const item = findItem(data, media, id)
    if (!item) return null
    if (String(item.chainthink_draft_published_at || '').trim()) return null
    if (String(item.chainthink_draft_publish_inflight_at || '').trim()) return null
    item.chainthink_draft_publish_inflight_at = new Date().toISOString()
    item.chainthink_draft_publish_mode = mode
    item.chainthink_draft_publish_error = ''
    saveData(data)
    return {
      media: item.media,
      id: String(item.id || ''),
      ...buildDraftPayloadFromItem(item),
    }
  })
}

async function finishDraftPublish(media, id, mode, result) {
  return await withDataLock(`draft:finish:${mode}`, async () => {
    const data = loadData()
    const item = findItem(data, media, id)
    if (!item) return null
    delete item.chainthink_draft_publish_inflight_at
    if (result.ok) {
      item.chainthink_draft_published_at = new Date().toISOString()
      item.chainthink_draft_publish_mode = mode
      item.chainthink_draft_publish_error = ''
    } else {
      item.chainthink_draft_publish_error = String(result.message || '')
    }
    saveData(data)
    return item
  })
}

async function runAutoDraftTick() {
  const state = loadAutoDraftState()
  if (!state.enabled || autoDraftTickRunning) return
  autoDraftTickRunning = true
  saveAutoDraftState({ worker_running: true, last_checked_at: new Date().toISOString(), last_error: '' })
  try {
    const data = loadData()
    const candidate = getAutoDraftCandidate(data)
    if (!candidate) {
      saveAutoDraftState({ worker_running: false, last_checked_at: new Date().toISOString() })
      return
    }
    const reserved = await reserveDraftPublish(candidate.media, candidate.id, 'auto')
    if (!reserved) {
      saveAutoDraftState({ worker_running: false, last_checked_at: new Date().toISOString() })
      return
    }
    await publishChainthinkDraft(reserved)
    await finishDraftPublish(reserved.media, reserved.id, 'auto', { ok: true })
    const current = loadAutoDraftState()
    saveAutoDraftState({
      worker_running: false,
      last_checked_at: new Date().toISOString(),
      last_published_at: new Date().toISOString(),
      last_published_key: `${reserved.media}:${reserved.id}`,
      total_published: Number(current.total_published || 0) + 1,
      last_error: '',
    })
  } catch (error) {
    saveAutoDraftState({
      worker_running: false,
      last_checked_at: new Date().toISOString(),
      last_error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    autoDraftTickRunning = false
  }
}

function ensureAutoDraftWorker() {
  const state = loadAutoDraftState()
  if (state.enabled) {
    if (!autoDraftTimer) {
      autoDraftTimer = setInterval(() => {
        void runAutoDraftTick()
      }, AUTO_DRAFT_INTERVAL_MS)
      void runAutoDraftTick()
    }
    return
  }
  if (autoDraftTimer) {
    clearInterval(autoDraftTimer)
    autoDraftTimer = null
  }
  if (state.worker_running) saveAutoDraftState({ worker_running: false })
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

function loadStyleGuide() {
  const content = fs.existsSync(REWRITE_PROMPT_FILE) ? fs.readFileSync(REWRITE_PROMPT_FILE, 'utf8') : ''
  return { content }
}

function saveStyleGuide(input) {
  const next = String(input?.content || '')
  fs.writeFileSync(REWRITE_PROMPT_FILE, next)
  return loadStyleGuide()
}

function loadScoringGuide() {
  const content = fs.existsSync(SCORING_PROMPT_FILE) ? fs.readFileSync(SCORING_PROMPT_FILE, 'utf8') : ''
  return { content }
}

function saveScoringGuide(input) {
  const next = String(input?.content || '')
  fs.writeFileSync(SCORING_PROMPT_FILE, next)
  return loadScoringGuide()
}

async function runPollerctl(args = []) {
  const { stdout } = await execFileAsync(process.execPath, [POLLERCTL_SCRIPT_FILE, ...args], {
    cwd: path.resolve('..'),
    maxBuffer: 10 * 1024 * 1024,
  })
  return String(stdout || '').trim()
}

async function loadMediaControlStatus() {
  const raw = await runPollerctl(['status-json'])
  const parsed = raw ? JSON.parse(raw) : {}
  const medias = {}
  for (const media of MEDIA_KEYS) {
    const entry = parsed?.medias?.[media] || {}
    medias[media] = {
      key: media,
      label: MEDIA_LABELS[media] || media,
      enabled: Boolean(entry.enabled),
      running: Boolean(entry.running),
      pid: String(entry.pid || ''),
      last_success_at: String(entry?.runtime?.worker?.last_success_at || ''),
      last_error: String(entry?.runtime?.worker?.last_error || ''),
      last_result: String(entry?.runtime?.worker?.last_result || ''),
      interval_ms: Number(entry?.runtime?.interval_ms || 30_000),
    }
  }
  return {
    pipeline: {
      running: Boolean(parsed?.pipeline?.running),
      pid: String(parsed?.pipeline?.pid || ''),
    },
    medias,
  }
}

async function setMediaControl(media, enabled) {
  if (!MEDIA_KEYS.includes(media)) throw new Error('media not found')
  await runPollerctl(['set-media', media, enabled ? 'on' : 'off'])
  return await loadMediaControlStatus()
}

function normalizeImageUrl(item) {
  const raw = item?.image_url
  if (typeof raw === 'string') return raw
  if (raw == null) return ''
  return String(raw)
}

async function pruneMediaItems(media) {
  if (!MEDIA_KEYS.includes(media)) throw new Error('media not found')
  return await withDataLock(`prune:${media}`, async () => {
    const data = loadData()
    const items = Array.isArray(data?.[media]?.items) ? data[media].items : []
    const before = items.length
    if (before <= MEDIA_PRUNE_THRESHOLD) {
      return {
        media,
        before,
        after: before,
        removed: 0,
        threshold: MEDIA_PRUNE_THRESHOLD,
        keep: MEDIA_PRUNE_KEEP,
      }
    }
    data[media].items = items.slice(0, MEDIA_PRUNE_KEEP)
    saveData(data)
    return {
      media,
      before,
      after: data[media].items.length,
      removed: before - data[media].items.length,
      threshold: MEDIA_PRUNE_THRESHOLD,
      keep: MEDIA_PRUNE_KEEP,
    }
  })
}

function getPendingItems() {
  const data = loadData()
  const medias = ['theblockbeats', 'techflow', 'odaily']
  const result = {}

  for (const media of medias) {
    const items = (data[media]?.items || [])
      .filter((item) => String(item.ai_decision || '') !== 'drop')
      .sort((a, b) => toTime(b.published_at) - toTime(a.published_at))
      .map((item) => {
        const aiTitle = item.ai_title || item.title
        const aiBody = item.ai_body || item.content
        const hasAiOptimized = Boolean(item.ai_title && item.ai_body)
        const imageUrl = normalizeImageUrl(item)
        const aiDecision = String(item.ai_decision || '')
        const aiScore = typeof item.ai_score === 'number' ? item.ai_score : null
        const sourceFeatured = Boolean(item.is_featured)
        const chainthinkFeatured = aiDecision === 'feature' || Boolean(item.is_featured_candidate)

        return {
          media: item.media,
          id: item.id,
          title: item.title,
          summary: item.summary,
          content: item.content,
          link: item.link,
          original_link: item.original_link,
          image_url: imageUrl,
          source_is_featured: sourceFeatured,
          chainthink_is_featured: chainthinkFeatured,
          ai_score: aiScore,
          ai_decision: aiDecision,
          ai_score_reason: item.ai_score_reason || '',
          ai_risk_flags: Array.isArray(item.ai_risk_flags) ? item.ai_risk_flags : [],
          ai_dimensions: item.ai_dimensions && typeof item.ai_dimensions === 'object' ? item.ai_dimensions : {},
          published_at: item.published_at,
          review_reason: item.review_reason,
          rewritten_title: item.rewritten_title,
          rewritten_content: item.rewritten_content,
          ai_title: aiTitle,
          ai_body: aiBody,
          has_ai_optimized: hasAiOptimized,
          chainthink_draft_published_at: String(item.chainthink_draft_published_at || ''),
          chainthink_draft_publish_mode: String(item.chainthink_draft_publish_mode || ''),
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

app.get('/api/debug/item/:media/:id', (req, res) => {
  const { media, id } = req.params
  const data = loadData()
  const item = (data?.[media]?.items || []).find((x) => String(x.id) === String(id)) || null
  res.json({ ok: true, data: item })
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

app.get('/api/style-guide', (_req, res) => {
  try {
    res.json({ ok: true, data: loadStyleGuide() })
  } catch (error) {
    res.status(500).json({ ok: false, message: error instanceof Error ? error.message : String(error) })
  }
})

app.post('/api/style-guide', (req, res) => {
  try {
    const saved = saveStyleGuide(req.body || {})
    res.json({ ok: true, message: '重写提示词保存成功', data: saved })
  } catch (error) {
    res.status(400).json({ ok: false, message: error instanceof Error ? error.message : String(error) })
  }
})

app.post('/api/style-guide/override', (req, res) => {
  try {
    const saved = saveStyleGuide({ content: String(req.body?.override || '') })
    res.json({ ok: true, message: '重写提示词保存成功', data: saved })
  } catch (error) {
    res.status(400).json({ ok: false, message: error instanceof Error ? error.message : String(error) })
  }
})

app.get('/api/scoring-guide', (_req, res) => {
  try {
    res.json({ ok: true, data: loadScoringGuide() })
  } catch (error) {
    res.status(500).json({ ok: false, message: error instanceof Error ? error.message : String(error) })
  }
})

app.post('/api/scoring-guide', (req, res) => {
  try {
    const saved = saveScoringGuide(req.body || {})
    res.json({ ok: true, message: '评分提示词保存成功', data: saved })
  } catch (error) {
    res.status(400).json({ ok: false, message: error instanceof Error ? error.message : String(error) })
  }
})

app.get('/api/media-control', async (_req, res) => {
  try {
    const data = await loadMediaControlStatus()
    res.json({ ok: true, data })
  } catch (error) {
    res.status(500).json({ ok: false, message: error instanceof Error ? error.message : String(error) })
  }
})

app.post('/api/media-control/:media', async (req, res) => {
  try {
    const media = String(req.params.media || '').trim()
    const enabled = Boolean(req.body?.enabled)
    const data = await setMediaControl(media, enabled)
    res.json({ ok: true, message: enabled ? '已开启媒体抓取' : '已关闭媒体抓取', data })
  } catch (error) {
    res.status(400).json({ ok: false, message: error instanceof Error ? error.message : String(error) })
  }
})

app.post('/api/media-control/:media/prune', async (req, res) => {
  try {
    const media = String(req.params.media || '').trim()
    const result = await pruneMediaItems(media)
    const label = MEDIA_LABELS[media] || media
    const message = result.removed > 0
      ? `${label} 已清理 ${result.removed} 条旧快讯`
      : `${label} 当前不足 ${MEDIA_PRUNE_THRESHOLD} 条，无需清理`
    res.json({ ok: true, message, data: result })
  } catch (error) {
    res.status(400).json({ ok: false, message: error instanceof Error ? error.message : String(error) })
  }
})

app.get('/api/chainthink/auto-draft', (_req, res) => {
  res.json({ ok: true, data: loadAutoDraftState() })
})

app.post('/api/chainthink/auto-draft', (req, res) => {
  const enabled = Boolean(req.body?.enabled)
  const saved = saveAutoDraftState({
    enabled,
    worker_running: false,
    last_error: '',
  })
  ensureAutoDraftWorker()
  res.json({ ok: true, message: enabled ? '已开启全自动草稿' : '已关闭全自动草稿', data: saved })
})



app.get('/api/chainthink/config', (_req, res) => {
  try {
    const cfg = loadLocalEnvConfig()
    res.json({ ok: true, data: { ...cfg, token: '', hasToken: cfg.hasToken } })
  } catch (error) {
    res.status(400).json({ ok: false, message: error instanceof Error ? error.message : String(error) })
  }
})

app.post('/api/chainthink/config', (req, res) => {
  try {
    const saved = saveLocalEnvConfig(req.body || {})
    res.json({ ok: true, message: 'ChainThink token 配置已保存（重启 API 后生效）', data: { ...saved, token: '', hasToken: saved.hasToken } })
  } catch (error) {
    res.status(400).json({ ok: false, message: error instanceof Error ? error.message : String(error) })
  }
})

app.post('/api/chainthink/draft', async (req, res) => {
  try {
    const payload = req.body || {}
    const media = String(payload.media || '').trim()
    const id = String(payload.id || '').trim()
    let reserved = null
    if (media && id) {
      reserved = await reserveDraftPublish(media, id, 'manual')
      if (!reserved) {
        return res.status(400).json({ ok: false, message: '该快讯已推送草稿或正在推送中' })
      }
    }
    const response = await publishChainthinkDraft({
      ...(reserved || payload),
      title: String(payload.title || reserved?.title || '').trim(),
      text: String(payload.text || reserved?.text || '').trim(),
      link: String(payload.link || reserved?.link || '').trim(),
      imageUrl: String(payload.imageUrl || reserved?.imageUrl || '').trim(),
    })
    if (media && id) {
      await finishDraftPublish(media, id, 'manual', { ok: true })
    }
    res.json({ ok: true, message: '已发布到 ChainThink 草稿', data: response })
  } catch (error) {
    const payload = req.body || {}
    const media = String(payload.media || '').trim()
    const id = String(payload.id || '').trim()
    if (media && id) {
      await finishDraftPublish(media, id, 'manual', {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    res.status(400).json({ ok: false, message: error instanceof Error ? error.message : String(error) })
  }
})

app.listen(PORT, () => {
  ensureAutoDraftWorker()
  console.log(`flash-news dashboard api running on http://localhost:${PORT}`)
})
