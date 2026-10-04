// 单轮对话的共用逻辑（纯函数 + 回调，不依赖 React）
//
// 桌面版和手机版都要做同一件事：算情绪 → 检索记忆 → 拼提示词 → 流式请求 → 存记忆。
// 把这段抽出来，两端共用一套；UI 各自负责渲染和本地状态。
//
// 约定：本模块只读传入的 session 快照，不改它；需要落盘的地方通过 persist 回调交回调用方。
import { buildSystemPrompt, getPersonality } from './personalities.js'
import { streamChat } from './deepseek.js'
import { classifyStimulus, applyStimulus, decayTowardBaseline, mapEmotionLabel, isFirstMeeting } from './emotion.js'
import { detectUserStop, isSensitiveText } from './consent.js'
import { MAX_HISTORY_TURNS } from './constants.js'
import { queueExtraction, retrieveMemories, formatRelativeTime } from './memory.js'

// 情绪预处理：刺激分类 → 施加 → 回落到人格底色 → 喊停修正
// 抽出来是为了让"情绪怎么变"这件事在两端完全一致，且可以脱离 UI 单测
export function computeNextEmotion({ session, content, preset }) {
  const stimulus = classifyStimulus(content)
  const sensitive = stimulus.type === 'adult_explicit' || stimulus.type === 'intimate'
  const traits = session.override?.traits ?? preset.traits
  const baseline = session.override?.baseline ?? preset.baseline
  // 喊停识别只响应用户的明确信号；"不要停/别停"这类继续信号不算喊停
  const userStop = session.adultOn && detectUserStop(content)
  let emotion = applyStimulus(
    session.emotion,
    !session.adultOn && stimulus.type === 'adult_explicit' ? 'neutral' : stimulus.type,
    stimulus.strength
  )
  emotion = decayTowardBaseline(emotion, baseline)
  if (userStop) {
    emotion = {
      ...emotion,
      aro: Math.max(-100, emotion.aro - 45),
      sec: Math.min(100, emotion.sec + 10)
    }
  }
  return { stimulus, sensitive, traits, baseline, userStop, emotion }
}

// 一条消息算不算"私密"，用来决定亲密模式关闭时要不要把它发出去。
//
// 三条判据取并集，因为单独任何一条都会漏：
//   1) sensitive 标记 —— 发消息那一刻按你那句话打上的；
//   2) 内容判定 —— 标记可能压根没写上（早期手机版就没写，旧存档里全是这种）；
//   3) 成对判定 —— 她的回复是对你那句话的回应，你那句露骨，这一整轮就都是私密的。
//      这条最要紧：她可能把话说得很含蓄（"里面还跟着您一下一下地跳"），
//      词表再扩也认不全，但"跟在一个露骨提问后面的回复"是结构上确定的事实
function isPrivateMessage(m, prev) {
  if (!m || typeof m !== 'object') return false
  if (m.sensitive) return true
  if (isSensitiveText(m.content)) return true
  // 只对"她的回复"看前一条：你自己的话露不露骨由前两条判据负责
  if (m.role === 'assistant' && prev && prev.role === 'user' && (prev.sensitive || isSensitiveText(prev.content))) return true
  return false
}

const MAX_IMAGE_DATA_URL = 8 * 1024 * 1024
function apiContent(content, attachments) {
  const images = (Array.isArray(attachments) ? attachments : [])
    .filter((a) => typeof a?.dataUrl === 'string' &&
      /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(a.dataUrl) &&
      a.dataUrl.length <= MAX_IMAGE_DATA_URL)
    .map((a) => ({ type: 'image_url', image_url: { url: a.dataUrl } }))
  return images.length ? [{ type: 'text', text: String(content || '') }, ...images] : String(content || '')
}

function isApiHistoryMessage(m) {
  return m && (m.role === 'user' || m.role === 'assistant') &&
    !m.pending && !m.local && !['pending', 'failed', 'local', 'stopped'].includes(m.status) &&
    (typeof m.content === 'string' && m.content.trim() || (m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length))
}

// 拼这一轮实际发给模型的消息
// 隐私过滤：亲密模式关闭时，历史里的亲密/露骨轮次不发给模型（本地仍保留）
export function buildTurnMessages({
  session,
  preset,
  content,
  emotion,
  userStop,
  traits,
  memories,
  profile,
  passages,
  attachments
}) {
  const system = buildSystemPrompt({
    preset,
    emotion,
    adultOn: session.adultOn,
    userStop,
    traits,
    memories,
    profile,
    passages,
    // 对方还没开口之前，一直按"第一次见面"来演
    firstMeeting: isFirstMeeting(session),
    // 你扮演的角色的性别：决定括号旁白里用「她」还是「他」称呼你
    userGender: session.userGender,
    // 经验设定：默认双方都是第一次
    experience: session.experience
  })
  // The UI snapshot already contains this user and its pending reply.
  const all = Array.isArray(session.messages) ? session.messages : []
  let end = all.length
  if (all[end - 1]?.role === 'assistant' && (all[end - 1]?.pending || all[end - 1]?.status === 'pending')) end--
  if (all[end - 1]?.role === 'user') end--
  const visible = all.slice(0, end)
  const history = visible
    .map((m, i) => ({ m, prev: visible[i - 1] }))
    .slice(-MAX_HISTORY_TURNS * 2)
    .filter(({ m, prev }) => isApiHistoryMessage(m) && (session.adultOn || !isPrivateMessage(m, prev)))
    .map(({ m }) => m)
    .map((m) => ({ role: m.role, content: apiContent(m.content, m.attachments) }))
  const apiMessages = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: apiContent(content, attachments) }
  ]
  return { system, history, apiMessages }
}

// 记忆检索 + 档案：失败静默回退，绝不影响聊天
export async function loadTurnMemory({ content, session }) {
  const memoryLines = []
  let profile = []
  let facts = []
  try {
    // limit 用 8：与检索层的默认值一致（之前这里硬写 5，比检索层能给的还少）
    // 带上最近几轮用户消息：让"你忘记东西了""再想想"这类上下文依赖句也能检索到东西
    const recentUser = (session.messages || [])
      .filter((m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim())
      .slice(-3, -1)
      .map((m) => m.content.trim())
    const mem = await retrieveMemories(content, session.adultOn, 8, recentUser, session.personalityId)
    facts = mem.facts || []
    // 最近进展：一句话概括最近聊到哪，避免她只能靠零散事实拼上下文
    if (mem.summary) memoryLines.push(`最近进展：${mem.summary}`)
    for (const f of facts) {
      const when = formatRelativeTime(f.ts)
      const head = `记忆${when ? `（${when}）` : ''}：${f.text}`
      // 带上出处原话：提炼会把细节压平，"你当时原话"能补回来，
      // 也让她有真实措辞可用，而不是复述一句干巴巴的总结。
      const quote = String(f.quote || '').trim()
      memoryLines.push(quote && quote !== f.text ? `${head}｜你当时的原话：「${quote}」` : head)
    }
    profile = mem.profile || []
  } catch {
    /* 检索失败不影响聊天 */
  }
  return { memoryLines, profile, facts }
}

// 跑完整一轮。
// 调用方负责：把 user/assistant 两条占位消息写进 session 并落盘（onPersist）、渲染流式文本。
// 本函数负责：算情绪、检索记忆、拼提示词、发请求、流结束后触发记忆提炼。
export async function runTurn({
  session, // 必须是"已包含本轮 user + pending assistant"的快照
  content,
  attachments,
  config,
  signal,
  onPersist,
  onDelta,
  onReasoning,
  onUsage,
  onDone,
  onError,
  onPrompt
}) {
  const preset = getPersonality(session.personalityId)
  const { sensitive, traits, userStop, emotion } = computeNextEmotion({ session, content, preset })
  let text = ''
  let result
  let errorSent = false
  const reportError = (message) => {
    if (errorSent || !message) return
    errorSent = true
    onError?.(message)
  }
  try {
    if (signal?.aborted) {
      result = { status: 'stopped', ok: false, text, emotion: session.emotion, sensitive, userStop }
      return result
    }
    const { memoryLines, profile, facts } = await loadTurnMemory({ content, session })
    if (signal?.aborted) {
      result = { status: 'stopped', ok: false, text, emotion: session.emotion, sensitive, userStop }
      return result
    }

  // 出处片段：把命中事实对应的原始对话捞回来。
  // 这一步是"她记得结论却记不住过程"的解药 —— 提炼句留在记忆里，
  // 但每轮另外附上那几段原话，她才有过程可讲。
  const passages = pickSourcePassages({ messages: session.messages, facts, sessionId: session.id, adultOn: session.adultOn })

  const { system, history, apiMessages } = buildTurnMessages({
    session,
    preset,
    content,
    emotion,
    userStop,
    traits,
    memories: memoryLines,
    profile,
    passages,
    attachments
  })

  // 交给调用方留档（手机版用它做「本轮提示词」面板）
  onPrompt?.({
    model: config.model,
    thinkingMode: config.thinkingMode,
    adultOn: session.adultOn,
    firstMeeting: isFirstMeeting(session),
    userGender: session.userGender,
    experience: session.experience,
    personalityId: session.personalityId,
    personalityName: preset.name,
    emotion,
    userStop,
    traits,
    memories: memoryLines,
    profile,
    system,
    history,
    apiMessages
  })

  const streamResult = await streamChat({
      model: config.model,
      messages: apiMessages,
      thinkingMode: config.thinkingMode,
      signal,
      onReasoning: (chunk) => { if (!signal?.aborted) onReasoning?.(chunk) },
      onDelta: (chunk) => {
        if (signal?.aborted) return
        text += chunk
        onDelta?.(chunk, text)
      },
      onUsage: (u) => { if (!signal?.aborted) onUsage?.(u) }
    })
    const status = signal?.aborted ? 'stopped' : streamResult.status === 'completed' && text ? 'completed' : streamResult.status === 'stopped' ? 'stopped' : 'failed'
    const error = status === 'failed' ? streamResult.error || '接口没有返回有效正文' : undefined
    if (error) reportError(error)
    result = { status, ok: status === 'completed', text, emotion: status === 'completed' ? emotion : session.emotion, sensitive, userStop, ...(error ? { error } : {}) }
    return result
  } catch (err) {
    const status = signal?.aborted ? 'stopped' : 'failed'
    const error = status === 'failed' ? String(err?.message || err) : undefined
    if (error) reportError(error)
    result = { status, ok: false, text, emotion: session.emotion, sensitive, userStop, ...(error ? { error } : {}) }
    return result
  } finally {
    onDone?.(result || { status: 'failed', ok: false, text, emotion: session.emotion, sensitive, userStop, error: '未知错误' })
  }
}

// 把命中事实的"出处"扩成真正的对话片段。
//
// 背景：提炼会把一段有过程的叙述压成一句话（"用户在地球发现墓穴并获得传承"），
// 于是她能记住结论，却记不住"过程"——表现为"有的地方清楚，有的地方像被撕掉了"。
// 而且一段身世往往横跨好几轮，只回引最初那一轮仍然接不上。
//
// 所以这里做两件事：
//   1) 顺着出处的 turn 回原文，取该轮**前后各 span 轮**，把整段过程捞回来；
//   2) 相邻/重叠的片段合并，避免同一段故事重复贴两遍。
// 有 token 预算上限，超了就丢最长的片段（宁可少给，也不能把提示词撑爆）。
export function pickSourcePassages({
  messages,
  facts,
  sessionId,
  adultOn = false,
  budgetChars = 1600,
  span = 2,
  maxPassages = 3
}) {
  if (!Array.isArray(messages) || !Array.isArray(facts) || facts.length === 0) return []

  // 收集所有需要回看的中心位置
  const centers = []
  for (const f of facts) {
    if (!adultOn && f?.sensitive) continue
    if (f?.sessionId && f.sessionId !== sessionId) continue
    let t = -1
    if (f?.messageId) t = messages.findIndex((m) => m?.id === f.messageId && m.role === 'user')
    else if (f?.turn !== null && f?.turn !== undefined && Number.isInteger(Number(f.turn))) {
      const candidate = Number(f.turn)
      // 没有会话 ID 的旧事实只能用原话验证下标；否则另一会话的同一下标会被误认。
      const quote = String(f.quote || '').trim()
      if (f.sessionId || (quote && String(messages[candidate]?.content || '').includes(quote))) t = candidate
    }
    if (t < 0 || t >= messages.length || messages[t]?.role !== 'user') continue
    centers.push({ index: t, legacy: !f?.messageId })
  }
  if (centers.length === 0) return []

  // 展开成区间，再合并重叠的（相邻 2 轮以内算同一段）
  const ranges = centers
    .map(({ index, legacy }) => [Math.max(0, index - (legacy ? 0 : span)), Math.min(messages.length - 1, index + (legacy ? 1 : span))])
    .sort((a, b) => a[0] - b[0])
  const merged = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1] + 2) last[1] = Math.max(last[1], r[1])
    else merged.push([...r])
  }

  // 转成片段文本
  const passages = merged.map(([from, to]) => {
    const lines = []
    for (let i = from; i <= to; i++) {
      const m = messages[i]
      if (!m || typeof m.content !== 'string' || !m.content.trim()) continue
      if (!adultOn && isPrivateMessage(m, messages[i - 1])) continue
      if (!isApiHistoryMessage(m)) continue
      const who = m.role === 'user' ? '你' : '她'
      lines.push(`${who}：${m.content.trim()}`)
    }
    return { from, to, text: lines.join('\n') }
  }).filter((p) => p.text.trim())

  // 预算控制：优先留短的（同样能补上下文，省 token）；再按时间顺序输出
  passages.sort((a, b) => a.text.length - b.text.length)
  const kept = []
  let used = 0
  for (const p of passages) {
    if (kept.length >= maxPassages) break
    if (used + p.text.length > budgetChars) continue
    kept.push(p)
    used += p.text.length
  }
  kept.sort((a, b) => a.from - b.from)
  return kept
}

// 流结束后把这一轮交给记忆提炼（后台静默，失败不影响聊天）
// turn = 这一轮在会话里的消息下标，会作为"出处"记在提炼出的事实上
export function queueTurnExtraction({ session, config, userText, assistantText, sensitive, turn, messageId, onDone, onStatus, onError }) {
  queueExtraction({
    model: config.model,
    thinkingMode: config.thinkingMode,
    userText,
    assistantText,
    sensitive: Boolean(sensitive),
    turn,
    personalityId: session.personalityId,
    sessionId: session.id,
    messageId,
    onDone,
    onStatus,
    onError
  })
}
