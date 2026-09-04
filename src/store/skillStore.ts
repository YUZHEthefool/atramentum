/**
 * 写作风格 skill：从现有课件提炼出的可复用风格规范（含样例节），
 * AI 著书时选用注入 prompt，使产出贴合既有课件的文风与骨架。存 localStorage。
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export interface WritingSkill {
  id: string
  name: string
  /** 风格规范（Markdown；注入生成 prompt） */
  styleGuide: string
  /** 样例节全文（供模仿文风） */
  sample: string
  /** 提炼来源（课件标题，用于展示） */
  from: string
  createdAt: number
}

interface SkillState {
  skills: WritingSkill[]
  add: (s: { name: string; styleGuide: string; sample: string; from: string }) => WritingSkill
  remove: (id: string) => void
}

export const useSkillStore = create<SkillState>()(
  persist(
    (set) => ({
      skills: [],
      add: ({ name, styleGuide, sample, from }) => {
        const skill: WritingSkill = {
          id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          name: name.trim() || '未命名 skill',
          styleGuide,
          sample,
          from,
          createdAt: Date.now(),
        }
        set((s) => ({ skills: [...s.skills, skill] }))
        return skill
      },
      remove: (id) => set((s) => ({ skills: s.skills.filter((k) => k.id !== id) })),
    }),
    {
      name: 'moxue-skills',
      storage: createJSONStorage(() => localStorage),
    },
  ),
)
