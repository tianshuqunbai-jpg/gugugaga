import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024 })
const privatePath = /(?:^|\/)(?:data|logs|chat-history|chat_history|conversations|exports?|backups?|预览|_avatars|node_modules|dist|\.gradle|\.kotlin|build)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:db(?:-.*)?|sqlite\d?(?:-.*)?|pem|key|jks|keystore|apk|aab|zip|7z|log)$|星语-(?:备份|聊天|记忆)|(?:^|\/)(?:credentials.*\.json|secrets.*\.json|google-services\.json|\.npmrc|local\.properties)$/i
let failures = 0
function scan(file, bytes, scope) {
  if (privatePath.test(file) && file !== '.env.example') {
    console.error(`${scope}: 私人数据或构建产物路径：${file}`); failures++
  }
  if (bytes.length > 50 * 1024 * 1024) { console.error(`${scope}: 大文件：${file}`); failures++ }
  // Search bytes even for binaries; report only path and line, never matched values.
  const text = bytes.toString('utf8')
  const patterns = [
    /\b(?:sk-|ghp_|github_pat_|xox[baprs]-|AIza)[A-Za-z0-9_-]{16,}/g,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    /^\s*(?:export\s+)?(?:DEEPSEEK_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|GITHUB_PAT|ANTHROPIC_API_KEY)\s*=\s*[^\s#]+/gm,
    /https?:\/\/[^\s\/]+:[^\s\/@]+@/g,
    /(?:api[_-]?key|secret|access[_-]?token|password)\s*[=:]\s*['"`]([^'"`\n]{16,})['"`]/gi
  ]
  for (const regex of patterns) for (const match of text.matchAll(regex)) {
    console.error(`${scope}: 疑似密钥：${file}:${text.slice(0, match.index).split('\n').length}`); failures++
  }
  if (file.endsWith('.json') && !file.endsWith('package-lock.json')) {
    try {
      const data = JSON.parse(text)
      const backup = data.app === 'xingyu' && (data.conversations || data.session || data.memoryByPartition)
      const runtime = Array.isArray(data.conversations) || (Array.isArray(data.messages) && !file.startsWith('tests/'))
      if (backup || runtime) { console.error(`${scope}: 疑似聊天存档：${file}`); failures++ }
    } catch { /* not JSON */ }
  }
}
const candidates = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString().split('\0').filter(Boolean)
for (const file of new Set(candidates)) scan(file, readFileSync(resolve(root, file)), '工作区')
const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).toString().split('\0').filter(Boolean)
for (const file of staged) scan(file, git(['show', `:${file}`]), '暂存区')
const objects = git(['rev-list', '--objects', '--all']).toString().trim().split('\n').filter(Boolean)
let blobs = 0
for (const line of objects) {
  const space = line.indexOf(' ')
  const oid = space < 0 ? line : line.slice(0, space)
  const file = space < 0 ? '' : line.slice(space + 1)
  if (git(['cat-file', '-t', oid]).toString().trim() !== 'blob') continue
  scan(file, git(['cat-file', 'blob', oid]), 'Git 历史'); blobs++
}
console.log(`已检查 ${new Set(candidates).size} 个待上传文件、${staged.length} 个暂存文件、${blobs} 个历史 blob；${failures} 项问题。未输出密钥值。`)
process.exitCode = failures ? 1 : 0
