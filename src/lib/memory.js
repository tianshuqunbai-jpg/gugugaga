import { chatNonStream } from './deepseek.js'
import { STORAGE_KEYS } from './constants.js'
import { readSecure, writeSecure } from './crypto.js'
import { isSensitiveText } from './consent.js'

const EXTRACT_SKIP_MIN = 6

// 可信度模型（借鉴 Ackem：confidence 0~1 + 指数衰减 + 注入门槛）
// 衰减只影响"是否注入"，绝不删除存储：老记忆永久保留，权重可以自然降到接近 0
const DEFAULT_CONFIDENCE = 0.8
const CONFIRM_BOOST = 0.1 // 再次确认同一事实时提升
const NEGATION_CONFIDENCE = 0.9 // 用户明确否定/更改后，新状态可信度
const MIN_CONFIDENCE_INJECT = 0.55 // 默认低于此值不注入（对齐 Ackem）；用户明确提起时仍可召回
const DECAY_LAMBDA = 0.005 // 每日衰减系数（约 138 天半衰）

const MERGE_SIMILARITY = 0.78 // 高度相似 → 同一事实再次确认
const NEGATION_MERGE_SIMILARITY = 0.9 // 去否定词后几乎相同 → 同一事实的新状态
const CONFLICT_SIM_MIN = 0.55 // 高度相近但未到合并阈值 → 可能冲突
const SEMANTIC_CANDIDATE_CAP = 24 // 语义重排的字面候选数
const RECENT_POOL_CAP = 12 // 语义重排的近期补充池
const RECENT_WINDOW_DAYS = 30
const SEMANTIC_RESCUE_THRESHOLD = 0.45 // 补充池事实需要达到的语义相关度
const SEMANTIC_BONUS = 0.4 // 语义对字面分的加成
const PROFILE_MIN_CONFIDENCE = 0.62
// 档案原本要求事实"满 3 天"才算稳定，导致刚聊出来的重要设定进不了档案，
// 于是同一个问题会被反复问（用户提过的事，隔几十条又要重新讲一遍）。
// 现在改成：除了"老"和"可信"，重要事实（见下）不设年龄门槛，直接常驻。
const PROFILE_STABLE_DAYS = 0.05
const PROFILE_IMPORTANT_DAYS = 0
const PROFILE_MAX = 5
// 档案优先纳入的"核心设定"类事实：命中就无视年龄门槛常驻，
// 让身世、来历、重要事件这类信息永远在提示词里，不依赖检索运气。
const PROFILE_IMPORTANT_RE = /来自|出身|地球|故乡|家园|传承|觉醒|身世|五百|逃离|逃亡|星舰|星域|魔法/
// 实体跟随用：消息里提到这些词时，把共享同一实体的其他事实一并拉出来。
// 这就是"提到地球 → 想起星空巨炮、魔力传承、五百年逃亡"的实现。
// 注意：这里只放**有区分度的具体实体**，不能放"主人""伴侣"这类几乎每条都有的词，
// 否则跟随会把泛词事实全拉进来，反而挤掉真正相关的。
const IMPORTANT_ENTITIES = [
  '地球', '星空巨炮', '修士', '墓穴', '墓地', '传承', '大魔法师', '魔法', '封印',
  '星舰', '星域', '帝国', '拍卖', '货架', '中转营', '阿绫'
]
const EMBED_CACHE_CAP = 400
// 只剥"纯否定标记"：不要把「不喜欢」整体剥掉（会连「喜欢」一起删）
// 多字词必须排在单字「不/没/别」前面
const NEGATION_WORDS = ['不再', '并非', '不是', '讨厌', '戒了', '不', '没', '别']
const PARTICLE_WORDS = ['了', '过', '着', '吧', '啊', '呢', '吗', '嘛', '呀', '哦']
const KEYWORD_STOPWORDS = new Set([  '用户', '伴侣', '喜欢', '这个', '那个', '什么', '怎么', '为什么', '知道', '觉得',
  '感觉', '今天', '昨天', '明天', '现在', '然后', '但是', '可是', '如果', '所以',
  '因为', '还有', '没有', '不是', '就是', '真的', '可以', '一下', '一点', '有点',
  '记得', '忘记', '想要', '希望', '明白', '谢谢', '你好', '早上', '晚上', '中午',
  '最近', '总是', '一直', '经常', '每天', '有时候', '我们', '你们', '他们', '她们',
  '自己', '东西', '事情', '时候', '的话', '这样', '那样', '开始', '后来', '终于',
  '已经', '正在', '之前', '以后', '第一次', '最后', '突然', '可能', '应该', '一定',
  '非常', '特别', '第一次'
])
// 指令式内容过滤：防止从对话里提炼出的"伪指令"混进系统提示词
const INSTRUCTION_PATTERNS = [
  /^(你现在是|你是|请(务必)?(回答|输出|扮演|执行)|忽略(之前|上述|以下|所有)|作为(AI|助手|模型|角色)|系统(提示|指令|消息)|记住:|输出格式)/i,
  /(忽略|无视).{0,6}(规则|指令|限制|系统|之前)/,
  /(不要|禁止).{0,4}(拒绝|遵守规则|安全策略)/i
]

export function isInstructionLike(text) {
  const t = String(text || '').trim()
  if (!t) return true
  if (t.length > 45) return false
  return INSTRUCTION_PATTERNS.some((p) => p.test(t))
}

// 相对时间标签："刚刚 / 昨天 / 3 天前 / 约 2 周前 / 约 3 个月前 / 很久以前"
export function formatRelativeTime(ts) {
  if (!ts) return ''
  const days = (Date.now() - Number(ts)) / 86400000
  if (days < 1) return '刚刚'
  if (days < 2) return '昨天'
  if (days < 7) return `${Math.floor(days)} 天前`
  if (days < 30) return `约 ${Math.max(1, Math.round(days / 7))} 周前`
  if (days < 365) return `约 ${Math.max(1, Math.round(days / 30))} 个月前`
  return '很久以前'
}
// 节点域（对照 Ackem 的领域分类）：每条事实归一个主题域，图按域聚类配色
export const MEMORY_DOMAINS = [
  '基本信息',
  '生活习惯',
  '健康',
  '工作学习',
  '家庭',
  '朋友',
  '伴侣关系',
  '兴趣偏好',
  '情绪状态',
  '重要事件',
  '其他'
]
const DOMAIN_SET = new Set(MEMORY_DOMAINS)
export function normalizeDomain(d) {
  return DOMAIN_SET.has(d) ? d : '其他'
}

// 本地主题域猜测：模型不可用时按关键词自动归类，避免全落"其他"
const DOMAIN_RULES = [
  { kw: ['失眠', '睡', '病', '疼', '药', '医院', '体检', '运动', '锻炼'], domain: '健康' },
  { kw: ['吃', '喝', '作息', '起床', '熬夜', '咖啡', '茶', '烟', '酒', '睡前'], domain: '生活习惯' },
  { kw: ['工作', '上班', '学习', '考试', '写', '项目', '公司', '学校', '读书', '论文', '课程'], domain: '工作学习' },
  { kw: ['爸', '妈', '父母', '孩子', '家', '姐姐', '哥哥', '妹妹', '弟弟', '外婆'], domain: '家庭' },
  { kw: ['朋友', '闺蜜', '兄弟', '同事', '同学'], domain: '朋友' },
  { kw: ['男朋友', '女朋友', '老公', '老婆', '伴侣', '恋人', '对象', '亲密'], domain: '伴侣关系' },
  { kw: ['喜欢', '爱好', '游戏', '小说', '电影', '歌', '旅行', '画画', '跑步', '爬山', '星星', '猫', '狗'], domain: '兴趣偏好' },
  { kw: ['难过', '开心', '焦虑', '压力', '累', '崩溃', '哭', '烦', '害怕', '孤独', '委屈'], domain: '情绪状态' },
  { kw: ['生日', '结婚', '搬家', '旅行', '毕业', '离职', '养'], domain: '重要事件' },
  { kw: ['名字', '年龄', '住', '城市', '职业', '星座'], domain: '基本信息' }
]
export function guessDomain(text) {
  const t = String(text || '')
  for (const rule of DOMAIN_RULES) {
    if (rule.kw.some((k) => t.includes(k))) return rule.domain
  }
  return '其他'
}
const STRIP_FILLERS = [
  '有时候', '最近', '今天', '昨天', '明天', '现在', '然后', '但是', '可是', '因为',
  '所以', '就是', '真的', '总是', '一直', '经常', '每天', '感觉', '觉得', '有点',
  '已经', '正在', '开始', '后来', '想要', '希望', '准备', '打算', '非常', '特别',
  '可能', '应该', '好像', '还是', '不过', '其实', '喜欢', '讨厌', '习惯', '养了',
  '养着', '有一只', '有一只叫', '一只叫', '住在', '曾经', '以前', '平时', '用户',
  '我们', '你们', '我', '你', '他', '她'
]
const STRIP_VERBS = ['喝', '吃', '玩', '看', '听', '买', '养', '学', '写', '读', '去', '来', '用', '聊', '唱', '画', '开', '做', '说', '爱', '想']
const SPLIT_CONNECTORS = ['但是', '而且', '还有', '然后', '后来', '所以', '因为', '可是', '就是', '其实', '但', '又', '也', '还', '就', '才', '更', '都', '却']

const EXTRACT_PROMPT = `你是记忆提炼器。从下面这轮对话中，提炼值得长期记住的信息。
规则：
- 只提炼用户主动分享的稳定事实、偏好、习惯、重要事件、人物关系、计划等。
- 临时心情（"今天好累"）不提炼；反复出现的状态可以提炼。
- 不要提炼对话中伴侣编造的内容；拿不准就不提炼。
- 每条事实 10~25 字，陈述句，用「用户」指代。
- 每条事实给出 4~6 个详细关键词（人名、物品、地点、习惯、事件名、特征等，越具体越好，用于日后检索），不要用「用户」「喜欢」这类泛词。
- 每条事实从以下主题域中选一个最贴切的：基本信息/生活习惯/健康/工作学习/家庭/朋友/伴侣关系/兴趣偏好/情绪状态/重要事件/其他。
- 每条事实附 src：它在输入里属于第几段（按"1." "2." 的编号，填数字）。
- 每条事实附 quote：从该段**用户的原话**里摘出最能支撑它的一小段（不超过 30 字，必须原文，不要改写）；摘不出来就填空字符串。
- summary 用一句话概括这轮对话的主题（10~30 字）。
- 因果链：只有当用户明确说出因果关系（因为…所以…、导致、于是、结果、才会、后来就）时，才输出 {"cause": "原因事实", "effect": "结果事实"}；cause 与 effect 必须来自 facts 列表中的原文，没把握就不输出。
严格输出 JSON：{"facts": [{"text": "...", "keywords": ["...", "..."], "domain": "...", "src": 1, "quote": "..."}], "summary": "...", "causals": [{"cause": "...", "effect": "..."}]}，不要输出其他文字。`

const CHUNK_EXTRACT_PROMPT = `你是记忆提炼器。下面是一段对话记录（用户与伴侣的往来，按轮编号）。
规则：
- 只提炼用户主动分享的稳定事实、偏好、习惯、重要事件、人物关系、计划。
- 临时心情不提炼；反复出现的状态可以提炼。
- 不要提炼伴侣编造的内容；拿不准就不提炼。
- 每条事实 10~25 字，陈述句，用「用户」指代。
- 每条事实给出 4~6 个详细关键词（人名、物品、地点、习惯、事件名、特征等，越具体越好），不要用「用户」「喜欢」这类泛词。
- 每条事实从以下主题域中选一个最贴切的：基本信息/生活习惯/健康/工作学习/家庭/朋友/伴侣关系/兴趣偏好/情绪状态/重要事件/其他。
- 每条事实附 src：它来自输入里的第几轮（按"1." "2." 的编号，填数字）。
- 每条事实附 quote：从该轮**用户的原话**里摘出最能支撑它的一小段（不超过 30 字，必须原文，不要改写）；摘不出来就填空字符串。
- summary 用一句话概括这段对话的主题（10~30 字）。
- 因果链：只有当用户明确说出因果关系（因为…所以…、导致、于是、结果、才会、后来就）时，才输出 {"cause": "原因事实", "effect": "结果事实"}；cause 与 effect 必须来自本段 facts 列表中的原文，没把握就不输出。
严格输出 JSON：{"facts": [{"text": "...", "keywords": ["...", "..."], "domain": "...", "src": 1, "quote": "..."}], "summary": "...", "causals": [{"cause": "...", "effect": "..."}]}，不要输出其他文字。`

let uid = 0
const nextId = () => `mem-${Date.now().toString(36)}-${++uid}`

export function emptyMemory() {
  return { version: 3, facts: [], summaries: [], causalLinks: [] }
}

export function normalizeConfidence(raw) {
  const n = Number(raw)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : DEFAULT_CONFIDENCE
}

export function formatConfidence(c) {
  return `${Math.round(normalizeConfidence(c) * 100)}%`
}

function norm(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
}

function bigrams(s) {
  const out = new Set()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

// 0~1 的粗略相似度（汉字 bigram 重合率）
// 导出以便离线工具复用（比如给旧存档回填出处时，要用和检索完全一致的相似度口径）
export function similarity(a, b) {
  const na = norm(a)
  const nb = norm(b)
  if (!na || !nb) return 0
  const ba = bigrams(na)
  const bb = bigrams(nb)
  let hit = 0
  for (const g of ba) if (bb.has(g)) hit++
  return hit / Math.max(1, Math.sqrt(ba.size * bb.size))
}

// 兜底关键词：整词优先，剥填充词/单字动词，绝不吐无意义 2 字碎片
export function deriveKeywords(text) {
  let body = String(text || '')
    .trim()
  let again = true
  while (again) {
    again = false
    for (const f of STRIP_FILLERS) {
      if (body.length > f.length && body.startsWith(f)) {
        body = body.slice(f.length)
        again = true
        break
      }
    }
  }
  const rawSegs = body
    .split(/[，。！？、；：\s（）()""''「」…\-—]/u)
    .map((s) => s.trim())
    .filter(Boolean)
  const segments = []
  for (const seg of rawSegs) {
    segments.push(...seg.split(new RegExp(`(${SPLIT_CONNECTORS.join('|')})`, 'u')).filter(Boolean))
  }
  const out = []
  const push = (w) => {
    const len = [...w].length
    if (len < 2 || len > 8) return
    if (KEYWORD_STOPWORDS.has(w)) return
    if (!out.includes(w)) out.push(w)
  }
  for (let seg of segments) {
    if (out.length >= 6) break
    let a2 = true
    while (a2) {
      a2 = false
      for (const f of STRIP_FILLERS) {
        if (seg.length > f.length && seg.startsWith(f)) {
          seg = seg.slice(f.length)
          a2 = true
          break
        }
      }
    }
    let a3 = true
    while (a3) {
      a3 = false
      for (const v of STRIP_VERBS) {
        if (seg.length > v.length && seg.startsWith(v) && [...seg.slice(v.length)].length >= 2) {
          seg = seg.slice(v.length)
          a3 = true
          break
        }
      }
    }
    push(seg)
    const len = [...seg].length
    if (len > 6) {
      const tail = [...seg].slice(-3).join('')
      push(tail)
    }
  }
  return out.slice(0, 6)
}

// 从用户消息里提取可能成为关键词的显著词（2~12 字，排除停用词）
const LEADING_FILLERS = [
  '有时候', '最近', '今天', '昨天', '明天', '现在', '然后', '但是', '可是', '因为',
  '所以', '就是', '真的', '总是', '一直', '经常', '每天', '感觉', '觉得', '有点',
  '已经', '正在', '开始', '后来', '想要', '希望', '准备', '打算', '非常', '特别',
  '可能', '应该', '好像', '还是', '不过', '其实', '用户', '我们', '你们', '我',
  '你', '他', '她'
]
function salientWords(text) {
  const toks = String(text || '')
    .split(/[，。！？、；：\s（）()""''「」…\-—]/u)
    .map((s) => s.trim())
    .filter(Boolean)
  const out = []
  for (let raw of toks) {
    if (out.length >= 3) break
    let tok = raw
    let again = true
    while (again) {
      again = false
      for (const f of LEADING_FILLERS) {
        if (tok.length > f.length && tok.startsWith(f)) {
          tok = tok.slice(f.length)
          again = true
          break
        }
      }
    }
    const len = [...tok].length
    if (len < 2) continue
    if (len > 4) {
      // 长句：剥完填充词后，取末尾 2 字作为候选（中文显著词常在句尾）
      const tail = [...tok].slice(-2).join('')
      if (tail && !KEYWORD_STOPWORDS.has(tail) && !/^[\d\s]+$/.test(tail) && !out.includes(tail)) {
        out.push(tail)
      }
      continue
    }
    if (KEYWORD_STOPWORDS.has(tok) || /^[\d\s]+$/.test(tok)) continue
    if (!out.includes(tok)) out.push(tok)
  }
  return out
}

function stripNegation(text) {
  let t = String(text || '')
  for (const w of [...NEGATION_WORDS, ...PARTICLE_WORDS]) t = t.split(w).join('')
  return t
}

// 新旧事实关系：'same-confirm'（同一事实再次确认）| 'same-update'（同一事实被否定/更改）| null
export function compareFacts(a, b) {
  const raw = similarity(a, b)
  if (raw >= MERGE_SIMILARITY) return { kind: 'same-confirm', raw }
  const stripped = similarity(stripNegation(a), stripNegation(b))
  if (stripped >= NEGATION_MERGE_SIMILARITY) return { kind: 'same-update', raw, stripped }
  if (raw >= CONFLICT_SIM_MIN) return { kind: 'possible-conflict', raw }
  return null
}

function mergeKeywords(a, b) {
  const out = [...(a || [])]
  for (const k of b || []) {
    if (k && typeof k === 'string' && k.trim() && !out.includes(k)) out.push(k)
  }
  return out.slice(0, 10)
}

// 读原始存储（不做衰减）：所有需要"改完再存"的写路径都应走这里，
// 避免把衰减后的置信度误写回存储，造成双重衰减

// ---- 记忆分区：长期记忆必须按人格隔离 ----
// 之前所有记忆共用一个全局 key，换人格后 A 的剧情照样被检索进 B 的提示词。
// 现在每个人格一个 key：xingyu.memory.v1::<人格id>
let activePersonalityId = ''

function safePid(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '') || 'default'
}

// 不传 personalityId 时用当前作用域；传了就直接定位那个分区。
// 备份要一次性读取/还原全部人格的记忆，必须能绕开作用域直接按分区操作
function memoryKeyFor(personalityId) {
  const pid = personalityId === undefined ? activePersonalityId : personalityId
  return `${STORAGE_KEYS.memory}::${safePid(pid)}`
}

// 切换人格时必须调用：决定之后所有读/写落在哪个人格的记忆区
export function setMemoryScope(personalityId) {
  activePersonalityId = personalityId || ''
}

// 分区键的派生只此一处，导出的记忆对象用的就是这些键。
// 外部（如备份）需要按人格 id 取分区时必须调它，不能自己写一份清洗逻辑
export function partitionKeyOf(personalityId) {
  return safePid(personalityId)
}

// 旧版全局记忆只迁移一次，而且只迁给"第一个打开的人格"。
// 这里必须是全局一次性标记，不能按人格记：按人格记等于每个人格都认领一次，
// 旧剧情会被复制到所有分区（那正是这次要修的串味问题）
function isLegacyClaimed() {
  try {
    return Boolean(localStorage.getItem(STORAGE_KEYS.memoryMigrated))
  } catch {
    return false
  }
}

function markLegacyClaimed() {
  try {
    localStorage.setItem(STORAGE_KEYS.memoryMigrated, new Date().toISOString())
    return true
  } catch {
    return false
  }
}

// 首次读取时把旧版全局记忆迁移进当前人格的记忆区（一次性）
function adoptLegacyMemoryIfAny() {
  let legacyRaw = null
  try {
    legacyRaw = localStorage.getItem(STORAGE_KEYS.memory)
  } catch {
    return false
  }
  if (!legacyRaw) return false
  if (isLegacyClaimed()) return false
  // 分区已经存在时不能用旧全局快照覆盖它，即使迁移标记写入失败。
  if (localStorage.getItem(memoryKeyFor()) !== null) return false
  try {
    // readSecure 在锁定或解密失败时返回 null；绝不能把加密信封当成记忆 JSON。
    const plaintext = readSecure(STORAGE_KEYS.memory)
    if (!plaintext) return false
    const parsed = JSON.parse(plaintext)
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.facts) || (parsed.summaries !== undefined && !Array.isArray(parsed.summaries))) return false
    const normalized = sanitizeMemory(parsed)
    const content = JSON.stringify(normalized)
    writeSecure(memoryKeyFor(), content)
    if (readSecure(memoryKeyFor()) !== content) {
      localStorage.removeItem(memoryKeyFor())
      return false
    }
    if (!markLegacyClaimed()) {
      localStorage.removeItem(memoryKeyFor())
      return false
    }
    // 关键：迁移完立刻把旧全局 key 标记成已迁移（保留内容不删，便于用户找回），
    // 这样即使迁移标记哪天丢了，也不可能再从它这里读出第二份污染数据
    try {
      localStorage.setItem(
        `${STORAGE_KEYS.memory}::__migrated__`,
        JSON.stringify({ at: new Date().toISOString(), to: safePid(activePersonalityId) })
      )
    } catch {
      /* 标记写不进去也不影响本次迁移结果 */
    }
    return true
  } catch {
    // 旧全局记录原样保留，失败的目标分区也不挡住下次重试。
    try { localStorage.removeItem(memoryKeyFor()) } catch { /* 原记录仍在 */ }
    return false
  }
}

function readMemoryRaw() {
  try {
    // readSecure：分区 key 已被 crypto.js 的前缀匹配纳入保护范围，开了隐私锁也能正确解密
    const raw = readSecure(memoryKeyFor())
    if (raw) return JSON.parse(raw)
    if (adoptLegacyMemoryIfAny()) {
      const migrated = readSecure(memoryKeyFor())
      return migrated ? JSON.parse(migrated) : null
    }
    return null
  } catch {
    return null
  }
}

function readRawMemory(personalityId) {
  try {
    const raw =
      personalityId === undefined
        ? readMemoryRaw()
        : (() => {
            const s = readSecure(memoryKeyFor(personalityId))
            return s ? JSON.parse(s) : null
          })()
    if (!raw) return emptyMemory()
    return sanitizeMemory(raw)
  } catch {
    return emptyMemory()
  }
}

export function loadMemory(personalityId) {
  const mem = readRawMemory(personalityId)
  // 幂等读取：衰减只在内存里算，绝不写回存储；不因权重低删除任何事实，
  // 重复读取结果一致，老记忆永久保留
  const now = Date.now()
  const facts = mem.facts.map((f) => {
    const ageDays = (now - (f.lastRelevant || f.createdAt || now)) / 86400000
    const conf = normalizeConfidence(f.confidence) * Math.exp(-DECAY_LAMBDA * Math.max(0, ageDays))
    return { ...f, confidence: conf }
  })
  return { ...mem, facts }
}

function saveMemoryData(mem, personalityId) {
  try {
    // writeSecure：分区 key 走前缀匹配，开启隐私锁时同样加密落盘
    writeSecure(memoryKeyFor(personalityId), JSON.stringify(mem))
    return true
  } catch (err) {
    const message = `长期记忆保存失败：${err?.message || '存储不可用'}`
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('xingyu:memory-error', {
        detail: { message, personalityId: safePid(personalityId ?? activePersonalityId) }
      }))
    }
    throw new Error(message)
  }
}

export function sanitizeMemory(m) {
  const base = emptyMemory()
  if (!m || typeof m !== 'object') return base
  const facts = Array.isArray(m.facts) ? m.facts : []
  const summaries = Array.isArray(m.summaries) ? m.summaries : []
  const cleanFacts = facts
    .map((f) => {
      // 兼容旧格式：事实可能是纯字符串
      const obj = f && typeof f === 'object' ? f : { text: f }
      const text = typeof obj.text === 'string' ? obj.text.trim() : ''
      if (!text || isInstructionLike(text)) return null
      return {
        id: typeof obj.id === 'string' ? obj.id : nextId(),
        text: text.slice(0, 120),
        keywords: Array.isArray(obj.keywords)
          ? obj.keywords.filter((k) => typeof k === 'string' && k.trim()).slice(0, 10)
          : deriveKeywords(text),
        confidence: normalizeConfidence(obj.confidence),
        sensitive: Boolean(obj.sensitive),
        manual: Boolean(obj.manual),
        domain: obj.domain ? normalizeDomain(obj.domain) : guessDomain(text),
        createdAt: Number(obj.createdAt) || Date.now(),
        lastRelevant: Number(obj.lastRelevant) || 0,
        // 出处：这条事实来自第几轮对话，以及当时的原话摘录。
        // 用途是检索时能把"你的原话"一起带进提示词，避免提炼把细节压平。
        turn: obj.turn !== null && obj.turn !== undefined && Number.isInteger(Number(obj.turn)) ? Number(obj.turn) : null,
        sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : '',
        messageId: typeof obj.messageId === 'string' ? obj.messageId : '',
        quote: typeof obj.quote === 'string' ? obj.quote.trim().slice(0, 200) : '',
        conflicts: Array.isArray(obj.conflicts)
          ? obj.conflicts.filter((x) => typeof x === 'string').slice(0, 5)
          : []
      }
    })
    .filter(Boolean)
  const factIds = new Set(cleanFacts.map((f) => f.id))
  return {
    version: 3,
    facts: cleanFacts,
    summaries: summaries
      .filter((s) => s && typeof s.text === 'string' && s.text.trim())
      .map((s) => ({
        id: typeof s.id === 'string' ? s.id : nextId(),
        text: String(s.text).slice(0, 120),
        // Old summaries had no privacy marker; hide them outside intimate mode.
        sensitive: s.sensitive === undefined || Boolean(s.sensitive) || isSensitiveText(s.text),
        sessionId: typeof s.sessionId === 'string' ? s.sessionId : '',
        createdAt: Number(s.createdAt) || Date.now()
      })),
    causalLinks: Array.isArray(m.causalLinks)
      ? m.causalLinks
          .filter(
            (l) =>
              l &&
              typeof l.fromFactId === 'string' &&
              typeof l.toFactId === 'string' &&
              factIds.has(l.fromFactId) &&
              factIds.has(l.toFactId)
          )
          .map((l) => ({
            id: typeof l.id === 'string' ? l.id : nextId(),
            fromFactId: l.fromFactId,
            toFactId: l.toFactId,
            reason: typeof l.reason === 'string' ? l.reason.slice(0, 80) : '',
            createdAt: Number(l.createdAt) || Date.now()
          }))
      : []
  }
}

// 写入一条事实；返回 'add' | 'update'
function addFact(mem, fact, sensitive) {
  const text = String(fact?.text ?? fact).trim().slice(0, 120)
  if (!text || isInstructionLike(text)) return null
  const keywords = Array.isArray(fact?.keywords) ? fact.keywords : deriveKeywords(text)
  const domain = normalizeDomain(fact?.domain)
  // 出处（第几轮 + 原话摘录）：由调用方解析后回填，这里只负责落库
  const turn = fact?.turn !== null && fact?.turn !== undefined && Number.isInteger(Number(fact.turn)) ? Number(fact.turn) : null
  const sessionId = typeof fact?.sessionId === 'string' ? fact.sessionId : ''
  const messageId = typeof fact?.messageId === 'string' ? fact.messageId : ''
  const quote = typeof fact?.quote === 'string' ? fact.quote.trim().slice(0, 200) : ''
  let conflictId = null
  for (const f of mem.facts) {
    const cmp = compareFacts(f.text, text)
    if (!cmp) continue
    if (cmp.kind === 'same-update') {
      // 用户改变了说法（喜欢→不喜欢）：新状态覆盖旧状态，可信度拉满
      f.text = text
      f.keywords = mergeKeywords(f.keywords, keywords)
      f.confidence = NEGATION_CONFIDENCE
      f.lastRelevant = Date.now()
      f.sensitive = sensitive || f.sensitive
      if (fact?.domain) f.domain = domain
      if (turn !== null) f.turn = turn
      if (sessionId) f.sessionId = sessionId
      if (messageId) f.messageId = messageId
      if (quote) f.quote = quote
      return 'update'
    }
    if (cmp.kind !== 'same-confirm') {
      // 高度相近但含义可能已变：记下冲突指向，新事实照常入库
      if (cmp.kind === 'possible-conflict' && conflictId === null) {
        const shared = keywords.some((k) => (f.keywords || []).includes(k))
        if (shared) conflictId = f.id
      }
      continue
    }
    // 再次确认：合并关键词、提升可信度
    f.text = text.length > f.text.length ? text : f.text
    f.keywords = mergeKeywords(f.keywords, keywords)
    f.confidence = Math.min(0.98, normalizeConfidence(f.confidence) + CONFIRM_BOOST)
    f.lastRelevant = Date.now()
    if (fact?.domain) f.domain = domain
    if (turn !== null) f.turn = turn
    if (sessionId) f.sessionId = sessionId
    if (messageId) f.messageId = messageId
    if (quote) f.quote = quote
    f.sensitive = sensitive || f.sensitive
    return 'update'
  }
  const item = {
    id: nextId(),
    text,
    keywords,
    confidence: DEFAULT_CONFIDENCE,
    sensitive: Boolean(sensitive),
    domain,
    createdAt: Date.now(),
    lastRelevant: 0,
    turn,
    sessionId,
    messageId,
    quote
  }
  if (conflictId) item.conflicts = [conflictId]
  mem.facts.push(item)
  return 'add'
}

function resolveFactId(mem, text) {
  const t = String(text || '').trim()
  if (!t) return null
  for (const f of mem.facts) {
    if (similarity(f.text, t) >= 0.85) return f.id
  }
  return null
}

function addCausalLinks(mem, causals) {
  let added = 0
  for (const c of causals || []) {
    if (!c || typeof c.cause !== 'string' || typeof c.effect !== 'string') continue
    const fromId = resolveFactId(mem, c.cause)
    const toId = resolveFactId(mem, c.effect)
    if (!fromId || !toId || fromId === toId) continue
    if (mem.causalLinks.some((l) => l.fromFactId === fromId && l.toFactId === toId)) continue
    mem.causalLinks.push({
      id: nextId(),
      fromFactId: fromId,
      toFactId: toId,
      reason: typeof c.reason === 'string' ? c.reason.slice(0, 80) : '',
      createdAt: Date.now()
    })
    added++
  }
  return added
}

export function addMemory({ facts = [], summary = '', sensitive = false, causals = [], personalityId, sessionId = '' }) {
  const mem = readRawMemory(personalityId)
  let added = 0
  let updated = 0
  for (const f of facts) {
    const kind = addFact(mem, f, sensitive)
    if (kind === 'add') added++
    else if (kind === 'update') updated++
  }
  const s = String(summary || '').trim().slice(0, 120)
  if (s) {
    mem.summaries.push({ id: nextId(), text: s, sensitive: Boolean(sensitive) || isSensitiveText(s), sessionId, createdAt: Date.now() })
  }
  const causalAdded = addCausalLinks(mem, causals)
  saveMemoryData(mem, personalityId)
  return { added, updated, causalAdded, mem }
}

// 相关性检索：关键词命中优先，字形相似度兜底，乘以可信度加权；
// 低权重只作减分项，用户明确提起（关键词命中/高度相似）时仍可召回
const embedCache = new Map()

// 嵌入模块按需加载：首屏不背 onnxruntime 大包，第一次语义检索时才拉取
let embedModulePromise = null
function getEmbedModule() {
  if (!embedModulePromise) embedModulePromise = import('./embed.js')
  return embedModulePromise
}

async function embedWithCache(texts, ids, embed) {
  const out = new Array(texts.length)
  const missingIdx = []
  const missingTexts = []
  for (let i = 0; i < texts.length; i++) {
    const cached = embedCache.get(ids[i])
    if (cached) out[i] = cached
    else {
      missingIdx.push(i)
      missingTexts.push(texts[i])
    }
  }
  if (missingTexts.length > 0) {
    const vecs = await embed.embedTexts(missingTexts)
    for (let j = 0; j < vecs.length; j++) {
      const i = missingIdx[j]
      out[i] = vecs[j]
      if (embedCache.size >= EMBED_CACHE_CAP) embedCache.delete(embedCache.keys().next().value)
      embedCache.set(ids[i], vecs[j])
    }
  }
  return out
}

// 长期档案：从"稳定且可信"的事实里挑出最可靠的几条，每轮固定注入
function buildProfileLines(mem, excludeIds, adultOn) {
  const ids = new Set(excludeIds)
  const now = Date.now()
  const base = mem.facts.filter(
    (f) => !ids.has(f.id) && (adultOn || !(f.sensitive || isSensitiveText(f.text) || isSensitiveText(f.quote))) && normalizeConfidence(f.confidence) >= PROFILE_MIN_CONFIDENCE
  )
  const ageDays = (f) => (now - (f.lastRelevant || f.createdAt)) / 86400000
  const isImportant = (f) => PROFILE_IMPORTANT_RE.test(String(f.text || ''))
  // 稳定的老事实 + 重要设定（重要设定不看年龄，避免"刚讲过就不记得"）
  const pool = base.filter(
    (f) => ageDays(f) >= PROFILE_STABLE_DAYS || (isImportant(f) && ageDays(f) >= PROFILE_IMPORTANT_DAYS)
  )
  const score = (f) => normalizeConfidence(f.confidence) + (isImportant(f) ? 1 : 0)
  const picked = [...pool].sort((a, b) => score(b) - score(a)).slice(0, PROFILE_MAX)
  return picked.map((f) => `${f.text}（${formatRelativeTime(f.lastRelevant || f.createdAt)}）`)
}

// history：最近几轮的用户消息（可选）。
// 为什么需要它：像「你忘记东西了」「再想想呢」「那个东西」这类句子是**上下文依赖句**，
// 本身不含任何实体，只按当前这一句检索必然一无所获（实测命中 0 条），
// 于是她在那一轮完全是瞎的，只能靠人设硬编。
// 所以关键词匹配把最近几轮也算进去，但语义相似度仍然只算当前这句 —— 避免话题被带偏。
export async function retrieveMemories(userText, adultOn, limit = 8, history = [], personalityId) {
  const pid = safePid(personalityId ?? activePersonalityId)
  const mem = loadMemory(pid)
  const msg = String(userText || '')
  // 关键词侧的匹配文本 = 最近几轮 + 当前这句
  const kwWindow = [...(Array.isArray(history) ? history : []), msg]
    .filter((x) => typeof x === 'string' && x.trim())
    .join('\n')
  const pool = adultOn ? mem.facts : mem.facts.filter((f) => !(f.sensitive || isSensitiveText(f.text) || isSensitiveText(f.quote)))
  const scored = []
  const absorbedIds = []

  // ---- 关键词稀有度（IDF）：越少事实共有的关键词越有区分度 ----
  // 解决"主人"这类口癖词霸占检索：它在几十条事实里都出现，权重应当趋近 0；
  // 而"地球""传承"只出现在少数几条里，一旦命中就是强信号。
  const df = new Map()
  for (const f of pool) {
    for (const k of new Set(f.keywords || [])) {
      if (k) df.set(k, (df.get(k) || 0) + 1)
    }
  }
  const total = Math.max(1, pool.length)
  // IDF 归一：除以 log(total)，让"只出现在极少数事实里"的关键词接近 1，
  // "几乎所有事实都有"的泛词（主人/伴侣）接近 0。
  // 不做这一步的话，泛词命中会把真正有区分度的词（地球/传承）挤下去。
  const idfMax = Math.log(total + 1)
  const idfOf = (k) => {
    const d = df.get(k) || 0
    if (d <= 0) return 0
    return Math.max(0, Math.log((total + 1) / (d + 1)) / idfMax)
  }

  for (const f of pool) {
    // 关键词在"最近几轮 + 当前句"里找，让上下文依赖句也能命中（语义仍只用当前句）
    const hits = (f.keywords || []).filter((k) => k && kwWindow.includes(k))
    const kwHit = hits.length > 0
    // 命中的关键词按 IDF 取最大，作为关键词侧的强度
    const kwScore = kwHit ? Math.max(...hits.map(idfOf)) : 0
    const sim = similarity(f.text, msg)
    const strongMatch = kwHit || sim >= 0.4
    if (f.confidence < MIN_CONFIDENCE_INJECT && !strongMatch) continue
    // 关键词侧直接用 IDF 强度：稀有词命中 → 接近 1；泛词命中 → 接近 0。
    // 这样"主人"命中几乎不加分，"地球/传承"命中才会真正拉起来。
    const base = kwHit ? 0.35 + 0.65 * kwScore + 0.1 * sim : sim
    if (!kwHit && sim < 0.12) continue
    scored.push({ f, score: base * (0.5 + 0.5 * f.confidence), sem: undefined, kw: kwScore })
    // 关键词自动吸收：命中且相关时，把消息里的新显著词并入关键词（最多 2 个/次）
    if (kwHit || sim >= 0.3) {
      const words = salientWords(msg)
      const merged = mergeKeywords(f.keywords, words.slice(0, 2))
      if (merged.length > (f.keywords || []).length) {
        f.keywords = merged
        absorbedIds.push(f.id)
      }
    }
  }

  // ---- 实体跟随：提到某个重要实体时，把"同一段故事"的其他事实也拉进来 ----
  // 这是"提到地球就能想起星空巨炮、传承、逃亡五百年"的关键：
  // 纯字面检索永远做不到这件事，必须顺着关键词做一跳扩散。
  const mentioned = IMPORTANT_ENTITIES.filter((e) => msg.includes(e))
  if (mentioned.length > 0) {
    const picked = new Set(scored.map((s) => s.f.id))
    for (const f of pool) {
      if (picked.has(f.id)) continue
      const kws = f.keywords || []
      const share = mentioned.filter((e) => kws.some((k) => k && k.includes(e)))
      if (share.length === 0) continue
      if (f.confidence < MIN_CONFIDENCE_INJECT) continue
      // 扩散进来的给一个中等分：低于强关键词命中，高于噪声，保证能进候选但不抢头条
      const followScore = 0.55 + 0.25 * (share.length / mentioned.length)
      scored.push({ f, score: followScore * (0.5 + 0.5 * f.confidence), sem: undefined, kw: 0, follow: true })
      picked.add(f.id)
    }
  }

  // ---- 主题域跟随：问句里没有具体实体、但问的是"来历/能力"类问题时，
  //      把「重要事件」「基本信息」域里的来历类事实一并带出来 ----
  // 例子：用户只问"你这魔法从哪学的"，句子里没有"地球/传承"，
  // 但命中了"魔法" → 于是把地球/墓穴/逃亡那几条也拉出来。
  // 这是"顺着关键词看延伸内容"的落点。
  const asksOrigin = /魔法|法术|法力|能力|来历|身世|怎么来|哪儿学|哪里学|以前|过去|怎么得到/.test(msg)
  if (asksOrigin) {
    const picked2 = new Set(scored.map((s) => s.f.id))
    for (const f of pool) {
      if (picked2.has(f.id)) continue
      if (f.confidence < MIN_CONFIDENCE_INJECT) continue
      const text = String(f.text || '')
      const kws = f.keywords || []
      const domainHit = f.domain === '重要事件' || f.domain === '基本信息'
      const originLike = /地球|传承|墓穴|墓地|逃亡|逃离|来自|五百|星舰|星域|大魔法师/.test(text)
      const kwLike = kws.some((k) => k && /魔法|法力|传承|封印|来历|身世|地球/.test(k))
      if (!(domainHit && originLike) && !kwLike) continue
      const followScore = 0.5 + (domainHit ? 0.2 : 0) + (originLike ? 0.1 : 0)
      scored.push({ f, score: followScore * (0.5 + 0.5 * f.confidence), sem: undefined, kw: 0, follow: true })
      picked2.add(f.id)
    }
  }

  // 只把关键词更新写回存储，保留原始置信度（不破坏衰减幂等）
  if (absorbedIds.length > 0) {
    try {
      // 走分区读取：直接读旧 key 会串到那份已废弃的全局记忆
      const raw = readRawMemory(pid)
      if (raw && Array.isArray(raw.facts)) {
        const absorbed = new Set(absorbedIds)
        for (const st of raw.facts) {
          if (absorbed.has(st.id) && Array.isArray(st.keywords)) {
            const fresh = mem.facts.find((x) => x.id === st.id)
            if (fresh) st.keywords = fresh.keywords
          }
        }
        saveMemoryData(raw, pid)
      }
    } catch {
      /* 吸收失败不影响检索 */
    }
  }
  scored.sort((a, b) => b.score - a.score)

  // ---- 语义重排：字面前 24 条 + 近 30 天的补充池，用本地嵌入模型打分 ----
  const lexTop = scored.slice(0, SEMANTIC_CANDIDATE_CAP)
  const inTop = new Set(lexTop.map((x) => x.f.id))
  const now = Date.now()
  const recent = []
  for (const f of pool) {
    if (inTop.has(f.id)) continue
    if (now - (f.lastRelevant || f.createdAt) > RECENT_WINDOW_DAYS * 86400000) continue
    recent.push(f)
  }
  // 近期补充池：不按时间，按"最近被想起过"排出较大的候选池，
  // 之后再让语义打分来挑（语义分高的才进最终结果）
  recent.sort(
    (a, b) =>
      (b.lastRelevant || b.createdAt || 0) - (a.lastRelevant || a.createdAt || 0) ||
      (b.createdAt || 0) - (a.createdAt || 0)
  )
  const recentTop = recent
    .slice(0, RECENT_POOL_CAP)
    .map((f) => ({ f, score: 0, sem: undefined, rescue: true }))
  const candidates = [...lexTop, ...recentTop]
  if (candidates.length > 0) {
    try {
      const embed = await getEmbedModule()
      const qvec = (await embed.embedTexts([msg]))[0]
      const vecs = await embedWithCache(
        candidates.map((c) => c.f.text),
        candidates.map((c) => c.f.id),
        embed
      )
      for (let i = 0; i < candidates.length; i++) {
        const sem = Math.max(0, embed.dotScore(qvec, vecs[i]))
        candidates[i].sem = sem
        candidates[i].score = candidates[i].rescue
          ? sem
          : candidates[i].score + SEMANTIC_BONUS * sem
      }
    } catch {
      /* 嵌入不可用（模型未下载/加载失败）：回退到纯字面排序 */
    }
  }
  // 近期池的作用是"语义兜底"：字面完全对不上、但意思相关的事实靠它救回来。
  // 原来按 lastRelevant 倒序取最新 12 条，结果对话一多就永远是"最近那几条"，
  // 真正相关的旧设定被挤在外面。改成按语义分取最高的若干条。
  for (const c of recentTop) {
    if (Number.isFinite(c.sem) && c.sem >= SEMANTIC_RESCUE_THRESHOLD) scored.push(c)
  }
  // 语义兜底不足时补齐：把近期池里语义分最高的几条也纳入，
  // 否则"字面对不上、只是意思相关"的旧设定永远救不回来
  const rescued = new Set(scored.map((s) => s.f.id))
  const relaxed = [...recentTop]
    .filter((c) => Number.isFinite(c.sem) && !rescued.has(c.f.id))
    .sort((a, b) => b.sem - a.sem)
    .slice(0, 4)
  for (const c of relaxed) scored.push(c)
  scored.sort((a, b) => b.score - a.score)

  // ---- 选谁进提示词：给"跟随进来的背景事实"保底名额 ----
  // 纯按分数排的话，泛词事实（"称呼主人"这类）永远挤掉真正需要的背景设定，
  // 所以这里把两组分开取：跟随组保底 3 条，其余名额给高分组。
  const followPool = scored.filter((x) => x.follow)
  const normalPool = scored.filter((x) => !x.follow)
  const followQuota = Math.min(followPool.length, Math.max(0, Math.min(3, limit - 3)))
  const pickedFacts = []
  const seenIds = new Set()
  for (const x of followPool.slice(0, followQuota)) {
    if (!seenIds.has(x.f.id)) { pickedFacts.push(x.f); seenIds.add(x.f.id) }
  }
  for (const x of normalPool) {
    if (pickedFacts.length >= limit) break
    if (!seenIds.has(x.f.id)) { pickedFacts.push(x.f); seenIds.add(x.f.id) }
  }
  // 还没满就继续从跟随池补（normal 不够时）
  for (const x of followPool) {
    if (pickedFacts.length >= limit) break
    if (!seenIds.has(x.f.id)) { pickedFacts.push(x.f); seenIds.add(x.f.id) }
  }
  const picked = pickedFacts
  // 关联扩散：提到 A 时，顺着因果链把相关的 B/C 也带出来（最多 +3）
  const linkMap = new Map()
  for (const l of mem.causalLinks) {
    if (!linkMap.has(l.fromFactId)) linkMap.set(l.fromFactId, [])
    linkMap.get(l.fromFactId).push(l.toFactId)
    if (!linkMap.has(l.toFactId)) linkMap.set(l.toFactId, [])
    linkMap.get(l.toFactId).push(l.fromFactId)
  }
  const pickedIds = new Set(picked.map((f) => f.id))
  const chain = []
  for (const f of picked) {
    for (const nid of linkMap.get(f.id) || []) {
      if (pickedIds.has(nid)) continue
      const nf = mem.facts.find((x) => x.id === nid)
      if (!nf) continue
      if (!adultOn && (nf.sensitive || isSensitiveText(nf.text) || isSensitiveText(nf.quote))) continue
      if (nf.confidence < MIN_CONFIDENCE_INJECT) continue
      pickedIds.add(nid)
      chain.push(nf)
      if (chain.length >= 3) break
    }
    if (chain.length >= 3) break
  }
  let finalFacts = [...picked, ...chain].slice(0, limit + 3)
  // 冲突去重：同一主题的新旧说法同时命中时，只留最新那条
  const idsIn = new Set(finalFacts.map((f) => f.id))
  const dropped = new Set()
  for (const f of finalFacts) {
    for (const cid of f.conflicts || []) {
      if (!idsIn.has(cid) || dropped.has(cid) || dropped.has(f.id)) continue
      const other = mem.facts.find((x) => x.id === cid)
      if (!other) continue
      const keepNewer =
        (f.lastRelevant || f.createdAt) >= (other.lastRelevant || other.createdAt)
      dropped.add(keepNewer ? cid : f.id)
    }
  }
  if (dropped.size > 0) finalFacts = finalFacts.filter((f) => !dropped.has(f.id))
  const allowedSummaries = adultOn ? mem.summaries : mem.summaries.filter((s) => !(s.sensitive || isSensitiveText(s.text)))
  const summary = allowedSummaries.length > 0 ? allowedSummaries[allowedSummaries.length - 1].text : ''
  // 档案也要避开"被新说法取代"的旧事实，避免同一轮里前后矛盾
  const profileExclude = new Set(finalFacts.map((f) => f.id))
  for (const f of finalFacts) {
    for (const cid of f.conflicts || []) profileExclude.add(cid)
  }
  const profile = buildProfileLines(mem, profileExclude, adultOn)
  // 用进废退：本轮注入的事实刷新"最近相关时间"，让仍在使用的记忆不衰减；
  // 只改原始存储里的 lastRelevant，不碰置信度，保持衰减幂等
  if (finalFacts.length > 0) {
    try {
      // 走分区读取：直接读旧 key 会串到那份已废弃的全局记忆
      const raw = readRawMemory(pid)
      if (raw && Array.isArray(raw.facts)) {
        const touched = new Set(finalFacts.map((f) => f.id))
        const nowTs = Date.now()
        let changed = false
        for (const st of raw.facts) {
          if (touched.has(st.id)) {
            st.lastRelevant = nowTs
            changed = true
          }
        }
        if (changed) saveMemoryData(raw, pid)
      }
    } catch {
      /* 刷新失败不影响检索 */
    }
  }
  return {
    facts: finalFacts.map((f) => ({
      id: f.id,
      text: f.text,
      ts: f.lastRelevant || f.createdAt,
      sensitive: Boolean(f.sensitive),
      conflict: Boolean(f.conflicts?.length),
      // 出处：第几轮 + 原话摘录。调用方可以把原话也喂给模型，补回提炼压平的细节。
      turn: f.turn ?? null,
      sessionId: f.sessionId || '',
      messageId: f.messageId || '',
      quote: f.quote || ''
    })),
    summary,
    profile
  }
}

// 从若干对 (用户, 伴侣) 中提炼记忆（一次 API 调用），供单轮与批量两条路径复用。
// 后台提炼一律不走思考模式（chatNonStream 不传 thinkingMode 即显式 disabled）：
// 思考 token 会挤占 max_tokens，容易把 JSON 输出截断
async function extractPairsChunk(pairs, sensitive, { model, personalityId, sessionId = '', isCurrent = () => true }) {
  if (!isCurrent()) return { ok: false, reason: 'cancelled' }
  const privateTurn = Boolean(sensitive) || pairs.some((p) => p.sensitive || isSensitiveText(p.user) || isSensitiveText(p.assistant))
  const text = pairs
    .map((p, j) => `${j + 1}. 用户：${p.user}\n   伴侣：${p.assistant}`)
    .join('\n')
  const res = await chatNonStream({
    model,
    messages: [
      { role: 'system', content: CHUNK_EXTRACT_PROMPT },
      { role: 'user', content: text }
    ],
    maxTokens: 3000,
    // 结构化提炼用低温，降低 JSON 格式出错的概率（后台任务不走思考模式）
    temperature: 0.3,
    // 走官方 JSON 模式：服务端保证是合法 JSON，省掉一半的解析失败兜底
    responseFormat: 'json'
  })
  if (!res.ok) return { ok: false, reason: `api:${res.status ?? 'err'}` }
  try {
    const clean = extractJsonBlock(res.text)
    const parsed = JSON.parse(clean)
    const facts = normalizeFactsArray(parsed.facts).filter((f) => {
      const t = typeof f === 'string' ? f : f?.text
      return typeof t === 'string' && t.trim() && !isInstructionLike(t)
    })
    // 出处回填：把模型给的 src（第几段/第几轮）换算成真实轮次，并保留它摘的原话。
    // 模型可能给出越界或非数字的 src，这里一律夹到合法范围；摘不到 quote 就退回
    // 该轮用户原话的前 60 字 —— 有原文总比没有强，而且不用再花一次调用。
    const factsWithDomain = facts.map((f) => {
      if (typeof f === 'string') {
        const first = pairs[0]
        return {
          text: f,
          keywords: [],
          domain: '',
          turn: first?.turn ?? null,
          sessionId: first?.sessionId || sessionId,
          messageId: first?.messageId || '',
          quote: first ? String(first.user || '').slice(0, 60) : ''
        }
      }
      const idx = Number.isFinite(Number(f.src)) ? Math.max(0, Math.min(pairs.length - 1, Number(f.src) - 1)) : 0
      const src = pairs[idx]
      const quote = typeof f.quote === 'string' && f.quote.trim() ? f.quote.trim().slice(0, 200) : String(src?.user || '').slice(0, 60)
      return {
        ...f,
        domain: f.domain || '',
        turn: src?.turn ?? null,
        sessionId: src?.sessionId || sessionId,
        messageId: src?.messageId || '',
        quote
      }
    })
    const summary =
      typeof parsed.summary === 'string' && !isInstructionLike(parsed.summary)
        ? parsed.summary
        : ''
    const causals = Array.isArray(parsed.causals)
      ? parsed.causals.filter(
          (c) => c && typeof c.cause === 'string' && typeof c.effect === 'string'
        )
      : []
    if (!isCurrent()) return { ok: false, reason: 'cancelled' }
    const { added, updated, causalAdded } = addMemory({
      facts: factsWithDomain,
      summary,
      sensitive: privateTurn || isSensitiveText(summary),
      causals,
      personalityId,
      sessionId
    })
    return { ok: true, added, updated, causalAdded, addedSummary: Boolean(summary) }
  } catch (err) {
    return { ok: false, reason: err?.message?.startsWith('长期记忆保存失败') ? err.message : 'parse' }
  }
}

// 立即提炼单轮（保留原接口；常规聊天走 queueExtraction 批量）
// ---- 批量化提炼：攒够 2 对或 3 分钟无新消息时合并成一次调用，省 API 额度 ----
const pendingPairs = []
const failedPairs = []
const extractionGenerations = new Map()
const extractionListeners = new Set()
let flushTimer = null
let flushInFlight = null
const PENDING_PAIR_CAP = 2
const FLUSH_IDLE_MS = 3 * 60 * 1000

function generationOf(pid) { return extractionGenerations.get(pid) || 0 }
function captureGeneration(pid) {
  if (!extractionGenerations.has(pid)) extractionGenerations.set(pid, 0)
  return generationOf(pid)
}
function publishExtractionStatus(task, status, error) {
  const event = { personalityId: task.personalityId, sessionId: task.sessionId, messageId: task.messageId, status, ...(error ? { error } : {}) }
  try { task.onStatus?.(event) } catch { /* observer errors do not stop extraction */ }
  for (const listener of extractionListeners) {
    try { listener(event) } catch { /* other subscribers still receive events */ }
  }
}
export function subscribeExtractionStatus(listener) {
  extractionListeners.add(listener)
  return () => extractionListeners.delete(listener)
}
export function getExtractionStatus(personalityId) {
  const pid = personalityId === undefined ? null : safePid(personalityId)
  const count = (items) => items.filter((x) => pid === null || x.personalityId === pid).length
  return { pending: count(pendingPairs), failed: count(failedPairs), running: count(flushInFlight?.tasks || []) }
}
function scheduleExtraction() {
  if (flushTimer || pendingPairs.length === 0 || flushInFlight) return
  flushTimer = setTimeout(() => { flushTimer = null; void flushPendingExtraction() }, FLUSH_IDLE_MS)
}

export function queueExtraction({ model, thinkingMode, userText, assistantText, sensitive, turn, personalityId, sessionId = '', messageId = '', onDone, onStatus, onError }) {
  const user = String(userText || '').trim()
  const assistant = String(assistantText || '').trim()
  if (user.length < EXTRACT_SKIP_MIN || !assistant) return
  // turn 是这一轮在会话里的消息下标，用来给事实标出处（"这条是你第几轮说的"）
  const pid = safePid(personalityId ?? activePersonalityId)
  const task = { user, assistant, sensitive: Boolean(sensitive) || isSensitiveText(user) || isSensitiveText(assistant), turn, personalityId: pid, sessionId: String(sessionId || ''), messageId: String(messageId || ''), generation: captureGeneration(pid), model, thinkingMode, onDone, onStatus, onError }
  pendingPairs.push(task)
  publishExtractionStatus(task, 'pending')
  if (pendingPairs.length >= PENDING_PAIR_CAP) {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    void flushPendingExtraction()
    return
  }
  scheduleExtraction()
}

export async function flushPendingExtraction() {
  if (flushInFlight) return flushInFlight.promise
  if (!pendingPairs.length) return
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  const state = { promise: null, tasks: [] }
  flushInFlight = state
  state.promise = (async () => {
    while (pendingPairs.length) {
      const first = pendingPairs.shift()
      if (first.generation !== generationOf(first.personalityId)) continue
      const same = (x) => x.personalityId === first.personalityId && x.sessionId === first.sessionId && x.sensitive === first.sensitive && x.generation === first.generation && x.model === first.model
      const batch = [first]
      while (batch.length < PENDING_PAIR_CAP && pendingPairs.length && same(pendingPairs[0])) batch.push(pendingPairs.shift())
      state.tasks = batch
      for (const task of batch) publishExtractionStatus(task, 'running')
      let outcome
      try {
        outcome = await extractPairsChunk(batch, first.sensitive, { model: first.model, personalityId: first.personalityId, sessionId: first.sessionId,
          isCurrent: () => first.generation === generationOf(first.personalityId)
        })
      } catch (err) { outcome = { ok: false, reason: err?.message || '存储失败' } }
      state.tasks = []
      if (first.generation !== generationOf(first.personalityId)) continue
      for (const task of batch) {
        if (outcome.ok) {
          publishExtractionStatus(task, 'completed')
          try { task.onDone?.() } catch { /* callback does not stop queue */ }
        } else {
          failedPairs.push(task)
          const error = outcome.reason || '提炼失败'
          publishExtractionStatus(task, 'failed', error)
          try { task.onError?.(error) } catch { /* callback does not stop queue */ }
        }
      }
    }
  })().finally(() => { flushInFlight = null; if (pendingPairs.length) void flushPendingExtraction() })
  return state.promise
}

export function retryFailedExtraction({ personalityId } = {}) {
  const pid = personalityId === undefined ? null : safePid(personalityId)
  const retry = failedPairs.filter((x) => pid === null || x.personalityId === pid)
  for (const task of retry) {
    failedPairs.splice(failedPairs.indexOf(task), 1)
    task.generation = generationOf(task.personalityId)
    pendingPairs.push(task)
    publishExtractionStatus(task, 'pending')
  }
  if (retry.length) void flushPendingExtraction()
  return retry.length
}

// 取消尚未提炼的对话：清空对话 / 彻底清除时必须调用。
// 否则排队中的那几轮会在清空之后被定时器提炼出来、又写回记忆里，
// 表现为"记录都删了，长期记忆却还在"
export function cancelPendingExtraction(personalityId = activePersonalityId) {
  const pid = safePid(personalityId)
  extractionGenerations.set(pid, generationOf(pid) + 1)
  for (const task of flushInFlight?.tasks || []) {
    if (task.personalityId === pid) publishExtractionStatus(task, 'stopped')
  }
  for (const items of [pendingPairs, failedPairs]) {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].personalityId === pid) {
        publishExtractionStatus(items[i], 'stopped')
        items.splice(i, 1)
      }
    }
  }
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (pendingPairs.length) scheduleExtraction()
}

// 彻底清除和备份恢复使用；无参 cancelPendingExtraction 仍只作用于当前人格。
export function cancelAllMemoryTasks() {
  const pids = new Set([
    ...extractionGenerations.keys(),
    ...pendingPairs.map((task) => task.personalityId),
    ...failedPairs.map((task) => task.personalityId),
    ...(flushInFlight?.tasks || []).map((task) => task.personalityId)
  ])
  for (const pid of pids) cancelPendingExtraction(pid)
}

const KEYWORD_BACKFILL_PROMPT = `你是关键词提炼器。为下列每条事实提炼 4~6 个详细检索关键词（人名、物品、地点、习惯、事件名、特征等，越具体越好），并从以下主题域中选一个：基本信息/生活习惯/健康/工作学习/家庭/朋友/伴侣关系/兴趣偏好/情绪状态/重要事件/其他。
要求：
- 关键词要具体、利于日后检索；不要用「用户」「喜欢」「这个」等泛词。
- 每条事实的关键词与输入编号一一对应。
- domains 输出为字符串数组，与输入编号一一对应，如 "domains": ["健康", "生活习惯"]。
- 必须输出数组，不要使用按编号的对象键值形式（如 {"25": {...}}）。
输入：
`

// 把模型返回转成 {keywords: 二维数组, domains: 数组}；兼容数组、对象、按编号对象等各种形状
export function normalizeKeywordsResponse(parsed) {
  if (Array.isArray(parsed)) {
    // 数组元素可能是 {keywords, domain} 对象（模型常见输出）
    if (parsed.length > 0 && parsed[0] && typeof parsed[0] === 'object' && !Array.isArray(parsed[0])) {
      return {
        keywords: parsed.map((v) => (Array.isArray(v?.keywords) ? v.keywords : [])),
        domains: parsed.map((v) => v?.domain)
      }
    }
    return { keywords: parsed, domains: null }
  }
  if (!parsed || typeof parsed !== 'object') return null
  let kws = parsed.keywords
  let doms = parsed.domains
  if (kws == null) kws = parsed.result ?? parsed.data
  if (Array.isArray(kws)) return { keywords: kws, domains: doms }
  // 按编号对象：{"25": {"keywords": [...], "domain": "..."}} 或 {"25": [...]}
  const numKeys = Object.keys(parsed).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b))
  if (numKeys.length > 0) {
    const kwsArr = []
    const domsArr = []
    let ok = false
    for (const k of numKeys) {
      const v = parsed[k]
      if (Array.isArray(v)) {
        kwsArr.push(v)
        ok = true
        continue
      }
      if (v && typeof v === 'object') {
        kwsArr.push(Array.isArray(v.keywords) ? v.keywords : [])
        domsArr.push(v.domain)
        ok = true
        continue
      }
      kwsArr.push([])
    }
    if (ok) return { keywords: kwsArr, domains: domsArr }
  }
  if (kws && typeof kws === 'object') {
    // 对象按数字键转数组（模型有时输出 {"1": [...], "2": [...]}）
    const keys = Object.keys(kws).sort((a, b) => Number(a) - Number(b))
    const arr = keys.map((k) => kws[k])
    if (arr.length > 0) return { keywords: arr, domains: doms }
  }
  return null
}

// 从模型回复里抓取 JSON 块：先定位 { 或 [，再按括号配对取完整对象/数组
export function extractJsonBlock(text) {
  const clean0 = String(text || '')
    .replace(/```(?:json)?/g, '')
    .trim()
  const start = clean0.search(/[{\[]/)
  if (start < 0) return clean0
  const open = clean0[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < clean0.length; i++) {
    const ch = clean0[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === open) depth++
    else if (ch === close && --depth === 0) return clean0.slice(start, i + 1)
  }
  return clean0.slice(start)
}

// 事实数组容错：兼容直接数组与按编号对象
export function normalizeFactsArray(raw) {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') {
    const numKeys = Object.keys(raw)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b))
    if (numKeys.length > 0) return numKeys.map((k) => raw[k])
  }
  return []
}

// 一键补全：批量用模型给已有事实提炼关键词；接口失败时用本地切词兜底。
// 只写关键词、保留原始置信度（不破坏衰减幂等）。
export async function backfillKeywords({ model, thinkingMode, onProgress, personalityId = activePersonalityId }) {
  const pid = safePid(personalityId)
  const generation = captureGeneration(pid)
  const isCurrent = () => generation === generationOf(pid)
  const raw = readRawMemory(pid)
  const mem = sanitizeMemory(raw)
  const facts = mem.facts
  if (facts.length === 0) return { ok: true, chunks: 0, processed: 0, updated: 0, failed: 0 }
  const CHUNK = 12
  const chunks = Math.ceil(facts.length / CHUNK)
  let updated = 0
  let failed = 0
  let processed = 0
  let lastError = ''
  for (let start = 0; start < facts.length; start += CHUNK) {
    if (!isCurrent()) return { ok: false, cancelled: true, chunks, processed, updated, failed }
    const slice = facts.slice(start, start + CHUNK)
    const list = slice.map((f, i) => `${start + i + 1}. ${f.text}`).join('\n')
    let keywordsByIndex = null
    let domainsByIndex = null
    const res = await chatNonStream({
      model,
      messages: [
        { role: 'system', content: KEYWORD_BACKFILL_PROMPT + list },
        { role: 'user', content: '请按编号输出 JSON。' }
      ],
      // 不传 thinkingMode：JSON 提炼用不到思考模式，客户端会显式发 disabled（更省钱、更不容易被截断）
      temperature: 0.3,
      // 官方 JSON 模式：保证返回合法 JSON
      responseFormat: 'json'
    })
    if (!isCurrent()) return { ok: false, cancelled: true, chunks, processed, updated, failed }
    if (!res.ok && !lastError) {
      lastError = res.message || `HTTP ${res.status ?? '?'}`
    }
    if (res.ok) {
      try {
      const clean = extractJsonBlock(res.text)
        const parsed = JSON.parse(clean)
        const kw = normalizeKeywordsResponse(parsed)
        if (kw) {
          keywordsByIndex = kw.keywords
          domainsByIndex = kw.domains
        } else if (!lastError) {
          lastError = `响应格式异常：${res.text.slice(0, 120)}`
        }
      } catch {
        if (!lastError) lastError = `内容无法解析：${res.text.slice(0, 120)}`
      }
    }
    if (!keywordsByIndex) failed++
    // 网络等待期间可能新增或手动编辑事实；只把当前批次合并回仍存在的事实 ID。
    const current = readRawMemory(pid)
    const currentById = new Map(current.facts.map((fact) => [fact.id, fact]))
    for (let i = 0; i < slice.length; i++) {
      const f = slice[i]
      const target = currentById.get(f.id)
      if (!target || target.manual || target.text !== f.text) continue
      const rawKws = keywordsByIndex?.[i]
      const modelKws = Array.isArray(rawKws)
        ? rawKws.filter((k) => typeof k === 'string' && k.trim())
        : []
      if (modelKws.length > 0) {
        // 模型成功：替换成详细关键词，并更新主题域
        const clean = mergeKeywords([], modelKws)
        if (JSON.stringify(clean) !== JSON.stringify(target.keywords || [])) {
          target.keywords = clean
          updated++
        }
        if (domainsByIndex && domainsByIndex[i]) {
          const d = domainsByIndex[i]
          target.domain = normalizeDomain(Array.isArray(d) ? d[0] || '其他' : d)
        }
      } else {
        // 模型失败：合并本地词，保留已有共享（不丢旧词、不断连）
        const merged = mergeKeywords(target.keywords, deriveKeywords(f.text))
        if (merged.length > (target.keywords || []).length) {
          target.keywords = merged
          updated++
        }
        // 模型不可用也用本地规则补主题域，避免全落"其他"
        if (target.domain === '其他' || !target.domain) {
          target.domain = guessDomain(f.text)
        }
      }
      processed++
    }
    if (!isCurrent()) return { ok: false, cancelled: true, chunks, processed, updated, failed }
    saveMemoryData(current, pid)
    onProgress?.({ done: Math.floor(start / CHUNK) + 1, total: chunks, updated })
  }
  return { ok: true, chunks, processed, updated, failed, lastError }
}

// 手动编辑关键词：直接替换并标记 manual，补全不会再覆盖
export function updateFactKeywords(id, keywords) {
  const raw = readMemoryRaw() || emptyMemory()
  const mem = sanitizeMemory(raw)
  const f = mem.facts.find((x) => x.id === id)
  if (!f) return mem
  f.keywords = mergeKeywords(
    [],
    (keywords || []).filter((k) => typeof k === 'string' && k.trim())
  )
  f.manual = true
  saveMemoryData(mem)
  return mem
}

function buildPairs(messages, sessionId = '') {
  const pairs = []
  const msgs = Array.isArray(messages) ? messages : []
  for (let i = 0; i < msgs.length - 1; i++) {
    const u = msgs[i]
    const a = msgs[i + 1]
    if (u && a && u.role === 'user' && a.role === 'assistant') {
      // turn 必须带上：重建记忆时靠它给事实标出处。
      // 少了它，整批重建出来的事实都会丢掉"这条是第几轮说的"，
      // 等于一次重建把之前所有出处冲光。
      pairs.push({ user: u.content, assistant: a.content, sensitive: Boolean(u.sensitive || a.sensitive || isSensitiveText(u.content) || isSensitiveText(a.content)), turn: i, sessionId, messageId: typeof u.id === 'string' ? u.id : '' })
      i++
    }
  }
  return pairs
}

export function countRebuildChunks(messages) {
  const pairs = buildPairs(messages)
  let chunks = 0
  let cur = null
  for (const p of pairs) {
    if (!cur || cur.sensitive !== p.sensitive || cur.items.length >= 8) {
      cur = { sensitive: p.sensitive, items: [] }
      chunks++
    }
    cur.items.push(p)
  }
  return { pairs: pairs.length, chunks }
}

export async function rebuildMemoryFromMessages({
  model,
  thinkingMode,
  messages,
  personalityId,
  sessionId = '',
  onProgress
}) {
  const pid = safePid(personalityId ?? activePersonalityId)
  const generation = captureGeneration(pid)
  const isCurrent = () => generation === generationOf(pid)
  const pairs = buildPairs(messages, sessionId)
  const chunks = []
  let cur = null
  for (const p of pairs) {
    if (!cur || cur.sensitive !== p.sensitive || cur.items.length >= 8) {
      cur = { sensitive: p.sensitive, items: [] }
      chunks.push(cur)
    }
    cur.items.push(p)
  }
  let addedFacts = 0
  let updatedFacts = 0
  let addedSummaries = 0
  let failed = 0
  const REBUILD_RETRIES = 3
  const RETRY_BASE_MS = 700
  for (let i = 0; i < chunks.length; i++) {
    if (!isCurrent()) return { ok: false, cancelled: true, chunks: chunks.length, addedFacts, updatedFacts, addedSummaries, failed }
    const c = chunks[i]
    let r = null
    for (let attempt = 1; attempt <= REBUILD_RETRIES; attempt++) {
      r = await extractPairsChunk(c.items, c.sensitive, { model, thinkingMode, personalityId: pid, sessionId, isCurrent })
      if (r.ok) break
      if (!isCurrent()) return { ok: false, cancelled: true, chunks: chunks.length, addedFacts, updatedFacts, addedSummaries, failed }
      if (attempt < REBUILD_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * attempt))
      }
    }
    if (r?.ok) {
      addedFacts += r.added
      updatedFacts += r.updated
      if (r.addedSummary) addedSummaries++
    } else {
      failed++
    }
    onProgress?.({ done: i + 1, total: chunks.length, added: addedFacts })
    // 段与段之间小停顿，降低连续调用触发限流的概率
    if (i < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  return { ok: true, chunks: chunks.length, addedFacts, updatedFacts, addedSummaries, failed }
}

export function deleteFact(id) {
  const mem = readRawMemory()
  mem.facts = mem.facts.filter((f) => f.id !== id)
  mem.causalLinks = mem.causalLinks.filter((l) => l.fromFactId !== id && l.toFactId !== id)
  saveMemoryData(mem)
  // 返回衰减视图，保证界面显示与 loadMemory 一致
  return loadMemory()
}

export function clearMemory() {
  // 连同排队中的提炼一起取消，避免清完又被写回来
  cancelPendingExtraction()
  const mem = emptyMemory()
  saveMemoryData(mem)
  return mem
}

// 列出所有已落盘的记忆分区（按人格），供界面查看与逐个清理。
// 场景：早期版本所有记忆共用一个全局位，切换人格会把上一个的剧情带过去；
// 修复后新数据不再串，但已被污染的旧分区需要用户能看见并精确清掉
export function listMemoryPartitions() {
  const out = []
  try {
    const prefix = `${STORAGE_KEYS.memory}::`
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(prefix)) continue
      const pid = k.slice(prefix.length)
      if (pid === '__migrated__') continue // 迁移标记不是记忆
      let mem = null
      try {
        const raw = readSecure(k)
        mem = raw ? sanitizeMemory(JSON.parse(raw)) : null
      } catch {
        mem = null
      }
      const facts = mem?.facts || []
      const summaries = mem?.summaries?.length || 0
      const causalLinks = mem?.causalLinks?.length || 0
      out.push({
        personalityId: pid,
        facts: facts.length,
        summaries,
        causalLinks,
        empty: facts.length === 0 && summaries === 0 && causalLinks === 0,
        sample: facts.slice(0, 2).map((f) => f.text)
      })
    }
  } catch {
    /* 存储不可用时返回空列表 */
  }
  // 空分区不展示：清空过的角色会留下一个空壳 key，列出来只会让人以为"还有残留"
  return out
    .filter((p) => !p.empty)
    .sort((a, b) => b.facts + b.summaries - (a.facts + a.summaries))
}

// 历史遗留的全局记忆是否还在（迁移不会被删除，只被标记）
export function hasLegacyMemory() {
  try {
    return Boolean(localStorage.getItem(STORAGE_KEYS.memory))
  } catch {
    return false
  }
}

// 精确清空指定人格的记忆分区；不传则清当前作用域
export function clearMemoryPartition(personalityId) {
  const pid = safePid(personalityId ?? activePersonalityId)
  cancelPendingExtraction(pid)
  try {
    localStorage.removeItem(`${STORAGE_KEYS.memory}::${pid}`)
  } catch {
    return false
  }
  return true
}

// 彻底删掉历史遗留的全局记忆（内容已被迁移过，删除不影响新分区）
export function dropLegacyMemory() {
  try {
    localStorage.removeItem(STORAGE_KEYS.memory)
    return true
  } catch {
    return false
  }
}

// 把全部人格的记忆分区打成一个 { 人格id: 记忆 } 对象，供备份一次性带走。
// 之前备份只存当前人格那一份，换个人格再导出就是别人的记忆：
// 想保全所有剧情得挨个切过去挨个导出，实际操作中根本做不到
export function exportAllPartitions() {
  const out = {}
  try {
    const prefix = `${STORAGE_KEYS.memory}::`
    const keys = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(prefix)) keys.push(k)
    }
    for (const k of keys) {
      const pid = k.slice(prefix.length)
      if (pid === '__migrated__') continue // 迁移标记不是记忆
      try {
        const raw = readSecure(k)
        if (!raw) continue
        const mem = sanitizeMemory(JSON.parse(raw))
        // 空分区不带走：清空过的角色会留下空壳，塞进备份只会让文件虚胖
        if (mem.facts.length === 0 && mem.summaries.length === 0 && mem.causalLinks.length === 0) {
          continue
        }
        out[pid] = mem
      } catch {
        /* 单个分区读不出来不影响其他分区 */
      }
    }
  } catch {
    /* 存储不可用时返回空对象 */
  }
  return out
}

// 还原全部人格的记忆分区。这里是"直接按分区落盘"，不改动当前作用域，
// 所以导入别人格的备份不会把界面正在看的记忆读串
export function importAllPartitions(byPartition) {
  let restored = 0
  let facts = 0
  if (!byPartition || typeof byPartition !== 'object') return { restored, facts }
  for (const [pid, raw] of Object.entries(byPartition)) {
    if (!pid || pid === '__migrated__') continue
    try {
      const mem = sanitizeMemory(raw)
      if (mem.facts.length === 0 && mem.summaries.length === 0 && mem.causalLinks.length === 0) {
        continue
      }
      saveMemoryData(mem, pid)
      restored++
      facts += mem.facts.length
    } catch {
      /* 单个分区写不进去不影响其他分区 */
    }
  }
  return { restored, facts }
}

// ---- 单人格记忆的导出 / 导入 ----
//
// 整份备份带的是"全部人格 + 当前会话"，适合换电脑一次性搬运。
// 但日常更常见的是只想处理一个人格：把她单独存一份留底，
// 或者把别人给的一份记忆并进来。所以单人格文件是独立格式，
// 导入时只写那一个分区，既不碰当前会话，也不碰别的人格。

function personaFilePayload(personalityId, mem) {
  return {
    app: 'xingyu',
    kind: 'persona-memory',
    appName: '星语 StarVox',
    version: 1,
    exportedAt: new Date().toISOString(),
    personalityId: safePid(personalityId),
    memory: mem
  }
}

// 按人格 id 取分区名（界面要用它对上人格的显示名）
export function personaFileOf(personalityId) {
  const pid = safePid(personalityId)
  return { personalityId: pid, memory: readRawMemory(pid) }
}

export function exportPersonaMemory(personalityId) {
  const pid = safePid(personalityId)
  return JSON.stringify(personaFilePayload(pid, readRawMemory(pid)), null, 2)
}

// 识别一份单人格记忆文件；不是这种文件就返回 null（调用方据此拒绝）
export function parsePersonaMemory(text) {
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  if (data.kind !== 'persona-memory') return null
  if (!data.memory || typeof data.memory !== 'object') return null
  const pid = safePid(data.personalityId)
  return {
    personalityId: pid,
    memory: sanitizeMemory(data.memory),
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : ''
  }
}

// 导入单人格记忆。mode:
//   'replace' —— 这份文件就是该人格的全部记忆，直接替换
//   'merge'   —— 把文件里的事实并进现有记忆，靠判重逻辑去重（她记着的还留着）
export function importPersonaMemory(personalityId, memory, mode = 'replace') {
  const pid = safePid(personalityId)
  const incoming = sanitizeMemory(memory)

  if (mode === 'merge') {
    const mem = readRawMemory(pid)
    let added = 0
    let updated = 0
    for (const f of incoming.facts) {
      const kind = addFact(mem, f, Boolean(f.sensitive))
      if (kind === 'add') added++
      else if (kind === 'update') updated++
    }
    // 摘要按文本去重：合并时不该把同一句进展记两遍
    const have = new Set(mem.summaries.map((s) => s.text))
    for (const s of incoming.summaries) {
      if (!have.has(s.text)) {
        mem.summaries.push(s)
        have.add(s.text)
      }
    }
    // addCausalLinks 要的是 {cause, effect} 文本，而存储里是 {fromFactId, toFactId}，
    // 所以先按 id 把两端的文本查出来再交给它重新解析
    const byId = new Map(mem.facts.map((f) => [f.id, f.text]))
    const causals = incoming.causalLinks
      .map((l) => ({
        cause: byId.get(l.fromFactId) || '',
        effect: byId.get(l.toFactId) || '',
        reason: l.reason
      }))
      .filter((c) => c.cause && c.effect)
    addCausalLinks(mem, causals)
    saveMemoryData(mem, pid)
    return { mode, facts: mem.facts.length, added, updated }
  }

  saveMemoryData(incoming, pid)
  return { mode, facts: incoming.facts.length, added: incoming.facts.length, updated: 0 }
}

// 找出同一分区内互相重复/高度相近的事实，供界面合并。
// 重建记忆是追加式的，重复跑几遍就会攒下近似条目；compareFacts 是提炼写入时
// 用的同一套判重逻辑，用它来分组才和"再讲一遍会被识别成同一件事"保持一致。
//
// 但必须分级：compareFacts 的 possible-conflict 只是"有点像"，它连是不是同一件事
// 都不确定（"用户对伴侣表达爱意"和"只爱对方一人"相似度 0.61 就被归进来）。
// 把这种条目一键合并等于删掉真实记忆和它的出处原话，所以：
//   exact  —— 判定为同一事实（same-confirm / same-update），可以放心批量合并
//   review —— 只是相似，必须用户逐组看一眼再决定
export function findDuplicateGroups(personalityId) {
  const mem = readRawMemory(personalityId)
  const exact = []
  const review = []
  const usedExact = new Set()
  const usedReview = new Set()

  const isExact = (a, b) => {
    const c = compareFacts(a.text, b.text)
    return Boolean(c && (c.kind === 'same-confirm' || c.kind === 'same-update'))
  }
  const isReview = (a, b) => {
    const c = compareFacts(a.text, b.text)
    return Boolean(c && c.kind === 'possible-conflict')
  }

  // 先摘确定的重复，剩下的再按"仅相似"分组，避免一个问题同时进两个篮子
  for (let i = 0; i < mem.facts.length; i++) {
    const a = mem.facts[i]
    if (usedExact.has(a.id)) continue
    const group = [a]
    for (let j = i + 1; j < mem.facts.length; j++) {
      const b = mem.facts[j]
      if (usedExact.has(b.id)) continue
      if (isExact(a, b)) {
        group.push(b)
        usedExact.add(b.id)
      }
    }
    if (group.length > 1) {
      usedExact.add(a.id)
      exact.push(group)
    }
  }

  for (let i = 0; i < mem.facts.length; i++) {
    const a = mem.facts[i]
    if (usedExact.has(a.id) || usedReview.has(a.id)) continue
    const group = [a]
    for (let j = i + 1; j < mem.facts.length; j++) {
      const b = mem.facts[j]
      if (usedExact.has(b.id) || usedReview.has(b.id)) continue
      if (isReview(a, b)) {
        group.push(b)
        usedReview.add(b.id)
      }
    }
    if (group.length > 1) {
      usedReview.add(a.id)
      review.push(group)
    }
  }

  return { exact, review }
}

// 把一组重复事实并成一条：可信度取最高、关键词取并集、出处取"最早那轮 + 对应原话"，
// 手工事实优先保留（用户自己写的东西不能被合并掉）
export function mergeFacts(ids, personalityId) {
  const mem = readRawMemory(personalityId)
  const idSet = new Set(ids)
  const picked = mem.facts.filter((f) => idSet.has(f.id))
  if (picked.length < 2) return loadMemory()

  const manual = picked.find((f) => f.manual)
  const longest = picked.reduce((acc, f) => (f.text.length > acc.text.length ? f : acc))
  const withQuote = picked.filter((f) => f.quote)
  // 出处取最早说话的那一轮：她"第一次听说"这件事的位置最贴近真实剧情顺序
  const earliest = withQuote.reduce(
    (acc, f) => {
      const t = Number.isFinite(Number(f.turn)) ? Number(f.turn) : Infinity
      return t < acc.t ? { t, f } : acc
    },
    { t: Infinity, f: null }
  )

  const keywords = []
  for (const f of picked) {
    for (const k of f.keywords || []) if (!keywords.includes(k)) keywords.push(k)
  }

  const merged = {
    ...longest,
    id: manual?.id || longest.id,
    text: manual?.text || longest.text,
    keywords: keywords.slice(0, 40),
    confidence: Math.max(...picked.map((f) => normalizeConfidence(f.confidence))),
    sensitive: picked.some((f) => f.sensitive),
    manual: picked.some((f) => f.manual),
    createdAt: Math.min(...picked.map((f) => Number(f.createdAt) || Date.now())),
    lastRelevant: Math.max(...picked.map((f) => Number(f.lastRelevant) || 0)) || Date.now(),
    conflicts: [...new Set(picked.flatMap((f) => f.conflicts || []))].filter((x) => !idSet.has(x)),
    turn: earliest.f ? earliest.f.turn : (longest.turn ?? null),
    quote: earliest.f ? earliest.f.quote : (longest.quote || '')
  }

  mem.facts = mem.facts.filter((f) => !idSet.has(f.id))
  mem.facts.push(merged)
  // 因果链重定向到保留下来的那条，避免合并后指向不存在的事实
  const keepId = merged.id
  mem.causalLinks = mem.causalLinks.map((l) => ({
    ...l,
    fromFactId: idSet.has(l.fromFactId) ? keepId : l.fromFactId,
    toFactId: idSet.has(l.toFactId) ? keepId : l.toFactId
  }))
  // 自己指向自己的因果链（两端原来是不同事实）没有意义，去掉
  mem.causalLinks = mem.causalLinks.filter((l) => l.fromFactId !== l.toFactId)
  saveMemoryData(mem, personalityId)
  return loadMemory()
}

// 一次并掉所有重复组，返回合并前后的条数
export function mergeAllDuplicates(personalityId) {
  const before = readRawMemory(personalityId).facts.length
  // 只合并"确定是同一事实"的那一组；仅相似的要用户在界面上逐组确认，
  // 自动合并它们会连真实记忆和出处一起删掉
  const { exact } = findDuplicateGroups(personalityId)
  for (const g of exact) mergeFacts(g.map((f) => f.id), personalityId)
  const after = readRawMemory(personalityId).facts.length
  return { groups: exact.length, before, after, removed: before - after }
}
