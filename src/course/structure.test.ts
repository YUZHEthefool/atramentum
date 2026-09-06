import { describe, expect, it } from 'vitest'
import {
  resolveRelative,
  titleFromMarkdown,
  buildTree,
} from './structure'
import type { CourseMeta } from '../types/course'

function meta(partial: Partial<CourseMeta>): CourseMeta {
  return {
    id: 't',
    title: '测试课件',
    seal: '测',
    desc: '',
    kind: 'dir',
    fileCount: 0,
    source: 'builtin',
    category: '学习',
    format: 'md',
    files: [],
    ...partial,
  }
}

describe('titleFromMarkdown', () => {
  it('提取首个 H1', () => {
    expect(titleFromMarkdown('# 1.1 工具链\n正文')).toBe('1.1 工具链')
  })

  it('取全文第一个 `# ` 行（含围栏内，实现按行首匹配）；无 H1 返回空', () => {
    // 注意：titleFromMarkdown 按行首正则匹配，不感知代码围栏——首个 # 行即标题
    expect(titleFromMarkdown('```md\n# 不是标题\n```\n# 真标题')).toBe('不是标题')
    expect(titleFromMarkdown('没有标题')).toBe('')
  })

  it('剥离标题里的强调记号', () => {
    expect(titleFromMarkdown('# **编译**与`解释`')).toBe('编译与解释')
  })
})

describe('resolveRelative', () => {
  it('同目录相对路径', () => {
    expect(resolveRelative('README.md', '01_intro.md')).toBe('01_intro.md')
    expect(resolveRelative('ch01/README.md', '02_types.md')).toBe('ch01/02_types.md')
  })

  it('../ 回退', () => {
    expect(resolveRelative('ch01/README.md', '../ch02/03.md')).toBe('ch02/03.md')
  })

  it('越出课程根返回 null', () => {
    expect(resolveRelative('README.md', '../other/a.md')).toBeNull()
  })

  it('忽略锚点与查询', () => {
    expect(resolveRelative('README.md', '01.md#section-2')).toBe('01.md')
  })

  it('外链/绝对路径/非文档扩展名返回 null', () => {
    expect(resolveRelative('README.md', 'https://example.com/a.md')).toBeNull()
    expect(resolveRelative('README.md', '/abs/a.md')).toBeNull()
    expect(resolveRelative('README.md', 'img.png')).toBeNull()
  })
})

describe('buildTree', () => {
  it('根 INDEX.md 表格 → 章（目录章含 README 时解析其表格为节）', async () => {
    const files = ['INDEX.md', 'ch01/README.md', 'ch01/01_a.md', 'ch01/02_b.md', 'ch02/README.md']
    const texts: Record<string, string> = {
      'INDEX.md': '| 01 | [第一章](ch01/README.md) |\n| 02 | [第二章](ch02/README.md) |',
      'ch01/README.md': '# 第一章\n| 01 | [小节 A](01_a.md) |\n| 02 | [小节 B](02_b.md) |',
    }
    const tree = await buildTree(meta({ files }), (p) => Promise.resolve(texts[p] ?? null))
    expect(tree.lessons).toHaveLength(2)
    expect(tree.lessons[0].path).toBe('ch01/README.md')
    expect(tree.lessons[0].children?.map((c) => c.path)).toEqual(['ch01/01_a.md', 'ch01/02_b.md'])
    // 第二章 README 无目录表 → 文件名前缀兜底（此处无子文件故无 children）
    expect(tree.lessons[1].children).toBeUndefined()
  })

  it('INDEX 链接直接指节文件 → 平铺课件', async () => {
    const files = ['INDEX.md', '01_x.md', '02_y.md']
    const texts: Record<string, string> = { 'INDEX.md': '| 01 | [X](01_x.md) |\n| 02 | [Y](02_y.md) |' }
    const tree = await buildTree(meta({ files }), (p) => Promise.resolve(texts[p] ?? null))
    expect(tree.lessons.map((l) => l.path)).toEqual(['01_x.md', '02_y.md'])
  })

  it('单文件课件：唯一文档即全部', async () => {
    const tree = await buildTree(meta({ kind: 'single', files: ['main.md'] }), async () => null)
    expect(tree.lessons).toEqual([{ path: 'main.md', title: '测试课件' }])
  })

  it('无 INDEX 回退：多目录按目录成章，顶层文件殿后', async () => {
    const files = ['01_top.md', 'ch01/README.md', 'ch01/a.md', 'ch02/b.md']
    const tree = await buildTree(meta({ files }), async () => null)
    const paths = tree.lessons.map((l) => l.path)
    expect(paths[0]).toBe('ch01/README.md')
    expect(tree.lessons[0].children?.map((c) => c.path)).toEqual(['ch01/a.md'])
    expect(paths[1]).toBe('ch02/b.md')
    expect(paths[paths.length - 1]).toBe('01_top.md')
  })

  it('INDEX 表格行不足 2 行（hasStructure=false）→ 走回退组织', async () => {
    const files = ['INDEX.md', '01_a.md', '02_b.md', '03_c.md']
    const texts: Record<string, string> = { 'INDEX.md': '| 01 | [A](01_a.md) |' } // 仅 1 行
    const tree = await buildTree(meta({ files }), (p) => Promise.resolve(texts[p] ?? null))
    expect(tree.lessons.map((l) => l.path)).toEqual(['01_a.md', '02_b.md', '03_c.md'])
  })
})
