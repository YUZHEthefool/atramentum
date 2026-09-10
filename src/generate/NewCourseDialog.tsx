// AI 著书对话框（课时制）：意向（主题+需求粘贴+风格 skill）→ 课时规划确认 → 逐课时流式生成 → 入库。
// 入库时随课程记录保存课时规划骨架（StoredPlan，含标题/要点/需求），供续写恢复完整规划。
// 续写模式（continueCourse）：优先读该骨架（旧课件回退解析 INDEX.md），只补生成缺失课时后覆盖写回。
// 整书改写（rewrite + continueCourse）：恢复规划后所有课时按「改写要求」重写并覆盖写回。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listAllCourses, storeFor } from '../course'
import {
  createCourseRecord,
  deleteCourse,
  loadCoursePlan,
  saveCourse,
  updateCourseFile,
} from '../course/dbStore'
import type { StoredPlan } from '../course/dbStore'
import type { CourseMeta } from '../types/course'
import { isAbortError } from '../ai/providers'
import { useSettingsStore } from '../store/settingsStore'
import { useSkillStore } from '../store/skillStore'
import { distillSkill } from './skill'
import { DEFAULT_SKILL } from './defaultSkill'
import { buildIndexMd, genLesson, genPlan, lessonFile, parseIndexEntries, planText, revisePlan } from './pipeline'
import type { PlanLesson } from './pipeline'
import { emitCourseCreated, emitCourseUpdated, useGenerateStore } from './generateStore'
import { Overlay } from '../components/common/Overlay'

type Phase = 'form' | 'plan' | 'generating' | 'done'

type FileStatus = 'pending' | 'running' | 'done' | 'error'

/** 规划清单条目：续写模式下带既有文件名与「跳过」（不重新生成）标记 */
interface PlanItem extends PlanLesson {
  file?: string
  skip?: boolean
}

const inputCls =
  'w-full border border-ink/20 bg-paper px-2.5 py-1.5 text-sm text-ink outline-none transition focus:border-cinnabar'

/** 取参考课材料：INDEX 目录 + 第一节全文 */
async function loadReference(meta: CourseMeta): Promise<{ outline: string; sample: string }> {
  const store = storeFor(meta.source)
  try {
    const tree = await store.loadTree(meta.id)
    if (!tree) return { outline: '', sample: '' }
    const indexText = await store.readFile(meta.id, 'INDEX.md')
    const first = tree.lessons[0]
    const samplePath = first?.children?.[0]?.path ?? first?.path ?? ''
    const sample = samplePath ? ((await store.readFile(meta.id, samplePath)) ?? '') : ''
    return { outline: indexText ?? '', sample }
  } catch {
    return { outline: '', sample: '' }
  }
}

export function NewCourseDialog() {
  // 全局承载：生成是长任务，对话框挂在路由之外；最小化不卸载、不中断
  const { visible, minimize, close } = useGenerateStore()
  const continueCourse = useGenerateStore((s) => s.continueCourse)
  const rewrite = useGenerateStore((s) => s.rewrite)
  const ai = useSettingsStore((s) => s.ai)
  const skills = useSkillStore((s) => s.skills)
  const addSkill = useSkillStore((s) => s.add)
  const removeSkill = useSkillStore((s) => s.remove)
  const rewriteMode = !!rewrite && !!continueCourse

  const [phase, setPhase] = useState<Phase>('form')
  const [courses, setCourses] = useState<CourseMeta[]>([])
  const [refId, setRefId] = useState('')
  const [topic, setTopic] = useState('')
  const [requirements, setRequirements] = useState('')

  // 风格 skill：默认用内置「墨痕课件风」；'' = 极简骨架；提炼面板状态
  const [skillId, setSkillId] = useState(DEFAULT_SKILL.id)
  const allSkills = useMemo(() => [DEFAULT_SKILL, ...skills], [skills])
  const skill = allSkills.find((s) => s.id === skillId) ?? null
  const [distillOpen, setDistillOpen] = useState(false)
  const [distillRefId, setDistillRefId] = useState('')
  const [distilling, setDistilling] = useState(false)
  const [distillErr, setDistillErr] = useState('')
  const [draftName, setDraftName] = useState('')
  const [draftGuide, setDraftGuide] = useState('')
  const draftSampleRef = useRef('')

  const [lessons, setLessons] = useState<PlanItem[]>([])
  const [planErr, setPlanErr] = useState('')

  // 大纲沟通：按用户反馈让 AI 修改规划（保留一轮撤销）
  const [feedback, setFeedback] = useState('')
  const [revising, setRevising] = useState(false)
  const [reviseErr, setReviseErr] = useState('')
  const [reviseNote, setReviseNote] = useState('')
  const prevLessonsRef = useRef<PlanItem[] | null>(null)

  // 整书改写：整体改写要求（注入每个课时的重写 prompt）；ref 供生成期闭包读取
  const [rewriteNote, setRewriteNote] = useState('')
  const rewriteModeRef = useRef(false)
  const rewriteNoteRef = useRef('')
  rewriteModeRef.current = rewriteMode
  rewriteNoteRef.current = rewriteNote

  // 生成期状态
  const [fileStatus, setFileStatus] = useState<Record<string, FileStatus>>({})
  const [live, setLive] = useState('')
  const [genErr, setGenErr] = useState('')
  const [doneInfo, setDoneInfo] = useState('')
  // 当前课时的已用秒数（无输出时用户也能确认请求还活着）
  const [elapsed, setElapsed] = useState(0)
  // 并发路数（1~4；1 = 纯串行）。越高越快，但可能撞供应商限流
  const [parallel, setParallel] = useState(2)
  const abortRef = useRef<AbortController | null>(null)
  const filesRef = useRef<Map<string, string>>(new Map())
  const lessonsRef = useRef<PlanItem[]>([])
  const refMatRef = useRef<{ outline: string; sample: string }>({ outline: '', sample: '' })
  const topicRef = useRef('')
  const reqRef = useRef('')
  const createdRef = useRef<CourseMeta | null>(null)
  // 本次会话新建的书（区别于续写的原书）：finalize 一无所出时只允许删这种空壳记录，
  // 续写目标的原书无论怎样都不能被删除
  const freshlyCreatedRef = useRef(false)

  // 「正在生成」从进行中的课时派生（并发生成时可能多个）；须在 lessonsRef 声明之后
  const activity = useMemo(
    () =>
      lessonsRef.current
        .filter((_, i) => fileStatus[`l${i}`] === 'running')
        .map((l) => l.title)
        .join(' · '),
    [fileStatus],
  )

  useEffect(() => {
    let alive = true
    listAllCourses().then((list) => {
      if (!alive) return
      setCourses(list)
      if (list.length > 0) setRefId(list[0].id)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => () => abortRef.current?.abort(), [])

  // 续写模式：读入已入库课件全部文件，恢复规划骨架；已有正文的课时默认跳过
  useEffect(() => {
    if (!continueCourse) return
    let alive = true
    void (async () => {
      const store = storeFor(continueCourse.source)
      const files = new Map<string, string>()
      for (const p of continueCourse.files) {
        const text = await store.readFile(continueCourse.id, p)
        if (text !== null) files.set(p, text)
      }
      // 规划来源：入库时保存的骨架（含要点/需求）优先；旧课件没有则回退解析 INDEX.md 目录表
      const entries = parseIndexEntries(files.get('INDEX.md') ?? '')
      const savedPlan =
        continueCourse.source === 'generated' ? await loadCoursePlan(continueCourse.id) : undefined
      const base: PlanLesson[] = savedPlan?.lessons.length
        ? savedPlan.lessons.map((l) => ({ title: l.title, points: l.points ?? [] }))
        : entries.map(({ title }) => ({ title, points: [] }))
      if (base.length === 0)
        throw new Error('未找到课时规划骨架或可解析的 INDEX.md 目录表，暂只支持课时制（lessonNN.md）课件')
      if (!alive) return
      filesRef.current = files
      createdRef.current = continueCourse
      freshlyCreatedRef.current = false // 续写的原书：绝不删除
      topicRef.current = savedPlan?.topic?.trim() || continueCourse.title
      reqRef.current = savedPlan?.requirements ?? ''
      setTopic(topicRef.current)
      setRequirements(reqRef.current)
      lessonsRef.current = base.map((l, i) => {
        const file = entries[i]?.file ?? lessonFile(i)
        // 整书改写默认全部重写；续写则已有正文的默认跳过
        return { ...l, file, skip: rewriteMode ? false : files.has(file) }
      })
      setLessons(lessonsRef.current)
      const st: Record<string, FileStatus> = {}
      lessonsRef.current.forEach((l, i) => {
        st[`l${i}`] = files.has(l.file ?? '') ? 'done' : 'pending'
      })
      setFileStatus(st)
      setPhase('plan')
    })().catch((e) => {
      if (!alive) return
      setPlanErr(`续写初始化失败：${(e as Error).message}`)
      setPhase('form')
    })
    return () => {
      alive = false
    }
  }, [continueCourse, rewriteMode])

  const setSt = useCallback((key: string, st: FileStatus) => {
    setFileStatus((prev) => ({ ...prev, [key]: st }))
  }, [])

  /* ── 风格 skill 提炼 ── */
  const doDistill = async () => {
    const ref = courses.find((c) => c.id === distillRefId)
    if (!ref) {
      setDistillErr('请选择作为风格来源的课件')
      return
    }
    setDistilling(true)
    setDistillErr('')
    try {
      const mat = await loadReference(ref)
      if (!mat.sample && !mat.outline) throw new Error('该课件没有可分析的内容')
      const guide = await distillSkill(ai, {
        courseTitle: ref.title,
        indexText: mat.outline,
        sampleSection: mat.sample,
      })
      setDraftName(`${ref.title} 风格`)
      setDraftGuide(guide)
      draftSampleRef.current = mat.sample
    } catch (e) {
      if (!isAbortError(e)) setDistillErr((e as Error).message)
    } finally {
      setDistilling(false)
    }
  }

  const saveDraftSkill = () => {
    if (!draftGuide.trim()) return
    const s = addSkill({
      name: draftName,
      styleGuide: draftGuide,
      sample: draftSampleRef.current,
      from: courses.find((c) => c.id === distillRefId)?.title ?? '',
    })
    setSkillId(s.id)
    setDraftGuide('')
    setDistillOpen(false)
  }

  /* ── 大纲沟通：按反馈让 AI 修改规划 ── */
  const doRevise = async () => {
    const fb = feedback.trim()
    if (!fb || revising || lessons.length === 0) return
    setRevising(true)
    setReviseErr('')
    setReviseNote('')
    setLive('') // 流式展示修改过程的原始输出
    const ac = new AbortController()
    abortRef.current = ac
    try {
      const { lessons: next, note } = await revisePlan(
        ai,
        {
          topic: topic.trim() || topicRef.current,
          lessons: lessons.map(({ title, points }) => ({ title, points })),
          feedback: fb,
          requirements: requirements || reqRef.current,
        },
        ac.signal,
        (chunk) => setLive((prev) => (prev + chunk).slice(-400)),
      )
      // 标题未变的课时沿用其 file/skip（续写模式：已生成的不因改规划而重写）
      const used = new Set<number>()
      const merged: PlanItem[] = next.map((l) => {
        const i = lessons.findIndex((p, idx) => !used.has(idx) && p.title === l.title)
        if (i >= 0) {
          used.add(i)
          return { ...l, file: lessons[i].file, skip: lessons[i].skip }
        }
        return { title: l.title, points: l.points }
      })
      prevLessonsRef.current = lessons
      setLessons(merged)
      setReviseNote(note || '已按反馈调整规划')
      setFeedback('')
    } catch (e) {
      if (!isAbortError(e)) setReviseErr((e as Error).message)
    } finally {
      abortRef.current = null
      setRevising(false)
      setLive('')
    }
  }

  const undoRevise = () => {
    if (!prevLessonsRef.current || revising) return
    setLessons(prevLessonsRef.current)
    prevLessonsRef.current = null
    setReviseNote('')
  }

  /* ── 课时规划 ── */
  const doPlan = async () => {
    if (!topic.trim()) {
      setPlanErr('请先填写你想学习的内容')
      return
    }
    setPlanErr('')
    setPhase('plan')
    setLessons([])
    setLive('') // 流式展示规划生成的原始输出
    const ref = courses.find((c) => c.id === refId)
    try {
      refMatRef.current = ref ? await loadReference(ref) : { outline: '', sample: '' }
      const ac = new AbortController()
      abortRef.current = ac
      const list = await genPlan(
        ai,
        {
          topic: topic.trim(),
          requirements,
          referenceOutline: refMatRef.current.outline,
          sampleSection: skill?.sample || refMatRef.current.sample,
          styleGuide: skill?.styleGuide,
          onDelta: (chunk) => setLive((prev) => (prev + chunk).slice(-400)),
        },
        ac.signal,
      )
      setLessons(list)
    } catch (e) {
      if (isAbortError(e)) return
      setPlanErr((e as Error).message)
    } finally {
      abortRef.current = null
      setLive('')
    }
  }

  /** 生成单个课时正文（start 与 retryFailed 共用）。断流自愈：连接中途断掉时，
   *  把已收到的部分作为续写底稿接着写（最多 3 次尝试），而不是从头重写。
   *  persist 非空时，写完立即入库——阅读器可以实时看到已完成的课时。 */
  const genOneLesson = useCallback(
    async (li: number, ac: AbortController, persist?: (text: string) => Promise<void>): Promise<void> => {
      const all = lessonsRef.current
      const lesson = all[li]
      if (!lesson) return
      const key = `l${li}`
      setSt(key, 'running')
      setElapsed(0)
      const startedAt = Date.now()
      const tick = setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000)
      try {
        let partial = '' // 本轮流式已收到的正文（中断时成为续写底稿）
        let reasoningTail = '' // 思考流尾巴（续写时上屏，避免看起来卡死）
        const showTail = () => setLive((partial + reasoningTail).slice(-400))
        for (let attempt = 1; ; attempt++) {
          setLive(partial || '')
          setSt(key, 'running')
          try {
            const text = await genLesson(
              ai,
              {
                topic: topicRef.current,
                requirements: reqRef.current,
                planText: planText(all),
                lessonTitle: lesson.title,
                points: lesson.points,
                lessonNo: li,
                total: all.length,
                prevTitle: li > 0 ? all[li - 1].title : undefined,
                nextTitle: li < all.length - 1 ? all[li + 1].title : undefined,
                nextFile: li < all.length - 1 ? lessonFile(li + 1) : undefined,
                sampleSection: skill?.sample || refMatRef.current.sample,
                styleGuide: skill?.styleGuide,
                // 整书改写：以现有正文为底稿按改写要求重写
                rewriteOf: rewriteModeRef.current ? (filesRef.current.get(lessonFile(li)) ?? '') : undefined,
                rewriteNote: rewriteModeRef.current ? rewriteNoteRef.current : undefined,
                // 断点续写：把已收到的部分交回去接着写
                continueOf: partial || undefined,
              },
              (chunk) => {
                partial += chunk
                showTail()
              },
              ac.signal,
              // 思考过程（推理模型）：也上屏，用户能看到模型确实在动
              (chunk) => {
                reasoningTail = (reasoningTail + chunk).slice(-400)
                showTail()
              },
            )
            filesRef.current.set(lessonFile(li), text)
            setSt(key, 'done')
            if (persist) await persist(text) // 实时入库：阅读器立刻可读该课时
            return
          } catch (e) {
            if (isAbortError(e)) throw e
            if (attempt >= 3) {
              setSt(key, 'error')
              return
            }
            await new Promise((r) => setTimeout(r, 1500)) // 退避后从断点续写
            if (ac.signal.aborted) throw new DOMException('已停止', 'AbortError')
          }
        }
      } finally {
        clearInterval(tick)
      }
    },
    [ai, setSt, skill],
  )

  /** 当前规划的持久化形态（随课程记录保存，续写时恢复） */
  const planToStore = (): StoredPlan => ({
    topic: topicRef.current,
    requirements: reqRef.current || undefined,
    lessons: lessonsRef.current.map(({ title, points }) => ({ title, points })),
  })

  /** 生成结束（完成/失败/取消）统一收尾：有产出就入库，无产出回规划页。
   *  生成期课程记录已实时建好（createdRef 非空），这里只统一 meta 与规划骨架。 */
  const finalize = useCallback(
    async (fatalErr: string) => {
      const files = [...filesRef.current].map(([path, text]) => ({ path, text }))
      const plan = planToStore()
      const created = createdRef.current
      if (!created || files.length <= 1) {
        // 一无所出：只有「本次会话新建的书」才清空壳记录；续写的原书任何情况都不能删
        if (created && files.length <= 1 && freshlyCreatedRef.current) {
          try {
            await deleteCourse(created.id)
          } catch {
            /* 清理失败不打扰用户，回规划页重试即可 */
          }
          createdRef.current = null
          freshlyCreatedRef.current = false
        }
        if (!created && files.length > 1) {
          // 实时立记录失败退化的场景：课时在内存里，重试「开始」会再次尝试建记录入库
          setGenErr(`课时已生成（${files.length - 1} 篇）但入库记录创建失败，请重试开始生成以完成入库。`)
        } else {
          setGenErr(fatalErr || '没有生成出可用内容，请检查模型与网络后重试。')
        }
        setPhase('plan')
        return
      }
      // 覆盖写回（新书的实时入库记录 / 续写改写的原书）：统一 meta、全量文件与规划骨架
      const meta: CourseMeta = {
        ...created,
        fileCount: files.length,
        files: files.map((f) => f.path),
        desc: created.source === 'generated' ? `AI 生成 · ${lessonsRef.current.length} 课时` : created.desc,
      }
      try {
        await saveCourse(meta, files, Date.now(), plan)
      } catch (e) {
        // 入库失败（配额/事务）绝不能静默：课时还在 filesRef，回规划页提示后可重试收尾
        setGenErr(`入库失败：${(e as Error).message}。课时内容已保留，可点「开始」重新收尾。`)
        setPhase('plan')
        return
      }
      createdRef.current = meta
      emitCourseCreated(meta)
      setDoneInfo(`${meta.title} · ${files.length} 个文件`)
      setPhase('done')
    },
    [],
  )

  /* ── 逐课时生成（并发池：1~4 路同时写，写完即入库可读） ── */
  const startGeneration = useCallback(async () => {
    const all = lessonsRef.current
    const ac = new AbortController()
    abortRef.current = ac
    setPhase('generating')
    setGenErr('')
    if (createdRef.current) {
      // 续写：把「跳过」的既有正文按当前顺序归位到 lesson{i+1}.md（兼容增删/调序），并清掉不再被引用的旧课时文件
      for (let i = 0; i < all.length; i++) {
        const item = all[i]
        if (item.skip && item.file && filesRef.current.has(item.file)) {
          filesRef.current.set(lessonFile(i), filesRef.current.get(item.file)!)
        }
      }
      const keep = new Set(['INDEX.md'])
      for (let i = 0; i < all.length; i++) keep.add(lessonFile(i))
      for (const p of [...filesRef.current.keys()]) {
        if (/^lesson\d+\.md$/.test(p) && !keep.has(p)) filesRef.current.delete(p)
      }
    } else if (!filesRef.current.has('INDEX.md') || filesRef.current.size <= 1) {
      // 全新开始；上一轮「入库记录创建失败」留下的内存课时（size>1）原样保留，点开始可再次尝试入库
      setFileStatus({})
      filesRef.current = new Map()
    } else {
      setFileStatus((prev) =>
        Object.fromEntries(Object.entries(prev).map(([k, st]) => [k, st === 'error' || st === 'running' ? 'pending' : st])),
      )
    }
    filesRef.current.set('INDEX.md', buildIndexMd(topicRef.current, all))

    // 实时入库：开写前立课程记录（新书面目 + INDEX 目录 + 规划骨架），之后每课时写完即补
    // 文件——生成中途就能去阅读器看已完成的课时；中途关浏览器留下的记录也能被续写完整恢复。
    // continueCourse 场景记录已存在，无需重建。
    // 注意：这里不能拿 filesRef.size 判断「有没有内容」——INDEX 刚 set 进去时 size=1，
    // 拿 size>1 做条件会让新书永远建不了记录，全部产出滞留内存，一关页面就全丢。
    if (!createdRef.current) {
      const title = topicRef.current.trim() || '未命名课件'
      const meta: CourseMeta = {
        id: `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        title,
        seal: [...title][0] || '课',
        desc: `AI 生成 · ${all.length} 课时`,
        kind: 'dir',
        fileCount: filesRef.current.size,
        files: [...filesRef.current.keys()],
        category: '学习',
        format: 'md',
        source: 'generated',
      }
      try {
        await createCourseRecord(meta, planToStore())
      } catch (e) {
        // 立记录失败（配额/IndexedDB 被禁）：退化为纯内存生成，结束时再走一次入库
        setGenErr(`实时入库不可用（${(e as Error).message}），改为生成完成后一次性入库。`)
      }
      if (createdRef.current === null) {
        createdRef.current = meta
        freshlyCreatedRef.current = true
        // INDEX 目录先落库，阅读器打开时目录树才有结构（课时随后逐个补文件）
        try {
          await updateCourseFile(meta.id, 'INDEX.md', filesRef.current.get('INDEX.md') ?? '')
        } catch {
          /* 阅读器目录可能暂时打不开，不影响生成 */
        }
        // 立刻通知书架：生成中的书马上可见、可点进去实时预览（不等全部写完）
        emitCourseCreated(meta)
      }
    }
    const courseId = createdRef.current?.id
    const persist = courseId
      ? (li: number, text: string) =>
          // 实时入库：阅读器立刻可读该课时；广播更新事件让开着的目录树长出新课时
          updateCourseFile(courseId, lessonFile(li), text).then((fresh) => {
            if (fresh) emitCourseUpdated(fresh)
          })
      : undefined

    // 待写队列（按规划顺序出队；并发 worker 各自取活）
    const queue = all.map((_, i) => i).filter((i) => !(all[i].skip && filesRef.current.has(lessonFile(i))))
    const workers = Array.from({ length: Math.max(1, Math.min(4, parallel, queue.length)) }, async () => {
      for (;;) {
        const li = queue.shift()
        if (li === undefined || ac.signal.aborted) return
        try {
          await genOneLesson(li, ac, persist ? (text) => persist(li, text) : undefined)
        } catch (e) {
          if (isAbortError(e)) return
          // 断流/入库失败不终止整池：genOneLesson 内部已标 error，继续取下一个课时
        }
      }
    })
    await Promise.all(workers)
    abortRef.current = null
    await finalize('')
  }, [genOneLesson, finalize, parallel])

  /** 重写失败的课时（重生成后覆盖入库） */
  const retryFailed = useCallback(async () => {
    const failed = Object.entries(fileStatus)
      .filter(([, st]) => st === 'error')
      .map(([key]) => Number(key.slice(1)))
      .filter((n) => Number.isInteger(n))
    if (failed.length === 0) return
    const ac = new AbortController()
    abortRef.current = ac
    setPhase('generating')
    setGenErr('')
    const courseId = createdRef.current?.id
    const persist = courseId
      ? (li: number, text: string) =>
          updateCourseFile(courseId, lessonFile(li), text).then((fresh) => {
            if (fresh) emitCourseUpdated(fresh)
          })
      : undefined
    const queue = [...failed]
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(4, parallel, queue.length)) }, async () => {
        for (;;) {
          const li = queue.shift()
          if (li === undefined || ac.signal.aborted) return
          try {
            await genOneLesson(li, ac, persist ? (text) => persist(li, text) : undefined)
          } catch (e) {
            if (isAbortError(e)) return
          }
        }
      }),
    )
    abortRef.current = null
    await finalize('')
  }, [fileStatus, genOneLesson, finalize, parallel])

  const cancel = () => {
    abortRef.current?.abort()
  }

  /* ── 课时规划编辑 ── */
  const editLesson = (li: number, title: string) => {
    setLessons((ls) => ls.map((l, i) => (i === li ? { ...l, title } : l)))
  }
  const editPoints = (li: number, text: string) => {
    const points = text.split('\n').map((s) => s.trim()).filter(Boolean)
    setLessons((ls) => ls.map((l, i) => (i === li ? { ...l, points } : l)))
  }
  const removeLesson = (li: number) => setLessons((ls) => ls.filter((_, i) => i !== li))
  const addLesson = () => setLessons((ls) => [...ls, { title: `新课时`, points: [] }])
  const setSkip = (li: number, skip: boolean) =>
    setLessons((ls) => ls.map((l, i) => (i === li ? { ...l, skip } : l)))
  const moveLesson = (li: number, delta: number) => {
    setLessons((ls) => {
      const j = li + delta
      if (j < 0 || j >= ls.length) return ls
      const next = [...ls]
      ;[next[li], next[j]] = [next[j], next[li]]
      return next
    })
  }

  const chipCls = (st: FileStatus): string =>
    st === 'done' ? 'text-ink-faint' : st === 'running' ? 'text-cinnabar-deep' : st === 'error' ? 'text-cinnabar' : 'text-ink-faint/50'
  const chipText = (st: FileStatus): string =>
    st === 'done' ? '✓' : st === 'running' ? '…' : st === 'error' ? '✕' : '○'

  /** 新标签页打开阅读器看某课时（HashRouter 下拼 hash 路由） */
  const openLesson = (li: number) => {
    const id = createdRef.current?.id
    if (!id) return
    const base = import.meta.env.BASE_URL // './' 或 '/'
    const prefix = base.endsWith('/') ? base : `${base}/`
    window.open(`${prefix}#/c/${id}?path=${encodeURIComponent(lessonFile(li))}`, '_blank')
  }

  // 最小化：组件保持挂载（流式任务在跑），只是不渲染面板
  if (!visible) return null

  return (
    <Overlay onClose={phase === 'generating' ? minimize : close} closeOnOverlay={phase !== 'generating'}>
      <div className="flex items-center justify-between border-b border-ink/15 px-5 py-3">
        <h2 className="font-song text-base font-bold tracking-wide">AI 著书</h2>
        <div className="flex items-center gap-2">
          {phase === 'generating' && (
            <button
              className="border border-ink/20 px-2 py-0.5 text-xs text-ink-faint transition hover:border-cinnabar/50 hover:text-cinnabar"
              onClick={minimize}
              title="收起对话框，生成在后台继续；可随时去书架/阅读器预览已写完的课时"
            >
              收起
            </button>
          )}
          {phase !== 'generating' && (
            <button className="text-ink-faint transition hover:text-cinnabar" onClick={close} aria-label="关闭">
              ✕
            </button>
          )}
        </div>
      </div>

      {/* ── 第一步：学习意向 ── */}
      {phase === 'form' && (
        <div className="space-y-4 p-5">
          <div>
            <label className="mb-1 block text-sm font-semibold">你想学习什么？</label>
            <input
              className={inputCls}
              placeholder="如：Docker 容器原理与实战 / 明清史入门 / 线性代数"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-semibold">
              需求（可选，直接粘贴）
            </label>
            <textarea
              className={`${inputCls} min-h-32 resize-y`}
              placeholder={'把你已有的东西直接贴进来，例如：\n· 课程大纲 / 章节目录\n· 课时数要求（如「20 课时，每课时 45 分钟」）\n· 目标读者、深度、风格偏好\n· 指定教材或参考书'}
              value={requirements}
              onChange={(e) => setRequirements(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-semibold">参考课件（可选，学习其组织方式）</label>
            <select className={inputCls} value={refId} onChange={(e) => setRefId(e.target.value)}>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-semibold">风格 Skill</label>
            <div className="flex items-center gap-2">
              <select className={inputCls} value={skillId} onChange={(e) => setSkillId(e.target.value)}>
                <option value={DEFAULT_SKILL.id}>{DEFAULT_SKILL.name}</option>
                {skills.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.from ? `（源自 ${s.from}）` : ''}
                  </option>
                ))}
                <option value="">极简骨架</option>
              </select>
              {skill && skill.id !== DEFAULT_SKILL.id && (
                <button
                  className="shrink-0 border border-ink/20 px-2.5 py-1.5 text-xs text-ink-faint transition hover:border-cinnabar hover:text-cinnabar"
                  onClick={() => {
                    removeSkill(skill.id)
                    setSkillId('')
                  }}
                >
                  删除
                </button>
              )}
              <button
                className="shrink-0 border border-ink/20 px-2.5 py-1.5 text-xs text-ink-soft transition hover:border-cinnabar/50 hover:text-cinnabar-deep"
                onClick={() => {
                  if (!distillOpen) {
                    setDistillRefId(refId)
                    setDistillErr('')
                  }
                  setDistillOpen((v) => !v)
                }}
              >
                {distillOpen ? '收起' : '提炼新 skill…'}
              </button>
            </div>
            <p className="mt-1 text-xs text-ink-faint">
              从现有课件提炼写作风格规范（文风、骨架、图示习惯），著书时注入，让产出延续同样的风格。
            </p>

            {distillOpen && (
              <div className="mt-3 space-y-3 border border-ink/15 p-3">
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label className="mb-1 block text-xs font-semibold">从哪门课提炼？</label>
                    <select className={inputCls} value={distillRefId} onChange={(e) => setDistillRefId(e.target.value)}>
                      {courses.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    className="shrink-0 bg-cinnabar px-3 py-1.5 text-xs text-paper transition hover:bg-cinnabar-deep disabled:opacity-50"
                    onClick={() => void doDistill()}
                    disabled={distilling || courses.length === 0}
                  >
                    {distilling ? '提炼中…' : '提炼'}
                  </button>
                </div>
                {distillErr && <p className="text-xs leading-5 text-cinnabar-deep">{distillErr}</p>}
                {draftGuide && (
                  <div className="space-y-2">
                    <input
                      className={inputCls}
                      placeholder="skill 名称"
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                    />
                    <textarea
                      className={`${inputCls} min-h-52 resize-y font-mono text-xs leading-5`}
                      value={draftGuide}
                      onChange={(e) => setDraftGuide(e.target.value)}
                    />
                    <p className="text-xs text-ink-faint">提炼结果可直接修改，满意后保存。样例节会一并存入 skill。</p>
                    <div className="flex items-center justify-end gap-3">
                      <button
                        className="border border-ink/25 px-3 py-1.5 text-xs text-ink-soft transition hover:border-cinnabar/50"
                        onClick={() => {
                          setDraftGuide('')
                          setDistillOpen(false)
                        }}
                      >
                        放弃
                      </button>
                      <button
                        className="bg-cinnabar px-3 py-1.5 text-xs text-paper transition hover:bg-cinnabar-deep disabled:opacity-40"
                        onClick={saveDraftSkill}
                        disabled={!draftGuide.trim() || !draftName.trim()}
                      >
                        保存并使用
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          {(!ai.apiKey || !ai.model) && (
            <p className="border border-cinnabar/40 bg-cinnabar/5 px-3 py-2 text-xs leading-5 text-cinnabar-deep">
              尚未配置 AI：请先到「设置」填写请求地址与 API Key。
            </p>
          )}
          {planErr && (
            <p className="border border-cinnabar/40 bg-cinnabar/5 px-3 py-2 text-xs leading-5 text-cinnabar-deep">{planErr}</p>
          )}
          <div className="flex items-center justify-end gap-3">
            <button className="border border-ink/25 px-4 py-1.5 text-sm text-ink-soft transition hover:border-cinnabar/50" onClick={close}>
              取消
            </button>
            <button
              className="bg-cinnabar px-4 py-1.5 text-sm text-paper transition hover:bg-cinnabar-deep disabled:opacity-40"
              onClick={() => void doPlan()}
              disabled={!topic.trim() || !ai.apiKey || !ai.model}
            >
              生成课时规划
            </button>
          </div>
        </div>
      )}

      {/* ── 第二步：课时规划确认 ── */}
      {phase === 'plan' && (
        <div className="p-5">
          {rewriteMode && (
            <div className="mb-3 space-y-2 border border-cinnabar/30 bg-cinnabar/5 p-3">
              <p className="text-xs font-semibold text-ink">
                整书改写 · 共 {lessons.length} 课时将全部重写（勾「跳过」的课时保留原文）
              </p>
              <textarea
                className={`${inputCls} min-h-16 resize-y text-xs`}
                placeholder={'整体改写要求，例如：\n· 面向零基础，多打比方，少用术语\n· 压缩篇幅到原来的 2/3，保留全部代码示例\n· 每节增加一个动手练习'}
                value={rewriteNote}
                onChange={(e) => setRewriteNote(e.target.value)}
                disabled={revising}
              />
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-xs text-ink-faint">风格 Skill</span>
                <select
                  className={`${inputCls} max-w-72 text-xs`}
                  value={skillId}
                  onChange={(e) => setSkillId(e.target.value)}
                  disabled={revising}
                >
                  <option value={DEFAULT_SKILL.id}>{DEFAULT_SKILL.name}</option>
                  {skills.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.from ? `（源自 ${s.from}）` : ''}
                    </option>
                  ))}
                  <option value="">极简骨架</option>
                </select>
              </div>
            </div>
          )}
          {lessons.length === 0 ? (
            <div className="py-8">
              <p className="text-center text-sm text-ink-faint">课时规划构思中……</p>
              {live && (
                <pre className="mx-auto mt-4 max-h-40 max-w-xl overflow-y-auto whitespace-pre-wrap break-all border border-ink/15 bg-paper-deep/40 p-3 text-xs leading-5 text-ink-faint">
                  {live}
                </pre>
              )}
            </div>
          ) : (
            <>
              <p className="mb-3 text-xs text-ink-faint">
                {continueCourse
                  ? `已生成 ${lessons.filter((l) => l.skip).length} / ${lessons.length} 课时。勾「跳过」的沿用已有正文，其余沿规划续写；标题、要点可改，也可加新课时。`
                  : `共 ${lessons.length} 课时。确认后逐课时生成；标题、要点、顺序都可改，也可增删。`}
              </p>
              <div className={`max-h-[42vh] space-y-3 overflow-y-auto pr-1 ${revising ? 'pointer-events-none opacity-60' : ''}`}>
                {lessons.map((l, li) => (
                  <div key={li} className="border border-ink/15 p-3">
                    <div className="flex items-center gap-2">
                      <span className="w-8 shrink-0 text-center text-xs text-ink-faint">{li + 1}</span>
                      <input className={`${inputCls} font-song font-bold`} value={l.title} onChange={(e) => editLesson(li, e.target.value)} />
                      {continueCourse && (
                        <label
                          className="flex shrink-0 cursor-pointer select-none items-center gap-1 text-xs text-ink-faint"
                          title="勾选则沿用已有正文，不重新生成"
                        >
                          <input
                            type="checkbox"
                            className="accent-cinnabar"
                            checked={!!l.skip}
                            onChange={(e) => setSkip(li, e.target.checked)}
                          />
                          跳过
                        </label>
                      )}
                      <button className="shrink-0 px-1 text-xs text-ink-faint transition hover:text-cinnabar" onClick={() => moveLesson(li, -1)} aria-label="上移">
                        ↑
                      </button>
                      <button className="shrink-0 px-1 text-xs text-ink-faint transition hover:text-cinnabar" onClick={() => moveLesson(li, 1)} aria-label="下移">
                        ↓
                      </button>
                      <button
                        className="shrink-0 border border-ink/20 px-2 py-1 text-xs text-ink-faint transition hover:border-cinnabar hover:text-cinnabar"
                        onClick={() => removeLesson(li)}
                        aria-label="删除本课时"
                      >
                        ✕
                      </button>
                    </div>
                    <textarea
                      className={`${inputCls} mt-2 min-h-16 resize-y text-xs`}
                      placeholder="本课时要点（每行一条）"
                      value={l.points.join('\n')}
                      onChange={(e) => editPoints(li, e.target.value)}
                    />
                  </div>
                ))}
              </div>

              {/* 和 AI 商量：按反馈修改规划 */}
              <div className="mt-3 border border-ink/15 p-3">
                <p className="mb-2 text-xs font-semibold text-ink">和 AI 商量这版规划</p>
                <textarea
                  className={`${inputCls} min-h-16 resize-y text-xs`}
                  placeholder={'直接说想怎么改，例如：\n· 压缩到 10 讲，把实践内容合并\n· 第 4 讲太难了，拆成两讲循序渐进\n· 加两节关于 X 的课时；历史部分砍掉'}
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  disabled={revising}
                />
                <div className="mt-2 flex items-center gap-3">
                  <button
                    className="border border-ink/20 px-3 py-1.5 text-xs text-ink-soft transition hover:border-cinnabar/50 hover:text-cinnabar-deep disabled:opacity-40"
                    onClick={() => void doRevise()}
                    disabled={revising || !feedback.trim() || !ai.apiKey || !ai.model}
                  >
                    {revising ? 'AI 修改中…' : '让 AI 修改规划'}
                  </button>
                  {prevLessonsRef.current && !revising && (
                    <button className="text-xs text-ink-faint transition hover:text-cinnabar" onClick={undoRevise}>
                      撤销本次修改
                    </button>
                  )}
                  {reviseNote && (
                    <span className="min-w-0 flex-1 truncate text-xs text-ink-faint" title={reviseNote}>
                      {reviseNote}
                    </span>
                  )}
                </div>
                {reviseErr && <p className="mt-2 text-xs leading-5 text-cinnabar-deep">{reviseErr}</p>}
                {revising && live && (
                  <pre className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-all border border-ink/15 bg-paper-deep/40 p-2 text-xs leading-5 text-ink-faint">
                    {live}
                  </pre>
                )}
              </div>
            </>
          )}
          <div className="mt-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button className="text-xs text-ink-faint transition hover:text-cinnabar disabled:opacity-40" onClick={addLesson} disabled={revising}>
                ＋ 加一课时
              </button>
              <label className="flex items-center gap-1.5 text-xs text-ink-faint" title="同时生成几路课时：越高越快，但可能撞供应商限流（429）；1 = 纯串行">
                并发
                <select
                  className="border border-ink/20 bg-paper px-1.5 py-0.5 text-xs text-ink outline-none focus:border-cinnabar"
                  value={parallel}
                  onChange={(e) => setParallel(Number(e.target.value))}
                  disabled={revising}
                >
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      {n} 路
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex items-center gap-3">
              <button
                className="border border-ink/25 px-4 py-1.5 text-sm text-ink-soft transition hover:border-cinnabar/50 disabled:opacity-40"
                onClick={() => setPhase('form')}
                disabled={revising}
              >
                上一步
              </button>
              <button
                className="bg-cinnabar px-4 py-1.5 text-sm text-paper transition hover:bg-cinnabar-deep disabled:opacity-40"
                onClick={() => {
                  lessonsRef.current = lessons
                  topicRef.current = topic.trim()
                  reqRef.current = requirements
                  void startGeneration()
                }}
                disabled={revising || lessons.length === 0 || (!!continueCourse && lessons.every((l) => l.skip))}
              >
                {rewriteMode ? '开始整书改写' : continueCourse ? '继续生成缺失课时' : '开始逐课时生成'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 第三步：生成进度 ── */}
      {phase === 'generating' && (
        <div className="p-5">
          <div className="flex items-baseline justify-between gap-3">
            <p className="min-w-0 truncate text-sm text-ink-soft">
              正在生成：<span className="font-semibold text-ink">{activity}</span>
            </p>
            {createdRef.current && (
              <button
                className="shrink-0 border border-ink/20 px-2.5 py-1 text-xs text-ink-soft transition hover:border-cinnabar/50 hover:text-cinnabar-deep"
                onClick={() => openLesson(0)}
                title="新标签页打开阅读器；已写完的课时立即可读，未写的显示加载失败属正常"
              >
                开新标签页预览 ↗
              </button>
            )}
          </div>
          <p className="mt-1 text-xs text-ink-faint">
            {Math.max(1, Math.min(4, parallel))} 路并发生成中 · 本轮已用 {elapsed} 秒 · 课时写完即可在预览中阅读
          </p>
          {live && (
            <pre className="mt-3 max-h-32 overflow-y-auto whitespace-pre-wrap break-all border border-ink/15 bg-paper-deep/40 p-3 text-xs leading-5 text-ink-faint">
              {live}
            </pre>
          )}
          <div className="mt-4 max-h-56 space-y-1.5 overflow-y-auto pr-1">
            {lessonsRef.current.map((l, li) => {
              const st = fileStatus[`l${li}`] ?? 'pending'
              return (
                <div key={li} className="flex items-center gap-2 text-sm">
                  <span className={`w-4 shrink-0 text-center text-xs ${chipCls(st)}`}>{chipText(st)}</span>
                  <span className={`min-w-0 flex-1 truncate ${st === 'error' ? 'text-cinnabar' : 'text-ink-soft'}`}>
                    {li + 1}. {l.title}
                  </span>
                  {st === 'done' && createdRef.current && (
                    <button
                      className="shrink-0 text-xs text-cinnabar-deep underline underline-offset-2 transition hover:text-cinnabar"
                      onClick={() => openLesson(li)}
                    >
                      去看 ↗
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          {genErr && <p className="mt-3 border border-cinnabar/40 bg-cinnabar/5 px-3 py-2 text-xs text-cinnabar-deep">{genErr}</p>}
          <div className="mt-4 text-right">
            <button
              className="border border-ink/25 px-4 py-1.5 text-sm text-ink-soft transition hover:border-cinnabar/50 hover:text-cinnabar-deep"
              onClick={cancel}
            >
              停止并保留已完成课时
            </button>
          </div>
        </div>
      )}

      {/* ── 第四步：完成 ── */}
      {phase === 'done' && (
        <div className="p-5 text-center">
          <p className="mt-4 font-song text-2xl font-bold text-ink">书成 ✦</p>
          <p className="mt-3 text-sm text-ink-soft">{doneInfo}</p>
          <p className="mt-1 text-xs text-ink-faint">
            {continueCourse
              ? '课件已写回本书，关闭后即可阅读新生成的课时。'
              : '课件已入库，回到书架即可开读、可导出、可继续让 AI 改写。'}
          </p>
          {Object.values(fileStatus).some((st) => st === 'error') ? (
            <div className="mt-5 flex items-center justify-center gap-3">
              <button
                className="border border-cinnabar/50 px-5 py-1.5 text-sm text-cinnabar-deep transition hover:bg-cinnabar/5"
                onClick={() => void retryFailed()}
              >
                重写失败课时
              </button>
              {createdRef.current && (
                <button
                  className="border border-ink/20 px-5 py-1.5 text-sm text-ink-soft transition hover:border-cinnabar/50 hover:text-cinnabar-deep"
                  onClick={() => openLesson(0)}
                >
                  去阅读 ↗
                </button>
              )}
              <button className="bg-cinnabar px-5 py-1.5 text-sm text-paper transition hover:bg-cinnabar-deep" onClick={close}>
                {continueCourse ? '完成' : '回书架'}
              </button>
            </div>
          ) : (
            <button className="mt-5 bg-cinnabar px-5 py-1.5 text-sm text-paper transition hover:bg-cinnabar-deep" onClick={close}>
              {continueCourse ? '完成' : '回书架'}
            </button>
          )}
        </div>
      )}
    </Overlay>
  )
}
