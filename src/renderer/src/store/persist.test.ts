import { describe, it, expect } from 'vitest'
import { normalizeChat } from './persist'

// Guards the effort-default migration: `thinking` was cosmetic before effort wiring landed (the
// same change that introduced `fast`), so leftover pre-feature values must not silently start
// sending real flags. Post-feature data (which has `fast`) is preserved as-is; the new `effort`
// field wins when present.
describe('normalizeChat — thinking → effort migration', () => {
  it("migrates legacy thinking: 'none' to effort null and drops pre-feature values", () => {
    expect(normalizeChat({ thinking: 'none', fast: true } as never, 'c1').effort).toBeNull()
    expect(normalizeChat({ thinking: 'medium' } as never, 'c2').effort).toBeNull() // pre-fast era: cosmetic
    expect(normalizeChat({ thinking: 'high', fast: false } as never, 'c3').effort).toBe('high')
    expect(normalizeChat({ effort: 'xhigh', fast: false } as never, 'c4').effort).toBe('xhigh')
  })

  it('hydrates fast strictly from boolean true and treats malformed fast as pre-feature', () => {
    const malformed = normalizeChat({ fast: null as unknown as boolean, thinking: 'medium' } as never, 'c_bad')
    expect(malformed.effort).toBeNull() // non-boolean fast = pre-feature: cosmetic thinking dropped
    expect(malformed.fast).toBe(false)
    expect(normalizeChat({ fast: true } as never, 'c_t').fast).toBe(true)
    expect(normalizeChat({} as never, 'c_none').fast).toBe(false)
  })
})
