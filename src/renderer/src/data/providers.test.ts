import { describe, it, expect } from 'vitest'
import { PROVIDERS } from './providers'

// modelIdFor / model-id resolution now lives in shared/capabilities.test.ts (Task 1) — this catalog
// is presentation-only (id/name/detail/dot/status/options); no model lists, no wiring flags.
describe('PROVIDERS', () => {
  it('has the four adapter-backed providers, each with options', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(['claude', 'codex', 'copilot', 'opencode'])
    for (const p of PROVIDERS) {
      expect(p.options.length).toBeGreaterThan(0)
    }
  })
  it('has no cursor provider until an adapter exists', () => {
    expect(PROVIDERS.find((p) => p.id === 'cursor')).toBeUndefined()
  })
})
