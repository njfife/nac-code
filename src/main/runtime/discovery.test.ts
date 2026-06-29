import { describe, it, expect } from 'vitest'
import { parseOpenCodeModels } from './discovery'

describe('parseOpenCodeModels', () => {
  it('keeps provider/model lines and drops noise', () => {
    const out = ['opencode/deepseek-v4-flash-free', 'lmstudio/qwen/qwen3-coder-30b', '', '  lmstudio-remote/google/gemma-4-31b-qat  ', 'some banner text', 'Available models:'].join('\n')
    expect(parseOpenCodeModels(out)).toEqual(['opencode/deepseek-v4-flash-free', 'lmstudio/qwen/qwen3-coder-30b', 'lmstudio-remote/google/gemma-4-31b-qat'])
  })

  it('returns empty for empty input', () => {
    expect(parseOpenCodeModels('')).toEqual([])
  })
})
