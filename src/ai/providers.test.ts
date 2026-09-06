import { describe, expect, it } from 'vitest'
import { extractJSON } from './providers'

describe('extractJSON', () => {
  it('剥离 ```json 围栏', () => {
    expect(extractJSON('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(extractJSON('```\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('截取首尾花括号之间（兼容前后缀噪声）', () => {
    expect(extractJSON('好的：{"a":1} 请查收')).toBe('{"a":1}')
  })

  it('对象数组缺少包装时返回原样 trim 文本', () => {
    expect(extractJSON('  纯文本  ')).toBe('纯文本')
  })
})
