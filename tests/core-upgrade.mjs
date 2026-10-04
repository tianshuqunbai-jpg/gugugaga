import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const root = new URL('../src/lib/', import.meta.url)
const delay = () => new Promise((resolve) => setImmediate(resolve))

test('browser model and connection checks use same-origin proxy without credentials', async () => {
  const calls = []
  const deepseek = await moduleWithStubs('deepseek.js', {
    './constants': { normalizeModel: x => x, buildUserId: () => 'test' }
  }, { fetch: async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => url.endsWith('/models') ? { data: [] } : { choices: [] } }
  } })
  await deepseek.fetchModels({ apiKey: 'test-only' })
  await deepseek.testKey({ apiKey: 'test-only', model: 'fake' })
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.url.startsWith('/api/deepseek/'), true)
    assert.equal(call.init.headers.Authorization, undefined)
    assert.equal(JSON.stringify(call.init).includes('test-only'), false)
  }
})

async function moduleWithStubs(file, stubs, globals = {}) {
  const context = vm.createContext({
    AbortController, TextDecoder, setTimeout, clearTimeout, console, URL,
    fetch: globals.fetch, localStorage: globals.localStorage, sessionStorage: globals.sessionStorage, window: globals.window,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } }
  })
  const src = await readFile(new URL(file, root), 'utf8')
  const entry = new vm.SourceTextModule(src, { context, identifier: file })
  await entry.link(async (specifier) => {
    const exports = stubs[specifier]
    assert.ok(exports, `missing stub ${specifier}`)
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
    }, { context })
  })
  await entry.evaluate()
  return entry.namespace
}

const session = () => ({
  id: 's1', personalityId: 'a', adultOn: false, emotion: { val: 0 }, messages: [
    { id: 'old', role: 'user', content: '从前' },
    { id: 'old-a', role: 'assistant', content: '知道了', status: 'completed' },
    { id: 'new', role: 'user', content: '现在', attachments: [] },
    { id: 'pending', role: 'assistant', content: '', pending: true }
  ]
})

function turnStubs(streamChat, retrieveMemories = async () => ({ facts: [], profile: [] })) {
  return {
    './personalities.js': { buildSystemPrompt: () => 'system', getPersonality: () => ({ traits: {}, baseline: {}, name: 'A' }) },
    './deepseek.js': { streamChat },
    './emotion.js': { classifyStimulus: () => ({ type: 'neutral', strength: 1 }), applyStimulus: () => ({ val: 1 }), decayTowardBaseline: (e) => e, mapEmotionLabel: () => '', isFirstMeeting: () => false },
    './consent.js': { detectUserStop: () => false, isSensitiveText: (text) => String(text || '').includes('私密') },
    './constants.js': { MAX_HISTORY_TURNS: 12 },
    './memory.js': { queueExtraction: () => {}, retrieveMemories, formatRelativeTime: () => '' }
  }
}

test('turn sends current text and image once; removes pending and private history', async () => {
  const turn = await moduleWithStubs('turn.js', turnStubs(async () => ({ status: 'completed' })))
  const s = session()
  s.messages.unshift({ id: 'private-a', role: 'assistant', content: '私密回复', status: 'completed' })
  s.messages.unshift({ id: 'private-u', role: 'user', content: '私密提问', sensitive: true })
  const image = 'data:image/png;base64,AAAA'
  const built = turn.buildTurnMessages({ session: s, preset: { traits: {}, baseline: {} }, content: '现在', attachments: [{ dataUrl: image }, { dataUrl: 'https://bad.test/image.png' }], emotion: {}, traits: {}, memories: [], profile: [], passages: [] })
  assert.equal(built.apiMessages.filter((m) => m.role === 'user').length, 2)
  assert.equal(built.apiMessages.at(-1).content[0].text, '现在')
  assert.equal(built.apiMessages.at(-1).content[1].image_url.url, image)
  assert.equal(built.apiMessages.filter((m) => JSON.stringify(m).includes('私密')).length, 0)
  assert.equal(built.apiMessages.filter((m) => JSON.stringify(m).includes('pending')).length, 0)
})

test('runTurn completes exactly once when stopped during retrieval', async () => {
  let release
  let streamed = false
  const memory = new Promise((resolve) => { release = resolve })
  const turn = await moduleWithStubs('turn.js', turnStubs(async () => { streamed = true; return { status: 'completed' } }, () => memory))
  const controller = new AbortController()
  const done = []
  const running = turn.runTurn({ session: session(), content: '现在', config: { model: 'deepseek-flash' }, signal: controller.signal, onDone: (r) => done.push(r) })
  controller.abort()
  release({ facts: [] })
  const result = await running
  assert.equal(result.status, 'stopped')
  assert.equal(done.length, 1)
  assert.equal(streamed, false)
})

test('failed stream keeps received text and does not commit emotion', async () => {
  const turn = await moduleWithStubs('turn.js', turnStubs(async ({ onDelta }) => {
    onDelta('半句')
    return { status: 'failed', error: '连接中断' }
  }))
  const s = session()
  const done = []
  const errors = []
  const result = await turn.runTurn({ session: s, content: '现在', config: { model: 'fake' }, onDone: (r) => done.push(r), onError: (e) => errors.push(e) })
  assert.equal(result.status, 'failed')
  assert.equal(result.text, '半句')
  assert.deepEqual(result.emotion, s.emotion)
  assert.equal(done.length, 1)
  assert.deepEqual(errors, ['连接中断'])
})

test('source passages use stable IDs, reject private neighbors and enforce first budget', async () => {
  const turn = await moduleWithStubs('turn.js', turnStubs(async () => ({ status: 'completed' })))
  const messages = [
    { id: 'u1', role: 'user', content: '普通故事' },
    { id: 'a1', role: 'assistant', content: '继续' },
    { id: 'u2', role: 'user', content: '私密问题', sensitive: true },
    { id: 'a2', role: 'assistant', content: '含蓄回应' }
  ]
  const facts = [{ messageId: 'u1', sessionId: 's1', turn: null }]
  assert.deepEqual(Array.from(turn.pickSourcePassages({ messages, facts, sessionId: 'other' })), [])
  const passages = turn.pickSourcePassages({ messages, facts, sessionId: 's1', budgetChars: 100, span: 3 })
  assert.equal(passages.length, 1)
  assert.equal(passages[0].text.includes('私密'), false)
  assert.equal(passages[0].text.includes('含蓄回应'), false)
  assert.equal(turn.pickSourcePassages({ messages, facts, sessionId: 's1', budgetChars: 2 }).length, 0)
  assert.equal(turn.pickSourcePassages({ messages, facts: [{ turn: null }], sessionId: 's1' }).length, 0)
})

async function memoryHarness({ legacyPlaintext = null } = {}) {
  const data = new Map()
  const localStorage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
    key: (i) => [...data.keys()][i] ?? null,
    get length() { return data.size }
  }
  const events = []
  const calls = []
  let failWrite = false
  let locked = false
  const memory = await moduleWithStubs('memory.js', {
    './deepseek.js': { chatNonStream: (args) => new Promise((resolve) => calls.push({ args, resolve })) },
    './constants.js': { STORAGE_KEYS: { memory: 'memory', memoryMigrated: 'migrated' } },
    './crypto.js': { readSecure: (k) => locked ? null : k === 'memory' && legacyPlaintext !== null ? legacyPlaintext : localStorage.getItem(k), writeSecure: (k, v) => { if (locked) throw Error('locked'); if (failWrite) throw Error('quota'); localStorage.setItem(k, v) } },
    './consent.js': { isSensitiveText: (text) => String(text || '').includes('私密') }
  }, { localStorage, window: { dispatchEvent: (event) => events.push(event) } })
  const response = (summary = '主题', fact = '用户喜欢猫') => JSON.stringify({ facts: [{ text: fact, src: 1, quote: '喜欢猫' }], summary, causals: [] })
  return { memory, data, localStorage, calls, events, response, setFailWrite: (v) => { failWrite = v }, setLocked: (v) => { locked = v } }
}

test('extraction drains by fixed personality, session and privacy scope', async () => {
  const h = await memoryHarness()
  const q = (personalityId, sessionId, sensitive, messageId) => h.memory.queueExtraction({ apiKey: 'fake', model: 'fake', userText: '我喜欢猫咪呀', assistantText: '好的知道了', personalityId, sessionId, sensitive, messageId })
  q('a', 's1', false, 'm1')
  q('b', 's2', true, 'm2')
  assert.equal(h.calls.length, 1)
  h.calls[0].resolve({ ok: true, text: h.response() })
  await delay()
  assert.equal(h.calls.length, 2)
  h.calls[1].resolve({ ok: true, text: h.response('私密话题', '用户有私密偏好') })
  await h.memory.flushPendingExtraction()
  assert.equal(JSON.parse(h.data.get('memory::a')).facts[0].messageId, 'm1')
  assert.equal(JSON.parse(h.data.get('memory::b')).facts[0].sessionId, 's2')
  assert.equal(JSON.parse(h.data.get('memory::b')).summaries[0].sensitive, true)
  h.memory.setMemoryScope('b')
  const hidden = await h.memory.retrieveMemories('猫咪', false)
  assert.equal(hidden.summary, '')
})

test('clear while in flight prevents resurrection; failure is observable and retryable', async () => {
  const h = await memoryHarness()
  h.memory.queueExtraction({ apiKey: 'fake', model: 'fake', userText: '我喜欢猫咪呀', assistantText: '好的知道了', personalityId: 'a', sessionId: 's1', messageId: 'm1' })
  const flushing = h.memory.flushPendingExtraction()
  h.memory.setMemoryScope('a')
  h.memory.clearMemory()
  h.calls[0].resolve({ ok: true, text: h.response() })
  await flushing
  assert.equal(JSON.parse(h.data.get('memory::a')).facts.length, 0)

  h.memory.queueExtraction({ apiKey: 'fake', model: 'fake', userText: '我喜欢猫咪呀', assistantText: '好的知道了', personalityId: 'a', sessionId: 's1', messageId: 'm2' })
  const next = h.memory.flushPendingExtraction()
  h.setFailWrite(true)
  h.calls[1].resolve({ ok: true, text: h.response() })
  await next
  assert.equal(h.memory.getExtractionStatus('a').failed, 1)
  assert.equal(h.events[0].type, 'xingyu:memory-error')
  assert.equal(h.events[0].detail.personalityId, 'a')
  h.setFailWrite(false)
  assert.equal(h.memory.retryFailedExtraction({ personalityId: 'a' }), 1)
  await delay()
  h.calls[2].resolve({ ok: true, text: h.response() })
  await h.memory.flushPendingExtraction()
  assert.equal(h.memory.getExtractionStatus('a').failed, 0)
})

test('stream idle timeout cancels reader and ignores late data', async () => {
  let cancelCount = 0
  let releaseRead
  const reader = {
    read: () => new Promise((resolve) => { releaseRead = resolve }),
    cancel: async () => { cancelCount++ }
  }
  const deepseek = await moduleWithStubs('deepseek.js', {
    './constants': { normalizeModel: (x) => x, buildUserId: () => 'test' }
  }, { fetch: async () => ({ ok: true, body: { getReader: () => reader } }) })
  const done = []
  const deltas = []
  const result = await deepseek.streamChat({ apiKey: 'fake', model: 'fake', messages: [], idleTimeoutMs: 5, onDone: (r) => done.push(r), onDelta: (x) => deltas.push(x) })
  assert.equal(result.status, 'failed')
  assert.equal(done.length, 1)
  assert.equal(cancelCount, 1)
  releaseRead({ done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"late"}}]}\n') })
  await delay()
  assert.deepEqual(deltas, [])
})

test('model and key checks honor abort signals', async () => {
  const deepseek = await moduleWithStubs('deepseek.js', {
    './constants': { normalizeModel: (x) => x, buildUserId: () => 'test' }
  }, { fetch: () => new Promise(() => {}) })
  const modelsAbort = new AbortController()
  const keyAbort = new AbortController()
  const models = deepseek.fetchModels({ apiKey: 'fake', signal: modelsAbort.signal })
  const key = deepseek.testKey({ apiKey: 'fake', model: 'fake', signal: keyAbort.signal })
  modelsAbort.abort()
  keyAbort.abort()
  assert.equal((await models).aborted, true)
  assert.equal((await key).aborted, true)
})

test('retrieval stays in requested personality and old unmarked summaries remain hidden', async () => {
  const h = await memoryHarness()
  h.memory.setMemoryScope('a')
  h.memory.addMemory({ summary: 'A 的普通进展' })
  h.memory.setMemoryScope('b')
  h.memory.addMemory({ summary: 'B 的普通进展' })
  const a = await h.memory.retrieveMemories('普通进展', false, 8, [], 'a')
  assert.equal(a.summary, 'A 的普通进展')
  h.data.set('memory::a', JSON.stringify({ facts: [], summaries: [{ text: '旧摘要可能私密' }], causalLinks: [] }))
  const old = await h.memory.retrieveMemories('旧摘要', false, 8, [], 'a')
  assert.equal(old.summary, '')
  const intimate = await h.memory.retrieveMemories('旧摘要', true, 8, [], 'a')
  assert.equal(intimate.summary, '旧摘要可能私密')
})

test('local greeting is never sent as assistant history', async () => {
  const turn = await moduleWithStubs('turn.js', turnStubs(async () => ({ status: 'completed' })))
  const s = session()
  s.messages.unshift({ id: 'greeting', role: 'assistant', content: '你好呀，我在这里', local: true, status: 'completed' })
  const built = turn.buildTurnMessages({ session: s, preset: { traits: {}, baseline: {} }, content: '现在', emotion: {}, traits: {}, memories: [], profile: [], passages: [] })
  assert.equal(built.apiMessages.some(m => String(m.content).includes('你好呀')), false)
})

test('legacy turn without session ID needs matching source quote', async () => {
  const turn = await moduleWithStubs('turn.js', turnStubs(async () => ({ status: 'completed' })))
  const messages = [{ role: 'user', content: '另一段故事' }, { role: 'assistant', content: '知道了' }]
  const fact = { turn: 0, quote: '原来的故事' }
  assert.equal(turn.pickSourcePassages({ messages, facts: [fact], sessionId: 'new' }).length, 0)
  assert.equal(turn.pickSourcePassages({ messages, facts: [{ turn: 0 }], sessionId: 'new' }).length, 0)
  messages[0].content = '原来的故事发生在这里'
  assert.equal(turn.pickSourcePassages({ messages, facts: [fact], sessionId: 'new' }).length, 1)
})

test('private assistant text marks subtle extracted fact and summary private', async () => {
  const h = await memoryHarness()
  h.memory.queueExtraction({ apiKey: 'fake', model: 'fake', userText: '今晚我们聊些什么呢', assistantText: '私密的事情悄悄说', personalityId: 'a', sessionId: 's1' })
  const running = h.memory.flushPendingExtraction()
  h.calls[0].resolve({ ok: true, text: h.response('后来我们更亲近了', '关系有了新的进展') })
  await running
  const stored = JSON.parse(h.data.get('memory::a'))
  assert.equal(stored.facts[0].sensitive, true)
  assert.equal(stored.summaries[0].sensitive, true)
  const hidden = await h.memory.retrieveMemories('进展', false, 8, [], 'a')
  assert.equal(hidden.summary, '')
})

test('rebuild result arriving after clear cannot restore memory', async () => {
  const h = await memoryHarness()
  h.memory.setMemoryScope('a')
  const running = h.memory.rebuildMemoryFromMessages({ apiKey: 'fake', model: 'fake', personalityId: 'a', sessionId: 's1', messages: [
    { id: 'u1', role: 'user', content: '我喜欢猫咪呀' }, { id: 'a1', role: 'assistant', content: '好的知道了' }
  ] })
  assert.equal(h.calls.length, 1)
  h.memory.clearMemory()
  h.calls[0].resolve({ ok: true, text: h.response() })
  const result = await running
  assert.equal(result.cancelled, true)
  assert.equal(JSON.parse(h.data.get('memory::a')).facts.length, 0)
})

test('keyword backfill merges by surviving ID and preserves facts added during request', async () => {
  const h = await memoryHarness()
  h.memory.setMemoryScope('a')
  h.memory.addMemory({ facts: ['用户喜欢猫咪'] })
  const firstId = JSON.parse(h.data.get('memory::a')).facts[0].id
  const running = h.memory.backfillKeywords({ apiKey: 'fake', model: 'fake' })
  h.memory.addMemory({ facts: ['用户喜欢月亮'] })
  h.calls[0].resolve({ ok: true, text: JSON.stringify({ keywords: [['猫咪', '宠物']], domains: ['兴趣偏好'] }) })
  await running
  const facts = JSON.parse(h.data.get('memory::a')).facts
  assert.equal(facts.length, 2)
  assert.equal(facts.find(f => f.id === firstId).keywords.includes('宠物'), true)
  assert.equal(facts.some(f => f.text.includes('月亮')), true)
})

test('keyword backfill respects its explicit personality while another is active', async () => {
  const h = await memoryHarness()
  h.memory.setMemoryScope('a')
  h.memory.addMemory({ facts: ['用户喜欢猫咪'] })
  h.memory.setMemoryScope('b')
  h.memory.addMemory({ facts: ['用户喜欢月亮'] })
  const beforeB = h.data.get('memory::b')
  const running = h.memory.backfillKeywords({ apiKey: 'fake', model: 'fake', personalityId: 'a' })
  assert.equal(h.calls.length, 1)
  h.calls[0].resolve({ ok: true, text: JSON.stringify({ keywords: [['猫咪', '宠物']] }) })
  const result = await running
  assert.equal(result.processed, 1)
  assert.equal(JSON.parse(h.data.get('memory::a')).facts[0].keywords.includes('宠物'), true)
  assert.equal(h.data.get('memory::b'), beforeB)
  const empty = await h.memory.backfillKeywords({ apiKey: 'fake', model: 'fake', personalityId: 'empty' })
  assert.equal(empty.processed, 0)
  assert.equal(h.calls.length, 1)
})

test('keyword backfill arriving after clear cannot restore facts', async () => {
  const h = await memoryHarness()
  h.memory.setMemoryScope('a')
  h.memory.addMemory({ facts: ['用户喜欢猫咪'] })
  const running = h.memory.backfillKeywords({ apiKey: 'fake', model: 'fake' })
  h.memory.clearMemory()
  h.calls[0].resolve({ ok: true, text: JSON.stringify({ keywords: [['猫咪']] }) })
  const result = await running
  assert.equal(result.cancelled, true)
  assert.equal(JSON.parse(h.data.get('memory::a')).facts.length, 0)
})

test('encrypted legacy memory waits for unlock, then migrates decoded content once', async () => {
  const original = JSON.stringify({ facts: [{ text: '用户喜欢猫咪' }], summaries: [], causalLinks: [] })
  const h = await memoryHarness({ legacyPlaintext: original })
  h.data.set('memory', JSON.stringify({ v: 1, enc: true, data: 'ciphertext' }))
  h.memory.setMemoryScope('a')
  h.setLocked(true)
  assert.equal(h.memory.loadMemory().facts.length, 0)
  assert.equal(h.data.has('migrated'), false)
  h.setLocked(false)
  assert.equal(h.memory.loadMemory().facts[0].text, '用户喜欢猫咪')
  assert.equal(h.data.has('migrated'), true)
  assert.equal(JSON.parse(h.data.get('memory::a')).facts[0].text, '用户喜欢猫咪')
  assert.equal(h.data.get('memory').includes('ciphertext'), true)
  h.memory.setMemoryScope('b')
  assert.equal(h.memory.loadMemory().facts.length, 0)
})

test('invalid legacy memory is retained without a migration marker', async () => {
  const h = await memoryHarness({ legacyPlaintext: JSON.stringify({ v: 1, enc: true }) })
  h.data.set('memory', 'encrypted-original')
  h.memory.setMemoryScope('a')
  assert.equal(h.memory.loadMemory().facts.length, 0)
  assert.equal(h.data.get('memory'), 'encrypted-original')
  assert.equal(h.data.has('memory::a'), false)
  assert.equal(h.data.has('migrated'), false)
})

test('clear all cancels every personality including another in-flight extraction', async () => {
  const h = await memoryHarness()
  h.memory.setMemoryScope('a')
  h.memory.queueExtraction({ apiKey: 'fake', model: 'fake', userText: '我喜欢猫咪呀', assistantText: '好的知道了', personalityId: 'b' })
  const running = h.memory.flushPendingExtraction()
  h.memory.queueExtraction({ apiKey: 'fake', model: 'fake', userText: '我喜欢星星呀', assistantText: '好的知道了', personalityId: 'a' })
  const sessionStorage = { removeItem() {} }
  const storage = await moduleWithStubs('storage.js', {
    './constants.js': { STORAGE_KEYS: { memory: 'memory', memoryMigrated: 'migrated', config: 'config', session: 'session', crypto: 'crypto', configSession: 'configSession' } },
    './crypto.js': { isCryptoEnabled: () => false, isUnlocked: () => false, readSecure: (k) => h.localStorage.getItem(k), writeSecure: (k, v) => h.localStorage.setItem(k, v) },
    './memory.js': h.memory
  }, { localStorage: h.localStorage, sessionStorage })
  storage.clearAllData()
  h.calls[0].resolve({ ok: true, text: h.response() })
  await running
  assert.equal(h.memory.getExtractionStatus().pending, 0)
  assert.equal(h.memory.getExtractionStatus().running, 0)
  assert.equal([...h.data.keys()].some(k => k.startsWith('memory::')), false)
})

test('backup restore invalidates older in-flight memory work', async () => {
  const h = await memoryHarness()
  h.memory.queueExtraction({ apiKey: 'fake', model: 'fake', userText: '我喜欢猫咪呀', assistantText: '好的知道了', personalityId: 'b' })
  const running = h.memory.flushPendingExtraction()
  const storage = await moduleWithStubs('storage.js', {
    './constants.js': { STORAGE_KEYS: { memory: 'memory', memoryMigrated: 'migrated', config: 'config', session: 'session', crypto: 'crypto', configSession: 'configSession' } },
    './crypto.js': { isCryptoEnabled: () => false, isUnlocked: () => false, readSecure: (k) => h.localStorage.getItem(k), writeSecure: (k, v) => h.localStorage.setItem(k, v) },
    './memory.js': h.memory
  }, { localStorage: h.localStorage, sessionStorage: { getItem: () => null, removeItem() {} } })
  storage.restoreBackup({ ok: true, activeId: 's1', conversations: [{ id: 's1' }], session: { id: 's1' }, memoryByPartition: {
    a: { version: 3, facts: [], summaries: [], causalLinks: [] }
  } })
  h.calls[0].resolve({ ok: true, text: h.response() })
  await running
  assert.equal(h.data.has('memory::b'), false)
  assert.equal(JSON.parse(h.data.get('memory::a')).facts.length, 0)
})

test('SSE joins multiline data across chunks and CRLF event boundaries', async () => {
  const chunks = [
    'data: {"choices":[{"delta":\r',
    '\ndata: {"content":"你好"},"finish_reason":"stop"}]}\r\n\r',
    '\n: comment\r\ndata: [DONE]\r\n\r\n'
  ].map(x => new TextEncoder().encode(x))
  const reader = { read: async () => chunks.length ? { done: false, value: chunks.shift() } : { done: true }, cancel: async () => {} }
  const deepseek = await moduleWithStubs('deepseek.js', {
    './constants': { normalizeModel: (x) => x, buildUserId: () => 'test' }
  }, { fetch: async () => ({ ok: true, body: { getReader: () => reader } }) })
  const deltas = []
  const result = await deepseek.streamChat({ apiKey: 'fake', model: 'fake', messages: [], onDelta: x => deltas.push(x) })
  assert.equal(result.status, 'completed')
  assert.deepEqual(deltas, ['你好'])
})
