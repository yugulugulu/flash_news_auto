#!/usr/bin/env node
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearListeningPorts } from './process-utils.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const pollerctlPath = path.resolve(__dirname, '../scripts/pollerctl.mjs')

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

async function main() {
  await clearListeningPorts([5173, 8787], 'stop-all')
  await runPollerCommand('stop')
  console.log('[stop-all] web/api/poller stopped')
}

main().catch((error) => {
  console.error('[stop-all] failed', error)
  process.exit(1)
})
