// 导入对话框：压缩包（zip / tar.gz / rar）、文件夹拖拽、PDF / EPUB 书籍 → 按分类入库
import { useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import {
  fromFiles,
  fromRar,
  fromTarGz,
  fromZip,
  ingestBookFromEpub,
  ingestBookFromPdf,
  ingestCourse,
  normalizeEntries,
} from '../io/import'
import type { RawEntry } from '../io/import'
import { UNCATEGORIZED, useCategoryStore } from '../store/categoryStore'
import { Overlay } from './common/Overlay'

const inputCls =
  'w-full border border-ink/20 bg-paper px-2.5 py-1.5 text-sm text-ink outline-none transition focus:border-cinnabar'

type IngestFn = () => Promise<{ meta: { id: string } }>

export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [dragOver, setDragOver] = useState(false)
  // '' = 未分类；选项来自用户自建分类
  const [category, setCategory] = useState('')
  const categories = useCategoryStore((s) => s.order)
  const assignTo = useCategoryStore((s) => s.assignTo)
  const zipInputRef = useRef<HTMLInputElement>(null)
  const dirInputRef = useRef<HTMLInputElement>(null)

  const run = async (ingest: IngestFn) => {
    setBusy(true)
    setMsg('')
    try {
      const { meta } = await ingest()
      if (category) assignTo(meta.id, category)
      onImported()
      onClose()
    } catch (e) {
      setMsg((e as Error)?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  /** 单文件：按扩展名分流（压缩包 / EPUB / PDF） */
  const ingestArchiveOrBook = (file: File): IngestFn => {
    if (/\.epub$/i.test(file.name)) return () => ingestBookFromEpub(file, category)
    if (/\.pdf$/i.test(file.name)) return () => ingestBookFromPdf(file, category)
    return async () => {
      const data = new Uint8Array(await file.arrayBuffer())
      const raw: RawEntry[] = /\.rar$/i.test(file.name)
        ? await fromRar(file)
        : /\.zip$/i.test(file.name)
          ? fromZip(data)
          : fromTarGz(data)
      return ingestCourse(normalizeEntries(raw), {
        source: 'imported',
        desc: `导入课件 · ${raw.length} 个文件`,
        category,
      })
    }
  }

  const onDrop = (e: ReactDragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (busy) return
    const items = e.dataTransfer.items
    // 拖入单个 epub/pdf 文件直接走书籍分流；文件夹/多文件走归一化管线
    if (items.length === 1 && items[0].kind === 'file') {
      const f = items[0].getAsFile()
      if (f && /\.(epub|pdf)$/i.test(f.name)) {
        void run(ingestArchiveOrBook(f))
        return
      }
    }
    void run(async () => {
      const raw = await fromFiles(items)
      return ingestCourse(normalizeEntries(raw), {
        source: 'imported',
        desc: `导入课件 · ${raw.length} 个文件`,
        category,
      })
    })
  }

  return (
    <Overlay onClose={onClose}>
      <div
        className={dragOver ? 'bg-paper-deep' : undefined}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div className="flex items-center justify-between border-b border-ink/15 px-5 py-3">
          <h2 className="font-song text-base font-bold tracking-wide">导入</h2>
          <button className="text-ink-faint transition hover:text-cinnabar" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div>
            <label className="mb-1 block text-sm font-semibold">归入分类（可稍后在书架拖拽调整）</label>
            <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{UNCATEGORIZED}</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div
            className={`border border-dashed px-6 py-8 text-center transition ${
              dragOver ? 'border-cinnabar bg-cinnabar/5' : 'border-ink/30'
            }`}
          >
            <p className="font-song text-lg font-bold text-ink">拖入文件到此</p>
            <p className="mt-2 text-xs leading-6 text-ink-faint">
              课件：整门课的压缩包（zip / tar.gz / rar）或课件文件夹。
              <br />
              书籍：PDF / EPUB（自动按章节分页，纯阅读，不带划词问 AI）。
            </p>
            <div className="mt-4 flex items-center justify-center gap-3">
              <button
                className="bg-cinnabar px-4 py-1.5 text-sm text-paper transition hover:bg-cinnabar-deep disabled:opacity-50"
                onClick={() => zipInputRef.current?.click()}
                disabled={busy}
              >
                选择文件
              </button>
              <button
                className="border border-ink/25 px-4 py-1.5 text-sm text-ink-soft transition hover:border-cinnabar/50 hover:text-cinnabar-deep disabled:opacity-50"
                onClick={() => dirInputRef.current?.click()}
                disabled={busy}
              >
                选择文件夹
              </button>
            </div>
          </div>

          {busy && <p className="text-sm text-ink-soft">解析入库中……</p>}
          {msg && <p className="border border-cinnabar/40 bg-cinnabar/5 px-3 py-2 text-sm leading-6 text-cinnabar-deep">{msg}</p>}

          <p className="text-xs leading-5 text-ink-faint">
            课件仅导入文本类文件（md / 代码 / 配置），单个不超过 2MB；书籍抽取文本后入库（不含图片）。
            全部保存在浏览器本地（IndexedDB），不会自动上传。
          </p>
        </div>

        <input
          ref={zipInputRef}
          type="file"
          className="hidden"
          accept=".zip,.rar,.tar.gz,.tgz,.pdf,.epub"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            if (files.length === 0) return
            const file = files[0]
            if (!/\.(zip|rar|tar\.gz|tgz|pdf|epub)$/i.test(file.name)) {
              setMsg('请选择 zip / tar.gz / rar 压缩包或 PDF / EPUB 书籍，课件文件夹请用「选择文件夹」。')
              return
            }
            void run(ingestArchiveOrBook(file))
          }}
        />
        <input
          ref={dirInputRef}
          type="file"
          className="hidden"
          multiple
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            if (files.length === 0) return
            void run(async () => {
              const raw = await fromFiles(files)
              return ingestCourse(normalizeEntries(raw), {
                source: 'imported',
                desc: `导入课件 · ${raw.length} 个文件`,
                category,
              })
            })
          }}
        />
      </div>
    </Overlay>
  )
}
