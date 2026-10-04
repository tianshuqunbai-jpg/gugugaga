import { normalizeModel, buildUserId } from './constants'

export const DEEPSEEK_BASE = '/api/deepseek'

// 导出以便单测：只拼请求体，不发请求
export function buildBody({
  model,
  messages,
  thinkingMode,
  stream,
  maxTokens,
  temperature,
  responseFormat,
  includeUsage
}) {
  const body = {
    model: normalizeModel(model),
    messages,
    stream,
    temperature: temperature ?? 1.0,
    top_p: 1.0,
    // 官方 user_id：KVCache 缓存隔离 + 调度隔离，多设备共用同一 Key 时不互相挤占
    user_id: buildUserId()
  }
  if (maxTokens) body.max_tokens = maxTokens
  // JSON 模式：服务端保证返回合法 JSON，比"提示词里写死 JSON + 前端兜底解析"更稳
  if (responseFormat === 'json') body.response_format = { type: 'json_object' }
  // 官方 thinking 参数只认两个字段：type（enabled/disabled）与 reasoning_effort（none/low/high/max），
  // 必须写成 body.thinking = { type, reasoning_effort }，不能把 reasoning_effort 提到顶层。
  // 注意 type 的默认值是 enabled —— 不传就等于开着思考，所以「不思考」必须显式 disabled，
  // 否则号称最快的档位其实一直在偷偷思考（更慢也更贵）。
  if (thinkingMode === 'thinking') {
    body.thinking = { type: 'enabled', reasoning_effort: 'high' }
  } else if (thinkingMode === 'max') {
    body.thinking = { type: 'enabled', reasoning_effort: 'max' }
  } else {
    body.thinking = { type: 'disabled' }
  }
  // 流式用量统计：官方会把整轮 usage 挂在最后一个内容块上（不会单独发一个 usage 块），
  // 所以必须等流结束后再回调 onUsage，否则拿到的是 null
  if (stream && includeUsage) body.stream_options = { include_usage: true }
  return body
}

function friendlyError(status, code, message) {
  if (typeof message === 'string' && message.startsWith('请在服务端设置 DEEPSEEK_API_KEY')) return message
  const map = {
    400: '请求格式有误，请检查模型名与参数',
    401: 'API Key 无效或已失效，请检查后重试',
    402: '账户余额不足，请到 platform.deepseek.com 充值',
    403: '当前模型不可用，请检查 Key 的权限与模型名',
    422: '请求参数不合法，请检查模型名与思考模式设置',
    429: '请求过于频繁，请稍后再试',
    500: 'DeepSeek 服务异常，请稍后重试',
    503: '服务过载，建议切到 Flash（deepseek-flash）或稍后重试'
  }
  const base = map[status] || `请求失败（HTTP ${status}）`
  return message ? `${base}：${message}` : base
}

// One controller owns the request, including response parsing. Callers can cancel
// without waiting for a slow server; timeout failures remain distinct from stops.
async function requestJson(url, options, { signal, timeoutMs = 30000 } = {}) {
  const controller = new AbortController()
  let timer
  let timedOut = false
  let abortListener
  const aborted = new Promise((_, reject) => {
    abortListener = () => {
      controller.abort()
      reject(Object.assign(new Error('已取消'), { name: 'AbortError' }))
    }
    if (signal?.aborted) abortListener()
    else signal?.addEventListener('abort', abortListener, { once: true })
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(Object.assign(new Error('请求超时，请重试'), { name: 'TimeoutError' }))
    }, timeoutMs)
  })
  try {
    if (signal?.aborted) return await aborted
    return await Promise.race([
      (async () => {
        const res = await fetch(url, { ...options, signal: controller.signal })
        const data = await res.json().catch(() => ({}))
        return { res, data }
      })(),
      aborted
    ])
  } catch (err) {
    if (timedOut) throw Object.assign(new Error('请求超时，请重试'), { name: 'TimeoutError' })
    throw err
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abortListener)
  }
}

function requestFailure(err) {
  if (err?.name === 'AbortError') return { ok: false, aborted: true, message: '已取消' }
  if (err?.name === 'TimeoutError') return { ok: false, timeout: true, message: err.message }
  return { ok: false, status: 0, message: `网络错误：${err?.message || '无法连接 DeepSeek'}` }
}

export async function testKey({ model, signal, timeoutMs }) {
  try {
    const { res, data } = await requestJson(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody({
        model, messages: [{ role: 'user', content: 'ping' }],
        thinkingMode: 'auto', stream: false, maxTokens: 16
      }))
    }, { signal, timeoutMs })
    if (!res.ok) return { ok: false, status: res.status, message: friendlyError(res.status, data?.error?.code, data?.error?.message) }
    if (!Array.isArray(data.choices)) return { ok: false, status: res.status, message: '接口返回格式不正确，未收到有效的对话结果' }
    return { ok: true, status: res.status, model: data.model, data }
  } catch (err) {
    return requestFailure(err)
  }
}

export async function chatNonStream({ model, thinkingMode, messages, maxTokens, temperature, responseFormat,
  signal, timeoutMs = 60000
}) {
  try {
    const { res, data } = await requestJson(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody({ model, messages, thinkingMode, stream: false, maxTokens, temperature, responseFormat }))
    }, { signal, timeoutMs })
    if (!res.ok) return { ok: false, status: res.status, message: friendlyError(res.status, data?.error?.code, data?.error?.message) }
    const text = data.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) return { ok: false, message: '接口没有返回有效正文' }
    if (data.choices?.[0]?.finish_reason === 'length') return { ok: false, message: '输出达到长度上限，请缩小任务后重试' }
    return { ok: true, text, usage: data.usage || null }
  } catch (err) {
    return requestFailure(err)
  }
}

// Resolves and calls onDone exactly once for every terminal state. A stopped or
// failed stream retains received text in the caller, but is never called complete.
export function streamChat({ model, messages, thinkingMode, signal,
  onDelta, onReasoning, onUsage, onDone, onError, idleTimeoutMs = 90000
}) {
  return new Promise((resolve) => {
    const controller = new AbortController()
    let reader = null
    let timer = null
    let settled = false
    let usage = null
    let finishReason = null
    const finish = (status, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      controller.abort()
      if (reader) void reader.cancel().catch(() => {})
      const result = { status, ok: status === 'completed', ...(error ? { error } : {}) }
      try { if (usage) onUsage?.(usage) } catch { /* consumer cannot block cleanup */ }
      try { if (error) onError?.(error) } catch { /* consumer cannot block cleanup */ }
      try { onDone?.(result) } catch { /* consumer cannot block cleanup */ }
      resolve(result)
    }
    const stop = () => finish('stopped')
    const bumpIdle = () => {
      clearTimeout(timer)
      timer = setTimeout(() => finish('failed', '响应超时，已保留收到的内容，可以重试'), idleTimeoutMs)
    }
    if (signal?.aborted) { stop(); return }
    signal?.addEventListener('abort', stop, { once: true })
    bumpIdle()

    void (async () => {
      try {
        const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildBody({ model, messages, thinkingMode, stream: true, includeUsage: true })),
          signal: controller.signal
        })
        if (settled) { void res.body?.cancel().catch(() => {}); return }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          finish('failed', friendlyError(res.status, data?.error?.code, data?.error?.message))
          return
        }
        if (!res.body) { finish('failed', '浏览器不支持流式响应，请更换较新的浏览器'); return }
        reader = res.body.getReader()
        const decoder = new TextDecoder('utf-8')
        let buffer = ''
        let dataLines = []
        const processEvent = () => {
          if (settled) return
          const payload = dataLines.join('\n').trim()
          dataLines = []
          if (!payload) return
          if (payload === '[DONE]') {
            finish(finishReason === 'length' ? 'failed' : 'completed', finishReason === 'length' ? '回复达到长度上限，已保留现有内容' : undefined)
            return
          }
          let json
          try { json = JSON.parse(payload) } catch { finish('failed', '流式响应格式异常，已保留收到的内容'); return }
          if (json.error) { finish('failed', json.error.message || '模型服务返回错误'); return }
          if (json.usage) usage = json.usage
          const choice = json.choices?.[0]
          if (choice?.finish_reason) finishReason = choice.finish_reason
          if (choice?.delta?.reasoning_content) onReasoning?.(choice.delta.reasoning_content)
          if (!settled && choice?.delta?.content) onDelta?.(choice.delta.content)
        }
        const processLine = (line) => {
          if (line === '') { processEvent(); return }
          if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
        }
        const consumeLines = (final = false) => {
          while (!settled) {
            const index = buffer.search(/[\r\n]/)
            if (index < 0) break
            if (!final && buffer[index] === '\r' && index === buffer.length - 1) break
            const line = buffer.slice(0, index)
            const width = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1
            buffer = buffer.slice(index + width)
            processLine(line)
          }
          if (final && !settled) {
            if (buffer) processLine(buffer)
            buffer = ''
            processEvent()
          }
        }
        while (!settled) {
          const { done, value } = await reader.read()
          if (settled) return
          if (done) {
            buffer += decoder.decode()
            consumeLines(true)
            if (!settled) {
              const complete = finishReason === 'stop'
              finish(complete ? 'completed' : 'failed', complete ? undefined : '连接提前结束，已保留收到的内容，可以重试')
            }
            return
          }
          bumpIdle()
          buffer += decoder.decode(value, { stream: true })
          consumeLines()
        }
      } catch (err) {
        if (!settled) finish(signal?.aborted ? 'stopped' : 'failed', signal?.aborted ? undefined : `网络错误：${err?.message || '连接中断'}`)
      }
    })()
  })
}

export async function fetchModels({ signal, timeoutMs } = {}) {
  try {
    const { res, data } = await requestJson(`${DEEPSEEK_BASE}/models`, {
      headers: {}
    }, { signal, timeoutMs })
    if (!res.ok) return { ok: false, status: res.status, message: friendlyError(res.status, null, data?.error?.message) }
    if (!Array.isArray(data?.data)) return { ok: false, message: '接口未返回有效模型列表' }
    return { ok: true, ids: data.data.map((m) => m?.id).filter((id) => typeof id === 'string') }
  } catch (err) {
    return requestFailure(err)
  }
}
