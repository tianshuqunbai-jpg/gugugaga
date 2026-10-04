// 本地加密层：口令 → PBKDF2-SHA256 派生密钥 → AES-256-GCM 落盘。
// 使用同步实现（@noble），与现有同步 localStorage 架构无缝衔接；
// 密钥只存在内存里，刷新页面后需要重新输入口令解锁。
import { gcm } from '@noble/ciphers/aes.js'
import { pbkdf2 } from '@noble/hashes/pbkdf2.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { STORAGE_KEYS } from './constants.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const ITERATIONS = 210000

// 需要被保护的落盘数据：对话、长期记忆、被"记住"的密钥配置
const CONVERSATIONS_KEY = 'xingyu.conversations.v1'
const PROTECTED_KEYS = [STORAGE_KEYS.session, STORAGE_KEYS.memory, STORAGE_KEYS.config, CONVERSATIONS_KEY]

// 长期记忆按人格分区后是一组动态 key（xingyu.memory.v1::<人格id>），
// 不在上面的固定清单里，所以这里用前缀匹配把它们一起纳入保护范围
const PROTECTED_PREFIXES = [`${STORAGE_KEYS.memory}::`]

function isProtectedKey(key) {
  return PROTECTED_KEYS.includes(key) || PROTECTED_PREFIXES.some((p) => String(key).startsWith(p))
}

// 当前实际存在的受保护 key（固定清单 + 已落盘的分区记忆 key）
function listProtectedKeys() {
  const keys = new Set(PROTECTED_KEYS)
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && isProtectedKey(k)) keys.add(k)
    }
  } catch {
    /* 存储被禁用时只处理固定清单 */
  }
  return [...keys]
}

let cachedKey = null // Uint8Array(32)，仅存内存

function randBytes(n) {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

function toB64(bytes) {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(s)
}

function fromB64(str) {
  const s = atob(str)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

function readEnvelope() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.crypto)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function deriveKey(passphrase, saltB64) {
  return pbkdf2(sha256, encoder.encode(passphrase), fromB64(saltB64), {
    c: ITERATIONS,
    dkLen: 32
  })
}

function encryptString(key, plaintext) {
  const iv = randBytes(12)
  const ct = gcm(key, iv).encrypt(encoder.encode(plaintext))
  return { iv: toB64(iv), data: toB64(ct) }
}

function decryptString(key, payload) {
  return decoder.decode(gcm(key, fromB64(payload.iv)).decrypt(fromB64(payload.data)))
}

function isEncryptedPayload(raw) {
  try {
    const parsed = JSON.parse(raw)
    return Boolean(parsed && parsed.v === 1 && parsed.enc === true)
  } catch {
    return false
  }
}

export function isCryptoEnabled() {
  return Boolean(readEnvelope()?.enabled)
}

export function isUnlocked() {
  return Boolean(cachedKey)
}

// 开启加密：派生密钥 → 把已有明文数据加密落盘 → 写入盐与校验罐
export function enableCrypto(passphrase) {
  if (isCryptoEnabled()) throw new Error('本地加密已开启')
  const salt = randBytes(16)
  const saltB64 = toB64(salt)
  const key = deriveKey(passphrase, saltB64)
  const envelope = {
    enabled: true,
    kdf: 'PBKDF2-SHA256',
    iterations: ITERATIONS,
    salt: saltB64
  }
  envelope.canary = encryptString(key, JSON.stringify({ ok: true }))
  // 用 listProtectedKeys：把已经落盘的分区记忆 key 也一并加密，
  // 否则开启隐私锁时那些记忆会留在明文状态
  const keys = listProtectedKeys()
  const before = new Map(keys.map((k) => [k, localStorage.getItem(k)]))
  const priorEnvelope = localStorage.getItem(STORAGE_KEYS.crypto)
  try {
    for (const k of keys) {
      const raw = before.get(k)
      if (raw && !isEncryptedPayload(raw)) {
        const payload = encryptString(key, raw)
        localStorage.setItem(k, JSON.stringify({ v: 1, enc: true, ...payload }))
      }
    }
    localStorage.setItem(STORAGE_KEYS.crypto, JSON.stringify(envelope))
  } catch (error) {
    // Roll back even when the final envelope write exhausts the quota.
    for (const k of keys) localStorage.removeItem(k)
    for (const [k, raw] of before) if (raw !== null) localStorage.setItem(k, raw)
    if (priorEnvelope === null) localStorage.removeItem(STORAGE_KEYS.crypto)
    else localStorage.setItem(STORAGE_KEYS.crypto, priorEnvelope)
    throw error
  }
  cachedKey = key
  return true
}

// 解锁：口令错误时校验罐解密会抛异常
export function unlockCrypto(passphrase) {
  const envelope = readEnvelope()
  if (!envelope?.enabled) {
    cachedKey = null
    return true
  }
  try {
    const key = deriveKey(passphrase, envelope.salt)
    decryptString(key, envelope.canary)
    cachedKey = key
    return true
  } catch {
    cachedKey = null
    return false
  }
}

export function lockCrypto() {
  cachedKey = null
}

// 关闭加密：验证口令后把数据解密回明文，删除口令信封
export function disableCrypto(passphrase) {
  if (!isCryptoEnabled()) return true
  const previousKey = cachedKey
  if (!unlockCrypto(passphrase)) { cachedKey = previousKey; return false }
  const keys = listProtectedKeys()
  const before = new Map(keys.map((k) => [k, localStorage.getItem(k)]))
  const envelope = localStorage.getItem(STORAGE_KEYS.crypto)
  try {
    const plain = new Map()
    for (const [k, raw] of before) {
      if (raw !== null) {
        const value = readSecure(k)
        if (value === null) throw new Error('加密数据读取失败')
        plain.set(k, value)
      }
    }
    for (const [k, value] of plain) localStorage.setItem(k, value)
    localStorage.removeItem(STORAGE_KEYS.crypto)
  } catch (error) {
    for (const k of keys) localStorage.removeItem(k)
    for (const [k, raw] of before) if (raw !== null) localStorage.setItem(k, raw)
    if (envelope !== null) localStorage.setItem(STORAGE_KEYS.crypto, envelope)
    throw error
  }
  cachedKey = null
  return true
}

// 忘记口令：只能销毁被加密的数据（不可恢复），回到未加密状态
export function resetCryptoForget() {
  for (const k of listProtectedKeys()) localStorage.removeItem(k)
  localStorage.removeItem(STORAGE_KEYS.crypto)
  localStorage.removeItem(STORAGE_KEYS.memoryMigrated)
  sessionStorage.removeItem(STORAGE_KEYS.configSession)
  cachedKey = null
}

// 统一读入口：加密信封 → 解密；明文 → 原样返回；未解锁时返回 null
export function readSecure(key) {
  try {
    if (isCryptoEnabled() && !cachedKey && isProtectedKey(key)) return null
    const raw = localStorage.getItem(key)
    if (!raw) return null
    if (isEncryptedPayload(raw)) {
      if (!cachedKey) return null
      return decryptString(cachedKey, JSON.parse(raw))
    }
    return raw
  } catch {
    return null
  }
}

// 统一写入口：已开启且已解锁 → 加密落盘；否则明文落盘
export function writeSecure(key, value) {
  const envelope = readEnvelope()
  if (envelope?.enabled && !cachedKey) throw new Error('本地数据已锁定，请先解锁')
  if (!envelope?.enabled) {
    localStorage.setItem(key, value)
    return
  }
  const payload = encryptString(cachedKey, value)
  localStorage.setItem(key, JSON.stringify({ v: 1, enc: true, ...payload }))
}
