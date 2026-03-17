import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Dexie, { type Table } from 'dexie'
import {
  Newspaper,
  FileDiff,
  RefreshCcw,
  Settings2,
  Save,
  PencilLine,
  CheckCircle2,
  CircleAlert,
  PlugZap,
  Maximize2,
  X,
} from 'lucide-react'
import blockbeatsLogo from './assets/blockbeats.svg'
import techflowLogo from './assets/techflow.svg'
import odailyLogo from './assets/odaily.svg'
import './App.css'

type MediaKey = 'theblockbeats' | 'techflow' | 'odaily'

type NewsItem = {
  media: MediaKey
  id: string
  title: string
  summary: string
  content: string
  link: string
  original_link: string
  image_url: string
  is_featured: boolean
  published_at: string
  review_reason: string
  rewritten_title: string
  rewritten_content: string
  ai_title: string
  ai_body: string
  has_ai_optimized: boolean
}

type ApiResponse = {
  ok: boolean
  data: Record<MediaKey, NewsItem[]>
}

type ModelConfig = {
  provider: string
  baseUrl: string
  apiKey: string
  hasApiKey?: boolean
  model: string
  enabled: boolean
}

type TestResult = {
  status: number
  model: string
  latencyMs: number
  preview: string
}

type StyleGuideData = {
  base: string
  override: string
  effective: string
}


type ChainthinkConfig = {
  token: string
  hasToken: boolean
  baseUrl: string
  xUserId: string
  xAppId: string
  userId: string
  asUserId: string
  origin: string
  referer: string
}

class DashboardDB extends Dexie {
  snapshots!: Table<{ media: MediaKey; updatedAt: number; payload: NewsItem[] }, string>

  constructor() {
    super('flashNewsDashboardDB')
    this.version(1).stores({
      snapshots: '&media, updatedAt',
    })
  }
}

const db = new DashboardDB()
const PAGE_SIZE = 5
const mediaOptions: { key: MediaKey; label: string; logo: string }[] = [
  { key: 'theblockbeats', label: '律动', logo: blockbeatsLogo },
  { key: 'techflow', label: '深潮', logo: techflowLogo },
  { key: 'odaily', label: 'Odaily', logo: odailyLogo },
]

async function fetchNews(): Promise<Record<MediaKey, NewsItem[]>> {
  const res = await fetch('http://localhost:8787/api/news')
  const json: ApiResponse = await res.json()
  if (!json.ok) throw new Error('failed to fetch news')
  for (const media of mediaOptions) {
    await db.snapshots.put({ media: media.key, updatedAt: Date.now(), payload: json.data[media.key] || [] })
  }
  return json.data
}

async function fetchModelConfig(): Promise<ModelConfig> {
  const res = await fetch('http://localhost:8787/api/model-config')
  const json = await res.json()
  if (!json.ok) throw new Error('failed to fetch model config')
  return json.data
}

async function saveModelConfig(config: ModelConfig): Promise<ModelConfig> {
  const res = await fetch('http://localhost:8787/api/model-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  const json = await res.json()
  if (!json.ok) throw new Error('failed to save model config')
  return json.data
}

async function testModelConfig(config: ModelConfig): Promise<TestResult> {
  const res = await fetch('http://localhost:8787/api/model-config/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  const json = await res.json()
  if (!json.ok) throw new Error(json.message || '豆包连接测试失败')
  return json.data
}

async function fetchStyleGuide(): Promise<StyleGuideData> {
  const res = await fetch('http://localhost:8787/api/style-guide')
  const json = await res.json()
  if (!json.ok) throw new Error(json.message || '读取风格规则失败')
  return json.data
}

async function saveStyleGuideOverride(override: string): Promise<StyleGuideData> {
  const res = await fetch('http://localhost:8787/api/style-guide/override', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ override }),
  })
  const json = await res.json()
  if (!json.ok) throw new Error(json.message || '保存风格补充规则失败')
  return json.data
}

async function resetStyleGuideOverride(): Promise<StyleGuideData> {
  const res = await fetch('http://localhost:8787/api/style-guide/reset', {
    method: 'POST',
  })
  const json = await res.json()
  if (!json.ok) throw new Error(json.message || '恢复默认风格失败')
  return json.data
}


async function fetchChainthinkConfig(): Promise<ChainthinkConfig> {
  const res = await fetch('http://localhost:8787/api/chainthink/config')
  const json = await res.json()
  if (!json.ok) throw new Error(json.message || '读取 ChainThink 配置失败')
  return json.data
}

async function saveChainthinkConfig(config: ChainthinkConfig): Promise<ChainthinkConfig> {
  const res = await fetch('http://localhost:8787/api/chainthink/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  const json = await res.json()
  if (!json.ok) throw new Error(json.message || '保存 ChainThink 配置失败')
  return json.data
}

function extractRewrittenBody(text: string) {
  if (!text) return '—'
  const match = text.match(/正文内容[:：]\s*([\s\S]*)$/)
  return match ? match[1].trim() : text.trim()
}

function App() {
  const [activeMedia, setActiveMedia] = useState<MediaKey>('theblockbeats')
  const [selectedId, setSelectedId] = useState<string>('')
  const [editedTitle, setEditedTitle] = useState('')
  const [editedBody, setEditedBody] = useState('')
  const [page, setPage] = useState(1)
  const [showAiOnly, setShowAiOnly] = useState(false)
  const [configStatus, setConfigStatus] = useState('')
  const [configStatusType, setConfigStatusType] = useState<'success' | 'error' | ''>('')
  const [isEditingConfig, setIsEditingConfig] = useState(false)
  const [isTestingConfig, setIsTestingConfig] = useState(false)
  const [isSavingStyleGuide, setIsSavingStyleGuide] = useState(false)
  const [isStyleGuideModalOpen, setIsStyleGuideModalOpen] = useState(false)
  const [isStyleGuidePreviewOpen, setIsStyleGuidePreviewOpen] = useState(false)
  const [isChainthinkConfigOpen, setIsChainthinkConfigOpen] = useState(false)
  const [previewImageUrl, setPreviewImageUrl] = useState('')
  const [isPublishingDraft, setIsPublishingDraft] = useState(false)
  const [isSavingChainthinkConfig, setIsSavingChainthinkConfig] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [modelConfig, setModelConfig] = useState<ModelConfig>({
    provider: 'doubao',
    baseUrl: '',
    apiKey: '',
    model: '',
    enabled: false,
  })
  const [styleGuide, setStyleGuide] = useState<StyleGuideData>({
    base: '',
    override: '',
    effective: '',
  })
  const [chainthinkConfig, setChainthinkConfig] = useState<ChainthinkConfig>({
    token: '',
    hasToken: false,
    baseUrl: 'https://api-v2.chainthink.cn',
    xUserId: '',
    xAppId: '101',
    userId: '3',
    asUserId: '3',
    origin: 'https://admin.chainthink.cn',
    referer: 'https://admin.chainthink.cn/',
  })
  const [styleOverrideDraft, setStyleOverrideDraft] = useState('')
  const [cachedData, setCachedData] = useState<Record<MediaKey, NewsItem[]>>({
    theblockbeats: [],
    techflow: [],
    odaily: [],
  })

  useEffect(() => {
    ;(async () => {
      const entries = await db.snapshots.toArray()
      const next = { theblockbeats: [], techflow: [], odaily: [] } as Record<MediaKey, NewsItem[]>
      entries.forEach((entry) => {
        next[entry.media] = entry.payload
      })
      setCachedData(next)
    })()
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const cfg = await fetchModelConfig()
        setModelConfig({
          provider: cfg.provider || 'doubao',
          baseUrl: cfg.baseUrl || '',
          apiKey: cfg.apiKey || '',
          model: cfg.model || '',
          enabled: Boolean(cfg.enabled),
          hasApiKey: Boolean(cfg.hasApiKey),
        })
      } catch {
        setConfigStatus('模型配置读取失败')
        setConfigStatusType('error')
      }
    })()
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const guide = await fetchStyleGuide()
        setStyleGuide(guide)
        setStyleOverrideDraft(guide.override || '')
      } catch {
        setConfigStatus('风格规则读取失败')
        setConfigStatusType('error')
      }
    })()
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const cfg = await fetchChainthinkConfig()
        setChainthinkConfig(cfg)
      } catch {
        setConfigStatus('ChainThink token 配置读取失败')
        setConfigStatusType('error')
      }
    })()
  }, [])

  const query = useQuery({
    queryKey: ['news'],
    queryFn: fetchNews,
    refetchInterval: 60_000,
  })

  const data = query.data || cachedData
  const items = data[activeMedia] || []
  const visibleItems = useMemo(() => (showAiOnly ? items.filter((item) => item.has_ai_optimized) : items), [items, showAiOnly])
  const totalPages = Math.max(1, Math.ceil(visibleItems.length / PAGE_SIZE))
  const pagedItems = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE
    return visibleItems.slice(start, start + PAGE_SIZE)
  }, [visibleItems, page])

  useEffect(() => {
    setPage(1)
  }, [activeMedia, showAiOnly])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  useEffect(() => {
    if (pagedItems.length && !pagedItems.find((item) => item.id === selectedId)) {
      setSelectedId(pagedItems[0].id)
    }
    if (!pagedItems.length) setSelectedId('')
  }, [activeMedia, pagedItems, selectedId])

  const selected = useMemo(
    () => pagedItems.find((item) => item.id === selectedId) || pagedItems[0],
    [pagedItems, selectedId],
  )

  useEffect(() => {
    if (!selected) {
      setEditedTitle('')
      setEditedBody('')
      return
    }
    setEditedTitle(selected.ai_title || selected.title || '')
    setEditedBody(extractRewrittenBody(selected.ai_body || selected.content || ''))
  }, [selected?.id])

  async function handleSaveConfig() {
    try {
      const saved = await saveModelConfig(modelConfig)
      setModelConfig({
        provider: saved.provider || 'doubao',
        baseUrl: saved.baseUrl || '',
        apiKey: saved.apiKey || '',
        model: saved.model || '',
        enabled: Boolean(saved.enabled),
        hasApiKey: Boolean(saved.hasApiKey),
      })
      setConfigStatus('配置保存成功')
      setConfigStatusType('success')
      setIsEditingConfig(false)
    } catch {
      setConfigStatus('配置保存失败')
      setConfigStatusType('error')
    }
  }

  async function handleTestConfig() {
    try {
      setIsTestingConfig(true)
      const result = await testModelConfig(modelConfig)
      setTestResult(result)
      setConfigStatus('豆包连接测试成功')
      setConfigStatusType('success')
    } catch (error) {
      setTestResult(null)
      setConfigStatus(error instanceof Error ? error.message : '豆包连接测试失败')
      setConfigStatusType('error')
    } finally {
      setIsTestingConfig(false)
    }
  }

  async function handleSaveStyleGuide() {
    try {
      setIsSavingStyleGuide(true)
      const saved = await saveStyleGuideOverride(styleOverrideDraft)
      setStyleGuide(saved)
      setStyleOverrideDraft(saved.override || '')
      setConfigStatus('风格补充规则保存成功')
      setConfigStatusType('success')
      setIsStyleGuideModalOpen(false)
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : '风格补充规则保存失败')
      setConfigStatusType('error')
    } finally {
      setIsSavingStyleGuide(false)
    }
  }



  async function handleSaveChainthinkConfig() {
    try {
      setIsSavingChainthinkConfig(true)
      const saved = await saveChainthinkConfig(chainthinkConfig)
      setChainthinkConfig(saved)
      setConfigStatus('ChainThink token 配置已保存，重启 API 后生效')
      setConfigStatusType('success')
      setIsChainthinkConfigOpen(false)
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : '保存 ChainThink 配置失败')
      setConfigStatusType('error')
    } finally {
      setIsSavingChainthinkConfig(false)
    }
  }

  async function handlePublishChainthinkDraft() {
    if (!selected) return
    const confirmed = window.confirm('是否发布到chainthink后台草稿')
    if (!confirmed) return
    try {
      setIsPublishingDraft(true)
      await fetch('http://localhost:8787/api/chainthink/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: String(editedTitle || selected.ai_title || selected.title || '').trim(),
          text: String(editedBody || extractRewrittenBody(selected.ai_body || selected.content || '')).trim(),
          link: String(selected.original_link || selected.link || '').trim(),
          imageUrl: String(selected.image_url || '').trim(),
        }),
      }).then(async (res) => {
        const json = await res.json()
        if (!json.ok) throw new Error(json.message || '发布到 ChainThink 草稿失败')
        return json
      })
      setConfigStatus('已发布到 ChainThink 后台草稿')
      setConfigStatusType('success')
      window.alert('已成功发布到 ChainThink 草稿')
    } catch (error) {
      const message = error instanceof Error ? error.message : '发布到 ChainThink 草稿失败'
      setConfigStatus(message)
      setConfigStatusType('error')
      window.alert(message)
    } finally {
      setIsPublishingDraft(false)
    }
  }

  async function handleResetStyleGuide() {
    const confirmed = window.confirm('你确定要恢复默认风格规则吗？这会清空当前自定义补充规则。')
    if (!confirmed) return
    try {
      setIsSavingStyleGuide(true)
      const reset = await resetStyleGuideOverride()
      setStyleGuide(reset)
      setStyleOverrideDraft(reset.override || '')
      setConfigStatus('已恢复默认风格规则')
      setConfigStatusType('success')
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : '恢复默认风格失败')
      setConfigStatusType('error')
    } finally {
      setIsSavingStyleGuide(false)
    }
  }

  const configLocked = !isEditingConfig

  return (
    <>
      <div className="page-shell">
        <aside className="sidebar">
          <div className="brand">
            <Newspaper size={18} />
            <div>
              <h1>Flash News Dashboard</h1>
              <p>过滤后待推送快讯面板</p>
            </div>
          </div>

          <div className="sidebar-card">
            <div className="sidebar-title">媒体</div>
            <div className="media-tabs">
              {mediaOptions.map((media) => (
                <button
                  key={media.key}
                  className={activeMedia === media.key ? 'tab active' : 'tab'}
                  onClick={() => setActiveMedia(media.key)}
                >
                  <span className="tab-main">
                    <img src={media.logo} alt={media.label} className="media-logo media-logo-real" />
                    {media.label}
                  </span>
                  <span className="count">{data[media.key]?.length || 0}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="sidebar-card">
            <div className="sidebar-title model-title model-title-row">
              <span><Settings2 size={14} /> 豆包模型配置</span>
              <button className="mini-btn" onClick={() => setIsEditingConfig((v) => !v)}>
                <PencilLine size={13} /> {isEditingConfig ? '取消编辑' : '编辑配置'}
              </button>
            </div>

            <div className="field compact-field">
              <label>提供商</label>
              <input className="editor-input readonly-input" value="doubao" disabled />
            </div>
            <div className="field compact-field">
              <label>启用豆包</label>
              <input type="checkbox" checked={modelConfig.enabled} disabled={configLocked} onChange={(e) => setModelConfig((cfg) => ({ ...cfg, enabled: e.target.checked }))} />
            </div>
            <div className="field compact-field">
              <label>Base URL</label>
              <input className={configLocked ? 'editor-input readonly-input' : 'editor-input'} value={modelConfig.baseUrl} placeholder="留空，用户自行填写" disabled={configLocked} onChange={(e) => setModelConfig((cfg) => ({ ...cfg, baseUrl: e.target.value }))} />
            </div>
            <div className="field compact-field">
              <label>API Key</label>
              <input className={configLocked ? 'editor-input readonly-input' : 'editor-input'} value={modelConfig.apiKey} placeholder="留空，用户自行填写" disabled={configLocked} onChange={(e) => setModelConfig((cfg) => ({ ...cfg, apiKey: e.target.value }))} />
            </div>
            <div className="field compact-field">
              <label>模型 ID</label>
              <input className={configLocked ? 'editor-input readonly-input' : 'editor-input'} value={modelConfig.model} placeholder="留空，用户自行填写" disabled={configLocked} onChange={(e) => setModelConfig((cfg) => ({ ...cfg, model: e.target.value }))} />
            </div>
            <div className="config-actions">
              <button className="refresh-btn" onClick={handleSaveConfig} disabled={configLocked}>
                <Save size={14} /> 保存豆包配置
              </button>
              <button className="mini-btn mini-btn-test" onClick={handleTestConfig} disabled={isTestingConfig}>
                <PlugZap size={13} /> {isTestingConfig ? '测试中...' : '测试豆包连接'}
              </button>
            </div>
            {configStatus ? (
              <div className={configStatusType === 'success' ? 'config-status config-status-success' : 'config-status config-status-error'}>
                {configStatusType === 'success' ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}
                {configStatus}
              </div>
            ) : null}
            {testResult ? (
              <div className="test-result-card">
                <div><strong>模型：</strong>{testResult.model}</div>
                <div><strong>HTTP 状态：</strong>{testResult.status}</div>
                <div><strong>延迟：</strong>{testResult.latencyMs} ms</div>
                <div><strong>返回摘要：</strong>{testResult.preview}</div>
              </div>
            ) : null}
          </div>

          <div className="sidebar-card status-card">
            <div className="sidebar-title">数据状态</div>
            <div className="status-row">
              <span>API</span>
              <strong>{query.isFetching ? '同步中' : '已连接'}</strong>
            </div>
            <div className="status-row">
              <span>本地缓存</span>
              <strong>Dexie / IndexedDB</strong>
            </div>
            <button className="refresh-btn" onClick={() => query.refetch()}>
              <RefreshCcw size={14} /> 手动刷新
            </button>
          </div>
        </aside>

        <main className="content">
          <section className="list-panel">
            <div className="panel-header">
              <h2>{mediaOptions.find((m) => m.key === activeMedia)?.label} 待推送快讯</h2>
              <span>{visibleItems.length} 条</span>
            </div>
            <div className="filter-row">
              <label className="toggle-row">
                <input type="checkbox" checked={showAiOnly} onChange={(e) => setShowAiOnly(e.target.checked)} />
                <span>只显示 AI 已优化的快讯</span>
              </label>
            </div>
            <div className="pagination-summary">第 {page} / {totalPages} 页 · 每页 {PAGE_SIZE} 条</div>
            <div className="news-list">
              {pagedItems.map((item) => (
                <button
                  key={`${item.media}-${item.id}`}
                  className={selected?.id === item.id ? 'news-item active' : 'news-item'}
                  onClick={() => setSelectedId(item.id)}
                >
                  <div className="news-time">{item.published_at || '—'}</div>
                  <div className="news-item-body">
                    {item.image_url ? <img src={item.image_url} alt={item.title} className="news-item-thumb" /> : null}
                    <div className="news-item-copy">
                      <div className="news-title">{item.ai_title || item.title}</div>
                      <div className="news-meta">
                        <span className={item.is_featured ? 'meta-badge meta-badge-featured' : 'meta-badge'}>
                          {item.is_featured ? '精选' : '普通'}
                        </span>
                        <span className={item.has_ai_optimized ? 'meta-badge meta-badge-ai' : 'meta-badge meta-badge-plain'}>
                          {item.has_ai_optimized ? '已 AI 优化' : '未 AI 优化'}
                        </span>
                        <span className="meta-badge">{item.review_reason || 'passed'}</span>
                      </div>
                    </div>
                  </div>
                </button>
              ))}
              {!pagedItems.length && <div className="empty-state">当前媒体没有待推送快讯</div>}
            </div>
            {visibleItems.length > 0 && (
              <div className="pagination-bar">
                <button className="page-btn" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</button>
                <div className="page-numbers">
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
                    <button key={n} className={n === page ? 'page-btn active' : 'page-btn'} onClick={() => setPage(n)}>{n}</button>
                  ))}
                </div>
                <button className="page-btn" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>下一页</button>
              </div>
            )}
          </section>

          <section className="detail-panel">
            {selected ? (
              <>
                <div className="panel-header">
                  <h2><FileDiff size={18} /> 修改前 / 修改后</h2>
                  <div className="detail-actions">
                    <button className="mini-btn" onClick={() => setIsChainthinkConfigOpen(true)}>配置 token</button>
                    <button className="mini-btn" onClick={() => setIsStyleGuideModalOpen(true)}>
                      <PencilLine size={13} /> 编辑风格补充规则
                    </button>
                  </div>
                </div>
                <div className="compare-grid">
                  <article className="compare-card">
                    <h3>修改前</h3>
                    <div className="field"><label>标题</label><div className="field-body">{selected.title}</div></div>
                    <div className="field"><label>正文</label><pre className="field-body pre-wrap">{selected.content || selected.summary}</pre></div>
                    <div className="field"><label>原文链接</label><a href={selected.original_link || selected.link} target="_blank" rel="noreferrer">{selected.original_link || selected.link || '—'}</a></div>
                    {selected.image_url ? (
                      <div className="field">
                        <label>原文图片</label>
                        <button type="button" className="image-preview-button" onClick={() => setPreviewImageUrl(selected.image_url)}>
                          <img src={selected.image_url} alt={selected.title} className="news-detail-image" />
                        </button>
                      </div>
                    ) : null}
                  </article>

                  <article className="compare-card rewritten">
                    <div className="compare-card-head">
                      <h3>修改后</h3>
                      <button className="draft-btn" onClick={handlePublishChainthinkDraft} disabled={isPublishingDraft}>
                        {isPublishingDraft ? '发布中...' : '发布到 ChainThink 草稿'}
                      </button>
                    </div>
                    <div className="field"><label>标题</label><input className="editor-input" value={editedTitle} onChange={(e) => setEditedTitle(e.target.value)} placeholder="请输入改写后的标题" /></div>
                    <div className="field">
                      <label>正文（富文本可编辑）</label>
                      <div
                        className="field-body rich-editor"
                        contentEditable
                        suppressContentEditableWarning
                        onInput={(e) => setEditedBody((e.target as HTMLDivElement).innerText)}
                        dangerouslySetInnerHTML={{ __html: editedBody.replace(/\n/g, '<br/>') }}
                      />
                    </div>
                    <div className="field"><label>原文链接</label><a href={selected.original_link || selected.link} target="_blank" rel="noreferrer">{selected.original_link || selected.link || '—'}</a></div>
                    {selected.image_url ? (
                      <div className="field">
                        <label>修改后正文配图</label>
                        <button type="button" className="image-preview-button" onClick={() => setPreviewImageUrl(selected.image_url)}>
                          <img src={selected.image_url} alt={selected.ai_title || selected.title} className="news-detail-image" />
                        </button>
                      </div>
                    ) : null}
                  </article>
                </div>
              </>
            ) : (
              <div className="empty-state detail-empty">请选择一条快讯查看详情</div>
            )}
          </section>
        </main>
      </div>

      {isStyleGuideModalOpen && (
        <div className="modal-backdrop" onClick={() => setIsStyleGuideModalOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>编辑 ChainThink 风格补充规则</h3>
              <button className="icon-btn" onClick={() => setIsStyleGuideModalOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-actions-top">
              <button className="mini-btn" onClick={() => setIsStyleGuidePreviewOpen(true)}>
                <Maximize2 size={13} /> 放大查看默认风格
              </button>
              <button className="mini-btn" onClick={handleResetStyleGuide} disabled={isSavingStyleGuide}>
                {isSavingStyleGuide ? '处理中...' : '恢复默认'}
              </button>
            </div>
            <div className="field compact-field">
              <label>默认风格（只读预览）</label>
              <pre className="field-body pre-wrap style-guide-preview">{styleGuide.base || '加载中...'}</pre>
            </div>
            <div className="field compact-field">
              <label>自定义补充规则（override）</label>
              <textarea
                className="editor-input style-guide-textarea"
                value={styleOverrideDraft}
                placeholder={'例如：\n1. 标题尽量更短，控制在 18-26 字。\n2. 正文首句优先带时间与来源。\n3. AI/Agent 类新闻增加一句行业影响判断。'}
                onChange={(e) => setStyleOverrideDraft(e.target.value)}
              />
            </div>
            <div className="config-actions">
              <button className="refresh-btn" onClick={handleSaveStyleGuide} disabled={isSavingStyleGuide}>
                <Save size={14} /> {isSavingStyleGuide ? '保存中...' : '保存风格补充规则'}
              </button>
            </div>
          </div>
        </div>
      )}


      {isChainthinkConfigOpen && (
        <div className="modal-backdrop" onClick={() => setIsChainthinkConfigOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>配置 ChainThink Token</h3>
              <button className="icon-btn" onClick={() => setIsChainthinkConfigOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="field compact-field">
              <label>Token</label>
              <input className="editor-input" type="password" value={chainthinkConfig.token} placeholder={chainthinkConfig.hasToken ? '已配置，可重新输入覆盖' : '请输入 ChainThink Token'} onChange={(e) => setChainthinkConfig((prev) => ({ ...prev, token: e.target.value }))} />
            </div>
            <div className="field compact-field">
              <label>Base URL</label>
              <input className="editor-input" value={chainthinkConfig.baseUrl} onChange={(e) => setChainthinkConfig((prev) => ({ ...prev, baseUrl: e.target.value }))} />
            </div>
            <div className="field compact-field">
              <label>X-User-Id</label>
              <input className="editor-input" value={chainthinkConfig.xUserId} onChange={(e) => setChainthinkConfig((prev) => ({ ...prev, xUserId: e.target.value }))} />
            </div>
            <div className="field compact-field">
              <label>X-App-Id</label>
              <input className="editor-input" value={chainthinkConfig.xAppId} onChange={(e) => setChainthinkConfig((prev) => ({ ...prev, xAppId: e.target.value }))} />
            </div>
            <div className="field compact-field">
              <label>User-Id（body）</label>
              <input className="editor-input" value={chainthinkConfig.userId} onChange={(e) => setChainthinkConfig((prev) => ({ ...prev, userId: e.target.value }))} />
            </div>
            <div className="field compact-field">
              <label>As-User-Id（body）</label>
              <input className="editor-input" value={chainthinkConfig.asUserId} onChange={(e) => setChainthinkConfig((prev) => ({ ...prev, asUserId: e.target.value }))} />
            </div>
            <div className="field compact-field">
              <label>Origin</label>
              <input className="editor-input" value={chainthinkConfig.origin} onChange={(e) => setChainthinkConfig((prev) => ({ ...prev, origin: e.target.value }))} />
            </div>
            <div className="field compact-field">
              <label>Referer</label>
              <input className="editor-input" value={chainthinkConfig.referer} onChange={(e) => setChainthinkConfig((prev) => ({ ...prev, referer: e.target.value }))} />
            </div>
            <div className="config-actions">
              <button className="refresh-btn" onClick={handleSaveChainthinkConfig} disabled={isSavingChainthinkConfig}>
                <Save size={14} /> {isSavingChainthinkConfig ? '保存中...' : '保存 token 配置'}
              </button>
            </div>
          </div>
        </div>
      )}

      {previewImageUrl && (
        <div className="modal-backdrop image-modal-backdrop" onClick={() => setPreviewImageUrl('')}>
          <div className="modal-card image-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>图片预览</h3>
              <button className="icon-btn" onClick={() => setPreviewImageUrl('')}>×</button>
            </div>
            <div className="image-modal-body">
              <img src={previewImageUrl} alt="预览大图" className="image-modal-preview" />
            </div>
          </div>
        </div>
      )}

      {isStyleGuidePreviewOpen && (
        <div className="modal-backdrop" onClick={() => setIsStyleGuidePreviewOpen(false)}>
          <div className="modal-card modal-card-lg" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>默认 ChainThink 风格规则</h3>
              <button className="icon-btn" onClick={() => setIsStyleGuidePreviewOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <pre className="field-body pre-wrap style-guide-preview-full">{styleGuide.base || '加载中...'}</pre>
          </div>
        </div>
      )}
    </>
  )
}

export default App
