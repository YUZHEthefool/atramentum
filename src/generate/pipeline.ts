/**
 * 课件生成流水线（纯函数层）——课时制：
 * 1. genPlan     —— 主题 + 需求（可粘贴大纲）+ 参考材料 → 课时规划 JSON
 * 2. genLesson   —— 逐课时生成正文（流式）
 * 3. buildIndexMd —— 目录由代码拼接（保证目录表可被 structure.ts 解析）
 */
import { chat, chatStream, extractJSON } from '../ai/providers'
import type { AIProviderConfig } from '../types/ai'

export interface PlanLesson {
  title: string
  points: string[]
}

export interface PlanParams {
  topic: string
  /** 用户粘贴的需求 / 大纲 / 期望（可为空） */
  requirements?: string
  /** 参考课 INDEX.md 文本（可为空） */
  referenceOutline: string
  /** 参考课一节全文样例（学习文风与骨架） */
  sampleSection: string
  /** 风格 skill 的规范（可为空；优先于样例） */
  styleGuide?: string
}

/* ───────── 课时规划 ───────── */

const PLAN_SYSTEM = '你是「墨痕」AI 陪学的课程设计师。只输出 JSON，不要输出任何其它文字、注释或代码围栏。'

export async function genPlan(
  config: AIProviderConfig,
  params: PlanParams,
  signal?: AbortSignal,
): Promise<PlanLesson[]> {
  const user = [
    `【任务】为主题「${params.topic}」设计一门课的课时规划。`,
    params.requirements?.trim() && `【我的需求（务必尽量满足）】\n${params.requirements.trim().slice(0, 6000)}`,
    params.styleGuide?.trim() && `【写作风格规范（skill，规划需与之匹配）】\n${params.styleGuide.trim().slice(0, 2500)}`,
    params.referenceOutline && `【参考课件的目录（学习其组织方式）】\n${params.referenceOutline.slice(0, 3000)}`,
    params.sampleSection && `【参考课件的一节样例（学习其文风与骨架）】\n${params.sampleSection.slice(0, 3000)}`,
    '【要求】设计 8~16 个课时（若「我的需求」指定了课时数/章节则严格照办）；每课时围绕一个完整主题，配 3~6 条「本课时要点」；课时之间循序渐进、彼此衔接。',
    '【输出】只输出 JSON：{"lessons":[{"title":"第1讲 …","points":["要点一","要点二"]}]}',
  ]
    .filter(Boolean)
    .join('\n\n')

  const raw = await chat(config, {
    messages: [
      { role: 'system', content: PLAN_SYSTEM },
      { role: 'user', content: user },
    ],
    json: true,
    temperature: 0.5,
    maxTokens: 4096,
    signal,
  })
  return parsePlan(raw)
}

/** 解析课时规划 JSON；兼容 lessons/chapters 字段名与裸数组 */
export function parsePlan(raw: string): PlanLesson[] {
  let data: unknown
  try {
    data = JSON.parse(extractJSON(raw))
  } catch {
    throw new Error(`课时规划解析失败，模型未返回合法 JSON。原始输出片段：${raw.slice(0, 160)}`)
  }
  const obj = data as { lessons?: unknown[]; chapters?: unknown[] }
  let rawList = Array.isArray(obj?.lessons)
    ? obj.lessons
    : Array.isArray(obj?.chapters)
      ? obj.chapters
      : null
  if (!rawList) {
    // 兼容模型忽略包装、直接输出顶层数组
    const m = /\[[\s\S]*\]/.exec(raw)
    if (m) {
      try {
        const arr = JSON.parse(m[0])
        if (Array.isArray(arr)) rawList = arr
      } catch {
        // 保持 null → 走下方报错
      }
    }
  }
  if (!rawList) throw new Error('课时规划 JSON 缺少 lessons 字段')
  const lessons: PlanLesson[] = []
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue
    const o = item as { title?: unknown; name?: unknown; points?: unknown; sections?: unknown; outline?: unknown }
    const title = String(o.title ?? o.name ?? '').trim()
    const rawPoints = o.points ?? o.sections ?? o.outline
    const points = Array.isArray(rawPoints) ? rawPoints.map((p) => String(p).trim()).filter(Boolean) : []
    if (title) lessons.push({ title, points })
  }
  if (lessons.length === 0) throw new Error('课时规划为空：模型未给出有效课时。请重试或换模型。')
  return lessons
}

/* ───────── 按用户反馈修改课时规划（大纲沟通） ───────── */

export interface RevisedPlan {
  lessons: PlanLesson[]
  /** 模型一句话说明改了什么；可能为空 */
  note: string
}

export async function revisePlan(
  config: AIProviderConfig,
  params: {
    topic: string
    lessons: PlanLesson[]
    feedback: string
    requirements?: string
  },
  signal?: AbortSignal,
): Promise<RevisedPlan> {
  const user = [
    `【任务】课程「${params.topic}」的课时规划已拟好，用户提出了修改反馈，请输出修改后的完整规划。`,
    params.requirements?.trim() && `【原始需求（仍然有效）】\n${params.requirements.trim().slice(0, 3000)}`,
    `【当前规划（JSON）】\n${JSON.stringify(params.lessons)}`,
    `【用户反馈（务必尽量满足）】\n${params.feedback.trim().slice(0, 3000)}`,
    '【要求】只改反馈涉及的部分，未涉及的课时保持原样（标题原样保留）；课时总数 4~24 讲；每课时保留 3~6 条要点，被拆分/合并/新增的课时重写要点。',
    '【输出】只输出 JSON：{"lessons":[{"title":"第1讲 …","points":["要点一","要点二"]}],"note":"用一句话向用户说明你改了什么"}',
  ]
    .filter(Boolean)
    .join('\n\n')

  const raw = await chat(config, {
    messages: [
      { role: 'system', content: PLAN_SYSTEM },
      { role: 'user', content: user },
    ],
    json: true,
    temperature: 0.4,
    maxTokens: 4096,
    signal,
  })

  // note 与 lessons 分开取：lessons 走 parsePlan 的容错（含裸数组兜底），note 缺席无碍
  let note = ''
  try {
    const data = JSON.parse(extractJSON(raw)) as { note?: unknown }
    if (typeof data?.note === 'string') note = data.note.trim()
  } catch {
    // 只拿得到裸数组也行，note 留空
  }
  return { lessons: parsePlan(raw), note }
}

/* ───────── 逐课时生成 ───────── */

export interface LessonParams {
  topic: string
  requirements?: string
  /** 全部课时的一览（标题 + 要点） */
  planText: string
  lessonTitle: string
  points: string[]
  lessonNo: number
  total: number
  prevTitle?: string
  nextTitle?: string
  nextFile?: string
  sampleSection: string
  /** 风格 skill 的规范（可为空；注入正文生成） */
  styleGuide?: string
  /** 整书改写：本课时的现有正文（有值即进入改写模式，而非从零写） */
  rewriteOf?: string
  /** 整书改写：用户的整体改写要求 */
  rewriteNote?: string
}

const LESSON_SYSTEM =
  '你是「墨痕」AI 陪学的课件作者，仿照既有课件风格撰写 Markdown 课件正文。' +
  '只输出 Markdown 正文本身：不要任何解释、不要用代码围栏包裹整篇。' +
  '行文风格：讲解详尽、由浅入深、多用比喻与对比；代码块/ASCII 图使用无语言标注的 ``` 围栏（保持等宽碑刻风）；适当使用表格与列表。'

export async function genLesson(
  config: AIProviderConfig,
  params: LessonParams,
  onDelta: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const user = [
    `【课件主题】${params.topic}`,
    params.requirements?.trim() && `【整体需求】\n${params.requirements.trim().slice(0, 3000)}`,
    params.styleGuide?.trim() && `【写作风格规范（skill，必须严格遵循）】\n${params.styleGuide.trim().slice(0, 3000)}`,
    `【全部课时规划】\n${params.planText.slice(0, 2500)}`,
    `【本课时】${params.lessonTitle}（第 ${params.lessonNo + 1} 讲 / 共 ${params.total} 讲，文件名 ${lessonFile(params.lessonNo)}）`,
    params.points.length > 0 && `【本课时要点】\n${params.points.map((p) => `- ${p}`).join('\n')}`,
    params.rewriteOf?.trim() && `【原文（本课时现有正文，整书改写）】\n${params.rewriteOf.trim().slice(0, 6000)}`,
    params.rewriteNote?.trim() && `【整书改写要求（必须严格遵循）】\n${params.rewriteNote.trim().slice(0, 1500)}`,
    (params.rewriteOf?.trim() || params.rewriteNote?.trim()) &&
      '- 整书改写模式：在覆盖原文全部知识点的前提下按改写要求重写；原文中仍合适的比喻/代码/表格可直接沿用，全书文风与信息密度保持统一',
    params.prevTitle && `【上一课时】${params.prevTitle}`,
    params.nextTitle && `【下一课时】${params.nextTitle}（文件名 ${params.nextFile ?? ''}）`,
    '【本课时结构要求】（严格遵循）',
    `- 以「# ${params.lessonTitle}」开头`,
    '- 紧接一行 blockquote：> 本课时目标：……（1~2 行）',
    '- 然后一行 ---',
    '- 正文分 2~5 个 ## 小节，循序渐进；覆盖上面全部要点；包含可运行的示例代码或 ASCII 示意图（用无语言标注 ``` 围栏）',
    '- 末尾必有「## 自我检测」小节：3~6 道编号练习题',
    '- 最后一行：下一讲 → [下一讲标题](下一讲文件名)：一句话预告（若是最后一讲，则改为整门课的两三句结语与后续学习建议）',
    params.sampleSection && `【参考文风样例（一节全文）】\n${params.sampleSection.slice(0, 3000)}`,
  ]
    .filter(Boolean)
    .join('\n\n')

  const raw = await chatStream(
    config,
    {
      messages: [
        { role: 'system', content: LESSON_SYSTEM },
        { role: 'user', content: user },
      ],
      temperature: 0.6,
      maxTokens: 8192,
      signal,
      onDelta,
    },
  )
  return stripFenceWrap(raw)
}

/** 有的模型会把整篇包进 ```markdown 围栏，剥掉（改写结果同样适用） */
export function stripFenceWrap(text: string): string {
  const t = text.trim()
  const m = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/.exec(t)
  return m ? m[1].trim() : t
}

/* ───────── 导航文件（代码拼接，保证目录表可解析） ───────── */

const pad = (n: number): string => String(n).padStart(2, '0')

export function lessonFile(index: number): string {
  return `lesson${pad(index + 1)}.md`
}

export function buildIndexMd(topic: string, lessons: PlanLesson[]): string {
  const rows = lessons.map((l, i) => `| ${pad(i + 1)} | [${l.title}](${lessonFile(i)}) |`)
  return [`# ${topic} · 课时总览`, '', '| # | 课时 |', '|---|------|', ...rows, ''].join('\n')
}

/** 课时规划的纯文本形态（注入正文生成 prompt） */
export function planText(lessons: PlanLesson[]): string {
  return lessons
    .map((l, i) => {
      const pts = l.points.length ? `\n  要点：${l.points.join('；')}` : ''
      return `${pad(i + 1)}. ${l.title}${pts}`
    })
    .join('\n')
}

/* ───────── 续写：从已入库的 INDEX.md 反解课时规划 ───────── */

export interface IndexEntry {
  title: string
  /** 课程内相对文件名（lesson01.md …） */
  file: string
}

/** 解析 buildIndexMd 生成的目录表（续写已入库课件时恢复课时清单） */
export function parseIndexEntries(indexText: string): IndexEntry[] {
  const out: IndexEntry[] = []
  const re = /^\s*\|\s*\d+\s*\|\s*\[([^\]]+)\]\(([^)\s]+)\)\s*\|\s*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(indexText)) !== null) {
    out.push({ title: m[1].trim(), file: m[2].trim() })
  }
  return out
}
