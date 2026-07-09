import { describe, it, expect, afterEach } from 'vitest'
import { normalizeChat, initPersistence } from './persist'
import { useApp } from './store'

// Guards the effort-default migration: `thinking` was cosmetic before effort wiring landed (the
// same change that introduced `fast`), so leftover pre-feature values must not silently start
// sending real flags. Post-feature data (which has `fast`) is preserved as-is; the new `effort`
// field wins when present.
describe('normalizeChat — thinking → effort migration', () => {
  it("migrates legacy thinking: 'none' to effort null and drops pre-feature values", () => {
    expect(normalizeChat({ thinking: 'none', fast: true } as never, 'c1').effort).toBeNull()
    expect(normalizeChat({ thinking: 'medium' } as never, 'c2').effort).toBeNull() // pre-fast era: cosmetic
    expect(normalizeChat({ thinking: 'high', fast: false } as never, 'c3').effort).toBe('high')
    expect(normalizeChat({ effort: 'xhigh', fast: false } as never, 'c4').effort).toBe('xhigh')
  })

  it('hydrates fast strictly from boolean true and treats malformed fast as pre-feature', () => {
    const malformed = normalizeChat({ fast: null as unknown as boolean, thinking: 'medium' } as never, 'c_bad')
    expect(malformed.effort).toBeNull() // non-boolean fast = pre-feature: cosmetic thinking dropped
    expect(malformed.fast).toBe(false)
    expect(normalizeChat({ fast: true } as never, 'c_t').fast).toBe(true)
    expect(normalizeChat({} as never, 'c_none').fast).toBe(false)
  })
})

describe('normalizeChat — never restore live-looking tool/permission state', () => {
  it('hydration never restores live-looking tool/permission state', () => {
    const raw = { fast: false, messages: [{ id: 'a', role: 'assistant', text: 'x', tools: [{ toolCallId: 't', title: 'T', status: 'running' }], permissions: [{ requestId: 'p', title: 'P', options: [] }] }] } as never
    const c = normalizeChat(raw, 'c_live')
    expect(c.messages[0].tools?.[0].status).toBe('failed')
    expect(c.messages[0].permissions?.[0].resolvedOptionId).toBe('stale')
  })

  it('never rehydrates a streaming flag', () => {
    const raw = { fast: false, messages: [{ id: 'a', role: 'assistant', text: 'x', streaming: true }] } as never
    expect(normalizeChat(raw, 'c_stream').messages[0].streaming).toBe(false)
  })

  it('never rehydrates contextLive', () => {
    const raw = { fast: false, contextLive: true, messages: [] } as never
    expect(normalizeChat(raw, 'c_ctx').contextLive).toBe(false)
  })
})

// Fresh-install sweep (Task 2): the old "≥1 chat or ignore the file" gate is gone — initPersistence
// must hydrate whatever's on disk, including a genuinely empty chats object, rather than falling back
// to (now nonexistent) demo chats.
describe('initPersistence — empty-chats gate', () => {
  afterEach(() => {
    // @ts-expect-error test-only teardown of the minimal preload stub
    delete globalThis.window
  })

  it('hydrates an EMPTY persisted state without resurrecting demo chats', async () => {
    const loaded = { chats: {}, workspaces: [{ id: 'ws_x', name: 'X', path: '' }], activeChatId: 'stale', layout: 'studio', expanded: {} }
    // @ts-expect-error minimal window.nac.state stub — only what initPersistence reads
    globalThis.window = { nac: { state: { load: async () => loaded, save: async () => {} } } }

    await initPersistence()

    const s = useApp.getState()
    expect(Object.keys(s.chats).length).toBe(0)
    expect(s.chats.c1).toBeUndefined()
    expect(s.chats.c2).toBeUndefined()
    expect(s.chats.c3).toBeUndefined()
    expect(s.activeChatId).toBe('') // no chats to point at
    expect(s.workspaces).toEqual([{ id: 'ws_x', name: 'X', path: '', defaults: undefined }])
  })
})
