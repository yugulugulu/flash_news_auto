#!/usr/bin/env node
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

const children = []
let shuttingDown = false

function run(name, command, args, cwd = __dirname) {
  const child = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    shell: false,
  })
  child.__name = name
  children.push(child)
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    if (code && code !== 0) {
      console.error(`[${name}] exited with code ${code}${signal ? ` signal=${signal}` : ''}`)
    }
  })
  return child
}

function runShell(name, script, cwd = __dirname) {
  const child = spawn('zsh', ['-lc', script], {
    cwd,
    stdio: 'inherit',
  })
  child.__name = name
  children.push(child)
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    if (code && code !== 0) {
      console.error(`[${name}] exited with code ${code}${signal ? ` signal=${signal}` : ''}`)
    }
  })
  return child
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

  try {
    await new Promise((resolve) => {
      const stopper = spawn('zsh', ['-lc', '../pollerctl stop || true'], {
        cwd: __dirname,
        stdio: 'inherit',
      })
      stopper.on('exit', () => resolve())
    })
  } catch {}

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
  await new Promise((resolve) => {
    const starter = spawn('zsh', ['-lc', '../pollerctl start || true'], {
      cwd: __dirname,
      stdio: 'inherit',
    })
    starter.on('exit', () => resolve())
  })

  run('api', 'node', ['server.mjs'], __dirname)
  runShell('web', 'npm run dev:web', __dirname)

  console.log('[dev-all] api + web + poller started. Press Ctrl+C to stop all.')
}

main().catch((error) => {
  console.error('[dev-all] failed to start', error)
  shutdown(1)
})
