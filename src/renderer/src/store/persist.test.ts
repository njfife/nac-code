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
// Sweep (Task 3): `agent` is gone from Chat, and the fake catalog entries (ag-*, fl-*, content-less
// skills) are gone from ITEMS_BY_ID — dead attachedIds referencing them must not survive hydration,
// while ids that belong to hydrated user items (notes/files, `u_` prefix) are real and must survive.
describe('normalizeChat — drops removed agent field and dead attachedIds', () => {
  it('drops the removed agent field and dead attachedIds on hydrate', () => {
    const raw = { agent: 'ag-nac', attachedIds: ['sk-tdd', 'ag-nac', 'fl-readme'] } as never
    const c = normalizeChat(raw, 'c1')
    expect(c).not.toHaveProperty('agent')
    expect(c.attachedIds).toEqual(['sk-tdd'])
  })

  it('keeps attachedIds that belong to hydrated user items even though they are not in ITEMS_BY_ID', () => {
    const raw = { attachedIds: ['sk-tdd', 'u_123_1', 'ag-nac'] } as never
    const c = normalizeChat(raw, 'c2', new Set(['u_123_1']))
    expect(c.attachedIds).toEqual(['sk-tdd', 'u_123_1'])
  })
})

describe('normalizeChat — tolerant hydration of corrupted/legacy shapes (PR #8 review)', () => {
  it('a chat missing workspaceId lands in the caller-supplied fallback workspace, not a ghost', () => {
    expect(normalizeChat({} as never, 'c_nows', new Set(), 'ws_default').workspaceId).toBe('ws_default')
    expect(normalizeChat({} as never, 'c_nows2').workspaceId).toBe('ws_default') // param default
  })
  it('null/non-object usage entries never crash hydration and coerce to safe zeros', () => {
    const u = normalizeChat({ usage: { codex: null, claude: 42, opencode: { turns: 1, costUsd: 0.5 } } } as never, 'c_junk').usage
    expect(u.codex).toEqual({ turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costKnown: false })
    expect(u.claude).toEqual({ turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costKnown: false })
    expect(u.opencode).toMatchObject({ turns: 1, costUsd: 0.5, costKnown: true })
  })
})

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

describe('initPersistence — strips removed workspace defaults.agent', () => {
  afterEach(() => {
    // @ts-expect-error test-only teardown of the minimal preload stub
    delete globalThis.window
  })

  it('legacy defaults keep provider/model but drop agent', async () => {
    const loaded = { chats: {}, workspaces: [{ id: 'w1', name: 'W', path: '', defaults: { provider: 'claude', model: 'Opus 4.8', agent: 'ag-nac' } }], activeChatId: '', layout: 'studio', expanded: {} }
    // @ts-expect-error minimal window.nac.state stub — only what initPersistence reads
    globalThis.window = { nac: { state: { load: async () => loaded, save: async () => {} } } }

    await initPersistence()

    const w = useApp.getState().workspaces.find((x) => x.id === 'w1')!
    expect(w.defaults).toEqual({ provider: 'claude', model: 'Opus 4.8' })
  })
})
