// 最小 POSIX/ustar 解包（fflate 无 tar 支持；只需读我们自己的课件包）
// 支持 GNU 'L' 长文件名；pax 扩展头跳过（本课件集路径较短，未用到）
export interface TarEntry {
  name: string
  data: Uint8Array
}

export function untarSync(buf: Uint8Array): TarEntry[] {
  const out: TarEntry[] = []
  const dec = new TextDecoder()
  let off = 0
  let longName: string | null = null
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    // 512 全零块 = 结束
    if (header.every((b) => b === 0)) break
    const name = dec.decode(header.subarray(0, 100)).replace(/\0.*$/, '')
    const size = parseInt(dec.decode(header.subarray(124, 136)).replace(/\0/g, '').trim() || '0', 8) || 0
    const type = header[156]
    off += 512
    const data = buf.subarray(off, off + size)
    off += Math.ceil(size / 512) * 512
    if (type === 0x4c) {
      // 'L' GNU 长文件名：data 即下一条目的名字
      longName = dec.decode(data).replace(/\0.*$/, '')
      continue
    }
    if (type === 0 || type === 0x30) {
      // '\0' 或 '0'：常规文件（目录 '5' / 链接等跳过）
      out.push({ name: longName ?? name, data })
    }
    longName = null
  }
  return out
}
