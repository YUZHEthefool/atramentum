// AI 接入类型：BYOK——用户自填端点与密钥，浏览器直连，仅存本机 localStorage
//
// Provider 抽象：两类适配器
// - openai-compatible: 可配置 baseURL + model，覆盖 OpenAI / DeepSeek / 通义 / 智谱
// - anthropic: Claude，浏览器直连需 anthropic-dangerous-direct-browser-access header

export type ProviderKind = 'openai-compatible' | 'anthropic'

/** 预置端点（用户也可自定义 baseURL） */
export interface PresetEndpoint {
  id: string
  label: string
  kind: ProviderKind
  baseURL: string
  defaultModel: string
  models: string[]
  apiKeyURL: string // 引导用户去拿 key 的地址
}

export const PRESET_ENDPOINTS: PresetEndpoint[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai-compatible',
    baseURL: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    apiKeyURL: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o'],
    apiKeyURL: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'qwen',
    label: '通义千问 (DashScope)',
    kind: 'openai-compatible',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
    apiKeyURL: 'https://dashscope.console.aliyun.com/apiKey',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    kind: 'openai-compatible',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-plus',
    models: ['glm-4-plus', 'glm-4-flash'],
    apiKeyURL: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    kind: 'anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-5',
    models: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'],
    apiKeyURL: 'https://console.anthropic.com/settings/keys',
  },
]

export interface AIProviderConfig {
  kind: ProviderKind
  baseURL: string
  apiKey: string
  model: string
}
