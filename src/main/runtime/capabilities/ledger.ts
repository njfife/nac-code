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

/** Pure + exported for testing: a completion is only "works" evidence when it actually produced
 * output. An opencode EMPTY TURN (unloaded local model) reports stopReason 'end_turn' with
 * usage.outputTokens === 0 — that is not proof the model works. Completions without a usage object
 * (claude one-shot, copilot, stub) carry no such signal, so they still count as before. */
export function isWorksEvidence(stopReason: string, usage?: { outputTokens?: number }): boolean {
  return stopReason === 'end_turn' && !(usage && usage.outputTokens === 0)
}

/** Pure + exported for testing: stamp `gated` onto caps models (and their variants) from ledger entries.
 * Model-level gating stays keyed on the model's own id; a gated variant id only stamps that variant
 * entry (the parent model's own gated flag is untouched unless the model's own id is also gated). */
export function mergeLedger(caps: ProviderCapabilities, ledger: Ledger): ProviderCapabilities {
  const entries = ledger[caps.provider]
  if (!entries || Object.keys(entries).length === 0) return caps
  let touched = false
  const models = caps.models.map((m) => {
    const modelGated = entries[m.id]?.verdict === 'gated'
    let variants = m.variants
    if (variants) {
      let variantsTouched = false
      variants = variants.map((v) => {
        if (entries[v.id]?.verdict === 'gated') {
          variantsTouched = true
          touched = true
          return { ...v, gated: true }
        }
        return v
      })
      if (!variantsTouched) variants = m.variants
    }
    if (modelGated) touched = true
    if (!modelGated && variants === m.variants) return m
    return { ...m, ...(modelGated ? { gated: true } : {}), ...(variants !== m.variants ? { variants } : {}) }
  })
  if (!touched) return caps
  return { ...caps, models, source: caps.source === 'static' ? 'static+learned' : caps.source }
}
