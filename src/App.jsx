import { useEffect, useState } from 'react'
import Starfield from './components/Starfield'
import HomePage from './components/HomePage'
import ChatPage from './components/ChatPage'
import SetupGate from './components/SetupGate'
import CryptoGate from './components/CryptoGate'
import { DEFAULT_MODEL } from './lib/constants'
import { loadConfig, saveConfig } from './lib/storage'
import { isCryptoEnabled } from './lib/crypto'

// Shared chat layout is responsive; skip decorative canvas on mobile devices.
const MOBILE_QUERY = '(max-width: 820px), (pointer: coarse) and (max-width: 1024px)'

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(MOBILE_QUERY).matches === true
  )
  useEffect(() => {
    if (!window.matchMedia) return
    const mq = window.matchMedia(MOBILE_QUERY)
    const onChange = (e) => setIsMobile(e.matches)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])
  return isMobile
}

const DEFAULT_CONFIG = {
  connectionMode: 'server',
  model: DEFAULT_MODEL,
  thinkingMode: 'auto',
  ready: false
}

export default function App() {
  const [view, setView] = useState('home')
  const [cryptoLocked, setCryptoLocked] = useState(() => isCryptoEnabled())
  const [config, setConfig] = useState(() =>
    // 开启加密且尚未解锁时先不读配置，解锁后再重新加载
    isCryptoEnabled() ? null : loadConfig(DEFAULT_CONFIG)
  )
  const [initialPersona, setInitialPersona] = useState(null)
  // 每次从首页发起聊天都递增：保证重新挂载；人格选择用 initialPersona 一次性传递，
  // 消费后清空，避免"重新配置"返回时被旧人格值覆盖
  const [chatEpoch, setChatEpoch] = useState(0)
  const isMobile = useIsMobile()

  // 记忆按人格分区：作用域由 loadSession 在读存档时同步设定（见 storage.js），
  // 所以这里不需要额外处理，也不会依赖 ChatPage 的挂载时序

  const startChat = (personaId) => {
    setInitialPersona(typeof personaId === 'string' ? personaId : null)
    setChatEpoch((e) => e + 1)
    setView(config.ready ? 'chat' : 'setup')
  }

  const handleSaveConfig = (cfg, { persist = true } = {}) => {
    if (persist) saveConfig(cfg)
    setConfig(cfg)
  }

  const handleUnlocked = () => {
    setConfig(loadConfig(DEFAULT_CONFIG))
    setCryptoLocked(false)
  }

  if (cryptoLocked) {
    return <CryptoGate onUnlocked={handleUnlocked} />
  }

  return (
    <>
      {!isMobile && view !== 'chat' && <Starfield />}
      <div className="bg-aurora" />
      <div className="bg-grid" />
      <div className="bg-vignette" />
      {view === 'home' && <HomePage onStart={startChat} />}
      {view === 'setup' && (
        <SetupGate
          config={config}
          onSave={handleSaveConfig}
          onReady={() => setView('chat')}
          onBack={() => setView('home')}
        />
      )}
      {view === 'chat' && (
        <ChatPage
          key={chatEpoch}
          config={config}
          initialPersona={initialPersona}
          onPersonaApplied={() => setInitialPersona(null)}
          onExit={() => setView('home')}
          onEditConfig={() => setView('setup')}
          onSaveConfig={handleSaveConfig}
        />
      )}
    </>
  )
}
