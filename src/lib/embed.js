// 本地语义嵌入：轻量 BERT 分词（WordPiece）+ onnxruntime-web 直接推理 bge-small-zh-v1.5。
// 模型在 public/models/，wasm 在 public/wasm/，全部本地加载、不联网。
// 该 ONNX 输出名为 "output"（等价 last_hidden_state），这里做 attention-mask 平均池化 + L2 归一化。
import ortDefault from 'onnxruntime-web'

// 兼容打包器与 Node 的两种模块解析结果
const ort = ortDefault?.env ? ortDefault : ortDefault?.default

const MODEL_DIR = '/models/Xenova/bge-small-zh-v1.5'
const MAX_LEN = 300
const MAX_TOKENS = 512
const CLS = 101
const SEP = 102
const UNK = 100
const PAD = 0

let initPromise = null
let state = { vocab: null, session: null }

function normalizeAndPreTokenize(text) {
  let t = String(text).replace(/[\u0000\uFFFD]/g, '')
  // handle_chinese_chars：在每个汉字两侧加空格，让中文按单字切分
  t = t.replace(/([\p{Script=Han}])/gu, ' $1 ')
  return t
    .split(/[\s\u3000]+/u)
    .filter(Boolean)
    .flatMap((w) => w.split(/([^\w\s])/u))
    .filter(Boolean)
}

// 标准 BERT WordPiece：最长前缀匹配，非首子词加 "##"，整词失配返回 [UNK]
function wordpiece(word, vocab) {
  const tokens = []
  let remaining = word
  let first = true
  while (remaining.length > 0) {
    let end = remaining.length
    let matched = null
    while (end > 0) {
      const cand = first ? remaining.slice(0, end) : `##${remaining.slice(0, end)}`
      if (vocab.has(cand)) {
        matched = cand
        break
      }
      end--
    }
    if (!matched) return [UNK]
    tokens.push(matched)
    remaining = remaining.slice(end)
    first = false
  }
  return tokens
}

function tokenizeOne(text, vocab) {
  const words = normalizeAndPreTokenize(text)
  const ids = [CLS]
  for (const w of words) {
    if (vocab.has(w)) {
      ids.push(vocab.get(w))
    } else {
      for (const tok of wordpiece(w, vocab)) {
        ids.push(vocab.has(tok) ? vocab.get(tok) : UNK)
      }
    }
    if (ids.length >= MAX_TOKENS - 1) break
  }
  ids.push(SEP)
  return ids.slice(0, MAX_TOKENS)
}

async function init() {
  if (!initPromise) {
    initPromise = (async () => {
      if (!ort?.env || !ort?.InferenceSession) throw new Error('onnxruntime-web 加载失败')
      if (typeof window !== 'undefined') {
        ort.env.wasm.wasmPaths = '/wasm/'
      } else {
        ort.env.wasm.numThreads = 1 // Node 测试：使用默认的本地 wasm 路径
      }
      const [tokBuf, modelBuf] = await Promise.all([
        fetch(`${MODEL_DIR}/tokenizer.json`).then((r) => {
          if (!r.ok) throw new Error(`词表加载失败 HTTP ${r.status}`)
          return r.arrayBuffer()
        }),
        fetch(`${MODEL_DIR}/onnx/model.onnx`).then((r) => {
          if (!r.ok) throw new Error(`模型加载失败 HTTP ${r.status}`)
          return r.arrayBuffer()
        })
      ])
      const tokJson = JSON.parse(new TextDecoder('utf-8').decode(tokBuf))
      const vocabRaw = tokJson?.model?.vocab
      if (!vocabRaw) throw new Error('词表格式异常')
      const vocab = new Map(Object.entries(vocabRaw).map(([k, v]) => [k, Number(v)]))
      state.session = await ort.InferenceSession.create(modelBuf)
      state.vocab = vocab
    })().catch((err) => {
      initPromise = null
      state = { vocab: null, session: null }
      throw err
    })
  }
  return initPromise.then(() => state)
}

function toBigIntArray(arr) {
  return BigInt64Array.from(arr.map((x) => BigInt(x)))
}

// 对一批短文本做句子嵌入，返回 [n, dim] 的二维普通数组；任何失败都会抛异常
export async function embedTexts(texts) {
  const { vocab, session } = await init()
  const clean = texts.map((t) => String(t ?? '').trim().slice(0, MAX_LEN) || ' ')
  const rows = clean.map((t) => tokenizeOne(t, vocab))
  const n = rows.length
  const L = Math.max(...rows.map((r) => r.length))
  const flatIds = []
  const flatMask = []
  const flatTypes = []
  for (const row of rows) {
    for (let j = 0; j < L; j++) {
      flatIds.push(j < row.length ? row[j] : PAD)
      flatMask.push(j < row.length ? 1 : 0)
      flatTypes.push(0)
    }
  }
  const feeds = {
    input_ids: new ort.Tensor('int64', toBigIntArray(flatIds), [n, L]),
    attention_mask: new ort.Tensor('int64', toBigIntArray(flatMask), [n, L]),
    token_type_ids: new ort.Tensor('int64', toBigIntArray(flatTypes), [n, L])
  }
  const out = await session.run(feeds)
  const hidden = out.output ?? out.last_hidden_state
  if (!hidden) throw new Error('模型输出格式异常')
  const dim = hidden.dims[2]
  const data = hidden.data
  const vecs = []
  for (let i = 0; i < n; i++) {
    const v = new Float32Array(dim)
    let cnt = 0
    for (let j = 0; j < L; j++) {
      if (j >= rows[i].length) continue
      const off = (i * L + j) * dim
      for (let d = 0; d < dim; d++) v[d] += data[off + d]
      cnt++
    }
    if (cnt === 0) cnt = 1
    let norm = 0
    for (let d = 0; d < dim; d++) {
      v[d] /= cnt
      norm += v[d] * v[d]
    }
    norm = Math.sqrt(norm) || 1
    for (let d = 0; d < dim; d++) v[d] /= norm
    vecs.push(Array.from(v))
  }
  return vecs
}

// 已归一化的向量点积 = 余弦相似度
export function dotScore(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
