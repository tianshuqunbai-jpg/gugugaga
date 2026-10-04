import { useId } from 'react'

function hexToRgba(hex, alpha) {
  const h = String(hex || '#8b5cf6').replace('#', '')
  const r = parseInt(h.slice(0, 2), 16) || 139
  const g = parseInt(h.slice(2, 4), 16) || 92
  const b = parseInt(h.slice(4, 6), 16) || 246
  return `rgba(${r},${g},${b},${alpha})`
}

// 把人格主色往不同方向推，得到一整组互相协调的颜色。
// 只用一个人格字段（color）就够驱动发色、瞳色、高光、阴影，
// 19 个人格不用各画一套图
function shift(hex, dr, dg, db) {
  const h = String(hex || '#8b5cf6').replace('#', '')
  const c = (i) => parseInt(h.slice(i, i + 2), 16) || 128
  const cl = (v) => Math.max(0, Math.min(255, Math.round(v)))
  const to2 = (v) => cl(v).toString(16).padStart(2, '0')
  return `#${to2(c(0) + dr)}${to2(c(2) + dg)}${to2(c(4) + db)}`
}

function darken(hex, amount) {
  const h = String(hex || '#8b5cf6').replace('#', '')
  const c = (i) => parseInt(h.slice(i, i + 2), 16) || 128
  const to2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${to2(c(0) * (1 - amount))}${to2(c(2) * (1 - amount))}${to2(c(4) * (1 - amount))}`
}

// 角色配色：以人格主色为基准派生。肤色固定（都是人形角色），
// 头发与眼睛跟着主色走，这样"邻家少年"和"阿绫"一眼就能分辨
function paletteOf(color) {
  return {
    hairTop: shift(color, 26, 10, 30),
    hairMid: color,
    hairDeep: darken(color, 0.52),
    hairShine: shift(color, 96, 84, 92),
    eyeTop: darken(color, 0.45),
    eyeBottom: shift(color, 70, 58, 46),
    glow: color
  }
}

// 一张角色头像。
//
// 之前这里只有两个圆点眼睛加一条嘴，看着像贴纸。现在按"能一眼看出是个人"
// 重画：渐层头发 + 高光、带虹膜与catchlight 的眼睛、腮红、轮廓光。
// 所有颜色从 color 一个字段派生，所以换人格不用换图。
// 坐标系统：viewBox 0 0 200 200，角色居中，脸占 y 62~152
function Character({ color, eyes, mouth, blush, uid = '' }) {
  const p = paletteOf(color)
  return (
    <>
      <defs>
        <linearGradient id={"vaHair" + uid} x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0%" stopColor={p.hairTop} />
          <stop offset="52%" stopColor={p.hairMid} />
          <stop offset="100%" stopColor={p.hairDeep} />
        </linearGradient>
        <linearGradient id={"vaSkin" + uid} x1="0.2" y1="0" x2="0.8" y2="1">
          <stop offset="0%" stopColor="#fff5f0" />
          <stop offset="62%" stopColor="#ffe4d6" />
          <stop offset="100%" stopColor="#f7cdbc" />
        </linearGradient>
        <radialGradient id={"vaEye" + uid} cx="0.5" cy="0.32" r="0.78">
          <stop offset="0%" stopColor={p.eyeBottom} />
          <stop offset="62%" stopColor={p.eyeTop} />
          <stop offset="100%" stopColor={darken(color, 0.72)} />
        </radialGradient>
        <radialGradient id={"vaBlush" + uid} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#ff9db4" stopOpacity="0.62" />
          <stop offset="100%" stopColor="#ff9db4" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={"vaBody" + uid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={shift(color, 34, 20, 38)} />
          <stop offset="100%" stopColor={darken(color, 0.62)} />
        </linearGradient>
        <linearGradient id={"vaRim" + uid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={p.hairShine} stopOpacity="0.85" />
          <stop offset="100%" stopColor={p.hairShine} stopOpacity="0" />
        </linearGradient>
        {/* 头发上半部的柔光，避免大面积纯色发块显得平 */}
        <radialGradient id={"vaHairGlow" + uid} cx="0.34" cy="0.16" r="0.66">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.32" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* 肩与衣领：底部用渐变淡出，不画硬边 */}
      <path
        d="M 38 200 C 42 172 62 158 100 158 C 138 158 158 172 162 200 Z"
        fill={`url(#vaBody${uid})`}
      />
      <path
        d="M 84 160 L 100 178 L 116 160 C 110 157 90 157 84 160 Z"
        fill="#fff"
        opacity="0.16"
      />

      {/* 脖子 */}
      <path d="M 89 130 L 111 130 L 111 156 Q 100 162 89 156 Z" fill="#f3c6b4" />

      {/* 后层头发：画在脸下面。
          之前两侧是"上宽下窄的直筒"，看着像两根管子；改成上厚下细、
          末端向外微翘的收尖，才像自然垂下的头发 */}
      <path
        d="M 100 40 C 58 40 40 74 40 112 C 40 150 48 172 57 186
           C 68 178 74 150 74 118 C 74 92 82 68 100 62
           C 118 68 126 92 126 118 C 126 150 132 178 143 186
           C 152 172 160 150 160 112 C 160 74 142 40 100 40 Z"
        fill={`url(#vaHair${uid})`}
      />
      <path
        d="M 100 40 C 58 40 40 74 40 112 C 40 150 48 172 57 186
           C 68 178 74 150 74 118 C 74 92 82 68 100 62
           C 118 68 126 92 126 118 C 126 150 132 178 143 186
           C 152 172 160 150 160 112 C 160 74 142 40 100 40 Z"
        fill={`url(#vaHairGlow${uid})`}
      />

      {/* 脸 */}
      <path
        d="M 100 56 C 130 56 142 78 142 102 C 142 126 128 145 100 152
           C 72 145 58 126 58 102 C 58 78 70 56 100 56 Z"
        fill={`url(#vaSkin${uid})`}
      />

      {/* 耳 */}
      <ellipse cx="57" cy="106" rx="5.5" ry="8.5" fill="#f7cdbc" />
      <ellipse cx="143" cy="106" rx="5.5" ry="8.5" fill="#f7cdbc" />

      {/* 腮红（按表情决定是否显示，和原来的 blush 规则一致） */}
      {blush && (
        <g opacity="0.9">
          <ellipse cx="72" cy="118" rx="12" ry="7" fill={`url(#vaBlush${uid})`} />
          <ellipse cx="128" cy="118" rx="12" ry="7" fill={`url(#vaBlush${uid})`} />
        </g>
      )}

      {/* 五官 */}
      <Eye cx={76} variant={eyes} palette={p} uid={uid} />
      <Eye cx={124} variant={eyes} palette={p} uid={uid} />

      {/* 鼻子：只一个小点，多了会显老 */}
      <path
        d="M 99 116 Q 101 118 99.5 119.5"
        fill="none"
        stroke="#dfa894"
        strokeWidth="1.6"
        strokeLinecap="round"
      />

      <Mouth variant={mouth} />

      {/* 前层头发与刘海：画在脸上面。
          关键是刘海底边要压住额头：之前分缝画成"∧"形，缝两侧露出两片三角形
          额头，看着像发际线后退。现在改成一条从分缝向两侧扫下的斜刘海，
          底边全程压在眉线附近，只在中缝处露一点额头 */}
      <path
        d="M 100 40 C 58 40 40 70 40 106 C 44 90 51 78 60 71
           C 59 85 64 94 72 98 C 76 84 83 72 92 63
           C 96 78 100 90 100 102 C 102 90 106 76 114 65
           C 126 69 140 80 152 96 C 160 78 157 57 146 47
           C 134 41 118 40 100 40 Z"
        fill={`url(#vaHair${uid})`}
      />
      {/* 发丝高光：一条弧，比整片亮色自然 */}
      <path
        d="M 54 96 C 68 62 96 47 130 54"
        fill="none"
        stroke={`url(#vaRim${uid})`}
        strokeWidth="5"
        strokeLinecap="round"
        opacity="0.7"
      />
      {/* 发夹：小配饰能立刻把"通用脸"变成"具体的人"，颜色跟人格主色走 */}
      <g transform="translate(126 72) rotate(18)">
        <rect x="-11" y="-3" width="22" height="6" rx="3" fill={p.hairShine} opacity="0.95" />
        <rect x="-11" y="-3" width="22" height="6" rx="3" fill="none" stroke="#fff" strokeWidth="0.9" opacity="0.5" />
        <circle cx="-8" cy="0" r="1.6" fill="#fff" opacity="0.85" />
        <circle cx="0" cy="0" r="1.6" fill="#fff" opacity="0.85" />
        <circle cx="8" cy="0" r="1.6" fill="#fff" opacity="0.85" />
      </g>
    </>
  )
}

// 单只眼睛（新坐标系：眼睛中心 cy=106，虹膜用渐变 + catchlight）。
// 两层动画叠在一起：
//   .va-eye-gaze  —— 眼神缓慢游移（像在注视，而不是画上去的贴纸）
//   .va-eye-blink —— 眨眼：把整只眼睛垂直压扁到 7%，配合轻微淡出。
//     只淡出不压扁会像"眼睛凭空消失"，压扁才有眼睑落下的感觉
function Eye({ cx, variant, palette, uid = '' }) {
  const p = palette || { eyeTop: '#2b2f6b', eyeBottom: '#6d7bff' }
  const EYE_Y = 106
  const RX = 13
  const RY = 16

  // 虹膜：底色 + 瞳孔 + 上暗下亮 + 两点 catchlight，四层才有透明感
  const iris = (offsetX = 0, r = 9) => (
    <g transform={`translate(${offsetX} 0)`}>
      <circle cx={cx} cy={EYE_Y} r={r} fill={`url(#vaEye${uid})`} />
      <circle cx={cx} cy={EYE_Y} r={r} fill="none" stroke={darken(p.eyeTop, 0.35)} strokeWidth="1.6" />
      <circle cx={cx} cy={EYE_Y + 1} r={r * 0.46} fill="#151a3d" />
      {/* 下半圈反光：让虹膜像有厚度 */}
      <path
        d={`M ${cx - r * 0.72} ${EYE_Y + r * 0.42} Q ${cx} ${EYE_Y + r * 1.15} ${cx + r * 0.72} ${EYE_Y + r * 0.42}`}
        fill="none"
        stroke="#fff"
        strokeWidth="1.8"
        strokeLinecap="round"
        opacity="0.5"
      />
      <circle cx={cx - r * 0.36} cy={EYE_Y - r * 0.42} r={r * 0.3} fill="#fff" />
      <circle cx={cx + r * 0.42} cy={EYE_Y + r * 0.34} r={r * 0.15} fill="#fff" opacity="0.75" />
    </g>
  )

  // 眉毛：细、拱、颜色比眼睛浅一档。
  // 之前又粗又黑又低，任何表情看着都凶；动漫脸的眉毛本就不该抢眼睛的戏
  const brow = (dy = 0, tilt = 0) => (
    <path
      d={`M ${cx - 12} ${88 + dy + tilt} Q ${cx - 1} ${82.5 + dy} ${cx + 12} ${86.5 + dy - tilt}`}
      fill="none"
      stroke={shift(p.eyeTop, 40, 40, 44)}
      strokeWidth="1.8"
      strokeLinecap="round"
      opacity="0.55"
    />
  )

  const inner = (() => {
    switch (variant) {
      case 'happy':
        // 弯成月牙的笑眼
        return (
          <g>
            {brow(-3)}
            <path
              d={`M ${cx - 13} ${EYE_Y + 4} Q ${cx} ${EYE_Y - 12} ${cx + 13} ${EYE_Y + 4}`}
              fill="none"
              stroke="#2b2a4e"
              strokeWidth="4.2"
              strokeLinecap="round"
            />
          </g>
        )
      case 'shy':
        return (
          <g>
            {brow(-4)}
            <path
              d={`M ${cx - 13} ${EYE_Y + 2} Q ${cx} ${EYE_Y - 9} ${cx + 13} ${EYE_Y + 2}`}
              fill="none"
              stroke="#2b2a4e"
              strokeWidth="4.2"
              strokeLinecap="round"
            />
            <path
              d={`M ${cx - 12} ${EYE_Y + 8} Q ${cx} ${EYE_Y + 13} ${cx + 12} ${EYE_Y + 8}`}
              fill="none"
              stroke="#ff9db4"
              strokeWidth="2.2"
              strokeLinecap="round"
              opacity="0.55"
            />
          </g>
        )
      case 'sad':
        return (
          <g>
            {brow(3, 3)}
            <ellipse cx={cx} cy={EYE_Y + 1} rx={RX - 1} ry={RY - 3} fill="#fdfbff" />
            {iris(0, 8.5)}
            {/* 上眼睑压下来一点，显得没精神 */}
            <path
              d={`M ${cx - 13} ${EYE_Y - 12} Q ${cx} ${EYE_Y - 8} ${cx + 13} ${EYE_Y - 12}`}
              fill="none"
              stroke="#2b2a4e"
              strokeWidth="4"
              strokeLinecap="round"
            />
            {/* 泪光 */}
            <path
              d={`M ${cx - 8} ${EYE_Y + 9} q -3 6 0 8 q 3 -2 0 -8 Z`}
              fill="#a8ddff"
              opacity="0.9"
            />
          </g>
        )
      case 'flat':
        return (
          <g>
            {brow(1)}
            <path
              d={`M ${cx - 13} ${EYE_Y - 1} L ${cx + 13} ${EYE_Y - 2}`}
              stroke="#2b2a4e"
              strokeWidth="3.4"
              strokeLinecap="round"
            />
          </g>
        )
      case 'angry':
        return (
          <g>
            {/* 眉压低并斜向内，是"生气"最关键的一笔 */}
            <path
              d={`M ${cx - 15} ${88} L ${cx + 12} ${96}`}
              stroke={darken(p.eyeTop, 0.6)}
              strokeWidth="3.2"
              strokeLinecap="round"
              opacity="0.85"
            />
            <ellipse cx={cx} cy={EYE_Y} rx={RX - 1} ry={RY - 3} fill="#fdfbff" />
            {iris(0, 8)}
            <path
              d={`M ${cx - 13} ${EYE_Y - 11} Q ${cx} ${EYE_Y - 13} ${cx + 13} ${EYE_Y - 9}`}
              fill="none"
              stroke="#2b2a4e"
              strokeWidth="4"
              strokeLinecap="round"
            />
          </g>
        )
      case 'wide':
        // 睁大：瞳孔缩小、眼白增多，是"受惊/不安"的通用画法
        return (
          <g>
            {brow(-6)}
            <ellipse cx={cx} cy={EYE_Y} rx={RX + 1} ry={RY + 2} fill="#fdfbff" />
            {iris(0, 7)}
            <path
              d={`M ${cx - 14} ${EYE_Y - 15} Q ${cx} ${EYE_Y - 18} ${cx + 14} ${EYE_Y - 15}`}
              fill="none"
              stroke="#2b2a4e"
              strokeWidth="4.2"
              strokeLinecap="round"
            />
          </g>
        )
      case 'tear':
        return (
          <g>
            {brow(3, 2)}
            <ellipse cx={cx} cy={EYE_Y + 1} rx={RX - 1} ry={RY - 3} fill="#fdfbff" />
            {iris(0, 8.5)}
            {/* 挂在眼角的一滴，比画在脸上更自然 */}
            <path
              d={`M ${cx - 12} ${EYE_Y + 8} q -4 8 0 11 q 4 -3 0 -11 Z`}
              fill="#9bd8ff"
              opacity="0.92"
            />
            <path
              d={`M ${cx - 13} ${EYE_Y - 12} Q ${cx} ${EYE_Y - 9} ${cx + 13} ${EYE_Y - 12}`}
              fill="none"
              stroke="#2b2a4e"
              strokeWidth="4"
              strokeLinecap="round"
            />
          </g>
        )
      case 'side':
        // 眼神偏向一边：虹膜整体平移，眼睑画一半营造"斜眼"
        return (
          <g>
            {brow(0)}
            <ellipse cx={cx} cy={EYE_Y} rx={RX} ry={RY - 2} fill="#fdfbff" />
            {iris(4.5, 8.5)}
            <path
              d={`M ${cx - 13} ${EYE_Y - 13} Q ${cx} ${EYE_Y - 9} ${cx + 13} ${EYE_Y - 13}`}
              fill="none"
              stroke="#2b2a4e"
              strokeWidth="4.4"
              strokeLinecap="round"
            />
          </g>
        )
      case 'heart':
        return (
          <g>
            {brow(-5)}
            <ellipse cx={cx} cy={EYE_Y} rx={RX} ry={RY - 1} fill="#fdfbff" />
            <path
              d={`M ${cx} ${EYE_Y + 10} C ${cx - 13} ${EYE_Y - 1} ${cx - 11} ${EYE_Y - 12} ${cx - 4} ${EYE_Y - 11}
                 C ${cx - 1} ${EYE_Y - 10.5} ${cx} ${EYE_Y - 6} ${cx} ${EYE_Y - 6}
                 C ${cx} ${EYE_Y - 6} ${cx + 1} ${EYE_Y - 10.5} ${cx + 4} ${EYE_Y - 11}
                 C ${cx + 11} ${EYE_Y - 12} ${cx + 13} ${EYE_Y - 1} ${cx} ${EYE_Y + 10} Z`}
              fill="#ff4d7d"
            />
            <circle cx={cx - 3.5} cy={EYE_Y - 6} r="2.2" fill="#fff" />
          </g>
        )
      default:
        // 默认：标准大眼。眼白 + 渐变虹膜 + 双高光 + 上睫毛
        return (
          <g>
            {brow()}
            <ellipse cx={cx} cy={EYE_Y} rx={RX} ry={RY} fill="#fdfbff" />
            {iris(0, 9)}
            {/* 上眼睑与睫毛：比眼白宽一点，向外挑出 */}
            <path
              d={`M ${cx - 14.5} ${EYE_Y - 14} Q ${cx} ${EYE_Y - 20.5} ${cx + 14.5} ${EYE_Y - 13}`}
              fill="none"
              stroke="#2b2a4e"
              strokeWidth="4.2"
              strokeLinecap="round"
            />
            <path
              d={`M ${cx + 13} ${EYE_Y - 14} l 5 -4`}
              stroke="#2b2a4e"
              strokeWidth="2.6"
              strokeLinecap="round"
            />
          </g>
        )
    }
  })()

  return (
    <g className="va-eye-gaze">
      <g
        className="va-eye-blink"
        // 每只眼用自己的中心当缩放原点，压扁时朝各自中心收，两只眼不会互相拉偏
        style={{ transformOrigin: `${cx}px ${EYE_Y}px` }}
      >
        {inner}
      </g>
    </g>
  )
}

// 嘴（新坐标系：嘴中心 y≈134，脸下缘 152）。
// 外面这层 .va-mouth 让嘴角有极轻微的起伏（呼吸感），
// 静止不动的嘴会让整张脸立刻露出"这是个图标"的破绽
function Mouth({ variant }) {
  const inner = (() => {
    switch (variant) {
      case 'open':
        return (
          <g>
            <ellipse cx="100" cy="135" rx="7" ry="6" fill="#8a3b52" />
            <ellipse cx="100" cy="137.5" rx="4.5" ry="3" fill="#e2748c" opacity="0.85" />
            <path
              d="M 93 135 Q 100 132 107 135"
              fill="none"
              stroke="#c76a80"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </g>
        )
      case 'grin':
        return (
          <g>
            <path d="M 88 131 Q 100 146 112 131 Q 100 135 88 131 Z" fill="#8a3b52" />
            <path d="M 90 132.5 L 110 132.5" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" />
          </g>
        )
      case 'pout':
        return (
          <g>
            <ellipse cx="100" cy="134" rx="4" ry="4.5" fill="#c76a80" />
            <path d="M 96 131 Q 100 133 104 131" fill="none" stroke="#a85268" strokeWidth="1.4" strokeLinecap="round" />
          </g>
        )
      case 'frown':
        return (
          <path
            d="M 91 137 Q 100 129 109 137"
            fill="none"
            stroke="#b8617a"
            strokeWidth="3"
            strokeLinecap="round"
          />
        )
      case 'neutral':
        return (
          <path d="M 93 134 L 107 134" stroke="#b8617a" strokeWidth="3" strokeLinecap="round" />
        )
      case 'grit':
        return (
          <g>
            <path d="M 90 131 Q 100 141 110 131 Q 100 134 90 131 Z" fill="#8a3b52" />
            <path d="M 92 132 L 108 132" stroke="#fff" strokeWidth="2.8" strokeLinecap="round" />
            <path d="M 100 132 L 100 137" stroke="#fff" strokeWidth="1.2" opacity="0.6" />
          </g>
        )
      case 'tremble':
        return (
          <path
            d="M 92 134 L 95.5 130.5 L 99 135 L 102.5 130.5 L 106 135 L 108.5 132"
            fill="none"
            stroke="#b8617a"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )
      default:
        // 微笑：上唇线 + 下唇一点，比单纯一条弧更立体
        return (
          <g>
            <path
              d="M 91 131 Q 100 140 109 131"
              fill="none"
              stroke="#c05e78"
              strokeWidth="3"
              strokeLinecap="round"
            />
            <path
              d="M 94 133.5 Q 100 137 106 133.5"
              fill="none"
              stroke="#e08fa2"
              strokeWidth="1.6"
              strokeLinecap="round"
              opacity="0.8"
            />
          </g>
        )
    }
  })()

  return (
    <g className="va-mouth" style={{ transformOrigin: '100px 134px' }}>
      {inner}
    </g>
  )
}

export default function VirtualAvatar({
  expression = { eyes: 'normal', mouth: 'smile' },
  color = '#8b5cf6',
  spark = true,
  className = ''
}) {
  const { eyes, mouth } = expression
  const blush = ['happy', 'shy', 'heart'].includes(eyes)

  // 渐变 id 必须全局唯一：侧栏、空对话页、首页特性区可能同时挂载多个头像，
  // 同名 defs 会让后面的头像套用第一个的颜色
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')

  return (
    <div
      className={`va-wrap ${className}`}
      style={{ '--va-glow': hexToRgba(color, 0.45), '--va-spark-color': color }}
    >
      <div className="va-halo" />
      <div className="va-orb" />
      {spark && (
        <>
          <span className="va-spark" style={{ top: '15%', left: '21%' }} />
          <span className="va-spark" style={{ top: '23%', right: '15%', animationDelay: '1.1s' }} />
          <span className="va-spark" style={{ bottom: '19%', left: '29%', animationDelay: '2.1s' }} />
          <span className="va-spark" style={{ bottom: '27%', right: '26%', animationDelay: '0.6s' }} />
        </>
      )}
      <div className="va-face">
        {/* viewBox 按角色实际占位取（头顶到肩部 y 40~200），
            与 width/height 同比例，缩放 1:1 不失真 */}
        <svg width="168" height="168" viewBox="0 0 200 200" aria-hidden="true">
          <Character color={color} eyes={eyes} mouth={mouth} blush={blush} uid={uid} />
        </svg>
      </div>
    </div>
  )
}
