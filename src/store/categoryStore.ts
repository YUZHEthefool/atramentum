/**
 * 分类（用户自管）：分类清单与「课件/书籍 → 分类」归属关系，存 localStorage。
 * 分类完全由用户创建/删除；未归入任何分类的内容落在「未分类」组。
 * 拖拽归档时更新 assign；删除分类时其成员自动回到「未分类」。
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { CourseMeta } from '../types/course'

export const UNCATEGORIZED = '未分类'
/** 书架拖拽 dataTransfer 类型 */
export const COURSE_DND_MIME = 'application/x-moxue-course'

export interface CategoryGroup {
  name: string
  items: CourseMeta[]
}

interface CategoryState {
  /** 用户创建的分类（有序；可为空组） */
  order: string[]
  /** courseId → 分类名；未出现的即「未分类」 */
  assign: Record<string, string>
  /** 新建分类；重名/空名/与「未分类」冲突返回 false */
  addCategory: (name: string) => boolean
  /** 删除分类（成员回到「未分类」） */
  removeCategory: (name: string) => void
  /** 归档：传 '' 表示移出分类 */
  assignTo: (courseId: string, category: string) => void
}

export const useCategoryStore = create<CategoryState>()(
  persist(
    (set) => ({
      order: [],
      assign: {},
      addCategory: (name) => {
        const v = name.trim().slice(0, 20)
        if (!v || v === UNCATEGORIZED) return false
        let ok = false
        set((s) => {
          if (s.order.includes(v)) return s
          ok = true
          return { order: [...s.order, v] }
        })
        return ok
      },
      removeCategory: (name) =>
        set((s) => {
          const assign: Record<string, string> = { ...s.assign }
          for (const [id, cat] of Object.entries(assign)) {
            if (cat === name) delete assign[id]
          }
          return { order: s.order.filter((n) => n !== name), assign }
        }),
      assignTo: (courseId, category) =>
        set((s) => {
          const assign: Record<string, string> = { ...s.assign }
          if (!category) delete assign[courseId]
          else assign[courseId] = category
          return { assign }
        }),
    }),
    {
      name: 'moxue-categories',
      storage: createJSONStorage(() => localStorage),
    },
  ),
)

/** 分组：用户分类按其排序（空组也展示，便于拖入），未分类殿后（非空才展示） */
export function groupCourses(
  courses: CourseMeta[],
  assign: Record<string, string>,
  order: string[],
): CategoryGroup[] {
  const groups: CategoryGroup[] = order
    .filter((n) => n && n !== UNCATEGORIZED)
    .map((name) => ({ name, items: [] }))
  const byName = new Map(groups.map((g) => [g.name, g]))
  const uncat: CategoryGroup = { name: UNCATEGORIZED, items: [] }
  for (const c of courses) {
    const cat = assign[c.id]
    const target = cat ? byName.get(cat) : undefined
    if (target) target.items.push(c)
    else uncat.items.push(c) // 未归档 / 归属的分类已被删除
  }
  return uncat.items.length > 0 ? [...groups, uncat] : groups
}
