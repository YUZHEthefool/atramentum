/**
 * AI Provider 适配器（原生 fetch，浏览器直连 BYOK）
 *
 * - openai-compatible: OpenAI / DeepSeek / 通义 / 智谱，POST /chat/completions
 * - anthropic: Claude，POST /messages（浏览器直连需 anthropic-dangerous-direct-browser-access 头）
 *
 * 统一接口：
 * - chat()       一次性调用（短请求，如连通性测试）
 * - chatStream() SSE 流式调用（划词问答、逐节生成），onDelta 逐段回调
 * - chatJSONStream() 流式 JSON 调用（课时规划等结构化场景；长请求保持字节流动，
 *   避免非流式长连接被代理掐断的 Failed to fetch）
 * - listModels() 拉取可用模型列表
 * - extractJSON / describeAIError / isAbortError 工具
 */
import type { AIProviderConfig } from '../types/ai'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  messages: ChatMessage[]
  /** 尽力让输出为可 JSON.parse 的文本 */
  json?: boolean
  temperature?: number
  /** 输出 token 上限（Anthropic 必需；OpenAI 兼容端点不传，用各自默认） */
  maxTokens?: number
  signal?: AbortSignal
}

export interface StreamOptions extends ChatOptions {
  onDelta: (chunk: string) => void
}

/* ───────── Agent：带工具调用的流式对话 ───────── */

export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema 形式的参数定义 */
  input_schema: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/** Agent 对话的中立消息形态（由适配器翻译为各协议格式） */
export type AgentMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; id: string; name: string; content: string }

export interface AgentTurn {
  /** 本轮流式输出的文本（工具轮的叙述，或最终回答） */
  text: string
  /** 本轮发起的工具调用；非空则由调用方执行后继续循环 */
  toolCalls: ToolCall[]
}

export interface AgentStreamOptions {
  messages: AgentMessage[]
  tools: ToolSchema[]
  temperature?: number
  signal?: AbortSignal
  onDelta?: (chunk: string) => void
}

/** 流式跑一轮带工具的对话；文本增量走 onDelta，工具调用增量在内部累积成完整调用 */
export async function chatAgentStream(config: AIProviderConfig, opts: AgentStreamOptions): Promise<AgentTurn> {
  if (config.kind === 'anthropic') return chatAgentStreamAnthropic(config, opts)
  return chatAgentStreamOpenAICompatible(config, opts)
}

function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : { _raw: raw }
  } catch {
    return { _raw: raw }
  }
}

function toOpenAIMessages(messages: AgentMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === 'system' || m.role === 'user') return { role: m.role, content: m.content }
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.id, content: m.content }
    const out: Record<string, unknown> = { role: 'assistant', content: m.content || null }
    if (m.toolCalls?.length) {
      out.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      }))
    }
    return out
  })
}

function toAnthropicMessages(messages: AgentMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let pendingResults: Record<string, unknown>[] = []
  const flushResults = () => {
    if (pendingResults.length) {
      out.push({ role: 'user', content: pendingResults })
      pendingResults = []
    }
  }
  for (const m of messages) {
    if (m.role === 'system') continue // 由顶层 system 参数承载
    if (m.role === 'tool') {
      pendingResults.push({ type: 'tool_result', tool_use_id: m.id, content: m.content })
      continue
    }
    flushResults()
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content })
    } else {
      const blocks: Record<string, unknown>[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args })
      out.push({ role: 'assistant', content: blocks.length ? blocks : '' })
    }
  }
  flushResults()
  return out
}

async function chatAgentStreamOpenAICompatible(config: AIProviderConfig, opts: AgentStreamOptions): Promise<AgentTurn> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: toOpenAIMessages(opts.messages),
    temperature: opts.temperature ?? 0.4,
    stream: true,
  }
  if (opts.tools.length) {
    body.tools = opts.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }))
  }
  const res = await postOpenAI(config, body, opts.signal)
  if (!res.ok) throw await toAIError(res, 'API')

  let text = ''
  const pending = new Map<number, { id?: string; name?: string; args: string }>()
  await consumeSSE(res, (data) => {
    if (data === '[DONE]') return
    try {
      const json = JSON.parse(data)
      const delta = json?.choices?.[0]?.delta
      if (typeof delta?.content === 'string' && delta.content) {
        text += delta.content
        opts.onDelta?.(delta.content)
      }
      // 工具调用按分片到达：以 index 聚合，arguments 逐段拼接
      for (const tc of delta?.tool_calls ?? []) {
        const idx = typeof tc.index === 'number' ? tc.index : 0
        const cur = pending.get(idx) ?? { args: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name = tc.function.name
        if (typeof tc.function?.arguments === 'string') cur.args += tc.function.arguments
        pending.set(idx, cur)
      }
    } catch {
      // 心跳/注释等非 JSON 载荷，静默跳过
    }
  })
  const toolCalls: ToolCall[] = []
  for (const [, p] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
    if (!p.name) continue
    toolCalls.push({ id: p.id ?? `call_${p.name}_${toolCalls.length}`, name: p.name, args: parseToolArgs(p.args) })
  }
  return { text, toolCalls }
}

async function chatAgentStreamAnthropic(config: AIProviderConfig, opts: AgentStreamOptions): Promise<AgentTurn> {
  const system = opts.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: 8192,
    temperature: opts.temperature ?? 0.4,
    system,
    messages: toAnthropicMessages(opts.messages),
    stream: true,
  }
  if (opts.tools.length) {
    body.tools = opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }))
  }
  const res = await fetch(`${trimSlash(config.baseURL)}/messages`, {
    method: 'POST',
    headers: anthropicHeaders(config),
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  if (!res.ok) throw await toAIError(res, 'Anthropic')

  let text = ''
  type Block = { kind: 'text' } | { kind: 'tool'; id: string; name: string; args: string }
  const blocks = new Map<number, Block>()
  await consumeSSE(res, (data) => {
    try {
      const json = JSON.parse(data)
      if (json?.type === 'content_block_start') {
        const cb = json.content_block ?? {}
        blocks.set(
          json.index,
          cb.type === 'tool_use'
            ? { kind: 'tool', id: cb.id ?? `toolu_${json.index}`, name: cb.name ?? '', args: '' }
            : { kind: 'text' },
        )
      } else if (json?.type === 'content_block_delta') {
        const b = blocks.get(json.index)
        const d = json.delta ?? {}
        if (b?.kind === 'tool' && d.type === 'input_json_delta' && typeof d.partial_json === 'string') b.args += d.partial_json
        else if (b?.kind === 'text' && d.type === 'text_delta' && typeof d.text === 'string') {
          text += d.text
          opts.onDelta?.(d.text)
        }
      }
    } catch {
      // 非 JSON 行，跳过
    }
  })
  const toolCalls: ToolCall[] = []
  for (const [, b] of blocks) {
    if (b.kind !== 'tool' || !b.name) continue
    toolCalls.push({ id: b.id, name: b.name, args: parseToolArgs(b.args) })
  }
  return { text, toolCalls }
}

/** 带 HTTP 状态的 AI 调用错误（供 describeAIError 分类给用户文案） */
export class AIError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

/** 调用 AI，返回完整文本 */
export async function chat(config: AIProviderConfig, opts: ChatOptions): Promise<string> {
  if (config.kind === 'anthropic') return chatAnthropic(config, opts)
  return chatOpenAICompatible(config, opts)
}

/** 流式调用：onDelta 逐段回调，resolve 为拼接后的完整文本 */
export async function chatStream(config: AIProviderConfig, opts: StreamOptions): Promise<string> {
  if (config.kind === 'anthropic') return chatStreamAnthropic(config, opts)
  return chatStreamOpenAICompatible(config, opts)
}

/** 流式 JSON 调用：强制 JSON 输出（OpenAI response_format / Anthropic tool_choice），
 *  但以 SSE 流式承载——长请求保持字节流动，不被中间层掐断，onDelta 可实时上屏 */
export async function chatJSONStream(config: AIProviderConfig, opts: StreamOptions): Promise<string> {
  if (config.kind === 'anthropic') return chatJSONStreamAnthropic(config, opts)
  return chatJSONStreamOpenAICompatible(config, opts)
}

/* ───────── OpenAI 兼容 ───────── */

async function postOpenAI(config: AIProviderConfig, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  return fetch(`${trimSlash(config.baseURL)}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(body),
    signal,
  })
}

async function chatOpenAICompatible(config: AIProviderConfig, opts: ChatOptions): Promise<string> {
  const buildBody = (json: boolean): Record<string, unknown> => {
    const b: Record<string, unknown> = {
      model: config.model,
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: opts.temperature ?? 0.4,
      stream: false,
    }
    if (json) b.response_format = { type: 'json_object' }
    return b
  }
  return withDeadline(CHAT_DEADLINE_MS, 'API', opts.signal, async (sig) => {
    let res = await postOpenAI(config, buildBody(!!opts.json), sig)
    // 部分端点/模型不支持 response_format（对 json_object 报 400）：去掉后重试一次，
    // system prompt 已强制"只输出 JSON"，由 extractJSON 容错解析
    if (!res.ok && res.status === 400 && opts.json) {
      res = await postOpenAI(config, buildBody(false), sig)
    }
    if (!res.ok) throw await toAIError(res, 'API')
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content) throw new AIError('空响应：模型未返回文本')
    return content
  })
}

async function chatStreamOpenAICompatible(config: AIProviderConfig, opts: StreamOptions): Promise<string> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: opts.temperature ?? 0.4,
    stream: true,
  }
  const res = await postOpenAI(config, body, opts.signal)
  if (!res.ok) throw await toAIError(res, 'API')

  let full = ''
  await consumeSSE(res, (data) => {
    if (data === '[DONE]') return
    try {
      const json = JSON.parse(data)
      // 兼容 delta.content 与 message.content（部分网关流式下仍回 message）
      const delta = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content ?? ''
      if (typeof delta === 'string' && delta) {
        full += delta
        opts.onDelta(delta)
      }
    } catch {
      // 心跳/注释等非 JSON 载荷，静默跳过
    }
  })
  return full
}

async function chatJSONStreamOpenAICompatible(config: AIProviderConfig, opts: StreamOptions): Promise<string> {
  const buildBody = (json: boolean): Record<string, unknown> => {
    const b: Record<string, unknown> = {
      model: config.model,
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: opts.temperature ?? 0.4,
      stream: true,
    }
    if (json) b.response_format = { type: 'json_object' }
    return b
  }
  // 部分端点/模型不支持 response_format（对 json_object 报 400）：去掉后重试一次，
  // system prompt 已强制"只输出 JSON"，由 extractJSON 容错解析
  let res = await postOpenAI(config, buildBody(true), opts.signal)
  if (!res.ok && res.status === 400) {
    await res.body?.cancel().catch(() => {})
    res = await postOpenAI(config, buildBody(false), opts.signal)
  }
  if (!res.ok) throw await toAIError(res, 'API')

  let full = ''
  await consumeSSE(res, (data) => {
    if (data === '[DONE]') return
    try {
      const json = JSON.parse(data)
      const delta = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content ?? ''
      if (typeof delta === 'string' && delta) {
        full += delta
        opts.onDelta(delta)
      }
    } catch {
      // 心跳/注释等非 JSON 载荷，静默跳过
    }
  })
  if (!full) throw new AIError('空响应：模型未返回文本')
  return full
}

/* ───────── Anthropic ───────── */

function anthropicHeaders(config: AIProviderConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': config.apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  }
}

async function chatAnthropic(config: AIProviderConfig, opts: ChatOptions): Promise<string> {
  const system = opts.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const messages = opts.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }))

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: opts.maxTokens ?? 8192,
    temperature: opts.temperature ?? 0.4,
    system,
    messages,
  }
  // 强制 JSON：用 tool_use 承载（Claude 对纯提示的 JSON 服从性不稳定）
  if (opts.json) {
    body.tools = [{
      name: 'emit_json',
      description: 'Emit the structured JSON result.',
      input_schema: { type: 'object', additionalProperties: true },
    }]
    body.tool_choice = { type: 'tool', name: 'emit_json' }
  }

  return withDeadline(CHAT_DEADLINE_MS, 'Anthropic', opts.signal, async (sig) => {
    const res = await fetch(`${trimSlash(config.baseURL)}/messages`, {
      method: 'POST',
      headers: anthropicHeaders(config),
      body: JSON.stringify(body),
      signal: sig,
    })
    if (!res.ok) throw await toAIError(res, 'Anthropic')
    const data = await res.json()
    // 强制 tool_choice 下 Claude 仍可能先吐文本前导，必须优先取 tool_use 块
    let text: string | null = null
    for (const block of data?.content ?? []) {
      if (block.type === 'tool_use' && block.input) return JSON.stringify(block.input)
      if (text === null && block.type === 'text' && typeof block.text === 'string') text = block.text
    }
    if (text !== null) return text
    throw new AIError('Anthropic 空响应')
  })
}

async function chatStreamAnthropic(config: AIProviderConfig, opts: StreamOptions): Promise<string> {
  const system = opts.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const messages = opts.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }))

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: opts.maxTokens ?? 8192,
    temperature: opts.temperature ?? 0.4,
    system,
    messages,
    stream: true,
  }
  const res = await fetch(`${trimSlash(config.baseURL)}/messages`, {
    method: 'POST',
    headers: anthropicHeaders(config),
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  if (!res.ok) throw await toAIError(res, 'Anthropic')

  let full = ''
  await consumeSSE(res, (data) => {
    try {
      const json = JSON.parse(data)
      // 只取正文增量；ping / message_start / message_delta(用量) 等一律忽略
      if (json?.type === 'content_block_delta' && json?.delta?.type === 'text_delta' && typeof json.delta.text === 'string') {
        full += json.delta.text
        opts.onDelta(json.delta.text)
      }
    } catch {
      // 非 JSON 行，跳过
    }
  })
  return full
}

/** 流式 + 强制 JSON：tool_use 承载（Claude 对纯提示的 JSON 服从性不稳定），
 *  input_json_delta 逐段拼出 JSON 文本；流式保持连接活性 */
async function chatJSONStreamAnthropic(config: AIProviderConfig, opts: StreamOptions): Promise<string> {
  const system = opts.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const messages = opts.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }))

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: opts.maxTokens ?? 8192,
    temperature: opts.temperature ?? 0.4,
    system,
    messages,
    stream: true,
    tools: [{
      name: 'emit_json',
      description: 'Emit the structured JSON result.',
      input_schema: { type: 'object', additionalProperties: true },
    }],
    tool_choice: { type: 'tool', name: 'emit_json' },
  }
  const res = await fetch(`${trimSlash(config.baseURL)}/messages`, {
    method: 'POST',
    headers: anthropicHeaders(config),
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  if (!res.ok) throw await toAIError(res, 'Anthropic')

  let full = ''
  await consumeSSE(res, (data) => {
    try {
      const json = JSON.parse(data)
      // JSON 由 tool_use 块的 input_json_delta 逐段承载；text 前导若有也收下（extractJSON 容错）
      if (json?.type === 'content_block_delta' && json?.delta?.type === 'input_json_delta' && typeof json.delta.partial_json === 'string') {
        full += json.delta.partial_json
        opts.onDelta(json.delta.partial_json)
      } else if (json?.type === 'content_block_delta' && json?.delta?.type === 'text_delta' && typeof json.delta.text === 'string') {
        opts.onDelta(json.delta.text)
      }
    } catch {
      // 非 JSON 行，跳过
    }
  })
  if (!full) throw new AIError('Anthropic 空响应')
  return full
}

/* ───────── SSE 解析 ───────── */

/** 流空闲上限：持续这么久没收到任何字节才判定连接被对端挂起，主动断开（推理模型思考间隙可很长，故给足 10 分钟） */
const SSE_IDLE_MS = 600_000

/** 带空闲看门狗的单次 read：超时后取消流并抛错，避免 fetch 永久挂起 */
async function readWithIdleGuard(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const read = reader.read()
  read.catch(() => {}) // 看门狗胜出后 reader.cancel() 会让 read 拒绝，预挂空 catch 防未处理拒绝
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new AIError(`流式响应超过 ${Math.round(SSE_IDLE_MS / 1000)} 秒无数据，连接疑似已被对端挂起，已中断`)),
          SSE_IDLE_MS,
        )
      }),
    ])
  } catch (e) {
    void reader.cancel().catch(() => {})
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 消费 SSE 响应体：逐行抽出 data: 载荷回调（event:/注释/空行两类协议都不需要） */
async function consumeSSE(res: Response, onData: (data: string) => void): Promise<void> {
  const reader = res.body?.getReader()
  if (!reader) throw new AIError('响应无内容流（可能被浏览器扩展或代理拦截）')
  const decoder = new TextDecoder()
  let buf = ''
  const handleLine = (line: string) => {
    if (line.startsWith('data:')) onData(line.slice(5).trim())
  }
  for (;;) {
    const { done, value } = await readWithIdleGuard(reader)
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, nl).replace(/\r$/, ''))
      buf = buf.slice(nl + 1)
    }
  }
  buf += decoder.decode()
  if (buf) handleLine(buf.replace(/\r$/, ''))
}

/* ───────── 错误与工具 ───────── */

/** 非流式调用的整体超时：非流没有逐字节可观测，只能按时长兜底（到点中止请求并抛错） */
const CHAT_DEADLINE_MS = 600_000

/** 在时限内执行一个接收 signal 的异步任务；超时以 AIError 中止底层请求，外部 signal 同步转发 */
async function withDeadline<T>(
  ms: number,
  label: string,
  external: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort(external?.reason)
  if (external) {
    if (external.aborted) ctrl.abort(external.reason)
    else external.addEventListener('abort', onAbort)
  }
  const timer = setTimeout(
    () => ctrl.abort(new AIError(`${label}请求超过 ${Math.round(ms / 1000)} 秒未完成，已中止`)),
    ms,
  )
  try {
    return await run(ctrl.signal)
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', onAbort)
  }
}

async function toAIError(res: Response, label: string): Promise<AIError> {
  const text = await res.text().catch(() => res.statusText)
  return new AIError(`${label} ${res.status}: ${text.slice(0, 300)}`, res.status)
}

/** 把各种失败归因为用户可操作的中文提示 */
export function describeAIError(e: unknown): string {
  if (isAbortError(e)) return '已停止'
  if (e instanceof AIError) {
    const s = e.status
    if (s === 401 || s === 403) return `鉴权失败（${s}）：API Key 无效或无权限，请到设置里检查密钥。`
    if (s === 404) return '端点不存在（404）：请检查请求地址是否完整（通常需含 /v1 等版本路径）。'
    if (s === 429) return '触发限流（429）：请求过于频繁或余额不足，请稍后再试。'
    if (s !== undefined && s >= 500) return `服务端错误（${s}）：模型服务暂不可用，请稍后再试。`
    return e.message
  }
  if (e instanceof TypeError) {
    return '网络请求失败：可能是 CORS 拦截或地址不可达。浏览器直连要求端点允许跨域；也可自建代理后填入代理地址。'
  }
  return (e as Error)?.message ?? String(e)
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '')
}

/** 从 AI 文本中尽力提取 JSON（兼容 ```json 包裹与前后缀噪声） */
export function extractJSON(raw: string): string {
  let s = raw.trim()
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  }
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start >= 0 && end > start) return s.slice(start, end + 1)
  return s
}

/* ───────── 拉取可用模型列表 ───────── */

export async function listModels(config: AIProviderConfig): Promise<string[]> {
  if (config.kind === 'anthropic') {
    const res = await fetch(`${trimSlash(config.baseURL)}/models?limit=100`, {
      headers: { ...anthropicHeaders(config), Accept: 'application/json' },
    })
    if (!res.ok) throw await toAIError(res, '拉取模型失败')
    const data = await res.json()
    return (Array.isArray(data?.data) ? data.data : []).map((m: { id?: string }) => m.id).filter(Boolean) as string[]
  }
  const res = await fetch(`${trimSlash(config.baseURL)}/models`, {
    headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
  })
  if (!res.ok) throw await toAIError(res, '拉取模型失败')
  const data = await res.json()
  const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : []
  return arr
    .map((m: { id?: string; model?: string; name?: string }) => m.id || m.model || m.name)
    .filter(Boolean) as string[]
}
