#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE = path.resolve(__dirname, '..');
const OUT_FILE = path.join(BASE, 'kuaixun_v2.json');
const LOCK_FILE = path.join(BASE, '.poller.lock');
const DATA_LOCK_FILE = path.join(BASE, '.kuaixun_v2.lock');
const RUNTIME_STATUS_FILE = path.join(BASE, 'flash_news_runtime.json');
const LIMIT = 5;
const FETCH_INTERVAL_MS = readPositiveInt(process.env.POLL_INTERVAL_MS, 30 * 1000);
const SCORE_INTERVAL_MS = readPositiveInt(process.env.AI_SCORE_INTERVAL_MS, 15 * 1000);
const REWRITE_INTERVAL_MS = readPositiveInt(process.env.AI_REWRITE_INTERVAL_MS, 15 * 1000);
const AI_SCORE_TIMEOUT_MS = readPositiveInt(process.env.AI_SCORE_TIMEOUT_MS, 120 * 1000);
const AI_REWRITE_TIMEOUT_MS = readPositiveInt(process.env.AI_REWRITE_TIMEOUT_MS, 120 * 1000);
let lockHeld = false;
let shuttingDown = false;
const activeChildren = new Set();

const runtimeState = {
  pid: process.pid,
  started_at: new Date().toISOString(),
  mode: 'daemon',
  shutting_down: false,
  intervals_ms: {
    fetch: FETCH_INTERVAL_MS,
    score: SCORE_INTERVAL_MS,
    rewrite: REWRITE_INTERVAL_MS,
  },
  workers: {
    fetch: createWorkerState(),
    score: createWorkerState(),
    rewrite: createWorkerState(),
  },
};

function createWorkerState() {
  return {
    running: false,
    total_runs: 0,
    consecutive_failures: 0,
    last_started_at: '',
    last_finished_at: '',
    last_success_at: '',
    last_error: '',
    last_duration_ms: 0,
    last_result: '',
  };
}

function readPositiveInt(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripHtml(html = '') {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

function toBJT(tsMs) {
  const d = new Date(Number(tsMs));
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(d).replace('T', ' ');
}

function ensureStore() {
  if (!fs.existsSync(OUT_FILE)) {
    fs.writeFileSync(OUT_FILE, JSON.stringify({
      theblockbeats: { items: [] },
      techflow: { items: [] },
      odaily: { items: [] },
    }, null, 2));
  }
}

function loadStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
}

function saveStore(store) {
  fs.writeFileSync(OUT_FILE, JSON.stringify(store, null, 2));
}

function writeRuntimeStatus() {
  const tempFile = `${RUNTIME_STATUS_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(runtimeState, null, 2));
  fs.renameSync(tempFile, RUNTIME_STATUS_FILE);
}

function keyOf(item) {
  return item.id ? `${item.media}:${item.id}` : `${item.media}:${item.link || `${item.title}@${item.published_at}`}`;
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function acquireProcessLock() {
  const owner = { pid: process.pid, started_at: new Date().toISOString() };
  while (true) {
    try {
      fs.writeFileSync(LOCK_FILE, JSON.stringify(owner), { flag: 'wx' });
      lockHeld = true;
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let existing = null;
      try {
        existing = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      } catch {}
      if (existing?.pid && pidAlive(existing.pid)) {
        throw new Error(`another_instance_running lock=${LOCK_FILE} owner=${JSON.stringify(existing)}`);
      }
      try {
        fs.unlinkSync(LOCK_FILE);
      } catch {}
    }
  }
}

function releaseProcessLock() {
  if (!lockHeld) return;
  lockHeld = false;
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {}
}

async function withDataLock(ownerLabel, fn) {
  const owner = { pid: process.pid, task: ownerLabel, started_at: new Date().toISOString() };
  while (true) {
    try {
      fs.writeFileSync(DATA_LOCK_FILE, JSON.stringify(owner), { flag: 'wx' });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let existing = null;
      try {
        existing = JSON.parse(fs.readFileSync(DATA_LOCK_FILE, 'utf8'));
      } catch {}
      if (existing?.pid && pidAlive(existing.pid)) {
        await sleep(100);
        continue;
      }
      try {
        fs.unlinkSync(DATA_LOCK_FILE);
      } catch {}
    }
  }

  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(DATA_LOCK_FILE);
    } catch {}
  }
}

function mergeItems(store, media, items) {
  const existing = store[media].items;
  const indexByKey = new Map(existing.map((item, index) => [keyOf(item), index]));
  const added = [];
  let updated = 0;

  for (const item of items) {
    const key = keyOf(item);
    const hitIndex = indexByKey.get(key);
    if (hitIndex !== undefined) {
      const prev = existing[hitIndex];
      const nextFeatured = Boolean(item.is_featured);
      const changed =
        prev.title !== item.title ||
        prev.summary !== item.summary ||
        prev.content !== item.content ||
        prev.link !== item.link ||
        prev.original_link !== item.original_link ||
        prev.image_url !== item.image_url ||
        prev.published_at !== item.published_at ||
        Boolean(prev.is_featured) !== nextFeatured;

      if (changed) {
        existing[hitIndex] = {
          ...prev,
          title: item.title,
          summary: item.summary,
          content: item.content,
          link: item.link,
          original_link: item.original_link,
          image_url: item.image_url || '',
          published_at: item.published_at,
          is_featured: nextFeatured,
          fetched_at: item.fetched_at,
        };
        updated += 1;
      }
      continue;
    }

    indexByKey.set(key, existing.length + added.length);
    added.push(item);
  }

  if (added.length) store[media].items = [...added, ...existing];
  return { added, updated };
}

function pickFirstImageUrl(value = '') {
  const text = String(value || '');
  const match = text.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? match[1] : '';
}

function cleanChainThinkText(text = '') {
  return String(text)
    .replace(/^(Odaily星球日报讯|BlockBeats\s*消息|深潮\s*TechFlow\s*消息|TechFlow\s*消息|深潮\s*消息)\s*[，,]?/gi, '')
    .replace(/^[，,\s]*\d+\s*月\s*\d+\s*日[，,\s]*/g, '')
    .replace(/（略）|\.{3,}|…/g, '')
    .replace(/(立即|速来|别错过|冲|上车|邀请码|加群|扫码|报名|福利|抽奖|认购|积分|活动)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function httpJson(url, opts = {}) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0',
      accept: 'application/json, text/plain, */*',
      ...(opts.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return await response.json();
}

async function httpText(url, opts = {}) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0',
      accept: 'text/html,application/xhtml+xml',
      ...(opts.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return await response.text();
}

async function fetchTechflow() {
  const list = await httpJson('https://www.techflowpost.com/api/client/newsflashes?page=1&page_size=5&articleType=0');
  const rows = Array.isArray(list.data) ? list.data : (list.data?.list || []);
  const output = [];

  for (const row of rows.slice(0, LIMIT)) {
    let detail = row;
    try {
      detail = await httpJson(`https://www.techflowpost.com/api/client/newsflashes/${row.id}`);
    } catch {}

    const content = cleanChainThinkText(stripHtml(detail.content || detail.abstract || row.abstract || ''));
    output.push({
      media: 'techflow',
      id: String(row.id || detail.id || ''),
      title: (detail.title || row.title || '').replace(/^首发\s*/, '').trim(),
      summary: cleanChainThinkText(stripHtml(detail.abstract || row.abstract || '')).slice(0, 220),
      content,
      link: `https://www.techflowpost.com/zh-CN/newsletter/${row.id || detail.id}`,
      original_link: detail.url || detail.original_link || '',
      image_url: detail.image || detail.cover || detail.cover_url || detail.thumb || detail.thumbnail || detail.pic || detail.picture || pickFirstImageUrl(detail.content || '') || pickFirstImageUrl(row.abstract || '') || '',
      is_featured: Boolean(row.is_hot || detail.is_hot || false),
      published_at: detail.created_at ? toBJT(Date.parse(detail.created_at)) : '',
    });
  }

  return output;
}

async function fetchOdaily() {
  const json = await httpJson('https://web-api.odaily.news/newsflash/page?page=1&size=5', {
    headers: { 'x-locale': 'zh-CN' },
  });
  const rows = json.data?.list || [];
  return rows.slice(0, LIMIT).map((row) => ({
    media: 'odaily',
    id: String(row.id || ''),
    title: (row.title || '').trim(),
    summary: cleanChainThinkText(stripHtml(row.description || '')).slice(0, 220),
    content: cleanChainThinkText(stripHtml(row.description || '')),
    link: `https://www.odaily.news/zh-CN/newsflash/${row.id}`,
    original_link: row.originUrl || row.originalUrl || row.newsUrl || '',
    image_url: Array.isArray(row.images) && row.images.length ? String(row.images[0] || '') : '',
    is_featured: Boolean(row.isImportant),
    published_at: toBJT(row.publishTimestamp),
  }));
}

async function fetchBlockbeats() {
  const html = await httpText('https://www.theblockbeats.info/newsflash');
  const start = html.indexOf('window.__NUXT__=');
  if (start < 0) throw new Error('blockbeats __NUXT__ not found');
  const end = html.indexOf('</script>', start);
  const script = html.slice(start, end);
  const sandbox = { window: {}, document: {}, console };
  vm.runInNewContext(script, sandbox, { timeout: 3000 });
  const nuxt = sandbox.window.__NUXT__;
  const data = nuxt?.data?.[0];
  if (!data) throw new Error('blockbeats __NUXT__.data[0] missing');

  const items = [];
  for (const day of data.days || []) {
    for (const child of day.children || []) items.push(child);
  }

  return items.slice(0, LIMIT).map((row) => ({
    media: 'theblockbeats',
    id: String(row.article_id || row.id || ''),
    title: (row.title || '').replace(/^首发\s*/, '').trim(),
    summary: cleanChainThinkText(stripHtml(row.content || row.abstract || '')).slice(0, 220),
    content: cleanChainThinkText(stripHtml(row.content || '')),
    link: `https://www.theblockbeats.info/flash/${row.article_id || row.id}`,
    original_link: row.url || '',
    image_url: row.img_url || row.c_img_url || '',
    is_featured: Boolean(row.is_hot || row.is_show_home),
    published_at: row.add_time ? toBJT(Number(row.add_time) * 1000) : '',
  }));
}

function buildPendingFields(item) {
  return {
    ...item,
    fetched_at: new Date().toISOString(),
    reviewed: false,
    passed: null,
    review_reason: '',
    rewritten_title: '',
    rewritten_content: '',
    ai_title: '',
    ai_body: '',
    ai_score: null,
    ai_decision: '',
    ai_score_reason: '',
    ai_risk_flags: [],
    ai_dimensions: {},
    is_featured_candidate: false,
  };
}

function updateWorkerState(name, patch) {
  Object.assign(runtimeState.workers[name], patch);
  writeRuntimeStatus();
}

function formatFetchReport(report) {
  return report.map((item) => (
    item.ok
      ? `${item.media}: +${item.added}/${item.fetched}, updated=${item.updated}`
      : `${item.media}: ERR ${item.error}`
  )).join(' | ');
}

function runNodeScript(scriptPath, env, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: BASE,
      stdio: 'inherit',
      env: {
        ...process.env,
        ...env,
      },
    });
    activeChildren.add(child);
    let settled = false;
    let timedOut = false;
    let timer = null;
    let forceKillTimer = null;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      activeChildren.delete(child);
      if (error) reject(error);
      else resolve(result);
    };

    forceKillTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
    }, timeoutMs + 5000);
    forceKillTimer.unref?.();

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {}
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(forceKillTimer);
      finish(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(forceKillTimer);
      if (timedOut) {
        finish(new Error(`${label} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code === 0) {
        finish(null, `${label} ok`);
        return;
      }
      finish(new Error(`${label} exited with ${signal || code}`));
    });
  });
}

async function runAiScore() {
  return await runNodeScript(
    path.join(BASE, 'scripts', 'ai_score_pending.mjs'),
    { AI_SCORE_BATCH_SIZE: process.env.AI_SCORE_BATCH_SIZE || '1' },
    AI_SCORE_TIMEOUT_MS,
    'ai score',
  );
}

async function runAiRewrite() {
  return await runNodeScript(
    path.join(BASE, 'scripts', 'ai_rewrite_pending.mjs'),
    { AI_REWRITE_BATCH_SIZE: process.env.AI_REWRITE_BATCH_SIZE || '1' },
    AI_REWRITE_TIMEOUT_MS,
    'ai rewrite',
  );
}

async function runWorkerCycle(name, runner) {
  const state = runtimeState.workers[name];
  if (state.running) return null;

  const startedAt = Date.now();
  updateWorkerState(name, {
    running: true,
    total_runs: state.total_runs + 1,
    last_started_at: new Date(startedAt).toISOString(),
    last_error: '',
  });

  try {
    const result = await runner();
    updateWorkerState(name, {
      running: false,
      consecutive_failures: 0,
      last_finished_at: new Date().toISOString(),
      last_success_at: new Date().toISOString(),
      last_duration_ms: Date.now() - startedAt,
      last_result: String(result || ''),
    });
    return result;
  } catch (error) {
    updateWorkerState(name, {
      running: false,
      consecutive_failures: state.consecutive_failures + 1,
      last_finished_at: new Date().toISOString(),
      last_duration_ms: Date.now() - startedAt,
      last_error: String(error?.message || error),
    });
    console.error(`[${new Date().toISOString()}] ${name} failed`, error?.message || error);
    return null;
  }
}

async function mergeFetchedItems(media, items) {
  const normalized = items.map(buildPendingFields);
  return await withDataLock(`fetch:${media}`, async () => {
    const store = loadStore();
    const merged = mergeItems(store, media, normalized);
    saveStore(store);
    return merged;
  });
}

async function pollOnce() {
  const report = [];
  const sources = [
    ['theblockbeats', fetchBlockbeats],
    ['techflow', fetchTechflow],
    ['odaily', fetchOdaily],
  ];

  for (const [media, fetcher] of sources) {
    try {
      const items = await fetcher();
      const { added, updated } = await mergeFetchedItems(media, items);
      report.push({
        media,
        ok: true,
        fetched: items.length,
        added: added.length,
        updated,
      });
    } catch (error) {
      report.push({ media, ok: false, error: String(error?.message || error) });
    }
  }

  return report;
}

async function runFetchCycle() {
  const startedAt = Date.now();
  const report = await pollOnce();
  const summary = formatFetchReport(report);
  console.log(`[${new Date().toISOString()}] fetch took=${Date.now() - startedAt}ms ${summary}`);
  return summary;
}

async function workerLoop(name, intervalMs, runner) {
  while (!shuttingDown) {
    const startedAt = Date.now();
    await runWorkerCycle(name, runner);
    if (shuttingDown) break;
    const sleepMs = Math.max(0, intervalMs - (Date.now() - startedAt));
    await sleep(sleepMs);
  }
}

async function shutdown(exitCode, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  runtimeState.shutting_down = true;
  runtimeState.shutdown_reason = reason;
  runtimeState.stopped_at = new Date().toISOString();
  writeRuntimeStatus();
  for (const child of activeChildren) {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
  await sleep(200);
  releaseProcessLock();
  process.exit(exitCode);
}

async function main() {
  acquireProcessLock();
  writeRuntimeStatus();
  const once = ['1', 'true'].includes(String(process.env.ONCE || '').toLowerCase());
  runtimeState.mode = once ? 'once' : 'daemon';
  writeRuntimeStatus();

  if (once) {
    await runWorkerCycle('fetch', runFetchCycle);
    await runWorkerCycle('score', runAiScore);
    await runWorkerCycle('rewrite', runAiRewrite);
    runtimeState.stopped_at = new Date().toISOString();
    writeRuntimeStatus();
    return;
  }

  await Promise.all([
    workerLoop('fetch', FETCH_INTERVAL_MS, runFetchCycle),
    workerLoop('score', SCORE_INTERVAL_MS, runAiScore),
    workerLoop('rewrite', REWRITE_INTERVAL_MS, runAiRewrite),
  ]);
}

process.on('exit', releaseProcessLock);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    void shutdown(0, signal);
  });
}

main().catch((error) => {
  console.error(error);
  void shutdown(1, 'fatal');
});
