# Context Library Polish — Design

**Date:** 2026-07-09
**Status:** Approved (approach A — delta injection on the next native send, revisioned items)
**Scope decision:** The three roadmap items (edit notes; mid-conversation re-seed; per-harness-native injection) plus two riders (file lifecycle M0-6; the dead Save-config button). Deferred: full FR-6.7 config management (rename/reorder/share), FR-5.10 scope enforcement, `markSeeded`-on-run.started timing.

## Goal

Context attachments become live: editable (version-safely), delivered into RUNNING sessions incrementally (no more session-killing "Apply now" as the only lever), and rendered natively where the protocol supports it. File items stop lying about their cost and state. The dead Save-config button becomes real.

## Survey findings driving this spec (main @ b4faf53)

1. No edit path exists (`store.ts` has add/remove only; the detail panel has Delete but no Edit). FR-5.9 requires edits that don't break referencing chats.
2. `contextPending` (store.ts:533-537) compares attachment ID SETS only — a content edit would silently desync from what was seeded.
3. `reseedContext` is destructive: it nulls sessionId, which disposes the live transport session (`sessionManager.ts` "Important 5") and forces a lossy textual replay. Native sends NEVER inject context — mid-conversation attachment changes are invisible until reseed.
4. Injection is one universal prompt-prefix (`buildContextBlock`); copilot ACP advertises `promptCapabilities.embeddedContext: true` (captured, `docs/research/acp-prompt-frames-copilot-1.0.69.txt`) and opencode advertised the same in the P4 initialize probe — both unused.
5. File items: `tokens: 0` forever, no missing/binary/size handling; send-time read failures are silent (`runtime.ts:96-100`). M0-6 spells out the required behavior.
6. "Save current as configuration…" (`ChatView.tsx:109`) has no onClick — a fake pixel.
7. `markSeeded` fires optimistically at prompt-build time (known; out of scope this branch).

## Design

### 1. Revisions & pending detection

- `ContextItem` gains `rev?: number` — user items start at 0, bumped on every edit; static catalog items never carry it (immutable).
- New pure helper (data or store level): `seedKey(item): string` = `` `${id}@${rev ?? 0}` `` for user items, bare `id` for static items.
- `markSeeded` stores seed keys. `contextPending` compares current seed-key set vs stored (legacy bare user-item entries hydrate as `id@0` via persist normalization, so nothing trips retroactively).
- `seededAttachments` remains the single seeded marker; persist normalization maps legacy entries.

### 2. Edit notes

- Store action `updateNote(id, patch: { name?: string; content?: string })`: user items only; recomputes `tokens = Math.ceil(content.length/4)` and `description = content.slice(0, 80)` when content changes; bumps `rev`.
- `ContextLibrary` detail panel gains **Edit** (gated `selected.user`, next to Delete) — reuses the existing note modal prefilled; Save routes to `updateNote`.
- File items are not editable (path is identity); rename-only editing of file items is out of scope.

### 3. Incremental re-seed (delta on next native send)

- `sendMessage`'s native branch: when `contextPending(chat)`, compute the delta before sending:
  - **added**: attached ids whose seed key is absent from `seededAttachments`, with full content;
  - **changed**: same id present at a different rev — treated as added (full new content), labeled "(updated)";
  - **removed**: seeded ids no longer attached — name-only notes.
- The delta travels as structured context (see §4); after dispatch, `markSeeded` records the new seed-key set. The stored user turn text remains the user's typed message ONLY (replay invariant: `buildReplayPrompt` reads `turn.text`; injection never enters the transcript).
- Non-native sends keep today's full-set behavior (fresh session gets everything), now also via structured context on the interactive path.
- UI: the composer pill copy becomes `context changes with your next message` (informational, no button); the library banner keeps an explicit button relabeled **Re-seed fresh session** with the existing `reseedContext` semantics and a title-attr warning ("starts a fresh harness session; in-session state is lost").

### 4. Per-harness-native injection

- `RunRequest` gains `context?: { items: { name: string; content: string; path?: string }[]; removed: string[] }` (full-set on fresh sends, delta on pending native sends, absent when nothing to inject). The renderer stops pre-baking `buildContextBlock` into the prompt for the INTERACTIVE path.
- `promptViaTransport` forwards it via `PromptOpts.context` (same shape). Per session:
  - **AcpSession (copilot + opencode)**: when the initialize response advertised `promptCapabilities.embeddedContext`, render items as ACP content blocks alongside the text block in `session/prompt` — target shape `{ type: 'resource', resource: { uri: 'nac://context/<name>' | 'file://<path>', text, mimeType: 'text/plain' } }` per the ACP spec; **one-off probe during implementation pins the accepted shape** (send a resource block, ask the model to recall its content). If the harness rejects it, fall back to text-prepend and record the observation. Removal notes are always text.
  - **ClaudeSession / CodexSession**: prepend the rendered text block to the outgoing message text (their protocols' native input IS text). Rendering reuses ONE shared pure builder (`renderContextText(context)` — extracted from `buildContextBlock` + a delta/removals variant) so all providers inject identical prose.
- The one-shot fallback path and the replay path keep baking `buildContextBlock` into the prompt string exactly as today (context must survive the degradation ladder).
- The initialize capability is captured per-session at connect (AcpSession stores `supportsEmbeddedContext` from the initialize response).

### 5. File lifecycle (M0-6 rider)

- Send-time file handling (the existing lazy read in `sendMessage`, moved behind a helper `readFileItem(item)`):
  - read fails / file gone → item flagged `fileState: 'missing'`, skipped from injection;
  - first 8KB contains a null byte → `fileState: 'binary'`, refused;
  - content > 256KB → `fileState: 'toolarge'`, refused;
  - success → `fileState` cleared, `tokens = Math.ceil(content.length/4)` updated on the item (the budget meter finally counts files).
- `fileState` renders as a badge on the library row + detail panel (missing / binary / too large, warning-tinted). Flags persist with userItems; a later successful read clears them.
- Refused/missing items do NOT silently vanish from the block: the injected text notes "attached file X could not be included (<reason>)" once, and the item's seed key is still recorded (no perpetual pending loop).

### 6. Save-config rider

- Store: `userConfigs: Configuration[]` (same `{id, name, itemIds}` shape, `u_`-prefixed ids), persisted top-level like `userItems`; actions `saveConfig(name)` (captures the ACTIVE chat's attachedIds) and `removeConfig(id)`.
- ChatView's config picker lists static CONFIGURATIONS + userConfigs; user entries get a small × delete affordance; the dead "Save current as configuration…" row opens an inline name input and calls `saveConfig`.
- `configTokens` works unchanged (it sums by id lookup — extend the lookup to include userItems for user-config token sums).

## Error handling

- Delta computation with a deleted-but-seeded user item: treated as removed (name unavailable → id string in the removal note).
- ACP resource-block rejection at runtime (error response to session/prompt): retry the same turn once with text-prepend rendering, then record; never lose the user's message.
- File flags never crash hydration (persist normalization defaults `fileState` absent).
- Empty delta (pending tripped but items resolve to nothing injectable) → send proceeds with no context payload; seed keys still update.

## Testing

- Store: rev bump on updateNote, pending-on-edit (set unchanged, rev changed), delta computation (added/changed/removed), seedKey legacy normalization, saveConfig/removeConfig, fileState transitions.
- Pure: `renderContextText` full + delta + removal + refused-file variants.
- Transport: the stateful AcpSession suite (FakeClient) extends: embeddedContext advertised → session/prompt carries resource blocks + text; not advertised → single text block with prepended context; rejection → one retry with text.
- **Live computer-use matrix (mandatory final task):** attach a note MID-conversation on a live native session → next send → the harness recalls the note's content verbatim (delta delivery proven, session survived — same PID); edit the note → pill trips → next send delivers the update; removal → harness confirms disregard; ACP resource block verified against real copilot or opencode (probe + in-app); missing-file badge (attach a file, delete it on disk, send); too-large badge; save/apply/delete a user config; "Re-seed fresh session" still works with its warning; four-transport regression smokes.

## Non-goals

`markSeeded` timing (stays optimistic; queued). FR-6.7 full config management. FR-5.10 scope enforcement. Editing file items. Real skills/agents discovery from disk (future feature with `--agent`).
