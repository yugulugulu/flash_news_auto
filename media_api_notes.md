# media_api_notes.md

> 目的：记录三家媒体（深潮 / 律动 / Odaily）快讯数据源的可用接口、字段结构、以及如何映射到统一 schema，便于后续重构抓取脚本。

---

# 1. 深潮 TechFlow

## 1.1 页面入口
```bash
https://www.techflowpost.com/zh-CN/newsletter?articleType=0
```

## 1.2 已确认的真实 API
### 快讯列表
```bash
GET https://www.techflowpost.com/api/client/newsflashes?page=1&page_size=5&articleType=0
```

### 单条快讯详情
```bash
GET https://www.techflowpost.com/api/client/newsflashes/<id>
```
示例：
```bash
GET https://www.techflowpost.com/api/client/newsflashes/116926
```

### 相关推荐
```bash
GET https://www.techflowpost.com/api/client/newsflashes/<id>/related?limit=3
```

### 快讯分类
```bash
GET https://www.techflowpost.com/api/client/newsflash-categories
```

## 1.3 来源确认方式
从页面 bundle：
```text
/_next/static/chunks/app/[locale]/newsletter/page-8e21ded3fa5a0acc.js
```
中可看到：
- `/client/newsflashes`
- `/client/newsflashes/:id`
- `/client/newsflashes/:id/related`
- `/client/newsflash-categories`

实际可用时需要在路径前加：
```text
https://www.techflowpost.com/api
```
即：
```text
https://www.techflowpost.com/api/client/newsflashes
```

## 1.4 典型字段
列表 / 详情 JSON 中常见字段：
- `id`
- `title`
- `abstract`
- `created_at` / 时间字段
- `original_link`（或正文中的外链）
- 详情中正文相关字段（需实际按返回结构取）

## 1.5 推荐接入方式
**优先直接走 API，不要再爬 DOM。**

---

# 2. Odaily 星球日报

## 2.1 页面入口
```bash
https://www.odaily.news/zh-CN/newsflash
```

## 2.2 已确认的真实 API 基础域名
```bash
https://web-api.odaily.news
```

该 baseURL 来自前端 JS bundle 中的 axios 配置：
```js
baseURL: "https://web-api.odaily.news"
```

## 2.3 已确认的 API
### 快讯列表
```bash
GET https://web-api.odaily.news/newsflash/page?page=1&size=5
```

### 检查是否有新快讯
```bash
GET https://web-api.odaily.news/newsflash/checkHasNew?lastId=<last_id>
```

## 2.4 典型返回结构
```json
{
  "code": 200,
  "msg": "操作成功",
  "data": {
    "total": 346201,
    "pageSize": 5,
    "pageNum": 1,
    "list": [
      {
        "id": 472429,
        "title": "...",
        "description": "<p>...</p>",
        "isImportant": true,
        "publishTimestamp": 1773678184000
      }
    ]
  }
}
```

## 2.5 关键字段
- `id`
- `title`
- `description`：HTML 正文
- `isImportant`：是否重要快讯（可视为精选）
- `publishTimestamp`

## 2.6 推荐接入方式
**优先直接走 API，不要再爬 DOM。**
并且 `description` 可直接做 HTML→文本清洗，正文精度会比抓页面高得多。

---

# 3. 律动 BlockBeats

## 3.1 页面入口
```bash
https://www.theblockbeats.info/newsflash
```

## 3.2 当前结论
律动暂时**没有像深潮 / Odaily 那样已确认的裸 REST JSON API**（至少当前公开路径直接 GET 返回的是 HTML 页面）。

我已经挖到的路径包括：
```bash
/newsflash/list?page=1&limit=10&ios=-2&end_time=&detective=
/newsflash/newestList
/newsflash/detail
/newsflash/important?limit=4
/newsflash/detective?limit=4
/newsflash/search_map?type=3
```

但直接请求这些地址时，返回的是 **HTML 页面**，而不是 JSON。

## 3.3 最稳的数据源：页面注入 JSON
页面里存在：
```js
window.__NUXT__.data[0]
```
这里包含了完整快讯数据，主要有：
- `days`
- `chainList`
- `hotFlash`
- `tabMeta`
- `detectiveMap`

### 3.3.1 主列表（按天分组）
```js
window.__NUXT__.data[0].days
```

每条快讯典型结构：
```json
{
  "id": 183572,
  "article_id": 336512,
  "content_id": 714617,
  "title": "多个鲸鱼地址正集体做多HYPE",
  "content": "<p>BlockBeats 消息，3 月 17 日，据 Lookonchain 监测...</p>",
  "url": "",
  "is_detective": 0,
  "is_first": 0,
  "is_hot": 0,
  "is_show_home": 0,
  "time": "00:26",
  "add_time": 1773678410
}
```

### 3.3.2 链上侦探列表
```js
window.__NUXT__.data[0].chainList
```

### 3.3.3 热门/重要快讯列表
```js
window.__NUXT__.data[0].hotFlash
```

### 3.3.4 分类 tab 元数据
```js
window.__NUXT__.data[0].tabMeta
```

## 3.4 推荐接入方式
### 当前最稳方案：
**在浏览器上下文中直接读 `window.__NUXT__.data[0]`**

也就是说，律动推荐的抓法不是“猜 HTTP API”，而是：
- 打开页面
- 在页面 JS 上下文里直接读取注入数据

## 3.5 字段说明
- `article_id`：可视为正文 id / 详情 id
- `content`：HTML 正文
- `url`：原文链接（部分条目为空）
- `is_detective`：是否链上侦探
- `is_first`：是否首发
- `is_hot`：热度标记（但不等于“重要快讯”的绝对判断）
- `time`：页面显示时间
- `add_time`：Unix 时间戳

---

# 4. 三家媒体统一字段映射建议

建议统一为：
```json
{
  "media": "techflow | odaily | theblockbeats",
  "id": "...",
  "title": "...",
  "summary": "...",
  "content": "...",
  "original_link": "...",
  "is_featured": true,
  "published_at": "2026-03-17 00:26"
}
```

## 4.1 TechFlow 映射
- `media` ← `techflow`
- `id` ← `id`
- `title` ← `title`
- `summary` ← `abstract`
- `content` ← 详情接口正文字段（或 abstract 兜底）
- `original_link` ← 正文里的外链 / 字段
- `published_at` ← `created_at` 转北京时间
- `is_featured` ← 如果未来能确定精选字段则用字段，否则单独策略判断

## 4.2 Odaily 映射
- `media` ← `odaily`
- `id` ← `id`
- `title` ← `title`
- `summary` ← `description` 去 HTML 后截断
- `content` ← `description` 去 HTML 后全文
- `original_link` ← 正文里“原文链接”或详情字段
- `published_at` ← `publishTimestamp` 转北京时间
- `is_featured` ← `isImportant`

## 4.3 BlockBeats 映射
- `media` ← `theblockbeats`
- `id` ← `article_id`
- `title` ← `title`
- `summary` ← `content` 去 HTML 后截断
- `content` ← `content` 去 HTML 后全文
- `original_link` ← `url`
- `published_at` ← `add_time` / 页面日期 + `time`
- `is_featured` ← 需额外策略判断（不能只靠当前 featured=true/false 参数）

---

# 5. 推荐重构方案（后续）

## 优先级建议
1. **深潮改 API 版**
2. **Odaily 改 API 版**
3. **律动改 `__NUXT__` 数据版**

这样可以直接解决：
- DOM 抓取不稳定
- 标题不准
- 正文抓脏
- 站点超时/前端变动

---

# 6. 一句话结论
- **深潮：已拿到可直接用的 REST API**
- **Odaily：已拿到可直接用的 REST API**
- **律动：目前最稳的是读 `window.__NUXT__.data[0]`，而不是裸接口**
