// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { NewCourseDialog } from './NewCourseDialog'
import { useGenerateStore } from './generateStore'

// 渲染冒烟：点「续写」后对话框应正常出面板，而不是整树崩溃（线上曾报空白页）
describe('NewCourseDialog 续写冒烟', () => {
  it('continueCourse 打开 → 组件可渲染且不抛错', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    useGenerateStore.getState().openGenerate({
      continueCourse: {
        id: 't-book',
        title: '测试书',
        seal: '测',
        desc: 'AI 生成 · 2 课时',
        kind: 'dir',
        fileCount: 3,
        files: ['INDEX.md', 'lesson01.md'],
        category: '学习',
        format: 'md',
        source: 'generated',
      },
    })
    let caught: unknown = null
    await act(async () => {
      try {
        root.render(<NewCourseDialog />)
      } catch (e) {
        caught = e
      }
    })
    // 续写初始化读 Dexie（测试环境无库）→ 异步失败路径走「续写初始化失败」回 form 页；
    // 只要渲染本身不崩即可（线上空白页 = 渲染期抛错带崩整树）
    expect(caught).toBeNull()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    useGenerateStore.getState().close()
    await act(async () => {
      root.unmount()
    })
  })
})
