import { describe, it, expect } from 'vitest'
import { classifyModelRejection, CLAUDE_MODEL_REJECTION, mergeLedger, type Ledger } from './ledger'
import { STATIC_CAPABILITIES } from '../../../shared/capabilities'

describe('classifyModelRejection', () => {
  it('recognizes the three verified rejection shapes', () => {
    expect(classifyModelRejection(`{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account."}}`)).toBe(true)
    expect(classifyModelRejection('Error: Model "totally-bogus" from --model flag is not available.')).toBe(true)
    expect(classifyModelRejection("There's an issue with the selected model (totally-bogus-model). It may not exist or you may not have access to it.")).toBe(true)
    expect(classifyModelRejection('harness exited with code 1')).toBe(false)
  })
  it('CLAUDE_MODEL_REJECTION matches the expected pattern', () => {
    expect(CLAUDE_MODEL_REJECTION.test("There's an issue with the selected model (x).")).toBe(true)
  })
})

describe('mergeLedger', () => {
  it('marks gated models and upgrades source to static+learned', () => {
    const ledger: Ledger = { claude: { opus: { verdict: 'gated', at: 1 } } }
    const merged = mergeLedger(STATIC_CAPABILITIES.claude, ledger)
    expect(merged.models.find((m) => m.id === 'opus')?.gated).toBe(true)
    expect(merged.source).toBe('static+learned')
    expect(merged.models.find((m) => m.id === 'sonnet')?.gated).toBeUndefined()
  })
  it('is a no-op without relevant entries', () => {
    expect(mergeLedger(STATIC_CAPABILITIES.claude, {})).toEqual(STATIC_CAPABILITIES.claude)
  })
  it('stamps a gated verdict on a variant id onto that variant entry, not the parent model', () => {
    const ledger: Ledger = { claude: { 'sonnet[1m]': { verdict: 'gated', at: 1 } } }
    const merged = mergeLedger(STATIC_CAPABILITIES.claude, ledger)
    const sonnet = merged.models.find((m) => m.id === 'sonnet')
    expect(sonnet?.gated).toBeUndefined()
    expect(sonnet?.variants?.find((v) => v.id === 'sonnet[1m]')?.gated).toBe(true)
    expect(merged.source).toBe('static+learned')
  })
})
