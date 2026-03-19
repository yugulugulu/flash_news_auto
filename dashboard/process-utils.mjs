import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function execFileSafe(file, args, options = {}) {
  try {
    return await execFileAsync(file, args, options)
  } catch (error) {
    if (typeof error?.code === 'number' || error?.code === 1) {
      return {
        stdout: String(error.stdout || ''),
        stderr: String(error.stderr || ''),
      }
    }
    throw error
  }
}

async function findListeningPids(port) {
  const { stdout } = await execFileSafe('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'])
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index)
}

async function findBusyPorts(ports) {
  const entries = await Promise.all(
    ports.map(async (port) => [port, await findListeningPids(port)]),
  )
  return Object.fromEntries(entries)
}

async function signalPids(pids, signal) {
  for (const pid of pids) {
    try {
      process.kill(Number(pid), signal)
    } catch {}
  }
}

export async function clearListeningPorts(ports, label = 'ports') {
  const firstPass = await findBusyPorts(ports)
  const initialPids = [...new Set(Object.values(firstPass).flat())]
  if (!initialPids.length) return { killed: [], remaining: [] }

  console.log(`[${label}] clearing listeners on ports ${ports.join(', ')}`)
  await signalPids(initialPids, 'SIGTERM')
  await sleep(800)

  const secondPass = await findBusyPorts(ports)
  const remaining = [...new Set(Object.values(secondPass).flat())]
  if (remaining.length) {
    console.log(`[${label}] force killing stale listeners: ${remaining.join(', ')}`)
    await signalPids(remaining, 'SIGKILL')
    await sleep(300)
  }

  const finalPass = await findBusyPorts(ports)
  const stillBusy = [...new Set(Object.values(finalPass).flat())]
  return {
    killed: initialPids,
    remaining: stillBusy,
  }
}
