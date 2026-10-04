import React from 'react'

let uid = 0
const key = () => `md-${++uid}`

function renderInline(text) {
  const nodes = []
  // React escapes text nodes itself; pre-escaping prints literal &amp; entities.
  const rest = String(text)
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let m
  while ((m = pattern.exec(rest)) !== null) {
    if (m.index > last) nodes.push(rest.slice(last, m.index))
    const token = m[0]
    if (token.startsWith('`')) {
      nodes.push(
        <code className="md-code" key={key()}>
          {token.slice(1, -1)}
        </code>
      )
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key()}>{renderInline(token.slice(2, -2))}</strong>)
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key()}>{renderInline(token.slice(1, -1))}</em>)
    } else {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      if (linkMatch) {
        const href = linkMatch[2].trim()
        // 只允许 http/https/mailto，杜绝 javascript: 之类协议注入
        if (/^(https?:|mailto:)/i.test(href)) {
          nodes.push(
            <a key={key()} href={href} target="_blank" rel="noreferrer">
              {linkMatch[1]}
            </a>
          )
        } else {
          nodes.push(linkMatch[1])
        }
      } else {
        nodes.push(token)
      }
    }
    last = m.index + token.length
  }
  if (last < rest.length) nodes.push(rest.slice(last))
  return nodes
}

export function renderMarkdown(md = '') {
  const source = String(md).replace(/\r\n/g, '\n')
  const blocks = []
  const lines = source.split('\n')
  let i = 0
  let list = null

  const flushList = () => {
    if (list) {
      blocks.push(<ul key={key()}>{list}</ul>)
      list = null
    }
  }

  while (i < lines.length) {
    const line = lines[i]

    const fence = /^```(\w*)\s*$/.exec(line)
    if (fence) {
      flushList()
      const codeLines = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i])
        i++
      }
      i++
      blocks.push(
        <pre className="md-pre" key={key()}>
          <code>{codeLines.join('\n')}</code>
        </pre>
      )
      continue
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      flushList()
      const level = heading[1].length
      const Tag = `h${Math.min(4, level + 2)}`
      blocks.push(<Tag key={key()}>{renderInline(heading[2])}</Tag>)
      i++
      continue
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      if (!list) list = []
      list.push(<li key={key()}>{renderInline(bullet[1])}</li>)
      i++
      continue
    }

    if (/^>\s?/.test(line)) {
      flushList()
      const quoteLines = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      blocks.push(
        <blockquote key={key()}>
          {quoteLines.map((q) => (
            <div key={key()}>{renderInline(q)}</div>
          ))}
        </blockquote>
      )
      continue
    }

    if (/^\s*$/.test(line)) {
      flushList()
      i++
      continue
    }

    flushList()
    const paraLines = [line]
    i++
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(#{1,4})\s/.test(lines[i]) &&
      !/^\s*[-*]\s/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^>\s?/.test(lines[i])
    ) {
      paraLines.push(lines[i])
      i++
    }
    blocks.push(<p key={key()}>{renderInline(paraLines.join('\n'))}</p>)
  }
  flushList()
  return blocks
}
