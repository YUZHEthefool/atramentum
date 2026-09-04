import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
import { resolveRelative } from '../course/structure'

// 仅注册课件常用语言子集，控制 bundle 体积
const LANGS = [
  'c', 'cpp', 'rust', 'python', 'javascript', 'typescript', 'java', 'go',
  'bash', 'shell', 'makefile', 'json', 'toml', 'yaml', 'ini', 'x86asm', 'nasm',
  'armasm', 'sql', 'diff', 'markdown', 'plaintext', 'cmake', 'perl', 'lua',
]
// 动态注册到全局 hljs 实例；语言缺失则静默跳过
void Promise.all(
  LANGS.map((lang) =>
    import(`highlight.js/lib/languages/${lang}`)
      .then((m) => hljs.registerLanguage(lang, m.default))
      .catch(() => undefined),
  ),
)

export interface RenderOptions {
  /** 当前文件课程内路径，用于解析相对链接 */
  filePath: string
  /** 把课程内 md 路径转为跳转回调（返回 null 表示拦截） */
  onLink?: (coursePath: string, el: HTMLAnchorElement) => void
  /** 渲染完 HTML 后的 DOM 后处理钩子（如 heading id） */
  postProcess?: (root: HTMLElement) => void
}

const md = new MarkdownIt({
  html: false, // 课件不可信，一律禁用内联 HTML，走 DOMPurify 之外再上一道保险
  linkify: false,
  typographer: false,
  breaks: false,
})

/**
 * fence 规则：
 * - 有语言标注 → highlight.js（未知语言退化为纯 code）
 * - 无语言标注 → ASCII 图：`<pre class="ascii">`，等宽不折行、不染色
 */
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]
  const info = (token.info || '').trim().split(/\s+/)[0].toLowerCase()
  const content = md.utils.escapeHtml(token.content)

  if (!info) {
    return `<pre class="ascii"><code>${content}</code></pre>\n`
  }
  if (info === 'text' || info === 'plain' || info === 'txt') {
    return `<pre class="ascii"><code>${content}</code></pre>\n`
  }
  const lang = hljs.getLanguage(info) ? info : ''
  if (lang) {
    try {
      const result = hljs.highlight(token.content, { language: lang, ignoreIllegals: true })
      return `<pre class="code"><code class="hljs language-${lang}">${result.value}</code></pre>\n`
    } catch {
      /* fallthrough */
    }
  }
  return `<pre class="code"><code class="hljs">${content}</code></pre>\n`
}

// 表格包一层横向滚动容器
md.renderer.rules.table_open = () => '<div class="table-wrap"><table>\n'
md.renderer.rules.table_close = () => '</table></div>\n'

/** 渲染 markdown → 净化后的 HTML 字符串，并处理后处理（链接改写在 DOM 层做） */
export function renderMarkdown(text: string): string {
  const raw = md.render(text)
  // html:false 已拦截大部分注入；块级 HTML 会被转义，无需额外白名单
  return raw
}

/** 把渲染结果挂到 DOM 并做链接改写 / 外链加固 / 钩子处理，返回根元素 */
export function mountMarkdown(html: string, opts: RenderOptions): HTMLElement {
  const root = document.createElement('div')
  root.className = 'prose prose-moxue'
  root.innerHTML = html

  // 链接处理
  for (const a of Array.from(root.querySelectorAll('a'))) {
    const href = a.getAttribute('href') ?? ''
    if (!href) continue
    if (/^[a-z]+:\/\//i.test(href)) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noreferrer noopener')
      continue
    }
    if (href.startsWith('#')) continue // 页内锚点
    const resolved = resolveRelative(opts.filePath, href)
    if (resolved) {
      a.setAttribute('href', resolved)
      a.dataset.courseLink = resolved
      opts.onLink?.(resolved, a)
    } else {
      // 越出课程根（如 ../os/…）或非 md：拦截 + 提示样式
      a.classList.add('link-blocked')
      a.addEventListener('click', (e) => {
        e.preventDefault()
        opts.onLink?.('', a)
      })
    }
  }

  // heading 锚点 id（用于目录跳转）
  let h2Index = 0
  for (const h of Array.from(root.querySelectorAll('h1, h2, h3'))) {
    if (!h.id) h.id = `h-${opts.filePath.replace(/[^\w]/g, '-')}-${h2Index++}`
  }

  opts.postProcess?.(root)
  return root
}

/**
 * 渲染并净化（返回字符串版本，供 innerHTML 使用）。
 * 注意：链接改写需要 DOM 操作，因此完整管线走 mountMarkdown；
 * 字符串版只做渲染 + DOMPurify 兜底。
 */
export function renderMarkdownSafe(text: string): string {
  const html = renderMarkdown(text)
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'span', 'a', 'br', 'hr',
      'strong', 'em', 'del', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'img', 'input', 'sup', 'sub', 'kbd', 'mark', 'details', 'summary',
    ],
    ALLOWED_ATTR: [
      'href', 'class', 'id', 'target', 'rel', 'data-course-link',
      'src', 'alt', 'title', 'type', 'checked', 'disabled', 'colspan', 'rowspan',
    ],
  })
}
