#!/usr/bin/env node
import { fetchTechflow, runMediaWorker } from './common.mjs'

await runMediaWorker('techflow', fetchTechflow)
