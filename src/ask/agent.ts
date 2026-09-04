/**
 * 问 AI 的 Agent 层（仿 Codex 工作流）：
 * 给模型一组只读课件工具（浏览目录 / 读文件 / 全文检索），循环「模型 → 工具 → 模型」
 * 直到给出最终回答。过程通过 onStep / onTurn 回调以步骤流形式暴露给 UI。
 */
import { chatAgentStream } from '../ai/providers'
import type { AgentMessage, ToolCall, ToolSchema } from '../ai/providers'
import type { AIProviderConfig } from '../types/ai'

/** 课程文件的只读访问口（由 AskPanel 基于当前课件 meta 提供） */
export interface CourseFiles {
  /** 课程内全部文件相对路径 */
  listFiles(): Promise<string[]>
  /** 读单文件全文；不存在返回 null */
  readFile(path: string): Promise<string | null>
}

export type StepStatus = 'running' | 'done' | 'error'

export interface AgentStep {
  /** 工具调用 id（一轮内唯一），UI 按 key upsert */
  key: string
  /** 一句话描述，如「读取 lesson01.md · 3.4k 字」 */
  label: string
  /** 展开可见的工具原始输出节选 */
  detail?: string
  status: StepStatus
}

/** 工作流时间线条目：步骤行与模型轮间叙述 */
export type FlowItem = { kind: 'step'; step: AgentStep } | { kind: 'note'; text: string }

const MAX_ROUNDS = 8
const READ_LIMIT = 8000 // read 单次返回上限（字符）
const SEARCH_MATCH_CAP = 10 // search 命中上限
const SEARCH_FILE_CAP = 150 // search 最多扫描的文件数
const STEP_DETAIL_LIMIT = 800 // 步骤详情展示的字符上限

const TOOLS: ToolSchema[] = [
  {
    name: 'list_course_files',
    description: '列出当前课件内的全部文件路径（含目录 INDEX.md），用于了解课程结构',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_course_file',
    description: '读取课件内某个文件的全文（超长会截断）。路径来自 list_course_files',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件相对路径，如 lesson01.md' } },
      required: ['path'],
    },
  },
  {
    name: 'search_course',
    description: '在课件全部文件中检索关键词，返回命中文件、行号与该行内容。跨节/跨文件找信息时优先用它',
    input_schema: {
      type: 'object',
      properties: { keyword: { type: 'string', description: '要检索的关键词' } },
      required: ['keyword'],
    },
  },
]

function fmtChars(n: number): string {
  return n < 1000 ? `${n} 字` : `${(n / 1000).toFixed(1)}k 字`
}

async function searchCourse(
  keyword: string,
  files: CourseFiles,
  cache: Map<string, string>,
): Promise<{ text: string; hits: number }> {
  const paths = await files.listFiles()
  const lines: string[] = []
  let hits = 0
  let scanned = 0
  let truncated = false
  for (const p of paths) {
    if (hits >= SEARCH_MATCH_CAP || scanned >= SEARCH_FILE_CAP) {
      truncated = true
      break
    }
    let text = cache.get(p)
    if (text === undefined) {
      text = (await files.readFile(p)) ?? ''
      cache.set(p, text)
    }
    if (!text) continue
    scanned++
    const ls = text.split('\n')
    for (let i = 0; i < ls.length; i++) {
      if (ls[i].includes(keyword)) {
        hits++
        lines.push(`${p}:${i + 1}  ${ls[i].trim().slice(0, 160)}`)
        if (hits >= SEARCH_MATCH_CAP) break
      }
    }
  }
  const head = `共命中 ${hits} 处${truncated ? `（扫描在 ${scanned} 个文件后提前停止）` : ''}`
  return { text: lines.length ? `${head}：\n${lines.join('\n')}` : `${head}：无`, hits }
}

/** 执行一个工具调用，返回展示标签与给模型的结果文本 */
async function execTool(
  call: ToolCall,
  files: CourseFiles,
  cache: Map<string, string>,
): Promise<{ label: string; result: string }> {
  if (call.name === 'list_course_files') {
    const paths = await files.listFiles()
    const shown = paths.slice(0, 400)
    return {
      label: `浏览目录 · ${paths.length} 个文件`,
      result: `${paths.length} 个文件：\n${shown.join('\n')}${paths.length > shown.length ? '\n…' : ''}`,
    }
  }
  if (call.name === 'read_course_file') {
    const p = String(call.args.path ?? '').trim()
    if (!p) return { label: '读取 · 缺少文件路径', result: '错误：缺少 path 参数' }
    let text = cache.get(p)
    if (text === undefined) {
      text = (await files.readFile(p)) ?? ''
      cache.set(p, text)
    }
    if (!text) return { label: `读取 ${p} · 无内容`, result: `文件 ${p} 不存在或为空` }
    return {
      label: `读取 ${p} · ${fmtChars(text.length)}`,
      result:
        text.length > READ_LIMIT
          ? `${text.slice(0, READ_LIMIT)}\n…（已截断，全文 ${text.length} 字符）`
          : text,
    }
  }
  if (call.name === 'search_course') {
    const kw = String(call.args.keyword ?? call.args.query ?? call.args.q ?? '').trim()
    if (!kw) return { label: '检索 · 缺少关键词', result: '错误：缺少 keyword 参数' }
    const out = await searchCourse(kw, files, cache)
    return { label: `检索「${kw.slice(0, 20)}」 · ${out.hits} 处命中`, result: out.text }
  }
  return { label: `未知工具 ${call.name}`, result: `未知工具：${call.name}` }
}

export interface AskAgentParams {
  config: AIProviderConfig
  courseTitle: string
  sectionTitle?: string
  /** 首条用户消息（自由提问载荷 / 划词载荷 / 追问原文） */
  question: string
  /** 追问时携带的前几轮问答（q 为展示用短文本） */
  history?: { q: string; a: string }[]
  /** 课件文件访问口；为空则退化为普通流式问答（不提供工具） */
  files?: CourseFiles | null
  signal: AbortSignal
  /** 流式增量（最终回答与工具轮叙述都走这里） */
  onDelta: (chunk: string) => void
  /** 工具步骤 upsert（按 step.key） */
  onStep: (step: AgentStep) => void
  /** 每轮模型输出结束回调；final=false 表示这是工具轮的叙述（非最终回答） */
  onTurn?: (text: string, final: boolean) => void
}

/** 跑完整 agent 循环，resolve 为最终回答全文 */
export async function runAskAgent(params: AskAgentParams): Promise<string> {
  const { config, files, signal, onDelta, onStep, onTurn } = params
  const hasTools = !!files

  const sys = [
    `你是「墨痕」AI 陪学助手，正在陪用户阅读课件《${params.courseTitle}》。`,
    hasTools
      ? '你可以调用只读工具浏览、检索这份课件来回答问题；工具使用要克制：本节上下文已够就直接回答，需要跨节/跨文件信息时先 search_course 再 read_course_file 精读。'
      : '请基于用户提供的上下文与通识回答。',
    params.sectionTitle && `用户当前正在阅读小节：${params.sectionTitle}。`,
    '回答要求：中文 Markdown，先给结论再展开；引用课件内容时注明来源文件名；课件里没有的用通识补充并注明「课件外补充」。不要寒暄。',
  ]
    .filter(Boolean)
    .join('\n')

  const messages: AgentMessage[] = [
    { role: 'system', content: sys },
    ...((params.history ?? []).flatMap((h) => [
      { role: 'user' as const, content: h.q },
      { role: 'assistant' as const, content: h.a },
    ])),
    { role: 'user', content: params.question },
  ]

  const cache = new Map<string, string>()
  let acc = ''

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const turn = await chatAgentStream(config, {
      messages,
      tools: hasTools ? TOOLS : [],
      temperature: 0.4,
      signal,
      onDelta,
    })
    onTurn?.(turn.text, turn.toolCalls.length === 0)
    if (turn.toolCalls.length === 0 || signal.aborted) {
      return turn.text || acc
    }
    acc += turn.text
    messages.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls })
    for (const call of turn.toolCalls) {
      onStep({ key: call.id, label: `调用 ${call.name}…`, status: 'running' })
      let result: string
      try {
        const out = await execTool(call, files!, cache)
        onStep({ key: call.id, label: out.label, detail: out.result.slice(0, STEP_DETAIL_LIMIT), status: 'done' })
        result = out.result
      } catch (e) {
        result = `工具执行失败：${(e as Error).message}`
        onStep({ key: call.id, label: `调用 ${call.name} 失败`, detail: result, status: 'error' })
      }
      messages.push({ role: 'tool', id: call.id, name: call.name, content: result })
    }
  }

  // 轮数用尽：不带工具强制收束
  messages.push({ role: 'user', content: '请停止调用工具，立刻根据已掌握的信息给出最终回答。' })
  const final = await chatAgentStream(config, { messages, tools: [], temperature: 0.4, signal, onDelta })
  return final.text || acc
}
