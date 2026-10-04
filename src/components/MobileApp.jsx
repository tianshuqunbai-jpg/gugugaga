import { useEffect, useMemo, useRef, useState } from 'react'
import { getPersonality, personaPronoun, PERSONALITIES } from '../lib/personalities'
import { emotionLabelOf, isFirstMeeting, STRANGER_EMOTION } from '../lib/emotion'
import { loadSession, saveSessionSafe } from '../lib/storage'
import { clearMemory, loadMemory, setMemoryScope } from '../lib/memory'
import { runTurn, queueTurnExtraction, computeNextEmotion } from '../lib/turn'
import { renderMarkdown } from '../lib/markdown.jsx'

// 手机版外壳：单列布局 + 底部抽屉，取代桌面版的三栏。
// 只保留聊天和人格切换，其余（情绪、记忆、加密、提示词调试）收进设置抽屉。

let idCounter = 0
function nextId() {
  idCounter += 1
  return `m-${Date.now().toString(36)}-${idCounter}`
}

function defaultSession() {
  return {
    personalityId: 'boy_next_door',
    adultOn: false,
    ageConfirmed: false,
    override: null,
    emotion: { aff: 12, sec: 20, aro: 12, dom: 0 },
    userGender: 'female',
    experience: 'first',
    messages: [],
    usage: null
  }
}

// 底部抽屉：从下往上滑出，手机上比居中弹窗顺手
function Sheet({ open, title, onClose, children }) {
  if (!open) return null
  return (
    <div className="m-sheet-mask" onClick={onClose}>
      <div className="m-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="m-sheet-head">
          <span className="m-sheet-title">{title}</span>
          <button type="button" className="m-icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="m-sheet-body">{children}</div>
      </div>
    </div>
  )
}

export default function MobileApp({ config, onEditConfig, onExit }) {
  const [session, setSession] = useState(() => {
    const saved = loadSession(defaultSession())
    setMemoryScope(saved.personalityId)
    return saved
  })
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(null)
  const [sheet, setSheet] = useState(null) // null | 'persona' | 'settings'
  const [memCount, setMemCount] = useState(() => {
    const m = loadMemory()
    return { facts: m.facts.length, summaries: m.summaries.length }
  })
  const [notice, setNotice] = useState(null)
  const [promptOpen, setPromptOpen] = useState(false)
  const [lastPrompt, setLastPrompt] = useState(null)

  const sessionRef = useRef(session)
  const partialRef = useRef('')
  const usageRef = useRef(null)
  const abortRef = useRef(null)
  const lockRef = useRef(false)
  // 本轮已收尾的消息 id：runTurn 出错时会先 onError 再 onDone，用它挡住第二次收尾
  const finalizedRef = useRef(null)
  const listRef = useRef(null)
  const inputRef = useRef(null)
  const seededRef = useRef(false)

  useEffect(() => {
    sessionRef.current = session
  }, [session])

  function persist(next) {
    const res = saveSessionSafe(next)
    sessionRef.current = res.session
    setSession(res.session)
    if (res.saved === false) setNotice('本机存储已满，新对话可能无法保存')
    else if (res.trimmed > 0) setNotice(`最早的 ${res.trimmed} 条对话已被自动清理`)
  }

  const preset = getPersonality(session.personalityId)
  const emotionLabel = emotionLabelOf(session)

  // 首次进入：没有消息就放人格的自我介绍
  useEffect(() => {
    if (seededRef.current) return
    seededRef.current = true
    const s = sessionRef.current
    if (s.messages.length === 0) {
      const p = getPersonality(s.personalityId)
      persist({
        ...s,
        messages: [{ id: nextId(), role: 'assistant', content: p.greeting, local: true }]
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 新消息 / 流式更新时滚到底
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [session.messages.length, streaming?.partial])

  function finalize(id, ok, errMsg) {
    // 幂等 + 收尾必达：runTurn 出错时会先 onError 再 onDone，
    // 而 persist / 提炼排队都可能抛 —— 一旦抛在解锁之前，界面就永远卡在生成中，
    // 手机上连刷新都不方便。所以整段包 try/finally，解锁放在 finally 里
    if (finalizedRef.current === id) return
    finalizedRef.current = id
    try {
      const text = ok ? partialRef.current : errMsg ? `（连接中断）${errMsg}` : ''
      const cur = sessionRef.current
      const turnUsage = usageRef.current
      usageRef.current = null
      const updated = {
        ...cur,
        messages: cur.messages.map((m) =>
          m.id === id
            ? { ...m, content: text || (ok ? '' : '（发送失败，请重试）'), pending: false }
            : m
        )
      }
      try {
        persist(updated)
      } catch {
        /* 存不进去也不能卡住收尾 */
      }
      if (ok && text) {
        try {
          const idx = updated.messages.findIndex((m) => m.id === id)
          const prev = idx > 0 ? updated.messages[idx - 1] : null
          if (prev && prev.role === 'user') {
            queueTurnExtraction({
              session: updated,
              config,
              userText: prev.content,
              assistantText: text,
              sensitive: Boolean(prev.sensitive),
              // 消息下标即"第几轮"，让提炼出的事实带上出处
              turn: idx - 1,
              onDone: () => {
                const m = loadMemory()
                setMemCount({ facts: m.facts.length, summaries: m.summaries.length })
              }
            })
          }
        } catch {
          /* 提炼排队失败不影响这轮对话 */
        }
      }
    } finally {
      lockRef.current = false
      abortRef.current = null
      setStreaming(null)
    }
  }

  async function send(raw) {
    const content = (raw ?? input).trim()
    if (!content || !config?.ready) return
    // 自愈：正常流程下这里不会是 true（生成中按钮会变成"停止"）。
    // 真到这一步说明上一轮卡住了 —— 之前是直接 return，等于把发送键吞掉，
    // 手机上连刷新都不方便。现在改成解开卡死状态并继续把这条发出去
    if (lockRef.current) {
      abortRef.current?.abort()
      abortRef.current = null
      lockRef.current = false
      setStreaming(null)
    }
    lockRef.current = true
    setInput('')
    const s = sessionRef.current
    const assistantId = nextId()
    // 情绪/敏感判定走与桌面版同一个函数：这两个标记必须和 runTurn 内部算的一致，
    // 否则提炼出的亲密记忆拿不到「私密」标记，关闭亲密模式时还会被注入提示词
    const { sensitive } = computeNextEmotion({
      session: s,
      content,
      preset: getPersonality(s.personalityId)
    })
    const snapshot = {
      ...s,
      messages: [
        ...s.messages,
        { id: nextId(), role: 'user', content, sensitive },
        { id: assistantId, role: 'assistant', content: '', pending: true, sensitive }
      ]
    }
    persist(snapshot)
    partialRef.current = ''
    finalizedRef.current = null
    setStreaming({ id: assistantId, partial: '', thinking: true })
    const controller = new AbortController()
    abortRef.current = controller

    // 出错原因先攒着：onDone 在出错时也会触发，让收尾只在 onDone 里发生一次
    let turnError = null

    // runTurn 理论上不抛，但真抛了也不能把界面锁死（手机上只能重开 App）
    try {
      await runTurn({
        session: snapshot,
        content,
        config,
        signal: controller.signal,
        onPrompt: (p) => setLastPrompt({ ...p, at: Date.now() }),
        onReasoning: () => setStreaming((st) => (st ? { ...st, thinking: true } : st)),
        onDelta: (chunk, text) => {
          partialRef.current = text
          setStreaming((st) => (st ? { ...st, partial: text, thinking: false } : st))
        },
        onUsage: (u) => {
          usageRef.current = {
            prompt_tokens: u.prompt_tokens || 0,
            completion_tokens: u.completion_tokens || 0,
            total_tokens: u.total_tokens || 0,
            reasoning_tokens: u.completion_tokens_details?.reasoning_tokens || 0
          }
        },
        onError: (msg) => {
          turnError = msg
        },
        onDone: ({ ok, emotion }) => {
          if (emotion) sessionRef.current = { ...sessionRef.current, emotion }
          finalize(assistantId, ok, turnError)
        }
      })
    } catch (err) {
      finalize(assistantId, false, err?.message || '未知错误')
    }
  }

  function stop() {
    abortRef.current?.abort()
  }

  function switchPersona(id) {
    const s = sessionRef.current
    const p = getPersonality(id)
    setMemoryScope(id)
    const firstMeeting = isFirstMeeting(s)
    const greetingOnly =
      s.messages.length <= 1 && s.messages.every((m) => m.role === 'assistant' && m.local)
    const messages = !firstMeeting
      ? s.messages
      : greetingOnly
        ? [{ id: nextId(), role: 'assistant', content: p.greeting, local: true }]
        : s.messages
    persist({ ...s, personalityId: id, override: null, messages, usage: null })
    const m = loadMemory()
    setMemCount({ facts: m.facts.length, summaries: m.summaries.length })
    setSheet(null)
  }

  // 清空对话＝重新开始：必须和桌面版一致地一起收拾记忆与情绪。
  // 只清 messages 会留下"记忆里还记着和这个角色发生过的事"的残留，
  // 而且情绪还停在亲密态，重开后第一句就不像初见
  function clearChat() {
    clearMemory()
    const s = sessionRef.current
    const p = getPersonality(s.personalityId)
    persist({
      ...s,
      emotion: { ...STRANGER_EMOTION },
      usage: null,
      messages: [{ id: nextId(), role: 'assistant', content: p.greeting, local: true }]
    })
    seededRef.current = true
    setMemCount({ facts: 0, summaries: 0 })
    setLastPrompt(null)
    setSheet(null)
  }

  const grouped = useMemo(
    () => ({
      female: PERSONALITIES.filter((p) => p.gender === 'female'),
      male: PERSONALITIES.filter((p) => p.gender === 'male')
    }),
    []
  )

  return (
    <div className="m-app">
      <header className="m-topbar">
        <button type="button" className="m-persona-chip" onClick={() => setSheet('persona')}>
          <span className="m-avatar">{preset.emoji}</span>
          <span className="m-persona-text">
            <span className="m-persona-name">{preset.name}</span>
            <span className="m-emotion" style={{ color: emotionLabel.color }}>
              <span className="m-dot" style={{ background: emotionLabel.color }} />
              {emotionLabel.name}
            </span>
          </span>
        </button>
        <button type="button" className="m-icon-btn" onClick={() => setSheet('settings')} aria-label="设置">
          ⚙
        </button>
      </header>

      {notice && (
        <div className="m-notice" onClick={() => setNotice(null)}>
          ⚠️ {notice}（点一下关闭）
        </div>
      )}

      <main className="m-list" ref={listRef}>
        {session.messages.map((m) => {
          const active = streaming?.id === m.id
          const body = active ? streaming.partial : m.content
          if (m.role === 'user') {
            return (
              <div key={m.id} className="m-row m-row-me">
                <div className="m-bubble m-bubble-me">{m.content}</div>
              </div>
            )
          }
          return (
            <div key={m.id} className="m-row">
              <span className="m-avatar m-avatar-sm">{preset.emoji}</span>
              <div className="m-bubble m-bubble-ai">
                {active && streaming.thinking && !body ? (
                  <span className="m-thinking">
                    <span className="spinner" />
                    正在思考…
                  </span>
                ) : (
                  <>
                    {renderMarkdown(body || '')}
                    {active && <span className="stream-caret" />}
                  </>
                )}
              </div>
            </div>
          )
        })}
      </main>

      <footer className="m-composer">
        <textarea
          ref={inputRef}
          className="m-input"
          value={input}
          rows={1}
          placeholder={`和${preset.name}说点什么…`}
          onChange={(e) => {
            setInput(e.target.value)
            const el = e.target
            el.style.height = 'auto'
            el.style.height = `${Math.min(el.scrollHeight, 120)}px`
          }}
        />
        {streaming ? (
          <button type="button" className="m-send m-stop" onClick={stop}>
            停
          </button>
        ) : (
          <button
            type="button"
            className="m-send"
            disabled={!input.trim() || !config?.ready}
            onClick={() => send()}
          >
            发送
          </button>
        )}
      </footer>

      <Sheet open={sheet === 'persona'} title="切换人格" onClose={() => setSheet(null)}>
        {['female', 'male'].map((g) => (
          <div key={g}>
            <div className="m-group-label">{g === 'female' ? '♀ 女生人格' : '♂ 男生人格'}</div>
            {grouped[g].map((p) => (
              <button
                key={p.id}
                type="button"
                className={`m-persona-row ${session.personalityId === p.id ? 'active' : ''}`}
                style={{ '--pc': p.color }}
                onClick={() => switchPersona(p.id)}
              >
                <span className="m-avatar">{p.emoji}</span>
                <span className="m-persona-text">
                  <span className="m-persona-name">{p.name}</span>
                  <span className="m-persona-desc">{p.tag}</span>
                </span>
                {session.personalityId === p.id && <span className="m-check">✓</span>}
              </button>
            ))}
          </div>
        ))}
      </Sheet>

      <Sheet open={sheet === 'settings'} title="设置" onClose={() => setSheet(null)}>
        <div className="m-field">
          <div className="m-field-label">亲密模式</div>
          <div className="m-seg">
            {[
              { v: false, t: '关闭' },
              { v: true, t: '开启' }
            ].map((o) => (
              <button
                key={String(o.v)}
                type="button"
                className={`m-seg-btn ${Boolean(session.adultOn) === o.v ? 'active' : ''}`}
                onClick={() => {
                  const s = sessionRef.current
                  if (o.v && !s.ageConfirmed) {
                    persist({ ...s, ageConfirmed: true, adultOn: true })
                  } else {
                    persist({ ...s, adultOn: o.v })
                  }
                }}
              >
                {o.t}
              </button>
            ))}
          </div>
        </div>

        <div className="m-field">
          <div className="m-field-label">我扮演的角色</div>
          <div className="m-seg">
            {[
              { v: 'female', t: '女生（「她」）' },
              { v: 'male', t: '男生（「他」）' }
            ].map((o) => (
              <button
                key={o.v}
                type="button"
                className={`m-seg-btn ${(session.userGender || 'female') === o.v ? 'active' : ''}`}
                onClick={() => persist({ ...sessionRef.current, userGender: o.v })}
              >
                {o.t}
              </button>
            ))}
          </div>
        </div>

        <div className="m-field">
          <div className="m-field-label">经验设定</div>
          <div className="m-seg">
            {[
              { v: 'first', t: '都是第一次' },
              { v: 'free', t: '不限制' }
            ].map((o) => (
              <button
                key={o.v}
                type="button"
                className={`m-seg-btn ${(session.experience || 'first') === o.v ? 'active' : ''}`}
                onClick={() => persist({ ...sessionRef.current, experience: o.v })}
              >
                {o.t}
              </button>
            ))}
          </div>
        </div>

        <div className="m-field">
          <div className="m-field-label">
            长期记忆 · {memCount.facts} 条事实 / {memCount.summaries} 条摘要
          </div>
          <p className="m-hint">记忆按人格分开存放，换人格不会串到别人的剧情。</p>
        </div>

        <div className="m-field">
          <div className="m-field-label">本轮提示词</div>
          <button
            type="button"
            className="m-btn"
            disabled={!lastPrompt}
            onClick={() => setPromptOpen(true)}
          >
            查看最近一轮发给模型的内容
          </button>
        </div>

        <div className="m-field">
          <div className="m-field-label">
            用量 · {session.usage ? `${session.usage.total_tokens.toLocaleString()} tokens / ${session.usage.turns} 轮` : '暂无'}
          </div>
          <p className="m-hint">「输入」是每轮完整上下文的总和，不等于新产生的消耗。</p>
        </div>

        <div className="m-field">
          <button type="button" className="m-btn" onClick={clearChat}>
            清空对话
          </button>
          <button type="button" className="m-btn" onClick={onEditConfig}>
            重新配置 API Key
          </button>
          <button type="button" className="m-btn" onClick={onExit}>
            返回首页
          </button>
        </div>
      </Sheet>

      <Sheet open={promptOpen} title="本轮提示词" onClose={() => setPromptOpen(false)}>
        {lastPrompt ? (
          <>
            <p className="m-hint">
              {lastPrompt.personalityName} · 亲密模式{lastPrompt.adultOn ? '开' : '关'} ·{' '}
              {lastPrompt.firstMeeting ? '初见态' : '已认识'} · 共 {lastPrompt.apiMessages.length} 条
            </p>
            {lastPrompt.apiMessages.map((m, i) => (
              <details key={i} className="m-prompt-item">
                <summary>
                  {m.role} · {String(m.content || '').length.toLocaleString()} 字
                </summary>
                <pre>{m.content}</pre>
              </details>
            ))}
          </>
        ) : (
          <p className="m-hint">还没有记录。先发一句话。</p>
        )}
      </Sheet>
    </div>
  )
}
