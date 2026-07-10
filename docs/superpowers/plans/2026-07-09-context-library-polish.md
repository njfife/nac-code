# Context Library Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Context attachments become live — editable with version-safety, delivered into RUNNING sessions as deltas on the next native send, rendered natively (ACP resource blocks) where the protocol supports it — plus the M0-6 file lifecycle and a real Save-config button.

**Architecture:** User items gain a `rev`; seeded markers become `id@rev` keys so edits trip `contextPending`. `RunRequest` gains a structured `context` payload; the renderer stops pre-baking context into prompt strings for live paths. A shared `renderContextText` (in `src/shared/` — both processes need it) is the universal text form; `AcpSession` upgrades to ACP resource blocks when the initialize response advertises `embeddedContext`; ipc bakes text for the one-shot fallback.

**Tech Stack:** Electron + React + TS, zustand, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-09-context-library-polish-design.md`.

## Global Constraints

- Replay invariant: injection NEVER enters stored turn text (`pushTurn` keeps the user's typed message only); `buildReplayPrompt` unchanged.
- Copy strings exact: pill `context changes with your next message`; banner button `Re-seed fresh session` (title attr: `starts a fresh harness session; in-session state is lost`); removal note line `The following attached context was removed — disregard it going forward: <names>`; refused-file note `attached file <name> could not be included (<missing|binary|too large>)`.
- File caps exact: 256KB size cap; binary = null byte in the first 8KB. `fileState: 'missing' | 'binary' | 'toolarge'` (absent = ok).
- Seed keys: `` `${id}@${rev ?? 0}` `` for user items (id starts with `u_`), bare `id` for static items. Legacy persisted `seededAttachments` entries for user items normalize to `id@0` on hydrate.
- Refused/missing file items still get their seed key recorded after the one-time note (no perpetual pending loop).
- ACP resource block target shape: `{ type: 'resource', resource: { uri, text, mimeType: 'text/plain' } }` with `uri = 'file://<path>'` for file items else `'nac://context/<name>'` — PROBE-FIRST during Task 4; if rejected, sessions fall back to text-prepend and the observation is recorded in `docs/research/`.
- On a session/prompt ERROR when resource blocks were included: retry the same turn ONCE with text-prepend rendering before surfacing run.errored.
- All tests green + `npm run typecheck` + `npm run build` clean before every commit. Work in a NEW worktree from current main. NEVER touch `/Users/nathanielfife/Code/nac-code` from implementers.

---

### Task 1: item revs, seed keys, pending-on-edit, updateNote

**Files:**
- Modify: `src/renderer/src/data/context.ts` (ContextItem gains `rev?: number`, `fileState?: 'missing' | 'binary' | 'toolarge'`)
- Modify: `src/renderer/src/store/store.ts` (`addNote` seeds `rev: 0`; new `updateNote`; `markSeeded` unchanged signature — CALLERS now pass seed keys; `contextPending` compares seed keys)
- Modify: `src/renderer/src/store/persist.ts` (legacy seeded-entry normalization; userItems hydrate `rev ?? 0` for notes)
- Test: `src/renderer/src/store/store.test.ts`, `src/renderer/src/store/persist.test.ts`

**Interfaces:**
- Produces: `seedKey(item: Pick<ContextItem, 'id' | 'rev'>): string` exported from `src/renderer/src/data/context.ts` — `` item.id.startsWith('u_') ? `${item.id}@${item.rev ?? 0}` : item.id ``. `updateNote(id: string, patch: { name?: string; content?: string }): void` store action. `contextPending(chat, userItems)` — NOTE the new second param: pending needs current revs, so the helper signature becomes `contextPending(chat: Chat, userItems: ContextItem[]): boolean`; update the two call sites (ChatView.tsx:29, ContextLibrary banner).

- [ ] **Step 1: Failing tests**

```ts
// store.test.ts additions
it('updateNote bumps rev, recomputes tokens/description, and trips contextPending without a set change', () => {
  const s = useApp.getState()
  s.newChat()
  const id = useApp.getState().activeChatId
  s.addNote('conventions', 'always use tabs')
  const note = useApp.getState().userItems.find((u) => u.tags.includes('note'))!
  expect(note.rev).toBe(0)
  s.toggleAttach(id, note.id)
  // simulate a seeded live session
  s.setSession(id, 'sess_1', useApp.getState().chats[id].provider)
  s.markSeeded(id, useApp.getState().chats[id].attachedIds.map((a) => {
    const it = useApp.getState().userItems.find((u) => u.id === a)
    return it ? seedKey(it) : a
  }))
  expect(contextPending(useApp.getState().chats[id], useApp.getState().userItems)).toBe(false)
  s.updateNote(note.id, { content: 'always use spaces, never tabs' })
  const edited = useApp.getState().userItems.find((u) => u.id === note.id)!
  expect(edited.rev).toBe(1)
  expect(edited.tokens).toBe(Math.ceil('always use spaces, never tabs'.length / 4))
  expect(contextPending(useApp.getState().chats[id], useApp.getState().userItems)).toBe(true) // same set, new rev
})

it('seedKey: user items carry @rev, static items stay bare', () => {
  expect(seedKey({ id: 'u_1_2', rev: 3 })).toBe('u_1_2@3')
  expect(seedKey({ id: 'u_1_2' })).toBe('u_1_2@0')
  expect(seedKey({ id: 'sk-tdd' })).toBe('sk-tdd')
})
```

```ts
// persist.test.ts addition
it('legacy seededAttachments entries for user items normalize to id@0', () => {
  const c = normalizeChat({ seededAttachments: ['sk-tdd', 'u_9_9'], sessionId: 's', sessionProvider: 'claude' } as never, 'c_l', new Set(['u_9_9']))
  expect(c.seededAttachments).toEqual(['sk-tdd', 'u_9_9@0'])
})
```

- [ ] **Step 2: RED. Step 3: Implement.**

`context.ts`: add the two optional fields + `seedKey` (code above in Interfaces). `store.ts`:

```ts
updateNote: (id, patch) =>
  set((s) => ({
    userItems: s.userItems.map((i) => {
      if (i.id !== id || !i.user || i.type !== 'instruction') return i
      const content = patch.content ?? i.content ?? ''
      return {
        ...i,
        name: (patch.name ?? i.name).trim() || i.name,
        content,
        description: content.trim().slice(0, 80),
        tokens: Math.ceil(content.length / 4),
        rev: (i.rev ?? 0) + 1
      }
    })
  })),
```

`addNote` gains `rev: 0` in its literal. `contextPending` becomes:

```ts
export function contextPending(chat: Chat, userItems: ContextItem[]): boolean {
  if (!chat.sessionId || chat.sessionProvider !== chat.provider || chat.seededAttachments === null) return false
  const currentKeys = chat.attachedIds.map((id) => {
    const u = userItems.find((i) => i.id === id)
    return u ? seedKey(u) : id
  })
  const seeded = new Set(chat.seededAttachments)
  return currentKeys.length !== seeded.size || currentKeys.some((k) => !seeded.has(k))
}
```

`persist.ts` normalizeChat: `seededAttachments` entries map `e.startsWith('u_') && !e.includes('@') ? `${e}@0` : e`; userItems hydration ensures notes get `rev: i.rev ?? 0`. Update the two `contextPending` call sites to pass `s.userItems`.
- [ ] **Step 4: GREEN + full suite + typecheck. Step 5: Commit** — `git commit -m "feat(clp): item revisions + seed keys — edits trip contextPending; updateNote lands"`

---

### Task 2: shared context rendering + delta computation (pure)

**Files:**
- Create: `src/shared/contextRender.ts` (+ test `src/shared/contextRender.test.ts`)
- Modify: `src/renderer/src/store/runtime.ts` (`buildContextBlock` delegates to the shared renderer; export kept for the replay path)
- Create: `src/renderer/src/store/contextDelta.ts` (+ test)

**Interfaces:**
- Produces (shared): `interface ContextPayload { items: { name: string; content: string; path?: string }[]; removed: string[]; notes?: string[] }` and `renderContextText(p: ContextPayload): string` — full block when `removed`/`notes` empty; appends the exact removal-note and refused-file-note lines otherwise; returns `''` for an empty payload.
- Produces (renderer): `computeContextDelta(chat: Chat, userItems: ContextItem[]): { addedOrChanged: ContextItem[]; removedNames: string[] }` — seed-key diff: attached keys not in `seededAttachments` → addedOrChanged (resolve item); seeded ids (key's id part) no longer attached → removedNames (resolved name, else the raw id).

- [ ] **Step 1: Failing tests**

```ts
// src/shared/contextRender.test.ts
import { describe, it, expect } from 'vitest'
import { renderContextText } from './contextRender'

describe('renderContextText', () => {
  it('renders items as ## sections with file fences, matching the v1 block shape', () => {
    const out = renderContextText({ items: [{ name: 'conventions', content: 'use tabs' }, { name: 'a.ts', content: 'code', path: '/x/a.ts' }], removed: [] })
    expect(out).toContain('Attached context for this conversation:')
    expect(out).toContain('## conventions\nuse tabs')
    expect(out).toContain('## a.ts (/x/a.ts)')
    expect(out).toContain('```\ncode\n```')
    expect(out.endsWith('---\n\n')).toBe(true)
  })
  it('renders removal + refused notes with the exact copy', () => {
    const out = renderContextText({ items: [], removed: ['old-note'], notes: ['attached file big.bin could not be included (too large)'] })
    expect(out).toContain('The following attached context was removed — disregard it going forward: old-note')
    expect(out).toContain('attached file big.bin could not be included (too large)')
  })
  it('empty payload renders empty string', () => {
    expect(renderContextText({ items: [], removed: [] })).toBe('')
  })
})
```

```ts
// src/renderer/src/store/contextDelta.test.ts
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
```

- [ ] **Step 2: RED. Step 3: Implement.** `contextRender.ts` extracts the exact block format from today's `buildContextBlock` (read `runtime.ts:62-70`) into `renderContextText`; append removal/notes lines before the trailing `---\n\n` separator (block ends with `---\n\n` exactly as today). `runtime.ts`'s `buildContextBlock` becomes a thin adapter mapping `(items, fileContents)` → `ContextPayload` → `renderContextText` (existing callers/tests unchanged). `contextDelta.ts`: implement per the interface (resolve items from userItems-then-`ITEMS_BY_ID`; static items appear in addedOrChanged only when newly attached — seed-key parity handles it since bare ids compare directly).
- [ ] **Step 4: GREEN + full suite + typecheck. Step 5: Commit** — `git commit -m "feat(clp): shared context renderer + pure delta computation"`

---

### Task 3: file lifecycle (M0-6)

**Files:**
- Create: `src/renderer/src/store/readFileItem.ts` (+ test)
- Modify: `src/renderer/src/store/store.ts` (`setFileState(id, state | undefined)` + re-tokenize action `setFileTokens(id, tokens)` — or one combined `recordFileRead(id, result)`), `src/renderer/src/store/persist.ts` (fileState hydration tolerance)
- Modify: `src/renderer/src/components/ContextLibrary.tsx` (row + detail badges)
- Test: `src/renderer/src/store/readFileItem.test.ts`, store tests

**Interfaces:**
- Produces: `readFileItem(item: { path?: string }, read: (p: string) => Promise<string | null | undefined>): Promise<{ ok: true; content: string; tokens: number } | { ok: false; state: 'missing' | 'binary' | 'toolarge' }>` — pure-ish (injected reader): null/undefined/throw → missing; `content.length > 262144` → toolarge; null byte (` `) in the first 8192 chars → binary; else ok + `tokens = Math.ceil(content.length / 4)`.
- Store: `recordFileRead(id: string, result: <the union above>): void` — ok → clears `fileState`, sets `tokens`; not-ok → sets `fileState`.

- [ ] **Step 1: Failing tests**

```ts
// readFileItem.test.ts
import { describe, it, expect } from 'vitest'
import { readFileItem } from './readFileItem'

describe('readFileItem', () => {
  it('ok path re-tokenizes', async () => {
    const r = await readFileItem({ path: '/x' }, async () => 'abcd'.repeat(10))
    expect(r).toEqual({ ok: true, content: 'abcd'.repeat(10), tokens: 10 })
  })
  it('missing / binary / toolarge map to states', async () => {
    expect(await readFileItem({ path: '/x' }, async () => null)).toEqual({ ok: false, state: 'missing' })
    expect(await readFileItem({ path: '/x' }, async () => { throw new Error('ENOENT') })).toEqual({ ok: false, state: 'missing' })
    expect(await readFileItem({ path: '/x' }, async () => 'a b')).toEqual({ ok: false, state: 'binary' })
    expect(await readFileItem({ path: '/x' }, async () => 'x'.repeat(262145))).toEqual({ ok: false, state: 'toolarge' })
  })
  it('no path → missing', async () => {
    expect(await readFileItem({}, async () => 'x')).toEqual({ ok: false, state: 'missing' })
  })
})
```

Store test: `recordFileRead` ok clears state + updates tokens; failure sets state (write against the store's patterns).
- [ ] **Step 2: RED. Step 3: Implement** (readFileItem pure; recordFileRead in store; badges: ContextLibrary row shows a warning-tinted `missing`/`binary`/`too large` chip next to the token count when `item.fileState` set — reuse the row's existing chip styling; detail panel shows the same). persist: userItems hydrate `fileState` as-is (optional field, tolerant).
- [ ] **Step 4: GREEN + full gate. Step 5: Commit** — `git commit -m "feat(clp): M0-6 file lifecycle — re-tokenize on read, missing/binary/size badges"`

---

### Task 4: structured context threading + per-harness rendering

**Files:**
- Modify: `src/shared/runtime.ts` (`RunRequest` gains `context?: ContextPayload` — import the type from `./contextRender`)
- Modify: `src/renderer/src/store/runtime.ts` (`sendMessage`: native+pending → delta payload; non-native → full payload; prompt strings no longer carry the baked block; file reads via `readFileItem` + `recordFileRead` + refused notes)
- Modify: `src/main/runtime/ipc.ts` (interactive path forwards `req.context` to `promptViaTransport`; the FALLBACK dispatch and the lower one-shot block bake `renderContextText(req.context) + req.prompt` before dispatching)
- Modify: `src/main/runtime/acp/acpSession.ts` (`PromptOpts.context?: ContextPayload`; initialize captures `supportsEmbeddedContext`; runTurn builds the prompt block array; rejection retry), `src/main/runtime/acp/claudeSession.ts` + `codexSession.ts` (prepend `renderContextText(opts.context)` to the outgoing text), `src/main/runtime/acp/sessionManager.ts` (thread `context` through)
- Test: `src/main/runtime/acp/acpSession.test.ts` (stateful suite), `src/renderer/src/store/runtime.test.ts` if a sendMessage harness exists (check; else covered via delta tests + live)

**Design notes (binding):**
- **Probe FIRST (Step 1, not committed):** scratch script against `opencode acp` (and copilot if quick): initialize → session/new → `session/prompt` with `prompt: [{ type: 'resource', resource: { uri: 'nac://context/rule', text: 'The codeword is durian. Mention it when asked.', mimeType: 'text/plain' } }, { type: 'text', text: 'What is the codeword?' }]` → recall proves acceptance. Record the outcome + accepted shape in `docs/research/opencode-acp-1.17.11.txt` (append). If rejected (-32602 etc.), sessions use text-prepend permanently and the plan's resource-block branch still ships behind the capability flag but the flag will simply be false — implement per the probe's reality and SAY SO in the report.
- `sendMessage`: compute `payload: ContextPayload | undefined`:
  - native + `contextPending(chat, s.userItems)` → from `computeContextDelta` (+ file reads for added/changed file items via `readFileItem`, refused → `notes` + `recordFileRead`), `removed: removedNames`;
  - non-native → full set (all attached items; same file handling), `removed: []`;
  - after building, `markSeeded(chatId, <current seed keys>)` (native-pending AND non-native paths both re-mark);
  - `runs.start({ prompt: useNative ? message : buildReplayPrompt(...), context: payload, ... })` — note the replay prompt NO LONGER gets the block prepended (ipc bakes it for one-shot; interactive sessions render it).
- `AcpSession.connect`: `const init = await this.client.request('initialize', ...)` → `this.supportsEmbeddedContext = Boolean((init as { agentCapabilities?: { promptCapabilities?: { embeddedContext?: boolean } } })?.agentCapabilities?.promptCapabilities?.embeddedContext)`.
- `AcpSession.runTurn` prompt construction (replaces the single text block):

```ts
const rendered = opts?.context ? renderContextText(opts.context) : ''
const blocks: unknown[] = []
if (opts?.context && this.supportsEmbeddedContext) {
  for (const it of opts.context.items) {
    blocks.push({ type: 'resource', resource: { uri: it.path ? `file://${it.path}` : `nac://context/${encodeURIComponent(it.name)}`, text: it.content, mimeType: 'text/plain' } })
  }
  const preamble = [
    opts.context.removed.length ? `The following attached context was removed — disregard it going forward: ${opts.context.removed.join(', ')}` : '',
    ...(opts.context.notes ?? [])
  ].filter(Boolean).join('\n')
  blocks.push({ type: 'text', text: preamble ? `${preamble}\n\n${text}` : text })
} else {
  blocks.push({ type: 'text', text: rendered + text })
}
```

  On `session/prompt` rejection (catch) when resource blocks were used: retry ONCE with `[{ type: 'text', text: rendered + text }]` before the error path.
- Claude/Codex sessions: in `prompt()`/`runTurn`, `text = renderContextText(opts.context ?? EMPTY) + text` (claude: prepend before writing the user frame; codex: prepend in the `turn/start` input text).
- ipc: `promptViaTransport({ ..., context: req.context })`; both fallback dispatches and the lower one-shot block wrap: `const prompt = req.context ? renderContextText(req.context) + req.prompt : req.prompt`.
- Session manager: `PromptOpts` construction gains `context: opts.context`.

- [ ] **Step 1: the probe. Step 2: Failing tests** — extend the stateful AcpSession suite (FakeClient): (a) `supportsEmbeddedContext` captured from a scripted initialize response; (b) prompt with context + support → prompt array contains N resource blocks + trailing text block (assert shapes); (c) without support → single text block starting with `Attached context`; (d) rejection retry: first session/prompt rejects, second (text-only) resolves → run completes, calls recorded in order. **Step 3: Implement everything. Step 4: GREEN + full gate. Step 5: Commit** — `git commit -m "feat(clp): structured context payload — ACP resource blocks, text-prepend elsewhere, fallback baking in ipc"`

---

### Task 5: UI — Edit button, pill copy, re-seed relabel, save-config

**Files:**
- Modify: `src/renderer/src/components/ContextLibrary.tsx` (Edit button in detail panel reusing `noteForm` prefilled — `noteForm` state gains `editingId?: string`; Save routes to `updateNote` when set; banner button relabeled `Re-seed fresh session` + title attr)
- Modify: `src/renderer/src/components/ChatView.tsx` (pill: copy `context changes with your next message`, no button/onClick; config picker lists `userConfigs` with a × delete; the dead `configSaveRow` becomes an inline name input + Save calling `saveConfig`)
- Modify: `src/renderer/src/store/store.ts` (`userConfigs: Configuration[]`, `saveConfig(name)`, `removeConfig(id)`), `src/renderer/src/store/persist.ts` (persist userConfigs), `src/renderer/src/data/configs.ts` (configTokens lookup extended with a userItems param — check its callers)
- Test: store tests (saveConfig captures active attachedIds with `u_` id; removeConfig; persist round-trip)

- [ ] **Step 1: Failing tests**

```ts
// store.test.ts
it('saveConfig captures the active chat attachments as a named user config; removeConfig deletes it', () => {
  const s = useApp.getState()
  s.newChat()
  const id = useApp.getState().activeChatId
  s.addNote('n', 'c')
  const note = useApp.getState().userItems.at(-1)!
  s.toggleAttach(id, note.id)
  s.saveConfig('My setup')
  const cfg = useApp.getState().userConfigs.at(-1)!
  expect(cfg.name).toBe('My setup')
  expect(cfg.itemIds).toEqual(useApp.getState().chats[id].attachedIds)
  expect(cfg.id.startsWith('u_')).toBe(true)
  s.removeConfig(cfg.id)
  expect(useApp.getState().userConfigs.find((c) => c.id === cfg.id)).toBeUndefined()
})
```

Persist test: userConfigs round-trip through hydration (follow the userItems pattern).
- [ ] **Step 2: RED. Step 3: Implement** (store actions mirror userItems patterns; `applyConfig` already swaps by itemIds — verify it resolves user configs too, extend its lookup if it reads CONFIGS_BY_ID only). UI per the notes; pill keeps rendering only when `contextPending`.
- [ ] **Step 4: GREEN + full gate. Step 5: Commit** — `git commit -m "feat(clp): edit notes UI, informational pill, real save-config"`

---

### Task 6: live verification (controller, computer use) + docs + final review

**Files:**
- Modify: `docs/DECISIONS.md`

- [ ] **Step 1: Live matrix** (adversarial; fresh worktree dev app):
  1. **Mid-conversation delta (headline)**: start a native claude or opencode conversation (one turn), then attach a NEW note with a codeword mid-conversation → pill shows `context changes with your next message` → send "what does the attached note say?" → harness recalls the codeword; verify the transport child PID is UNCHANGED (session survived) and the stored user turn text has no context block.
  2. Edit that note (new codeword) → pill trips again → next send recalls the NEW codeword.
  3. Detach it → next send: harness confirms it should disregard it (removal note delivered).
  4. ACP resource block: on opencode (embeddedContext advertised) verify recall of a resource-block-delivered item; check the probe transcript matches.
  5. Fresh-session full seed still works (new chat + attachments → first send recalls).
  6. Re-seed fresh session button: still drops the session (new PID) and replays.
  7. File lifecycle: attach a real file → send (recall proves inclusion; token count updates in the library); delete the file on disk → pill/send → `missing` badge appears and the note is delivered once; attach a >256KB file → `too large` badge.
  8. Save-config: save current as config → new chat → apply it → attachments match; delete the config.
  9. Replay path regression: provider switch mid-chat still carries context (block baked into replay via ipc/one-shot or structured via transport).
  10. Four-transport regression smokes (context threading touched every session class).
- [ ] **Step 2: Final gate** — `npm run typecheck && npx vitest run && npm run build`.
- [ ] **Step 3: DECISIONS entry** at the top of Current phase (replace `<commit>`) + roadmap item 3 checked off:

```markdown
**✅ Context library polish** (`<commit>`): attachments are LIVE. Mid-conversation attachment changes deliver as a DELTA on the next native send — the transport session survives (verified live: same child PID, codeword recalled) — replacing the destructive Apply-now as the default; "Re-seed fresh session" remains as the explicit, warned nuclear option. User items carry revisions (id@rev seed keys): editing a note trips the pill and re-delivers (FR-5.9's version-safety, minimal form) via the new updateNote + Edit UI. Injection is structured end-to-end: RunRequest.context → per-harness rendering — ACP resource blocks where embeddedContext is advertised (probe outcome recorded), text-prepend on claude/codex (their native shape), ipc bakes text for the one-shot fallback, replay unchanged. M0-6 file lifecycle landed: send-time re-tokenize (the budget meter finally counts files), missing/binary/too-large badges with one-time skip notes. The dead "Save current as configuration…" button is real (persisted user configs, deletable). Spec: `docs/superpowers/specs/2026-07-09-context-library-polish-design.md`.
```

- [ ] **Step 4: Commit** — `git add docs/DECISIONS.md && git commit -m "docs: context library polish done — live deltas verified against running sessions"`

Then: final whole-branch review (most capable model), one fix subagent, re-review, finishing-a-development-branch.
