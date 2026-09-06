import { describe, expect, it } from 'vitest'
import {
  buildIndexMd,
  lessonFile,
  parseIndexEntries,
  parsePlan,
  planText,
  stripFenceWrap,
} from './pipeline'

describe('parsePlan', () => {
  it('标准 lessons JSON', () => {
    const lessons = parsePlan('{"lessons":[{"title":"第1讲 A","points":["a","b"]},{"title":"第2讲 B","points":[]}]}')
    expect(lessons).toHaveLength(2)
    expect(lessons[0]).toEqual({ title: '第1讲 A', points: ['a', 'b'] })
  })

  it('兼容 chapters 字段名与裸数组', () => {
    expect(parsePlan('{"chapters":[{"title":"X","points":[]}]}')).toHaveLength(1)
    expect(parsePlan('[{"title":"Y","points":[]}]')).toHaveLength(1)
    // 围栏包裹 + 前后噪声也能抽出
    expect(parsePlan('好的，规划如下：```json\n{"lessons":[{"title":"Z","points":[]}]}\n```')).toHaveLength(1)
  })

  it('兼容 name/outline 别名字段；跳过无标题条目', () => {
    const lessons = parsePlan('{"lessons":[{"name":"甲","outline":["x"]},{"points":["无标题"]},{"title":"乙"}]}')
    expect(lessons).toEqual([
      { title: '甲', points: ['x'] },
      { title: '乙', points: [] },
    ])
  })

  it('非法 JSON / 缺 lessons 字段 / 空规划 → 报错', () => {
    expect(() => parsePlan('完全不是 JSON')).toThrow(/解析失败/)
    expect(() => parsePlan('{"foo":1}')).toThrow(/缺少 lessons/)
    expect(() => parsePlan('{"lessons":[]}')).toThrow(/为空/)
  })
})

describe('buildIndexMd / parseIndexEntries 往返', () => {
  it('生成的目录表可被 parseIndexEntries 反解', () => {
    const lessons = [
      { title: '引言', points: [] },
      { title: '进阶', points: ['p1'] },
    ]
    const md = buildIndexMd('测试主题', lessons)
    expect(md).toContain('# 测试主题 · 课时总览')
    const entries = parseIndexEntries(md)
    expect(entries).toEqual([
      { title: '引言', file: 'lesson01.md' },
      { title: '进阶', file: 'lesson02.md' },
    ])
  })
})

describe('lessonFile', () => {
  it('两位数字补零', () => {
    expect(lessonFile(0)).toBe('lesson01.md')
    expect(lessonFile(8)).toBe('lesson09.md')
    expect(lessonFile(99)).toBe('lesson100.md')
  })
})

describe('planText', () => {
  it('要点拼接为纯文本一览', () => {
    const text = planText([
      { title: '一', points: ['a', 'b'] },
      { title: '二', points: [] },
    ])
    expect(text).toBe('01. 一\n  要点：a；b\n02. 二')
  })
})

describe('stripFenceWrap', () => {
  it('剥掉整篇围栏包裹', () => {
    expect(stripFenceWrap('```markdown\n# 标题\n正文\n```')).toBe('# 标题\n正文')
    expect(stripFenceWrap('```\n内容\n```')).toBe('内容')
  })

  it('闭合围栏前无需换行也能剥掉；非围栏文本原样（trim）', () => {
    expect(stripFenceWrap('```c\nint main;```')).toBe('int main;')
    expect(stripFenceWrap('  普通文本  ')).toBe('普通文本')
  })
})
