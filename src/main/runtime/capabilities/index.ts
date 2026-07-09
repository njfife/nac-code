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

const cache = new Map<string, ProviderCapabilities>()

export async function getCapabilities(provider: string, refresh = false): Promise<ProviderCapabilities> {
  if (!refresh && cache.has(provider)) return cache.get(provider)!
  // Lazy-load the electron-backed ledger store so importing this module never requires electron.
  const { readLedger } = await import('./ledgerStore')
  const ledger = readLedger()
  const strategies: Record<string, Strategy> = {
    codex: discoverCodex,
    copilot: discoverCopilot,
    claude: async () => discoverClaude(ledger), // static+learned; never null
    opencode: discoverOpenCode
  }
  const caps = await resolveCapabilities(provider, strategies[provider] ?? (async () => null), ledger)
  cache.set(provider, caps)
  return caps
}
