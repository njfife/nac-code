import { describe, it, expect } from 'vitest'
import { mapCopilotModels } from './copilot'

const AVAILABLE = [
  { modelId: 'auto', name: 'Auto', description: 'Let Copilot pick the best model' },
  { modelId: 'gpt-5.4', name: 'GPT-5.4', description: 'GPT-5.4', _meta: { copilotUsage: '6x', copilotEnablement: 'enabled' } },
  { modelId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', description: 'Claude Sonnet 4.6', _meta: { copilotUsage: '9x', copilotEnablement: 'enabled' } }
]

describe('mapCopilotModels', () => {
  it('maps the real ACP availableModels shape, marks the current default, carries usage', () => {
    const models = mapCopilotModels(AVAILABLE, 'gpt-5.4')
    expect(models).toEqual([
      { id: 'auto', label: 'Auto', isDefault: false },
      { id: 'gpt-5.4', label: 'GPT-5.4', isDefault: true, note: '6x usage' },
      { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6', isDefault: false, note: '9x usage' }
    ])
  })
  it('tolerates junk entries', () => {
    expect(mapCopilotModels([null, {}, { name: 'no-id' }])).toEqual([])
  })
})
