import { useEffect, useRef, useState } from 'react'
import { MAX_IMAGES, prepareImage } from '../lib/media'

export default function ComposerTools({ attachments, onAttachments, speech, model, disabled, onNotice }) {
  const fileRef = useRef(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const [processing, setProcessing] = useState(false)
  const [speechIntro, setSpeechIntro] = useState(false)
  const [settings, setSettings] = useState(false)
  const supportsImages = model === 'deepseek-flash' || model === 'deepseek-v4-flash'
  async function addImages(e) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    if (files.length + attachments.length > MAX_IMAGES) { onNotice(`一次最多选择 ${MAX_IMAGES} 张图片`); return }
    setProcessing(true)
    try {
      const prepared = []
      for (const file of files) prepared.push(await prepareImage(file))
      if (alive.current) onAttachments([...attachments, ...prepared])
    } catch (error) { if (alive.current) onNotice(error.message) } finally { if (alive.current) setProcessing(false) }
  }
  return <>
    {attachments.length > 0 && <div className="attachment-strip">{attachments.map(a => <div className="attachment-preview" key={a.id}><img src={a.dataUrl} alt={a.name} /><button disabled={disabled} aria-label={`移除 ${a.name}`} onClick={() => onAttachments(attachments.filter(item => item.id !== a.id))}>×</button><small>{a.name}</small></div>)}</div>}
    <div className="composer-tools">
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={addImages} />
      <button type="button" disabled={disabled || processing} title={supportsImages ? '添加图片，发送时交给 DeepSeek 识别' : '图片需要切换到 Flash 模型'} onClick={() => supportsImages ? fileRef.current?.click() : onNotice('请在 API 配置中选择 Flash，再发送图片')}>{processing ? '处理图片…' : '＋ 图片'}</button>
      <button type="button" disabled={disabled} aria-pressed={speech.listening} onClick={() => speech.listening ? speech.stopListening() : setSpeechIntro(true)}>{speech.listening ? '停止听写' : '语音输入'}</button>
      <button type="button" aria-expanded={settings} onClick={() => setSettings(v => !v)}>声音设置</button>
      {speech.speaking && <button type="button" onClick={speech.stopSpeech}>停止朗读</button>}
      <span className="composer-status">{speech.listening ? '正在听，请说话…' : attachments.length ? '图片随下一条消息发送' : '文字 · 图片 · 语音'}</span>
    </div>
    {settings && <div className="speech-settings"><label>朗读声音<select value={speech.voiceURI} onChange={e => speech.setVoiceURI(e.target.value)}><option value="">系统中文声音</option>{speech.voices.map(v => <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>)}</select></label><label>语速 {speech.rate.toFixed(1)}×<input type="range" min="0.6" max="1.6" step="0.1" value={speech.rate} onChange={e => speech.setRate(Number(e.target.value))} /></label><p className="gate-hint">声音由浏览器或系统提供，部分声音可能需要联网。</p></div>}
    {speechIntro && <div className="speech-settings" role="dialog" aria-label="使用语音输入"><p>语音识别可能由浏览器的联网服务处理音频。开始后浏览器会请求麦克风权限，识别文字先放入输入框，由你决定是否发送。</p><button className="btn btn-primary btn-sm" onClick={() => { setSpeechIntro(false); speech.startListening() }}>开始语音输入</button><button className="btn btn-ghost btn-sm" onClick={() => setSpeechIntro(false)}>取消</button></div>}
  </>
}
