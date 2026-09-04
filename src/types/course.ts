// 课件相关类型：来源、元信息、目录树
export type CourseSource = 'builtin' | 'imported' | 'generated'
export type CourseKind = 'dir' | 'single'
/** 内容格式：md 课件（带 AI 能力）；epub/pdf 书籍（纯阅读，不做划词） */
export type CourseFormat = 'md' | 'epub' | 'pdf'

export interface CourseMeta {
  id: string
  title: string
  seal: string
  desc: string
  kind: CourseKind
  fileCount: number
  source: CourseSource
  /** 书架分类（学习 / 课本 / 小说 / 自定义…） */
  category: string
  /** 内容格式（默认 md） */
  format: CourseFormat
  /** 课程内全部文件相对路径（builtin 来自 manifest；导入/生成来自入库清单） */
  files: string[]
}

/** 仅 md 课件可用的 AI 能力开关；书籍类一律 false */
export function aiEnabled(meta: Pick<CourseMeta, 'format'>): boolean {
  return (meta.format ?? 'md') === 'md'
}

export interface LessonNode {
  /** 课程内相对路径 */
  path: string
  title: string
  /** 章内小节（仅目录型课件的章节有） */
  children?: LessonNode[]
}

export interface CourseTree {
  meta: CourseMeta
  /** 顶层节点：章（目录型）/ 课（平铺型）/ 唯一文件（单文件型） */
  lessons: LessonNode[]
}
