import type { CourseMeta, CourseTree } from '../types/course'
import type { CourseStore } from './CourseStore'
import { buildTree } from './structure'

// HashRouter 下相对路径会基于 #/… 解析，必须显式拼 base
const BASE = import.meta.env.BASE_URL // './' 或 '/'
const MANIFEST_URL = `${BASE}courses/manifest.json`

interface Manifest {
  version: number
  courses: (CourseMeta & { source?: string })[]
}

const treeCache = new Map<string, Promise<CourseTree | null>>()
let manifestPromise: Promise<CourseMeta[]> | null = null

async function fetchManifest(): Promise<CourseMeta[]> {
  const res = await fetch(MANIFEST_URL)
  if (!res.ok) throw new Error(`manifest.json 加载失败 (${res.status})`)
  const data = (await res.json()) as Manifest
  // 课件内路径统一 posix 分隔符（旧版 bundle 脚本在 Windows 上产出过反斜杠清单）
  return data.courses.map((c) => ({
    ...c,
    files: c.files.map((f) => f.replace(/\\/g, '/')),
    category: c.category ?? '学习',
    format: c.format ?? 'md',
    source: 'builtin' as const,
  }))
}

async function fetchText(courseId: string, path: string): Promise<string | null> {
  const url = `${BASE}courses/${courseId}/${path}`
    .split('/')
    .map((seg, i) => (i < 2 ? seg : encodeURIComponent(seg)))
    .join('/')
  const res = await fetch(url)
  if (!res.ok) return null
  return res.text()
}

/** 内置课件：随站静态资源 */
export const builtinStore: CourseStore = {
  async list() {
    manifestPromise ??= fetchManifest()
    return manifestPromise
  },

  loadTree(id: string) {
    treeCache.get(id) ?? treeCache.set(id, (async () => {
      const metas = await this.list()
      const meta = metas.find((m) => m.id === id)
      if (!meta) return null
      return buildTree(meta, (p) => fetchText(id, p))
    })())
    // 构树失败（网络抖动等）不缓存rejected promise，下次可重试
    treeCache.get(id)!.catch(() => treeCache.delete(id))
    return treeCache.get(id)!
  },

  async readFile(courseId: string, path: string) {
    return fetchText(courseId, path)
  },
}
