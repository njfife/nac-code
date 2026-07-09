import { describe, it, expect } from 'vitest'
import { costLabel } from './format'

const chat = (provider: string, model: string, usage: Record<string, { turns: number; inputTokens: number; outputTokens: number; costUsd: number; costKnown: boolean }>) =>
  ({ provider, model, usage }) as never

describe('costLabel', () => {
  it('shows real accumulated dollars', () => {
    expect(costLabel(chat('claude', 'Opus 4.8', { claude: { turns: 3, inputTokens: 1, outputTokens: 1, costUsd: 1.234, costKnown: true } }))).toBe('$1.23')
  })
  it('sub-cent positive cost is <$0.01, never $0.00', () => {
    expect(costLabel(chat('claude', 'Opus 4.8', { claude: { turns: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.004, costKnown: true } }))).toBe('<$0.01')
  })
  it('opencode local models are free · local', () => {
    expect(costLabel(chat('opencode', 'lmstudio-local/qwen/qwen3.6-27b', {}))).toBe('free · local')
  })
  it('metered turns with a KNOWN zero cost are an honest $0.00', () => {
    expect(costLabel(chat('opencode', 'opencode/big-pickle', { opencode: { turns: 2, inputTokens: 1, outputTokens: 1, costUsd: 0, costKnown: true } }))).toBe('$0.00')
  })
  it('metered turns with NO cost signal stay an em dash (unknown ≠ zero — codex)', () => {
    expect(costLabel(chat('codex', 'GPT-5.5', { codex: { turns: 4, inputTokens: 1, outputTokens: 1, costUsd: 0, costKnown: false } }))).toBe('—')
  })
  it('no turns yet is an em dash', () => {
    expect(costLabel(chat('codex', 'GPT-5.5', {}))).toBe('—')
  })
  it('real accumulated cost wins over the local shortcut (matrix order is binding)', () => {
    expect(costLabel(chat('opencode', 'lmstudio-local/qwen/qwen3.6-27b', { opencode: { turns: 2, inputTokens: 1, outputTokens: 1, costUsd: 0.5, costKnown: true } }))).toBe('$0.50')
  })
})
