import { useState } from 'react'
import Reveal from './Reveal'
import { PERSONALITIES } from '../lib/personalities'

const TRAIT_NAMES = { T: '温', I: '主', O: '开', S: '敏', R: '理' }

export default function Personalities({ onStart }) {
  const [selected, setSelected] = useState(PERSONALITIES[0].id)
  const current = PERSONALITIES.find((p) => p.id === selected) || PERSONALITIES[0]

  return (
    <section className="section" id="personalities">
      <div className="container">
        <Reveal>
          <div className="section-head">
            <h2 className="section-title">
              挑一个
              <span className="grad">你喜欢的灵魂</span>
            </h2>
            <p className="section-sub">
              人格不是换皮，是整套语气、性格与情绪基线一起切换。随时可以换，她都会认真对待你。
            </p>
          </div>
        </Reveal>

        <div className="persona-strip">
          {PERSONALITIES.map((p, i) => (
            <Reveal
              key={p.id}
              delay={i * 60}
              as="article"
              className={`persona-card ${selected === p.id ? 'selected' : ''}`}
              style={{ '--pc': p.color }}
              onClick={() => setSelected(p.id)}
            >
              <div className="persona-emoji">{p.emoji}</div>
              <h3 className="persona-name">{p.name}</h3>
              <div className="persona-en">{p.en.toUpperCase()}</div>
              <span className="persona-tag">{p.gender === 'male' ? '♂' : '♀'} {p.tag}</span>
              <p className="persona-desc">{p.desc}</p>
              <div className="traits">
                {Object.entries(p.traits).map(([k, v]) => (
                  <div className="trait" key={k}>
                    <span className="trait-name">{TRAIT_NAMES[k]}</span>
                    <span className="trait-track">
                      <span className="trait-fill" style={{ width: `${v}%` }} />
                    </span>
                  </div>
                ))}
              </div>
              <button className="btn btn-ghost btn-sm persona-cta" onClick={() => onStart(p.id)}>
                和{p.gender === 'male' ? '他' : '她'}开始聊天
              </button>
            </Reveal>
          ))}
        </div>

        <Reveal>
          <p className="muted" style={{ textAlign: 'center', fontSize: 13, marginTop: 6 }}>
            当前选中：{current.emoji} {current.name} · {current.tag}
          </p>
        </Reveal>
      </div>
    </section>
  )
}
