// Provider catalog for the model/provider modal. "Provider" here = an agentic harness NAC Code wraps
// (per the architecture: wrapper, never a harness). Local models appear under the OpenCode carrier.
// Availability comes from the live CliRegistry probe (registry:providers); this catalog carries the
// capability metadata (models, variants, options). `status` remains only as the Inspector's static view.

export type ConnStatus = 'authenticated' | 'expired' | 'not-authenticated' | 'not-installed'

export interface ModelVariant {
  id: string
  label: string
}

export interface ModelDef {
  id: string
  label: string
  variants?: ModelVariant[] // e.g. Sonnet 1M context — selected like a model, maps to its own id
}

// A per-provider capability the UI can set on the active chat. `effort` binds to chat.thinking
// (universal scale; 'none' = harness default); `fast` binds to chat.fast (Claude-only in v1).
export interface OptionDef {
  id: 'effort' | 'fast'
  label: string
  kind: 'enum' | 'toggle'
  values?: string[]
  note?: string
}

export interface ProviderDef {
  id: string
  name: string
  detail: string
  dot: string
  status: ConnStatus
  models: ModelDef[]
  options: OptionDef[]
}

const EFFORT: OptionDef = { id: 'effort', label: 'Effort', kind: 'enum', values: ['none', 'low', 'medium', 'high'] }

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    detail: 'claude · subscription',
    dot: '#d97757',
    status: 'authenticated',
    models: [
      { id: 'opus', label: 'Opus 4.8' },
      { id: 'sonnet', label: 'Sonnet 4.6', variants: [{ id: 'sonnet[1m]', label: 'Sonnet 4.6 · 1M' }] },
      { id: 'haiku', label: 'Haiku 4.5' }
    ],
    options: [
      { ...EFFORT, note: '--effort' },
      { id: 'fast', label: 'Fast mode', kind: 'toggle', note: 'research preview · Opus' }
    ]
  },
  {
    id: 'codex',
    name: 'Codex',
    detail: 'codex exec · subscription',
    dot: '#10a37f',
    status: 'authenticated',
    models: [{ id: 'gpt-5-codex', label: 'gpt-5-codex' }],
    options: [{ ...EFFORT, note: 'model_reasoning_effort' }]
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
    ],
    options: [{ ...EFFORT, note: '--reasoning-effort · plan-gated models fail with the real error' }]
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
    ],
    options: [{ ...EFFORT, note: '--variant · model-dependent' }]
  }
]

// Map a provider + a model's (or variant's) display label back to the harness model id (for --model).
export function modelIdFor(provider: string, label: string): string | undefined {
  const models = PROVIDERS.find((p) => p.id === provider)?.models ?? []
  for (const m of models) {
    if (m.label === label) return m.id
    const v = m.variants?.find((x) => x.label === label)
    if (v) return v.id
  }
  // Discovered models (OpenCode) use the raw `provider/model` id as their display label.
  if (provider === 'opencode' && label.includes('/')) return label
  return undefined
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
