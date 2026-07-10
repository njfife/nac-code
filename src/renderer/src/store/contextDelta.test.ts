import { describe, it, expect } from 'vitest'
import { computeContextDelta } from './contextDelta'

const item = (id: string, rev: number, name: string) => ({ id, rev, name, type: 'instruction', description: '', tokens: 1, scope: 'workspace', source: 'user', tags: [], content: 'c', user: true }) as never

describe('computeContextDelta', () => {
  const userItems = [item('u_1_1', 1, 'edited-note'), item('u_2_2', 0, 'new-note')]
  it('splits added/changed (seed-key miss) from removed (seeded id gone)', () => {
    const chat = { attachedIds: ['u_1_1', 'u_2_2', 'sk-tdd'], seededAttachments: ['u_1_1@0', 'sk-tdd', 'u_9_9@0'] } as never
    const d = computeContextDelta(chat, userItems as never)
    expect(d.addedOrChanged.map((i: { id: string }) => i.id)).toEqual(['u_1_1', 'u_2_2']) // rev bump + brand new
    expect(d.removedNames).toEqual(['u_9_9']) // deleted item: name unavailable → id
  })
  it('no pending → empty delta', () => {
    const chat = { attachedIds: ['sk-tdd'], seededAttachments: ['sk-tdd'] } as never
    const d = computeContextDelta(chat, [] as never)
    expect(d.addedOrChanged).toEqual([])
    expect(d.removedNames).toEqual([])
  })
})
