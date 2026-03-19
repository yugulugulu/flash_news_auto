#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { loadDataFile, saveDataFile } from './data_file.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const BASE = path.resolve(__dirname, '..')

const data = loadDataFile()
let resetCount = 0
for (const media of ['theblockbeats', 'techflow', 'odaily']) {
  for (const item of data?.[media]?.items || []) {
    item.reviewed = false
    item.passed = null
    item.review_reason = ''
    item.ai_score = null
    item.ai_decision = ''
    item.ai_score_reason = ''
    item.ai_risk_flags = []
    item.ai_dimensions = {}
    item.is_featured_candidate = false
    item.ai_title = ''
    item.ai_body = ''
    resetCount += 1
  }
}
saveDataFile(data)
console.log(`reset ${resetCount} items for re-score`)
try {
  execFileSync('node', [path.join(BASE, 'scripts', 'ai_score_pending.mjs')], { stdio: 'inherit' })
  execFileSync('node', [path.join(BASE, 'scripts', 'ai_rewrite_pending.mjs')], { stdio: 'inherit' })
} catch (e) {
  process.exitCode = 1
}
