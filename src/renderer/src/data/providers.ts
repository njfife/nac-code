// Provider catalog for the model/provider modal. "Provider" here = an agentic harness NAC Code wraps
// (per the architecture: wrapper, never a harness). Local models appear under the OpenCode carrier.
// Availability comes from the live CliRegistry probe (registry:providers, via useProviderProbe — shared
// by ModelModal and the Inspector's CLI Connections panel); model/effort capability data comes from
// `caps` (Task 6 store + shared/capabilities.ts STATIC_CAPABILITIES). This catalog is presentation-only:
// id/name/detail/dot/options. No static connection status ships here (M0-5 honesty sweep) — the only
// real states a live probe can report are `installed` / `not installed`, plus `error` when the probe
// itself couldn't run (e.g. no preload bridge). ConnStatus + STATUS_LABEL/STATUS_COLOR below exist for
// the Inspector to render those real states consistently.

export type ConnStatus = 'authenticated' | 'not-installed' | 'error'

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
  options: OptionDef[]
}

const EFFORT: OptionDef = { id: 'effort', label: 'Effort', kind: 'enum' }

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    detail: 'claude · subscription',
    dot: '#d97757',
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
    options: [{ ...EFFORT, note: 'model_reasoning_effort' }]
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    detail: 'copilot · subscription',
    dot: '#8957e5',
    options: [{ ...EFFORT, note: '--reasoning-effort' }]
  },
  {
    id: 'opencode',
    name: 'OpenCode (local carrier)',
    detail: 'opencode → LM Studio',
    dot: '#46cf8b',
    options: [{ ...EFFORT, note: '--variant · model-dependent' }]
  }
]

export const STATUS_LABEL: Record<ConnStatus, string> = {
  authenticated: 'authenticated',
  'not-installed': 'not installed',
  error: 'error'
}

export const STATUS_COLOR: Record<ConnStatus, string> = {
  authenticated: 'var(--success)',
  'not-installed': 'var(--faint)',
  error: 'var(--warning)'
}
