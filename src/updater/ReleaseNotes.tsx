import type { ReactNode } from 'react'
import { toast } from '../components/common/Toast'
import { useT } from '../i18n'
import { openExternalUrl } from '../utils/externalLinks'

function renderInline(text: string, keyPrefix: string, t: (key: string) => string): ReactNode[] {
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\))/g
  const nodes: ReactNode[] = []
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    const value = match[0]
    const start = match.index ?? 0
    if (start > cursor) nodes.push(text.slice(cursor, start))
    const key = `${keyPrefix}-${start}`
    if (value.startsWith('**') || value.startsWith('__')) {
      nodes.push(<strong key={key}>{value.slice(2, -2)}</strong>)
    } else if (value.startsWith('~~')) {
      nodes.push(<del key={key}>{value.slice(2, -2)}</del>)
    } else if (value.startsWith('`')) {
      nodes.push(<code key={key}>{value.slice(1, -1)}</code>)
    } else if (value.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(value)
      const href = link?.[2]
      let safeHref: string | null = null
      try {
        const url = new URL(href ?? '')
        if (url.protocol === 'https:' || url.protocol === 'http:') safeHref = url.href
      } catch { /* leave unsupported link syntax as readable text */ }
      nodes.push(safeHref && link
        ? <a key={key} href={safeHref} onClick={(event) => {
          event.preventDefault()
          void openExternalUrl(safeHref).catch(() => toast.show(t('Could not open external link'), 'error'))
        }}>{link[1]}</a>
        : value)
    } else {
      nodes.push(<em key={key}>{value.slice(1, -1)}</em>)
    }
    cursor = start + value.length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

function isListStart(line: string): boolean {
  return /^\s*(?:[-*+]\s+|\d+\.\s+)/.test(line)
}

/** Renders the common release-note Markdown safely, without accepting raw HTML. */
export default function ReleaseNotes({ markdown }: { markdown: string }) {
  const t = useT()
  const lines = markdown.replace(/\r/g, '').split('\n')
  const blocks: ReactNode[] = []
  let index = 0
  let blockIndex = 0

  while (index < lines.length) {
    const line = lines[index].trim()
    if (!line) { index += 1; continue }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line)
    if (heading) {
      const Tag = `h${Math.min(4, heading[1].length + 1)}` as 'h2' | 'h3' | 'h4' | 'h5'
      blocks.push(<Tag key={`h-${blockIndex++}`}>{renderInline(heading[2], `h-${index}`, t)}</Tag>)
      index += 1
      continue
    }

    if (isListStart(line)) {
      const ordered = /^\d+\./.test(line)
      const items: ReactNode[] = []
      while (index < lines.length && isListStart(lines[index])) {
        const item = lines[index].trim().replace(/^(?:[-*+]\s+|\d+\.\s+)/, '')
        items.push(<li key={`li-${index}`}>{renderInline(item, `li-${index}`, t)}</li>)
        index += 1
      }
      blocks.push(ordered
        ? <ol key={`ol-${blockIndex++}`}>{items}</ol>
        : <ul key={`ul-${blockIndex++}`}>{items}</ul>)
      continue
    }

    const paragraph: string[] = [line]
    index += 1
    while (index < lines.length) {
      const next = lines[index].trim()
      if (!next || /^#{1,4}\s+/.test(next) || isListStart(next)) break
      paragraph.push(next)
      index += 1
    }
    blocks.push(<p key={`p-${blockIndex++}`}>{paragraph.map((part, lineIndex) => (
      <span key={`line-${lineIndex}`}>{lineIndex > 0 ? <br /> : null}{renderInline(part, `p-${index}-${lineIndex}`, t)}</span>
    ))}</p>)
  }

  return <div className="update-markdown">{blocks}</div>
}
