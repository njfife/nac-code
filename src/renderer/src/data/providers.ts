// Provider catalog for the model/provider modal. "Provider" here = an agentic harness NAC Code wraps
// (per the architecture: wrapper, never a harness). Local models appear under the OpenCode carrier.
// Static for now; real discovery comes from CliRegistry (M4).

export type ConnStatus = 'authenticated' | 'expired' | 'not-authenticated' | 'not-installed'

export interface ModelDef {
  id: string
  label: string
}

export interface ProviderDef {
  id: string
  name: string
  detail: string
  dot: string
  status: ConnStatus
  models: ModelDef[]
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    detail: 'claude · subscription',
    dot: '#d97757',
    status: 'authenticated',
    models: [
      { id: 'opus-4.8', label: 'Opus 4.8' },
      { id: 'sonnet-4.6', label: 'Sonnet 4.6' },
      { id: 'haiku-4.5', label: 'Haiku 4.5' }
    ]
  },
  {
    id: 'codex',
    name: 'Codex',
    detail: 'codex exec · subscription',
    dot: '#10a37f',
    status: 'authenticated',
    models: [{ id: 'gpt-5-codex', label: 'gpt-5-codex' }]
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    detail: 'copilot · subscription',
    dot: '#8957e5',
    status: 'authenticated',
    models: [
      { id: 'auto', label: 'Auto' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' }
    ]
  },
  {
    id: 'cursor',
    name: 'Cursor',
    detail: 'cursor-agent · ACP',
    dot: '#5fb3e3',
    status: 'expired',
    models: [{ id: 'composer', label: 'Composer' }]
  },
  {
    id: 'opencode',
    name: 'OpenCode (local carrier)',
    detail: 'opencode → LM Studio',
    dot: '#46cf8b',
    status: 'authenticated',
    models: [
      { id: 'opencode/deepseek-v4-flash-free', label: 'DeepSeek V4 Flash (free)' },
      { id: 'lmstudio/qwen/qwen3-coder-30b', label: 'Qwen3 Coder 30B (local)' },
      { id: 'lmstudio-remote/qwen/qwen3.6-27b', label: 'qwen3.6-27b (remote)' }
    ]
  }
]

// Map a provider + a model's display label back to the harness model id (for --model).
export function modelIdFor(provider: string, label: string): string | undefined {
  return PROVIDERS.find((p) => p.id === provider)?.models.find((m) => m.label === label)?.id
}

export const STATUS_LABEL: Record<ConnStatus, string> = {
  authenticated: 'Authenticated',
  expired: 'Expired',
  'not-authenticated': 'Not authenticated',
  'not-installed': 'Not installed'
}

export const STATUS_COLOR: Record<ConnStatus, string> = {
  authenticated: 'var(--success)',
  expired: 'var(--warning)',
  'not-authenticated': 'var(--error)',
  'not-installed': 'var(--faint)'
}
