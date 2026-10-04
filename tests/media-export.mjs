import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

async function exportHarness(platform, nativeResult = { saved: true }) {
  const calls = []
  const downloads = []
  const blobs = []
  const timers = []
  const context = vm.createContext({
    Blob, Uint8Array, atob,
    URL: { createObjectURL(blob) { blobs.push(blob); return `blob:test-${blobs.length}` }, revokeObjectURL() {} },
    setTimeout(callback) { timers.push(callback) },
    document: {
      createElement(tag) {
        assert.equal(tag, 'a')
        assert.notEqual(platform, 'android', 'native exports must use the system picker')
        return { click() { downloads.push({ name: this.download, url: this.href }) }, remove() {} }
      },
      body: { appendChild() {} }
    }
  })
  const module = new vm.SourceTextModule(await readFile(new URL('../src/lib/media.js', import.meta.url), 'utf8'), { context })
  await module.link((specifier) => {
    assert.equal(specifier, '@capacitor/core')
    return new vm.SyntheticModule(['Capacitor', 'registerPlugin'], function () {
      this.setExport('Capacitor', { getPlatform: () => platform })
      this.setExport('registerPlugin', (name) => {
        assert.equal(name, 'FileExport')
        return { async saveFile(payload) {
          calls.push(payload)
          if (nativeResult instanceof Error) throw nativeResult
          return nativeResult
        } }
      })
    }, { context })
  })
  await module.evaluate()
  return { media: module.namespace, calls, downloads, blobs, timers }
}

test('Android backup keeps Unicode and reports picker cancellation or write failure', async () => {
  const cancelled = await exportHarness('android', { cancelled: true })
  const content = JSON.stringify({ title: '阅读计划🌙', messages: ['今晚读三章'] })
  const result = await cancelled.media.downloadText(content, '星语:备份.json', 'application/json;charset=utf-8')
  assert.equal(result.cancelled, true)
  assert.equal(result.saved, undefined)
  assert.equal(cancelled.calls[0].content, content)
  assert.equal(cancelled.calls[0].filename, '星语_备份.json')
  assert.equal(cancelled.calls[0].mimeType, 'application/json')
  assert.equal(cancelled.calls[0].base64, false)
  assert.equal(cancelled.downloads.length, 0)
  const failed = await exportHarness('android', new Error('所选位置无法写入'))
  await assert.rejects(failed.media.downloadText(content, '备份.json'), /无法写入/)
  assert.equal(failed.downloads.length, 0)
})

test('compressed image export uses its actual JPEG format and rejects remote URLs', async () => {
  const h = await exportHarness('android')
  const content = Buffer.from([0xff, 0xd8, 0x00, 0x80, 0xff, 0xd9]).toString('base64')
  const result = await h.media.downloadImage({ name: '原始图片.png', dataUrl: `data:image/jpeg;base64,${content}` })
  assert.equal(result.saved, true)
  assert.equal(h.calls[0].filename, '原始图片.jpg')
  assert.equal(h.calls[0].mimeType, 'image/jpeg')
  assert.equal(h.calls[0].base64, true)
  assert.equal(h.calls[0].content, content)
  await assert.rejects(h.media.downloadImage({ name: '远程.png', dataUrl: 'https://example.invalid/image.png' }), /格式无效/)
  assert.equal(h.calls.length, 1)
})

test('browser backup and binary image preserve bytes without calling Android plugin', async () => {
  const h = await exportHarness('web')
  const content = '{"title":"星语🌙","messages":["你好\\n世界"]}'
  await h.media.downloadText(content, '备份.json', 'application/json;charset=utf-8')
  assert.equal(await h.blobs[0].text(), content)
  const bytes = Buffer.from([0xff, 0xd8, 0x00, 0x80, 0xff, 0xd9])
  await h.media.downloadImage({ name: 'photo.webp', dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` })
  assert.deepEqual(Buffer.from(await h.blobs[1].arrayBuffer()), bytes)
  assert.equal(h.blobs[1].type, 'image/jpeg')
  assert.equal(h.downloads[1].name, 'photo.jpg')
  assert.equal(h.calls.length, 0)
  assert.equal(h.timers.length, 2)
})
