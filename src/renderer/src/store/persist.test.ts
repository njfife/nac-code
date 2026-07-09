import { describe, it, expect } from 'vitest'
import { normalizeChat } from './persist'

// Guards the effort-default migration: `thinking` was cosmetic before effort wiring landed (the
// same change that introduced `fast`), so leftover 'medium' from pre-feature persisted data must
// not silently start sending real flags. Post-feature data (which has `fast`) is preserved as-is.
describe('normalizeChat — thinking default migration', () => {
  it('resets pre-feature data (no `fast` key) to thinking: none regardless of stored value', () => {
    const raw = { title: 'Old chat', provider: 'claude', model: 'Opus 4.8', thinking: 'medium' as const }
    const c = normalizeChat(raw, 'c_old')
    expect(c.thinking).toBe('none')
    expect(c.fast).toBe(false)
  })

  it('preserves post-feature data (has `fast`) as-is', () => {
    const raw = { title: 'New chat', provider: 'claude', model: 'Opus 4.8', fast: true, thinking: 'high' as const }
    const c = normalizeChat(raw, 'c_new')
    expect(c.thinking).toBe('high')
    expect(c.fast).toBe(true)
  })
})
