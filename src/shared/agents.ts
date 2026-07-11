// Harness-native agent discovery + NAC-authored sync (spec: docs/superpowers/specs/2026-07-10-agent-picker-design.md).
// One neutral shape for every provider, mirroring ProviderCapabilities.

export interface DiscoveredAgent {
  id: string // provider-unique: the name the harness knows (what --agent / mode value receives)
  name: string
  description?: string
  source: 'user' | 'project' | 'plugin' | 'builtin' | 'nac' // 'nac' = file carries the managed-by marker
  selectable: boolean // false for all copilot agents (its ACP surface doesn't expose --agent)
}

export interface ProviderAgents {
  provider: string
  support: 'full' | 'sync-only' | 'none'
  agents: DiscoveredAgent[]
  note?: string // the honest badge text rendered under the list
  fetchedAt: number
}

// NAC-authored agent (persisted in nac-state via the renderer store). rev bumps on edit —
// the sync engine writes it into each harness's native format (context-library rev pattern).
export interface NacAgent {
  id: string // u_ag_<ts>_<n>
  name: string // display name; slugify(name) is the on-disk filename + harness-facing id
  description: string
  prompt: string // the system-prompt body
  rev: number
}

export type SyncAction = 'written' | 'skipped' | 'conflict' | 'error' | 'pruned'
export interface SyncReportEntry {
  provider: 'claude' | 'copilot' | 'opencode'
  agentId: string // NacAgent.id, or the slug for prunes of orphaned marker files
  action: SyncAction
  detail?: string
}

export const AGENTS_CHANNELS = {
  get: 'agents:get',
  sync: 'agents:sync'
} as const

/** Filesystem/harness-safe slug: lowercase, non-alphanumerics → '-', runs collapsed, trimmed. */
export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s || 'agent'
}
