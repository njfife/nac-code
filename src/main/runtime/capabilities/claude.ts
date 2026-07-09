import { STATIC_CAPABILITIES } from '../../../shared/capabilities'
import type { ProviderCapabilities } from '../../../shared/runtime'
import { mergeLedger, type Ledger } from './ledger'

// Claude Code has no headless model list (alias set is fixed per CLI version; account-gated at
// request time — verified 2026-07-08). Static base + gating ledger = 'static+learned'.
export function discoverClaude(ledger: Ledger): ProviderCapabilities {
  return mergeLedger({ ...STATIC_CAPABILITIES.claude, fetchedAt: Date.now() }, ledger)
}
