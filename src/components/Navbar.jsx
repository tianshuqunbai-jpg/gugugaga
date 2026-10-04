import { useEffect, useState } from 'react'

function BrandMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <path
        d="M32 6 L37 27 L58 32 L37 37 L32 58 L27 37 L6 32 L27 27 Z"
        fill="currentColor"
      />
      <circle cx="49" cy="15" r="4" fill="#f6c96b" />
    </svg>
  )
}

export function Brand({ onClick }) {
  return (
    <a className="brand" href="#top" onClick={onClick} aria-label="星语 StarVox 首页">
      <span className="brand-mark">
        <BrandMark />
      </span>
      <span>
        <span style={{ display: 'block' }}>星语</span>
        <span className="brand-en">STARVOX</span>
      </span>
    </a>
  )
}

export default function Navbar({ onStart, home = false }) {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header className={`nav ${scrolled ? 'scrolled' : ''}`}>
      <div className="container nav-inner">
        <Brand onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} />
        {home && (
          <nav className="nav-links">
            <a href="#features">能力</a>
            <a href="#personalities">人格</a>
            <a href="#roadmap">路线</a>
          </nav>
        )}
        <div className="nav-cta">
          <button className="btn btn-primary btn-sm" onClick={() => onStart()}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
            开始聊天
          </button>
        </div>
      </div>
    </header>
  )
}
