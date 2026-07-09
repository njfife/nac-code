import { describe, it, expect } from 'vitest'
import { RESUME_VERIFY_MS, needsRespawn } from './claudeSession'
import { PROMPT_TIMEOUT_MS } from './acpSession'

describe('ClaudeSession constants + respawn predicate', () => {
  it('verifies resume inside a window well under the prompt ceiling', () => {
    expect(RESUME_VERIFY_MS).toBe(2000)
    expect(RESUME_VERIFY_MS).toBeLessThan(PROMPT_TIMEOUT_MS)
  })
  it('needsRespawn: only when a known session exists and model/effort actually changed', () => {
    expect(needsRespawn({ model: 'a', effort: 'high' }, { model: 'a', effort: 'high' }, 'sid')).toBe(false)
    expect(needsRespawn({ model: 'a' }, { model: 'b' }, 'sid')).toBe(true)
    expect(needsRespawn({ model: 'a' }, { model: 'b' }, null)).toBe(false) // no session to resume — never respawn mid-air
    expect(needsRespawn({}, {}, 'sid')).toBe(false)
    expect(needsRespawn({ effort: 'high' }, {}, 'sid')).toBe(false) // requested field undefined = no preference
  })
})
