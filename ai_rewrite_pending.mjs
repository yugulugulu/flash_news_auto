#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const BASE = __dirname
const DATA_FILE = path.join(BASE, 'kuaixun_v2.json')
const STYLE_FILE = path.join(BASE, 'chainthink_style.md')
const MODEL_CONFIG_FILE = path.join(BASE, 'model_config.json')

function load() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
}

function save(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))
}

function loadStyleGuide() {
  return fs.readFileSync(STYLE_FILE, 'utf8')
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
      if (item.reviewed === true && item.passed === 1 && (!item.ai_title || !item.ai_body)) {
        rows.push({
          media: item.media,
          id: String(item.id),
          title: item.title || '',
          summary: item.summary || '',
          content: item.content || item.summary || '',
          original_link: item.original_link || item.link || '',
          published_at: item.published_at || '',
          is_featured: Boolean(item.is_featured),
        })
      }
    }
  }
  return rows
}

function buildPrompt(styleGuide, items) {
  return `你是 ChainThink 的中文加密快讯编辑。你的任务是：把每一条“可推送快讯”都严格按照 ChainThink 风格进行 AI 改写。

你必须严格遵守下面这份风格规范（原文照读并执行，不要偷懒，不要模板化硬套，不要返回解释）：

${styleGuide}

额外强制要求：
1. 这次是“逐条 AI 改写”，不是脚本模板改写。每条都要基于原始内容理解后重写。
2. 输出必须是 JSON 数组，不要 markdown，不要解释，不要代码块。
3. 每个数组项字段必须为：media,id,ai_title,ai_body。
4. ai_title：中文新闻标题口吻，简洁、清楚，不要带原媒体抬头，不要写“ChainThink 消息”。
5. ai_body：必须是完整可读的 ChainThink 风格正文；正文第一句应尽量以“ChainThink 消息，X 月 X 日，…”或“ChainThink 消息，据…”开头。
6. 禁止照搬原媒体固定口吻，如“Odaily星球日报讯”“BlockBeats 消息”“TechFlow 消息”。
7. 禁止出现营销导流、夸张措辞、邀请码、群号、扫码、福利、上车、财富密码等垃圾词。
8. 禁止使用“（略）”“...”这类偷懒写法。
9. 不得编造事实；只允许基于提供的数据压缩、整理、改写。
10. 如果原文信息不足以支撑很长的正文，就写短一点，但必须完整、自然、像新闻，不要脚本腔。
11. 如果有来源线索（原文链接/内容中的监测机构、媒体、平台），优先在正文首句中用“据…”自然表达。
12. 你返回的 ai_body 里不要包含“标题：”“正文内容：”这类标签，直接给正文。
13. 如果原始快讯中带有原文链接、URL、域名、查看原文入口，ai_body 里必须彻底去除，不准保留任何链接，不准出现 http、https、www、.com、.cn、查看原文、原文链接 等字样。

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

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  })

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

function sanitizeAiBody(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/www\.\S+/gi, '')
    .replace(/\b[\w.-]+\.(com|cn|net|org|io|ai|xyz|co)\S*/gi, '')
    .replace(/\[?原文链接\]?[:：]?\s*\S*/gi, '')
    .replace(/查看原文[:：]?\s*\S*/gi, '')
    .replace(/原文链接|查看原文/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function patchData(data, rewrites) {
  const exactMap = new Map(rewrites.map((x) => [`${x.media || ''}:${x.id}`, x]))
  const idMap = new Map(rewrites.map((x) => [String(x.id), x]))
  let updated = 0
  for (const media of ['theblockbeats', 'techflow', 'odaily']) {
    for (const item of data?.[media]?.items || []) {
      const hit = exactMap.get(`${item.media}:${item.id}`) || idMap.get(String(item.id))
      if (!hit) continue
      item.ai_title = String(hit.ai_title || '').trim()
      item.ai_body = sanitizeAiBody(hit.ai_body)
      updated += 1
    }
  }
  return updated
}

async function main() {
  const data = load()
  const pending = collectPending(data)
  if (!pending.length) {
    console.log('no pending ai rewrite items')
    return
  }

  const styleGuide = loadStyleGuide()
  const modelConfig = loadModelConfig()
  const batchSize = 8
  let totalUpdated = 0
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize)
    const prompt = buildPrompt(styleGuide, batch)
    const raw = await callModel(prompt, modelConfig)
    const rewrites = parseJson(raw)
    totalUpdated += patchData(data, rewrites)
  }
  save(data)
  console.log(`ai rewritten ${totalUpdated} items`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
