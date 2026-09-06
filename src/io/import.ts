/**
 * 导入管线：任意来源（zip / tar.gz / rar / 文件夹拖拽）→ 归一化 RawEntry[] →
 * 过滤清洗 → 解码文本 → 整课写入 Dexie（source: imported）。
 * 白名单与 scripts/bundle-courses.mjs 保持一致（纯文本扩展名）。
 */
import { gunzipSync, unzipSync } from 'fflate'
import type { CourseFormat, CourseMeta } from '../types/course'
import { saveCourse } from '../course/dbStore'
import { untarSync, type TarEntry } from './tar'
import { epubToChapters } from './epub'
import { pdfToPages } from './pdf'

export interface RawEntry {
  /** posix 相对路径 */
  path: string
  data: Uint8Array
}

// 与 bundle 脚本同款白名单；全部按 UTF-8 文本解码入库
const INCLUDE_EXT = new Set([
  '.md', '.txt', '.c', '.h', '.cpp', '.hpp', '.rs', '.toml', '.json',
  '.yaml', '.yml', '.csv', '.cfg', '.sh', '.py', '.S', '.asm', '.mk',
  '.html', '.htm',
])
const EXCLUDE_PARTS = new Set(['.git', '.claude', 'target', '__pycache__', '__MACOSX'])
const MAX_FILE = 2 * 1024 * 1024

/* ───────── 各来源 → RawEntry[] ───────── */

export function fromZip(u8: Uint8Array): RawEntry[] {
  const files = unzipSync(u8)
  return Object.entries(files)
    .filter(([path]) => !path.endsWith('/')) // 目录条目跳过
    .map(([path, data]) => ({ path: path.replace(/\\/g, '/'), data }))
}

export function fromTarGz(u8: Uint8Array): RawEntry[] {
  const entries: TarEntry[] = untarSync(gunzipSync(u8))
  return entries.map((e) => ({ path: e.name.replace(/\\/g, '/'), data: e.data }))
}

/** RAR（v4/v5）/7z 等：libarchive.js 动态加载，worker + wasm 来自 public/libarchive/ */
export async function fromRar(file: File): Promise<RawEntry[]> {
  let Archive: (typeof import('libarchive.js'))['Archive']
  try {
    ;({ Archive } = await import('libarchive.js'))
  } catch {
    throw new Error('rar 解析组件加载失败，请重试，或将压缩包解压后拖入文件夹 / 改用 zip。')
  }
  Archive.init({ workerUrl: `${import.meta.env.BASE_URL}libarchive/worker-bundle.js` })
  let archive: Awaited<ReturnType<typeof Archive.open>>
  try {
    archive = await Archive.open(file)
    if ((await archive.hasEncryptedData()) === true) {
      throw new Error('该压缩包已加密，请先解密后再导入。')
    }
  } catch (e) {
    const text = (e as Error)?.message ?? String(e)
    throw new Error(/加密/.test(text) ? text : `rar 解析失败：${text.slice(0, 120)}。可改用 zip 或拖入已解压的文件夹。`)
  }
  const tree = await archive.extractFiles()
  const out: RawEntry[] = []
  const walk = async (node: Record<string, unknown>, prefix: string): Promise<void> => {
    for (const [name, value] of Object.entries(node)) {
      if (value instanceof File) {
        out.push({ path: prefix + name, data: new Uint8Array(await value.arrayBuffer()) })
      } else if (value && typeof value === 'object') {
        await walk(value as Record<string, unknown>, `${prefix}${name}/`)
      }
    }
  }
  await walk(tree, '')
  return out
}

/** 文件夹拖拽 / 多选文件 → RawEntry[]（用 webkitRelativePath / entry 树还原目录结构） */
export async function fromFiles(items: File[] | DataTransferItemList): Promise<RawEntry[]> {
  const out: RawEntry[] = []
  const readFile = async (f: File, path: string) => {
    out.push({ path, data: new Uint8Array(await f.arrayBuffer()) })
  }

  if (items instanceof DataTransferItemList) {
    const entries: FileSystemEntry[] = []
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry()
      if (entry) entries.push(entry)
    }
    const walkEntry = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
      if (entry.isFile) {
        const file = await new Promise<File | null>((res) =>
          (entry as FileSystemFileEntry).file((f) => res(f), () => res(null)),
        )
        if (file) await readFile(file, prefix + file.name)
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader()
        for (;;) {
          // readEntries 每次最多返回 100 条，需循环取尽
          const batch = await new Promise<FileSystemEntry[]>((res) =>
            reader.readEntries((es) => res(es), () => res([])),
          )
          if (batch.length === 0) break
          for (const e of batch) await walkEntry(e, `${prefix}${entry.name}/`)
        }
      }
    }
    for (const e of entries) await walkEntry(e, '')
    return out
  }

  for (const f of items) {
    await readFile(f, f.webkitRelativePath || f.name)
  }
  return out
}

/* ───────── 归一化 + 清洗 ───────── */

function isJunk(path: string): boolean {
  const parts = path.split('/')
  return (
    parts.some((p) => EXCLUDE_PARTS.has(p) || p === '.DS_Store' || p.startsWith('._')) ||
    parts[parts.length - 1] === '.gitignore'
  )
}

function allowedExt(path: string): boolean {
  const base = path.split('/').pop() ?? ''
  if (!base.includes('.')) return base === 'Makefile'
  const ext = `.${(base.split('.').pop() ?? '').toLowerCase()}`
  return INCLUDE_EXT.has(ext)
}

/** 若全部条目共享同一个「文件夹根」（无扩展名），剥掉它——压缩整门课的包常见此形态 */
export function stripCommonRoot(entries: RawEntry[]): RawEntry[] {
  if (entries.length === 0) return entries
  const first = entries[0].path.split('/')[0]
  if (!first || first.includes('.')) return entries
  const allShare = entries.every((e) => e.path.startsWith(`${first}/`))
  return allShare ? entries.map((e) => ({ ...e, path: e.path.slice(first.length + 1) })) : entries
}

/** 清洗：去垃圾/越白名单/超大文件，转文本 */
export function normalizeEntries(entries: RawEntry[]): { path: string; text: string }[] {
  const cleaned = stripCommonRoot(
    entries.filter((e) => e.path && !isJunk(e.path) && allowedExt(e.path) && e.data.length <= MAX_FILE),
  )
  const dec = new TextDecoder('utf-8', { fatal: false })
  return cleaned.map((e) => ({ path: e.path, text: dec.decode(e.data) }))
}

/* ───────── 入库 ───────── */

export interface IngestResult {
  meta: CourseMeta
  fileCount: number
}

/** 由文件构成推断格式：仅 html → epub；仅 txt → pdf；否则 md */
function detectFormat(files: { path: string }[]): CourseFormat {
  const has = (re: RegExp) => files.some((f) => re.test(f.path))
  if (has(/\.(html?)$/i) && !has(/\.md$/i)) return 'epub'
  if (has(/\.txt$/i) && !has(/\.(md|html?)$/i)) return 'pdf'
  return 'md'
}

/** 归一化后的文件集整课入库（imported / generated 通用） */
export async function ingestCourse(
  files: { path: string; text: string }[],
  opts: {
    source: 'imported' | 'generated'
    title?: string
    desc?: string
    category?: string
    format?: CourseFormat
  },
): Promise<IngestResult> {
  if (files.length === 0) throw new Error('没有可用的课件文件（仅支持文本类文件，单个不超过 2MB）')
  const id = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const docCount = files.filter((f) => /\.(md|html?|txt)$/i.test(f.path)).length
  const title = (opts.title ?? '').trim() || '未命名课件'
  const meta: CourseMeta = {
    id,
    title,
    seal: [...title][0] || '课',
    desc: opts.desc ?? '',
    kind: docCount > 1 ? 'dir' : 'single',
    fileCount: files.length,
    files: files.map((f) => f.path),
    category: opts.category?.trim() || '学习',
    format: opts.format ?? detectFormat(files),
    source: opts.source,
  }
  await saveCourse(meta, files)
  return { meta, fileCount: files.length }
}

/* ───────── 书籍入库（EPUB / PDF） ───────── */

function bookIndexMd(title: string, rows: { title: string; href: string }[]): string {
  return [
    `# ${title}`,
    '',
    '| # | 章节 |',
    '|---|------|',
    ...rows.map((r, i) => `| ${String(i + 1).padStart(2, '0')} | [${r.title}](${r.href}) |`),
    '',
  ].join('\n')
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** EPUB → 章节化书籍入库 */
export async function ingestBookFromEpub(file: File, category: string): Promise<IngestResult> {
  const { title, chapters } = await epubToChapters(file)
  const files = [
    {
      path: 'INDEX.md',
      text: bookIndexMd(title, chapters.map((c, i) => ({ title: c.title, href: `epub/${pad2(i + 1)}.html` }))),
    },
    ...chapters.map((c, i) => ({ path: `epub/${pad2(i + 1)}.html`, text: c.html })),
  ]
  return ingestCourse(files, {
    source: 'imported',
    title,
    desc: `EPUB · ${chapters.length} 章`,
    category,
    format: 'epub',
  })
}

/** PDF → 逐页文本书籍入库 */
export async function ingestBookFromPdf(file: File, category: string): Promise<IngestResult> {
  const { pages } = await pdfToPages(file)
  const title = file.name.replace(/\.pdf$/i, '') || '未命名 PDF'
  const files = [
    {
      path: 'INDEX.md',
      text: bookIndexMd(
        title,
        pages.map((_, i) => ({ title: `第 ${i + 1} 页`, href: `pdf/p${pad2(i + 1)}.txt` })),
      ),
    },
    ...pages.map((t, i) => ({ path: `pdf/p${pad2(i + 1)}.txt`, text: t })),
  ]
  return ingestCourse(files, {
    source: 'imported',
    title,
    desc: `PDF · ${pages.length} 页`,
    category,
    format: 'pdf',
  })
}
