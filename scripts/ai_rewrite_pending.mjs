#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const BASE = path.resolve(__dirname, '..')
const DATA_FILE = path.join(BASE, 'kuaixun_v2.json')
const DATA_LOCK_FILE = path.join(BASE, '.kuaixun_v2.lock')
const MODEL_CONFIG_FILE = path.join(BASE, 'model_config.json')
const REWRITE_PROMPT_FILE = path.join(BASE, 'template', 'rewrite_prompt.md')

function load() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
}

function save(data) {
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

function loadRewriteGuide() {
  if (!fs.existsSync(REWRITE_PROMPT_FILE)) return ''
  return fs.readFileSync(REWRITE_PROMPT_FILE, 'utf8').trim()
}

function loadModelConfig() {
  if (!fs.existsSync(MODEL_CONFIG_FILE)) {
    return { provider: 'doubao', baseUrl: '', apiKey: '', model: '', enabled: false }
  }
  return JSON.parse(fs.readFileSync(MODEL_CONFIG_FILE, 'utf8'))
}

function collectPending(data) {
  const rows = []
  for (const media of ['theblockbeats', 'techflow', 'odaily']) {
    for (const item of data?.[media]?.items || []) {
      if (item.reviewed === true && item.passed === 1 && ['feature', 'rewrite'].includes(String(item.ai_decision || '')) && (!item.ai_title || !item.ai_body)) {
        rows.push({
          media: item.media,
          id: String(item.id || ''),
          title: item.title || '',
          summary: item.summary || '',
          content: item.content || item.summary || '',
          original_link: item.original_link || item.link || '',
          published_at: item.published_at || '',
          ai_decision: String(item.ai_decision || ''),
          ai_score: typeof item.ai_score === 'number' ? item.ai_score : null,
          ai_key_signal: String(item.ai_key_signal || ''),
          is_featured_candidate: Boolean(item.is_featured_candidate),
          ai_dimensions: item.ai_dimensions && typeof item.ai_dimensions === 'object' ? item.ai_dimensions : {},
          ai_score_reason: String(item.ai_score_reason || ''),
        })
      }
    }
  }
  return rows
}

function buildPrompt(rewriteGuide, items) {
  return `你是 ChainThink 风格的中文快讯编辑，只做精简改写。

你的任务是把已通过评分的快讯，改写成适合推送和审阅的中文快讯成稿，并统一改写成 ChainThink 风格。
这些快讯已经经过“精选/改写”筛选，因此你必须参考下面这份唯一的改写模板。

请基于输入快讯生成 JSON 数组，每项字段必须为：media,id,ai_title,ai_body。

改写模板：
${rewriteGuide || '缺省要求：标题结果优先，正文统一改写成 ChainThink 风格，删除原媒体口吻和链接。'}

待改写数据：
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
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('doubao rewrite request timeout after 45s')
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
  const trimmed = String(text || '').trim().replace(/^```json\s*/i, '').replace(/^```/i, '').replace(/```$/i, '').trim()
  try { return JSON.parse(trimmed) } catch {}
  const m = trimmed.match(/\[[\s\S]*\]/)
  if (m) return JSON.parse(m[0])
  throw new Error('AI rewrite output is not valid JSON')
}

function patchData(data, rewrittenItems) {
  const exactMap = new Map(rewrittenItems.map((x) => [`${x.media || ''}:${x.id}`, x]))
  const idMap = new Map(rewrittenItems.map((x) => [String(x.id), x]))
  let updated = 0
  for (const media of ['theblockbeats', 'techflow', 'odaily']) {
    for (const item of data?.[media]?.items || []) {
      const hit = exactMap.get(`${item.media}:${item.id}`) || idMap.get(String(item.id))
      if (!hit) continue
      const nextTitle = String(hit.ai_title || '').trim()
      const nextBody = String(hit.ai_body || '').trim()
      if (!nextTitle || !nextBody) continue
      item.ai_title = nextTitle
      item.ai_body = nextBody
      updated += 1
    }
  }
  return updated
}

async function main() {
  const pending = collectPending(load())
  if (!pending.length) {
    console.log('no pending ai rewrite items')
    return
  }

  const rewriteGuide = loadRewriteGuide()
  const modelConfig = loadModelConfig()
  const batchSize = Number(process.env.AI_REWRITE_BATCH_SIZE || 1)
  let updated = 0
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize)
    console.log(`rewriting batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(pending.length / batchSize)} size=${batch.length}`)
    const prompt = buildPrompt(rewriteGuide, batch)
    const raw = await callModel(prompt, modelConfig)
    const rewritten = parseJson(raw)
    updated += await withDataLock('rewrite:patch', async () => {
      const latest = load()
      const patched = patchData(latest, rewritten)
      save(latest)
      return patched
    })
  }
  console.log(`ai rewritten ${updated} items`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
