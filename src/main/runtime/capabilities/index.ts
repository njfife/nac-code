import { STATIC_CAPABILITIES } from '../../../shared/capabilities'
import type { ProviderCapabilities } from '../../../shared/runtime'
import { discoverCodex } from './codex'
import { discoverCopilot } from './copilot'
import { discoverClaude } from './claude'
import { discoverOpenCode } from './opencode'
import { mergeLedger, type Ledger } from './ledger'

// Degradation ladder: protocol → static+learned → static. Never rejects.
type Strategy = () => Promise<ProviderCapabilities | null>

/** Pure + exported for testing: strategy and ledger are injected. */
export async function resolveCapabilities(provider: string, strategy: Strategy, ledger: Ledger = {}): Promise<ProviderCapabilities> {
  try {
    const live = await strategy()
    if (live) return mergeLedger(live, ledger) // learned gating applies to live results too
  } catch {
    // fall through to the floor
  }
  const floor = STATIC_CAPABILITIES[provider] ?? { provider, source: 'static' as const, models: [], efforts: [], fetchedAt: 0 }
  return mergeLedger({ ...floor, fetchedAt: Date.now() }, ledger)
}

// Coalesced per-provider fetches: concurrent callers share one promise; refresh replaces the
// in-flight entry so a slower stale fetch can never overwrite a fresher refresh result.
const cache = new Map<string, Promise<ProviderCapabilities>>()

async function fetchCapabilities(provider: string): Promise<ProviderCapabilities> {
  const { readLedger } = await import('./ledgerStore')
  const ledger = await readLedger()
  const strategies: Record<string, Strategy> = {
    codex: discoverCodex,
    copilot: discoverCopilot,
    claude: async () => discoverClaude(ledger), // static+learned; never null
    opencode: discoverOpenCode
  }
  return resolveCapabilities(provider, strategies[provider] ?? (async () => null), ledger)
}

export function getCapabilities(provider: string, refresh = false): Promise<ProviderCapabilities> {
  if (!refresh && cache.has(provider)) return cache.get(provider)!
  const fetch = fetchCapabilities(provider)
  cache.set(provider, fetch)
  return fetch
}

/** Drop a provider's cached capabilities so the next getCapabilities re-fetches and re-merges the
 * ledger. Called when a gated verdict is recorded, so the tint appears without a manual refresh. */
export function invalidateCapabilities(provider: string): void {
  cache.delete(provider)
}
