#!/usr/bin/env node
import { fetchBlockbeats, runMediaWorker } from './common.mjs'

await runMediaWorker('theblockbeats', fetchBlockbeats)
