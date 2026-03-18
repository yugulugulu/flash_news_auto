#!/usr/bin/env node
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const pollerctlPath = path.resolve(__dirname, '../scripts/pollerctl.mjs')
const children = []
let shuttingDown = false

function attachChild(name, child) {
  child.__name = name
  children.push(child)
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    if (code && code !== 0) {
      console.error(`[${name}] exited with code ${code}${signal ? ` signal=${signal}` : ''}`)
    }
  })
  child.on('error', (error) => {
    if (shuttingDown) return
    console.error(`[${name}] failed to start:`, error.message)
  })
  return child
}

function runNode(name, args, cwd = __dirname) {
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: 'inherit',
  })
  return attachChild(name, child)
}

function runViteDev(name, cwd = __dirname) {
  const viteBin = path.resolve(__dirname, 'node_modules/vite/bin/vite.js')
  const child = spawn(process.execPath, [viteBin, '--host', '0.0.0.0'], {
    cwd,
    stdio: 'inherit',
  })
  return attachChild(name, child)
}

async function runPollerCommand(command) {
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [pollerctlPath, command], {
      cwd: __dirname,
      stdio: 'inherit',
    })
    child.on('exit', () => resolve())
    child.on('error', () => resolve())
  })
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  console.log('\n[dev-all] shutting down api/web/poller...')

  for (const child of children) {
    try {
      if (!child.killed) child.kill('SIGTERM')
    } catch {}
  }

  await new Promise((resolve) => setTimeout(resolve, 500))
  await runPollerCommand('stop')

  for (const child of children) {
    try {
      if (!child.killed) child.kill('SIGKILL')
    } catch {}
  }

  process.exit(exitCode)
}

process.on('SIGINT', () => {
  shutdown(0)
})
process.on('SIGTERM', () => {
  shutdown(0)
})

async function main() {
  await runPollerCommand('stop')
  await runPollerCommand('start')
  runNode('api', ['server.mjs'], __dirname)
  runViteDev('web', __dirname)
  console.log('[dev-all] api + web + poller started. Press Ctrl+C to stop all.')
}

main().catch((error) => {
  console.error('[dev-all] failed to start', error)
  shutdown(1)
})
