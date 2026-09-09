/**
 * Dexie-backed CourseStore：imported / generated 共用（meta 里已带 source）。
 * 同时提供入库 / 删除 / 配额预检，供 io 与生成流水线调用。
 */
import Dexie, { type Table } from 'dexie'
import type { CourseMeta, CourseTree } from '../types/course'
import { buildTree } from './structure'
import type { CourseStore } from './CourseStore'

/* ───────── 数据库 ───────── */

export interface StoredCourse extends CourseMeta {
  createdAt: number
  /** 课时规划骨架（AI 著书产物；续写时恢复完整规划用，不进阅读目录树） */
  plan?: StoredPlan
}

/** 课时规划骨架：标题 + 要点 + 原始需求，随课程记录持久化 */
export interface StoredPlan {
  topic: string
  requirements?: string
  lessons: { title: string; points: string[] }[]
}

export interface StoredFile {
  courseId: string
  path: string
  text: string
}

class MoxueDB extends Dexie {
  courses!: Table<StoredCourse, string>
  files!: Table<StoredFile, [string, string]>

  constructor() {
    super('moxue')
    this.version(1).stores({
      courses: 'id, source, createdAt',
      files: '[courseId+path], courseId',
    })
  }
}

export const db = new MoxueDB()

/* ───────── CourseStore 实现（imported / generated 共用） ───────── */

const treeCache = new Map<string, Promise<CourseTree | null>>()

/** 课件更新/删除后失效其目录树缓存 */
export function invalidateTree(id: string): void {
  treeCache.delete(id)
}

/** 读取时补齐新字段默认值（旧数据迁移） */
function withDefaults(meta: CourseMeta): CourseMeta {
  return { ...meta, category: meta.category || '学习', format: meta.format || 'md' }
}

function makeDbStore(source: CourseMeta['source']): CourseStore {
  return {
    async list() {
      // imported/generated 共用一张表，必须按 source 过滤——否则每门课在书架出现两份
      const all = await db.courses.where('source').equals(source).toArray()
      // createdAt 是存储层字段，不进 CourseMeta
      return all.map(({ createdAt: _createdAt, ...meta }) => withDefaults(meta))
    },

    loadTree(id) {
      treeCache.get(id) ??
        treeCache.set(
          id,
          (async () => {
            const meta = await db.courses.get(id)
            if (!meta) return null
            const { createdAt: _createdAt, ...pure } = meta
            return buildTree(withDefaults(pure), (p) => db.files.get([id, p]).then((f) => f?.text ?? null))
          })(),
        )
      treeCache.get(id)!.catch(() => treeCache.delete(id))
      return treeCache.get(id)!
    },

    async readFile(courseId, path) {
      const f = await db.files.get([courseId, path])
      return f?.text ?? null
    },
  }
}

export const importedStore: CourseStore = makeDbStore('imported')
export const generatedStore: CourseStore = makeDbStore('generated')

/* ───────── 写入 / 删除 / 配额 ───────── */

function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 写入前预检配额（约 95% 阈值），不足直接抛错 */
export async function assertQuota(neededBytes: number): Promise<void> {
  if (!navigator.storage?.estimate) return
  const { usage = 0, quota = Number.POSITIVE_INFINITY } = await navigator.storage.estimate()
  if (usage + neededBytes > quota * 0.95) {
    throw new Error(`浏览器存储空间不足：需约 ${fmtSize(neededBytes)}，可用约 ${fmtSize(Math.max(0, quota - usage))}`)
  }
}

/** 整课入库（覆盖同 id 旧文件）；files 为已归一化的 posix 相对路径；plan 为可选的课时规划骨架 */
export async function saveCourse(
  meta: CourseMeta,
  files: { path: string; text: string }[],
  createdAt = Date.now(),
  plan?: StoredPlan,
): Promise<void> {
  await assertQuota(files.reduce((n, f) => n + f.text.length * 2, 0) /* UTF-16 粗估 */)
  await db.transaction('rw', db.courses, db.files, async () => {
    await db.courses.put({ ...meta, createdAt, plan })
    await db.files.where('courseId').equals(meta.id).delete()
    await db.files.bulkPut(files.map((f) => ({ courseId: meta.id, path: f.path, text: f.text })))
  })
  invalidateTree(meta.id)
}

/** 单独写回课时规划骨架（不影响文件与目录树；首次入库走 ingestCourse 后补写） */
export async function saveCoursePlan(courseId: string, plan: StoredPlan): Promise<void> {
  await db.courses.update(courseId, { plan })
}

/** 读取课时规划骨架（仅 imported/generated 存于课程记录；无则返回 undefined） */
export async function loadCoursePlan(courseId: string): Promise<StoredPlan | undefined> {
  const rec = await db.courses.get(courseId)
  return rec?.plan
}

export async function deleteCourse(id: string): Promise<void> {
  await db.transaction('rw', db.courses, db.files, async () => {
    await db.courses.delete(id)
    await db.files.where('courseId').equals(id).delete()
  })
  invalidateTree(id)
}

/** 重命名课件（仅本地来源；同步更新印章字） */
export async function renameCourse(id: string, title: string): Promise<void> {
  const name = title.trim()
  if (!name) throw new Error('标题不能为空')
  await db.courses.update(id, { title: name, seal: [...name][0] || '课' })
  invalidateTree(id)
}

/** 更新单文件内容（AI 改写应用） */
export async function updateCourseFile(courseId: string, path: string, text: string): Promise<void> {
  await db.files.put({ courseId, path, text })
  invalidateTree(courseId)
}
