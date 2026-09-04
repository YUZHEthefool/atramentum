/**
 * 划词问答的上下文截取。
 * 给定选区所在 DOM 与选中文本，产出「选区 + 所在节标题 + 前后段落截取」的上下文包。
 */

export interface AskContext {
  /** 用户划选的原文 */
  selection: string
  /** 选区所在小节标题（最近的前辈 heading），可能为空 */
  sectionTitle: string
  /** 选区前 ~400 字符的段落文本截取 */
  before: string
  /** 选区后 ~400 字符的段落文本截取 */
  after: string
}

const WINDOW = 400

function textContent(el: Element | null): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

/** 找选区所在容器的最近 heading 标题 */
function nearestHeading(node: Node | null, root: HTMLElement): string {
  let cur: Node | null = node
  while (cur && cur !== root) {
    if (cur instanceof HTMLElement && /^H[1-6]$/.test(cur.tagName)) {
      return textContent(cur)
    }
    if (cur instanceof HTMLElement) {
      const prev = cur.previousElementSibling
      // 向前找同级 heading
      let p: Element | null = prev
      while (p) {
        if (/^H[1-6]$/.test(p.tagName)) return textContent(p)
        p = p.previousElementSibling
      }
    }
    cur = cur.parentNode
  }
  return ''
}

function blockTextBefore(root: HTMLElement, node: Node | null): string {
  const blocks = Array.from(root.querySelectorAll('p, li, pre, table, h1, h2, h3, h4'))
  let acc = ''
  for (const b of blocks) {
    if (node && (b === node || b.contains(node))) break
    acc += ' ' + textContent(b)
    if (acc.length >= WINDOW * 2) break
  }
  return acc.slice(-WINDOW).trim()
}

function blockTextAfter(root: HTMLElement, node: Node | null): string {
  const blocks = Array.from(root.querySelectorAll('p, li, pre, table, h1, h2, h3, h4'))
  let started = !node
  let acc = ''
  for (const b of blocks) {
    if (!started) {
      if (node && (b === node || b.contains(node))) started = true
      continue
    }
    acc += ' ' + textContent(b)
    if (acc.length >= WINDOW * 2) break
  }
  return acc.slice(0, WINDOW).trim()
}

/** 从阅读视图容器里提取划词上下文；selection 为选区原文 */
export function extractAskContext(root: HTMLElement, selection: string): AskContext {
  const sel = window.getSelection()
  let anchor: Node | null = null
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0)
    anchor = range.startContainer
    // 若容器外（比如面板内划词），退化为 root 起点
    if (!root.contains(anchor)) anchor = null
  }
  return {
    selection,
    sectionTitle: nearestHeading(anchor, root),
    before: blockTextBefore(root, anchor),
    after: blockTextAfter(root, anchor),
  }
}
