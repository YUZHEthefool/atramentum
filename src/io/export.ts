// 课件导出：枚举全部文件 → fflate zip → 浏览器下载 {title}.zip
import { strToU8, zipSync } from 'fflate'
import type { CourseMeta } from '../types/course'
import { storeFor } from '../course'

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Safari 需等点击完成后再回收
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function exportCourseZip(meta: CourseMeta): Promise<number> {
  const store = storeFor(meta.source)
  const files: Record<string, Uint8Array> = {}
  let missing = 0
  for (const path of meta.files) {
    const text = await store.readFile(meta.id, path)
    if (text === null) {
      missing++
      continue
    }
    files[path] = strToU8(text)
  }
  if (Object.keys(files).length === 0) throw new Error('课件内没有可导出的文件')
  const blob = new Blob([zipSync(files)], { type: 'application/zip' })
  const safeName = meta.title.replace(/[\\/:*?"<>|]/g, '_') || 'course'
  downloadBlob(blob, `${safeName}.zip`)
  return missing
}
