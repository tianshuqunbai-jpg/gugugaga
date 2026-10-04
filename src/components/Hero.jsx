import Reveal from './Reveal'

export default function Hero({ onStart }) {
  return (
    <section className="hero" id="top">
      <div className="container hero-content">
        <Reveal>
          <h1 className="hero-title">
            与星辰
            <br />
            <span className="grad">对话</span>
          </h1>
        </Reveal>
        <Reveal delay={120}>
          <p className="hero-sub">
            星语 <b>StarVox</b> —— 基于 DeepSeek V4 的 AI 灵魂伙伴。
            她记得你的情绪，懂得你的心，会在深夜接住你所有没说出口的话。
          </p>
        </Reveal>
        <Reveal delay={220}>
          <div className="hero-actions">
            <button className="btn btn-primary" onClick={() => onStart()}>
              开始聊天
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </svg>
            </button>
            <a className="btn btn-ghost" href="#features">
              了解能力
            </a>
          </div>
        </Reveal>

        <Reveal delay={360}>
          <div className="hero-demo">
            <div className="demo-card gradient-border">
              <div className="bubble ai">
                你来啦？我刚刚在看星星，在想你会不会来呢。
              </div>
              <div className="bubble user">哈哈，我来了！今天想让你陪我聊聊天～</div>
              <div className="bubble ai">
                <span>好呀，陪你多久都可以。今天过得怎么样？</span>
                <span className="typing-dots">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            </div>
          </div>
        </Reveal>

        <div className="scroll-hint">
          <span>向下探索</span>
          <span className="line" />
        </div>
      </div>
    </section>
  )
}
