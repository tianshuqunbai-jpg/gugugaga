import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { describePersonality, getPersonality, personaPronoun, PERSONALITIES } from '../lib/personalities'
import { computeNextEmotion, runTurn } from '../lib/turn'
import {
  backfillKeywords,
  clearMemory,
  clearMemoryPartition,
  countRebuildChunks,
  deleteFact,
  dropLegacyMemory,
  findDuplicateGroups,
  formatConfidence,
  hasLegacyMemory,
  importPersonaMemory,
  listMemoryPartitions,
  loadMemory,
  mergeAllDuplicates,
  mergeFacts,
  parsePersonaMemory,
  personaFileOf,
  exportPersonaMemory,
  queueExtraction,
  rebuildMemoryFromMessages,
  setMemoryScope,
  getExtractionStatus,
  retryFailedExtraction,
  subscribeExtractionStatus,
  updateFactKeywords
} from '../lib/memory'
import { emotionLabelOf, isFirstMeeting, STRANGER_EMOTION } from '../lib/emotion'
import { clearAllData, loadSession, parseBackup, saveSessionSafe, listConversations, createConversation, activateConversation, renameConversation, deleteConversation } from '../lib/storage'
import { disableCrypto, enableCrypto, isCryptoEnabled, lockCrypto } from '../lib/crypto'
import VirtualAvatar from './VirtualAvatar'
import EmotionPanel from './EmotionPanel'
import MemoryGraph from './MemoryGraph'
import BackupModal from './BackupModal'
import ConversationPanel from './ConversationPanel'
import ChatMessage from './ChatMessage'
import ComposerTools from './ComposerTools'
import { useSpeech } from '../lib/useSpeech'
import { conversationMarkdown, downloadText, downloadImage, prepareImage } from '../lib/media'

let idCounter = 0
function nextId() {
  idCounter += 1
  return `m-${Date.now().toString(36)}-${idCounter}`
}

const defaultSession = () => ({
  personalityId: 'boy_next_door',
  adultOn: false,
  ageConfirmed: false,
  override: null,
  // 新对话从"陌生人"情绪起步，不是热恋底色
  emotion: { ...STRANGER_EMOTION },
  // 你扮演的角色的性别：只影响旁白里怎么称呼你（人格自身的性别由 preset.gender 决定）
  userGender: 'female',
  // 经验设定：'first' = 双方都是第一次（默认，可在侧栏关闭）；'free' = 不做限制
  experience: 'first',
  messages: [],
  // 累计 token 用量（来自流式最后一个块的 usage），仅本机统计，不参与任何判断
  usage: null
})

// 只要对方一句话都还没说过，就仍处于"第一次见面"阶段：
// 人格开场白是 local 消息，不计入，所以这里数的是真正的用户发言（判定见 lib/emotion.js）

// 把单轮 usage 累加进会话总量
function accumulateUsage(prev, u) {
  const cur = prev || {}
  return {
    prompt_tokens: (cur.prompt_tokens || 0) + (u.prompt_tokens || 0),
    completion_tokens: (cur.completion_tokens || 0) + (u.completion_tokens || 0),
    total_tokens: (cur.total_tokens || 0) + (u.total_tokens || 0),
    reasoning_tokens: (cur.reasoning_tokens || 0) + (u.reasoning_tokens || 0),
    turns: (cur.turns || 0) + 1
  }
}

const ADV_TRAITS = [
  { key: 'T', label: '温柔', min: 0, max: 100 },
  { key: 'I', label: '主动', min: 0, max: 100 },
  { key: 'O', label: '开放', min: 0, max: 100 },
  { key: 'S', label: '敏感', min: 0, max: 100 },
  { key: 'R', label: '理性', min: 0, max: 100 }
]

const ADV_EMO = [
  { key: 'aff', label: '依恋', min: -100, max: 100 },
  { key: 'sec', label: '安全', min: -100, max: 100 },
  { key: 'aro', label: '唤醒', min: -100, max: 100 },
  { key: 'dom', label: '支配', min: -100, max: 100 }
]

const SUGGESTIONS = [
  '今天心情不太好，可以陪陪我吗？',
  '讲一个关于星星的故事吧',
  '如果我突然消失了，你会怎么办？'
]

// 左栏的可折叠分区。
// 之前每个设置都是常驻展开的一块，设定完就不动的东西（用量、隐私锁、人格参数）
// 也一直占着竖向空间，想找常用的那一项得在十几个块里翻。折起来后左栏只留
// 头像、情绪和分组标题，需要哪个再展开。
//
// 初始展开状态用 ref 直接设 DOM 的 open，不能写成 open={defaultOpen}——
// 那会让 React 接管这个属性，用户手动展开后一重渲染就被强行关回去
function RailFold({ title, hint, count, defaultOpen = false, children }) {
  const initOpen = useCallback((el) => {
    if (el && defaultOpen) el.open = true
  }, [defaultOpen])
  return (
    <details className="rail-fold" ref={initOpen}>
      <summary className="rail-fold-head">
        <span className="rail-fold-title">{title}</span>
        {hint && <span className="rail-fold-hint">{hint}</span>}
        {count !== undefined && <span className="rail-fold-count">{count}</span>}
        <span className="rail-fold-arrow">▾</span>
      </summary>
      <div className="rail-fold-body">{children}</div>
    </details>
  )
}

// 单条消息气泡：用 memo 包住，流式输出时只有正在生成的那条重新渲染，
// 避免长对话里每条历史消息都重新解析一遍 Markdown
export default function ChatPage({
  config,
  initialPersona,
  onPersonaApplied,
  onExit,
  onEditConfig,
  onSaveConfig
}) {
  const [session, setSession] = useState(() => {
    let saved = loadSession(defaultSession())
    if (typeof initialPersona === 'string' && saved.personalityId !== initialPersona) saved = { ...defaultSession(), personalityId: initialPersona }
    // 记忆按人格分区存储：必须在任何 loadMemory/retrieveMemories 之前确定作用域
    setMemoryScope(saved.personalityId)
    return saved
  })
  const [streaming, setStreaming] = useState(null)
  const [input, setInput] = useState(session.draft || '')
  const [attachments, setAttachments] = useState(session.draftAttachments || [])
  const [conversations, setConversations] = useState(() => listConversations())
  const [railOpen, setRailOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [starsOnly, setStarsOnly] = useState(false)
  const [following, setFollowing] = useState(true)
  const [editMessage, setEditMessage] = useState(null)
  const [editText, setEditText] = useState('')
  const [extraction, setExtraction] = useState(() => getExtractionStatus(session.personalityId))
  const avatarFileRef = useRef(null)
  const requestRef = useRef(null)
  const mountedRef = useRef(true)
  const draftRef = useRef({ input, attachments })
  draftRef.current = { input, attachments }
  const speech = useSpeech({ onText: text => setInput(value => value + (value ? ' ' : '') + text), onNotice: setNotice })
  const [adultModal, setAdultModal] = useState(false)
  const [advModal, setAdvModal] = useState(false)
  const [advDraft, setAdvDraft] = useState(null)
  const [clearModal, setClearModal] = useState(false)
  const [clearMemoryToo, setClearMemoryToo] = useState(false)
  const [wipeConfirm, setWipeConfirm] = useState(false)
  const [backupModal, setBackupModal] = useState(false)
  const [cryptoOn, setCryptoOn] = useState(() => isCryptoEnabled())
  const [cryptoModal, setCryptoModal] = useState(null)
  const [cryptoPass, setCryptoPass] = useState('')
  const [cryptoPass2, setCryptoPass2] = useState('')
  const [cryptoError, setCryptoError] = useState(null)
  const [trimNotice, setTrimNotice] = useState(null)
  const [memory, setMemory] = useState(() => loadMemory())
  const [memModal, setMemModal] = useState(false)
  const [memoryDeleteConfirm, setMemoryDeleteConfirm] = useState(false)
  // 记忆分区总览：用于排查"换了人格还残留上一个人格记忆"
  const [partitions, setPartitions] = useState([])
  const [legacyLeft, setLegacyLeft] = useState(false)
  const [rebuildState, setRebuildState] = useState(null)
  const [rebuildConfirm, setRebuildConfirm] = useState(null)
  const [rebuildResult, setRebuildResult] = useState(null)
  const [backfillState, setBackfillState] = useState(null)
  const [backfillResult, setBackfillResult] = useState(null)
  const [editKwFactId, setEditKwFactId] = useState(null)
  const [kwDraft, setKwDraft] = useState([])
  const [kwInput, setKwInput] = useState('')
  // 重复事实整理：重建记忆是追加式的，重复跑几遍会攒下近似条目
  const [dupGroups, setDupGroups] = useState(null)
  const [dupResult, setDupResult] = useState(null)
  // 单人格记忆的导出/导入：目标人格与导入方式
  const [personaTarget, setPersonaTarget] = useState('')
  const [personaMode, setPersonaMode] = useState('replace')
  const [personaMsg, setPersonaMsg] = useState(null)
  const personaFileRef = useRef(null)
  // 调试：最近一轮实际发给模型的内容（系统提示词 + 历史 + 本轮输入）
  const [promptDebug, setPromptDebug] = useState(null)
  const [promptOpen, setPromptOpen] = useState(false)
  const rebuildFileRef = useRef(null)
  const pendingRebuildMessages = useRef([])

  const sessionRef = useRef(session)
  const abortRef = useRef(null)
  const streamLock = useRef(false)
  const scrollRef = useRef(null)
  const seededRef = useRef(false)
  const actionRef = useRef(null)
  actionRef.current = onMessageAction
  const messageAction = useCallback((...args) => actionRef.current?.(...args), [])

  // 首次挂载：把"从首页选中的人格"写回本地，随后通知上层清空一次性选择，
  // 避免之后"重新配置"返回时被旧人格值覆盖
  useEffect(() => {
    persist(sessionRef.current)
    onPersonaApplied?.()
    // 仅首次挂载执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 切换人格时把记忆作用域跟着切过去，并重新加载该人格的记忆。
  // 这是"换人格后串到上一个人格的剧情"那个 bug 的修复点：
  // 记忆按人格分区存放，换人格必须同时换读写的 key，并刷新界面上的记忆列表
  useEffect(() => {
    setMemoryScope(session.personalityId)
    setMemory(loadMemory())
  }, [session.personalityId])

  // 打开记忆面板时刷新分区总览（每次打开都重新读，避免显示过期数据）
  useEffect(() => {
    if (memModal) refreshPartitions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memModal])

  // Escape 关闭所有弹窗
  useEffect(() => {
    if (!(adultModal || advModal || clearModal || backupModal || memModal || cryptoModal || promptOpen))
      return
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      setAdultModal(false)
      setAdvModal(false)
      setClearModal(false)
      setBackupModal(false)
      setMemModal(false)
      setCryptoModal(null)
      setPromptOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [adultModal, advModal, clearModal, backupModal, memModal, cryptoModal, promptOpen])

  useEffect(() => {
    const open = adultModal || advModal || clearModal || backupModal || memModal || cryptoModal || promptOpen || editMessage
    const dialog = open ? [...document.querySelectorAll('.modal-overlay .modal')].at(-1) : null
    const previous = document.activeElement
    if (dialog) {
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('aria-modal', 'true')
      dialog.setAttribute('aria-label', dialog.querySelector('h3')?.textContent || '设置窗口')
      dialog.querySelector('button, input, textarea, select, [tabindex="0"]')?.focus()
    }
    const keyboard = event => {
      if (event.key === 'Escape') { setEditMessage(null); setRailOpen(false) }
      if (event.key !== 'Tab' || !dialog) return
      const elements = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]')].filter(el => el.getClientRects().length)
      const first = elements[0], last = elements.at(-1)
      if (!first) return
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', keyboard)
    return () => { window.removeEventListener('keydown', keyboard); if (dialog && previous?.isConnected) previous.focus() }
  }, [Boolean(adultModal), Boolean(advModal), clearModal, backupModal, memModal, Boolean(cryptoModal), promptOpen, Boolean(editMessage)])

  // welcome message on first open
  useEffect(() => {
    if (seededRef.current) return
    seededRef.current = true
    const s = sessionRef.current
    if (s.messages.length === 0) {
      const preset = getPersonality(s.personalityId)
      const greeting = {
        id: nextId(),
        role: 'assistant',
        content: preset.greeting,
        local: true
      }
      // 全新对话：情绪回到陌生人起点，关系从零开始
      persist({ ...s, emotion: { ...STRANGER_EMOTION }, messages: [greeting] })
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    const saveBeforeLeave = () => {
      stop()
      const draft = draftRef.current
      saveSessionSafe({ ...sessionRef.current, draft: draft.input, draftAttachments: draft.attachments })
    }
    const onMemoryError = e => setNotice(e.detail?.message || '记忆保存失败，请导出备份后重试')
    window.addEventListener('xingyu:memory-error', onMemoryError)
    window.addEventListener('pagehide', saveBeforeLeave)
    const unsubscribe = subscribeExtractionStatus(() => setExtraction(getExtractionStatus(sessionRef.current.personalityId)))
    return () => {
      stop()
      mountedRef.current = false
      window.removeEventListener('xingyu:memory-error', onMemoryError)
      window.removeEventListener('pagehide', saveBeforeLeave)
      unsubscribe?.()
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      const current = sessionRef.current
      if (current.draft !== input || JSON.stringify(current.draftAttachments || []) !== JSON.stringify(attachments)) persist({ ...current, draft: input, draftAttachments: attachments })
    }, 500)
    return () => clearTimeout(timer)
  }, [input, attachments])

  // Only follow new text while the reader is close to the end.
  useEffect(() => {
    const el = scrollRef.current
    if (el && following) el.scrollTop = el.scrollHeight
  }, [session.messages.length, streaming?.partial, following])

  // Keep the latest reply visible when the viewport or composer changes size.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !following || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { el.scrollTop = el.scrollHeight })
    observer.observe(el)
    return () => observer.disconnect()
  }, [following])

  const preset = getPersonality(session.personalityId)
  const emotionLabel = emotionLabelOf(session)

  function persist(next) {
    const res = saveSessionSafe(next)
    const nextSession = res.session
    sessionRef.current = nextSession
    setSession(nextSession)
    if (res.saved === false) {
      setTrimNotice({ failed: true, error: res.error })
    } else {
      setTrimNotice(null)
      setConversations(listConversations())
    }
    return res.saved !== false
  }

  function finishRequest(request, result) {
    if (request.done || requestRef.current !== request) return
    request.done = true
    requestRef.current = null
    abortRef.current = null
    streamLock.current = false
    const cur = sessionRef.current
    if (cur.id !== request.sessionId) return
    const status = result.status || (result.ok ? 'completed' : 'failed')
    const text = result.text ?? request.text
    const updated = {
      ...cur,
      emotion: status === 'completed' && result.emotion ? result.emotion : cur.emotion,
      usage: request.usage ? accumulateUsage(cur.usage, request.usage) : cur.usage,
      messages: cur.messages.map(m => m.id === request.id ? { ...m, content: text, reasoning: request.reasoning, pending: false, status, error: result.error || '', usage: request.usage } : m)
    }
    persist(updated)
    if (mountedRef.current) setStreaming(null)
    if (status === 'completed' && text) {
      const index = updated.messages.findIndex(m => m.id === request.id)
      const user = updated.messages[index - 1]
      if (user?.role === 'user') queueExtraction({ model: config.model, thinkingMode: config.thinkingMode,
        userText: user.content, assistantText: text, sensitive: Boolean(user.sensitive),
        personalityId: updated.personalityId, sessionId: updated.id, messageId: user.id, turn: index - 1,
        onDone: () => { if (mountedRef.current && sessionRef.current.personalityId === updated.personalityId) setMemory(loadMemory()) },
        onError: error => { if (mountedRef.current) setNotice(typeof error === 'string' ? error : error?.message || '记忆提炼失败，可以在设置中重试') }
      })
    }
  }

  async function send(raw, providedAttachments) {
    if (requestRef.current) return
    const images = providedAttachments ?? attachments
    const content = (raw ?? input).trim() || (images.length ? '请看看这张图片。' : '')
    if (!content) return
    if (!config.ready) { setNotice('请先测试服务器连接'); return }
    if (images.length && !['deepseek-flash', 'deepseek-v4-flash'].includes(config.model)) { setNotice('图片需要使用 Flash 模型，请先修改 API 配置'); return }
    speech.stopListening()
    speech.stopSpeech()
    const current = sessionRef.current
    const { sensitive } = computeNextEmotion({ session: current, content, preset: getPersonality(current.personalityId) })
    const user = { id: nextId(), role: 'user', content, sensitive, createdAt: Date.now(), attachments: images }
    const id = nextId()
    const snapshot = {
      ...current, draft: '', draftAttachments: [],
      title: current.title && current.title !== '新对话' ? current.title : content.slice(0, 28),
      messages: [...current.messages, user, { id, role: 'assistant', content: '', pending: true, sensitive, createdAt: Date.now() }]
    }
    persist(snapshot)
    setInput('')
    setAttachments([])
    setFollowing(true)
    setSearch('')
    setStarsOnly(false)
    const request = { id, sessionId: sessionRef.current.id, text: '', reasoning: '', usage: null, controller: new AbortController(), done: false }
    requestRef.current = request
    abortRef.current = request.controller
    streamLock.current = true
    setStreaming({ id, partial: '', reasoning: '', thinking: true })
    const currentRequest = () => mountedRef.current && requestRef.current === request && !request.done
    try {
      await runTurn({
        session: sessionRef.current, content, attachments: images, config, signal: request.controller.signal,
        onPrompt: p => { if (currentRequest()) setPromptDebug({ ...p, at: Date.now(), totalChars: (p.apiMessages || []).reduce((n, m) => n + JSON.stringify(m.content).length, 0) }) },
        onReasoning: chunk => {
          if (!currentRequest()) return
          request.reasoning += chunk
          setStreaming(st => st && ({ ...st, reasoning: request.reasoning, thinking: !request.text }))
        },
        onDelta: (chunk, text) => {
          if (!currentRequest()) return
          request.text = text
          setStreaming({ id, partial: text, reasoning: request.reasoning, thinking: false })
        },
        onUsage: u => {
          if (!currentRequest()) return
          request.usage = { prompt_tokens: u.prompt_tokens || 0, completion_tokens: u.completion_tokens || 0, total_tokens: u.total_tokens || 0, reasoning_tokens: u.completion_tokens_details?.reasoning_tokens || 0 }
        },
        onError: error => { if (currentRequest()) request.error = error },
        onDone: result => { if (currentRequest()) finishRequest(request, { ...result, error: result.error || request.error }) }
      })
    } catch (error) {
      if (currentRequest()) finishRequest(request, { status: 'failed', text: request.text, error: error?.message || '发送失败，请重试' })
    } finally {
      if (currentRequest()) finishRequest(request, { status: request.controller.signal.aborted ? 'stopped' : 'failed', text: request.text, error: request.error })
    }
  }

  function stop() {
    const request = requestRef.current
    if (!request) return
    request.controller.abort()
    if (!request.done) finishRequest(request, { status: 'stopped', text: request.text })
  }

  function preserveDraft() {
    stop()
    const draft = draftRef.current
    return persist({ ...sessionRef.current, draft: draft.input, draftAttachments: draft.attachments })
  }

  function adoptSession(next) {
    speech.stopListening()
    speech.stopSpeech()
    sessionRef.current = next
    setSession(next)
    setMemoryScope(next.personalityId)
    setMemory(loadMemory())
    setExtraction(getExtractionStatus(next.personalityId))
    setConversations(listConversations())
    setInput(next.draft || '')
    setAttachments(next.draftAttachments || [])
    setPromptDebug(null)
    setSearch('')
    setStarsOnly(false)
    setFollowing(true)
    setRailOpen(false)
    setEditMessage(null)
    setRebuildConfirm(null)
    setEditKwFactId(null)
    setMemoryDeleteConfirm(false)
    setDupGroups(null)
    setDupResult(null)
    seededRef.current = true
  }

  function newConversation(personalityId = sessionRef.current.personalityId) {
    if (!preserveDraft()) { setNotice('当前内容尚未保存，请先导出备份后再切换'); return }
    try {
      const p = getPersonality(personalityId)
      const next = createConversation({ ...defaultSession(), personalityId, userGender: sessionRef.current.userGender, messages: [{ id: nextId(), role: 'assistant', content: p.greeting, local: true }] }, '新对话')
      adoptSession(next)
    } catch (error) { setNotice(error.message || '新建对话失败') }
  }

  function selectConversation(id) {
    if (id === sessionRef.current.id) { setRailOpen(false); return }
    if (!preserveDraft()) { setNotice('当前内容尚未保存，请先导出备份后再切换'); return }
    try { adoptSession(activateConversation(id, defaultSession())) } catch (error) { setNotice(error.message) }
  }

  function renameChat(id, title) {
    try {
      if (!title.trim()) { setNotice('请输入对话名称'); return false }
      renameConversation(id, title.trim())
      if (sessionRef.current.id === id) { sessionRef.current = { ...sessionRef.current, title: title.trim() }; setSession(sessionRef.current) }
      setConversations(listConversations())
      return true
    } catch (error) { setNotice(error.message); return false }
  }

  function deleteChat(id) {
    if (!preserveDraft()) return false
    try {
      const active = id === sessionRef.current.id
      deleteConversation(id)
      const items = listConversations()
      if (active) {
        if (items.length) adoptSession(activateConversation(items[0].id, defaultSession()))
        else {
          const p = getPersonality(sessionRef.current.personalityId)
          adoptSession(createConversation({ ...defaultSession(), personalityId: p.id, messages: [{ id: nextId(), role: 'assistant', content: p.greeting, local: true }] }, '新对话'))
        }
      } else setConversations(items)
      return true
    } catch (error) { setNotice(error.message); return false }
  }

  function switchPersona(personalityId) {
    if (personalityId !== sessionRef.current.personalityId) newConversation(personalityId)
  }

  function leave(action) {
    if (!preserveDraft()) { setNotice('还有未保存内容，请先导出备份'); return }
    speech.stopSpeech()
    speech.stopListening()
    action()
  }

  async function onMessageAction(action, msg) {
    if (action === 'image') {
      try {
        const result = await downloadImage(msg)
        setNotice(result.cancelled ? '已取消保存图片' : '已导出图片')
      } catch (error) { setNotice(error.message || '图片保存失败') }
    } else if (action === 'copy') {
      try { await navigator.clipboard.writeText(msg.content); setNotice('已复制这条消息') } catch { setNotice('复制失败，请长按或选中消息复制') }
    } else if (action === 'star') {
      persist({ ...sessionRef.current, messages: sessionRef.current.messages.map(m => m.id === msg.id ? { ...m, starred: !m.starred } : m) })
    } else if (action === 'speak') speech.speak(msg.content)
    else {
      const messages = sessionRef.current.messages
      const index = messages.findIndex(m => m.id === msg.id)
      const userIndex = msg.role === 'user' ? index : index - 1
      const user = messages[userIndex]
      if (user?.role !== 'user') return
      if (action === 'edit') { setEditMessage(user); setEditText(user.content) }
      else branchFrom(user, user.content)
    }
  }

  async function exportConversation() {
    try {
      const current = sessionRef.current
      const result = await downloadText(conversationMarkdown(current, getPersonality(current.personalityId).name), `${current.title || '星语对话'}.md`)
      setNotice(result.cancelled ? '已取消导出' : '已导出对话文本')
    } catch (error) { setNotice(error.message || '导出失败，请重试') }
  }

  function branchFrom(user, content) {
    if (!preserveDraft() || !content.trim()) return
    const current = sessionRef.current
    const index = current.messages.findIndex(m => m.id === user.id)
    if (index < 0) return
    try {
      const branch = createConversation({ ...current, id: undefined, createdAt: Date.now(), updatedAt: Date.now(), messages: current.messages.slice(0, index), draft: '', draftAttachments: [], usage: null, forkedFrom: current.id }, (current.title || '对话').slice(0, 60) + ' · 分支')
      adoptSession(branch)
      setEditMessage(null)
      setNotice('已创建分支，原对话已保留；同一人格的长期记忆仍然共享')
      send(content, user.attachments || [])
    } catch (error) { setNotice(error.message) }
  }

  async function changeAvatar(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const sessionId = sessionRef.current.id
    try {
      const image = await prepareImage(file, { maxEdge: 512, maxChars: 180000 })
      if (sessionRef.current.id === sessionId) persist({ ...sessionRef.current, avatar: image.dataUrl })
    } catch (error) { setNotice(error.message) }
  }

  function toggleAdult(target) {
    if (target && !sessionRef.current.ageConfirmed) {
      setAdultModal({ target, step: 'age' })
    } else {
      setAdultModal({ target })
    }
  }

  function confirmAdult() {
    stop()
    const target = adultModal.target
    const s = sessionRef.current
    const next =
      adultModal.step === 'age'
        ? { ...s, ageConfirmed: true, adultOn: target }
        : { ...s, adultOn: target }
    persist(next)
    setAdultModal(false)
  }

  function openAdvEditor() {
    const s = sessionRef.current
    const p = getPersonality(s.personalityId)
    const traits = s.override?.traits ? { ...s.override.traits } : { ...p.traits }
    const baseline = s.override?.baseline ? { ...s.override.baseline } : { ...p.baseline }
    setAdvDraft({ traits, baseline, emotion: { ...s.emotion } })
    setAdvModal({ step: 'edit' })
  }

  function saveAdv() {
    const s = sessionRef.current
    persist({
      ...s,
      override: { traits: { ...advDraft.traits }, baseline: { ...advDraft.baseline } },
      emotion: { ...advDraft.emotion }
    })
    setAdvModal(false)
  }

  function resetAdv() {
    const p = getPersonality(sessionRef.current.personalityId)
    setAdvDraft({
      traits: { ...p.traits },
      baseline: { ...p.baseline },
      emotion: { ...p.baseline }
    })
  }

  function clampNum(v, min, max) {
    return Math.max(min, Math.min(max, Number(v) || 0))
  }

  function setAdvTrait(key, v) {
    setAdvDraft((d) => ({ ...d, traits: { ...d.traits, [key]: clampNum(v, 0, 100) } }))
  }

  function setAdvBase(key, v) {
    setAdvDraft((d) => ({ ...d, baseline: { ...d.baseline, [key]: clampNum(v, -100, 100) } }))
  }

  function setAdvEmo(key, v) {
    setAdvDraft((d) => ({ ...d, emotion: { ...d.emotion, [key]: clampNum(v, -100, 100) } }))
  }

  function handleClear() {
    // 记录都删了，长期记忆也该跟着走：否则记忆里还挂着"和这个角色发生过的事"，
    // 换人格时看着就像残留（clearMemory 内部同时会取消排队中的提炼）
    stop()
    if (clearMemoryToo) { try { clearMemory() } catch (error) { setNotice(error.message); return } }
    setMemory(loadMemory())
    setPromptDebug(null)
    setInput('')
    setAttachments([])
    seededRef.current = false
    setClearModal(false)
    const preset = getPersonality(sessionRef.current.personalityId)
    // 清空对话＝重新开始：情绪回到陌生人起点、用量统计归零，重新走一次第一次见面
    persist({
      ...sessionRef.current,
      draft: '', draftAttachments: [],
      emotion: { ...STRANGER_EMOTION },
      usage: null,
      messages: [{ id: nextId(), role: 'assistant', content: preset.greeting, local: true }]
    })
    seededRef.current = true
  }

  function handleWipeAll() {
    // 彻底清除：对话 + 长期记忆 + 模型配置，然后回到首页重新配置
    stop()
    speech.stopSpeech()
    speech.stopListening()
    clearAllData()
    onSaveConfig({
      connectionMode: 'server',
      model: config.model,
      thinkingMode: config.thinkingMode,
      ready: false
    })
    setMemory(loadMemory())
    setClearModal(false)
    onExit()
  }

  function submitCrypto() {
    if (!preserveDraft()) { setCryptoError('当前数据尚未保存，请先导出备份'); return }
    setCryptoError(null)
    if (cryptoModal?.mode === 'enable') {
      if (cryptoPass.length < 6) {
        setCryptoError('口令至少 6 位')
        return
      }
      if (cryptoPass !== cryptoPass2) {
        setCryptoError('两次输入的口令不一致')
        return
      }
      try {
        enableCrypto(cryptoPass)
        setCryptoOn(true)
        setCryptoModal(null)
        setCryptoPass('')
        setCryptoPass2('')
      } catch (e) {
        setCryptoError(e?.message || '开启失败')
      }
    } else {
      try {
        if (!disableCrypto(cryptoPass)) { setCryptoError('口令不正确'); return }
      } catch (error) { setCryptoError(error.message || '关闭加密失败，数据已保留'); return }
      setCryptoOn(false)
      setCryptoModal(null)
      setCryptoPass('')
      setCryptoPass2('')
    }
  }

  function handleLockNow() {
    if (!preserveDraft()) { setNotice('当前数据尚未保存，请先导出备份'); return }
    speech.stopSpeech()
    speech.stopListening()
    lockCrypto()
    window.location.reload()
  }

  function handleImportSession(imported) {
    adoptSession(imported)
  }

  // 导入完成后刷新界面上的记忆与分区：备份里可能带回了多个人格的记忆，
  // 正在看的那份也要重新读，否则界面还停在导入前的旧数据
  function handleImported() {
    setMemory(loadMemory())
    refreshPartitions()
  }

  function handleDeleteFact(id) {
    setMemory(deleteFact(id))
  }

  function handleClearMemory() {
    if (!memoryDeleteConfirm) { setMemoryDeleteConfirm(true); return }
    stop()
    try { setMemory(clearMemory()) } catch (error) { setNotice(error.message); return }
    setMemoryDeleteConfirm(false)
    refreshPartitions()
    setDupGroups(null)
    setDupResult(null)
  }

  // 扫一遍当前人格的记忆：确定重复的和只是相似的必须分开，
  // 后者一键合并会删掉真实记忆（"表达爱意"和"只爱一人"并不是同一件事）
  function handleScanDuplicates() {
    try {
      const r = findDuplicateGroups(sessionRef.current.personalityId)
      setDupGroups(r)
      setDupResult(
        r.exact.length === 0 && r.review.length === 0
          ? { type: 'ok', text: '没有发现重复事实，这份记忆是干净的。' }
          : null
      )
    } catch (err) {
      setDupGroups(null)
      setDupResult({ type: 'error', text: `扫描失败：${err?.message || '未知错误'}` })
    }
  }

  function handleMergeGroup(ids) {
    setMemory(mergeFacts(ids, sessionRef.current.personalityId))
    setDupGroups(findDuplicateGroups(sessionRef.current.personalityId))
    setDupResult({ type: 'ok', text: `已把 ${ids.length} 条合并为 1 条。` })
  }

  function handleMergeAllDuplicates() {
    const r = mergeAllDuplicates(sessionRef.current.personalityId)
    setMemory(loadMemory())
    setDupGroups(findDuplicateGroups(sessionRef.current.personalityId))
    setDupResult({
      type: 'ok',
      text:
        r.groups === 0
          ? '没有确定重复的事实。'
          : `合并了 ${r.groups} 组确定重复的，事实从 ${r.before} 条精简到 ${r.after} 条（去掉 ${r.removed} 条重复）。`
    })
  }

  // 记忆按人格分区：这里列出所有分区，让"上一个人格的剧情留在新人格里"这种问题
  // 能被直接看见并精确清掉，而不是只能一键清空全部
  function refreshPartitions() {
    try {
      setPartitions(listMemoryPartitions())
      setLegacyLeft(hasLegacyMemory())
    } catch {
      setPartitions([])
      setLegacyLeft(false)
    }
  }

  function handleClearPartition(pid) {
    clearMemoryPartition(pid)
    refreshPartitions()
    // 清的就是当前人格时，顺带刷新界面上的记忆列表
    if (sessionRef.current.personalityId === pid) setMemory(loadMemory())
  }

  // 单人格记忆导出：只装这一个角色，不含会话，导入时也不会碰会话
  async function handleExportPersona(pid) {
    try {
      const json = exportPersonaMemory(pid)
      const { memory: m } = personaFileOf(pid)
      const preset = PERSONALITIES.find((x) => x.id === pid)
      const result = await downloadText(json, `星语-记忆-${preset ? preset.name : pid}.json`, 'application/json')
      if (result.cancelled) { setPersonaMsg({ type: 'ok', text: '已取消导出' }); return }
      setPersonaMsg({
        type: 'ok',
        text: `已导出「${preset ? preset.name : pid}」的记忆：${m.facts.length} 条事实 · ${m.summaries.length} 条摘要。`
      })
    } catch (err) {
      setPersonaMsg({ type: 'error', text: `导出失败：${err?.message || '未知错误'}` })
    }
  }

  function handlePersonaFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const parsed = parsePersonaMemory(String(reader.result))
      if (!parsed) {
        // 整份备份走「备份与恢复」那条路：这里只认单人格记忆文件，
        // 否则会让人以为"导入了记忆"，实际连会话一起换掉了
        setPersonaMsg({
          type: 'error',
          text: '这不是单人格记忆文件。整份对话备份请用下面的「备份与恢复」。'
        })
        return
      }
      if (!personaTarget) {
        setPersonaMsg({ type: 'error', text: '先选一个角色，再导入她的记忆文件。' })
        return
      }
      const r = importPersonaMemory(personaTarget, parsed.memory, personaMode)
      const preset = PERSONALITIES.find((x) => x.id === personaTarget)
      setPersonaMsg({
        type: 'ok',
        text:
          personaMode === 'merge'
            ? `已并进「${preset ? preset.name : personaTarget}」：新增 ${r.added} 条、更新 ${r.updated} 条，现在共 ${r.facts} 条。`
            : `已替换「${preset ? preset.name : personaTarget}」的记忆，现在共 ${r.facts} 条。`
      })
      refreshPartitions()
      if (sessionRef.current.personalityId === personaTarget) setMemory(loadMemory())
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  function handleDropLegacy() {
    dropLegacyMemory()
    refreshPartitions()
  }

  function startKwEdit(f) {
    setEditKwFactId(f.id)
    setKwDraft([...(f.keywords || [])])
    setKwInput('')
  }

  function addKw() {
    const v = kwInput.trim()
    if (!v) return
    setKwDraft((d) => (d.includes(v) ? d : [...d, v.slice(0, 12)]))
    setKwInput('')
  }

  function removeKw(k) {
    setKwDraft((d) => d.filter((x) => x !== k))
  }

  function saveKw() {
    setMemory(updateFactKeywords(editKwFactId, kwDraft))
    setEditKwFactId(null)
  }

  function handleRebuildFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > 50 * 1024 * 1024) { setRebuildResult('备份超过 50 MB，请选择较小的文件'); return }
    const personalityId = sessionRef.current.personalityId
    const reader = new FileReader()
    reader.onload = () => {
      const res = parseBackup(String(reader.result))
      if (!res.ok) {
        setRebuildResult(`重建失败：${res.reason}`)
        return
      }
      pendingRebuildMessages.current = res.session.messages
      const { pairs, chunks } = countRebuildChunks(res.session.messages)
      setRebuildConfirm({ pairs, chunks, source: 'backup', personalityId })
      setRebuildResult(null)
    }
    reader.onerror = () => setRebuildResult('无法读取文件，请重新选择')
    reader.readAsText(file)
  }

  function handleDirectRebuild() {
    if (rebuildState?.running) return
    const s = sessionRef.current
    const msgs = (s?.messages || []).filter(
      (m) =>
        m &&
        m.content &&
        !m.pending && !m.local && !['failed', 'stopped'].includes(m.status) &&
        (m.role === 'user' || m.role === 'assistant') &&
        !/^（(发送失败|连接中断)/.test(m.content)
    )
    if (msgs.length < 2) {
      setRebuildResult('当前对话太少，先多聊几句再重建记忆吧')
      return
    }
    const { pairs, chunks } = countRebuildChunks(msgs)
    if (pairs === 0) {
      setRebuildResult('当前对话里还没有完整的一问一答，无法提炼记忆')
      return
    }
    pendingRebuildMessages.current = msgs
    setRebuildConfirm({ pairs, chunks, source: 'current', personalityId: s.personalityId, sessionId: s.id })
    setRebuildResult(null)
  }

  async function startRebuild() {
    if (rebuildState?.running || !rebuildConfirm) return
    setRebuildState({ running: true, total: rebuildConfirm.chunks, done: 0, added: 0 })
    setRebuildResult(null)
    try {
    const res = await rebuildMemoryFromMessages({
      model: config.model,
      thinkingMode: config.thinkingMode,
      personalityId: rebuildConfirm.personalityId,
      sessionId: rebuildConfirm.sessionId,
      messages: pendingRebuildMessages.current,
      onProgress: (p) => {
        setRebuildState({ running: true, total: p.total, done: p.done, added: p.added })
        setMemory(loadMemory())
      }
    })
    setRebuildResult(
      `${res.cancelled ? '重建已取消' : '重建完成'}：新增 ${res.addedFacts} 条事实 / ${res.addedSummaries} 条摘要${
        res.failed > 0 ? `，${res.failed} 段失败（已自动重试 3 次，多为接口限流，稍后可再重建）` : ''
      }`
    )
    } catch (error) {
      setRebuildResult(`重建失败：${error?.message || '未知错误'}`)
    } finally {
      setRebuildState(null)
      setRebuildConfirm(null)
      setMemory(loadMemory())
    }
  }

  async function startBackfill() {
    if (backfillState?.running) return
    setBackfillState({ running: true, done: 0, total: 0, updated: 0 })
    setBackfillResult(null)
    try {
      const res = await backfillKeywords({
        personalityId: sessionRef.current.personalityId,
        model: config.model,
        thinkingMode: config.thinkingMode,
        onProgress: (p) =>
          setBackfillState({ running: true, done: p.done, total: p.total, updated: p.updated })
      })
      setBackfillResult(
        `${res.cancelled ? '补全已取消' : '补全完成'}：处理 ${res.processed || 0} 条，更新 ${res.updated} 条关键词${
          res.failed > 0
            ? `；${res.failed} 批接口未返回（${res.lastError || '未知原因'}），已用本地兜底`
            : ''
        }`
      )
    } catch (err) {
      setBackfillResult(`补全失败：${err?.message || '未知错误'}，请重试`)
    } finally {
      setBackfillState(null)
      setMemory(loadMemory())
    }
  }

  function handleImportConfig(cfg) {
    onSaveConfig?.({ ...cfg, ready: true }, { persist: false })
  }

  const isStreaming = Boolean(streaming)

  return (
    <div className={`chat-page ${railOpen ? 'rail-open' : ''}`}>
      {railOpen && <button className="chat-rail-backdrop" aria-label="关闭设置侧栏" onClick={() => setRailOpen(false)} />}
      <header className="chat-topbar">
        <button className="btn btn-ghost btn-icon" onClick={() => leave(onExit)} aria-label="返回首页" title="返回首页">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5" />
            <path d="m12 19-7-7 7-7" />
          </svg>
        </button>
        <button className="chat-rail-toggle btn btn-ghost" onClick={() => setRailOpen(v => !v)} aria-expanded={railOpen} aria-controls="chat-settings">☰ <span>对话与设置</span></button>
        <div className="topbar-info">
          <span className="topbar-avatar">{preset.emoji}</span>
          <div>
            <div className="topbar-name">{session.title || preset.name}</div>
            <div className="topbar-meta">
              <span className="emotion-chip" style={{ color: emotionLabel.color, padding: '3px 10px' }}>
                <span className="dot" style={{ background: emotionLabel.color }} />
                {emotionLabel.name}
              </span>
              <span className="mono hide-sm" style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                {config.model}
              </span>
            </div>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="btn btn-ghost btn-sm" onClick={exportConversation}>导出文本</button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setPromptOpen(true)}
            disabled={!promptDebug}
            title={promptDebug ? '查看最近一轮实际发给模型的内容' : '先聊一句，才能看到这一轮发了什么'}
          >
            🔍 本轮提示词
          </button>
        </div>
      </header>
      {notice && <div className="upgrade-notice" role="status"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="关闭提示">×</button></div>}

      {trimNotice && (
        <div className="trim-banner danger" role="alert">
          <span>保存失败：{trimNotice.error || '本机存储空间不足'}。当前内容仍在页面里，请先导出备份再关闭。</span>
          <button className="btn btn-ghost btn-sm" onClick={() => { preserveDraft(); setBackupModal(true) }}>立即备份</button>
          <button className="trim-banner-close" onClick={() => setTrimNotice(null)} aria-label="关闭">
            ✕
          </button>
        </div>
      )}

      <div className="chat-body">
        <aside className="chat-rail" id="chat-settings" aria-label="对话与设置">
          <button className="chat-rail-close" onClick={() => setRailOpen(false)} aria-label="收起对话与设置">收起设置 ×</button>
          <ConversationPanel conversations={conversations} activeId={session.id} onSelect={selectConversation} onNew={() => newConversation()} onRename={renameChat} onDelete={deleteChat} />
          <div className="rail-block">
            <div className={`avatar-stage ${speech.speaking || streaming ? 'is-speaking' : ''}`}>
              {session.avatar ? <img className="custom-avatar" src={session.avatar} alt={`${preset.name}的角色形象`} /> : <VirtualAvatar expression={emotionLabel.expr} color={emotionLabel.color} />}
              <span className="emotion-chip" style={{ color: emotionLabel.color }}>
                <span className="dot" style={{ background: emotionLabel.color }} />
                {emotionLabel.name}
              </span>
            </div>
            <div className="rail-btn-row"><input type="file" ref={avatarFileRef} accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={changeAvatar} /><button className="btn btn-ghost btn-sm" onClick={() => avatarFileRef.current?.click()}>自定义形象</button>{session.avatar && <button className="btn btn-ghost btn-sm" onClick={() => persist({ ...sessionRef.current, avatar: null })}>恢复动态头像</button>}</div>
          </div>

          {/* 情绪四维单独一块并默认收起：情绪名在头像上和顶栏都看得到，
              这里的四根进度条属于"想看细节时再看"。收起来能腾出 267px */}
          <RailFold title="情绪空间" hint="四维数值" count={emotionLabel.name}>
            <EmotionPanel emotion={session.emotion} firstMeeting={isFirstMeeting(session)} />
          </RailFold>

          {/* 常用设置：亲密模式、你演谁、经验、切换人格。默认展开 */}
          <RailFold title="常用设置" defaultOpen>
            <div className="rail-field">
              <div className="rail-field-label">
                <span className="emoji">{session.adultOn ? '💗' : '🔒'}</span>
                亲密模式
              </div>
              <button
                type="button"
                className={`switch ${session.adultOn ? 'on' : ''}`}
                onClick={() => toggleAdult(!session.adultOn)}
                aria-label="切换成人模式"
              />
            </div>
            <p className="gate-hint">
              {session.adultOn
                ? `已开启：${personaPronoun(preset)}会自然地表现亲密。开关完全由你手动控制，不会自动关闭或暂停。`
                : '关闭：日常陪伴模式。开启与否完全由你手动决定。'}
            </p>

            <div className="rail-field rail-field-top">
              <div className="rail-field-label">你演的角色</div>
              <div className="thinking-options">
                {[
                  { id: 'female', label: '女生（旁白用「她」）' },
                  { id: 'male', label: '男生（旁白用「他」）' }
                ].map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className={`thinking-option ${(session.userGender || 'female') === o.id ? 'active' : ''}`}
                    onClick={() => persist({ ...sessionRef.current, userGender: o.id })}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="rail-field rail-field-top">
              <div className="rail-field-label">经验设定</div>
              <div className="thinking-options">
                {[
                  { id: 'first', label: '双方都是第一次' },
                  { id: 'free', label: '不做限制' }
                ].map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className={`thinking-option ${(session.experience || 'first') === o.id ? 'active' : ''}`}
                    onClick={() => persist({ ...sessionRef.current, experience: o.id })}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="gate-hint">
              {session.userGender === 'male'
                ? '旁白里会用「他」称呼你。'
                : '旁白里会用「她」称呼你。'}
              {' '}
              {session.experience === 'free'
                ? '经验不设限：人格可以自行发挥，包括给自己设定过往经验。'
                : '默认双方都没有过往经历，人格不会编造"以前和谁"，紧张生疏才是正常反应。'}
            </p>

            <div className="rail-field rail-field-top">
              <div className="rail-field-label">记忆 · 已记住 {memory.facts.length} 条</div>
              <div className="rail-btn-row">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMemModal(true)}>
                  查看/管理
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { preserveDraft(); setBackupModal(true) }}>
                  💾 备份与恢复
                </button>
              </div>
            </div>
            <p className="gate-hint">
              备份存的是完整对话 + 全部人格的记忆；只给某个角色留底，进「查看/管理」按角色导出。
            </p>
            <p className="gate-hint" role="status">记忆任务：{extraction?.running ? '处理中' : '空闲'} · 等待 {extraction?.pending || 0} · 失败 {extraction?.failed || 0}</p>
            {extraction?.failed > 0 && <button className="btn btn-ghost btn-sm" onClick={() => retryFailedExtraction({ personalityId: session.personalityId })}>重试失败的记忆提炼</button>}
          </RailFold>

          {/* 切换人格单独一块：19 个人格展开就有一千多像素，和上面那些小开关放一起
              会把左栏撑得极长。这里默认收起，标题上直接显示现在是谁，想换再点开 */}
          <RailFold title="切换人格" count={`${preset.emoji} ${preset.name}`}>
            <div className="persona-mini-list">
              {['female', 'male'].map((g) => (
                <Fragment key={g}>
                  <div className="persona-group-label">
                    {g === 'female' ? '♀ 女生人格' : '♂ 男生人格'}
                  </div>
                  {PERSONALITIES.filter((p) => p.gender === g).map((p) => (
                    <button
                      key={p.id}
                      className={`persona-mini ${session.personalityId === p.id ? 'active' : ''}`}
                      style={{ '--pc': p.color }}
                      onClick={() => switchPersona(p.id)}
                    >
                      <span className="emoji">{p.emoji}</span>
                      <span>{p.name}</span>
                      <span className="mono" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-3)' }}>
                        {p.tag}
                      </span>
                      <span className="persona-tip">{p.desc}</span>
                    </button>
                  ))}
                </Fragment>
              ))}
            </div>
          </RailFold>

          {/* 针对这个会话的操作：从顶栏挪下来，顶栏只留「本轮提示词」 */}
          <RailFold title="对话操作">
            <div className="rail-btn-row">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => leave(onEditConfig)}>
                ⚙️ 重新配置 API
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setClearMemoryToo(false); setWipeConfirm(false); setClearModal(true) }}>
                🗑 清空对话
              </button>
            </div>
            <p className="gate-hint">
              清空只处理当前对话。需要同时重置人格记忆时，在确认窗口中勾选。
            </p>
          </RailFold>

          {/* 偶尔才动的设定：折起来，左栏才清爽 */}
          <RailFold title="高级与统计">
            <button className="btn btn-ghost btn-sm" disabled={!promptDebug} onClick={() => setPromptOpen(true)}>查看本轮提示词</button>
            <div className="rail-field">
              <div className="rail-field-label">人格参数编辑</div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setAdvModal({ step: 'risk' })}
              >
                ⚙️ 打开参数编辑
              </button>
            </div>
            <p className="gate-hint">
              {session.override
                ? '当前人格已有自定义参数，可随时调整或恢复默认。'
                : '直接改数值会改变 TA 的说话方式与情绪反应，存在异常风险。'}
            </p>

            <div className="rail-field rail-field-top">
              <div className="rail-field-label">用量统计</div>
            </div>
            {session.usage ? (
              <>
                <div className="mono" style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.7 }}>
                  <div>输入 {session.usage.prompt_tokens.toLocaleString()}</div>
                  <div>输出 {session.usage.completion_tokens.toLocaleString()}</div>
                  {session.usage.reasoning_tokens > 0 && (
                    <div>└ 其中思考 {session.usage.reasoning_tokens.toLocaleString()}</div>
                  )}
                  <div style={{ color: 'var(--text-3)' }}>
                    共 {session.usage.total_tokens.toLocaleString()} tokens · {session.usage.turns} 轮
                  </div>
                  <div style={{ color: 'var(--text-3)' }}>
                    均 {Math.round(session.usage.prompt_tokens / Math.max(1, session.usage.turns)).toLocaleString()} 输入 /{' '}
                    {Math.round(session.usage.completion_tokens / Math.max(1, session.usage.turns)).toLocaleString()} 输出每轮
                  </div>
                </div>
                <p className="gate-hint">
                  本机累计，只算本设备。注意「输入」是<b>每轮完整上下文的总和</b>——系统提示词加全部历史对话
                  每轮都要重发一次，所以它远大于对话本身的字数，并不等于新产生的消耗（重复部分会命中服务端缓存，
                  按更低价格计费）。真正随对话增长的是「输出」。
                </p>
              </>
            ) : (
              <p className="gate-hint">还没有数据。聊一句就会显示累计 token 用量，方便你对账。</p>
            )}

            <div className="rail-field rail-field-top">
              <div className="rail-field-label">隐私锁</div>
            </div>
            <p className="gate-hint">
              {cryptoOn
                ? '已开启：对话与记忆在本机以密文保存，每次打开需要口令解锁。'
                : '未开启：数据以明文保存在本机浏览器，能打开这台电脑的人可以直接读到。'}
            </p>
            <div className="rail-btn-row">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setCryptoModal({ mode: cryptoOn ? 'disable' : 'enable' })}
              >
                {cryptoOn ? '关闭加密' : '开启本地加密'}
              </button>
              {cryptoOn && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={handleLockNow}>
                  立即锁定
                </button>
              )}
            </div>
          </RailFold>
        </aside>

        <main className="chat-main">
          <div className="chat-search-row"><input className="input" aria-label="搜索当前对话" placeholder="查找当前对话中的内容" value={search} onChange={e => setSearch(e.target.value)} /><button className={`btn btn-ghost btn-sm ${starsOnly ? 'active' : ''}`} aria-pressed={starsOnly} onClick={() => setStarsOnly(v => !v)}>{starsOnly ? '显示全部' : '只看收藏'}</button>{search && <button className="btn btn-ghost btn-sm" onClick={() => setSearch('')}>清除</button>}</div>
          <div className="messages" ref={scrollRef} onScroll={e => { const el = e.currentTarget; setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 90) }}>
            {session.messages.length === 0 ? (
              <div className="chat-empty">
                <div className="va-mini">
                  <VirtualAvatar expression={emotionLabel.expr} color={emotionLabel.color} />
                </div>
                <h3>和{preset.name}打个招呼吧</h3>
                <p>{preset.desc}</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 'min(420px, 100%)' }}>
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="btn btn-ghost btn-sm" onClick={() => send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              session.messages.filter(msg => (!search || msg.content.toLocaleLowerCase().includes(search.toLocaleLowerCase())) && (!starsOnly || msg.starred)).map((msg) => {
                const active = streaming?.id === msg.id
                return (
                  <ChatMessage
                    key={msg.id}
                    msg={msg}
                    active={active}
                    partial={active ? streaming?.partial || '' : ''}
                    thinking={active ? Boolean(streaming?.thinking) : false}
                    reasoning={active ? streaming?.reasoning || '' : ''}
                    presetName={preset.name}
                    presetEmoji={preset.emoji}
                    disabled={isStreaming}
                    onAction={messageAction}
                  />
                )
              })
            )}
          </div>
          {!following && <button className="jump-latest" onClick={() => { setSearch(''); setStarsOnly(false); setFollowing(true) }}>回到最新消息 ↓</button>}

          <div className="composer">
            <ComposerTools key={session.id || 'initial'} attachments={attachments} onAttachments={setAttachments} speech={speech} model={config.model} disabled={isStreaming} onNotice={setNotice} />
            <div className="composer-box">
              <textarea
                rows={1}
                placeholder={`和${preset.name}说点什么…`}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value)
                  e.target.style.height = 'auto'
                  e.target.style.height = `${Math.min(170, e.target.scrollHeight)}px`
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !window.matchMedia('(pointer: coarse)').matches) {
                    e.preventDefault()
                    send()
                  }
                }}
              />
              {isStreaming ? (
                <button className="send-btn stop" onClick={stop} aria-label="停止生成" title="停止生成">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2.5" />
                  </svg>
                </button>
              ) : (
                <button
                  className="send-btn"
                  onClick={() => send()}
                  disabled={!input.trim() && attachments.length === 0}
                  aria-label="发送"
                  title="发送"
                >
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m22 2-7 20-4-9-9-4Z" />
                    <path d="M22 2 11 13" />
                  </svg>
                </button>
              )}
            </div>
            <div className="composer-hint">
              Enter 发送 · Shift + Enter 换行 · 触屏回车换行 · 草稿自动保存
            </div>
          </div>
        </main>
      </div>
      {editMessage && <div className="modal-overlay" onClick={() => setEditMessage(null)}><form className="modal" role="dialog" aria-modal="true" aria-label="编辑消息并建立分支" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); branchFrom(editMessage, editText) }}><h3>编辑消息并建立分支</h3><p>原对话会保留。新分支从这句话继续；这个人格的长期记忆仍然共享。</p><textarea className="input edit-message-input" rows={6} autoFocus aria-label="编辑消息内容" value={editText} onChange={e => setEditText(e.target.value)} /><div className="modal-actions"><button type="button" className="btn btn-ghost" onClick={() => setEditMessage(null)}>取消</button><button className="btn btn-primary" type="submit" disabled={!editText.trim()}>创建分支并发送</button></div></form></div>}

      {adultModal && (
        <div className="modal-overlay" onClick={() => setAdultModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setAdultModal(false)} aria-label="关闭">
              ✕
            </button>
            {adultModal.step === 'age' ? (
              <>
                <h3>开启前，请先确认</h3>
                <p>
                  亲密模式会让{personaPronoun(preset)}自然地表现亲密与暧昧。请确认你已年满 18
                  周岁，并知晓开启后对话可能包含成人内容，可随时手动关闭。
                </p>
                <p className="muted" style={{ fontSize: 13 }}>
                  确认只保存在你的本机浏览器，之后开启无需重复确认。
                </p>
              </>
            ) : (
              <>
                <h3>{adultModal.target ? '开启亲密模式' : '关闭亲密模式'}</h3>
                {adultModal.target ? (
                  <>
                    <p>
                      开启后{personaPronoun(preset)}会自然地表现亲密与暧昧，语气更贴近恋人关系。
                      开关完全由你手动控制，不会自动关闭或暂停。
                    </p>
                    <p className="muted" style={{ fontSize: 13 }}>
                      注：最终输出的内容边界仍由模型自身的安全策略决定。关闭亲密模式后，历史里的亲密内容也不会再发给模型。
                    </p>
                  </>
                ) : (
                  <p>
                    关闭后{personaPronoun(preset)}会回到日常的陪伴关系，不再涉及亲密话题，历史里的亲密内容也不会再发给模型。
                  </p>
                )}
              </>
            )}
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setAdultModal(false)}>
                再想想
              </button>
              <button
                className={`btn ${adultModal.target ? 'btn-heart' : 'btn-ghost'}`}
                onClick={confirmAdult}
              >
                {adultModal.step === 'age' ? '确认并开启' : adultModal.target ? '确认开启' : '确认关闭'}
              </button>
            </div>
          </div>
        </div>
      )}

      {advModal && (
        <div className="modal-overlay" onClick={() => setAdvModal(false)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setAdvModal(false)} aria-label="关闭">
              ✕
            </button>
            {advModal.step === 'risk' ? (
              <>
                <h3>人格异常风险确认</h3>
                <p>
                  直接修改人格参数会影响 TA 的说话方式与情绪反应，可能导致：人设不稳、言行反差、回复语气异常、情绪状态不协调。
                </p>
                <p className="muted" style={{ fontSize: 13 }}>
                  修改即时生效，可随时「恢复默认」。聊天中情绪数值仍会随对话继续增减（积分机制正常运行）。
                </p>
                <div className="modal-actions">
                  <button className="btn btn-ghost" onClick={() => setAdvModal(false)}>
                    取消
                  </button>
                  <button className="btn btn-heart" onClick={openAdvEditor}>
                    我已知晓风险，进入编辑
                  </button>
                </div>
              </>
            ) : advDraft ? (
              <>
                <h3>高级人格参数 · {preset.name}</h3>
                <div className="adv-form">
                  <div className="adv-group">
                    <div className="adv-group-title">人格特质（影响说话方式，直接进提示词）</div>
                    {ADV_TRAITS.map((it) => (
                      <div className="adv-row" key={it.key}>
                        <span className="adv-label">{it.label}</span>
                        <input
                          type="range"
                          min={it.min}
                          max={it.max}
                          value={advDraft.traits[it.key]}
                          onChange={(e) => setAdvTrait(it.key, e.target.value)}
                        />
                        <span className="adv-value">{advDraft.traits[it.key]}</span>
                      </div>
                    ))}
                  </div>
                  <div className="adv-group">
                    <div className="adv-group-title">情绪基线（情绪回落的目标底色）</div>
                    {ADV_EMO.map((it) => (
                      <div className="adv-row" key={`b-${it.key}`}>
                        <span className="adv-label">{it.label}</span>
                        <input
                          type="range"
                          min={it.min}
                          max={it.max}
                          value={advDraft.baseline[it.key]}
                          onChange={(e) => setAdvBase(it.key, e.target.value)}
                        />
                        <span className="adv-value">{advDraft.baseline[it.key]}</span>
                      </div>
                    ))}
                  </div>
                  <div className="adv-group">
                    <div className="adv-group-title">当前情绪数值（立即生效，聊天中会继续变化）</div>
                    {ADV_EMO.map((it) => (
                      <div className="adv-row" key={`e-${it.key}`}>
                        <span className="adv-label">{it.label}</span>
                        <input
                          type="range"
                          min={it.min}
                          max={it.max}
                          value={advDraft.emotion[it.key]}
                          onChange={(e) => setAdvEmo(it.key, e.target.value)}
                        />
                        <span className="adv-value">{advDraft.emotion[it.key]}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="adv-preview">
                  <div className="adv-preview-title">人格预览</div>
                  <p>{describePersonality({ traits: advDraft.traits, baseline: advDraft.baseline })}</p>
                </div>
                <div className="modal-actions">
                  <button className="btn btn-ghost" onClick={resetAdv}>
                    恢复默认
                  </button>
                  <button className="btn btn-ghost" onClick={() => setAdvModal(false)}>
                    取消
                  </button>
                  <button className="btn btn-heart" onClick={saveAdv}>
                    保存并聊天
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}

      {memModal && (
        <div className="modal-overlay" onClick={() => setMemModal(false)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setMemModal(false)} aria-label="关闭">
              ✕
            </button>
            <h3>长期记忆</h3>
            <p className="muted" style={{ fontSize: 13 }}>
              每轮对话后自动提炼。带「私密」标记的记忆在亲密模式关闭时不会注入给模型。
              共 {memory.facts.length} 条事实 · {memory.summaries.length} 条摘要。
            </p>
            <MemoryGraph facts={memory.facts} causalLinks={memory.causalLinks} />

            {/* 重复事实整理：重建记忆是追加式的，跑多次会攒下同一件事的多种说法 */}
            <div className="mem-tidy">
              <div className="mem-tidy-head">
                <span className="rail-title" style={{ margin: 0 }}>
                  重复事实整理
                </span>
                <button className="btn btn-ghost btn-sm" onClick={handleScanDuplicates}>
                  扫描重复
                </button>
                {dupGroups && dupGroups.exact.length > 0 && (
                  <button className="btn btn-primary btn-sm" onClick={handleMergeAllDuplicates}>
                    合并确定重复（{dupGroups.exact.length} 组）
                  </button>
                )}
              </div>
              <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
                「从对话重建记忆」是往现有记忆里追加，重复跑会把同一件事记成好几条。
                这里用提炼时的同一套判重逻辑找相似条目，合并时保留最长说法、最高可信度、
                最早那一轮的出处原话。
              </p>
              {dupResult && (
                <div className={`test-result ${dupResult.type === 'error' ? 'error' : 'success'}`}>
                  <span>{dupResult.type === 'error' ? '✕' : '✓'}</span>
                  <span>{dupResult.text}</span>
                </div>
              )}
              {dupGroups && dupGroups.exact.length > 0 && (
                <>
                  <div className="mem-tidy-sub">确定是同一件事（可放心合并）</div>
                  <ul className="mem-dup-list">
                    {dupGroups.exact.map((g, gi) => (
                      <li key={`e${gi}`}>
                        <div className="mem-dup-items">
                          {g.map((f) => (
                            <span key={f.id} className="mem-dup-item">
                              {f.text}
                            </span>
                          ))}
                        </div>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => handleMergeGroup(g.map((f) => f.id))}
                        >
                          合并这 {g.length} 条
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {dupGroups && dupGroups.review.length > 0 && (
                <>
                  {/* 这一档不能自动合并：只是"有点像"，可能是两件不同的事。
                      合并会连事实和出处原话一起删掉，必须逐组由人判断 */}
                  <div className="mem-tidy-sub warn">
                    只是有点像，需要你自己判断（{dupGroups.review.length} 组）
                  </div>
                  <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
                    这些条目措辞相近但可能是两件不同的事，合并会删掉其中一条和它的出处原话。
                    确认是同一件事再点合并。
                  </p>
                  <ul className="mem-dup-list">
                    {dupGroups.review.map((g, gi) => (
                      <li key={`r${gi}`}>
                        <div className="mem-dup-items">
                          {g.map((f) => (
                            <span key={f.id} className="mem-dup-item">
                              <span className="mem-dup-meta">
                                第 {f.turn !== null && f.turn !== undefined ? f.turn + 1 : '?'} 条
                              </span>
                              {f.text}
                              {f.quote ? (
                                <span className="mem-dup-quote">原话：「{f.quote}」</span>
                              ) : null}
                            </span>
                          ))}
                        </div>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => handleMergeGroup(g.map((f) => f.id))}
                        >
                          确认是同一件事，合并这 {g.length} 条
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            {memory.facts.length === 0 ? (
              <p>还没有记忆。多聊几句，她就会开始记住你。</p>
            ) : (
              <ul className="mem-list">
                {memory.facts.map((f) => (
                  <li key={f.id}>
                    <div className="mem-row">
                      <span className={`mem-badge ${f.sensitive ? 'sens' : ''}`}>
                        {f.sensitive ? '私密' : '事实'}
                      </span>
                      <span className="mem-text">{f.text}</span>
                      {f.conflicts?.length > 0 && (
                        <span style={{ color: '#fbbf24', fontSize: 12 }} title="可能与旧记忆冲突">
                          ⚠
                        </span>
                      )}
                      <span className="mem-conf">{formatConfidence(f.confidence)}</span>
                      <button
                        className="mem-del"
                        onClick={() => handleDeleteFact(f.id)}
                        aria-label="删除这条记忆"
                        title="删除"
                      >
                        ✕
                      </button>
                    </div>
                    {/* 出处：这条记忆从哪一轮、哪句原话提炼而来。看得见出处，才能判断提炼有没有失真 */}
                    {(f.quote || (f.turn !== null && f.turn !== undefined)) && (
                      <div className="mem-src">
                        {f.turn !== null && f.turn !== undefined && (
                          <span className="mem-src-turn">第 {f.turn + 1} 条</span>
                        )}
                        {f.quote ? <span className="mem-src-quote">原话：「{f.quote}」</span> : null}
                      </div>
                    )}
                    {editKwFactId === f.id ? (
                      <div className="mem-kw-edit">
                        {(kwDraft || []).map((k, i) => (
                          <span key={`${k}-${i}`} className="mem-kw-chip">
                            {k}
                            <button onClick={() => removeKw(k)} aria-label="移除关键词">
                              ×
                            </button>
                          </span>
                        ))}
                        <input
                          className="mem-kw-input"
                          placeholder="+ 添加关键词"
                          value={kwInput}
                          onChange={(e) => setKwInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                              e.preventDefault()
                              addKw()
                            }
                          }}
                        />
                        <button className="btn btn-ghost btn-sm" onClick={saveKw}>
                          保存
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditKwFactId(null)}>
                          取消
                        </button>
                      </div>
                    ) : (
                      <div className="mem-kw-row">
                        {(f.keywords || []).map((k) => (
                          <span key={k} className="mem-kw-chip">
                            {k}
                          </span>
                        ))}
                        <button
                          className="mem-kw-edit-btn"
                          onClick={() => startKwEdit(f)}
                          title="编辑关键词"
                          aria-label="编辑关键词"
                        >
                          ✎
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="rebuild-box">
              <input
                ref={rebuildFileRef}
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={handleRebuildFile}
              />
              {rebuildState?.running ? (
                <p className="rebuild-progress">
                  正在重建记忆… 第 {rebuildState.done}/{rebuildState.total} 段（已新增{' '}
                  {rebuildState.added} 条），请稍候，不要关闭页面。
                </p>
              ) : rebuildConfirm ? (
                <>
                  <p className="rebuild-progress">
                    {rebuildConfirm.source === 'current' ? '当前对话里' : '备份里'}有{' '}
                    {rebuildConfirm.pairs} 对对话，预计调用 {rebuildConfirm.chunks}{' '}
                    次模型接口（每 8 轮一次）。这会消耗少量 API 额度。
                  </p>
                  <p className="rebuild-progress">
                    <strong>这是追加，不是重置</strong>：现在有 {memory.facts.length} 条事实，
                    重建后的新记忆会加在这 {memory.facts.length} 条之上，现有记忆不会被删除。
                    如果同一件事这次提炼出的说法和旧的相似，会更新那一条而不是新建
                    （出处跟着刷新为这次的原话）；说法差得较多时才会变成新条目 ——
                    重复重建几遍可能攒下近似重复，之后可以在「重复事实整理」里合并。
                  </p>
                  {memory.facts.length > 0 && (
                    <p className="rebuild-progress">
                      想从零开始就先在下面「清空全部记忆」，再重建。
                    </p>
                  )}
                  <div className="modal-actions">
                    <button
                      className="btn btn-ghost"
                      onClick={() => setRebuildConfirm(null)}
                    >
                      取消
                    </button>
                    <button className="btn btn-heart" onClick={startRebuild}>
                      开始重建
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="rebuild-progress">
                    把完整对话重新提炼成记忆（每 8 轮调用一次模型，失败自动重试）。
                  </p>
                  <button
                    type="button"
                    className="btn btn-heart btn-sm"
                    onClick={handleDirectRebuild}
                  >
                    直接重建当前对话
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => rebuildFileRef.current?.click()}
                  >
                    从备份重建记忆
                  </button>
                </>
              )}
              {rebuildResult && <p className="rebuild-result">{rebuildResult}</p>}
              <div className="rebuild-divider" />
              {backfillState?.running ? (
                <p className="rebuild-progress">
                  正在智能补全关键词… 第 {backfillState.done}/{backfillState.total} 批（已更新{' '}
                  {backfillState.updated} 条），请稍候。
                </p>
              ) : (
                <button type="button" className="btn btn-ghost btn-sm" onClick={startBackfill}>
                  ✨ 智能补全关键词
                </button>
              )}
              {backfillResult && <p className="rebuild-result">{backfillResult}</p>}
            </div>

            <details className="mem-partitions" style={{ marginTop: 12 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13 }}>
                记忆分区总览（{partitions.length} 个人格有独立记忆）
              </summary>
              <p className="muted" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.7 }}>
                长期记忆按人格分开存放。若某个分区里出现了别的角色的剧情，说明它是早期版本写入的，
                可以只清掉那一个，不影响其他角色。
              </p>
              {partitions.length === 0 ? (
                <p className="muted" style={{ fontSize: 12 }}>还没有任何分区的记忆。</p>
              ) : (
                partitions.map((p) => {
                  const preset = PERSONALITIES.find((x) => x.id === p.personalityId)
                  const isCurrent = p.personalityId === session.personalityId
                  return (
                    <div
                      key={p.personalityId}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 0',
                        borderTop: '1px solid rgba(255,255,255,0.06)'
                      }}
                    >
                      <span style={{ fontSize: 12, minWidth: 96 }}>
                        {preset ? `${preset.emoji} ${preset.name}` : p.personalityId}
                        {isCurrent && <span className="muted"> · 当前</span>}
                      </span>
                      <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                        {p.facts} 事实 · {p.summaries} 摘要
                      </span>
                      <span
                        className="muted"
                        style={{
                          fontSize: 11,
                          flex: 1,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}
                        title={p.sample.join(' / ')}
                      >
                        {p.sample.join(' / ') || '（空）'}
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => handleExportPersona(p.personalityId)}
                        title="把这个角色的长期记忆单独存成一个文件"
                      >
                        导出
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => handleClearPartition(p.personalityId)}
                      >
                        清空此分区
                      </button>
                    </div>
                  )
                })
              )}
              {legacyLeft && (
                <p className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.7 }}>
                  检测到早期版本遗留的全局记忆（内容已迁移过，不会再被读取）。
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ marginLeft: 8 }}
                    onClick={handleDropLegacy}
                  >
                    删除遗留副本
                  </button>
                </p>
              )}

              {/* 单人格导入：文件只装一个角色的记忆，导入时不碰会话、不碰别的分区 */}
              <div className="mem-persona-io">
                <div className="mem-tidy-head">
                  <span className="rail-title" style={{ margin: 0 }}>
                    按角色导入记忆
                  </span>
                </div>
                <p className="muted" style={{ fontSize: 12, margin: '6px 0 0', lineHeight: 1.7 }}>
                  上面每个人的「导出」存的是单个角色的记忆，导入时只写那一个分区，
                  不会动你的对话记录，也不会影响其他角色。
                </p>
                <div className="mem-persona-row">
                  <select
                    className="mem-select"
                    value={personaTarget}
                    onChange={(e) => setPersonaTarget(e.target.value)}
                  >
                    <option value="">选择要把记忆给谁…</option>
                    {PERSONALITIES.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.emoji} {x.name}
                        {x.id === session.personalityId ? '（当前）' : ''}
                      </option>
                    ))}
                  </select>
                  <label className="mem-radio">
                    <input
                      type="radio"
                      name="persona-mode"
                      checked={personaMode === 'replace'}
                      onChange={() => setPersonaMode('replace')}
                    />
                    <span>替换</span>
                  </label>
                  <label className="mem-radio">
                    <input
                      type="radio"
                      name="persona-mode"
                      checked={personaMode === 'merge'}
                      onChange={() => setPersonaMode('merge')}
                    />
                    <span>并入现有记忆</span>
                  </label>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => personaFileRef.current?.click()}
                  >
                    选择记忆文件导入
                  </button>
                  <input
                    ref={personaFileRef}
                    type="file"
                    accept=".json,application/json"
                    onChange={handlePersonaFile}
                    style={{ display: 'none' }}
                  />
                </div>
                {personaMsg && (
                  <div
                    className={`test-result ${personaMsg.type === 'error' ? 'error' : 'success'}`}
                  >
                    <span>{personaMsg.type === 'error' ? '✕' : '✓'}</span>
                    <span>{personaMsg.text}</span>
                  </div>
                )}
              </div>
            </details>

            <div className="modal-actions">
              <button
                className="btn btn-ghost"
                onClick={handleClearMemory}
                disabled={Boolean(rebuildState?.running)}
              >
                {memoryDeleteConfirm ? '确认删除该人格的全部记忆' : '清空全部记忆'}
              </button>
              <button className="btn btn-ghost" onClick={() => setMemModal(false)}>
                完成
              </button>
            </div>
          </div>
        </div>
      )}

      {clearModal && (
        <div className="modal-overlay" onClick={() => setClearModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setClearModal(false)} aria-label="关闭">
              ✕
            </button>
            <h3>清空对话？</h3>
            <p>
              将删除当前对话的聊天记录并重置情绪。其他对话会保留，此操作无法撤销。
            </p>
            <label className="check-row"><input type="checkbox" checked={clearMemoryToo} onChange={e => setClearMemoryToo(e.target.checked)} />同时删除这个人格的全部长期记忆（会影响同人格的其他对话）</label>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setClearModal(false)}>
                取消
              </button>
              <button className="btn btn-heart" onClick={handleClear}>
                清空对话
              </button>
            </div>
            <div className="rebuild-divider" />
            <p className="muted" style={{ fontSize: 13 }}>
              需要连同长期记忆与本地设置一起清除？
            </p>
            <button
              className="btn btn-ghost"
              style={{ width: '100%' }}
              onClick={() => wipeConfirm ? handleWipeAll() : setWipeConfirm(true)}
            >
              {wipeConfirm ? '确认永久删除全部会话、记忆和本地设置' : '彻底清除全部本地数据（对话 + 记忆 + 本地设置）'}
            </button>
          </div>
        </div>
      )}

      {promptOpen && (
        <div className="modal-overlay" onClick={() => setPromptOpen(false)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setPromptOpen(false)} aria-label="关闭">
              ✕
            </button>
            <h3>🔍 本轮提示词</h3>
            {!promptDebug ? (
              <p className="muted" style={{ fontSize: 13 }}>
                还没有记录。先发一句话，这里会显示那一轮**实际**发给模型的全部内容。
              </p>
            ) : (
              <>
                <p className="muted" style={{ fontSize: 13, lineHeight: 1.7 }}>
                  {promptDebug.personalityName}（{promptDebug.personalityId}） · 模型 {promptDebug.model} ·
                  思考 {promptDebug.thinkingMode} · 亲密模式{promptDebug.adultOn ? '开' : '关'} ·{' '}
                  {promptDebug.firstMeeting ? '初见态' : '已认识'} · 你演
                  {promptDebug.userGender === 'male' ? '男生' : '女生'} · 经验
                  {promptDebug.experience === 'first' ? '第一次' : '不限制'}
                  {promptDebug.userStop ? ' · 本轮检测到喊停' : ''}
                  <br />
                  共 {promptDebug.apiMessages.length} 条消息 / 约 {promptDebug.totalChars.toLocaleString()} 字
                </p>
                <div className="prompt-debug-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      navigator.clipboard
                        ?.writeText(
                          promptDebug.apiMessages
                            .map((m) => `===== ${m.role} =====\n${m.content}`)
                            .join('\n\n')
                        )
                        .then(() => setPromptOpen(true))
                        .catch(() => {})
                    }}
                  >
                    复制全部
                  </button>
                  <span className="muted" style={{ fontSize: 12 }}>
                    从上到下就是模型实际收到的顺序：system → 历史 → 本轮输入
                  </span>
                </div>
                <div className="prompt-debug">
                  {promptDebug.apiMessages.map((m, i) => (
                    <details key={i} open={m.role === 'system' || i === promptDebug.apiMessages.length - 1}>
                      <summary>
                        <span className={`pd-role pd-${m.role}`}>{m.role}</span>
                        <span className="muted" style={{ fontSize: 12 }}>
                          {String(m.content || '').length.toLocaleString()} 字
                          {m.role === 'system' ? ' · 完整系统提示词' : ''}
                          {i === promptDebug.apiMessages.length - 1 ? ' · 你刚发的这句' : ''}
                        </span>
                      </summary>
                      <pre>{m.content}</pre>
                    </details>
                  ))}
                </div>
                <details className="prompt-debug-extra">
                  <summary>本轮其它输入（情绪数值 / 记忆 / 档案）</summary>
                  <pre>
                    {JSON.stringify(
                      {
                        情绪数值: promptDebug.emotion,
                        长期档案: promptDebug.profile,
                        注入的记忆: promptDebug.memories,
                        人格参数: promptDebug.traits
                      },
                      null,
                      2
                    )}
                  </pre>
                </details>
              </>
            )}
          </div>
        </div>
      )}

      {cryptoModal && (
        <div className="modal-overlay" onClick={() => setCryptoModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setCryptoModal(null)} aria-label="关闭">
              ✕
            </button>
            {cryptoModal.mode === 'enable' ? (
              <>
                <h3>开启本地加密</h3>
                <p>对话和长期记忆会以密文保存在本机，之后每次打开都需要输入口令。</p>
                <p className="muted" style={{ fontSize: 13 }}>
                  口令不会存储、不会上传；忘记口令将无法找回数据，只能清除。请设置你绝不会忘的口令。
                </p>
                <div className="field">
                  <label>设置口令（至少 6 位）</label>
                  <input
                    className="input"
                    type="password"
                    value={cryptoPass}
                    onChange={(e) => {
                      setCryptoPass(e.target.value)
                      setCryptoError(null)
                    }}
                  />
                </div>
                <div className="field">
                  <label>再次输入确认</label>
                  <input
                    className="input"
                    type="password"
                    value={cryptoPass2}
                    onChange={(e) => {
                      setCryptoPass2(e.target.value)
                      setCryptoError(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) submitCrypto()
                    }}
                  />
                </div>
              </>
            ) : (
              <>
                <h3>关闭本地加密</h3>
                <p>关闭后数据会恢复为明文保存。输入口令确认这是你本人的操作。</p>
                <div className="field">
                  <label>当前口令</label>
                  <input
                    className="input"
                    type="password"
                    value={cryptoPass}
                    onChange={(e) => {
                      setCryptoPass(e.target.value)
                      setCryptoError(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) submitCrypto()
                    }}
                  />
                </div>
              </>
            )}
            {cryptoError && (
              <div className="test-result error">
                <span>✕</span>
                <span>{cryptoError}</span>
              </div>
            )}
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setCryptoModal(null)}>
                取消
              </button>
              <button className="btn btn-heart" onClick={submitCrypto}>
                {cryptoModal.mode === 'enable' ? '开启加密' : '关闭加密'}
              </button>
            </div>
          </div>
        </div>
      )}

      {backupModal && (
        <BackupModal
          session={session}
          config={config}
          onClose={() => setBackupModal(false)}
          onImportSession={handleImportSession}
          onImportConfig={handleImportConfig}
          onImported={handleImported}
        />
      )}
    </div>
  )
}
