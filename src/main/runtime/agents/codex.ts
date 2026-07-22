import type { ProviderAgents } from '../../../shared/agents'

// Probe 2026-07-10 (codex 0.142.3): -p/--profile layers a config file; AGENTS.md is context, not a
// persona. There is no agent concept to discover — this is the honest static answer.
export function codexAgents(): ProviderAgents {
  return { provider: 'codex', support: 'none', agents: [], note: 'Codex has no agent concept (profiles are config presets)', fetchedAt: Date.now() }
}
