import { describe, expect, it } from 'vitest'
import { normalizeEntries, fromZip, stripCommonRoot } from './import'
import { strToU8, zipSync } from 'fflate'
import type { RawEntry } from './import'

function raw(path: string, data = 'x'): RawEntry {
  return { path, data: new TextEncoder().encode(data) }
}

describe('fromZip', () => {
  it('解包 zip；目录条目跳过、路径归一为 posix', () => {
    const zip = zipSync({
      'course/README.md': strToU8('# 课'),
      'course/01_a.md': strToU8('正文'),
      'course/sub/': new Uint8Array(0),
    })
    const entries = fromZip(zip)
    expect(entries.map((e) => e.path)).toEqual(['course/README.md', 'course/01_a.md'])
  })
})

describe('normalizeEntries', () => {
  it('剔除垃圾路径（.git/.DS_Store/._前缀/.gitignore 等）', () => {
    const out = normalizeEntries([
      raw('a.md'),
      raw('.git/config'),
      raw('.DS_Store'),
      raw('._ junk.md'),
      raw('sub/.gitignore'),
      raw('__pycache__/x.pyc'),
    ])
    expect(out.map((o) => o.path)).toEqual(['a.md'])
  })

  it('只留白名单扩展名（md/代码/配置/Makefile）；图片等被剔除', () => {
    const out = normalizeEntries([
      raw('a.md'),
      raw('main.c'),
      raw('Cargo.toml'),
      raw('Makefile'),
      raw('img.png'),
      raw('video.mp4'),
      raw('no_ext_file'),
    ])
    expect(out.map((o) => o.path)).toEqual(['a.md', 'main.c', 'Cargo.toml', 'Makefile'])
  })

  it('超过 2MB 的文件被剔除', () => {
    const big = raw('big.md', 'x'.repeat(2 * 1024 * 1024 + 1))
    const small = raw('ok.md')
    const out = normalizeEntries([big, small])
    expect(out.map((o) => o.path)).toEqual(['ok.md'])
  })

  it('共享同一无扩展名根时剥掉；根有扩展名或根不唯一则保留', () => {
    // 全部共享 course/ 根 → 剥掉
    const stripped = normalizeEntries([raw('course/README.md'), raw('course/sub/a.md')])
    expect(stripped.map((o) => o.path)).toEqual(['README.md', 'sub/a.md'])
    // 根带扩展名 → 保留
    const kept = normalizeEntries([raw('my.md'), raw('b.md')])
    expect(kept.map((o) => o.path)).toEqual(['my.md', 'b.md'])
  })

  it('UTF-8 解码（UTF-8 内容）', () => {
    const out = normalizeEntries([raw('a.md', '# 墨痕')])
    expect(out[0].text).toBe('# 墨痕')
  })
})

describe('stripCommonRoot', () => {
  it('边界：空条目 / 单条目也剥根 / 根不唯一', () => {
    expect(stripCommonRoot([])).toEqual([])
    // 单条目且带无扩展名根：也剥（与整课压缩包形态一致）
    const single = [raw('a/b.md')]
    expect(stripCommonRoot(single).map((e) => e.path)).toEqual(['b.md'])
    // 根不唯一：保留
    const mixed = [raw('a/b.md'), raw('c/d.md')]
    expect(stripCommonRoot(mixed).map((e) => e.path)).toEqual(['a/b.md', 'c/d.md'])
  })
})
