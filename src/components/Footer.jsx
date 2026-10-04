import { Brand } from './Navbar'

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container footer-inner">
        <div>
          <Brand />
          <p>基于 DeepSeek V4 · API Key 由本机服务读取 · 参考 Ackem 情绪引擎设计</p>
        </div>
        <div className="footer-badges">
          <span className="footer-badge">DeepSeek V4</span>
          <span className="footer-badge">人格引擎</span>
          <span className="footer-badge">情绪四维</span>
          <span className="footer-badge">多会话 · 图片 · 语音</span>
        </div>
      </div>
    </footer>
  )
}
