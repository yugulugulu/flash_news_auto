#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_DIR = path.resolve(__dirname, '..')
const MEDIA_CONFIG_FILE = path.join(PROJECT_DIR, 'media_control.json')

const PIPELINE = {
  key: 'pipeline',
  script: path.join(PROJECT_DIR, 'scripts', 'flash_news_v2.mjs'),
  pidFile: path.join(PROJECT_DIR, 'flash_news_v2.pid'),
  logFile: path.join(PROJECT_DIR, 'flash_news_v2.log'),
  lockFile: path.join(PROJECT_DIR, '.poller.lock'),
  runtimeFile: path.join(PROJECT_DIR, 'flash_news_runtime.json'),
}

const MEDIA_SPECS = {
  theblockbeats: {
    key: 'theblockbeats',
    label: '律动',
    script: path.join(PROJECT_DIR, 'scripts', 'media', 'theblockbeats.mjs'),
    pidFile: path.join(PROJECT_DIR, 'flash_news_theblockbeats.pid'),
    logFile: path.join(PROJECT_DIR, 'flash_news_theblockbeats.log'),
    lockFile: path.join(PROJECT_DIR, '.poller.theblockbeats.lock'),
    runtimeFile: path.join(PROJECT_DIR, 'flash_news_runtime_theblockbeats.json'),
  },
  techflow: {
    key: 'techflow',
    label: '深潮',
    script: path.join(PROJECT_DIR, 'scripts', 'media', 'techflow.mjs'),
    pidFile: path.join(PROJECT_DIR, 'flash_news_techflow.pid'),
    logFile: path.join(PROJECT_DIR, 'flash_news_techflow.log'),
    lockFile: path.join(PROJECT_DIR, '.poller.techflow.lock'),
    runtimeFile: path.join(PROJECT_DIR, 'flash_news_runtime_techflow.json'),
  },
  odaily: {
    key: 'odaily',
    label: 'Odaily',
    script: path.join(PROJECT_DIR, 'scripts', 'media', 'odaily.mjs'),
    pidFile: path.join(PROJECT_DIR, 'flash_news_odaily.pid'),
    logFile: path.join(PROJECT_DIR, 'flash_news_odaily.log'),
    lockFile: path.join(PROJECT_DIR, '.poller.odaily.lock'),
    runtimeFile: path.join(PROJECT_DIR, 'flash_news_runtime_odaily.json'),
  },
}

const MEDIA_ORDER = ['theblockbeats', 'techflow', 'odaily']

function exists(p) {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

function ensureFile(p) {
  if (!exists(p)) fs.writeFileSync(p, '')
}

function readPid(pidFile) {
  try {
    return String(fs.readFileSync(pidFile, 'utf8')).trim()
  } catch {
    return ''
  }
}

function isRunning(pid) {
  if (!pid) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function removeFile(p) {
  try { fs.unlinkSync(p) } catch {}
}

function defaultMediaConfig() {
  return {
    theblockbeats: { enabled: true },
    techflow: { enabled: true },
    odaily: { enabled: true },
  }
}

function loadMediaConfig() {
  const defaults = defaultMediaConfig()
  if (!exists(MEDIA_CONFIG_FILE)) {
    fs.writeFileSync(MEDIA_CONFIG_FILE, JSON.stringify(defaults, null, 2))
    return defaults
  }
  const parsed = readJson(MEDIA_CONFIG_FILE) || {}
  return {
    theblockbeats: { enabled: parsed?.theblockbeats?.enabled !== false },
    techflow: { enabled: parsed?.techflow?.enabled !== false },
    odaily: { enabled: parsed?.odaily?.enabled !== false },
  }
}

function saveMediaConfig(next) {
  fs.writeFileSync(MEDIA_CONFIG_FILE, JSON.stringify(next, null, 2))
  return next
}

function setMediaEnabled(media, enabled) {
  if (!MEDIA_SPECS[media]) throw new Error(`unknown media: ${media}`)
  const config = loadMediaConfig()
  config[media] = { enabled: Boolean(enabled) }
  return saveMediaConfig(config)
}

function ensureLogFile(logFile) {
  ensureFile(logFile)
}

function buildStatusEntry(spec, enabled = true) {
  const pid = readPid(spec.pidFile)
  return {
    key: spec.key,
    label: spec.label || spec.key,
    enabled,
    pid,
    running: isRunning(pid),
    runtime: readJson(spec.runtimeFile),
    logFile: spec.logFile,
  }
}

function printStatusEntry(entry) {
  const runtime = entry.runtime
  const last = runtime?.worker?.last_success_at || runtime?.workers?.score?.last_success_at || runtime?.workers?.rewrite?.last_success_at || runtime?.stopped_at || 'never'
  const error = runtime?.worker?.last_error || runtime?.workers?.score?.last_error || runtime?.workers?.rewrite?.last_error || ''
  console.log(`${entry.label}: enabled=${entry.enabled ? 'on' : 'off'} running=${entry.running ? 'yes' : 'no'} pid=${entry.pid || '-'} last=${last}${error ? ` err=${error}` : ''}`)
}

function printLogSummary(logFile) {
  if (!exists(logFile)) return
  console.log(`--- ${path.basename(logFile)} ---`)
  const text = fs.readFileSync(logFile, 'utf8')
  const lines = text.trimEnd().split(/\r?\n/)
  for (const line of lines.slice(-3)) console.log(line)
}

async function startSpec(spec, extraEnv = {}) {
  const pid = readPid(spec.pidFile)
  if (isRunning(pid)) return { started: false, pid }

  removeFile(spec.pidFile)
  removeFile(spec.lockFile)
  removeFile(spec.runtimeFile)
  ensureLogFile(spec.logFile)

  const out = fs.openSync(spec.logFile, 'a')
  const child = spawn(process.execPath, [spec.script], {
    cwd: PROJECT_DIR,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ...extraEnv },
  })

  child.unref()
  fs.writeFileSync(spec.pidFile, String(child.pid))
  await new Promise((resolve) => setTimeout(resolve, 800))
  return { started: isRunning(child.pid), pid: String(child.pid) }
}

async function stopSpec(spec) {
  const pid = readPid(spec.pidFile)
  if (!isRunning(pid)) {
    removeFile(spec.pidFile)
    removeFile(spec.lockFile)
    return false
  }

  try {
    process.kill(Number(pid), 'SIGTERM')
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 1000))
  if (isRunning(pid)) {
    try { process.kill(Number(pid), 'SIGKILL') } catch {}
  }

  removeFile(spec.pidFile)
  removeFile(spec.lockFile)
  return true
}

async function start() {
  const mediaConfig = loadMediaConfig()
  await startSpec(PIPELINE)
  for (const media of MEDIA_ORDER) {
    if (!mediaConfig[media]?.enabled) continue
    await startSpec(MEDIA_SPECS[media])
  }
  console.log('started pipeline and enabled media workers')
}

async function stop() {
  for (const media of MEDIA_ORDER) {
    await stopSpec(MEDIA_SPECS[media])
  }
  await stopSpec(PIPELINE)
  console.log('stopped pipeline and media workers')
}

async function once() {
  const mediaConfig = loadMediaConfig()
  for (const media of MEDIA_ORDER) {
    if (!mediaConfig[media]?.enabled) continue
    const spec = MEDIA_SPECS[media]
    const child = spawn(process.execPath, [spec.script], {
      cwd: PROJECT_DIR,
      stdio: 'inherit',
      env: { ...process.env, ONCE: '1' },
    })
    await new Promise((resolve) => child.on('exit', (code) => {
      process.exitCode = code || 0
      resolve()
    }))
  }

  const pipeline = spawn(process.execPath, [PIPELINE.script], {
    cwd: PROJECT_DIR,
    stdio: 'inherit',
    env: { ...process.env, ONCE: '1' },
  })
  await new Promise((resolve) => pipeline.on('exit', (code) => {
    process.exitCode = process.exitCode || code || 0
    resolve()
  }))
}

function clean() {
  for (const spec of [PIPELINE, ...MEDIA_ORDER.map((media) => MEDIA_SPECS[media])]) {
    removeFile(spec.pidFile)
    removeFile(spec.lockFile)
    removeFile(spec.runtimeFile)
  }
  console.log('runtime state cleaned')
}

function statusJson() {
  const mediaConfig = loadMediaConfig()
  const payload = {
    pipeline: buildStatusEntry(PIPELINE, true),
    medias: Object.fromEntries(MEDIA_ORDER.map((media) => [media, buildStatusEntry(MEDIA_SPECS[media], Boolean(mediaConfig[media]?.enabled))])),
  }
  console.log(JSON.stringify(payload, null, 2))
}

function status() {
  const mediaConfig = loadMediaConfig()
  console.log('pipeline:')
  printStatusEntry(buildStatusEntry(PIPELINE, true))
  console.log('media:')
  for (const media of MEDIA_ORDER) {
    printStatusEntry(buildStatusEntry(MEDIA_SPECS[media], Boolean(mediaConfig[media]?.enabled)))
  }
  printLogSummary(PIPELINE.logFile)
  for (const media of MEDIA_ORDER) {
    printLogSummary(MEDIA_SPECS[media].logFile)
  }
}

async function setMedia(media, enabled) {
  if (!MEDIA_SPECS[media]) {
    console.error(`unknown media: ${media}`)
    process.exit(1)
  }
  setMediaEnabled(media, enabled)
  if (enabled) {
    await startSpec(MEDIA_SPECS[media])
  } else {
    await stopSpec(MEDIA_SPECS[media])
  }
  const entry = buildStatusEntry(MEDIA_SPECS[media], enabled)
  console.log(JSON.stringify({ ok: true, media, enabled, running: entry.running, pid: entry.pid }, null, 2))
}

function usage() {
  console.log(`Usage: node scripts/pollerctl.mjs <command>

Commands:
  start                    Start pipeline and enabled media workers
  stop                     Stop pipeline and all media workers
  restart                  Restart everything
  status                   Show aggregated status
  status-json              Print aggregated status as JSON
  once                     Run one round for enabled media, then score/rewrite once
  set-media <media> <on|off>  Enable or disable a media worker
  clean                    Clear runtime state
`)
}

const cmd = process.argv[2] || 'status'

switch (cmd) {
  case 'start':
    await start()
    break
  case 'stop':
    await stop()
    break
  case 'restart':
    await stop()
    await start()
    break
  case 'status':
    status()
    break
  case 'status-json':
    statusJson()
    break
  case 'once':
    await once()
    break
  case 'set-media': {
    const media = String(process.argv[3] || '').trim()
    const raw = String(process.argv[4] || '').trim().toLowerCase()
    if (!media || !['on', 'off'].includes(raw)) {
      usage()
      process.exit(1)
    }
    await setMedia(media, raw === 'on')
    break
  }
  case 'clean':
    clean()
    break
  default:
    usage()
    process.exitCode = 1
}
