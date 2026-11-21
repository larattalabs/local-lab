/**
 * A deliberately small Markdown renderer for agent replies: fenced code,
 * inline code, bold/italic, headings, lists, links shown as text. Everything is
 * HTML-escaped first, so model output can never inject markup.
 */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '<span class="md-link" title="$2">$1</span>')
}

export function markdown(src: string): string {
  const out: string[] = []
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  let list: 'ul' | 'ol' | null = null
  let para: string[] = []
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = [] } }
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null } }
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^\s*```(\S*)/)
    if (fence) {
      flushPara(); closeList()
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++])
      i++ // closing fence (or end of a still-streaming block)
      out.push(`<pre class="md-code"${fence[1] ? ` data-lang="${esc(fence[1])}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`)
      continue
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    const ul = line.match(/^\s*[-*+]\s+(.*)$/)
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (h) { flushPara(); closeList(); out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`) }
    else if (ul || ol) {
      flushPara()
      const kind = ul ? 'ul' : 'ol'
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind }
      out.push(`<li>${inline((ul ?? ol)![1])}</li>`)
    } else if (!line.trim()) { flushPara(); closeList() }
    else { closeList(); para.push(line) }
    i++
  }
  flushPara(); closeList()
  return out.join('')
}

/** Colour unified-diff lines; returns escaped HTML. */
export function diffHtml(src: string): string {
  return src.split('\n').map((l) => {
    const cls = l.startsWith('+') && !l.startsWith('+++') ? 'd-add' : l.startsWith('-') && !l.startsWith('---') ? 'd-del' : l.startsWith('@@') ? 'd-hunk' : ''
    return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l)
  }).join('\n')
}

export const looksLikeDiff = (s: string) => /^(@@|\+\+\+|---|Index: )/m.test(s)
