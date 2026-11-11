import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import ReleaseNotes from './ReleaseNotes'

vi.mock('../utils/externalLinks', () => ({
  openExternalUrl: vi.fn(() => Promise.resolve()),
}))

function render(markdown: string): string {
  return renderToStaticMarkup(<ReleaseNotes markdown={markdown} />)
}

describe('ReleaseNotes Markdown images', () => {
  it('uses a bundled preview for the official poster and keeps its full-resolution link', () => {
    const original = 'https://raw.githubusercontent.com/GLIPIYT/tempo-player/v1.5.0/docs/design/changelog-1.5.0/tempo-1.5.0-changelog.webp'
    const markup = render(`![Tempo 1.5.0](<${original}>)`)

    expect(markup).toContain(`href="${original}"`)
    expect(markup).toContain('src="/src/updater/assets/v1.5.0-changelog-preview.webp"')
    expect(markup).not.toContain(`src="${original}"`)
  })

  it('renders standalone and inline HTTP(S) images with alt text, lazy loading, decoding, and optional title', () => {
    const markup = render('![Poster banner](https://example.com/banner.png "Release banner")\nInline: ![Icon](http://example.com/icon.png)')

    expect(markup).toContain('class="update-markdown-image"')
    expect(markup).toContain('src="https://example.com/banner.png"')
    expect(markup).toContain('alt="Poster banner"')
    expect(markup).toContain('title="Release banner"')
    expect(markup).toContain('loading="lazy"')
    expect(markup).toContain('decoding="async"')
    expect(markup).toContain('href="https://example.com/banner.png"')
    expect(markup).toContain('src="http://example.com/icon.png"')
  })

  it('renders a linked image with its safe outer URL and opens the full image link', () => {
    const markup = render('[![Banner preview](https://example.com/preview.png "Preview")](https://example.com/full.png)')

    expect(markup).toContain('href="https://example.com/full.png"')
    expect(markup).toContain('src="https://example.com/preview.png"')
    expect(markup).toContain('alt="Banner preview"')
    expect(markup).toContain('title="Preview"')
  })

  it('rejects javascript, file, and data image sources while keeping their alt text readable', () => {
    const markup = render('![Script](javascript:alert) ![Local file](file:///tmp/banner.png) ![Embedded](data:image/png;base64,AA==)')

    expect(markup).toContain('Script')
    expect(markup).toContain('Local file')
    expect(markup).toContain('Embedded')
    expect(markup).not.toContain('<img')
    expect(markup).not.toContain('href="javascript:')
    expect(markup).not.toContain('src="file:')
    expect(markup).not.toContain('src="data:')
  })

  it('keeps existing headings, lists, links, emphasis, and marker removal', () => {
    const markup = render('<!-- tempo:release-type=major -->\n# Summary\n- **Bold** and _italic_ with [details](https://example.com)')

    expect(markup).toContain('<h2>Summary</h2>')
    expect(markup).toContain('<ul><li><strong>Bold</strong> and <em>italic</em> with <a href="https://example.com/">details</a></li></ul>')
    expect(markup).not.toContain('tempo:release-type')
  })

  it('escapes raw HTML instead of inserting it into the notes document', () => {
    const markup = render('<img src=x onerror=alert(1)>')

    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(markup).not.toContain('<img src=x')
  })
})
