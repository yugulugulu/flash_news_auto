#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE = __dirname;
const OUT_FILE = path.join(BASE, 'kuaixun_v2.json');
const WORD_TMP = path.join(BASE, 'word_records_tmp.json');
const WORD_DOCX = path.join(BASE, 'push_records_v2.docx');
const LIMIT = 5;
const INTERVAL_MS = 2 * 60 * 1000;

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function stripHtml(html='') {
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
function toBJT(tsMs){
  const d = new Date(Number(tsMs));
  return new Intl.DateTimeFormat('sv-SE', { timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' }).format(d).replace('T',' ');
}
function ensureStore() {
  if (!fs.existsSync(OUT_FILE)) {
    fs.writeFileSync(OUT_FILE, JSON.stringify({ theblockbeats:{items:[]}, techflow:{items:[]}, odaily:{items:[]} }, null, 2));
  }
}
function loadStore(){ ensureStore(); return JSON.parse(fs.readFileSync(OUT_FILE,'utf8')); }
function saveStore(s){ fs.writeFileSync(OUT_FILE, JSON.stringify(s, null, 2)); }
function keyOf(it){ return it.id ? `${it.media}:${it.id}` : `${it.media}:${it.link || it.title+'@'+it.published_at}`; }
function mergeItems(store, media, items){
  const exist = store[media].items;
  const indexByKey = new Map(exist.map((item, index) => [keyOf(item), index]));
  const added=[];
  let updated=0;
  for (const it of items){
    const k = keyOf(it);
    const hitIndex = indexByKey.get(k);
    if (hitIndex !== undefined) {
      const prev = exist[hitIndex];
      const nextFeatured = Boolean(it.is_featured);
      const changed =
        prev.title !== it.title ||
        prev.summary !== it.summary ||
        prev.content !== it.content ||
        prev.link !== it.link ||
        prev.original_link !== it.original_link ||
        prev.image_url !== it.image_url ||
        prev.published_at !== it.published_at ||
        Boolean(prev.is_featured) !== nextFeatured;
      if (changed) {
        exist[hitIndex] = {
          ...prev,
          title: it.title,
          summary: it.summary,
          content: it.content,
          link: it.link,
          original_link: it.original_link,
          image_url: it.image_url || '',
          published_at: it.published_at,
          is_featured: nextFeatured,
        };
        updated++;
      }
      continue;
    }
    indexByKey.set(k, exist.length + added.length);
    added.push(it);
  }
  if (added.length) store[media].items = [...added, ...exist];
  return { added, updated };
}
function looksLikeAd(text='') {
  const t = text.toLowerCase();
  return ['立即','扫码','加群','邀请码','返佣','返现','抽奖','福利','限时','活动','认购','积分','联系客服','联系商务','稳赚','暴富'].some(k=>t.includes(k));
}
function scoreItem(it){
  let s=0; const t=`${it.title}\n${it.content}`;
  if (/(融资|破产|被盗|攻击|漏洞|黑客|监管|etf|上线|发布|内测|合作|收购|起诉|调查)/i.test(t)) s+=3;
  if (/(openai|claude|nvidia|英伟达|大模型|agent|智能体|算力|芯片|ai)/i.test(t)) s+=2;
  if (/(亿美元|万枚|%|\b\d+(?:\.\d+)?\b)/.test(t)) s+=1;
  if (it.original_link) s+=1;
  if (looksLikeAd(t)) s-=5;
  return s;
}

function pickFirstImageUrl(value='') {
  const text = String(value || '')
  const m = text.match(/<img[^>]+src=["']([^"']+)["']/i)
  return m ? m[1] : ''
}

function cleanChainThinkText(s='') {
  return String(s)
    .replace(/^(Odaily星球日报讯|BlockBeats\s*消息|深潮\s*TechFlow\s*消息|TechFlow\s*消息|深潮\s*消息)\s*[，,]?/gi,'')
    .replace(/^[，,\s]*\d+\s*月\s*\d+\s*日[，,\s]*/g,'')
    .replace(/（略）|\.{3,}|…/g,'')
    .replace(/(立即|速来|别错过|冲|上车|邀请码|加群|扫码|报名|福利|抽奖|认购|积分|活动)/g,'')
    .replace(/\s+/g,' ')
    .trim();
}
async function httpJson(url, opts={}){
  const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0','accept':'application/json, text/plain, */*',...(opts.headers||{})}});
  if(!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return await r.json();
}
async function httpText(url, opts={}){
  const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0','accept':'text/html,application/xhtml+xml',...(opts.headers||{})}});
  if(!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return await r.text();
}
async function fetchTechflow(){
  const list = await httpJson('https://www.techflowpost.com/api/client/newsflashes?page=1&page_size=5&articleType=0');
  const rows = Array.isArray(list.data) ? list.data : (list.data?.list || []);
  const out=[];
  for (const x of rows.slice(0,LIMIT)){
    let detail = x;
    try { detail = await httpJson(`https://www.techflowpost.com/api/client/newsflashes/${x.id}`); } catch {}
    const content = cleanChainThinkText(stripHtml(detail.content || detail.abstract || x.abstract || ''));
    out.push({
      media:'techflow',
      id:String(x.id||detail.id||''),
      title:(detail.title||x.title||'').replace(/^首发\s*/,'').trim(),
      summary: cleanChainThinkText(stripHtml(detail.abstract || x.abstract || '')).slice(0,220),
      content,
      link:`https://www.techflowpost.com/zh-CN/newsletter/${x.id||detail.id}`,
      original_link: detail.url || detail.original_link || '',
      image_url: detail.image || detail.cover || detail.cover_url || detail.thumb || detail.thumbnail || detail.pic || detail.picture || pickFirstImageUrl(detail.content || '') || pickFirstImageUrl(x.abstract || '') || '',
      is_featured:Boolean(x.is_hot || detail.is_hot || false),
      published_at: detail.created_at ? toBJT(Date.parse(detail.created_at)) : ''
    });
  }
  return out;
}
async function fetchOdaily(){
  const j = await httpJson('https://web-api.odaily.news/newsflash/page?page=1&size=5',{headers:{'x-locale':'zh-CN'}});
  const rows = j.data?.list || [];
  return rows.slice(0,LIMIT).map(x=>({
    media:'odaily',
    id:String(x.id||''),
    title:(x.title||'').trim(),
    summary: cleanChainThinkText(stripHtml(x.description||'')).slice(0,220),
    content: cleanChainThinkText(stripHtml(x.description||'')),
    link:`https://www.odaily.news/zh-CN/newsflash/${x.id}`,
    original_link: x.originUrl || x.originalUrl || x.newsUrl || '',
    image_url: Array.isArray(x.images) && x.images.length ? String(x.images[0] || '') : '',
    is_featured:Boolean(x.isImportant),
    published_at: toBJT(x.publishTimestamp)
  }));
}
async function fetchBlockbeats(){
  const html = await httpText('https://www.theblockbeats.info/newsflash');
  const start = html.indexOf('window.__NUXT__=');
  if (start < 0) throw new Error('blockbeats __NUXT__ not found');
  const end = html.indexOf('</script>', start);
  const script = html.slice(start, end);
  const sandbox = { window:{}, document:{}, console };
  vm.runInNewContext(script, sandbox, { timeout: 3000 });
  const nuxt = sandbox.window.__NUXT__;
  const d = nuxt?.data?.[0];
  if (!d) throw new Error('blockbeats __NUXT__.data[0] missing');
  const items=[];
  for (const day of d.days || []) {
    for (const x of day.children || []) items.push(x);
  }
  return items.slice(0,LIMIT).map(x=>({
    media:'theblockbeats',
    id:String(x.article_id || x.id || ''),
    title:(x.title||'').replace(/^首发\s*/,'').trim(),
    summary: cleanChainThinkText(stripHtml(x.content||x.abstract||'')).slice(0,220),
    content: cleanChainThinkText(stripHtml(x.content||'')),
    link:`https://www.theblockbeats.info/flash/${x.article_id || x.id}`,
    original_link: x.url || '',
    image_url: x.img_url || x.c_img_url || '',
    is_featured:Boolean(x.is_hot || x.is_show_home),
    published_at: x.add_time ? toBJT(Number(x.add_time)*1000) : ''
  }));
}
function appendWord(records){
  const scriptPath = path.join(BASE,'append_word_report.py');
  if (!fs.existsSync(scriptPath)) {
    console.warn('append_word_report.py missing, skip word export');
    return;
  }
  fs.writeFileSync(WORD_TMP, JSON.stringify({records}, null, 2));
  execFileSync('python3', [scriptPath, WORD_TMP, WORD_DOCX], { stdio:'inherit' });
}
function runAiRewrite(){
  try {
    execFileSync('node', [path.join(BASE, 'ai_rewrite_pending.mjs')], { stdio: 'inherit' });
  } catch (e) {
    console.error('ai rewrite failed', e?.message || e);
  }
}
function buildAiWordRecords(store, newlyPassedKeys){
  const keySet = new Set(newlyPassedKeys);
  const records = [];
  for (const media of ['theblockbeats', 'techflow', 'odaily']) {
    for (const item of store?.[media]?.items || []) {
      const key = keyOf(item);
      if (!keySet.has(key)) continue;
      if (!(item.reviewed === true && item.passed === 1)) continue;
      if (!item.ai_title || !item.ai_body) continue;
      records.push({
        media: item.media,
        published_at: item.published_at,
        before_title: item.title,
        before_content: item.content,
        before_original_link: item.original_link,
        after_title: item.ai_title,
        after_content: item.ai_body,
        after_original_link: item.original_link,
      });
    }
  }
  return records;
}
async function pollOnce(){
  const store = loadStore();
  const report=[]; const newlyPassedKeys=[];
  const sources=[['theblockbeats', fetchBlockbeats], ['techflow', fetchTechflow], ['odaily', fetchOdaily]];
  for (const [media, fn] of sources){
    try {
      const items = await fn();
      const normalized = items.map(it=>({...it, fetched_at:new Date().toISOString(), reviewed:false, passed:null, review_reason:'', rewritten_title:'', rewritten_content:'', ai_title:'', ai_body:''}));
      const { added, updated } = mergeItems(store, media, normalized);
      let reviewed=0, passed=0;
      for (const it of added){
        reviewed++;
        const ad = looksLikeAd(`${it.title}\n${it.content}\n${it.summary}`);
        const score = scoreItem(it);
        it.reviewed=true;
        it.passed = (!ad && score >= 2) ? 1 : 0;
        it.review_reason = ad ? `ad_block score=${score}` : `score=${score}`;
        if (it.passed===1){
          passed++;
          newlyPassedKeys.push(keyOf(it));
        }
      }
      report.push({media, ok:true, fetched:items.length, added:added.length, updated, reviewed, passed});
    } catch (e){ report.push({media, ok:false, error:String(e.message||e)}); }
  }
  saveStore(store);
  runAiRewrite();
  const updatedStore = loadStore();
  const wordRecords = buildAiWordRecords(updatedStore, newlyPassedKeys);
  if (wordRecords.length) appendWord(wordRecords);
  return report;
}
async function main(){
  const once = ['1','true'].includes(String(process.env.ONCE||'').toLowerCase());
  while (true){
    const st=Date.now();
    const report = await pollOnce();
    console.log(`[${new Date().toISOString()}] took=${Date.now()-st}ms ` + report.map(r=>r.ok?`${r.media}: +${r.added}/${r.fetched}, reviewed=${r.reviewed}, passed=${r.passed}`:`${r.media}: ERR ${r.error}`).join(' | '));
    if (once) break;
    await sleep(INTERVAL_MS);
  }
}
main().catch(err=>{ console.error(err); process.exit(1); });
