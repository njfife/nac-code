import { describe, it, expect } from 'vitest'
import { pickAutoApprove } from './acpSession'

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
