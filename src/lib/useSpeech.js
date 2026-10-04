import { useCallback, useEffect, useRef, useState } from 'react'

export function useSpeech({ onText, onNotice }) {
  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [voices, setVoices] = useState([])
  const [voiceURI, setVoiceURI] = useState('')
  const [rate, setRate] = useState(1)
  const recognitionRef = useRef(null)
  const callbacks = useRef({ onText, onNotice })
  callbacks.current = { onText, onNotice }
  const recognitionSupported = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
  const synthesisSupported = 'speechSynthesis' in window

  const stopSpeech = useCallback(() => {
    window.speechSynthesis?.cancel()
    setSpeaking(false)
  }, [])
  const stopListening = useCallback(() => {
    recognitionRef.current?.abort()
    recognitionRef.current = null
    setListening(false)
  }, [])

  useEffect(() => {
    const synth = window.speechSynthesis
    const refresh = () => setVoices(synth?.getVoices() || [])
    refresh()
    synth?.addEventListener('voiceschanged', refresh)
    return () => {
      recognitionRef.current?.abort()
      synth?.cancel()
      synth?.removeEventListener('voiceschanged', refresh)
    }
  }, [])

  function startListening() {
    if (listening) { stopListening(); return }
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!Recognition) { onNotice('当前浏览器不支持语音输入，可以继续打字或使用系统键盘的听写'); return }
    stopSpeech()
    const recognizer = new Recognition()
    recognitionRef.current = recognizer
    recognizer.lang = 'zh-CN'
    recognizer.continuous = false
    recognizer.interimResults = false
    recognizer.onresult = (event) => {
      if (recognitionRef.current !== recognizer) return
      const text = Array.from(event.results).filter(r => r.isFinal).map(r => r[0].transcript).join('')
      if (text) callbacks.current.onText(text)
    }
    recognizer.onerror = (event) => {
      if (recognitionRef.current !== recognizer || event.error === 'aborted') return
      const errors = { 'not-allowed': '没有获得麦克风权限，请检查浏览器权限', 'no-speech': '没有听清，可以再试一次', network: '语音识别服务连接失败，请检查网络或使用键盘听写', 'audio-capture': '没有可用的麦克风' }
      callbacks.current.onNotice(errors[event.error] || '语音输入不可用，请使用键盘输入')
    }
    recognizer.onend = () => {
      if (recognitionRef.current !== recognizer) return
      recognitionRef.current = null
      setListening(false)
    }
    try { recognizer.start(); setListening(true) } catch { onNotice('语音输入启动失败，请稍后重试'); stopListening() }
  }

  function speak(text) {
    if (!synthesisSupported) { onNotice('当前浏览器不支持朗读'); return }
    stopListening()
    stopSpeech()
    const source = String(text || '').replace(/```[\s\S]*?```/g, '（代码片段）').replace(/[#*_`>]/g, '').trim()
    if (!source) return
    // Small chunks avoid platforms silently stopping long utterances.
    const chunks = source.match(/[^。！？.!?\n]{1,160}[。！？.!?\n]?/g) || [source.slice(0, 160)]
    setSpeaking(true)
    for (const [i, chunk] of chunks.entries()) {
      const utterance = new SpeechSynthesisUtterance(chunk)
      utterance.lang = 'zh-CN'
      utterance.rate = rate
      utterance.voice = voices.find(v => v.voiceURI === voiceURI) || voices.find(v => /^zh/.test(v.lang)) || null
      utterance.onend = () => { if (i === chunks.length - 1) setSpeaking(false) }
      utterance.onerror = (event) => {
        if (!['canceled', 'interrupted'].includes(event.error)) callbacks.current.onNotice('朗读服务不可用，请选择其他声音')
        setSpeaking(false)
      }
      window.speechSynthesis.speak(utterance)
    }
  }
  return { listening, speaking, voices, voiceURI, setVoiceURI, rate, setRate, recognitionSupported, synthesisSupported, startListening, stopListening, speak, stopSpeech }
}
