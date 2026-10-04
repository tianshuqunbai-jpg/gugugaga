import { useState } from 'react'
import { resetCryptoForget, unlockCrypto } from '../lib/crypto'

export default function CryptoGate({ onUnlocked }) {
  const [pass, setPass] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [forget, setForget] = useState(false)

  function submit() {
    if (!pass || busy) return
    setBusy(true)
    setError(null)
    // 先让「正在解锁」状态渲染出来，再执行同步口令派生（约 0.5~1 秒）
    setTimeout(() => {
      const ok = unlockCrypto(pass)
      if (ok) {
        onUnlocked()
      } else {
        setError('口令不正确，请重试')
        setPass('')
        setBusy(false)
      }
    }, 40)
  }

  function confirmForget() {
    if (busy) return
    setBusy(true)
    setTimeout(() => {
      try {
        resetCryptoForget()
        onUnlocked()
      } catch (cause) {
        setError(cause?.message || '清除失败，请重试')
        setBusy(false)
      }
    }, 40)
  }

  return (
    <div className="setup-wrap">
      <div className="setup-card">
        <h2>🔒 本地数据已加密</h2>
        {forget ? (
          <>
            <p className="sub">
              忘记口令意味着被加密的对话和长期记忆无法找回，只能全部销毁。
              确定要清除全部数据吗？
            </p>
            <div className="setup-actions">
              <button className="btn btn-ghost" onClick={() => setForget(false)} disabled={busy}>
                返回输入口令
              </button>
              <button className="btn btn-heart" onClick={confirmForget} disabled={busy}>
                {busy ? '正在清除…' : '确认清除全部数据'}
              </button>
            </div>
            {error && <div className="test-result error"><span>✕</span><span>{error}</span></div>}
          </>
        ) : (
          <>
            <p className="sub">
              输入口令解锁你的对话与记忆。口令只在你的本机用于解密，不会存储、不会上传；
              忘记口令将无法找回数据。
            </p>
            <div className="field">
              <label>解锁口令</label>
              <input
                className="input"
                type="password"
                value={pass}
                autoFocus
                onChange={(e) => {
                  setPass(e.target.value)
                  setError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit()
                }}
              />
            </div>
            {error && (
              <div className="test-result error">
                <span>✕</span>
                <span>{error}</span>
              </div>
            )}
            <div className="setup-actions">
              <button className="btn btn-primary" onClick={submit} disabled={busy || !pass}>
                {busy ? '正在解锁…' : '解锁'}
              </button>
            </div>
            <p style={{ textAlign: 'center', fontSize: 13 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setForget(true)} disabled={busy}>
                忘记口令？
              </button>
            </p>
          </>
        )}
      </div>
    </div>
  )
}
