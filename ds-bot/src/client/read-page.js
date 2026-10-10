// The page reader for `read_browser`. `readPage` runs inside the Bot's webview, so it is
// serialized with Function.prototype.toString: it must not use any name from this module
// or any import, only its own locals and the page's globals.

export const READ_LIMITS = {
  chars: 400_000,
  nodes: 150_000,
  depth: 400,
  ms: 1500,
  items: 3000,
  tableRows: 5000,
  tableCols: 30,
  frameDepth: 3,
}

/**
 * Reads what a person sees: the visible content as Markdown, the selection, and the
 * links and controls, each marked `[#n]` in the text where it sits. Walks open shadow
 * roots (with slotted content) and same-origin iframes. Secret fields never report a value.
 * @param {typeof READ_LIMITS} limits
 */
export function readPage(limits) {
  const started = performance.now()
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link', 'svg', 'object', 'embed', 'audio', 'video', 'source', 'track', 'map', 'datalist', 'option', 'optgroup'])
  const ITEM = 'a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [role=radio], [contenteditable=""], [contenteditable=true]'
  const ROLES = { a: 'link', button: 'button', select: 'select', textarea: 'textbox', summary: 'button' }
  const INPUT_ROLES = { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button', image: 'button', search: 'searchbox', range: 'slider', file: 'button', color: 'button' }
  const NO_VALUE_TYPES = new Set(['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file', 'color'])
  const SECRET_HINT = /(^|[-_\s])(cvv|cvc|csc|cc-?(num|number|csc|exp)|card-?(num|number)|otp|one-?time-?code|pin)([-_\s]|$)/i
  const BLOCK_DISPLAY = /^(block|flex|grid|list-item|table|flow-root|table-caption|table-row-group|table-header-group|table-footer-group|table-row|-webkit-box)$/
  const INLINE_BLOCK = /^(inline-block|inline-flex|inline-grid|inline-table|table-cell|-webkit-inline-box)$/
  const SEMANTIC = /^(ul|ol|table|pre|blockquote|h[1-6]|code|details)$/

  const items = []
  const stash = []
  const stats = { nodes: 0, frames: 0 }
  let chars = 0
  let stop = ''

  const collapse = value => String(value || '').replace(/\s+/g, ' ').trim()
  const isSecret = (el) => {
    if (el.localName !== 'input' && el.localName !== 'textarea') return false
    const auto = String(el.getAttribute('autocomplete') || '').toLowerCase()
    return el.type === 'password' || /(^|\s)(cc-|one-time-code)/.test(auto) || SECRET_HINT.test(`${el.getAttribute('name') || ''} ${el.id || ''}`)
  }
  // A finished block (list, quote, table, code, frame) is kept aside behind a token, so the
  // whitespace clean-up of the text around it cannot touch its indentation.
  // Preformatted lines end in \u0003 instead of \u0002: a code view that puts each line in
  // its own block (GitHub) gets single line breaks between them, not blank lines.
  const keep = (text, end = '\u0002') => {
    if (text === '') return ''
    stash.push(text)
    return `\n\n\u0001${stash.length - 1}${end}\n\n`
  }
  const expand = text => text.replace(/\u0001(\d+)[\u0002\u0003]/g, (_, index) => expand(stash[Number(index)]))
  const flow = text => text
    .split('\n')
    .map(line => line.replace(/[ \t\f\v\u00a0\u2028\u2029]+/g, ' ').trim().replace(/^· /, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\u0003\n\n(?=\u0001\d+\u0003)/g, '\u0003\n')
    .trim()
  const block = text => expand(flow(text))
  const oneLine = text => block(text).replace(/\s*\n+\s*/g, ' ').trim()
  const styleOf = el => (el.ownerDocument.defaultView || window).getComputedStyle(el)
  const childrenOf = (el) => {
    if (el.shadowRoot) return el.shadowRoot.childNodes
    if (el.localName === 'slot' && typeof el.assignedNodes === 'function') {
      const assigned = el.assignedNodes()
      if (assigned.length > 0) return assigned
    }
    return el.childNodes
  }
  const over = () => {
    if (stop) return true
    if (chars > limits.chars) stop = `the text passed ${limits.chars} characters`
    else if (stats.nodes > limits.nodes) stop = `the page has more than ${limits.nodes} nodes`
    else if (stats.nodes % 512 === 0 && performance.now() - started > limits.ms) stop = `reading took longer than ${limits.ms} ms`
    return stop !== ''
  }

  const roleOf = el => el.getAttribute('role') || ROLES[el.localName] || (el.localName === 'input' ? INPUT_ROLES[el.type] || 'textbox' : el.isContentEditable ? 'textbox' : el.localName)
  const sized = (el) => {
    const box = el.getBoundingClientRect()
    return box.width > 0 && box.height > 0
  }
  // Numbered before its content is walked, so a control inside a link gets the next number.
  const itemFor = (el, style) => {
    if (items.length >= limits.items || style.visibility !== 'visible' || !el.matches(ITEM) || !sized(el)) return null
    const item = { role: roleOf(el) }
    const secret = isSecret(el)
    if (el.href) item.href = String(el.href)
    if ((el.localName === 'input' || el.localName === 'textarea') && !secret && !NO_VALUE_TYPES.has(el.type) && el.value) item.value = String(el.value).slice(0, 120)
    if (el.localName === 'select' && el.selectedOptions?.length) item.value = collapse([...el.selectedOptions].map(option => option.label || option.text).join(', ')).slice(0, 120)
    if (el.checked) item.checked = true
    if (el.disabled) item.disabled = true
    items.push(item)
    return { item, number: items.length, secret }
  }
  const nameOf = (el, text, secret) => collapse(
    el.getAttribute('aria-label') || text
    || (el.localName === 'input' && !secret && NO_VALUE_TYPES.has(el.type) ? el.value : '')
    || el.getAttribute('placeholder') || el.title || el.getAttribute('alt')
    || el.querySelector?.('img[alt]')?.alt || el.getAttribute('name') || '',
  ).slice(0, 80)

  const fenced = (code, lang) => {
    const longest = Math.max(2, ...(code.match(/`{3,}/g) || []).map(run => run.length))
    const fence = '`'.repeat(longest + 1)
    return `${fence}${lang}\n${code.replace(/\n+$/, '')}\n${fence}`
  }
  const langOf = (el) => {
    const names = `${el.className || ''} ${el.querySelector?.('code')?.className || ''}`
    return /(?:^|\s)(?:lang|language)-([\w+#.-]+)/.exec(names)?.[1] || ''
  }

  const list = (el, ctx) => {
    const ordered = el.localName === 'ol'
    let number = ordered ? Number(el.getAttribute('start') || 1) || 1 : 1
    const lines = []
    for (const child of childrenOf(el)) {
      if (over()) break
      if (child.nodeType !== 1 || child.localName !== 'li') {
        const loose = block(render(child, ctx))
        if (loose) lines.push(loose)
        continue
      }
      const style = styleOf(child)
      if (style.display === 'none') continue
      let body = block(children(child, { ...ctx, depth: ctx.depth + 1, shown: style.visibility === 'visible' }))
      if (!body.includes('```')) body = body.replace(/\n{2,}/g, '\n')
      const marker = ordered ? `${number++}. ` : '- '
      if (body === '') continue
      const pad = ' '.repeat(marker.length)
      lines.push(body.split('\n').map((line, index) => (index === 0 ? marker : line ? pad : '') + line).join('\n'))
    }
    return keep(lines.join('\n'))
  }

  const cellText = (cell, ctx) => block(children(cell, ctx)).replace(/\n+/g, ' <br> ').replace(/\|/g, '\\|')
  const layoutTable = (table, rows) => {
    const role = table.getAttribute('role')
    if (role === 'presentation' || role === 'none') return true
    if (table.querySelector('table')) return true
    return !rows.some(row => row.cells.length > 1)
  }
  const tableMarkdown = (table, ctx) => {
    const rows = [...table.rows].filter(row => styleOf(row).display !== 'none')
    const caption = table.caption ? oneLine(children(table.caption, ctx)) : ''
    if (layoutTable(table, rows)) {
      return rows.map(row => [...row.cells].map(cell => `\n\n${children(cell, ctx)}\n\n`).join('')).join('')
    }
    const grid = []
    const carry = []
    let width = 0
    // The limit counts the rows after the first, which becomes the header.
    for (const row of rows.slice(0, limits.tableRows + 1)) {
      if (over()) break
      const line = []
      let column = 0
      const place = () => {
        while (carry[column]?.left > 0) {
          line[column] = carry[column].text
          carry[column].left -= 1
          column += 1
        }
      }
      for (const cell of row.cells) {
        place()
        if (styleOf(cell).display === 'none') continue
        const text = cellText(cell, ctx)
        const span = Math.max(1, Math.min(limits.tableCols, Number(cell.colSpan) || 1))
        const down = Math.max(1, Math.min(limits.tableRows, Number(cell.rowSpan) || 1))
        for (let offset = 0; offset < span; offset += 1) {
          line[column] = offset === 0 ? text : ''
          if (down > 1) carry[column] = { text: offset === 0 ? text : '', left: down - 1 }
          column += 1
        }
      }
      place()
      width = Math.max(width, line.length)
      grid.push(line)
    }
    width = Math.min(width, limits.tableCols)
    if (grid.length === 0 || width === 0) return caption ? `\n\n${caption}\n\n` : ''
    const format = cells => `| ${Array.from({ length: width }, (_, index) => cells[index] ?? '').join(' | ')} |`
    const out = [format(grid[0]), `|${' --- |'.repeat(width)}`, ...grid.slice(1).map(format)]
    if (rows.length > limits.tableRows + 1) out.push(`… (table cut: ${rows.length - limits.tableRows - 1} more rows)`)
    return `${caption ? `\n\nTable: ${caption}` : ''}${keep(out.join('\n'))}`
  }

  const frame = (el, ctx) => {
    let doc = null
    try { doc = el.contentDocument } catch { doc = null }
    const address = (() => {
      try { return doc?.location?.href || el.src || el.getAttribute('src') || 'about:blank' } catch { return el.src || 'about:blank' }
    })()
    if (!doc) return `\n\n[iframe (cross-origin, not readable): ${address}]\n\n`
    if (ctx.frames >= limits.frameDepth) return `\n\n[iframe (nested too deep, not read): ${address}]\n\n`
    stats.frames += 1
    const title = collapse(el.title || doc.title)
    const body = doc.body ? block(children(doc.body, { ...ctx, frames: ctx.frames + 1, depth: ctx.depth + 1, shown: true, pre: false })) : ''
    return keep(`[iframe: ${title ? `${title} (${address})` : address}]\n${body || '(no text)'}\n[iframe end]`)
  }

  function children(el, ctx) {
    let out = ''
    for (const child of childrenOf(el)) {
      if (over()) break
      out += render(child, ctx)
    }
    return out
  }

  function render(node, ctx) {
    stats.nodes += 1
    if (node.nodeType === 3) {
      if (!ctx.shown) return ''
      const data = node.data.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      const text = ctx.pre ? data : data.replace(/[\t\n\r ]+/g, ' ')
      chars += text.length
      return text
    }
    if (node.nodeType !== 1) return ''
    const el = node
    const tag = el.localName
    if (SKIP.has(tag) || ctx.depth > limits.depth || over()) return ''
    const style = styleOf(el)
    const display = style.display
    if (display === 'none' || style.contentVisibility === 'hidden') return ''
    const shown = style.visibility === 'visible'
    const keepsSpace = String(style.whiteSpace || '').startsWith('pre') || style.whiteSpace === 'break-spaces'
    const next = { ...ctx, depth: ctx.depth + 1, shown }
    if (display === 'contents' && !SEMANTIC.test(tag) && !el.matches(ITEM)) return children(el, next)
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
      const box = el.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) return ''
    }

    if (tag === 'br') return '\n'
    if (tag === 'hr') return '\n\n---\n\n'
    if (tag === 'img') {
      const alt = collapse(el.getAttribute('alt'))
      return shown && alt ? `[image: ${alt}]` : ''
    }
    if (tag === 'canvas') {
      const box = el.getBoundingClientRect()
      return box.width >= 200 && box.height >= 100 ? '\n\n[canvas: drawn content, not readable]\n\n' : ''
    }
    if (tag === 'iframe' || tag === 'frame') {
      const box = el.getBoundingClientRect()
      return tag === 'iframe' && (box.width < 2 || box.height < 2) ? '' : frame(el, next)
    }

    const found = itemFor(el, style)
    const mark = found ? `[#${found.number}]` : ''
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (found) found.item.name = nameOf(el, tag === 'select' ? '' : el.labels?.[0] ? collapse(el.labels[0].textContent) : '', found.secret)
      return mark ? ` ${mark} ` : ''
    }

    let body
    if (tag === 'pre') {
      const code = shown ? String(el.innerText || el.textContent || '') : ''
      chars += code.length
      body = code.trim() ? keep(fenced(code, langOf(el))) : ''
    } else if (tag === 'table') {
      body = tableMarkdown(el, next)
    } else if (tag === 'ul' || tag === 'ol') {
      body = list(el, next)
    } else if (tag === 'details' && !el.open) {
      const summary = [...el.children].find(child => child.localName === 'summary')
      body = summary ? render(summary, next) : ''
    } else {
      body = children(el, { ...next, pre: keepsSpace })
    }
    if (found) found.item.name = nameOf(el, oneLine(body), found.secret)

    const level = /^h([1-6])$/.exec(tag)?.[1] || (el.getAttribute('role') === 'heading' ? el.getAttribute('aria-level') || '2' : '')
    if (level) {
      const title = oneLine(body)
      return title ? `\n\n${'#'.repeat(Math.min(6, Number(level) || 2))} ${title}${mark}\n\n` : mark
    }
    if (tag === 'code' && !ctx.pre) {
      const code = oneLine(body)
      if (!code) return mark
      const ticks = code.includes('`') ? '``' : '`'
      return `${ticks}${code}${ticks}${mark}`
    }
    if (tag === 'blockquote') {
      const quoted = block(body)
      return quoted ? keep(quoted.split('\n').map(line => (line ? `> ${line}` : '>')).join('\n')) : ''
    }
    // The mark goes after the last text, not after the line breaks a nested block leaves.
    const end = body.trimEnd().length
    const marked = mark ? `${body.slice(0, end)}${mark}${body.slice(end)}` : body
    if (ctx.pre && !BLOCK_DISPLAY.test(display)) return marked
    if (keepsSpace && BLOCK_DISPLAY.test(display) && tag !== 'pre') {
      return keep(expand(marked).replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\s+$/g, ''), '\u0003')
    }
    if (BLOCK_DISPLAY.test(display)) return `\n\n${marked}\n\n`
    if (INLINE_BLOCK.test(display)) return ` ${marked} `
    // Inline list items (Wikipedia's navboxes) are told apart by ::after content, which is not read.
    if (tag === 'li') return ` · ${marked}`
    return marked
  }

  const body = document.body
  let text = ''
  if (body) {
    text = block(render(body, { depth: 0, frames: 0, shown: true, pre: false })).replace(/\u00a0/g, ' ')
  }
  if (text.length > limits.chars) {
    text = text.slice(0, limits.chars)
    stop ||= `the text passed ${limits.chars} characters`
  }
  const page = {
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang || '',
    description: document.querySelector('meta[name="description"]')?.content || '',
    selection: String(getSelection() || '').slice(0, 4000),
    format: 'markdown',
    text,
    items,
    stats: { ...stats, ms: Math.round(performance.now() - started) },
  }
  if (stop) page.truncated = stop
  return page
}

/** The reader as one expression for `executeJavaScript`. */
export const readPageScript = (limits = READ_LIMITS) => `(${readPage})(${JSON.stringify(limits)})`

export const READ_PAGE_SCRIPT = readPageScript()
