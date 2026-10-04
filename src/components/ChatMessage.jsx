import { memo } from 'react'
import { renderMarkdown } from '../lib/markdown.jsx'

export default memo(function ChatMessage({ msg, active, partial, thinking, reasoning, presetName, presetEmoji, disabled, onAction }) {
  return <article className={`msg ${msg.role}`} data-message-id={msg.id}>
    <span className="msg-avatar">{msg.role === 'assistant' ? presetEmoji : '你'}</span>
    <div className="msg-body">
      <span className="msg-role">{msg.role === 'assistant' ? presetName : '你'}{msg.starred ? ' · 已收藏' : ''}</span>
      {msg.attachments?.length > 0 && <div className="attachment-strip message-images">{msg.attachments.map(a => <a href={a.dataUrl} download={a.name} key={a.id} title={`保存 ${a.name}`} onClick={event => { event.preventDefault(); onAction('image', a) }}><img src={a.dataUrl} alt={a.name} loading="lazy" /></a>)}</div>}
      {(reasoning || msg.reasoning) && <details className="reasoning-panel"><summary>思考过程</summary><div>{reasoning || msg.reasoning}</div></details>}
      <div className="bubble ai chat">{active ? thinking && !partial ? <span className="thinking-line"><span className="spinner" />正在思考…</span> : <>{renderMarkdown(partial)}<span className="stream-caret" /></> : renderMarkdown(msg.content || (msg.status === 'stopped' ? '已停止生成' : msg.status === 'failed' ? '发送失败，可重试' : ''))}</div>
      {!active && msg.error && <p className="message-error" role="status">{msg.error}</p>}
      {!active && msg.status === 'stopped' && <small className="muted">已停止 · 内容已保留</small>}
      {!active && <div className="message-actions">
        <button onClick={() => onAction('copy', msg)} disabled={!msg.content}>复制</button>
        <button onClick={() => onAction('star', msg)} aria-pressed={Boolean(msg.starred)}>{msg.starred ? '取消收藏' : '收藏'}</button>
        {msg.role === 'user' && <button disabled={disabled} onClick={() => onAction('edit', msg)}>编辑并分支</button>}
        {msg.role === 'assistant' && !msg.local && <button disabled={disabled} onClick={() => onAction('retry', msg)}>{msg.status === 'failed' || msg.status === 'stopped' ? '重试' : '重新生成'}</button>}
        {msg.role === 'assistant' && msg.content && <button onClick={() => onAction('speak', msg)}>朗读</button>}
      </div>}
    </div>
  </article>
})
