/**
 * 风格 skill 提炼：把现有课件（目录 + 样例节）交给 AI 总结成可复用的「写作风格规范」，
 * 保存为 skill 后在 AI 著书时注入生成 prompt。
 */
import { chatStream } from '../ai/providers'
import type { AIProviderConfig } from '../types/ai'

const DISTILL_SYSTEM =
  '你是「墨痕」AI 陪学的课件风格分析师。只输出风格规范正文（Markdown），不要解释、不要寒暄。'

/** 从课件提炼风格规范（返回 Markdown 文本） */
export async function distillSkill(
  config: AIProviderConfig,
  params: { courseTitle: string; indexText: string; sampleSection: string },
  signal?: AbortSignal,
): Promise<string> {
  const user = [
    `【任务】通读以下课件材料，提炼一份可复用的「写作风格规范」，供 AI 今后以完全相同的风格撰写新课件。`,
    `【课件】${params.courseTitle}`,
    params.indexText && `【目录结构】\n${params.indexText.slice(0, 2500)}`,
    params.sampleSection && `【样例节全文（重点分析对象）】\n${params.sampleSection.slice(0, 4500)}`,
    '【输出要求】Markdown，依次包含：',
    '## 文风与语气（称谓、口吻、详略、比喻与类比习惯，附典型句式 2~3 例）',
    '## 结构骨架（必须遵守的节模板：H1 标题 / blockquote 本节目标 / --- 分隔 / ## 小节的组织方式 / 自我检测练习的形式与数量 / 尾部导航的写法）',
    '## 代码与图示规范（代码块语言标注习惯、ASCII 示意图的使用场景与画法风格、表格用法）',
    '## 语言与格式（标点习惯、列表与表格密度、段落长度、术语处理）',
    '## 禁忌（这种风格里不会出现的东西）',
    '要求具体、可执行、带样例；总长 800~1500 字。',
  ]
    .filter(Boolean)
    .join('\n\n')

  const raw = await chatStream(config, {
    messages: [
      { role: 'system', content: DISTILL_SYSTEM },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
    maxTokens: 4096,
    signal,
    onDelta: () => {},
  })
  return stripFence(raw)
}

function stripFence(text: string): string {
  const t = text.trim()
  const m = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/.exec(t)
  return m ? m[1].trim() : t
}
