import { useMemo, useState } from 'react'
import { getPersonality } from '../lib/personalities'

export default function ConversationPanel({ conversations, activeId, onSelect, onNew, onRename, onDelete }) {
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(null)
  const [title, setTitle] = useState('')
  const [deleting, setDeleting] = useState(null)
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    return conversations.filter(c => !q || `${c.title || ''} ${getPersonality(c.personalityId).name} ${c.searchText || c.messages?.map(m => m.content).join(' ') || ''}`.toLocaleLowerCase().includes(q))
  }, [conversations, query])
  return <section className="conversation-panel" aria-label="对话列表">
    <div className="conversation-heading"><strong>我的对话</strong><button className="btn btn-primary btn-sm" onClick={onNew}>＋ 新对话</button></div>
    <input className="input conversation-search" aria-label="搜索全部对话" placeholder="搜索对话标题或内容" value={query} onChange={e => setQuery(e.target.value)} />
    <div className="conversation-list">
      {filtered.map(c => <div className={`conversation-item ${c.id === activeId ? 'active' : ''}`} key={c.id}>
        {editing === c.id ? <form onSubmit={e => { e.preventDefault(); if (onRename(c.id, title) !== false) setEditing(null) }}><input aria-label="对话名称" className="input" autoFocus maxLength={80} value={title} onChange={e => setTitle(e.target.value)} /><div className="conversation-actions"><button type="submit">保存名称</button><button type="button" onClick={() => setEditing(null)}>取消</button></div></form> : <>
          <button className="conversation-select" aria-current={c.id === activeId ? 'true' : undefined} onClick={() => onSelect(c.id)}><span>{c.title || '新对话'}</span><small>{getPersonality(c.personalityId).name} · {c.messageCount ?? c.messages?.filter(m => !m.local).length ?? 0} 条消息</small></button>
          <div className="conversation-actions"><button onClick={() => { setEditing(c.id); setTitle(c.title || '') }}>改名</button><button onClick={() => setDeleting(c.id)}>删除</button></div>
        </>}
        {deleting === c.id && <div className="conversation-delete"><p>删除这段对话？人格记忆会保留。</p><button onClick={() => { if (onDelete(c.id) !== false) setDeleting(null) }}>确认删除</button><button onClick={() => setDeleting(null)}>取消</button></div>}
      </div>)}
      {!filtered.length && <p className="gate-hint">没有匹配的对话</p>}
    </div>
    <p className="gate-hint">每段对话独立保存；同一人格共享长期记忆。</p>
  </section>
}
