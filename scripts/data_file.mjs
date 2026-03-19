import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const BASE = path.resolve(__dirname, '..')

export const PRIMARY_DATA_FILE = path.join(BASE, 'kuaixun_v2.json')
export const LOCAL_DATA_FILE = path.join(BASE, 'kuaixun_v2.local.json')

export function createEmptyDataStore() {
  return {
    theblockbeats: { items: [] },
    techflow: { items: [] },
    odaily: { items: [] },
  }
}

export function resolveDataFile() {
  return fs.existsSync(LOCAL_DATA_FILE) ? LOCAL_DATA_FILE : PRIMARY_DATA_FILE
}

export function ensureDataFile() {
  const file = resolveDataFile()
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(createEmptyDataStore(), null, 2))
  }
  return file
}

export function loadDataFile() {
  const file = ensureDataFile()
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function saveDataFile(data) {
  const file = ensureDataFile()
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
  return file
}
