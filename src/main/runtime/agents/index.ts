import type { ProviderAgents } from '../../../shared/agents'
import { discoverClaudeAgents } from './claude'
import { discoverCopilotAgents } from './copilot'
import { discoverOpenCodeAgents } from './opencode'
import { codexAgents } from './codex'

// Coalesced per-(provider,cwd) fetches, mirroring capabilities/index.ts. Discovery never rejects —
// every strategy already degrades internally; this floor covers an unknown provider id.
const cache = new Map<string, Promise<ProviderAgents>>()

async function fetchAgents(provider: string, cwd: string | undefined): Promise<ProviderAgents> {
  try {
    if (provider === 'claude') return await discoverClaudeAgents(cwd)
    if (provider === 'copilot') return await discoverCopilotAgents(cwd)
    if (provider === 'opencode') return await discoverOpenCodeAgents(cwd)
    if (provider === 'codex') return codexAgents()
  } catch {
    // strategies shouldn't throw; belt-and-braces floor below
  }
  return { provider, support: 'none', agents: [], fetchedAt: Date.now() }
}

export function getAgents(provider: string, cwd: string | undefined, refresh = false): Promise<ProviderAgents> {
  const key = `${provider}:${cwd ?? ''}`
  if (!refresh && cache.has(key)) return cache.get(key)!
  const fetch = fetchAgents(provider, cwd)
  cache.set(key, fetch)
  return fetch
}

/** Drop cached discovery (all cwds for the provider; no provider = everything) — sync calls this. */
export function invalidateAgents(provider?: string): void {
  for (const key of [...cache.keys()]) if (!provider || key.startsWith(`${provider}:`)) cache.delete(key)
}
