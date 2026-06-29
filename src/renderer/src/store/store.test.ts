import { describe, it, expect, beforeEach } from 'vitest'
import { useApp, chatsForWorkspace } from './store'

// Guards the FR-4.1 invariant (mutations affect only the active chat) and FR-9.3 branching.
describe('app store — per-chat spine', () => {
  beforeEach(() => useApp.getState().selectChat('c1'))

  it('setModel affects only the active chat (FR-4.1)', () => {
    const otherBefore = useApp.getState().chats.c3.model
    useApp.getState().selectChat('c1')
    useApp.getState().setModel('codex', 'gpt-5-codex')
    expect(useApp.getState().chats.c1.model).toBe('gpt-5-codex')
    expect(useApp.getState().chats.c3.model).toBe(otherBefore) // untouched
  })

  it('toggleAttach toggles membership and marks the chat dirty (FR-5.5 / FR-6.4)', () => {
    useApp.getState().selectChat('c1')
    const had = useApp.getState().chats.c1.attachedIds.includes('sk-review')
    useApp.getState().toggleAttach('sk-review')
    expect(useApp.getState().chats.c1.attachedIds.includes('sk-review')).toBe(!had)
    expect(useApp.getState().chats.c1.dirty).toBe(true)
  })

  it('newFromCompacted branches a new active chat and leaves the original intact (FR-9.3)', () => {
    useApp.getState().selectChat('c1')
    const n0 = Object.keys(useApp.getState().chats).length
    useApp.getState().newFromCompacted()
    const s = useApp.getState()
    expect(Object.keys(s.chats).length).toBe(n0 + 1)
    const active = s.chats[s.activeChatId]
    expect(active.branchedFrom).toBe('c1')
    expect(active.title).toContain('Compacted ·')
    expect(s.chats.c1.branchedFrom).toBeNull() // original untouched
    // branched chats sort to the top of their workspace group (FR-2.4)
    expect(chatsForWorkspace(s.chats, 'ws_nac')[0].branchedFrom).not.toBeNull()
  })

  it('applyConfig replaces the attached set and clears dirty (FR-6.3)', () => {
    useApp.getState().selectChat('c2') // seeded dirty
    useApp.getState().applyConfig('minimal')
    const c2 = useApp.getState().chats.c2
    expect(c2.attachedIds).toEqual(['in-style'])
    expect(c2.activeConfig).toBe('minimal')
    expect(c2.dirty).toBe(false)
  })

  it('newChat seeds from the active chat and applies Standard (FR-2.3 / M0-4)', () => {
    useApp.getState().selectChat('c3') // codex / infra workspace
    const n0 = Object.keys(useApp.getState().chats).length
    useApp.getState().newChat()
    const s = useApp.getState()
    expect(Object.keys(s.chats).length).toBe(n0 + 1)
    const active = s.chats[s.activeChatId]
    expect(active.title).toBe('New chat')
    expect(active.provider).toBe('codex') // inherited from the active chat
    expect(active.workspaceId).toBe('ws_infra')
    expect(active.activeConfig).toBe('standard')
    expect(active.contextK).toBe(0)
  })

  it('addWorkspace appends a folder-bound workspace and expands it', () => {
    const n0 = useApp.getState().workspaces.length
    useApp.getState().addWorkspace('proj', '/Users/x/proj')
    const s = useApp.getState()
    expect(s.workspaces.length).toBe(n0 + 1)
    const ws = s.workspaces[s.workspaces.length - 1]
    expect(ws.name).toBe('proj')
    expect(ws.path).toBe('/Users/x/proj')
    expect(s.expanded[ws.id]).toBe(true)
  })

  it('removeWorkspace drops an empty workspace but never one with chats', () => {
    useApp.getState().addWorkspace('empty', '/tmp/empty')
    const empty = useApp.getState().workspaces.find((w) => w.name === 'empty')!
    useApp.getState().removeWorkspace(empty.id)
    expect(useApp.getState().workspaces.find((w) => w.id === empty.id)).toBeUndefined()
    const before = useApp.getState().workspaces.length
    useApp.getState().removeWorkspace('ws_nac') // ws_nac has seeded chats -> blocked
    expect(useApp.getState().workspaces.length).toBe(before)
    expect(useApp.getState().workspaces.find((w) => w.id === 'ws_nac')).toBeDefined()
  })
})
