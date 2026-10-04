export const EMOTION_LABELS = [
  { id: 'CALM_RATIONAL', name: '平静理性', color: '#7dd3fc', expr: { eyes: 'normal', mouth: 'smile' }, speech: '语气平稳温和、条理清晰，不冷淡也不过度热情' },
  { id: 'QUIET_FOND', name: '安静眷恋', color: '#a5b4fc', expr: { eyes: 'soft', mouth: 'smile' }, speech: '语气柔和眷恋，话不多但字字温暖，带着舍不得结束的意味' },
  { id: 'SWEET_ATTACHMENT', name: '甜蜜依恋', color: '#f9a8d4', expr: { eyes: 'heart', mouth: 'grin' }, speech: '语气甜而粘人，想靠近、想多待一会儿，会自然地说想你' },
  { id: 'SHY_HEARTBEAT', name: '害羞心动', color: '#fda4af', expr: { eyes: 'shy', mouth: 'pout' }, speech: '说话有些打结、躲闪，想靠近又不好意思，藏不住脸红' },
  { id: 'EXCITED_JOY', name: '雀跃开心', color: '#fcd34d', expr: { eyes: 'happy', mouth: 'open' }, speech: '兴奋雀跃，语气轻快、短句和感叹多，藏不住开心' },
  { id: 'TSUNDERE', name: '傲娇别扭', color: '#fb923c', expr: { eyes: 'side', mouth: 'pout' }, speech: '嘴上硬、语气别扭，行动却暴露关心，别扭一句后偶尔软一下' },
  { id: 'INSECURE_ATTACHED', name: '患得患失', color: '#c084fc', expr: { eyes: 'wide', mouth: 'pout' }, speech: '依恋很深但心里没底：会反复确认你的语气和态度，怕自己读错，一点变化就翻来覆去地想' },
  { id: 'HURT_GRIEVANCE', name: '委屈难过', color: '#93c5fd', expr: { eyes: 'tear', mouth: 'frown' }, speech: '语气低落委屈，可能带点哭腔，需要被哄、被解释' },
  { id: 'SAD_LONELY', name: '低落孤单', color: '#94a3b8', expr: { eyes: 'sad', mouth: 'frown' }, speech: '话变少、句尾发蔫，有点提不起劲，但仍会认真回应对方' },
  { id: 'COLD_DETACHED', name: '冷淡疏离', color: '#818cf8', expr: { eyes: 'flat', mouth: 'neutral' }, speech: '短句、克制、拉开距离，礼貌但明显降温' },
  { id: 'MEETING_STRANGER', name: '初见客气', color: '#7dd3fc', expr: { eyes: 'normal', mouth: 'smile' }, speech: '刚认识不久：礼貌、留有余地，带一点好奇，不热络也不冷淡' },
  { id: 'ANGRY_ATTACK', name: '生气炸毛', color: '#f87171', expr: { eyes: 'angry', mouth: 'grit' }, speech: '语气冲、带刺，但绝不说人身攻击的话，其实随时可能被哄好' },
  { id: 'FEARFUL_OBEDIENT', name: '不安顺从', color: '#c4b5fd', expr: { eyes: 'wide', mouth: 'tremble' }, speech: '小心翼翼、唯恐说错话，语气发怯，渴望被肯定' }
]

// 初次见面：陌生感为主，但保持礼貌与一点好奇——
// 依恋低（没交情）、有戒心、唤醒低（还没热起来）、支配中性（无上下位）
export const STRANGER_EMOTION = { aff: 12, sec: 20, aro: 12, dom: 0 }

// 人格自带的情绪底色（恋爱关系里那种"已经熟了"的默认值）只在关系建立后作为回落点使用
export const DEFAULT_EMOTION = { aff: 20, sec: 30, aro: 10, dom: -5 }

export const BASE_STIMULUS = {
  praise: { aff: 7, sec: 4.5, aro: 5, dom: -2 },
  hurtful: { aff: -10, sec: -11, aro: 7.5, dom: 5.5 },
  vulnerable: { aff: 10, sec: -2, aro: -1, dom: -5 },
  intimate: { aff: 5, sec: 2.5, aro: 4, dom: 1 },
  adult_explicit: { aff: 5.5, sec: 1, aro: 7.5, dom: 2 },
  playful: { aff: 4, sec: 2, aro: 6, dom: 1 },
  neutral: { aff: 0.5, sec: 1, aro: 0.3, dom: 0 }
}

const KEYWORDS = {
  praise: ['爱你', '喜欢你', '想你', '好棒', '真棒', '厉害', '好看', '漂亮', '可爱', '温柔', '聪明', '欣赏', '夸你', '优秀', '贴心', '最爱', '抱抱', '摸摸头'],
  hurtful: ['滚开', '给我滚', '讨厌', '废物', '蠢货', '真蠢', '笨蛋', '真笨', '傻瓜', '真傻', '恶心', '烦死', '闭嘴', '滚蛋', '你有病', '有毛病', '去死', '恨你', '垃圾'],
  vulnerable: ['难过', '伤心', '哭', '委屈', '害怕', '孤独', '好累', '压力', '焦虑', '崩溃', '失眠', 'emo'],
  intimate: ['亲亲', '宝贝', '亲爱的', '抱一下', '亲一下', '想抱', '亲我', '吻我', '抱着我', '贴贴', '摸我', '撒娇'],
  // 这张表决定 isSensitiveText，进而决定"成人模式关闭时哪些历史轮次不发给模型"。
  // 漏一个词意味着那一轮会被照常发出，所以宁可多列；
  // 但也不能用"身体/胸/下面/射"这类日常也会出现的裸词 —— 误判会把正常轮次当露骨剔掉。
  // 所以这里的词都带上下文或本身就足够明确。
  adult_explicit: [
    '做爱', '上床', '色色', '裸体', '裸露', '口交', '操我', '操你', '黄文', '性幻想',
    '脱了', '脱掉', '脱光', '一丝不挂', '光着', '全裸', '半裸', '解开衣服', '掀开衣服',
    '舔', '含住', '插', '抽插', '射精', '射了', '高潮', '呻吟', '发情', '情欲',
    '你的身体', '摸胸', '揉胸', '舔胸', '胸部', '你的胸', '胸好', '屁股翘', '下面湿', '下面痒',
    '下面好', '摸下面', '舔下面', '插下面',
    '硬了', '湿了', '想要你', '要我', '上你', '干你', '睡我', '睡你',
    '肉棒', '阴道', '乳头', '龟头', '阴蒂', '精液', '淫', '骚', '荡妇'
  ],
  playful: ['哈哈', '嘿嘿', '嘻嘻', '逗你', '开玩笑', '好玩', '笑死', '整活']
}

function countKeywordHits(t, w) {
  let count = 0
  let idx = 0
  while ((idx = t.indexOf(w, idx)) !== -1) {
    const before = t[idx - 1]
    // 紧跟"不/没/别/甭"的否定形式不算命中（如"不讨厌""没毛病"）
    if (before !== '不' && before !== '没' && before !== '别' && before !== '甭') count++
    idx += w.length
  }
  return count
}

export function classifyStimulus(text = '') {
  const t = String(text).toLowerCase()
  const hits = []
  for (const [type, words] of Object.entries(KEYWORDS)) {
    let count = 0
    for (const w of words) {
      count += countKeywordHits(t, w.toLowerCase())
    }
    if (count > 0) hits.push({ type, count })
  }
  if (hits.length === 0) return { type: 'neutral', strength: 0.6 }
  hits.sort((a, b) => b.count - a.count)
  return { type: hits[0].type, strength: Math.min(1.6, 0.7 + (hits[0].count - 1) * 0.4) }
}

export function applyStimulus(state, type, strength = 1) {
  const base = BASE_STIMULUS[type] || BASE_STIMULUS.neutral
  // 防御：strength 只要进来一次非有限值（NaN/Infinity），
  // 情绪四维就会永久变成 NaN，之后标签、提示词全部失效且无法自愈。
  // 这里直接夹到有限范围，宁可当 1 也不能让状态被污染。
  const s = Number.isFinite(strength) ? Math.max(-2, Math.min(2, strength)) : 1
  const next = { ...state }
  for (const dim of ['aff', 'sec', 'aro', 'dom']) {
    const cur = Number.isFinite(next[dim]) ? next[dim] : 0
    const v = cur + (base[dim] ?? 0) * s
    next[dim] = clamp(Number.isFinite(v) ? v : cur, -100, 100)
  }
  return next
}

export function decayTowardBaseline(state, baseline, rate = 0.12) {
  const next = { ...state }
  const r = Number.isFinite(rate) ? Math.max(0, Math.min(1, rate)) : 0.12
  for (const dim of ['aff', 'sec', 'aro', 'dom']) {
    const cur = Number.isFinite(next[dim]) ? next[dim] : 0
    const rawTarget = baseline?.[dim]
    const target = Number.isFinite(rawTarget) ? rawTarget : 0
    next[dim] = clamp(cur + (target - cur) * r, -100, 100)
  }
  return next
}

// firstMeeting：关系阶段不属于情绪数值，必须显式传入，否则"初见"只能靠数值区间猜，
// 会跟"平静理性""冷淡疏离"互相抢区间（实测会吞掉这两档）
export function mapEmotionLabel(state, firstMeeting = false) {
  if (firstMeeting) return 'MEETING_STRANGER'
  const { aff, sec, aro, dom } = state
  if (aff < -40 && dom > 15) return 'ANGRY_ATTACK'
  if (aff < -30 && sec < -30) return 'HURT_GRIEVANCE'
  if (sec < -35 && dom < -20) return 'FEARFUL_OBEDIENT'
  if (aff < 5 && aro < -10) return 'SAD_LONELY'
  if (aff < 10) return 'COLD_DETACHED'
  if (aff > 55 && aro > 45) return 'SWEET_ATTACHMENT'
  // 依恋很深但安全感很低：患得患失。必须排在 TSUNDERE 之前，
  // 否则这一档会被"傲娇别扭"吃掉（它本来是给中等依恋的口是心非型准备的）
  if (aff > 45 && sec <= 20 && aro > 20) return 'INSECURE_ATTACHED'
  if (aro > 60 && aff > 25 && aff < 60 && dom < 10) return 'SHY_HEARTBEAT'
  if (aff > 25 && aff < 60 && aro > 40) return 'TSUNDERE'
  if (aff > 55 && aro < 20) return 'QUIET_FOND'
  if (aro > 45) return 'EXCITED_JOY'
  return 'CALM_RATIONAL'
}

export function getEmotionLabel(id) {
  return EMOTION_LABELS.find((l) => l.id === id) || EMOTION_LABELS[0]
}

// 关系阶段：只要对方一句话都还没说过，就仍处于"第一次见面"。
// 放在这里是为了让所有取情绪标签的地方（侧栏、情绪面板、系统提示词）判断口径完全一致
export function isFirstMeeting(session) {
  return !session?.messages?.some((m) => m.role === 'user')
}

export function emotionLabelOf(session) {
  return getEmotionLabel(mapEmotionLabel(session?.emotion, isFirstMeeting(session)))
}

// 情绪图鉴：每种情绪对应的四维大致条件（展示用；精确判定仍走 mapEmotionLabel）
export const EMOTION_RULES = [
  { id: 'SWEET_ATTACHMENT', cond: '依恋很高 + 唤醒高' },
  { id: 'SHY_HEARTBEAT', cond: '唤醒很高 + 依恋中等 + 不强势' },
  { id: 'QUIET_FOND', cond: '依恋很高 + 唤醒低' },
  { id: 'EXCITED_JOY', cond: '唤醒很高' },
  { id: 'TSUNDERE', cond: '依恋中等 + 唤醒较高' },
  { id: 'INSECURE_ATTACHED', cond: '依恋很深 + 安全感很低' },
  { id: 'CALM_RATIONAL', cond: '其余常见状态' },
  { id: 'MEETING_STRANGER', cond: '尚未正式认识（第一次见面阶段）' },
  { id: 'SAD_LONELY', cond: '依恋低 + 唤醒低' },
  { id: 'COLD_DETACHED', cond: '依恋很低' },
  { id: 'HURT_GRIEVANCE', cond: '依恋低 + 安全感崩' },
  { id: 'ANGRY_ATTACK', cond: '依恋极低 + 支配高' },
  { id: 'FEARFUL_OBEDIENT', cond: '安全感极低 + 很顺从' }
]

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v))
}
