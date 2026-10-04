import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const revision = '75c43b069aac4d136ba6bc1122f995fedcfd2781'
const hashes = {
  'tokenizer.json': '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26',
  'onnx/model.onnx': '69a0b846f4f116b5e6aabf9546ea6754d02264f3211a13a1bd69b31b8040749a'
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
for (const [file, hash] of Object.entries(hashes)) {
  const target = resolve(root, 'public/models/Xenova/bge-small-zh-v1.5', file)
  const existing = await readFile(target).catch(() => null)
  // Retain the project's existing local ONNX variant as well as the pinned upstream model.
  const localVariant = file === 'onnx/model.onnx' && existing && digest(existing) === '4e0160ff50efd0efc49e33569e9721803cee59d20d2da774be4d3ce70ce12c2b'
  if (existing && (digest(existing) === hash || localVariant)) { console.log(`已验证模型资源：${file}`); continue }
  const response = await fetch(`https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/${revision}/${file}`, { signal: AbortSignal.timeout(300000) })
  if (!response.ok) throw new Error(`模型资源下载失败：HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (digest(bytes) !== hash) throw new Error(`模型资源校验失败：${file}`)
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.download`
  try { await writeFile(temp, bytes); await rename(temp, target) } finally { await rm(temp, { force: true }) }
  console.log(`已下载并验证模型资源：${file}`)
}
await mkdir(resolve(root, 'public/wasm'), { recursive: true })
for (const file of ['ort-wasm.wasm', 'ort-wasm-threaded.wasm', 'ort-wasm-simd.wasm', 'ort-wasm-simd-threaded.wasm']) {
  await copyFile(resolve(root, 'node_modules/onnxruntime-web/dist', file), resolve(root, 'public/wasm', file))
}
console.log('本地模型和 WASM 已就绪；这些文件由 .gitignore 排除。')
