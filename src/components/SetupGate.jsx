import { useEffect, useRef, useState } from 'react'
import { DEFAULT_MODEL, MODELS, THINKING_MODES, normalizeModel } from '../lib/constants'
import { testKey, fetchModels } from '../lib/deepseek'
import { Brand } from './Navbar'

export default function SetupGate({ config, onSave, onReady, onBack }) {
  // 旧存档可能存着已下线的模型 id，读进来先做一次迁移
  const [model, setModel] = useState(normalizeModel(config.model || DEFAULT_MODEL))
  const [thinking, setThinking] = useState(config.thinkingMode || 'auto')
  const [testing, setTesting] = useState(false)
  const [status, setStatus] = useState(null)
  const [tested, setTested] = useState(false)
  const [availableModels, setAvailableModels] = useState(null)
  const testRef = useRef(null)
  useEffect(() => () => testRef.current?.abort(), [])

  const invalidate = () => {
    testRef.current?.abort()
    testRef.current = null
    setTesting(false)
    setTested(false)
    setStatus(null)
    setAvailableModels(null)
  }
  const back = () => { invalidate(); onBack() }

  const handleTest = async () => {
    testRef.current?.abort()

    setTesting(true)
    setTested(false)
    const controller = new AbortController()
    testRef.current = controller
    setStatus({ type: 'pending', text: '正在连接 DeepSeek 并验证密钥…' })
    const res = await testKey({
      model,
      thinkingMode: thinking,
      signal: controller.signal
    })
    if (testRef.current !== controller || controller.signal.aborted) return
    // 顺手问一次官方 /models，核对这个 Key 到底能用哪些模型（失败不影响测试结论）
    const modelsRes = res.ok ? await fetchModels({ signal: controller.signal }) : { ok: false }
    if (testRef.current !== controller || controller.signal.aborted) return
    setTesting(false)
    if (res.ok) {
      setAvailableModels(modelsRes.ok ? modelsRes.ids : null)
      setStatus({
        type: 'success',
        text: `连接成功！模型 ${res.model || model} 可用，开始聊天吧`
      })
      setTested(true)
    } else {
      setAvailableModels(null)
      setStatus({ type: 'error', text: res.message })
      setTested(false)
    }
  }

  const handleStart = () => {
    if (tested) {
      try {
        onSave({ connectionMode: 'server', model, thinkingMode: thinking, ready: true })
        onReady()
      } catch (error) { setStatus({ type: 'error', text: error.message || '配置保存失败，请重试' }) }
    }
  }

  return (
    <div className="setup-wrap">
      <div className="setup-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <Brand onClick={back} />
          <button className="btn btn-ghost btn-sm" onClick={back}>
            返回首页
          </button>
        </div>
        <h2>连接你的 AI 伙伴</h2>
        <p className="sub">
          测试服务器连接后即可开始聊天。密钥由本机服务读取，无需在页面填写。
        </p>

        <div className="field">
          <label>模型</label>
          <div className="model-grid">
            {MODELS.map((m) => (
              <div
                key={m.id}
                className={`model-card ${model === m.id ? 'active' : ''}`}
                onClick={() => { setModel(m.id); invalidate() }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setModel(m.id); invalidate() } }}
              >
                <span className={`m-tag ${m.id.includes('pro') ? 'pro' : ''}`}>{m.tag}</span>
                <div className="m-name">{m.label}</div>
                <div className="m-desc">{m.desc}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="field">
          <label>思考强度</label>
          <div className="thinking-options">
            {THINKING_MODES.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`thinking-option ${thinking === t.id ? 'active' : ''}`}
                onClick={() => { setThinking(t.id); invalidate() }}
                title={t.desc}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {status && (
          <div className={`test-result ${status.type}`}>
            <span>
              {status.type === 'success' ? '✓' : status.type === 'error' ? '✕' : '…'}
            </span>
            <span>{status.text}</span>
          </div>
        )}

        {availableModels && availableModels.length > 0 && (
          <p className="muted" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.6 }}>
            服务器可用的模型：
            <span className="mono">{availableModels.join(' · ')}</span>
            {!availableModels.includes(model) && (
              <span style={{ color: 'var(--warning)' }}>
                {' '}
                ⚠️ 当前选择的 {model} 不在列表里，建议改选上面的模型
              </span>
            )}
          </p>
        )}

        <div className="setup-actions">
          <button className="btn btn-ghost" onClick={handleTest} disabled={testing}>
            {testing ? (
              <>
                <span className="spinner" />
                测试中…
              </>
            ) : (
              '测试连接'
            )}
          </button>
          <button className="btn btn-primary" onClick={handleStart} disabled={!tested}>
            开始聊天
          </button>
        </div>

        <div className="security-note">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', marginTop: 2 }}>
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <span>
            对话保存在本机浏览器；聊天与记忆提炼会发送相关内容给 DeepSeek。
            语音识别可能使用浏览器提供商的在线服务，启用前会提示。
          </span>
        </div>
      </div>
    </div>
  )
}
