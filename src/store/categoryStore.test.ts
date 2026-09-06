import { beforeEach, describe, expect, it } from 'vitest'
import { UNCATEGORIZED, groupCourses } from './categoryStore'
import type { CourseMeta } from '../types/course'

// persist 中间件在 jsdom/localStorage 下直接工作；这里清掉存储保证用例独立
beforeEach(() => {
  localStorage.clear()
})

function course(id: string): CourseMeta {
  return {
    id,
    title: id,
    seal: '课',
    desc: '',
    kind: 'dir',
    fileCount: 1,
    source: 'imported',
    category: '学习',
    format: 'md',
    files: ['a.md'],
  }
}

describe('groupCourses', () => {
  it('按用户分类顺序分组；未分类殿后且非空才显示', () => {
    const a = course('a')
    const b = course('b')
    const c = course('c')
    const groups = groupCourses([a, b, c], { a: '课本', b: '学习' }, ['学习', '课本'])
    expect(groups.map((g) => g.name)).toEqual(['学习', '课本', UNCATEGORIZED])
    expect(groups[0].items).toEqual([b])
    expect(groups[1].items).toEqual([a])
    expect(groups[2].items).toEqual([c])
  })

  it('空分类也展示（便于拖入）；归属的分类已删除 → 回未分类', () => {
    const a = course('a')
    const groups = groupCourses([a], { a: '被删的分类' }, ['空组'])
    expect(groups.map((g) => g.name)).toEqual(['空组', UNCATEGORIZED])
  })

  it('全部归类且无空组时不显示未分类', () => {
    const a = course('a')
    const groups = groupCourses([a], { a: '学习' }, ['学习'])
    expect(groups.map((g) => g.name)).toEqual(['学习'])
  })
})
