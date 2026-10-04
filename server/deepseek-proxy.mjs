import { Readable } from 'node:stream'

const UPSTREAM = 'https://api.deepseek.com'
const PREFIX = '/api/deepseek'
const MAX_BODY = 16 * 1024 * 1024
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function json(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify({ error: { message } }))
}

// The secret is read only by Node. Never serialize this configuration to Vite's client.
export function createDeepSeekProxy({ env = process.env, fetchImpl = fetch } = {}) {
  return async function deepSeekProxy(req, res, next = () => json(res, 404, '接口不存在')) {
    const pathname = req.url?.split('?')[0]
    if (!pathname?.startsWith(PREFIX)) return next()
    let host
    try { host = new URL(`http://${req.headers.host}`) } catch { return json(res, 403, '只允许本机访问') }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname) ||
        (req.socket.remoteAddress && !LOOPBACK.has(req.socket.remoteAddress))) {
      return json(res, 403, '只允许本机访问')
    }
    if (req.headers.origin) {
      let origin
      try { origin = new URL(req.headers.origin) } catch { return json(res, 403, '请求来源不受信任') }
      if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== host.host) {
        return json(res, 403, '请求来源不受信任')
      }
    }
    const route = pathname.slice(PREFIX.length)
    if (!['/models', '/chat/completions'].includes(route)) return json(res, 404, '接口不存在')
    if (req.method !== (route === '/models' ? 'GET' : 'POST')) return json(res, 405, '请求方法不支持')
    const apiKey = env.DEEPSEEK_API_KEY?.trim()
    if (!apiKey) return json(res, 503, '请在服务端设置 DEEPSEEK_API_KEY 后重启服务')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 180000)
    res.on('close', () => { if (!res.writableFinished) controller.abort() })
    req.on('aborted', () => controller.abort())
    try {
      let body
      if (req.method === 'POST') {
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > MAX_BODY) { json(res, 413, '请求内容过大'); return }
          chunks.push(chunk)
        }
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed
        try { parsed = JSON.parse(text) } catch { return json(res, 400, '请求必须是 JSON') }
        if (!parsed || !Array.isArray(parsed.messages) || typeof parsed.model !== 'string') {
          return json(res, 400, '请求缺少模型或消息')
        }
        body = JSON.stringify(parsed)
      }
      const upstream = await fetchImpl(`${UPSTREAM}${route}`, {
        method: req.method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        ...(body ? { body } : {}), signal: controller.signal, redirect: 'error'
      })
      if (!upstream.ok) {
        // Provider error bodies may include request details; never relay them or log them.
        void upstream.body?.cancel().catch(() => {})
        return json(res, upstream.status, `DeepSeek 请求失败（HTTP ${upstream.status}）`)
      }
      if (!upstream.body) return json(res, 502, '服务商返回空响应')
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
      })
      res.flushHeaders?.()
      for await (const chunk of Readable.fromWeb(upstream.body)) {
        if (res.destroyed) break
        if (!res.write(chunk)) {
          await new Promise(resolve => {
            const done = () => { res.off('drain', done); res.off('close', done); resolve() }
            res.once('drain', done); res.once('close', done)
          })
        }
      }
      if (!res.destroyed) res.end()
    } catch {
      if (!res.headersSent && !res.destroyed) json(res, 502, '无法连接 DeepSeek，请稍后重试')
      else if (!res.destroyed) res.destroy()
    } finally { clearTimeout(timeout) }
  }
}
