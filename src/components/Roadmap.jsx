import Reveal from './Reveal'

const STEPS = [
  {
    status: 'done',
    badge: '已完成',
    title: '第一阶段 · 稳稳保存',
    desc: '流式停止与失败处理、人格记忆隔离、旧存档迁移、多会话加密和完整备份。存储不足时明确提示，保留内容供你导出。'
  },
  {
    status: 'done',
    badge: '已完成',
    title: '第二阶段 · 每段故事都有位置',
    desc: '电脑与手机共用完整功能：多会话、独立草稿、全文搜索、收藏、复制、编辑分支、重新生成和文本导出。'
  },
  {
    status: 'done',
    badge: '已完成',
    title: '第三阶段 · 看见与听见',
    desc: '图片压缩与发送、自定义角色形象，以及浏览器支持时的语音输入、回复朗读和声音设置。长期记忆可管理、重建和补全。'
  },
  {
    status: 'dream',
    badge: '后续扩展',
    title: '下一步 · 实时虚拟人',
    desc: '真正的 Live2D 动作与口型、连续语音通话仍需对应模型、授权与服务支持。目前使用情绪头像和静态自定义图片。'
  }
]

export default function Roadmap() {
  return (
    <section className="section" id="roadmap">
      <div className="container">
        <Reveal>
          <div className="section-head">
            <h2 className="section-title">
              她会一步步
              <span className="grad">来到你身边</span>
            </h2>
            <p className="section-sub">这是你我的约定，也是星语正在走的路。</p>
          </div>
        </Reveal>

        <div className="timeline">
          {STEPS.map((s, i) => (
            <Reveal className={`t-step ${s.status}`} key={s.title} delay={i * 90}>
              <span className="t-dot" />
              <h3 className="t-title">
                {s.title}
                <span className={`t-badge ${s.status}`}>{s.badge}</span>
              </h3>
              <p className="t-desc">{s.desc}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
