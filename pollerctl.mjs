#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_DIR = __dirname
const SCRIPT = path.join(PROJECT_DIR, 'flash_news_v2.mjs')
const PID_FILE = path.join(PROJECT_DIR, 'flash_news_v2.pid')
const LOG_FILE = path.join(PROJECT_DIR, 'flash_news_v2.log')
const LOCK_FILE = path.join(PROJECT_DIR, '.poller.lock')
const TAB_STATE_FILE = path.join(PROJECT_DIR, 'tab_state.json')

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

function cleanRuntimeState() {
  for (const file of [PID_FILE, LOCK_FILE, TAB_STATE_FILE]) {
    try { fs.unlinkSync(file) } catch {}
  }
}

function status() {
  const pid = readPid()
  if (isRunning(pid)) {
    console.log(`running (pid=${pid})`)
  } else {
    console.log('not running')
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

  cleanRuntimeState()
  ensureLogFile()

  const out = fs.openSync(LOG_FILE, 'a')
  const child = spawn(process.execPath, [SCRIPT], {
    cwd: PROJECT_DIR,
    detached: true,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      NO_OPEN: process.env.NO_OPEN || '1',
      DISABLE_RUNTIME_REOPEN: process.env.DISABLE_RUNTIME_REOPEN || '1',
      BB_OPENCLAW: process.env.BB_OPENCLAW || '0',
    },
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
    cleanRuntimeState()
    return
  }

  try {
    process.kill(Number(pid), 'SIGTERM')
  } catch {}
  await new Promise((r) => setTimeout(r, 1000))

  if (isRunning(pid)) {
    try { process.kill(Number(pid), 'SIGKILL') } catch {}
  }

  cleanRuntimeState()
  console.log('stopped')
}

async function once() {
  try { fs.unlinkSync(LOCK_FILE) } catch {}
  const child = spawn(process.execPath, [SCRIPT], {
    cwd: PROJECT_DIR,
    stdio: 'inherit',
    env: { ...process.env, ONCE: '1', BB_OPENCLAW: process.env.BB_OPENCLAW || '0' },
  })
  await new Promise((resolve) => child.on('exit', (code) => {
    process.exitCode = code || 0
    resolve()
  }))
}

function clean() {
  cleanRuntimeState()
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
  console.log(`Usage: node pollerctl.mjs <command>\n\nCommands:\n  start      Start daemon\n  stop       Stop daemon\n  restart    Restart daemon\n  status     Show process and last logs\n  once       Run one cycle in foreground\n  logs       Tail log file\n  clean      Clear runtime state (pid/lock/tab_state)`) 
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
