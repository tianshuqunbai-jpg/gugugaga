import { classifyStimulus } from './emotion'

// 明确的喊停信号（用户主动说出口才算；宁可不触发，绝不误伤）
// 长词组含义明确，可直接包含匹配；短词组容易误伤（如"今天不"会命中"今天不开心"），
// 必须左右有边界（标点/空白/句首句尾，或紧跟人称代词）才算数
const SUBSTRING_STOP_PHRASES = [
  '不要继续',
  '不想继续',
  '别继续',
  '停下来',
  '停下',
  '别碰我',
  '让我静静',
  '有点不舒服',
  '不想聊这个',
  '我想一个人待会',
  'leave me alone'
]

const BOUNDED_STOP_PHRASES = [
  '今天不',
  '算了',
  '够了',
  '不要了',
  '别这样',
  '走开',
  '别闹',
  '别闹了',
  '改天吧',
  '下次吧',
  'not now',
  'not tonight',
  'no more'
]

// 这些词出现时表示"继续"，优先级高于上面的停止信号（如"不要停/别停下"）
const CONTINUE_EXCEPTIONS = [
  '不要停',
  '别停',
  '别停下',
  '别停下来',
  '不要停下来',
  '不想停下来',
  '不能停',
  '舍不得停',
  '不停'
]

const PRONOUNS = new Set(['我', '你', '他', '她', '它', '俺', '咱'])

function isBoundary(ch) {
  return !ch || !/[\p{L}\p{N}]/u.test(ch)
}

function hasBoundedPhrase(text, phrase) {
  let idx = 0
  while ((idx = text.indexOf(phrase, idx)) !== -1) {
    const before = text[idx - 1]
    const after = text[idx + phrase.length]
    // 右边界必须成立；"我不要了/你够了"这类人称代词开头的也算左边界
    if (isBoundary(after) && (isBoundary(before) || PRONOUNS.has(before))) return true
    idx += phrase.length
  }
  return false
}

export function detectUserStop(text = '') {
  const t = String(text).toLowerCase().trim()
  if (!t) return false
  // 单独一个"停"字也是明确喊停
  if (t === '停' || t === 'stop') return true
  const hit =
    SUBSTRING_STOP_PHRASES.some((w) => t.includes(w)) ||
    BOUNDED_STOP_PHRASES.some((w) => hasBoundedPhrase(t, w))
  if (!hit) return false
  // 但若是"不要停/别停/不想停下来"这类继续信号，则不视为喊停
  return !CONTINUE_EXCEPTIONS.some((w) => t.includes(w))
}

export function isSensitiveType(type) {
  return type === 'adult_explicit' || type === 'intimate'
}

// 兜底分类：老数据没有 sensitive 标记时，用关键词粗判是否属于亲密/露骨轮次
export function isSensitiveText(text = '') {
  if (!text) return false
  return isSensitiveType(classifyStimulus(text).type)
}
