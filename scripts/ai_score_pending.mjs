#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { loadDataFile, saveDataFile } from './data_file.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const BASE = path.resolve(__dirname, '..')
const DATA_LOCK_FILE = path.join(BASE, '.kuaixun_v2.lock')
const MODEL_CONFIG_FILE = path.join(BASE, 'model_config.json')
const SCORE_PROMPT_FILE = path.join(BASE, 'template', 'scoring_prompt.md')

function load() {
  return loadDataFile()
}

function save(data) {
  saveDataFile(data)
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

function loadModelConfig() {
  if (!fs.existsSync(MODEL_CONFIG_FILE)) {
    return { provider: 'doubao', baseUrl: '', apiKey: '', model: '', enabled: false }
  }
  return JSON.parse(fs.readFileSync(MODEL_CONFIG_FILE, 'utf8'))
}

function loadScoringGuide() {
  if (!fs.existsSync(SCORE_PROMPT_FILE)) return ''
  return fs.readFileSync(SCORE_PROMPT_FILE, 'utf8').trim()
}

function collectPending(data) {
  const rows = []
  for (const media of ['theblockbeats', 'techflow', 'odaily']) {
    for (const item of data?.[media]?.items || []) {
      const needsScore = typeof item.ai_score !== 'number' || !String(item.ai_decision || '').trim()
      if (!needsScore) continue
      rows.push({
        media: item.media,
        id: String(item.id || ''),
        title: item.title || '',
        summary: item.summary || '',
        content: item.content || item.summary || '',
        original_link: item.original_link || item.link || '',
        published_at: item.published_at || '',
        is_featured: Boolean(item.is_featured),
      })
    }
  }
  return rows
}

function buildPrompt(scoringGuide, items) {
  return `你是中文加密快讯编辑，只做快讯评分，不做改写。

你现在的任务不是做普通新闻价值判断，而是严格按照下面这份“综合精选评分标准”，为后续自动精选与改写流程提供稳定评分。

请严格参考下面的评分标准：
${scoringGuide || '如果资料缺失，则按“重要主体 + 明确事件 + 可量化细节 + 市场影响 + 信源质量”的标准评分。'}

执行要求：
1. 只能依据输入文本本身评分，不得编造或补充输入中没有的事实。
2. score 取 0-100。
3. decision 只能是 feature / rewrite / review / drop。
4. 阈值固定：
   - score >= 85 => feature
   - 70-84 => rewrite
   - 55-69 => review
   - <55 => drop
5. dimensions 必须是对象，包含以下五个 0-25/25/20/15/15 区间的整数分项：
   - entity_importance: 0-25
   - event_materiality: 0-25
   - market_impact: 0-20
   - information_density: 0-15
   - source_quality: 0-15
6. score 应与 dimensions 大体一致，总分明显不一致时，以 dimensions 之和为准。
7. is_featured_candidate 只有在 decision=feature 时才允许为 true。

输出要求：
- 只返回 JSON 数组，不要 markdown，不要解释。
- 每项必须包含：
  media,id,score,decision,is_featured_candidate,reason,key_signal,risk_flags,dimensions
- reason: 1-3 条简短中文理由组成的字符串数组。
- key_signal: 一句中文，概括这条快讯最强的精选理由；如果没有强信号，也要明确写出最主要短板。
- risk_flags: 字符串数组，可包含 weak_entity / weak_event / low_impact / low_density / weak_source / promo / duplicate_like / off_topic 等。

待评分数据：
${JSON.stringify(items, null, 2)}`
}

async function callDoubao(prompt, config) {
  const baseUrl = String(config.baseUrl || '').replace(/\/$/, '')
  const apiKey = String(config.apiKey || '').trim()
  const model = String(config.model || '').trim()
  if (!(config.enabled && baseUrl && apiKey && model)) {
    throw new Error('doubao config incomplete')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 45000)
  let res
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('doubao request timeout after 45s')
    throw error
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`doubao http ${res.status}: ${text.slice(0, 400)}`)
  }

  const json = await res.json()
  const text = json?.choices?.[0]?.message?.content
  if (!text) throw new Error('doubao empty response')
  return text
}

function callClaude(prompt) {
  return execFileSync('claude', ['--permission-mode', 'bypassPermissions', '--print', prompt], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
}

async function callModel(prompt, config) {
  if (config?.provider === 'doubao' && config?.enabled) {
    return await callDoubao(prompt, config)
  }
  return callClaude(prompt)
}

function parseJson(text) {
  const trimmed = text.trim()
  try { return JSON.parse(trimmed) } catch {}
  const m = trimmed.match(/\[[\s\S]*\]/)
  if (m) return JSON.parse(m[0])
  throw new Error('AI output is not valid JSON')
}

function normalizeDecision(score, decision) {
  if (decision && ['feature', 'rewrite', 'review', 'drop'].includes(decision)) return decision
  if (score >= 85) return 'feature'
  if (score >= 70) return 'rewrite'
  if (score >= 55) return 'review'
  return 'drop'
}

function normalizeDimensionValue(value, max) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0
  return Math.max(0, Math.min(max, Math.round(num)))
}

function normalizeDimensions(dimensions) {
  const source = dimensions && typeof dimensions === 'object' ? dimensions : {}
  return {
    entity_importance: normalizeDimensionValue(source.entity_importance, 25),
    event_materiality: normalizeDimensionValue(source.event_materiality, 25),
    market_impact: normalizeDimensionValue(source.market_impact, 20),
    information_density: normalizeDimensionValue(source.information_density, 15),
    source_quality: normalizeDimensionValue(source.source_quality, 15),
  }
}

function sumDimensions(dimensions) {
  return Object.values(normalizeDimensions(dimensions)).reduce((sum, value) => sum + value, 0)
}

function patchData(data, scoredItems) {
  const exactMap = new Map(scoredItems.map((x) => [`${x.media || ''}:${x.id}`, x]))
  const idMap = new Map(scoredItems.map((x) => [String(x.id), x]))
  let updated = 0
  for (const media of ['theblockbeats', 'techflow', 'odaily']) {
    for (const item of data?.[media]?.items || []) {
      const hit = exactMap.get(`${item.media}:${item.id}`) || idMap.get(String(item.id))
      if (!hit) continue
      const dimensions = normalizeDimensions(hit.dimensions)
      const scoreFromDimensions = sumDimensions(dimensions)
      const rawScore = Number(hit.score || 0)
      const score = Number.isFinite(rawScore) && Math.abs(rawScore - scoreFromDimensions) <= 8
        ? Math.round(rawScore)
        : scoreFromDimensions
      const decision = normalizeDecision(score, String(hit.decision || '').trim())
      item.ai_score = score
      item.ai_decision = decision
      item.ai_score_reason = Array.isArray(hit.reason) ? hit.reason.join(' | ') : String(hit.reason || '')
      item.ai_risk_flags = Array.isArray(hit.risk_flags) ? hit.risk_flags : []
      item.ai_dimensions = dimensions
      item.ai_key_signal = String(hit.key_signal || '').trim()
      item.reviewed = true
      item.passed = decision === 'drop' ? 0 : 1
      item.review_reason = `ai_score=${score}; decision=${decision}${item.ai_key_signal ? `; key_signal=${item.ai_key_signal}` : ''}`
      item.is_featured_candidate = Boolean(hit.is_featured_candidate) || decision === 'feature'
      updated += 1
    }
  }
  return updated
}

async function main() {
  const pending = collectPending(load())
  if (!pending.length) {
    console.log('no pending ai score items')
    return
  }

  const modelConfig = loadModelConfig()
  const scoringGuide = loadScoringGuide()
  const batchSize = Number(process.env.AI_SCORE_BATCH_SIZE || 3)
  let totalUpdated = 0
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize)
    console.log(`scoring batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(pending.length / batchSize)} size=${batch.length}`)
    const prompt = buildPrompt(scoringGuide, batch)
    const raw = await callModel(prompt, modelConfig)
    const scored = parseJson(raw)
    totalUpdated += await withDataLock('score:patch', async () => {
      const latest = load()
      const updated = patchData(latest, scored)
      save(latest)
      return updated
    })
  }
  console.log(`ai scored ${totalUpdated} items`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
