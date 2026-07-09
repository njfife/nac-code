import { describe, it, expect } from 'vitest'
import { homedir } from 'os'
import { pickAutoApprove, acpCwd, shouldAutoCancelPermission } from './acpSession'

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
