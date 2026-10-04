import { useEffect, useState } from 'react'
import Reveal from './Reveal'
import VirtualAvatar from './VirtualAvatar'
import { EMOTION_LABELS, mapEmotionLabel } from '../lib/emotion'
import { PERSONALITIES } from '../lib/personalities'

const DEMO_BASELINE = { aff: 55, sec: 45, aro: 38, dom: 2 }
const DEMO_DIMS = [
  { key: 'aff', label: '依恋', color: '#f9a8d4' },
  { key: 'sec', label: '安全', color: '#34d399' },
  { key: 'aro', label: '唤醒', color: '#fbbf24' },
  { key: 'dom', label: '支配', color: '#818cf8' }
]

function useDemoEmotion() {
  const [emotion, setEmotion] = useState({ aff: 42, sec: 38, aro: 28, dom: 4 })
  useEffect(() => {
    const id = setInterval(() => {
      setEmotion((prev) => {
        const next = {}
        for (const dim of DEMO_DIMS) {
          const drift = (Math.random() - 0.5) * 9
          const target = DEMO_BASELINE[dim.key]
          next[dim.key] = Math.max(-100, Math.min(100, prev[dim.key] + (target - prev[dim.key]) * 0.18 + drift))
        }
        return next
      })
    }, 1600)
    return () => clearInterval(id)
  }, [])
  return emotion
}

function DimBars({ emotion, mini = false }) {
  return (
    <div className="dims">
      {DEMO_DIMS.map((d) => (
        <div className={`dim ${mini ? 'mini' : ''}`} key={d.key}>
          <span className="dim-label">{d.label}</span>
          <span className="dim-track">
            <span
              className="dim-fill"
              style={{
                width: `${Math.round(((emotion[d.key] + 100) / 200) * 100)}%`,
                background: d.color
              }}
            />
          </span>
          <span className="dim-value">{Math.round(emotion[d.key])}</span>
        </div>
      ))}
    </div>
  )
}

function TraitBars({ traits }) {
  const map = { T: '温度', I: '主动', O: '开放', S: '敏感', R: '理性' }
  return (
    <div className="traits">
      {Object.entries(traits).map(([k, v]) => (
        <div className="trait" key={k}>
          <span className="trait-name">{map[k] || k}</span>
          <span className="trait-track">
            <span className="trait-fill" style={{ width: `${v}%` }} />
          </span>
        </div>
      ))}
    </div>
  )
}

export default function Features() {
  const emotion = useDemoEmotion()
  const labelId = mapEmotionLabel(emotion)
  const label = EMOTION_LABELS.find((l) => l.id === labelId) || EMOTION_LABELS[0]

  return (
    <section className="section" id="features">
      <div className="container">
        <Reveal>
          <div className="section-head">
            <h2 className="section-title">
              不只是聊天，
              <br />
              <span className="grad">她有自己的心</span>
            </h2>
            <p className="section-sub">
              每一个细节都为「陪伴感」设计：她会记住你的喜好，感知你的情绪，在合适的时候靠近你。
            </p>
          </div>
        </Reveal>

        <div className="features-grid">
          <Reveal className="tile span-6 cyan" style={{ '--tile-glow': 'rgba(56,224,245,0.5)' }}>
            <div className="tile-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
              </svg>
            </div>
            <h3>DeepSeek V4 双引擎</h3>
            <p>
              通过本机服务连接官方 API，流式输出，可随时停止。支持 Flash、Pro 和不同思考强度；
              Flash 可接收图片，连接设置会核对服务器实际可用的模型。
            </p>
            <div className="persona-tag" style={{ '--pc': '#38e0f5' }}>
              deepseek-flash
            </div>
            <div className="persona-tag" style={{ '--pc': '#e879f9', marginLeft: 8 }}>
              deepseek-v4-pro
            </div>
          </Reveal>

          <Reveal delay={90} className="tile" style={{ '--tile-glow': 'rgba(139,92,246,0.5)' }}>
            <div className="tile-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="5" />
                <path d="M8.5 13 7 22l5-3 5 3-1.5-9" />
              </svg>
            </div>
            <h3>人格引擎</h3>
            <p>{PERSONALITIES.length} 套人格预设，温度 / 主动 / 开放 / 敏感 / 理性五维可调，每段对话独立保留情绪与设定。</p>
            <TraitBars traits={{ T: 88, I: 70, O: 76, S: 68, R: 42 }} />
          </Reveal>

          <Reveal delay={180} className="tile gold" style={{ '--tile-glow': 'rgba(246,201,107,0.45)' }}>
            <div className="tile-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" />
                <path d="M8.5 12.5s1 1.5 3.5 1.5 3.5-1.5 3.5-1.5" />
                <path d="M9 9.5h.01M15 9.5h.01" />
              </svg>
            </div>
            <h3>情绪虚拟人</h3>
            <p>四维情绪驱动表情精灵，也能选择本地图片作为角色形象。支持朗读回复，在声音设置里选择语音与语速。</p>
            <div className="va-mini" style={{ margin: '14px auto 0', width: 128 }}>
              <VirtualAvatar expression={label.expr} color={label.color} spark />
            </div>
          </Reveal>

          <Reveal className="tile heart" style={{ '--tile-glow': 'rgba(232,121,249,0.5)' }}>
            <div className="tile-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
              </svg>
            </div>
            <h3>成人模式 · 完全手动掌控</h3>
            <p>开关永远由你手动决定，绝不自作主张关闭。一次年龄确认、喊停尊重、关闭后不再向模型发送亲密历史。</p>
            <div className="stage-path">
              <span className="stage-node active">手动开关</span>
              <span className="stage-arrow">·</span>
              <span className="stage-node">喊停尊重</span>
              <span className="stage-arrow">·</span>
              <span className="stage-node">隐私过滤</span>
            </div>
          </Reveal>

          <Reveal delay={90} className="tile" style={{ '--tile-glow': 'rgba(52,211,153,0.4)' }}>
            <div className="tile-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <path d="m9 12 2 2 4-4" />
              </svg>
            </div>
            <h3>隐私安全</h3>
            <p>多会话和记忆保存在本机，可选口令加密。完整备份始终不含密钥，恢复前可预览。聊天和记忆提炼使用 DeepSeek，语音识别可能使用浏览器提供商的服务。</p>
          </Reveal>

          <Reveal delay={180} className="tile span-6" style={{ '--tile-glow': 'rgba(139,92,246,0.55)' }}>
            <div className="tile-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
                <circle cx="12" cy="12" r="3.2" />
              </svg>
            </div>
            <h3>四维情绪空间</h3>
            <p>
              参考 Ackem 引擎：依恋、安全、唤醒、支配四个维度实时起伏，
              情绪标签（害羞心动、甜蜜依恋、傲娇别扭…）直接决定她说话的语气和脸上的表情。
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', marginTop: 8 }}>
              <div style={{ flex: '1 1 260px' }}>
                <DimBars emotion={emotion} mini />
              </div>
              <span className="emotion-chip" style={{ color: label.color }}>
                <span className="dot" style={{ background: label.color }} />
                {label.name}
              </span>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
