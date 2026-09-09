// 阅读视图：左目录树 + 中央排印正文 + 右 AI 面板（问答/改写）；md 相对链接转为应用内跳转
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { applyCourseEdit, findCourseMeta, forkCourseForEdit, storeFor } from '../course'
import DOMPurify from 'dompurify'
import { mountMarkdown, renderMarkdown } from '../markdown/renderer'
import { aiEnabled, type CourseMeta, type CourseTree, type LessonNode } from '../types/course'
import { useSelectionProbe } from '../ask/SelectionWatcher'
import { FloatingToolbar } from '../ask/FloatingToolbar'
import { AskPanel } from '../ask/AskPanel'
import type { AskSeed } from '../ask/AskPanel'
import { SettingsDialog } from './SettingsDialog'
import { exportCourseZip } from '../io/export'
import { useCategoryStore } from '../store/categoryStore'
import { onCourseCreated, useGenerateStore } from '../generate/generateStore'
import { GenerateBadge } from './GenerateBadge'

type Phase = 'loading' | 'ready' | 'missing' | 'error'

function flattenLessons(nodes: LessonNode[], out: LessonNode[] = []): LessonNode[] {
  for (const n of nodes) {
    out.push(n)
    if (n.children) flattenLessons(n.children, out)
  }
  return out
}

/** 目录树节点：章（含 children）可折叠；点击章标题进入章 README */
function TocItem({
  node,
  depth,
  currentPath,
  expanded,
  toggle,
  onNavigate,
}: {
  node: LessonNode
  depth: number
  currentPath: string
  expanded: Set<string>
  toggle: (path: string) => void
  onNavigate: (path: string) => void
}) {
  const hasChildren = !!node.children?.length
  const isOpen = expanded.has(node.path)
  const active = currentPath === node.path

  return (
    <div>
      <div className="flex items-center">
        {hasChildren ? (
          <button
            aria-label={isOpen ? '收起' : '展开'}
            className="w-5 shrink-0 text-center text-ink-faint hover:text-cinnabar"
            onClick={() => toggle(node.path)}
          >
            {isOpen ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        <button
          className={`min-w-0 flex-1 truncate py-1 text-left text-[13px] leading-6 transition ${
            active ? 'font-semibold text-cinnabar-deep' : 'text-ink-soft hover:text-ink'
          }`}
          style={{ paddingLeft: depth * 10 }}
          onClick={() => {
            if (hasChildren && !isOpen) toggle(node.path)
            onNavigate(node.path)
          }}
          title={node.title}
        >
          {node.title}
        </button>
      </div>
      {hasChildren && isOpen && (
        <div>
          {node.children!.map((c) => (
            <TocItem
              key={c.path}
              node={c}
              depth={depth + 1}
              currentPath={currentPath}
              expanded={expanded}
              toggle={toggle}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function Reader() {
  const { courseId = '' } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()

  const [meta, setMeta] = useState<CourseMeta | null>(null)
  const [tree, setTree] = useState<CourseTree | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [content, setContent] = useState<string | null>(null)
  const [contentErr, setContentErr] = useState('')

  const currentPath = searchParams.get('path') ?? ''
  const mountRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // 折叠状态：存「已展开」的章路径；默认展开含当前节的那一章
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // AI 面板（仅 md 课件；书籍类不做划词/问答）
  const askAvailable = meta ? aiEnabled(meta) : false
  const [askOpen, setAskOpen] = useState(false)
  const [askSeed, setAskSeed] = useState<AskSeed | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  // 续写 / 整书改写：走全局生成对话框（最小化后生成不中断）
  const openGenerate = useGenerateStore((s) => s.openGenerate)
  const [forking, setForking] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState('')
  const { probe, clearProbe } = useSelectionProbe(mountRef, phase === 'ready' && askAvailable)

  const handleExport = useCallback(async () => {
    if (!meta || exporting) return
    setExporting(true)
    setExportMsg('')
    try {
      const missing = await exportCourseZip(meta)
      setExportMsg(missing > 0 ? `已导出（${missing} 个文件缺失被跳过）` : '')
      setTimeout(() => setExportMsg(''), 4000)
    } catch (e) {
      setExportMsg(`导出失败：${(e as Error).message}`)
    } finally {
      setExporting(false)
    }
  }, [meta, exporting])

  const handleAsk = useCallback(() => {
    if (!probe?.text) return
    setAskSeed((prev) => ({ selection: probe.text, nonce: (prev?.nonce ?? 0) + 1 }))
    setAskOpen(true)
    clearProbe()
  }, [probe, clearProbe])

  /** 整书改写：内置课件先 fork 成可编辑副本，其余来源直接写回原书 */
  const handleRewrite = useCallback(async () => {
    if (!meta || forking) return
    setForking(true)
    try {
      if (meta.source === 'builtin') {
        const forked = await forkCourseForEdit(meta)
        const cat = useCategoryStore.getState().assign[meta.id]
        if (cat) useCategoryStore.getState().assignTo(forked.id, cat)
        openGenerate({ continueCourse: forked, rewrite: true })
      } else {
        openGenerate({ continueCourse: meta, rewrite: true })
      }
    } catch (e) {
      setExportMsg(`整书改写初始化失败：${(e as Error).message}`)
      setTimeout(() => setExportMsg(''), 4000)
    } finally {
      setForking(false)
    }
  }, [meta, forking, openGenerate])

  const getProseRoot = useCallback(() => {
    // mountMarkdown 挂载的 .prose 根是 mountRef 的首子元素
    const first = mountRef.current?.firstElementChild
    return first instanceof HTMLElement ? first : null
  }, [])

  const getSectionText = useCallback(async (): Promise<string | null> => {
    if (!meta || !currentPath) return null
    return storeFor(meta.source).readFile(courseId, currentPath)
  }, [meta, courseId, currentPath])

  /** AI 改写应用：builtin 先 fork 成副本并跳转；本地课件直接写回并刷新正文 */
  const handleApplyEdit = useCallback(
    async (text: string): Promise<string | null> => {
      if (!meta || !currentPath) return '课件尚未加载'
      try {
        let target = meta
        if (meta.source === 'builtin') {
          target = await forkCourseForEdit(meta)
          // 副本继承原分类归属
          const cat = useCategoryStore.getState().assign[meta.id]
          if (cat) useCategoryStore.getState().assignTo(target.id, cat)
          await applyCourseEdit(target, currentPath, text)
          navigate(`/c/${target.id}?path=${encodeURIComponent(currentPath)}`)
          return null
        }
        await applyCourseEdit(target, currentPath, text)
        const fresh = await storeFor(target.source).readFile(courseId, currentPath)
        setContent(fresh ?? text)
        setExportMsg('已应用改写')
        setTimeout(() => setExportMsg(''), 3000)
        return null
      } catch (e) {
        return (e as Error).message
      }
    },
    [meta, courseId, currentPath, navigate],
  )

  // 载入课件元信息与目录树
  useEffect(() => {
    let alive = true
    setPhase('loading')
    setMeta(null)
    setTree(null)
    setContent(null)
    setExpanded(new Set())
    findCourseMeta(courseId)
      .then(async (m) => {
        if (!alive) return
        if (!m) {
          setPhase('missing')
          return
        }
        setMeta(m)
        const t = await storeFor(m.source).loadTree(courseId)
        if (!alive) return
        if (!t) {
          setPhase('missing')
          return
        }
        setTree(t)
        setPhase('ready')
      })
      .catch((e) => {
        if (alive) {
          console.error('[moxue] 载入课件失败', e)
          setPhase('error')
        }
      })
    return () => {
      alive = false
    }
  }, [courseId, reloadNonce])

  // AI 著书写成（含续写/改写写回）→ 若正是当前书，重载目录树与正文
  useEffect(() => onCourseCreated((m) => m.id === courseId && setReloadNonce((n) => n + 1)), [courseId])

  const flat = useMemo(() => (tree ? flattenLessons(tree.lessons) : []), [tree])

  // 无 path 参数或 path 不在树内 → 定位第一节
  useEffect(() => {
    if (phase !== 'ready' || flat.length === 0) return
    if (currentPath && flat.some((l) => l.path === currentPath)) return
    setSearchParams({ path: flat[0].path }, { replace: true })
  }, [phase, flat, currentPath, setSearchParams])

  // 拉取正文
  useEffect(() => {
    if (phase !== 'ready' || !currentPath || !meta) return
    let alive = true
    setContent(null)
    setContentErr('')
    storeFor(meta.source)
      .readFile(courseId, currentPath)
      .then((text) => {
        if (!alive) return
        if (text === null) setContentErr('该课时尚未写出……AI 正在后台撰写，完成后自动显示')
        else setContent(text)
      })
      .catch((e) => alive && setContentErr((e as Error).message))
    return () => {
      alive = false
    }
  }, [phase, courseId, currentPath, meta])

  // AI 著书实时入库：正在后台生成的书，正文可能还没写完——失败时自动轮询重试，
  // 写完的那一刻自动出现（「文到即读」），无需手动刷新
  const [contentRetry, setContentRetry] = useState(0)
  useEffect(() => {
    if (!contentErr) return
    const timer = setTimeout(() => setContentRetry((n) => n + 1), 3000)
    return () => clearTimeout(timer)
  }, [contentErr, contentRetry])
  useEffect(() => {
    if (contentRetry === 0) return
    if (phase !== 'ready' || !currentPath || !meta) return
    let alive = true
    storeFor(meta.source)
      .readFile(courseId, currentPath)
      .then((text) => {
        if (!alive) return
        if (text !== null) {
          setContent(text)
          setContentErr('')
        }
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [contentRetry, phase, courseId, currentPath, meta])

  // 渲染 markdown/书籍内容 → DOM（md 含链接改写、heading id）
  useEffect(() => {
    const host = mountRef.current
    if (!host || content === null || !currentPath) return
    if (/\.html?$/i.test(currentPath)) {
      // EPUB 章节：净化后的 HTML 直接进 prose 排印
      const root = document.createElement('div')
      root.className = 'prose prose-moxue'
      root.innerHTML = DOMPurify.sanitize(content, {
        ALLOWED_TAGS: [
          'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'blockquote', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'u', 's', 'small',
          'code', 'pre', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
          'span', 'div', 'section', 'article', 'figure', 'figcaption', 'sup', 'sub', 'ruby', 'rt', 'rb',
        ],
        ALLOWED_ATTR: ['colspan', 'rowspan'],
      })
      host.replaceChildren(root)
    } else if (/\.txt$/i.test(currentPath)) {
      // PDF 逐页文本：等宽舒展、保留原始换行
      const root = document.createElement('div')
      root.className = 'book-text mx-auto'
      root.textContent = content
      host.replaceChildren(root)
    } else {
      host.replaceChildren(
        mountMarkdown(renderMarkdown(content), {
          filePath: currentPath,
          onLink: (coursePath) => {
            // 越出课程根 / 不可解析链接：renderer 已加 link-blocked 并拦截点击，这里仅提示
            if (!coursePath) console.info('[moxue] 链接越出课程根或不可解析，已拦截')
          },
        }),
      )
    }
    scrollRef.current?.scrollTo({ top: 0 })
  }, [content, currentPath])

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const goTo = useCallback(
    (path: string) => {
      setSearchParams({ path })
    },
    [setSearchParams],
  )

  const onBodyClick = useCallback(
    (e: ReactMouseEvent) => {
      const a = (e.target as HTMLElement).closest('a')
      if (!a) return
      const resolved = a.dataset.courseLink
      if (resolved) {
        e.preventDefault()
        goTo(resolved)
      }
    },
    [goTo],
  )

  // 当前节在扁平序列里的位置（上下篇导航）
  const idx = flat.findIndex((l) => l.path === currentPath)
  const prev = idx > 0 ? flat[idx - 1] : null
  const next = idx >= 0 && idx < flat.length - 1 ? flat[idx + 1] : null
  const lessonTitle = idx >= 0 ? flat[idx].title : ''

  // 目录树就绪后展开包含当前节的章（children 仅一层，直接匹配即可）
  useEffect(() => {
    if (!tree || !currentPath) return
    const owners = tree.lessons.filter((l) => l.children?.some((c) => c.path === currentPath)).map((l) => l.path)
    if (owners.length === 0) return
    setExpanded((prev) => {
      if (owners.every((p) => prev.has(p))) return prev
      const next = new Set(prev)
      for (const p of owners) next.add(p)
      return next
    })
  }, [tree, currentPath])

  return (
    <div className="flex h-screen overflow-hidden bg-paper text-ink">
      {/* 左：课件目录 */}
      <aside className="hidden w-72 shrink-0 flex-col border-r border-ink/15 bg-paper-deep/40 md:flex">
        <div className="border-b border-ink/10 px-5 pb-4 pt-5">
          <Link to="/" className="text-xs tracking-[0.25em] text-ink-faint transition hover:text-cinnabar">
            ← 墨痕书架
          </Link>
          <div className="mt-3 flex items-center gap-3">
            <span className="h-8 w-8 shrink-0 bg-cinnabar text-center font-song text-sm font-bold leading-8 text-paper shadow-seal">
              {meta?.seal || '课'}
            </span>
            <h1 className="min-w-0 truncate font-song text-base font-bold tracking-wide" title={meta?.title}>
              {meta?.title ?? courseId}
            </h1>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-3">
          {tree?.lessons.map((l) => (
            <TocItem
              key={l.path}
              node={l}
              depth={0}
              currentPath={currentPath}
              expanded={expanded}
              toggle={toggle}
              onNavigate={goTo}
            />
          ))}
        </nav>
      </aside>

      {/* 右：正文 */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-ink/10 bg-paper/80 px-6 py-3 backdrop-blur">
          <div className="min-w-0 truncate text-xs text-ink-faint">
            <Link to="/" className="md:hidden transition hover:text-cinnabar">
              书架
            </Link>
            <span className="md:hidden"> / </span>
            {meta?.title}
            {lessonTitle && <span> / {lessonTitle}</span>}
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs">
            {exportMsg && <span className="max-w-48 truncate text-ink-faint" title={exportMsg}>{exportMsg}</span>}
            {askAvailable && (
              <button
                className={`border px-2.5 py-1 transition ${
                  askOpen
                    ? 'border-ink bg-ink text-paper'
                    : 'border-ink/15 text-ink-soft hover:border-cinnabar/50 hover:text-cinnabar-deep'
                }`}
                onClick={() => setAskOpen((v) => !v)}
              >
                问 AI
              </button>
            )}
            {meta?.source === 'generated' && (
              <button
                className="border border-ink/15 px-2.5 py-1 text-ink-soft transition hover:border-cinnabar/50 hover:text-cinnabar-deep"
                title="沿课时规划继续生成缺失的课时"
                onClick={() => {
                  openGenerate({ continueCourse: meta })
                }}
              >
                续写
              </button>
            )}
            {meta && aiEnabled(meta) && (
              <button
                className="border border-ink/15 px-2.5 py-1 text-ink-soft transition hover:border-cinnabar/50 hover:text-cinnabar-deep disabled:opacity-50"
                title="按你的要求整体重写全书各课时（内置课件会先另存为可编辑副本）"
                disabled={forking}
                onClick={() => void handleRewrite()}
              >
                {forking ? '备副本…' : '整书改写'}
              </button>
            )}
            <button
              className="border border-ink/15 px-2.5 py-1 text-ink-soft transition hover:border-cinnabar/50 hover:text-cinnabar-deep disabled:opacity-50"
              onClick={() => void handleExport()}
              disabled={exporting || !meta}
            >
              {exporting ? '导出中…' : '导出 zip'}
            </button>
            <button
              className="border border-ink/15 px-2.5 py-1 text-ink-soft transition hover:border-cinnabar/50 hover:text-cinnabar-deep"
              onClick={() => setShowSettings(true)}
            >
              设置
            </button>
            {prev && (
              <button
                className="border border-ink/15 px-2.5 py-1 text-ink-soft transition hover:border-cinnabar/50 hover:text-cinnabar-deep"
                onClick={() => goTo(prev.path)}
                title={prev.title}
              >
                ← 上一篇
              </button>
            )}
            {next && (
              <button
                className="border border-ink/15 px-2.5 py-1 text-ink-soft transition hover:border-cinnabar/50 hover:text-cinnabar-deep"
                onClick={() => goTo(next.path)}
                title={next.title}
              >
                下一篇 →
              </button>
            )}
          </div>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto" onClick={onBodyClick}>
          <div className="mx-auto max-w-4xl px-6 py-10">
            {phase === 'loading' && <p className="text-sm text-ink-faint">展卷中……</p>}
            {phase === 'missing' && (
              <div className="border border-ink/15 bg-paper-deep/40 p-6 text-sm text-ink-soft">
                课件不存在或已被移除。<Link to="/" className="text-cinnabar underline underline-offset-4">回到书架</Link>
              </div>
            )}
            {phase === 'error' && (
              <div className="border border-cinnabar/40 bg-cinnabar/5 p-6 text-sm text-cinnabar-deep">
                课件加载失败，请检查网络后刷新重试。
              </div>
            )}
            {phase === 'ready' && contentErr && (
              <div className="border border-cinnabar/40 bg-cinnabar/5 p-6 text-sm text-cinnabar-deep">{contentErr}</div>
            )}
            {phase === 'ready' && !contentErr && content === null && (
              <p className="text-sm text-ink-faint">取文中……</p>
            )}
            {/* 渲染产物挂载点（.prose 根由 mountMarkdown 生成） */}
            <div ref={mountRef} />
          </div>
        </div>
      </main>

      {/* 右：AI 面板（仅 md 课件；内置课改写时会自动另存为可编辑副本） */}
      {askOpen && askAvailable && (
        <AskPanel
          courseTitle={meta?.title ?? courseId}
          sectionTitle={lessonTitle}
          course={meta}
          getProseRoot={getProseRoot}
          getSectionText={getSectionText}
          seed={askSeed}
          canEdit
          onClose={() => setAskOpen(false)}
          onOpenSettings={() => setShowSettings(true)}
          onApplyEdit={handleApplyEdit}
        />
      )}

      {probe && <FloatingToolbar x={probe.x} y={probe.y} onAsk={handleAsk} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      <GenerateBadge />
    </div>
  )
}
