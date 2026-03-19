#!/usr/bin/env node
import { fetchOdaily, runMediaWorker } from './common.mjs'

await runMediaWorker('odaily', fetchOdaily)
