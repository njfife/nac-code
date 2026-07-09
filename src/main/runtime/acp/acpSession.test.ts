import { describe, it, expect } from 'vitest'
import { homedir } from 'os'
import { pickAutoApprove, acpCwd, shouldAutoCancelPermission, shouldEmitEmptyTurnNotice, COPILOT_PROFILE, OPENCODE_PROFILE } from './acpSession'

describe('pickAutoApprove', () => {
  it('picks the first allow-kind option', () => {
    expect(pickAutoApprove([
      { id: 'reject_once', label: 'Deny', kind: 'deny' },
      { id: 'allow_once', label: 'Allow once', kind: 'allow' },
      { id: 'allow_always', label: 'Always', kind: 'allow_always' }
    ])?.id).toBe('allow_once')
  })
  it('returns undefined when no allow option exists', () => {
    expect(pickAutoApprove([{ id: 'reject_once', label: 'Deny', kind: 'deny' }])).toBeUndefined()
  })
})

describe('shouldAutoCancelPermission', () => {
  it('auto-cancels when no run is active or during session/load replay (else the JSON-RPC request deadlocks)', () => {
    expect(shouldAutoCancelPermission(false, null)).toBe(true) // no active run
    expect(shouldAutoCancelPermission(true, 'run_1')).toBe(true) // replaying loaded history
    expect(shouldAutoCancelPermission(true, null)).toBe(true)
  })
  it('surfaces the card only during a live, non-replaying run', () => {
    expect(shouldAutoCancelPermission(false, 'run_1')).toBe(false)
  })
})

describe('acpCwd', () => {
  it('expands a stored ~ workspace path to absolute (copilot session/new rejects non-absolute)', () => {
    expect(acpCwd('~/Code/nac-code')).toBe(`${homedir()}/Code/nac-code`)
    expect(acpCwd('~')).toBe(homedir())
  })
  it('passes an absolute path through and falls back to process cwd when unset', () => {
    expect(acpCwd('/abs/path')).toBe('/abs/path')
    expect(acpCwd(undefined)).toBe(process.cwd())
    expect(acpCwd('')).toBe(process.cwd())
  })
})

describe('pillar-4 profile', () => {
  it('profiles carry the exact spawn specs', () => {
    expect(COPILOT_PROFILE).toEqual({ provider: 'copilot', command: 'copilot', args: ['--acp'] })
    expect(OPENCODE_PROFILE).toEqual({ provider: 'opencode', command: 'opencode', args: ['acp'] })
  })
  it('empty-turn notice fires only for opencode, no text, zero tokens, not interrupted', () => {
    expect(shouldEmitEmptyTurnNotice('opencode', false, 0, false)).toBe(true)
    expect(shouldEmitEmptyTurnNotice('opencode', true, 0, false)).toBe(false)
    expect(shouldEmitEmptyTurnNotice('opencode', false, 5, false)).toBe(false)
    expect(shouldEmitEmptyTurnNotice('opencode', false, 0, true)).toBe(false)
    expect(shouldEmitEmptyTurnNotice('copilot', false, 0, false)).toBe(false)
  })
})
