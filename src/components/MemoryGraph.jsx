import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatConfidence, MEMORY_DOMAINS } from '../lib/memory'

// 自由布局世界：比视口大得多，节点可以在里面自然散开，不设死框
const W = 900
const H = 500
const GRAPH_FACT_CAP = 80
const GRAPH_OLDEST_FALLBACK = 8
const KW_CAP = 16
const ALPHA_STOP = 0.02 // 能量衰减到阈值后静止（不再闪烁）
const ALPHA_DECAY = 0.99
const DOMAIN_COLORS = {
  基本信息: '#7dd3fc',
  生活习惯: '#34d399',
  健康: '#fb7185',
  工作学习: '#fbbf24',
  家庭: '#c084fc',
  朋友: '#38bdf8',
  伴侣关系: '#f0abfc',
  兴趣偏好: '#a3e635',
  情绪状态: '#fda4af',
  重要事件: '#f97316',
  其他: '#94a3b8'
}

function buildGraph(facts, causalLinks) {
  const kwCount = {}
  for (const f of facts) {
    for (const k of f.keywords || []) {
      if (k) kwCount[k] = (kwCount[k] || 0) + 1
    }
  }
  const topKws = Object.entries(kwCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, KW_CAP)
    .map(([k]) => k)
  const kwSet = new Set(topKws)
  const nodes = []
  const idx = {}
  const push = (n) => {
    idx[n.id] = nodes.length
    nodes.push(n)
  }
  for (const f of facts) push({ id: 'f:' + f.id, kind: 'fact', fact: f })
  for (const k of topKws) push({ id: 'k:' + k, kind: 'kw', kw: k })
  const edges = []
  for (const f of facts) {
    for (const k of f.keywords || []) {
      if (kwSet.has(k)) edges.push({ a: idx['f:' + f.id], b: idx['k:' + k] })
    }
  }
  const causalEdges = []
  for (const l of causalLinks || []) {
    const a = idx['f:' + l.fromFactId]
    const b = idx['f:' + l.toFactId]
    if (a !== undefined && b !== undefined && a !== b) {
      causalEdges.push({ a, b, reason: l.reason || '' })
    }
  }
  // 事实-事实关联边：共享关键词、或关键词互相包含（薄荷茶 vs 薄荷糖）都算关联
  const factEdges = []
  const seen = new Set()
  for (let i = 0; i < facts.length && factEdges.length < 120; i++) {
    for (let j = i + 1; j < facts.length && factEdges.length < 120; j++) {
      const k1 = facts[i].keywords || []
      const k2 = facts[j].keywords || []
      if (k1.length === 0 || k2.length === 0) continue
      let shared = false
      for (const a of k1) {
        for (const b of k2) {
          if (a === b || (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a)))) {
            shared = true
            break
          }
        }
        if (shared) break
      }
      if (!shared) continue
      const ai = idx['f:' + facts[i].id]
      const bj = idx['f:' + facts[j].id]
      if (ai === undefined || bj === undefined || ai === bj) continue
      const key = ai < bj ? ai + '-' + bj : bj + '-' + ai
      if (seen.has(key)) continue
      seen.add(key)
      factEdges.push({ a: ai, b: bj })
    }
  }
  return { nodes, edges, causalEdges, factEdges }
}

// 每个主题域一个锚点：按域数量均匀分布在中央椭圆上，事实节点被拉向自己的锚点形成独立簇
function domainAnchors(domains) {
  const anchors = {}
  domains.forEach((d, i) => {
    const ang = (i / Math.max(1, domains.length)) * Math.PI * 2 - Math.PI / 2
    anchors[d] = { x: W / 2 + Math.cos(ang) * 320, y: H / 2 + Math.sin(ang) * 190 }
  })
  return anchors
}

// 自由力导向：斥力 + 弹簧 + 弱向心；能量随 alpha 衰减直到静止
function physicsStep(nodes, edges, params, alpha) {
  const REP = 7000 * params.repulsion
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]
    if (a.fixed) {
      a.vx = 0
      a.vy = 0
      continue
    }
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]
      let dx = a.x - b.x
      let dy = a.y - b.y
      let d2 = dx * dx + dy * dy
      if (d2 < 1) {
        dx = Math.random() - 0.5
        dy = Math.random() - 0.5
        d2 = 1
      }
      const d = Math.sqrt(d2)
      const f = (REP / d2) * alpha
      const fx = (dx / d) * f
      const fy = (dy / d) * f
      a.vx += fx
      a.vy += fy
      b.vx -= fx
      b.vy -= fy
    }
  }
  for (const e of edges) {
    const a = nodes[e.a]
    const b = nodes[e.b]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const d = Math.max(1, Math.sqrt(dx * dx + dy * dy))
    const f = (d - 85) * 0.08 * alpha
    const fx = (dx / d) * f
    const fy = (dy / d) * f
    if (!a.fixed) {
      a.vx += fx
      a.vy += fy
    }
    if (!b.fixed) {
      b.vx -= fx
      b.vy -= fy
    }
  }
  for (const n of nodes) {
    if (n.fixed) continue
    // 只有关键词节点受向心力约束；事实节点由各自的域锚点定位
    if (n.kind === 'kw') {
      n.vx += (W / 2 - n.x) * params.gravity * alpha
      n.vy += (H / 2 - n.y) * params.gravity * alpha
    }
    n.vx *= 0.88
    n.vy *= 0.88
    n.x += n.vx
    n.y += n.vy
    // 无四壁：不做任何坐标钳制，节点靠引力自然聚拢
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
      n.x = W / 2
      n.y = H / 2
      n.vx = 0
      n.vy = 0
    }
  }
  // 主题聚类：同域事实被拉向各自的域锚点，形成一簇一簇的布局
  const domains = [...new Set(nodes.filter((n) => n.kind === 'fact').map((n) => n.fact.domain || '其他'))]
  const anchors = domainAnchors(domains)
  for (const n of nodes) {
    if (n.kind !== 'fact' || n.fixed) continue
    const a = anchors[n.fact.domain || '其他']
    if (!a) continue
    n.vx += (a.x - n.x) * 0.05 * alpha
    n.vy += (a.y - n.y) * 0.05 * alpha
  }
  return alpha * ALPHA_DECAY
}

export default function MemoryGraph({ facts, causalLinks }) {
  const [tick, setTick] = useState(0)
  const [hover, setHover] = useState(null)
  const [freshIds, setFreshIds] = useState(null)
  const [params, setParams] = useState({ gravity: 0.004, repulsion: 1 })
  const simRef = useRef({ nodes: [], edges: [] })
  const paramsRef = useRef(params)
  const viewRef = useRef({ tx: 0, ty: 0, k: 1 })
  const alphaRef = useRef(1)
  const rafRef = useRef(null)
  const posCache = useRef(new Map())
  const dragNodeRef = useRef(null)
  const panRef = useRef(null)
  const svgRef = useRef(null)
  const prevIds = useRef(new Set())
  const firstRunRef = useRef(true)

  const zoomAt = useCallback((clientX, clientY, factor) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const v = viewRef.current
    const wx = (clientX - rect.left - v.tx) / v.k
    const wy = (clientY - rect.top - v.ty) / v.k
    const k2 = Math.max(0.2, Math.min(4, v.k * factor))
    v.tx = clientX - rect.left - wx * k2
    v.ty = clientY - rect.top - wy * k2
    v.k = k2
    setTick((t) => t + 1)
  }, [])
  useWheelZoom(svgRef, zoomAt)

  const startLoop = useCallback(() => {
    if (rafRef.current) return
    const step = () => {
      const { nodes, edges } = simRef.current
      if (nodes.length > 0) {
        alphaRef.current = physicsStep(nodes, edges, paramsRef.current, alphaRef.current)
      }
      setTick((t) => t + 1)
      if (alphaRef.current >= ALPHA_STOP) {
        rafRef.current = requestAnimationFrame(step)
      } else {
        rafRef.current = null
      }
    }
    rafRef.current = requestAnimationFrame(step)
  }, [])

  useEffect(() => {
    startLoop()
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [startLoop])

  // 滑杆参数变化：重新加热，让布局重新适应
  useEffect(() => {
    paramsRef.current = params
    alphaRef.current = 1
    startLoop()
  }, [params, startLoop])

  const data = useMemo(() => {
    if (!facts || facts.length === 0) return null
    const top = [...facts]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, GRAPH_FACT_CAP)
    // 老记忆兜底：最可信的之外，永远带上最早的一小撮，避免远古记忆从图上消失
    const topIds = new Set(top.map((f) => f.id))
    const oldest = [...facts]
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .filter((f) => !topIds.has(f.id))
      .slice(0, GRAPH_OLDEST_FALLBACK)
    const g = buildGraph([...top, ...oldest], causalLinks)
    const cache = posCache.current
    const anchors = domainAnchors([
      ...new Set(g.nodes.filter((n) => n.kind === 'fact').map((n) => n.fact.domain || '其他'))
    ])
    for (const n of g.nodes) {
      const c = cache.get(n.id)
      if (c) {
        n.x = c.x
        n.y = c.y
      } else if (n.kind === 'fact') {
        // 新事实节点直接出生在自己的域簇附近，而不是都挤在画面中央
        const a = anchors[n.fact.domain || '其他'] || { x: W / 2, y: H / 2 }
        n.x = a.x + (Math.random() - 0.5) * 110
        n.y = a.y + (Math.random() - 0.5) * 80
        cache.set(n.id, n)
      } else {
        n.x = W / 2 + (Math.random() - 0.5) * 320
        n.y = H / 2 + (Math.random() - 0.5) * 200
        cache.set(n.id, n)
      }
      n.vx = 0
      n.vy = 0
      n.fixed = false
    }
    const live = new Set(g.nodes.map((n) => n.id))
    for (const id of [...cache.keys()]) if (!live.has(id)) cache.delete(id)
    simRef.current = g
    return g
  }, [facts, causalLinks])

  // 新记忆出现：脉冲提示 + 重新加热让新节点落位
  useEffect(() => {
    if (!data) return
    const ids = new Set(data.nodes.map((n) => n.id))
    if (firstRunRef.current) {
      firstRunRef.current = false
      prevIds.current = ids
      return
    }
    const fresh = new Set([...ids].filter((id) => !prevIds.current.has(id)))
    prevIds.current = ids
    if (fresh.size > 0) {
      setFreshIds(fresh)
      alphaRef.current = 0.6
      startLoop()
      const t = setTimeout(() => setFreshIds(null), 3000)
      return () => clearTimeout(t)
    }
  }, [data, startLoop])

  if (!data) return null

  const hoverIdx = hover === null ? -1 : data.nodes.findIndex((n) => n.id === hover)
  const neighbors = new Set()
  if (hoverIdx >= 0) {
    neighbors.add(hoverIdx)
    for (const e of data.edges) {
      if (e.a === hoverIdx) neighbors.add(e.b)
      if (e.b === hoverIdx) neighbors.add(e.a)
    }
    for (const e of data.causalEdges) {
      if (e.a === hoverIdx) neighbors.add(e.b)
      if (e.b === hoverIdx) neighbors.add(e.a)
    }
    for (const e of data.factEdges) {
      if (e.a === hoverIdx) neighbors.add(e.b)
      if (e.b === hoverIdx) neighbors.add(e.a)
    }
  }
  const active = neighbors.size > 0
  const hovered = hoverIdx >= 0 ? data.nodes[hoverIdx] : null

  const clientToWorld = (clientX, clientY) => {
    const rect = svgRef.current.getBoundingClientRect()
    const v = viewRef.current
    return {
      x: (clientX - rect.left - v.tx) / v.k,
      y: (clientY - rect.top - v.ty) / v.k
    }
  }

  const zoomCenter = (factor) => {
    const rect = svgRef.current.getBoundingClientRect()
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor)
  }

  const resetView = () => {
    viewRef.current = { tx: 0, ty: 0, k: 1 }
    setTick((t) => t + 1)
  }

  const onNodeDown = (e, n) => {
    e.stopPropagation()
    n.fixed = true
    dragNodeRef.current = n
    alphaRef.current = 0.7
    startLoop()
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onSvgPointerMove = (e) => {
    if (dragNodeRef.current) {
      const p = clientToWorld(e.clientX, e.clientY)
      dragNodeRef.current.x = p.x
      dragNodeRef.current.y = p.y
    } else if (panRef.current) {
      const v = viewRef.current
      v.tx = panRef.current.tx + (e.clientX - panRef.current.x)
      v.ty = panRef.current.ty + (e.clientY - panRef.current.y)
    }
  }

  const onSvgPointerUp = () => {
    if (dragNodeRef.current) {
      dragNodeRef.current.fixed = false
      dragNodeRef.current = null
    }
    panRef.current = null
  }

  const onSvgPointerDown = (e) => {
    const v = viewRef.current
    panRef.current = { x: e.clientX, y: e.clientY, tx: v.tx, ty: v.ty }
  }

  const v = viewRef.current
  const capped = facts.length > GRAPH_FACT_CAP

  return (
    <div className="mem-graph">
      <div className="mem-graph-stage">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="mem-graph-svg"
          role="img"
          aria-label="记忆关系图"
          onPointerDown={onSvgPointerDown}
          onPointerMove={onSvgPointerMove}
          onPointerUp={onSvgPointerUp}
        >
          <g transform={`translate(${v.tx},${v.ty}) scale(${v.k})`}>
            <defs>
              <marker id="arrowGold" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#fbbf24" />
              </marker>
            </defs>
            {data.factEdges.map((e, i) => {
              const a = data.nodes[e.a]
              const b = data.nodes[e.b]
              const on = active && neighbors.has(e.a) && neighbors.has(e.b)
              return (
                <line
                  key={'link' + i}
                  className={`mem-edge link${on ? ' on' : ''}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                />
              )
            })}
            {data.causalEdges.map((e, i) => {
              const a = data.nodes[e.a]
              const b = data.nodes[e.b]
              const on = active && neighbors.has(e.a) && neighbors.has(e.b)
              return (
                <line
                  key={'c' + i}
                  className={`mem-edge causal${on ? ' on' : ''}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  markerEnd="url(#arrowGold)"
                >
                  <title>{e.reason ? `因果：${e.reason}` : '因果链'}</title>
                </line>
              )
            })}
            {data.edges.map((e, i) => {
              const a = data.nodes[e.a]
              const b = data.nodes[e.b]
              const on = active && neighbors.has(e.a) && neighbors.has(e.b)
              return (
                <line key={i} className={`mem-edge${on ? ' on' : ''}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
              )
            })}
            {data.nodes.map((n) => {
              const isFact = n.kind === 'fact'
              const on = active ? neighbors.has(data.nodes.findIndex((x) => x.id === n.id)) : true
              const fresh = freshIds && freshIds.has(n.id)
              const r = isFact ? 6 + norm(n.fact.confidence) * 12 : 4
              const fill = isFact
                ? n.fact.sensitive
                  ? '#f472b6'
                  : DOMAIN_COLORS[n.fact.domain] || '#94a3b8'
                : '#a78bfa'
              return (
                <circle
                  key={n.id}
                  className={`mem-node ${isFact ? 'fact' : 'kw'}${on ? ' on' : ''}${fresh ? ' fresh' : ''}`}
                  cx={n.x}
                  cy={n.y}
                  r={r}
                  fill={fill}
                  onMouseEnter={() => setHover(n.id)}
                  onMouseLeave={() => setHover(null)}
                  onPointerDown={(e) => onNodeDown(e, n)}
                >
                  <title>
                    {isFact
                      ? `${n.fact.text}（${n.fact.domain || '其他'} · 可信度 ${formatConfidence(n.fact.confidence)}）`
                      : n.kw}
                  </title>
                </circle>
              )
            })}
            {data.nodes
              .filter((n) => n.kind === 'kw')
              .map((n) => (
                <text key={'t' + n.id} className="mem-node-label" x={n.x} y={n.y + 18} textAnchor="middle">
                  {n.kw}
                </text>
              ))}
          </g>
        </svg>
        <div className="mem-graph-controls">
          <button type="button" className="ctrl-btn" onClick={() => zoomCenter(1.25)} aria-label="放大" title="放大">
            +
          </button>
          <button type="button" className="ctrl-btn" onClick={() => zoomCenter(0.8)} aria-label="缩小" title="缩小">
            −
          </button>
          <button type="button" className="ctrl-btn ctrl-reset" onClick={resetView} aria-label="重置视图" title="重置视图">
            重置
          </button>
          <label className="ctrl-slider">
            引力
            <input
              type="range"
              min="0"
              max="0.02"
              step="0.001"
              value={params.gravity}
              onChange={(e) => setParams((p) => ({ ...p, gravity: Number(e.target.value) }))}
            />
          </label>
          <label className="ctrl-slider">
            疏密
            <input
              type="range"
              min="0.5"
              max="3"
              step="0.1"
              value={params.repulsion}
              onChange={(e) => setParams((p) => ({ ...p, repulsion: Number(e.target.value) }))}
            />
          </label>
        </div>
      </div>
      <div className="mem-graph-legend">
        <span>
          <i className="legend-swatch" style={{ background: '#f472b6' }} />
          私密
        </span>
        <span>
          <i className="legend-swatch" style={{ background: '#a78bfa' }} />
          关键词
        </span>
        <span>
          <i className="legend-swatch" style={{ background: '#fbbf24' }} />
          因果链
        </span>
        <span className="muted">
          星点越大 = 可信度越高 · 金色箭头 = 因果 · 浅蓝线 = 事实关联 · 滚轮缩放 · 布局自然散开并静止
          {capped
            ? ` · 显示最可信的 ${GRAPH_FACT_CAP} 条 + 最早的 ${GRAPH_OLDEST_FALLBACK} 条（共 ${facts.length} 条）`
            : ''}
        </span>
      </div>
      {hovered && (
        <div className="mem-graph-tip">
          {hovered.kind === 'fact'
            ? `${hovered.fact.text}（${hovered.fact.domain || '其他'}）`
            : `关键词：${hovered.kw}`}
        </div>
      )}
      <div className="mem-domain-legend">
        {MEMORY_DOMAINS.filter((d) => data.nodes.some((n) => n.kind === 'fact' && (n.fact.domain || '其他') === d)).map(
          (d) => (
            <span key={d} className="mem-domain-chip">
              <i style={{ background: DOMAIN_COLORS[d] || '#94a3b8' }} />
              {d}
            </span>
          )
        )}
      </div>
    </div>
  )
}

function useWheelZoom(svgRef, zoomAt) {
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const handler = (e) => {
      e.preventDefault()
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 0.89)
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [svgRef, zoomAt])
}

function norm(c) {
  const n = Number(c)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.8
}
