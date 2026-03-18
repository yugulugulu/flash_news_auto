#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_DIR = path.resolve(__dirname, '..')
const SCRIPT = path.join(PROJECT_DIR, 'scripts', 'flash_news_v2.mjs')
const PID_FILE = path.join(PROJECT_DIR, 'flash_news_v2.pid')
const LOG_FILE = path.join(PROJECT_DIR, 'flash_news_v2.log')
const LOCK_FILE = path.join(PROJECT_DIR, '.poller.lock')
const STATUS_FILE = path.join(PROJECT_DIR, 'flash_news_runtime.json')

function exists(p) {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

function readPid() {
  try {
    return String(fs.readFileSync(PID_FILE, 'utf8')).trim()
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

function ensureLogFile() {
  if (!exists(LOG_FILE)) fs.writeFileSync(LOG_FILE, '')
}

function cleanRuntimeState(includeStatus = false) {
  const files = includeStatus ? [PID_FILE, LOCK_FILE, STATUS_FILE] : [PID_FILE, LOCK_FILE]
  for (const file of files) {
    try { fs.unlinkSync(file) } catch {}
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function formatWorkerLine(name, state) {
  if (!state) return `${name}: no state`
  const status = state.running ? 'running' : 'idle'
  const last = state.last_success_at || state.last_finished_at || 'never'
  const error = state.last_error ? ` err=${state.last_error}` : ''
  return `${name}: ${status}, runs=${state.total_runs || 0}, last=${last}, duration=${state.last_duration_ms || 0}ms${error}`
}

function status() {
  const pid = readPid()
  const running = isRunning(pid)
  if (running) {
    console.log(`running (pid=${pid})`)
  } else {
    console.log('not running')
  }

  const runtime = readJson(STATUS_FILE)
  if (runtime) {
    console.log('--- runtime ---')
    const runtimeMatches = running && String(runtime.pid || '') === String(pid)
    console.log(`mode=${runtime.mode || 'daemon'} fetch=${runtime.intervals_ms?.fetch || 0}ms score=${runtime.intervals_ms?.score || 0}ms rewrite=${runtime.intervals_ms?.rewrite || 0}ms${runtimeMatches ? '' : ' stale=true'}`)
    const workers = runtimeMatches
      ? runtime.workers
      : {
          fetch: { ...(runtime.workers?.fetch || {}), running: false },
          score: { ...(runtime.workers?.score || {}), running: false },
          rewrite: { ...(runtime.workers?.rewrite || {}), running: false },
        }
    console.log(formatWorkerLine('fetch', workers?.fetch))
    console.log(formatWorkerLine('score', workers?.score))
    console.log(formatWorkerLine('rewrite', workers?.rewrite))
  }

  if (exists(LOG_FILE)) {
    console.log('--- last log ---')
    const text = fs.readFileSync(LOG_FILE, 'utf8')
    const lines = text.trimEnd().split(/\r?\n/)
    for (const line of lines.slice(-3)) console.log(line)
  }
}

async function start() {
  const pid = readPid()
  if (isRunning(pid)) {
    console.log(`already running (pid=${pid})`)
    return
  }

  cleanRuntimeState(true)
  ensureLogFile()

  const out = fs.openSync(LOG_FILE, 'a')
  const child = spawn(process.execPath, [SCRIPT], {
    cwd: PROJECT_DIR,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env },
  })

  child.unref()
  fs.writeFileSync(PID_FILE, String(child.pid))
  await new Promise((r) => setTimeout(r, 800))

  if (isRunning(child.pid)) {
    console.log(`started (pid=${child.pid})`)
  } else {
    console.log(`failed to start, check log: ${LOG_FILE}`)
    process.exitCode = 1
  }
}

async function stop() {
  const pid = readPid()
  if (!isRunning(pid)) {
    console.log('not running')
    cleanRuntimeState(true)
    return
  }

  try {
    process.kill(Number(pid), 'SIGTERM')
  } catch {}
  await new Promise((r) => setTimeout(r, 1000))

  if (isRunning(pid)) {
    try { process.kill(Number(pid), 'SIGKILL') } catch {}
  }

  cleanRuntimeState(true)
  console.log('stopped')
}

async function once() {
  const child = spawn(process.execPath, [SCRIPT], {
    cwd: PROJECT_DIR,
    stdio: 'inherit',
    env: { ...process.env, ONCE: '1' },
  })
  await new Promise((resolve) => child.on('exit', (code) => {
    process.exitCode = code || 0
    resolve()
  }))
}

function clean() {
  cleanRuntimeState(true)
  console.log('runtime state cleaned')
}

async function logs() {
  ensureLogFile()
  console.log(`tailing ${LOG_FILE} (Ctrl+C to stop)`) 
  let lastSize = 0
  const printNew = () => {
    const text = fs.readFileSync(LOG_FILE, 'utf8')
    if (text.length > lastSize) {
      process.stdout.write(text.slice(lastSize))
      lastSize = text.length
    }
  }
  printNew()
  const timer = setInterval(printNew, 1000)
  process.on('SIGINT', () => {
    clearInterval(timer)
    process.exit(0)
  })
}

function usage() {
  console.log(`Usage: node scripts/pollerctl.mjs <command>\n\nCommands:\n  start      Start daemon\n  stop       Stop daemon\n  restart    Restart daemon\n  status     Show process and last logs\n  once       Run one cycle in foreground\n  logs       Tail log file\n  clean      Clear runtime state (pid/lock)`)
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
  case 'once':
    await once()
    break
  case 'logs':
    await logs()
    break
  case 'clean':
    clean()
    break
  default:
    usage()
    process.exitCode = 1
}
