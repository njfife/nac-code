import type { ProviderCapabilities } from '../../../shared/runtime'

// Outcome-learned account gating (pure logic). File I/O lives in ledgerStore.ts (electron-only).

export type Ledger = Record<string, Record<string, { verdict: 'gated' | 'works'; at: number; message?: string }>>

/** Claude's model-rejection text (structured 404 result). Shared with the claude adapter. */
export const CLAUDE_MODEL_REJECTION = /issue with the selected model/i

// One rejection matcher per verified harness error shape (see spec's probed ground truth).
const REJECTION_PATTERNS = [
  /model is not supported when using Codex/i, // codex 400
  /Model "[^"]+" from --model flag is not available/i, // copilot
  CLAUDE_MODEL_REJECTION // claude structured 404 result text
]

/** Pure + exported for testing. */
export function classifyModelRejection(message: string): boolean {
  return REJECTION_PATTERNS.some((p) => p.test(message))
}

/** Pure + exported for testing: stamp `gated` onto caps models from ledger entries. */
export function mergeLedger(caps: ProviderCapabilities, ledger: Ledger): ProviderCapabilities {
  const entries = ledger[caps.provider]
  if (!entries || Object.keys(entries).length === 0) return caps
  let touched = false
  const models = caps.models.map((m) => {
    if (entries[m.id]?.verdict === 'gated') {
      touched = true
      return { ...m, gated: true }
    }
    return m
  })
  if (!touched) return caps
  return { ...caps, models, source: caps.source === 'static' ? 'static+learned' : caps.source }
}
