import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDeepSeekProxy } from './deepseek-proxy.mjs'

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist')
if (!existsSync(resolve(dist, 'index.html'))) throw new Error('请先运行 npm run build')
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' }
const proxy = createDeepSeekProxy()
const server = createServer((req, res) => {
  void proxy(req, res, () => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return }
    let pathname
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname) } catch { res.writeHead(400); res.end(); return }
    const file = resolve(dist, `.${pathname}`)
    if ((file !== dist && !file.startsWith(dist + sep)) || pathname.split('/').some(p => p.startsWith('.')) || pathname.startsWith('/api/')) {
      res.writeHead(404); res.end(); return
    }
    let target = file
    if (!existsSync(target) || !statSync(target).isFile()) {
      if (extname(pathname)) { res.writeHead(404); res.end(); return }
      target = resolve(dist, 'index.html')
    }
    res.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' })
    if (req.method === 'HEAD') res.end()
    else createReadStream(target).on('error', () => res.destroy()).pipe(res)
  })
})
server.listen(Number(process.env.PORT || 5173), '127.0.0.1', () => {
  console.log(`星语已启动：http://localhost:${server.address().port}`)
})
