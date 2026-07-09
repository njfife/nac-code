// Provider catalog for the model/provider modal. "Provider" here = an agentic harness NAC Code wraps
// (per the architecture: wrapper, never a harness). Local models appear under the OpenCode carrier.
// Availability comes from the live CliRegistry probe (registry:providers); model/effort capability data
// now comes from `caps` (Task 6 store + shared/capabilities.ts STATIC_CAPABILITIES) — this catalog is
// presentation-only. `status` remains only as the Inspector's static view.

export type ConnStatus = 'authenticated' | 'expired' | 'not-authenticated' | 'not-installed'

// A per-provider capability the UI can set on the active chat. `effort` binds to chat.effort
// (provider-real scale; null = harness default); `fast` binds to chat.fast (Claude-only in v1).
export interface OptionDef {
  id: 'effort' | 'fast'
  label: string
  kind: 'enum' | 'toggle'
  note?: string
}

export interface ProviderDef {
  id: string
  name: string
  detail: string
  dot: string
  status: ConnStatus
  options: OptionDef[]
}

const EFFORT: OptionDef = { id: 'effort', label: 'Effort', kind: 'enum' }

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    detail: 'claude · subscription',
    dot: '#d97757',
    status: 'authenticated',
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
    options: [{ ...EFFORT, note: 'model_reasoning_effort' }]
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    detail: 'copilot · subscription',
    dot: '#8957e5',
    status: 'authenticated',
    options: [{ ...EFFORT, note: '--reasoning-effort' }]
  },
  {
    id: 'opencode',
    name: 'OpenCode (local carrier)',
    detail: 'opencode → LM Studio',
    dot: '#46cf8b',
    status: 'authenticated',
    options: [{ ...EFFORT, note: '--variant · model-dependent' }]
  }
]

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
