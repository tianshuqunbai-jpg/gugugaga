import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

function memoryStore() {
  const values = new Map()
  let fail = null
  return {
    values,
    failNext(key) { fail = key },
    getItem(key) { return values.get(key) ?? null },
    setItem(key, value) {
      if (fail === key) { fail = null; throw new Error('quota') }
      values.set(key, String(value))
    },
    removeItem(key) { values.delete(key) },
    key(index) { return [...values.keys()][index] ?? null },
    get length() { return values.size },
    clear() { values.clear(); fail = null }
  }
}

globalThis.localStorage = memoryStore()
globalThis.sessionStorage = memoryStore()
globalThis.window = { dispatchEvent() {} }
globalThis.CustomEvent = class { constructor(name) { this.type = name } }

const crypt = await import('../src/lib/crypto.js')
const { STORAGE_KEYS } = await import('../src/lib/constants.js')
const context = vm.createContext({
  localStorage, sessionStorage, crypto: globalThis.crypto,
  Date, Math, JSON, Number, Object, Array, String, Error, Boolean
})
const source = await readFile(new URL('../src/lib/storage.js', import.meta.url), 'utf8')
const entry = new vm.SourceTextModule(source, { context, identifier: 'storage.js' })
const stubs = {
  './constants.js': { STORAGE_KEYS },
  './crypto.js': crypt,
  './memory.js': {
    cancelAllMemoryTasks() {},
    exportAllPartitions() { return {} },
    loadMemory() { return { facts: [], summaries: [], causalLinks: [] } },
    partitionKeyOf(id) { return String(id || '') },
    sanitizeMemory(mem) { return { version: 3, facts: mem.facts || [], summaries: mem.summaries || [], causalLinks: mem.causalLinks || [] } },
    setMemoryScope() {}
  }
}
await entry.link(async (specifier) => {
  const exports = stubs[specifier]
  assert.ok(exports, `missing stub ${specifier}`)
  return new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
  }, { context })
})
await entry.evaluate()
const storage = entry.namespace

const sample = (content = '你好') => ({
  personalityId: 'boy_next_door', emotion: { aff: 20, sec: 30, aro: 10, dom: -5 },
  messages: [{ id: 'm1', role: 'user', content, status: 'completed', starred: true, createdAt: 10 }],
  draft: '未发送', draftAttachments: []
})

function reset() {
  crypt.lockCrypto()
  localStorage.clear()
  sessionStorage.clear()
}

test('legacy session is retained until complete vault write succeeds', () => {
  reset()
  const legacy = JSON.stringify(sample('旧消息'))
  localStorage.setItem(STORAGE_KEYS.session, legacy)
  const loaded = storage.loadSession(sample())
  assert.ok(loaded.id)
  localStorage.failNext(storage.CONVERSATIONS_KEY)
  const failed = storage.saveSessionSafe({ ...loaded, messages: [...loaded.messages, { id: 'm2', role: 'user', content: '新消息' }] })
  assert.equal(failed.saved, false)
  assert.equal(failed.trimmed, 0)
  assert.equal(failed.session.messages.length, 2)
  assert.equal(localStorage.getItem(STORAGE_KEYS.session), legacy)
  assert.equal(localStorage.getItem(storage.CONVERSATIONS_KEY), null)
  assert.equal(storage.saveSessionSafe(failed.session).saved, true)
  assert.equal(localStorage.getItem(STORAGE_KEYS.session), null)
  assert.equal(storage.listConversations().length, 1, 'legacy migration must not duplicate the session')
})

test('conversation create, switch, rename and delete retain full messages and drafts', () => {
  reset()
  const first = storage.createConversation(sample('银河'), '初见')
  const second = storage.createConversation(sample('星空'), '续篇')
  assert.notEqual(first.id, second.id)
  assert.equal(storage.listConversations().length, 2)
  assert.equal(storage.listConversations().find(s => s.id === first.id).messages[0].content, '银河')
  assert.equal(storage.activateConversation(first.id, {}).draft, '未发送')
  assert.equal(storage.loadSession({}).id, first.id)
  storage.renameConversation(first.id, '银河故事')
  assert.equal(storage.listConversations().find(s => s.id === first.id).title, '银河故事')
  assert.equal(storage.deleteConversation(second.id), true)
  assert.equal(storage.listConversations().length, 1)
})

test('crypto enable rollback, locked writes and round trip protect vault', () => {
  reset()
  const first = storage.createConversation(sample(), '加密对话')
  localStorage.failNext(STORAGE_KEYS.crypto)
  assert.throws(() => crypt.enableCrypto('password'), /quota/)
  assert.equal(crypt.isCryptoEnabled(), false)
  assert.equal(JSON.parse(localStorage.getItem(storage.CONVERSATIONS_KEY)).conversations[0].id, first.id)
  crypt.enableCrypto('password')
  assert.equal(localStorage.getItem(storage.CONVERSATIONS_KEY).includes('加密对话'), false)
  crypt.lockCrypto()
  assert.throws(() => crypt.writeSecure(STORAGE_KEYS.memory, '{}'), /锁定/)
  assert.equal(storage.saveSessionSafe(sample()).saved, false)
  assert.equal(storage.listConversations().length, 0)
  assert.equal(crypt.unlockCrypto('password'), true)
  assert.equal(storage.listConversations()[0].id, first.id)
  assert.equal(crypt.disableCrypto('wrong-password'), false)
  assert.equal(crypt.isUnlocked(), true, 'wrong disable password must preserve the unlocked key')
  assert.equal(crypt.disableCrypto('password'), true)
  assert.equal(JSON.parse(localStorage.getItem(storage.CONVERSATIONS_KEY)).conversations[0].id, first.id)
})

test('backup preview is pure and recovery rolls back quota failure', () => {
  reset()
  const a = storage.createConversation(sample('A'), 'A')
  const b = storage.createConversation(sample('B'), 'B')
  const beforeVault = localStorage.getItem(storage.CONVERSATIONS_KEY)
  const beforeKeys = [...localStorage.values.keys()]
  const raw = storage.buildBackup({ session: a, config: { apiKey: 'synthetic', rememberKey: true }, includeConfig: true })
  assert.equal(raw.includes('synthetic'), false, 'backup must never export a credential')
  const parsed = storage.parseBackup(raw)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.conversations.length, 2)
  assert.equal(parsed.session.id, a.id)
  assert.equal(parsed.session.messages[0].starred, true)
  assert.equal(localStorage.getItem(storage.CONVERSATIONS_KEY), beforeVault)
  assert.deepEqual([...localStorage.values.keys()], beforeKeys)
  const changed = structuredClone(parsed)
  changed.conversations[0].title = '恢复后的标题'
  changed.memoryByPartition = { boy_next_door: { facts: [{ text: '合成事实' }], summaries: [], causalLinks: [] } }
  localStorage.failNext(`${STORAGE_KEYS.memory}::boy_next_door`)
  assert.throws(() => storage.restoreBackup(changed), /quota/)
  assert.equal(localStorage.getItem(storage.CONVERSATIONS_KEY), beforeVault)
  assert.equal(localStorage.getItem(`${STORAGE_KEYS.memory}::boy_next_door`), null)
  const restored = storage.restoreBackup(changed)
  assert.equal(restored.conversations, 2)
  assert.equal(storage.listConversations().some(s => s.title === '恢复后的标题'), true)
})

test('legacy browser and backup credentials are ignored while conversation data is retained', () => {
  reset()
  const legacy = { apiKey: 'synthetic', rememberKey: true, model: 'fake', ready: true }
  localStorage.setItem(STORAGE_KEYS.config, JSON.stringify(legacy))
  const config = storage.loadConfig({ ready: false })
  assert.equal(config.apiKey, undefined)
  assert.equal(config.ready, false, 'legacy credentials cannot mark the server as tested')
  const payload = { app: 'xingyu', version: 4, session: sample('合成聊天'), config: legacy }
  const parsed = storage.parseBackup(JSON.stringify(payload))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.config.apiKey, undefined)
  assert.equal(parsed.session.messages[0].content, '合成聊天')
  storage.saveConfig({ ...legacy, connectionMode: 'server' })
  assert.equal(localStorage.getItem(STORAGE_KEYS.config).includes('synthetic'), false)
  assert.equal(storage.loadConfig({}).model, 'fake')
})

test('rescue backup includes unsaved live content without mutating the vault', () => {
  reset()
  const saved = storage.createConversation(sample('原内容'), '救援备份')
  const before = localStorage.getItem(storage.CONVERSATIONS_KEY)
  const live = { ...saved, messages: [...saved.messages, { id: 'unsaved', role: 'assistant', content: '空间不足时尚未落盘的回复' }] }
  localStorage.failNext(storage.CONVERSATIONS_KEY)
  assert.equal(storage.saveSessionSafe(live).saved, false)
  const parsed = storage.parseBackup(storage.buildBackup({ session: live }))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.session.messages.at(-1).content, '空间不足时尚未落盘的回复')
  assert.equal(localStorage.getItem(storage.CONVERSATIONS_KEY), before)
})

test('reloaded and restored partial responses become stopped without losing text', () => {
  reset()
  const saved = storage.createConversation({ ...sample(), messages: [{ id: 'partial', role: 'assistant', content: '半条回复', pending: true }] })
  for (const loaded of [storage.loadSession({}), storage.activateConversation(saved.id, {}), storage.parseBackup(JSON.stringify({ session: saved })).session]) {
    assert.equal(loaded.messages[0].content, '半条回复')
    assert.equal(loaded.messages[0].pending, false)
    assert.equal(loaded.messages[0].status, 'stopped')
  }
})

test('message usage survives interrupted requests and branch totals are recalculated', () => {
  const messages = [
    { role: 'assistant', status: 'completed', usage: { total_tokens: 12 } },
    { role: 'assistant', status: 'stopped', usage: { total_tokens: 4 } },
    { role: 'assistant', local: true, usage: { total_tokens: 100 } }
  ]
  assert.equal(storage.normalizeUsage({ messages }).total_tokens, 16)
  assert.equal(storage.normalizeUsage({ messages: messages.slice(0, 1), usage: { total_tokens: 999 } }).total_tokens, 12)
})

test('v1-v3 backup keeps source IDs and all supported message fields', () => {
  reset()
  const legacy = {
    version: 3, session: {
      ...sample(), messages: [{
        id: 'source-id', role: 'assistant', content: '回复', status: 'stopped', pending: false,
        local: true, sensitive: true, starred: true, error: '中断', reasoning: '过程',
        createdAt: 123, usage: { total_tokens: 9 }, attachments: []
      }]
    },
    memory: { facts: [{ id: 'fact', text: '用户喜欢星星', messageId: 'source-id', sessionId: 'old-session' }], summaries: [], causalLinks: [] }
  }
  const parsed = storage.parseBackup(JSON.stringify(legacy))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.session.messages[0].id, 'source-id')
  assert.equal(parsed.session.messages[0].status, 'stopped')
  assert.equal(parsed.session.messages[0].reasoning, '过程')
  assert.equal(parsed.memoryByPartition.boy_next_door.facts[0].messageId, 'source-id')
  assert.equal(parsed.memoryByPartition.boy_next_door.facts[0].sessionId, 'old-session')
})
