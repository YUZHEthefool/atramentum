import type { CourseMeta, CourseTree, LessonNode } from '../types/course'

// 数字前缀：01_xxx.md / 00_foundations/README.md
const NUM_PREFIX = /^(\d+)[_\-]?(.*)$/

// 可作为「正文」的文档扩展名：md 课件 + epub 章节导出的 html + pdf 逐页文本
const DOC_EXT = /\.(md|html?|txt)$/i

function stripExt(p: string): string {
  return p.replace(DOC_EXT, '')
}

/** 数字前缀排序比较器（无前缀的排后面，按字典序） */
function pathCompare(a: string, b: string): number {
  const na = NUM_PREFIX.exec(stripExt(a).split('/').pop() ?? '')
  const nb = NUM_PREFIX.exec(stripExt(b).split('/').pop() ?? '')
  if (na && nb) {
    if (na[1] !== nb[1]) return Number(na[1]) - Number(nb[1])
    const ta = na[2] || a
    const tb = nb[2] || b
    return ta < tb ? -1 : ta > tb ? 1 : 0
  }
  if (na) return -1
  if (nb) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** 从 markdown 文本提取首个 H1 作为标题 */
export function titleFromMarkdown(text: string): string {
  const m = /^#\s+(.+)$/m.exec(text)
  if (m) return m[1].trim().replace(/[*`_]/g, '')
  return ''
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

/** 文件名 → 可读标题：01_what_is_os.md → 01 · What is os；纯数字页/章文件 → 第 N 节 */
function titleFromFile(path: string, text?: string): string {
  if (text) {
    const t = titleFromMarkdown(text)
    if (t && t !== '未命名') return t
  }
  const base = stripExt(basename(path))
  if (/^\d+$/.test(base)) return `第 ${parseInt(base, 10)} 节`
  const m = NUM_PREFIX.exec(base)
  if (m) return `${m[1]} · ${m[2].replace(/[_-]/g, ' ').trim() || base}`
  return base.replace(/[_-]/g, ' ')
}

// INDEX.md 表格行：| 01 | [标题](路径.md/.html/.txt) | ... 可能有更多列
const TABLE_ROW = /^\s*\|\s*`?(\d+)`?\s*\|\s*\[([^\]]+)\]\(([^)]+\.(?:md|html?|txt))\)/i

interface ParsedTable {
  rows: { num: string; title: string; link: string }[]
  hasStructure: boolean
}

/** 解析 markdown 文本里的表格行链接（INDEX.md / 章节 README 的目录表） */
function parseIndexTable(text: string): ParsedTable {
  const rows: ParsedTable['rows'] = []
  for (const line of text.split(/\r?\n/)) {
    const m = TABLE_ROW.exec(line)
    if (m) rows.push({ num: m[1], title: m[2].trim(), link: m[3].trim() })
  }
  return { rows, hasStructure: rows.length >= 2 }
}

/**
 * 构建课件目录树。
 * 优先级：
 * 1. 根 INDEX.md 表格 → 章；若章是目录且含 README，再解析 README 的表格 → 节
 * 2. 回退：manifest 文件清单按数字前缀排序组织
 * 变体兼容：平铺（INDEX 链接直接是 01_xxx.md）；单文件（唯一 md）
 */
export function buildTree(meta: CourseMeta, readFile: (path: string) => Promise<string | null>): Promise<CourseTree> {
  return buildTreeSync(meta, (p) => readFile(p))
}

async function buildTreeSync(
  meta: CourseMeta,
  readFile: (path: string) => Promise<string | null>,
): Promise<CourseTree> {
  const mdFiles = meta.files.filter((f) => f.toLowerCase().endsWith('.md'))
  const docFiles = meta.files.filter((f) => DOC_EXT.test(f))

  // 单文件课件：唯一文档就是全部
  if (meta.kind === 'single' || docFiles.length === 1) {
    const path = docFiles[0] ?? ''
    return { meta, lessons: [{ path, title: meta.title }] }
  }

  // 1) 尝试根 INDEX.md
  const indexKey = mdFiles.find((f) => f === 'INDEX.md' || f === 'index.md' || f.endsWith('/INDEX.md'))
  if (indexKey) {
    const indexText = await readFile(indexKey)
    if (indexText) {
      const { rows, hasStructure } = parseIndexTable(indexText)
      if (hasStructure) {
        const lessons: LessonNode[] = []
        for (const row of rows) {
          const target = resolveRelative(indexKey, row.link)
          if (!target || !meta.files.includes(target)) continue
          const node = await chapterNode(meta, readFile, target, row.title)
          lessons.push(node)
        }
        if (lessons.length >= 2) return { meta, lessons }
      }
    }
  }

  // 2) 回退：目录/文件名数字前缀组织
  return fallbackTree(meta, docFiles)
}

/** 章 → 目录（解析 README 表格为节）或直接 lesson（平铺 md） */
async function chapterNode(
  meta: CourseMeta,
  readFile: (path: string) => Promise<string | null>,
  target: string,
  fallbackTitle: string,
): Promise<LessonNode> {
  const dir = dirname(target)
  if (dir && basename(target).toLowerCase() === 'readme.md') {
    // 目录章：README 为主课，表格链接为节
    const readmeText = await readFile(target)
    let children: LessonNode[] = []
    if (readmeText) {
      const { rows, hasStructure } = parseIndexTable(readmeText)
      if (hasStructure) {
        for (const row of rows) {
          const sub = resolveRelative(target, row.link)
          if (!sub || !meta.files.includes(sub) || sub === target) continue
          children.push({ path: sub, title: row.title })
        }
      }
      if (children.length === 0) {
        // 表格缺失：目录内数字前缀 md 兜底（README 除外）
        const prefix = dir + '/'
        children = meta.files
          .filter((f) => f.startsWith(prefix) && f.toLowerCase().endsWith('.md') && basename(f).toLowerCase() !== 'readme.md')
          .sort(pathCompare)
          .map((f) => ({ path: f, title: titleFromFile(f) }))
      }
    }
    const title = (readmeText ? titleFromMarkdown(readmeText) : '') || fallbackTitle
    return { path: target, title, children: children.length ? children : undefined }
  }
  // 平铺课件：INDEX 直接链到节文件
  return { path: target, title: fallbackTitle }
}

/** 回退组织：顶层文档按数字前缀；若多文件同目录则该目录 README 为章 */
function fallbackTree(meta: CourseMeta, docFiles: string[]): CourseTree {
  const sorted = [...docFiles].sort(pathCompare)
  const lessons: LessonNode[] = []

  // 目录型：每章目录取 README（或首个 md）为章，其余 md 为节
  const byDir = new Map<string, string[]>()
  for (const f of sorted) {
    const dir = dirname(f)
    if (!dir) continue
    const list = byDir.get(dir) ?? []
    list.push(f)
    byDir.set(dir, list)
  }

  if (byDir.size > 1) {
    const topFiles: string[] = []
    const dirs: string[] = []
    for (const f of sorted) {
      const dir = dirname(f)
      if (!dir) topFiles.push(f)
      else if (!dirs.includes(dir)) dirs.push(dir)
    }
    for (const dir of dirs.sort(pathCompare)) {
      const list = byDir.get(dir)!
      const readme = list.find((f) => basename(f).toLowerCase() === 'readme.md')
      const head = readme ?? list[0]
      lessons.push({
        path: head,
        title: titleFromFile(head),
        children: list.filter((f) => f !== head).map((f) => ({ path: f, title: titleFromFile(f) })),
      })
    }
    for (const f of topFiles) {
      if (f.toLowerCase() === 'index.md') continue
      lessons.push({ path: f, title: titleFromFile(f) })
    }
    return { meta, lessons }
  }

  // 平铺型：顶层 md 直接为课（INDEX.md 单列导航不重复展示）
  for (const f of sorted) {
    if (f.toLowerCase() === 'index.md') continue
    lessons.push({ path: f, title: titleFromFile(f) })
  }
  return { meta, lessons: lessons.length ? lessons : sorted.map((f) => ({ path: f, title: titleFromFile(f) })) }
}

// ---- 路径工具（课件路径恒为 posix 相对路径） ----

function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(0, i) : ''
}

export function resolveRelative(fromFile: string, link: string): string | null {
  // 忽略锚点/查询
  const clean = link.split('#')[0].split('?')[0]
  if (!clean || !DOC_EXT.test(clean)) return null
  if (/^[a-z]+:\/\//i.test(clean)) return null
  if (clean.startsWith('/')) return null
  const fromDir = dirname(fromFile)
  const segments = (fromDir ? fromDir.split('/') : []).concat(clean.split('/'))
  const out: string[] = []
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return null // 越出课程根（如 ../os/…）→ 调用方提示
      out.pop()
    } else {
      out.push(seg)
    }
  }
  return out.join('/')
}
