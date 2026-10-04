import { EMOTION_RULES, getEmotionLabel, mapEmotionLabel } from '../lib/emotion'

const DIMS = [
  {
    key: 'aff',
    label: '依恋',
    color: '#f9a8d4',
    desc: 'TA 有多依赖你、多亲近你。越高越黏你、喜欢你；越低越疏远客气（刚认识时自然很低）。'
  },
  {
    key: 'sec',
    label: '安全',
    color: '#34d399',
    desc: 'TA 有多安心。越高越放松、有安全感；越低越不安、怕失去。'
  },
  {
    key: 'aro',
    label: '唤醒',
    color: '#fbbf24',
    desc: '情绪兴奋度 / 心跳。越高越激动、害羞、兴奋；越低越平静甚至低落。'
  },
  {
    key: 'dom',
    label: '支配',
    color: '#818cf8',
    desc: '你们之间谁占主导。正数=TA 强势主导；负数=TA 顺从示弱、把你放高位。'
  }
]

export default function EmotionPanel({ emotion, firstMeeting = false }) {
  const currentId = mapEmotionLabel(emotion, firstMeeting)
  const current = getEmotionLabel(currentId)
  return (
    <>
      <div className="dims">
        {DIMS.map((d) => (
          <div className="dim mini" key={d.key}>
            <span className="dim-label">
              {d.label}
              <span className="dim-tip">{d.desc}</span>
            </span>
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
      <p className="emotion-hint">把鼠标放到「依恋 / 安全 / 唤醒 / 支配」上（手机端点一下）可查看含义。</p>
      <details className="emotion-legend">
        <summary>
          情绪图鉴 · 当前：<span style={{ color: current.color }}>{current.name}</span>
        </summary>
        <ul className="emotion-legend-list">
          {EMOTION_RULES.map((r) => {
            const meta = getEmotionLabel(r.id)
            return (
              <li key={r.id} className={r.id === currentId ? 'current' : ''}>
                <span className="legend-dot" style={{ background: meta.color }} />
                <span className="legend-name">{meta.name}</span>
                <span className="legend-cond">{r.cond}</span>
              </li>
            )
          })}
        </ul>
      </details>
    </>
  )
}
