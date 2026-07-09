import { describe, it, expect } from 'vitest'
import { mapCodexModels } from './codex'

const GPT55 = {
  id: 'gpt-5.5', model: 'gpt-5.5', displayName: 'GPT-5.5',
  description: 'Frontier model for complex coding, research, and real-world work.',
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
    { reasoningEffort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
    { reasoningEffort: 'high', description: 'Greater reasoning depth for complex problems' },
    { reasoningEffort: 'xhigh', description: 'Extra high reasoning depth for complex problems' }
  ],
  defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'], supportsPersonality: true,
  additionalSpeedTiers: ['fast'], serviceTiers: [{ id: 'priority', name: 'Fast' }], defaultServiceTier: null, isDefault: true
}

describe('mapCodexModels', () => {
  it('maps the real model/list shape to DiscoveredModel', () => {
    const [m] = mapCodexModels([GPT55])
    expect(m).toEqual({
      id: 'gpt-5.5', label: 'GPT-5.5', isDefault: true,
      efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium'
    })
  })
  it('drops hidden models and tolerates junk entries', () => {
    expect(mapCodexModels([{ ...GPT55, hidden: true }])).toEqual([])
    expect(mapCodexModels([null, 42, {}])).toEqual([])
  })
})
