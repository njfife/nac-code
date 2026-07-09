import { describe, it, expect } from 'vitest'
import { modelIdFor, PROVIDERS } from './providers'

describe('modelIdFor', () => {
  it('maps base models and 1M variants to harness ids', () => {
    expect(modelIdFor('claude', 'Sonnet 4.6')).toBe('sonnet')
    expect(modelIdFor('claude', 'Sonnet 4.6 · 1M')).toBe('sonnet[1m]')
    expect(modelIdFor('opencode', 'lmstudio/qwen/qwen3-coder-30b')).toBe('lmstudio/qwen/qwen3-coder-30b')
    expect(modelIdFor('claude', 'nope')).toBeUndefined()
  })
  it('has no cursor provider until an adapter exists', () => {
    expect(PROVIDERS.find((p) => p.id === 'cursor')).toBeUndefined()
  })
})
