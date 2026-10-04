import { STORAGE_KEYS } from './constants.js'
import { isCryptoEnabled, isUnlocked, readSecure, writeSecure } from './crypto.js'
import {
  cancelAllMemoryTasks,
  exportAllPartitions,
  loadMemory,
  partitionKeyOf,
  sanitizeMemory,
  setMemoryScope
} from './memory.js'

export const CONVERSATIONS_KEY = 'xingyu.conversations.v1'
const MEMORY_PREFIX = `${STORAGE_KEYS.memory}::`
const now = () => Date.now()
const newId = () => `c-${globalThis.crypto?.randomUUID?.() || `${now().toString(36)}-${Math.random().toString(36).slice(2)}`}`

function requireUnlocked() {
  if (isCryptoEnabled() && !isUnlocked()) throw new Error('本地数据已锁定，请先解锁')
}

function loadJSONFrom(store, key) {
  try {
    const raw = store.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value))
}

// Only non-secret preferences cross the browser storage/backup boundary.
export function sanitizeConfig(config = {}) {
  return {
    connectionMode: 'server',
    ...(typeof config.model === 'string' ? { model: config.model } : {}),
    ...(typeof config.thinkingMode === 'string' ? { thinkingMode: config.thinkingMode } : {}),
    ready: config.connectionMode === 'server' && config.ready === true
  }
}

export function loadConfig(fallback) {
  const raw = readSecure(STORAGE_KEYS.config)
  if (raw) {
    try { return { ...fallback, ...sanitizeConfig(JSON.parse(raw)) } } catch { /* damaged config */ }
  }
  const config = loadJSONFrom(sessionStorage, STORAGE_KEYS.configSession)
  return config && typeof config === 'object' ? { ...fallback, ...sanitizeConfig(config) } : fallback
}

export function saveConfig(config) {
  requireUnlocked()
  writeSecure(STORAGE_KEYS.config, JSON.stringify(sanitizeConfig(config)))
  sessionStorage.removeItem(STORAGE_KEYS.configSession)
}

function keysWithPrefix(prefix) {
  const keys = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(prefix)) keys.push(key)
  }
  return keys
}

export function clearAllData() {
  cancelAllMemoryTasks()
  for (const key of [
    STORAGE_KEYS.config, STORAGE_KEYS.session, CONVERSATIONS_KEY,
    STORAGE_KEYS.memory, STORAGE_KEYS.memoryMigrated, STORAGE_KEYS.crypto,
    ...keysWithPrefix(MEMORY_PREFIX)
  ]) localStorage.removeItem(key)
  sessionStorage.removeItem(STORAGE_KEYS.configSession)
}

export function normalizeUsage(session) {
  const usage = session?.usage
  const messages = Array.isArray(session?.messages) ? session.messages : []
  const billed = messages.filter(m => m?.role === 'assistant' && !m.pending && !m.local && m.usage)
  if (billed.length) return billed.reduce((total, message) => {
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'reasoning_tokens']) {
      const value = Number(message.usage[key])
      if (Number.isFinite(value)) total[key] += Math.max(0, value)
    }
    total.turns++
    return total
  }, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, reasoning_tokens: 0, turns: 0 })
  if (!usage || typeof usage !== 'object') return null
  const actual = messages.filter(m => m?.role === 'assistant' && !m.pending && !m.local && m.status !== 'failed' && m.status !== 'stopped' && m.content).length
  return actual > 0 && Number(usage.turns) === actual ? usage : null
}

function sessionWithMetadata(session, previous = null, title = undefined) {
  const stamp = now()
  const source = session && typeof session === 'object' ? session : {}
  return {
    ...source,
    id: typeof source.id === 'string' && source.id ? source.id : previous?.id || newId(),
    title: String(title ?? source.title ?? previous?.title ?? '新对话').trim() || '新对话',
    createdAt: Number.isFinite(Number(source.createdAt)) ? Number(source.createdAt) : previous?.createdAt || stamp,
    updatedAt: stamp,
    messages: Array.isArray(source.messages) ? source.messages : [],
    draft: typeof source.draft === 'string' ? source.draft : '',
    draftAttachments: Array.isArray(source.draftAttachments) ? source.draftAttachments : []
  }
}

// Reloaded requests cannot resume, but their saved partial text remains usable.
function recoverInterruptedSession(session) {
  return {
    ...session,
    messages: (session.messages || []).map(message => message.pending ? {
      ...message, pending: false, status: 'stopped', error: '上次生成已中断，可重新生成'
    } : message)
  }
}

function readVault() {
  requireUnlocked()
  const raw = readSecure(CONVERSATIONS_KEY)
  if (!raw) {
    if (localStorage.getItem(CONVERSATIONS_KEY) !== null) throw new Error('会话仓库无法读取，已阻止覆盖，请先解锁或恢复备份')
    return null
  }
  let vault
  try { vault = JSON.parse(raw) } catch { throw new Error('会话仓库损坏，请先导出或恢复备份') }
  if (vault?.version !== 1 || !Array.isArray(vault.conversations) || typeof vault.activeId !== 'string') {
    throw new Error('会话仓库格式不正确')
  }
  return vault
}

function legacyVault() {
  const raw = readSecure(STORAGE_KEYS.session)
  if (!raw) return { version: 1, activeId: '', conversations: [] }
  try {
    const original = JSON.parse(raw)
    const session = sessionWithMetadata({ ...original, id: original.id || 'legacy-session' })
    session.usage = normalizeUsage(session)
    return { version: 1, activeId: session.id, conversations: [session] }
  } catch {
    throw new Error('旧会话存档损坏，请先恢复备份')
  }
}

function currentVault() {
  return readVault() || legacyVault()
}

function commitVault(vault) {
  requireUnlocked()
  const prior = localStorage.getItem(CONVERSATIONS_KEY)
  try {
    writeSecure(CONVERSATIONS_KEY, JSON.stringify(vault))
    // Legacy is removed only after the complete new vault has been persisted.
    localStorage.removeItem(STORAGE_KEYS.session)
  } catch (error) {
    localStorage.removeItem(CONVERSATIONS_KEY)
    if (prior !== null) localStorage.setItem(CONVERSATIONS_KEY, prior)
    throw error
  }
}

export function listConversations() {
  try {
    return currentVault().conversations.map(s => ({ ...s, messages: [...s.messages] }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

export function loadSession(fallback) {
  try {
    const vault = currentVault()
    const session = vault.conversations.find(s => s.id === vault.activeId) || vault.conversations[0]
    if (!session) return sessionWithMetadata(fallback)
    const recovered = recoverInterruptedSession(session)
    const out = { ...fallback, ...recovered, usage: normalizeUsage(recovered) }
    setMemoryScope(out.personalityId)
    return out
  } catch {
    return sessionWithMetadata(fallback)
  }
}

// Kept for older callers, but never used to alter or discard persisted messages.
export function fitMessagesToBudget(messages) { return { messages, trimmed: 0 } }
export function trimSessionToBudget(session) { return { session, trimmed: 0 } }

export function saveSessionSafe(session) {
  const candidate = sessionWithMetadata(session)
  try {
    const vault = currentVault()
    const index = vault.conversations.findIndex(s => s.id === candidate.id)
    if (index >= 0) vault.conversations[index] = candidate
    else vault.conversations.push(candidate)
    vault.activeId = candidate.id
    commitVault(vault)
    return { saved: true, session: candidate, trimmed: 0 }
  } catch (error) {
    return { saved: false, session: candidate, trimmed: 0, error: error?.message || String(error) }
  }
}

export function createConversation(session, title = '新对话') {
  const vault = currentVault()
  const created = sessionWithMetadata({ ...session, id: newId(), createdAt: now() }, null, title)
  vault.conversations.push(created)
  vault.activeId = created.id
  commitVault(vault)
  setMemoryScope(created.personalityId)
  return created
}

export function activateConversation(id, fallback) {
  const vault = currentVault()
  const found = vault.conversations.find(s => s.id === id)
  if (!found) throw new Error('找不到这段对话')
  const recovered = recoverInterruptedSession(found)
  vault.conversations = vault.conversations.map(s => s.id === id ? recovered : s)
  vault.activeId = found.id
  commitVault(vault)
  const session = { ...fallback, ...recovered, usage: normalizeUsage(recovered) }
  setMemoryScope(session.personalityId)
  return session
}

export function renameConversation(id, title) {
  const vault = currentVault()
  const found = vault.conversations.find(s => s.id === id)
  if (!found) throw new Error('找不到这段对话')
  if (!String(title || '').trim()) throw new Error('对话名称不能为空')
  found.title = String(title).trim()
  found.updatedAt = now()
  commitVault(vault)
  return found
}

export function deleteConversation(id) {
  const vault = currentVault()
  const index = vault.conversations.findIndex(s => s.id === id)
  if (index < 0) return false
  vault.conversations.splice(index, 1)
  if (vault.activeId === id) vault.activeId = vault.conversations[0]?.id || ''
  commitVault(vault)
  return true
}

function clampNum(v, min, max, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

function sanitizeEmotion(e) {
  const base = { aff: 20, sec: 30, aro: 10, dom: -5 }
  const out = {}
  for (const k of Object.keys(base)) out[k] = clampNum(e?.[k], -100, 100, base[k])
  return out
}

function sanitizeAttachments(value) {
  if (!Array.isArray(value)) return []
  if (value.length > 3) throw new Error('单条消息最多支持 3 张图片')
  return value.map(a => {
    if (!a || typeof a !== 'object' || typeof a.dataUrl !== 'string' ||
        !/^data:image\/(?:jpeg|png|webp);base64,/i.test(a.dataUrl) || a.dataUrl.length > 420000) {
      throw new Error('备份包含无效或过大的图片')
    }
    return {
      id: typeof a.id === 'string' ? a.id : newId(),
      name: typeof a.name === 'string' ? a.name : '',
      type: typeof a.type === 'string' ? a.type : '',
      dataUrl: a.dataUrl,
      width: clampNum(a.width, 0, 10000, 0),
      height: clampNum(a.height, 0, 10000, 0)
    }
  })
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) throw new Error('备份文件里没有聊天记录（messages 缺失）')
  return messages.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({
      id: typeof m.id === 'string' && m.id ? m.id : newId(),
      role: m.role,
      content: m.content,
      ...(typeof m.status === 'string' && ['completed', 'stopped', 'failed'].includes(m.status) ? { status: m.status } : {}),
      pending: Boolean(m.pending),
      local: Boolean(m.local),
      sensitive: Boolean(m.sensitive),
      starred: Boolean(m.starred),
      ...(typeof m.error === 'string' ? { error: m.error } : {}),
      ...(typeof m.reasoning === 'string' ? { reasoning: m.reasoning } : {}),
      ...(Number.isFinite(Number(m.createdAt)) ? { createdAt: Number(m.createdAt) } : {}),
      ...(m.usage && typeof m.usage === 'object' ? { usage: m.usage } : {}),
      attachments: sanitizeAttachments(m.attachments)
    }))
}

function sanitizeOverride(value) {
  if (!value || typeof value !== 'object') return null
  const out = {}
  if (value.traits && typeof value.traits === 'object') {
    out.traits = {}
    for (const k of ['T', 'I', 'O', 'S', 'R']) out.traits[k] = clampNum(value.traits[k], 0, 100, 50)
  }
  if (value.baseline && typeof value.baseline === 'object') {
    out.baseline = {}
    for (const k of ['aff', 'sec', 'aro', 'dom']) out.baseline[k] = clampNum(value.baseline[k], -100, 100, 0)
  }
  return Object.keys(out).length ? out : null
}

function sanitizeSession(s) {
  if (!s || typeof s !== 'object') throw new Error('备份文件里没有会话数据')
  if (s.avatar && (typeof s.avatar !== 'string' || !/^data:image\/jpeg;base64,/i.test(s.avatar) || s.avatar.length > 180000)) {
    throw new Error('角色图片格式无效或过大')
  }
  const session = sessionWithMetadata({
    id: s.id,
    title: typeof s.title === 'string' ? s.title : '导入的对话',
    createdAt: s.createdAt,
    personalityId: typeof s.personalityId === 'string' ? s.personalityId : 'boy_next_door',
    adultOn: Boolean(s.adultOn),
    ageConfirmed: Boolean(s.ageConfirmed),
    userGender: s.userGender === 'male' ? 'male' : 'female',
    override: sanitizeOverride(s.override),
    emotion: sanitizeEmotion(s.emotion),
    messages: sanitizeMessages(s.messages),
    usage: s.usage && typeof s.usage === 'object' ? s.usage : null,
    draft: typeof s.draft === 'string' ? s.draft : '',
    draftAttachments: sanitizeAttachments(s.draftAttachments),
    ...(s.avatar ? { avatar: s.avatar } : {}),
    ...(s.experience === 'first' || s.experience === 'free' ? { experience: s.experience } : {}),
    ...(typeof s.forkedFrom === 'string' ? { forkedFrom: s.forkedFrom } : {}),
    ...(typeof s.seeded === 'boolean' ? { seeded: s.seeded } : {})
  })
  if (Number.isFinite(Number(s.updatedAt))) session.updatedAt = Number(s.updatedAt)
  return recoverInterruptedSession(session)
}

export function buildBackup({ session, config, includeConfig = false }) {
  requireUnlocked()
  const vault = currentVault()
  const conversations = [...vault.conversations]
  if (session) {
    const index = conversations.findIndex(s => s.id === session.id)
    if (index >= 0) conversations[index] = sessionWithMetadata(session)
    else conversations.push(sessionWithMetadata(session))
  }
  const active = conversations.find(s => s.id === session?.id) || conversations.find(s => s.id === vault.activeId) || conversations[0]
  const byPartition = exportAllPartitions()
  const headPid = active?.personalityId ? partitionKeyOf(active.personalityId) : ''
  if (headPid && !byPartition[headPid]) {
    const legacy = readSecure(STORAGE_KEYS.memory)
    if (legacy) {
      try { byPartition[headPid] = sanitizeMemory(JSON.parse(legacy)) } catch { /* corrupt legacy memory */ }
    }
  }
  const payload = {
    app: 'xingyu', appName: '星语 StarVox', version: 4, exportedAt: new Date().toISOString(),
    activeId: active?.id || '', conversations, session: active,
    memory: byPartition[headPid] ?? (active ? loadMemory(active.personalityId) : null),
    memoryByPartition: byPartition
  }
  if (includeConfig && config) payload.config = sanitizeConfig(config)
  return JSON.stringify(payload, null, 2)
}

export function parseBackup(text) {
  let data
  try { data = JSON.parse(text) } catch { return { ok: false, reason: '文件不是有效的 JSON，可能已损坏' } }
  if (!data || typeof data !== 'object') return { ok: false, reason: '备份文件格式不正确' }
  try {
    const rawSessions = Array.isArray(data.conversations) && data.conversations.length ? data.conversations : [data.session]
    const conversations = rawSessions.map(sanitizeSession)
    const ids = new Set()
    for (const s of conversations) {
      if (ids.has(s.id)) s.id = newId()
      ids.add(s.id)
    }
    const session = conversations.find(s => s.id === data.activeId) || conversations[0]
    let memoryByPartition = null
    if (data.memoryByPartition && typeof data.memoryByPartition === 'object') {
      memoryByPartition = {}
      for (const [pid, raw] of Object.entries(data.memoryByPartition)) {
        if (pid && pid !== '__migrated__') memoryByPartition[partitionKeyOf(pid)] = sanitizeMemory(raw)
      }
    } else if (data.memory) {
      memoryByPartition = { [partitionKeyOf(session.personalityId)]: sanitizeMemory(data.memory) }
    }
    const config = data.config && typeof data.config === 'object' ? sanitizeConfig(data.config) : null
    return {
      ok: true, session, conversations, activeId: session.id, config,
      memory: memoryByPartition?.[partitionKeyOf(session.personalityId)] || null,
      memoryByPartition, partitionCount: Object.keys(memoryByPartition || {}).length, trimmed: 0
    }
  } catch (error) {
    return { ok: false, reason: error?.message || '备份文件格式不正确' }
  }
}

// All affected raw values are restored if any write fails. A backup preview never calls this.
export function restoreBackup(parsed, { includeConfig = true } = {}) {
  if (!parsed?.ok) throw new Error(parsed?.reason || '备份文件无效')
  requireUnlocked()
  cancelAllMemoryTasks()
  const localKeys = new Set([
    CONVERSATIONS_KEY, STORAGE_KEYS.session, STORAGE_KEYS.memory,
    STORAGE_KEYS.memoryMigrated, STORAGE_KEYS.config, ...keysWithPrefix(MEMORY_PREFIX),
    ...Object.keys(parsed.memoryByPartition || {}).map(pid => `${MEMORY_PREFIX}${partitionKeyOf(pid)}`)
  ])
  const beforeLocal = new Map([...localKeys].map(k => [k, localStorage.getItem(k)]))
  const beforeSession = sessionStorage.getItem(STORAGE_KEYS.configSession)
  const vault = { version: 1, activeId: parsed.activeId, conversations: parsed.conversations }
  try {
    writeSecure(CONVERSATIONS_KEY, JSON.stringify(vault))
    for (const [pid, memory] of Object.entries(parsed.memoryByPartition || {})) {
      writeSecure(`${MEMORY_PREFIX}${partitionKeyOf(pid)}`, JSON.stringify(memory))
    }
    if (includeConfig && parsed.config) saveConfig(parsed.config)
    localStorage.removeItem(STORAGE_KEYS.session)
    return {
      session: parsed.session,
      conversations: parsed.conversations.length,
      partitions: Object.keys(parsed.memoryByPartition || {}).length,
      facts: Object.values(parsed.memoryByPartition || {}).reduce((n, mem) => n + (mem.facts?.length || 0), 0)
    }
  } catch (error) {
    for (const k of localKeys) localStorage.removeItem(k)
    for (const [k, raw] of beforeLocal) if (raw !== null) localStorage.setItem(k, raw)
    if (beforeSession === null) sessionStorage.removeItem(STORAGE_KEYS.configSession)
    else sessionStorage.setItem(STORAGE_KEYS.configSession, beforeSession)
    throw error
  }
}
