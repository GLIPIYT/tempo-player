import { memo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { toast } from '../components/common/Toast'
import { useT } from '../i18n'
import { openExternalUrl } from '../utils/externalLinks'
import { RELEASE_TYPE_MARKER } from './releaseType'
import releasePosterPreview from './assets/v1.5.0-changelog-preview.webp'

const RELEASE_POSTER_URL = 'https://raw.githubusercontent.com/GLIPIYT/tempo-player/v1.5.0/docs/design/changelog-1.5.0/tempo-1.5.0-changelog.webp'

interface MarkdownImageTarget {
  src: string
  title?: string
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

function parseImageTarget(target: string): MarkdownImageTarget | null {
  const match = /^(?:<([^<>]+)>|(\S+))(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?$/.exec(target.trim())
  if (!match) return null
  const src = safeHttpUrl(match[1] ?? match[2] ?? '')
  if (!src) return null
  const title = match[3] ?? match[4] ?? match[5]
  return title === undefined ? { src } : { src, title }
}

function openLink(href: string, t: (key: string) => string) {
  return (event: ReactMouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    void openExternalUrl(href).catch(() => toast.show(t('Could not open external link'), 'error'))
  }
}

function MarkdownImage({ src, alt, title }: MarkdownImageTarget & { alt: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <span className="update-markdown-image-fallback">{alt}</span>
  // Keep the 1.5.0 poster sharp enough for the dialog while avoiding a 13 MP
  // decode. Its wrapping link still points at the full-resolution original.
  const displaySrc = src === RELEASE_POSTER_URL ? releasePosterPreview : src
  return (
    <img
      className="update-markdown-image"
      src={displaySrc}
      alt={alt}
      title={title}
      loading="lazy"
      decoding="async"
      fetchPriority="low"
      onError={() => setFailed(true)}
    />
  )
}

function externalAnchor(href: string, key: string, children: ReactNode, t: (key: string) => string, className?: string) {
  return <a key={key} href={href} className={className} onClick={openLink(href, t)}>{children}</a>
}

function renderImage(imageTarget: string, alt: string, key: string, t: (key: string) => string): ReactNode {
  const target = parseImageTarget(imageTarget)
  if (!target) return alt
  return externalAnchor(
    target.src,
    `${key}-link`,
    <MarkdownImage src={target.src} alt={alt} title={target.title} />,
    t,
    'update-markdown-image-link',
  )
}

function renderInline(text: string, keyPrefix: string, t: (key: string) => string): ReactNode[] {
  const pattern = /(\[!\[[^\]]*\]\([^)]+\)\]\([^)]+\)|!\[[^\]]*\]\([^)]+\)|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\))/g
  const nodes: ReactNode[] = []
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    const value = match[0]
    const start = match.index ?? 0
    if (start > cursor) nodes.push(text.slice(cursor, start))
    const key = `${keyPrefix}-${start}`
    const linkedImage = /^\[!\[([^\]]*)\]\(([^)]*)\)\]\(([^)]*)\)$/.exec(value)
    const image = /^!\[([^\]]*)\]\(([^)]*)\)$/.exec(value)
    if (linkedImage) {
      const [, alt, imageTarget, linkTarget] = linkedImage
      const parsedImage = parseImageTarget(imageTarget)
      const imageNode = parsedImage
        ? <MarkdownImage src={parsedImage.src} alt={alt} title={parsedImage.title} />
        : alt
      const safeHref = safeHttpUrl(linkTarget)
      nodes.push(safeHref
        ? externalAnchor(safeHref, key, imageNode, t, 'update-markdown-image-link')
        : parsedImage
          ? renderImage(imageTarget, alt, key, t)
          : alt)
    } else if (image) {
      nodes.push(renderImage(image[2], image[1], key, t))
    } else if (value.startsWith('**') || value.startsWith('__')) {
      nodes.push(<strong key={key}>{value.slice(2, -2)}</strong>)
    } else if (value.startsWith('~~')) {
      nodes.push(<del key={key}>{value.slice(2, -2)}</del>)
    } else if (value.startsWith('`')) {
      nodes.push(<code key={key}>{value.slice(1, -1)}</code>)
    } else if (value.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(value)
      const safeHref = link ? safeHttpUrl(link[2]) : null
      nodes.push(safeHref && link
        ? externalAnchor(safeHref, key, link[1], t)
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
function ReleaseNotes({ markdown }: { markdown: string }) {
  const t = useT()
  const lines = markdown.replace(RELEASE_TYPE_MARKER, '').replace(/\r/g, '').split('\n')
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

// Download progress and installed-update effects rerender the dialog while its
// selected release notes stay unchanged. Keep the Markdown tree stable across
// those updates, especially when the notes include a tall banner image.
export default memo(ReleaseNotes)
