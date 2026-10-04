export const APP_NAME = '星语'
export const APP_NAME_EN = 'STARVOX'

// 官方 model id：deepseek-flash（= DeepSeek-V4.1-Flash）/ deepseek-v4-pro（= DeepSeek-V4-Pro-0813）
// 旧 id `deepseek-v4-flash` 目前仍可调用，但对应模型已下线、由 V4.1-Flash 代答，故统一用新 id
export const DEFAULT_MODEL = 'deepseek-flash'
export const MODELS = [
  {
    id: 'deepseek-flash',
    label: 'DeepSeek V4.1 Flash',
    desc: '响应快 · 性价比高 · 支持图像理解',
    tag: '推荐'
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    desc: '推理更强 · 适合复杂对话',
    tag: '更强'
  }
]

// 旧版存档里可能还存着 deepseek-v4-flash，读配置时统一迁移到新 id，避免用户被迫重选
const LEGACY_MODEL_ALIASES = { 'deepseek-v4-flash': 'deepseek-flash' }

export function normalizeModel(id) {
  return LEGACY_MODEL_ALIASES[id] || id || DEFAULT_MODEL
}

export const THINKING_MODES = [
  { id: 'auto', label: '不思考', desc: '最快' },
  { id: 'thinking', label: '思考模式', desc: '质量更高' },
  { id: 'max', label: '深度思考', desc: '最强推理' }
]

export const STORAGE_KEYS = {
  config: 'xingyu.config.v1',
  configSession: 'xingyu.config.session',
  session: 'xingyu.session.v1',
  memory: 'xingyu.memory.v1',
  // 旧版全局记忆的"已认领"标记：确保它只会被迁移进一个人格的记忆区
  memoryMigrated: 'xingyu.memory.migrated.v1',
  crypto: 'xingyu.crypto.v1',
  // 匿名安装标识（非敏感，不随"清除数据"删除，避免每次都换身份）
  uid: 'xingyu.uid.v1'
}

// 官方 user_id：只允许 [a-zA-Z0-9-_]，用于 KVCache 缓存隔离与调度隔离。
// 这里只放随机生成的匿名标识，绝不放任何真实身份信息（官方也明确要求不要放隐私信息）。
let fallbackUserId = ''

export function buildUserId() {
  try {
    let id = localStorage.getItem(STORAGE_KEYS.uid)
    if (id && /^[a-zA-Z0-9_-]{8,64}$/.test(id)) return id
    const rand =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID().replace(/-/g, '')
        : Math.random().toString(36).slice(2) + Date.now().toString(36)
    id = `xy-${rand.slice(0, 24)}`
    localStorage.setItem(STORAGE_KEYS.uid, id)
    return id
  } catch {
    // 隐私模式/存储被禁用时不要拖垮请求：退化成"本次会话固定"的匿名值
    if (!fallbackUserId) {
      fallbackUserId = `xy-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
    }
    return fallbackUserId
  }
}

export const MAX_HISTORY_TURNS = 20
