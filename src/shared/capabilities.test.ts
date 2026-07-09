import { describe, it, expect } from 'vitest'
import { STATIC_CAPABILITIES, modelIdFor, effortScaleFor, windowKFor } from './capabilities'

describe('STATIC_CAPABILITIES', () => {
  it('covers the four adapter-backed providers with source static', () => {
    for (const p of ['claude', 'codex', 'copilot', 'opencode']) {
      expect(STATIC_CAPABILITIES[p]?.source).toBe('static')
    }
    expect(STATIC_CAPABILITIES.claude.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    expect(STATIC_CAPABILITIES.copilot.efforts).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('modelIdFor', () => {
  it('resolves labels and variants from provided caps, falling back to static', () => {
    expect(modelIdFor('claude', 'Sonnet 4.6 · 1M')).toBe('sonnet[1m]')
    const caps = { provider: 'copilot', source: 'protocol' as const, models: [{ id: 'gpt-5.4', label: 'GPT-5.4' }], efforts: [], fetchedAt: 1 }
    expect(modelIdFor('copilot', 'GPT-5.4', caps)).toBe('gpt-5.4')
    expect(modelIdFor('opencode', 'lmstudio/qwen/qwen3-coder-30b')).toBe('lmstudio/qwen/qwen3-coder-30b')
    expect(modelIdFor('codex', 'Account default')).toBeUndefined()
  })
})

describe('effortScaleFor', () => {
  it("prefers the selected model's own scale, then provider-wide", () => {
    const caps = { provider: 'codex', source: 'protocol' as const, efforts: ['low', 'medium', 'high'], fetchedAt: 1,
      models: [{ id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] }] }
    expect(effortScaleFor(caps, 'GPT-5.5')).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(effortScaleFor(caps, 'Account default')).toEqual(['low', 'medium', 'high'])
    expect(effortScaleFor(undefined, 'x')).toEqual(['low', 'medium', 'high'])
  })
})

describe('windowKFor', () => {
  it('resolves per-model windows from the static floor, variants included', () => {
    expect(windowKFor('claude', 'Opus 4.8')).toBe(200)
    expect(windowKFor('claude', 'Sonnet 4.6 · 1M')).toBe(1000)
    expect(windowKFor('claude', 'Haiku 4.5')).toBe(200)
  })
  it('prefers live caps and falls back to 200 for unknown models', () => {
    const caps = { provider: 'codex', source: 'live', fetchedAt: 1, efforts: [], models: [{ id: 'gpt-5.5', label: 'GPT-5.5', contextWindowK: 272 }] } as never
    expect(windowKFor('codex', 'GPT-5.5', caps)).toBe(272)
    expect(windowKFor('codex', 'Mystery Model')).toBe(200)
  })
})
