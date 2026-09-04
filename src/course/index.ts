import type { CourseMeta } from '../types/course'
import { builtinStore } from './builtinStore'
import { importedStore, generatedStore, updateCourseFile } from './dbStore'
import { ingestCourse } from '../io/import'
import type { CourseStore } from './CourseStore'

// 各来源 store 注册表；Dexie 版（imported/generated）共用实现
const stores: Partial<Record<CourseMeta['source'], CourseStore>> = {
  builtin: builtinStore,
  imported: importedStore,
  generated: generatedStore,
}

export function registerStore(source: CourseMeta['source'], store: CourseStore): void {
  stores[source] = store
}

export function storeFor(source: CourseMeta['source']): CourseStore {
  return stores[source] ?? builtinStore
}

/** 全部来源课件汇总（书架用）；某来源不可用时跳过而非整体失败 */
export async function listAllCourses(): Promise<CourseMeta[]> {
  const out: CourseMeta[] = []
  for (const s of ['builtin', 'imported', 'generated'] as const) {
    const store = stores[s]
    if (!store) continue
    try {
      for (const m of await store.list()) out.push({ ...m, source: s })
    } catch {
      // 该来源读取失败（如 IndexedDB 被禁）不影响其它来源
    }
  }
  return out
}

export async function findCourseMeta(id: string): Promise<CourseMeta | undefined> {
  return (await listAllCourses()).find((m) => m.id === id)
}

/** 把课件复制为可编辑的本地副本（内置课件只读，AI 改写前先 fork），返回新 meta */
export async function forkCourseForEdit(meta: CourseMeta): Promise<CourseMeta> {
  const store = storeFor(meta.source)
  const files: { path: string; text: string }[] = []
  for (const path of meta.files) {
    const text = await store.readFile(meta.id, path)
    if (text !== null) files.push({ path, text })
  }
  const { meta: forked } = await ingestCourse(files, {
    source: 'imported',
    title: `${meta.title}（副本）`,
    desc: meta.desc,
    category: meta.category,
    format: meta.format,
  })
  return forked
}

/** AI 改写后的内容写回课件（仅本地可编辑来源；内置请先 forkCourseForEdit） */
export async function applyCourseEdit(meta: CourseMeta, path: string, text: string): Promise<void> {
  if (meta.source === 'builtin') throw new Error('内置课件只读，请先另存为副本')
  await updateCourseFile(meta.id, path, text)
}

export type { CourseStore } from './CourseStore'
