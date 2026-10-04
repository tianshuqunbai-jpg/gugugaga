import { useEffect, useRef } from 'react'

export default function Starfield({ density = 1 }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    let raf = 0
    let w = 0
    let h = 0
    let dpr = 1
    const stars = []
    const meteors = []
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const mouse = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 }

    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1)
      w = window.innerWidth
      h = window.innerHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      initStars()
    }

    function initStars() {
      stars.length = 0
      const count = Math.round(Math.min(420, (w * h) / 4300) * density)
      for (let i = 0; i < count; i++) {
        const warm = Math.random()
        stars.push({
          x: Math.random() * w,
          y: Math.random() * h,
          z: 0.15 + Math.random() * 0.85,
          r: 0.3 + Math.random() * 1.25,
          tw: Math.random() * Math.PI * 2,
          ts: 0.4 + Math.random() * 1.7,
          hue:
            warm < 0.16
              ? '150, 220, 255'
              : warm < 0.3
                ? '195, 180, 255'
                : '228, 233, 255'
        })
      }
    }

    function onMouse(e) {
      mouse.tx = e.clientX / w
      mouse.ty = e.clientY / h
    }

    function spawnMeteor(time) {
      if (reduced || time - meteors.lastSpawn < 9000 + Math.random() * 5000) return
      meteors.lastSpawn = time
      const fromLeft = Math.random() < 0.5
      meteors.push({
        x: fromLeft ? Math.random() * w * 0.3 : w * (0.7 + Math.random() * 0.3),
        y: Math.random() * h * 0.28,
        vx: fromLeft ? 7 + Math.random() * 5 : -7 - Math.random() * 5,
        vy: 4.5 + Math.random() * 3,
        life: 1
      })
    }

    function draw(time) {
      const t = time / 1000
      mouse.x += (mouse.tx - mouse.x) * 0.045
      mouse.y += (mouse.ty - mouse.y) * 0.045
      const px = (mouse.x - 0.5) * 28
      const py = (mouse.y - 0.5) * 28

      ctx.clearRect(0, 0, w, h)

      for (const s of stars) {
        const sx = s.x + px * s.z
        const sy = s.y + py * s.z
        const a = 0.32 + 0.58 * (0.5 + 0.5 * Math.sin(t * s.ts + s.tw))
        ctx.beginPath()
        ctx.arc(sx, sy, s.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${s.hue},${a.toFixed(3)})`
        ctx.fill()
      }

      spawnMeteor(t)
      for (let i = meteors.length - 1; i >= 0; i--) {
        const m = meteors[i]
        m.x += m.vx
        m.y += m.vy
        m.life -= 0.016
        if (m.life <= 0 || m.x < -60 || m.x > w + 60 || m.y > h + 60) {
          meteors.splice(i, 1)
          continue
        }
        const grad = ctx.createLinearGradient(m.x, m.y, m.x - m.vx * 14, m.y - m.vy * 14)
        grad.addColorStop(0, `rgba(190,225,255,${(0.85 * m.life).toFixed(3)})`)
        grad.addColorStop(1, 'rgba(190,225,255,0)')
        ctx.strokeStyle = grad
        ctx.lineWidth = 1.4
        ctx.beginPath()
        ctx.moveTo(m.x, m.y)
        ctx.lineTo(m.x - m.vx * 14, m.y - m.vy * 14)
        ctx.stroke()
      }

      raf = requestAnimationFrame(draw)
    }

    resize()
    if (reduced) {
      drawStatic()
    } else {
      raf = requestAnimationFrame(draw)
    }
    window.addEventListener('resize', resize)
    window.addEventListener('mousemove', onMouse)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onMouse)
    }

    function drawStatic() {
      for (const s of stars) {
        ctx.beginPath()
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(228,233,255,0.7)`
        ctx.fill()
      }
    }
  }, [density])

  return <canvas ref={canvasRef} className="bg-canvas" aria-hidden="true" />
}
