import { Capacitor, registerPlugin } from '@capacitor/core'

const fileExport = registerPlugin('FileExport')
export const MAX_IMAGES = 3

export async function prepareImage(file, { maxEdge = 1280, maxChars = 420000 } = {}) {
  if (!file || !/^image\/(jpeg|png|webp|gif)$/.test(file.type)) throw new Error('请选择 JPG、PNG、WebP 或 GIF 图片')
  if (file.size > 12 * 1024 * 1024) throw new Error('单张原图不能超过 12 MB')
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    await new Promise((resolve, reject) => {
      image.onload = resolve
      image.onerror = () => reject(new Error('图片无法解码，请换一张图片'))
      image.src = url
    })
    if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 80000000) throw new Error('图片尺寸过大，请先缩小图片')
    const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('当前浏览器不能处理图片')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    let dataUrl = canvas.toDataURL('image/jpeg', 0.82)
    for (const quality of [0.65, 0.45, 0.3]) {
      if (dataUrl.length <= maxChars) break
      dataUrl = canvas.toDataURL('image/jpeg', quality)
    }
    if (dataUrl.length > maxChars) throw new Error('压缩后图片仍较大，请裁剪图片后重试')
    return { id: crypto.randomUUID(), name: file.name.slice(0, 120), type: 'image/jpeg', dataUrl, width: canvas.width, height: canvas.height }
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function saveFile(content, filename, type, base64 = false) {
  const safeName = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
  if (Capacitor.getPlatform() === 'android') {
    return fileExport.saveFile({ content, filename: safeName, mimeType: type.split(';')[0], base64 })
  }
  const data = base64 ? Uint8Array.from(atob(content), c => c.charCodeAt(0)) : content
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = safeName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
  return { saved: true }
}

export function downloadText(text, filename, type = 'text/plain;charset=utf-8') {
  return saveFile(text, filename, type)
}

export function downloadImage(attachment) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s.exec(attachment.dataUrl || '')
  if (!match) return Promise.reject(new Error('图片格式无效，无法保存'))
  const extension = match[1].split('/')[1].replace('jpeg', 'jpg')
  const filename = (attachment.name || '星语图片').replace(/\.[^.]+$/, '') + '.' + extension
  return saveFile(match[2], filename, match[1], true)
}

export function conversationMarkdown(session, name) {
  return `# ${session.title || '星语对话'}\n\n` + session.messages.filter(m => !m.pending).map(m =>
    `### ${m.role === 'user' ? '你' : name}${m.starred ? ' · 已收藏' : ''}\n\n${m.content || ''}${m.attachments?.length ? '\n\n' + m.attachments.map(a => `[图片：${a.name}]`).join('\n') : ''}`
  ).join('\n\n---\n\n')
}
