// 书架：全部分类分组陈列；分类由用户自建/删除，卡片可拖拽归档（带封面式拖影）
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import { Link } from 'react-router-dom'
import { listAllCourses } from '../course'
import { deleteCourse, renameCourse } from '../course/dbStore'
import type { CourseMeta } from '../types/course'
import { COURSE_DND_MIME, UNCATEGORIZED, groupCourses, useCategoryStore } from '../store/categoryStore'
import { SettingsDialog } from './SettingsDialog'
import { ImportDialog } from './ImportDialog'
import { NewCourseDialog } from '../generate/NewCourseDialog'

const SOURCE_LABEL: Record<CourseMeta['source'], string> = {
  builtin: '内置',
  imported: '导入',
  generated: 'AI 著书',
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

/** 拖影：书籍封面式预览（印章 + 书名），替代浏览器默认的 URL 拖影 */
function ghostHTML(meta: CourseMeta): string {
  const isBook = meta.format !== 'md'
  const seal = isBook ? '书' : meta.seal || '课'
  const coverBg = isBook ? '#2b2a26' : '#c03f2b'
  return `
    <div style="width:136px;font-family:'Noto Serif SC','Noto Sans SC',serif;box-shadow:0 10px 28px rgba(43,42,38,.35)">
      <div style="background:${coverBg};color:#f5f1e8;height:92px;display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:700">${escapeHtml(seal)}</div>
      <div style="background:#f5f1e8;border:1px solid rgba(43,42,38,.25);border-top:none;padding:8px 10px">
        <div style="font-weight:700;font-size:12px;color:#2b2a26;line-height:1.45;max-height:36px;overflow:hidden">${escapeHtml(meta.title)}</div>
        <div style="margin-top:4px;font-size:10px;color:#8a8578;font-family:'Noto Sans SC',sans-serif">${isBook ? '纯阅读' : `${meta.fileCount} 篇`}</div>
      </div>
    </div>`
}

function CourseCard({
  meta,
  categorized,
  onDelete,
  onMoveOut,
  onRename,
}: {
  meta: CourseMeta
  categorized: boolean
  onDelete: () => void
  onMoveOut: () => void
  onRename: (title: string) => Promise<void>
}) {
  const ghostRef = useRef<HTMLDivElement>(null)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(meta.title)
  const removable = meta.source !== 'builtin'
  const isBook = meta.format !== 'md'

  const commitRename = async () => {
    const name = draft.trim()
    setRenaming(false)
    if (!name || name === meta.title) return
    await onRename(name)
  }

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(COURSE_DND_MIME, meta.id)
        e.dataTransfer.effectAllowed = 'move'
        // 同步填充拖影并设为拖动预览（元素须已挂载，故常驻藏于屏外）
        const ghost = ghostRef.current
        if (ghost) {
          ghost.innerHTML = ghostHTML(meta)
          e.dataTransfer.setDragImage(ghost, 68, 76)
        }
      }}
      onDragEnd={() => {
        if (ghostRef.current) ghostRef.current.innerHTML = ''
      }}
      className="group relative flex flex-col border border-ink/15 bg-paper-deep/40 p-5 shadow-paper transition
        hover:-translate-y-0.5 hover:border-cinnabar/50 hover:bg-paper-deep"
    >
      <div ref={ghostRef} aria-hidden style={{ position: 'fixed', top: -9999, left: -9999, pointerEvents: 'none' }} />
      {renaming ? (
        <div className="mb-3 space-y-2">
          <input
            autoFocus
            className="w-full border border-cinnabar/50 bg-paper px-2.5 py-1.5 text-sm text-ink outline-none"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename()
              if (e.key === 'Escape') {
                setDraft(meta.title)
                setRenaming(false)
              }
            }}
            aria-label="新标题"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              className="border border-ink/25 px-2.5 py-1 text-xs text-ink-soft transition hover:border-cinnabar/50"
              onClick={() => {
                setDraft(meta.title)
                setRenaming(false)
              }}
            >
              取消
            </button>
            <button
              className="bg-cinnabar px-2.5 py-1 text-xs text-paper transition hover:bg-cinnabar-deep disabled:opacity-40"
              onClick={() => void commitRename()}
              disabled={!draft.trim()}
            >
              保存
            </button>
          </div>
        </div>
      ) : (
        <>
          {removable && (
            <div className="absolute right-2 top-2 hidden items-center gap-1 group-hover:flex">
              <button
                className="flex h-6 w-6 items-center justify-center border border-ink/20 bg-paper text-xs text-ink-faint transition hover:border-cinnabar hover:text-cinnabar"
                onClick={(e) => {
                  e.preventDefault()
                  setDraft(meta.title)
                  setRenaming(true)
                }}
                aria-label="重命名"
                title="重命名"
              >
                ✎
              </button>
              <button
                className="flex h-6 w-6 items-center justify-center border border-ink/20 bg-paper text-xs text-ink-faint transition hover:border-cinnabar hover:text-cinnabar"
                onClick={(e) => {
                  e.preventDefault()
                  if (window.confirm(`删除「${meta.title}」？该操作不可恢复。`)) onDelete()
                }}
                aria-label="删除"
                title="删除"
              >
                ✕
              </button>
            </div>
          )}
        </>
      )}
      {categorized && (
        <button
          className="absolute left-2 top-2 hidden h-6 items-center justify-center border border-ink/20 px-1.5 text-[11px] text-ink-faint transition hover:border-cinnabar hover:text-cinnabar group-hover:flex"
          onClick={(e) => {
            e.preventDefault()
            onMoveOut()
          }}
          aria-label="移出分类"
          title="移出分类"
        >
          移出
        </button>
      )}
      <Link to={`/c/${meta.id}`} draggable={false} className="flex flex-1 flex-col">
        <div className="flex items-start gap-4">
          <span
            className={`h-10 w-10 shrink-0 text-center font-song text-lg font-bold leading-10 text-paper shadow-seal ${
              isBook ? 'bg-ink' : 'bg-cinnabar'
            }`}
          >
            {isBook ? '书' : meta.seal || '课'}
          </span>
          <div className="min-w-0">
            <h2 className="font-song text-lg font-bold leading-snug tracking-wide text-ink group-hover:text-cinnabar-deep">
              {meta.title}
            </h2>
            <p className="mt-1 text-xs text-ink-faint">{meta.desc}</p>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-ink/10 pt-3 text-xs text-ink-faint">
          <span className="border border-ink/20 px-1.5 py-0.5 tracking-widest">{SOURCE_LABEL[meta.source]}</span>
          <span>{isBook ? '纯阅读' : `${meta.fileCount} 篇`}</span>
        </div>
      </Link>
    </div>
  )
}

export default function Bookshelf() {
  const [courses, setCourses] = useState<CourseMeta[] | null>(null)
  const [error, setError] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showGenerate, setShowGenerate] = useState(false)

  const order = useCategoryStore((s) => s.order)
  const assign = useCategoryStore((s) => s.assign)
  const addCategory = useCategoryStore((s) => s.addCategory)
  const removeCategory = useCategoryStore((s) => s.removeCategory)
  const assignTo = useCategoryStore((s) => s.assignTo)

  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const refresh = useCallback(() => {
    listAllCourses()
      .then((list) => setCourses(list))
      .catch((e) => setError((e as Error).message))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const groups = useMemo(() => groupCourses(courses ?? [], assign, order), [courses, assign, order])

  const commitNewCategory = () => {
    if (newName.trim()) addCategory(newName)
    setNewName('')
    setCreating(false)
  }

  const onDropTo = (e: ReactDragEvent, name: string) => {
    e.preventDefault()
    setDropTarget(null)
    const id = e.dataTransfer.getData(COURSE_DND_MIME)
    if (id) assignTo(id, name === UNCATEGORIZED ? '' : name)
  }

  const dropProps = (name: string) => ({
    onDragOver: (e: ReactDragEvent) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropTarget(name)
    },
    onDragLeave: () => setDropTarget((cur) => (cur === name ? null : cur)),
    onDrop: (e: ReactDragEvent) => onDropTo(e, name),
  })

  return (
    <main className="min-h-screen bg-paper px-6 py-14 text-ink">
      <div className="mx-auto max-w-5xl">
        <header className="flex items-end justify-between gap-6 border-b border-ink/15 pb-8">
          <div>
            <p className="text-xs tracking-[0.35em] text-ink-faint">MO XUE · AI 陪学</p>
            <h1 className="mt-3 font-song text-5xl font-bold tracking-[0.2em] text-ink">墨痕</h1>
            <p className="mt-4 max-w-xl text-sm leading-7 text-ink-soft">
              阅读课件与书籍，划词问 AI，仿写生成。分类自建，拖放归档。
            </p>
          </div>
          <div className="flex items-center gap-4">
            <button
              className="border border-ink/20 px-3 py-1.5 text-xs tracking-widest text-ink-soft transition hover:border-cinnabar/50 hover:text-cinnabar-deep"
              onClick={() => setShowGenerate(true)}
            >
              AI 著书
            </button>
            <button
              className="border border-ink/20 px-3 py-1.5 text-xs tracking-widest text-ink-soft transition hover:border-cinnabar/50 hover:text-cinnabar-deep"
              onClick={() => setShowImport(true)}
            >
              导入
            </button>
            <button
              className="border border-ink/20 px-3 py-1.5 text-xs tracking-widest text-ink-soft transition hover:border-cinnabar/50 hover:text-cinnabar-deep"
              onClick={() => setShowSettings(true)}
            >
              设 置
            </button>
            <div className="h-12 w-12 shrink-0 bg-cinnabar text-center font-song text-2xl font-bold leading-[3rem] text-paper shadow-seal">
              墨
            </div>
          </div>
        </header>

        {error && (
          <p className="mt-10 border border-cinnabar/40 bg-cinnabar/5 px-4 py-3 text-sm text-cinnabar-deep">
            内容清单加载失败：{error}
          </p>
        )}
        {!error && courses === null && <p className="mt-10 text-sm text-ink-faint">书卷整理中……</p>}

        {courses !== null && courses.length === 0 && !error && (
          <p className="mt-10 text-sm text-ink-faint">书架空空：先导入课件 / 书籍，或让 AI 著一部新书。</p>
        )}

        {courses !== null && courses.length > 0 && (
          <>
            {groups.map(({ name, items }) => (
              <section
                key={name}
                className={`mt-10 border border-transparent p-3 -m-3 transition ${
                  dropTarget === name ? 'border-cinnabar/60 bg-cinnabar/5' : ''
                }`}
                {...dropProps(name)}
              >
                <h2 className="flex items-baseline gap-3 border-b border-ink/10 pb-2 font-song text-sm font-bold tracking-[0.3em] text-ink-soft">
                  {name}
                  <span className="text-xs font-normal tracking-normal text-ink-faint">{items.length}</span>
                  {name !== UNCATEGORIZED && (
                    <button
                      className="ml-auto text-xs font-normal tracking-normal text-ink-faint/70 transition hover:text-cinnabar"
                      onClick={() => {
                        if (window.confirm(`删除分类「${name}」？其中 ${items.length} 个内容将回到「未分类」。`)) {
                          removeCategory(name)
                        }
                      }}
                    >
                      删除分类
                    </button>
                  )}
                </h2>
                {items.length > 0 ? (
                  <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                    {items.map((c) => (
                      <CourseCard
                        key={`${c.source}-${c.id}`}
                        meta={c}
                        categorized={!!assign[c.id]}
                        onDelete={() => {
                          void deleteCourse(c.id).then(refresh)
                        }}
                        onMoveOut={() => assignTo(c.id, '')}
                        onRename={async (title) => {
                          await renameCourse(c.id, title)
                          refresh()
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="mt-5 border border-dashed border-ink/25 px-6 py-6 text-center text-xs text-ink-faint">
                    把课件 / 书籍拖到这里
                  </div>
                )}
              </section>
            ))}

            {/* 新建分类 */}
            <div className="mt-8">
              {creating ? (
                <input
                  autoFocus
                  className="w-full border border-dashed border-cinnabar/50 bg-paper px-4 py-2.5 text-sm text-ink outline-none"
                  placeholder="分类名称（如：学习 / 课本 / 小说），Enter 确认，Esc 取消"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitNewCategory()
                    if (e.key === 'Escape') {
                      setNewName('')
                      setCreating(false)
                    }
                  }}
                  onBlur={commitNewCategory}
                />
              ) : (
                <button
                  className="w-full border border-dashed border-ink/30 px-4 py-2.5 text-sm text-ink-faint transition hover:border-cinnabar/50 hover:text-cinnabar-deep"
                  onClick={() => setCreating(true)}
                >
                  ＋ 新建分类
                </button>
              )}
            </div>
          </>
        )}

        <footer className="mt-16 border-t border-ink/10 pt-6 text-xs text-ink-faint">
          墨痕 · 纯静态部署于 Cloudflare Pages · AI 密钥仅存本机
        </footer>
      </div>

      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showImport && <ImportDialog onClose={() => setShowImport(false)} onImported={refresh} />}
      {showGenerate && <NewCourseDialog onClose={() => setShowGenerate(false)} onCreated={refresh} />}
    </main>
  )
}
