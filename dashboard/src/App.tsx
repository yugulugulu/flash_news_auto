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
  X,
} from 'lucide-react'
import blockbeatsLogo from './assets/blockbeats.svg'
import techflowLogo from './assets/techflow.svg'
import odailyLogo from './assets/odaily.svg'
import './App.css'

type MediaKey = 'theblockbeats' | 'techflow' | 'odaily'
type AIDecision = 'feature' | 'rewrite' | 'review' | 'drop' | ''

type NewsItem = {
  media: MediaKey
  id: string
  title: string
  summary: string
  content: string
  link: string
  original_link: string
  image_url: string
  source_is_featured: boolean
  chainthink_is_featured: boolean
  ai_score: number | null
  ai_decision: AIDecision
  ai_score_reason: string
  ai_risk_flags: string[]
  ai_dimensions: Record<string, number>
  published_at: string
  review_reason: string
  rewritten_title: string
  rewritten_content: string
  ai_title: string
  ai_body: string
  has_ai_optimized: boolean
  chainthink_draft_published_at: string
  chainthink_draft_publish_mode: string
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
  content: string
}

type MediaControlEntry = {
  key: MediaKey
  label: string
  enabled: boolean
  running: boolean
  pid: string
  last_success_at: string
  last_error: string
  last_result: string
  interval_ms: number
}

type MediaControlState = {
  pipeline: {
    running: boolean
    pid: string
  }
  medias: Record<MediaKey, MediaControlEntry>
}

type AutoDraftState = {
  enabled: boolean
  interval_ms: number
  worker_running: boolean
  last_checked_at: string
  last_published_at: string
  last_published_key: string
  last_error: string
  total_published: number
}

type PruneResult = {
  media: MediaKey
  before: number
  after: number
  removed: number
  threshold: number
  keep: number
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
  if (!json.ok) throw new Error(json.message || '读取重写提示词失败')
  return json.data
}

async function saveStyleGuideContent(content: string): Promise<StyleGuideData> {
  const res = await fetch('http://localhost:8787/api/style-guide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  const json = await res.json()
  if (!json.ok) throw new Error(json.message || '保存重写提示词失败')
  return json.data
}

async function fetchScoringGuide(): Promise<StyleGuideData> {
  const res = await fetch('http://localhost:8787/api/scoring-guide')
  const json = await res.json()
  if (!json.ok) throw new Error(json.message || '读取评分提示词失败')
  return json.data
}

async function saveScoringGuideContent(content: string): Promise<StyleGuideData> {
  const res = await fetch('http://localhost:8787/api/scoring-guide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  const json = await res.json()
  if (!json.ok) throw new Error(json.message || '保存评分提示词失败')
  return json.data
}

async function fetchAutoDraftState(): Promise<AutoDraftState> {
  const res = await fetch('http://localhost:8787/api/chainthink/auto-draft')
  const json = await res.json()
  if (!json.ok) throw new Error(json.message || '读取全自动状态失败')
  return json.data
}

async function fetchMediaControl(): Promise<MediaControlState> {
  const res = await fetch('http://localhost:8787/api/media-control')
  const json = await res.json()
  if (!json.ok) throw new Error(json.message || '读取媒体抓取状态失败')
  return json.data
}

async function saveMediaControl(media: MediaKey, enabled: boolean): Promise<MediaControlState> {
  const res = await fetch(`http://localhost:8787/api/media-control/${media}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  const json = await res.json()
  if (!json.ok) throw new Error(json.message || '保存媒体抓取状态失败')
  return json.data
}

async function pruneMediaNews(media: MediaKey): Promise<PruneResult> {
  const res = await fetch(`http://localhost:8787/api/media-control/${media}/prune`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  const json = await res.json()
  if (!json.ok) throw new Error(json.message || '清理旧快讯失败')
  return json.data
}

async function saveAutoDraftState(enabled: boolean): Promise<AutoDraftState> {
  const res = await fetch('http://localhost:8787/api/chainthink/auto-draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  const json = await res.json()
  if (!json.ok) throw new Error(json.message || '保存全自动状态失败')
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

function getDecisionLabel(decision: AIDecision) {
  if (decision === 'feature') return '精选'
  if (decision === 'rewrite') return '自动改写'
  if (decision === 'review') return '人工复核'
  if (decision === 'drop') return '丢弃'
  return '未评分'
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
  const [isSavingScoringGuide, setIsSavingScoringGuide] = useState(false)
  const [isStyleGuideModalOpen, setIsStyleGuideModalOpen] = useState(false)
  const [isScoringGuideModalOpen, setIsScoringGuideModalOpen] = useState(false)
  const [isChainthinkConfigOpen, setIsChainthinkConfigOpen] = useState(false)
  const [previewImageUrl, setPreviewImageUrl] = useState('')
  const [isPublishingDraft, setIsPublishingDraft] = useState(false)
  const [isSavingAutoDraft, setIsSavingAutoDraft] = useState(false)
  const [savingMediaKey, setSavingMediaKey] = useState<MediaKey | ''>('')
  const [pruningMediaKey, setPruningMediaKey] = useState<MediaKey | ''>('')
  const [isSavingChainthinkConfig, setIsSavingChainthinkConfig] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [modelConfig, setModelConfig] = useState<ModelConfig>({
    provider: 'doubao',
    baseUrl: '',
    apiKey: '',
    model: '',
    enabled: false,
  })
  const [styleGuide, setStyleGuide] = useState<StyleGuideData>({ content: '' })
  const [scoringGuide, setScoringGuide] = useState<StyleGuideData>({ content: '' })
  const [autoDraftState, setAutoDraftState] = useState<AutoDraftState>({
    enabled: false,
    interval_ms: 30_000,
    worker_running: false,
    last_checked_at: '',
    last_published_at: '',
    last_published_key: '',
    last_error: '',
    total_published: 0,
  })
  const [mediaControl, setMediaControl] = useState<MediaControlState>({
    pipeline: { running: false, pid: '' },
    medias: {
      theblockbeats: { key: 'theblockbeats', label: '律动', enabled: true, running: false, pid: '', last_success_at: '', last_error: '', last_result: '', interval_ms: 30_000 },
      techflow: { key: 'techflow', label: '深潮', enabled: true, running: false, pid: '', last_success_at: '', last_error: '', last_result: '', interval_ms: 30_000 },
      odaily: { key: 'odaily', label: 'Odaily', enabled: true, running: false, pid: '', last_success_at: '', last_error: '', last_result: '', interval_ms: 30_000 },
    },
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
  const [stylePromptDraft, setStylePromptDraft] = useState('')
  const [scoringPromptDraft, setScoringPromptDraft] = useState('')
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
        setStylePromptDraft(guide.content || '')
      } catch {
        setConfigStatus('重写提示词读取失败')
        setConfigStatusType('error')
      }
    })()
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const guide = await fetchScoringGuide()
        setScoringGuide(guide)
        setScoringPromptDraft(guide.content || '')
      } catch {
        setConfigStatus('评分提示词读取失败')
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

  useEffect(() => {
    ;(async () => {
      try {
        const state = await fetchAutoDraftState()
        setAutoDraftState(state)
      } catch {
        setConfigStatus('全自动状态读取失败')
        setConfigStatusType('error')
      }
    })()
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const state = await fetchMediaControl()
        setMediaControl(state)
      } catch {
        setConfigStatus('媒体抓取状态读取失败')
        setConfigStatusType('error')
      }
    })()
  }, [])

  useEffect(() => {
    const timer = window.setInterval(async () => {
      try {
        const state = await fetchAutoDraftState()
        setAutoDraftState(state)
      } catch {}
    }, 10_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const timer = window.setInterval(async () => {
      try {
        const state = await fetchMediaControl()
        setMediaControl(state)
      } catch {}
    }, 10_000)
    return () => window.clearInterval(timer)
  }, [])

  const query = useQuery({
    queryKey: ['news'],
    queryFn: fetchNews,
    refetchInterval: 30_000,
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
      const saved = await saveStyleGuideContent(stylePromptDraft)
      setStyleGuide(saved)
      setStylePromptDraft(saved.content || '')
      setConfigStatus('重写提示词保存成功')
      setConfigStatusType('success')
      setIsStyleGuideModalOpen(false)
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : '重写提示词保存失败')
      setConfigStatusType('error')
    } finally {
      setIsSavingStyleGuide(false)
    }
  }

  async function handleSaveScoringGuide() {
    try {
      setIsSavingScoringGuide(true)
      const saved = await saveScoringGuideContent(scoringPromptDraft)
      setScoringGuide(saved)
      setScoringPromptDraft(saved.content || '')
      setConfigStatus('评分提示词保存成功')
      setConfigStatusType('success')
      setIsScoringGuideModalOpen(false)
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : '评分提示词保存失败')
      setConfigStatusType('error')
    } finally {
      setIsSavingScoringGuide(false)
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
    if (selected.chainthink_draft_published_at) {
      window.alert('这条快讯已经推送过草稿了')
      return
    }
    const confirmed = window.confirm('是否发布到chainthink后台草稿')
    if (!confirmed) return
    try {
      setIsPublishingDraft(true)
      await fetch('http://localhost:8787/api/chainthink/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          media: selected.media,
          id: selected.id,
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

  async function handleToggleAutoDraft() {
    const nextEnabled = !autoDraftState.enabled
    if (nextEnabled) {
      const confirmed = window.confirm('开启后会每 30 秒检查一次快讯，并把“评分 >= 85 且已 AI 改写、且未推送过”的快讯自动推到 ChainThink 草稿。是否继续？')
      if (!confirmed) return
    }
    try {
      setIsSavingAutoDraft(true)
      const saved = await saveAutoDraftState(nextEnabled)
      setAutoDraftState(saved)
      setConfigStatus(nextEnabled ? '已开启全自动草稿' : '已关闭全自动草稿')
      setConfigStatusType('success')
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : '全自动状态保存失败')
      setConfigStatusType('error')
    } finally {
      setIsSavingAutoDraft(false)
    }
  }

  async function handleToggleMedia(media: MediaKey) {
    const current = mediaControl.medias[media]
    const nextEnabled = !current?.enabled
    try {
      setSavingMediaKey(media)
      const saved = await saveMediaControl(media, nextEnabled)
      setMediaControl(saved)
      setConfigStatus(`${mediaOptions.find((item) => item.key === media)?.label || media}${nextEnabled ? ' 抓取已开启' : ' 抓取已关闭'}`)
      setConfigStatusType('success')
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : '媒体抓取状态保存失败')
      setConfigStatusType('error')
    } finally {
      setSavingMediaKey('')
    }
  }

  async function handlePruneMedia(media: MediaKey) {
    const label = mediaOptions.find((item) => item.key === media)?.label || media
    const confirmed = window.confirm(`只在 ${label} 快讯超过 100 条时，保留最新 50 条。现在执行吗？`)
    if (!confirmed) return
    try {
      setPruningMediaKey(media)
      const result = await pruneMediaNews(media)
      await query.refetch()
      const message = result.removed > 0
        ? `${label} 已清理 ${result.removed} 条旧快讯`
        : `${label} 当前不足 ${result.threshold} 条，无需清理`
      setConfigStatus(message)
      setConfigStatusType('success')
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : '清理旧快讯失败')
      setConfigStatusType('error')
    } finally {
      setPruningMediaKey('')
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
                <div key={media.key} className="media-row">
                  <button
                    className={activeMedia === media.key ? 'tab active' : 'tab'}
                    onClick={() => setActiveMedia(media.key)}
                  >
                    <span className="tab-main">
                      <img src={media.logo} alt={media.label} className="media-logo media-logo-real" />
                      <span className="media-copy">
                        <strong>{media.label}</strong>
                        <span className={mediaControl.medias[media.key]?.running ? 'media-fetch-state media-fetch-state-on' : 'media-fetch-state media-fetch-state-off'}>
                          {mediaControl.medias[media.key]?.enabled
                            ? (mediaControl.medias[media.key]?.running ? '抓取中' : '待启动')
                            : '已关闭'}
                        </span>
                      </span>
                    </span>
                    <span className="count">{data[media.key]?.length || 0}</span>
                  </button>
                  <button
                    className={mediaControl.medias[media.key]?.enabled ? 'media-toggle-btn media-toggle-btn-on' : 'media-toggle-btn'}
                    disabled={savingMediaKey === media.key}
                    onClick={() => handleToggleMedia(media.key)}
                  >
                    {savingMediaKey === media.key ? '处理中...' : (mediaControl.medias[media.key]?.enabled ? '抓取开' : '抓取关')}
                  </button>
                </div>
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
              <span>抓取主控</span>
              <strong>{mediaControl.pipeline.running ? '运行中' : '未运行'}</strong>
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
              <button
                className="mini-btn"
                disabled={pruningMediaKey === activeMedia}
                onClick={() => handlePruneMedia(activeMedia)}
              >
                {pruningMediaKey === activeMedia ? '清理中...' : '清理旧快讯'}
              </button>
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
                        {item.chainthink_is_featured ? (
                          <span className="meta-badge meta-badge-featured">ChainThink 精选</span>
                        ) : null}
                        <span className={item.source_is_featured ? 'meta-badge meta-badge-source' : 'meta-badge meta-badge-plain'}>
                          {item.source_is_featured ? '源站重点' : '源站无信号'}
                        </span>
                        <span className="meta-badge">{getDecisionLabel(item.ai_decision)}</span>
                        <span className={item.has_ai_optimized ? 'meta-badge meta-badge-ai' : 'meta-badge meta-badge-plain'}>
                          {item.has_ai_optimized ? '已 AI 改写' : '未 AI 改写'}
                        </span>
                        {item.chainthink_draft_published_at ? (
                          <span className="meta-badge meta-badge-drafted">已推草稿</span>
                        ) : null}
                        <span className="meta-badge">AI分：{item.ai_score ?? '—'}</span>
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
                      <PencilLine size={13} /> 编辑 ChainThink 风格优化规则
                    </button>
                    <button className="mini-btn" onClick={() => setIsScoringGuideModalOpen(true)}>
                      <PencilLine size={13} /> 编辑 ChainThink 评分规则
                    </button>
                  </div>
                </div>
                <div className="compare-grid">
                  <article className="compare-card">
                    <h3>修改前</h3>
                    <div className="score-panel">
                      <div className="score-panel-head">评分信息</div>
                      <div className="score-panel-grid">
                        <div className="score-kv"><span className="score-kv-label">AI 总分</span><strong>{selected.ai_score ?? '—'}</strong></div>
                        <div className="score-kv"><span className="score-kv-label">AI 决策</span><strong>{getDecisionLabel(selected.ai_decision)}</strong></div>
                        <div className="score-kv"><span className="score-kv-label">源站重点信号</span><strong>{selected.source_is_featured ? '命中' : '未命中'}</strong></div>
                        <div className="score-kv"><span className="score-kv-label">我们精选</span><strong>{selected.chainthink_is_featured ? '是' : '否'}</strong></div>
                      </div>
                      <div className="score-reason-box">
                        <div className="score-kv-label">评分理由</div>
                        <pre className="field-body pre-wrap score-reason-pre">{selected.ai_score_reason || '—'}</pre>
                      </div>
                    </div>
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
                      <div className="compare-card-actions">
                        <button className="draft-btn" onClick={handlePublishChainthinkDraft} disabled={isPublishingDraft || Boolean(selected.chainthink_draft_published_at)}>
                          {selected.chainthink_draft_published_at ? '已推草稿' : (isPublishingDraft ? '发布中...' : '发布草稿')}
                        </button>
                        <button className={autoDraftState.enabled ? 'auto-btn auto-btn-active' : 'auto-btn'} onClick={handleToggleAutoDraft} disabled={isSavingAutoDraft}>
                          {isSavingAutoDraft ? '处理中...' : `全自动 ${autoDraftState.enabled ? '开' : '关'}`}
                        </button>
                      </div>
                    </div>
                    <div className="auto-draft-status">
                      <span>自动草稿轮询：每 {Math.round((autoDraftState.interval_ms || 30_000) / 1000)} 秒</span>
                      <span>{autoDraftState.worker_running ? '正在检查' : '空闲'}</span>
                      {autoDraftState.last_published_at ? <span>上次推送：{autoDraftState.last_published_at}</span> : null}
                      {autoDraftState.last_error ? <span className="auto-draft-error">错误：{autoDraftState.last_error}</span> : null}
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
                    {selected.chainthink_draft_published_at ? (
                      <div className="field">
                        <label>草稿推送状态</label>
                        <div className="field-body">已于 {selected.chainthink_draft_published_at} 推送到 ChainThink 草稿{selected.chainthink_draft_publish_mode ? `（${selected.chainthink_draft_publish_mode}）` : ''}</div>
                      </div>
                    ) : null}
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
              <h3>编辑 ChainThink 风格优化规则</h3>
              <button className="icon-btn" onClick={() => setIsStyleGuideModalOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="field compact-field">
              <label>当前重写提示词</label>
              <pre className="field-body pre-wrap style-guide-preview">{styleGuide.content || '加载中...'}</pre>
            </div>
            <div className="field compact-field">
              <label>ChainThink 风格优化规则 / 重写提示词</label>
              <textarea
                className="editor-input style-guide-textarea"
                value={stylePromptDraft}
                placeholder={'例如：\n1. 标题必须结论先行，保留最强事实信号。\n2. 正文统一改写成 ChainThink 成稿口吻，不保留原媒体语气。\n3. 优先保留数字、主体、动作、影响，不写空话。'}
                onChange={(e) => setStylePromptDraft(e.target.value)}
              />
            </div>
            <div className="config-actions">
              <button className="refresh-btn" onClick={handleSaveStyleGuide} disabled={isSavingStyleGuide}>
                <Save size={14} /> {isSavingStyleGuide ? '保存中...' : '保存重写提示词'}
              </button>
            </div>
          </div>
        </div>
      )}

      {isScoringGuideModalOpen && (
        <div className="modal-backdrop" onClick={() => setIsScoringGuideModalOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>编辑 ChainThink 评分规则</h3>
              <button className="icon-btn" onClick={() => setIsScoringGuideModalOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="field compact-field">
              <label>当前评分提示词</label>
              <pre className="field-body pre-wrap style-guide-preview">{scoringGuide.content || '加载中...'}</pre>
            </div>
            <div className="field compact-field">
              <label>ChainThink 评分规则 / 评分提示词</label>
              <textarea
                className="editor-input style-guide-textarea"
                value={scoringPromptDraft}
                placeholder={'例如：\n1. 优先判断主体重要性、事件确定性、市场影响。\n2. 没有明确信号的快讯不要给高分。\n3. 评分与 decision 必须严格一致。'}
                onChange={(e) => setScoringPromptDraft(e.target.value)}
              />
            </div>
            <div className="config-actions">
              <button className="refresh-btn" onClick={handleSaveScoringGuide} disabled={isSavingScoringGuide}>
                <Save size={14} /> {isSavingScoringGuide ? '保存中...' : '保存评分提示词'}
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

    </>
  )
}

export default App
