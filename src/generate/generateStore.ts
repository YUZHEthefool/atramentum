/**
 * AI 著书对话框的全局承载：生成是长任务，对话框必须挂在路由之外，
 * 否则用户跳去别的页面会把组件（连同正在生成的流）一起卸载。
 *
 * open/visible 分离：open = 有任务在跑（生成中不可关），visible = 面板是否展开。
 * 最小化后生成继续，回到书架/阅读器仍可实时预览已写完的课时。
 */
import { create } from 'zustand'
import type { CourseMeta } from '../types/course'

interface GenerateState {
  /** 对话框是否打开（有活动任务或新著书意图） */
  open: boolean
  /** 面板展开与否；最小化 = false，生成继续 */
  visible: boolean
  /** 续写 / 整书改写目标（含 rewrite 标记） */
  continueCourse: CourseMeta | null
  rewrite: boolean
  /** 每次打开新著书表单时递增，驱动组件重置 */
  nonce: number
  openGenerate: (opts?: { continueCourse?: CourseMeta | null; rewrite?: boolean }) => void
  minimize: () => void
  restore: () => void
  /** 生成结束（完成/取消/失败回规划页）后由组件调用：关闭整个对话框 */
  close: () => void
}

export const useGenerateStore = create<GenerateState>()((set) => ({
  open: false,
  visible: false,
  continueCourse: null,
  rewrite: false,
  nonce: 0,
  openGenerate: (opts) =>
    set((s) => ({
      open: true,
      visible: true,
      continueCourse: opts?.continueCourse ?? null,
      rewrite: !!opts?.rewrite,
      nonce: s.nonce + 1,
    })),
  minimize: () => set({ visible: false }),
  restore: () => set({ visible: true }),
  close: () => set({ open: false, visible: false, continueCourse: null, rewrite: false }),
}))

/** 生成入库事件：书架刷新、Reader 续写后重载都订阅它 */
type CreatedListener = (meta: CourseMeta) => void
const createdListeners = new Set<CreatedListener>()

export function emitCourseCreated(meta: CourseMeta): void {
  for (const l of createdListeners) l(meta)
}

export function onCourseCreated(listener: CreatedListener): () => void {
  createdListeners.add(listener)
  return () => createdListeners.delete(listener)
}
