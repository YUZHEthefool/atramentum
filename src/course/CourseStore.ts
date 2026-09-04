import type { CourseMeta, CourseTree } from '../types/course'

/**
 * CourseStore 抽象：统一 imported / generated 两种来源的课件访问。
 * 两者均由 Dexie 实现同接口。
 */
export interface CourseStore {
  /** 列出该来源全部课件（轻量，仅元信息） */
  list(): Promise<CourseMeta[]>
  /** 读课件树（含结构；实现方可缓存） */
  loadTree(id: string): Promise<CourseTree | null>
  /** 读单个文件文本 */
  readFile(courseId: string, path: string): Promise<string | null>
}
