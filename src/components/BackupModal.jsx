import { useRef, useState } from 'react'
import { buildBackup, listConversations, parseBackup, restoreBackup } from '../lib/storage'
import { getPersonality } from '../lib/personalities'
import { exportAllPartitions } from '../lib/memory'
import { downloadText } from '../lib/media'

export default function BackupModal({
  session,
  config,
  onClose,
  onImportSession,
  onImportConfig,
  onImported
}) {
  const [includeSettings, setIncludeSettings] = useState(false)
  const [status, setStatus] = useState(null)
  const [preview, setPreview] = useState(null)
  const [exporting, setExporting] = useState(false)
  const fileRef = useRef(null)

  // 导出前先算清楚：这份备份到底带走了几个人格的记忆
  const partitionPreview = (() => {
    try {
      const by = exportAllPartitions()
      const pids = Object.keys(by)
      return {
        partitions: pids.length,
        facts: pids.reduce((n, p) => n + (by[p].facts?.length || 0), 0),
        summaries: pids.reduce((n, p) => n + (by[p].summaries?.length || 0), 0)
      }
    } catch {
      return { partitions: 0, facts: 0, summaries: 0 }
    }
  })()

  async function handleExport() {
    if (exporting) return
    let json
    try {
      json = buildBackup({ session, config, includeConfig: includeSettings })
    } catch (error) {
      setStatus({ type: 'error', text: error.message || '备份导出失败' })
      return
    }
    const exported = JSON.parse(json)
    const totalMessages = exported.conversations.reduce((n, s) => n + s.messages.length, 0)
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    setExporting(true)
    try {
      const result = await downloadText(json, `星语-备份-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.json`, 'application/json')
      if (result.cancelled) { setStatus({ type: 'success', text: '已取消导出，原有数据不变' }); return }
    // 说明带走的是"全部人格"的记忆：旧备份只含当前人格那一份，
    // 用户要能一眼分辨手里的文件是哪种，否则会以为记忆没备份上
    setStatus({
      type: 'success',
      text: `已导出 ${exported.conversations.length} 段对话、${totalMessages} 条消息和 ${partitionPreview.partitions} 个人格的 ${partitionPreview.facts} 条长期记忆，请存到安全位置`
    })
    } catch (error) {
      setStatus({ type: 'error', text: `导出失败：${error.message || '请重试'}` })
    } finally { setExporting(false) }
  }

  function handleFile(e) {
    setPreview(null)
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 50 * 1024 * 1024) { setStatus({ type: 'error', text: '备份文件过大，请选择小于 50 MB 的星语备份' }); return }
    const reader = new FileReader()
    reader.onload = () => {
      const res = parseBackup(String(reader.result))
      if (!res.ok) {
        setStatus({ type: 'error', text: `导入失败：${res.reason}` })
        return
      }
      setPreview(res)
      setStatus(null)
    }
    reader.onerror = () => setStatus({ type: 'error', text: '文件读取失败，请重新选择备份文件' })
    reader.readAsText(file)
    e.target.value = ''
  }

  function confirmImport() {
    if (!preview) return
    let restored
    try {
      restored = restoreBackup(preview)
    } catch (error) {
      setStatus({ type: 'error', text: `恢复失败：${error.message || '存储空间不足'}；原有数据已保留` })
      return
    }
    // Data is fully committed before React is notified.
    onImportSession?.(preview.session)
    if (preview.config) onImportConfig?.(preview.config)
    onImported?.()
    const preset = getPersonality(preview.session.personalityId)
    setStatus({
      type: 'success',
      text: `已恢复 ${restored.conversations} 段对话、${restored.partitions} 个人格的 ${restored.facts} 条长期记忆；当前人格「${preset.name}」`
    })
    setPreview(null)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="关闭">
          ✕
        </button>
        <h3>备份与恢复</h3>
        <p>
          对话记录目前只保存在浏览器本地，清除浏览器数据或换浏览器都会丢失。
          建议定期导出备份，换电脑或清数据后一键恢复。
        </p>

        <div className="rail-title" style={{ marginBottom: 12 }}>
          导出
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={includeSettings}
            onChange={(e) => setIncludeSettings(e.target.checked)}
          />
          <span>
            同时导出模型与思考设置
            <span className="muted" style={{ display: 'block', fontSize: 12 }}>
              备份始终不含 API Key。聊天与记忆仍属于私人数据，请妥善保管
            </span>
          </span>
        </label>
        <button className="btn btn-primary" disabled={exporting} style={{ width: '100%', marginTop: 14 }} onClick={handleExport}>
          导出备份文件（{listConversations().length || 1} 段对话 · {partitionPreview.partitions} 个人格的记忆）
        </button>
        <p className="gate-hint" style={{ marginTop: 8 }}>
          备份会带走全部人格的长期记忆，不只是当前这个。切成别人格再导出不会漏掉这边的剧情。
        </p>

        <div style={{ height: 22 }} />

        <div className="rail-title" style={{ marginBottom: 12 }}>
          导入
        </div>
        <label className="file-btn">
          选择备份文件导入
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            onChange={handleFile}
            style={{ display: 'none' }}
          />
        </label>
        <p className="gate-hint" style={{ marginTop: 8 }}>
          选择文件后先预览。确认恢复会覆盖本机对话和备份中相应人格的长期记忆。
        </p>

        {preview && (
          <div className="test-result" style={{ marginTop: 12 }}>
            <span>预览：{preview.conversations.length} 段对话、{preview.conversations.reduce((n, s) => n + s.messages.length, 0)} 条消息、{preview.partitionCount} 个人格的记忆{preview.config ? '，含模型与思考设置' : ''}。确认会替换本机对话列表，建议先导出当前备份。</span>
            <button className="btn btn-primary" type="button" onClick={confirmImport}>确认恢复</button>
            <button className="btn btn-ghost" type="button" onClick={() => setPreview(null)}>取消</button>
          </div>
        )}

        {status && (
          <div className={`test-result ${status.type}`} style={{ marginTop: 6 }}>
            <span>{status.type === 'success' ? '✓' : '✕'}</span>
            <span>{status.text}</span>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  )
}
