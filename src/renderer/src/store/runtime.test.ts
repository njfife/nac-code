import { describe, it, expect, afterEach } from 'vitest'
import { buildReplayPrompt, sendMessage } from './runtime'
import { useApp, type Turn } from './store'
import { seedKey } from '../data/context'
import type { RunRequest } from '../../../shared/runtime'

const turn = (role: Turn['role'], text: string): Turn => ({ id: `${role}_${text}`, role, text })

describe('buildReplayPrompt (cross-provider / compaction-aware replay)', () => {
  it('returns the bare message when there is nothing to replay', () => {
    expect(buildReplayPrompt(null, [], 'hello')).toBe('hello')
  })

  it('replays the tail turns when there is no summary', () => {
    const out = buildReplayPrompt(null, [turn('user', 'remember ZEBRA'), turn('assistant', 'ok')], 'what word?')
    expect(out).toContain('User: remember ZEBRA')
    expect(out).toContain('Assistant: ok')
    expect(out).toContain('User: what word?')
  })

  it('puts the compaction summary first and appends only the tail (not the whole history)', () => {
    const out = buildReplayPrompt('Earlier: user picked the codeword ZEBRA.', [turn('user', 'still there?')], 'what word?')
    expect(out).toContain('Summary of the earlier conversation:')
    expect(out).toContain('codeword ZEBRA')
    expect(out).toContain('User: still there?')
    expect(out.indexOf('Summary of the earlier conversation:')).toBeLessThan(out.indexOf('User: still there?'))
  })

  it('skips empty/streaming-placeholder turns', () => {
    const out = buildReplayPrompt(null, [turn('user', 'hi'), turn('assistant', '   ')], 'next')
    expect(out).toContain('User: hi')
    expect(out).not.toContain('Assistant:')
  })
})

// Task 4: sendMessage no longer bakes a rendered context block into the prompt string — it builds a
// structured ContextPayload (native+pending → delta; else → full set) and sends it alongside the bare
// prompt/replay text. File reads route through readFileItem + recordFileRead (never an inline read) —
// the Task 3 reviewer flagged the old inline `window.nac.files.read` call; this suite proves it's gone.
describe('sendMessage — structured context payload (Task 4)', () => {
  afterEach(() => {
    // @ts-expect-error test-only teardown of the minimal preload stub (follows store.test.ts's pattern)
    delete globalThis.window
  })

  function freshChat(): string {
    const s = useApp.getState()
    s.newChat()
    const id = useApp.getState().activeChatId
    // Strip the 'standard' config's default attachments so each test starts from an empty, known set.
    for (const defaultId of [...useApp.getState().chats[id].attachedIds]) s.toggleAttach(defaultId)
    return id
  }

  function stubRuns(fileContents: Record<string, string | null> = {}): { calls: RunRequest[] } {
    const calls: RunRequest[] = []
    const api = {
      runs: { start: async (req: RunRequest) => { calls.push(req); return { runId: 'r1' } } },
      files: { read: async (p: string) => fileContents[p] ?? null }
    }
    // @ts-expect-error minimal window.nac stub — only what sendMessage reads
    globalThis.window = { nac: api }
    return { calls }
  }

  it('non-native (no live session): sends the FULL attached set as context, resolving file content via readFileItem', async () => {
    const s = useApp.getState()
    const id = freshChat()
    s.addNote('style-note', 'Use tabs.')
    const note = useApp.getState().userItems.find((u) => u.name === 'style-note')!
    s.addFileItem('a.ts', '/proj/a.ts')
    const file = useApp.getState().userItems.find((u) => u.name === 'a.ts')!
    s.toggleAttach(note.id)
    s.toggleAttach(file.id)

    const { calls } = stubRuns({ '/proj/a.ts': 'export const x = 1' })
    await sendMessage('hello')

    expect(calls).toHaveLength(1)
    const req = calls[0]
    expect(req.prompt).toBe('hello') // bare — no baked block prepended client-side anymore
    expect(req.context?.removed).toEqual([])
    expect(req.context?.items).toEqual([
      { name: 'style-note', content: 'Use tabs.', path: undefined },
      { name: 'a.ts', content: 'export const x = 1', path: '/proj/a.ts' }
    ])
    // File read went through readFileItem/recordFileRead: a successful read clears fileState + sets tokens.
    const readFile = useApp.getState().userItems.find((u) => u.id === file.id)!
    expect(readFile.fileState).toBeUndefined()
    expect(readFile.tokens).toBeGreaterThan(0)
    // Both the delta and non-native paths re-mark seeded with the CURRENT attached set's seed keys.
    const seeded = useApp.getState().chats[id].seededAttachments
    expect(seeded).toEqual(useApp.getState().chats[id].attachedIds.map((aid) => {
      const u = useApp.getState().userItems.find((x) => x.id === aid)
      return u ? seedKey(u) : aid
    }))
  })

  it('native + pending: sends only the DELTA (added/changed items + removed names), then re-marks seeded to the current set', async () => {
    const s = useApp.getState()
    const id = freshChat()
    s.addNote('kept-note', 'kept content')
    const kept = useApp.getState().userItems.find((u) => u.name === 'kept-note')!
    s.addNote('new-note', 'new content')
    const added = useApp.getState().userItems.find((u) => u.name === 'new-note')!
    s.toggleAttach(kept.id)
    s.toggleAttach(added.id)

    // Simulate a live native session seeded BEFORE `added` was attached, and which still believes the
    // (now-detached) static item 'sk-tdd' is present — it must show up in `removed`.
    const provider = useApp.getState().chats[id].provider
    s.setSession(id, 'sess_1', provider)
    s.markSeeded(id, [seedKey(kept), 'sk-tdd'])

    const { calls } = stubRuns()
    await sendMessage('hello')

    expect(calls).toHaveLength(1)
    const req = calls[0]
    expect(req.prompt).toBe('hello') // native path: bare message, no replay text
    expect(req.sessionId).toBe('sess_1')
    expect(req.context?.items).toEqual([{ name: 'new-note', content: 'new content', path: undefined }])
    expect(req.context?.removed).toEqual(['test-driven-development']) // sk-tdd's display name
    const reseeded = useApp.getState().chats[id].seededAttachments
    expect(reseeded).toEqual([seedKey(kept), seedKey(added)])
  })

  it('non-native, nothing attached: context is omitted entirely, not sent as an empty payload', async () => {
    // An empty {items:[],removed:[]} payload would still set usedResourceBlocks on an ACP transport
    // (e.g. opencode) even though nothing was actually attached, arming the text-only retry on any
    // unrelated error for every fresh turn. context must be undefined here, not a hollow object.
    freshChat()

    const { calls } = stubRuns()
    await sendMessage('hello, nothing attached')

    expect(calls).toHaveLength(1)
    expect(calls[0].context).toBeUndefined()
  })

  it('native + NOT pending: no context payload is sent, and the prompt is the bare message', async () => {
    const s = useApp.getState()
    const id = freshChat()
    const provider = useApp.getState().chats[id].provider
    s.setSession(id, 'sess_1', provider)
    s.markSeeded(id, useApp.getState().chats[id].attachedIds) // seeded == current (empty) set — nothing pending
    const seededBefore = useApp.getState().chats[id].seededAttachments

    const { calls } = stubRuns()
    await sendMessage('hi again')

    expect(calls).toHaveLength(1)
    expect(calls[0].context).toBeUndefined()
    expect(calls[0].prompt).toBe('hi again')
    expect(calls[0].sessionId).toBe('sess_1')
    expect(useApp.getState().chats[id].seededAttachments).toEqual(seededBefore) // not re-marked
  })

  it('a refused (missing) file attachment becomes a `notes` line — never silently dropped — and records fileState', async () => {
    const s = useApp.getState()
    freshChat()
    s.addFileItem('missing.ts', '/proj/missing.ts')
    const file = useApp.getState().userItems.find((u) => u.name === 'missing.ts')!
    s.toggleAttach(file.id)

    const { calls } = stubRuns() // files.read resolves null → missing
    await sendMessage('hello')

    const req = calls[0]
    expect(req.context?.items).toEqual([])
    expect(req.context?.notes).toEqual(['attached file missing.ts could not be included (missing)'])
    expect(useApp.getState().userItems.find((u) => u.id === file.id)?.fileState).toBe('missing')
  })

  it('maps the toolarge file state to the "too large" copy in the refusal note', async () => {
    const s = useApp.getState()
    freshChat()
    s.addFileItem('big.ts', '/proj/big.ts')
    const file = useApp.getState().userItems.find((u) => u.name === 'big.ts')!
    s.toggleAttach(file.id)

    const { calls } = stubRuns({ '/proj/big.ts': 'x'.repeat(262145) })
    await sendMessage('hello')

    const req = calls[0]
    expect(req.context?.notes).toEqual(['attached file big.ts could not be included (too large)'])
    expect(useApp.getState().userItems.find((u) => u.id === file.id)?.fileState).toBe('toolarge')
  })
})
