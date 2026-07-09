# NAC Code — Decisions & Current State

> **Source of truth across devices.** Keep this updated as decisions are made (dated entries, newest first). Concise by design — detailed rationale lives in `docs/plans/`, `docs/specs/`, `docs/research/`. The agent memory under `~/.claude/` is device-local convenience only; **this file is canonical.**

## Current phase

**✅ Provider-first model picker + real options** (`dcbf0ad`): the model modal is two-page (detected providers → provider page); availability = live CLI probe (CliRegistry v0 — starts M4; Cursor dropped until it has an adapter). Thinking/effort is REAL on all four harnesses (claude `--effort`, codex `model_reasoning_effort`, copilot `--reasoning-effort`, opencode `--variant`; universal none/low/medium/high, 'none' = harness default) — closes the "thinking-level wiring" next-option. Claude extras: fast mode via per-run `--settings '{"fastMode":true}'` (no --fast flag exists) and a Sonnet 1M-context variant (`sonnet[1m]`), **both verified end-to-end in the running app** (2026-07-08 GUI check: picked `Sonnet 4.6 · 1M` in the new picker → run completed and `claude-sonnet-4-6[1m]` appeared in the harness's model usage; toggled Fast mode on → resumed run with the injected settings completed. Fast mode = the flag is accepted and sent per-run; the speed gain itself is server-side and not asserted). Gated options fail honestly (harness stderr → transcript). Live-verified `--effort low` on all four binaries: claude/codex/copilot completed cleanly first try; opencode's account-default model hung past 120s (unrelated to `--variant` itself — the flag worked once a responsive model was targeted), confirmed by retrying with `-m opencode/big-pickle`, which completed in ~1s — no `OptionDef` change needed, the existing "model-dependent" note already covers this. Spec: `docs/superpowers/specs/2026-07-08-provider-first-model-picker-design.md`. Review fixes: codex/copilot model chips are display-only ("account default · needs M4 discovery" — honest UI per the locked M4 decision), and effort defaults migrated to 'none' (pre-feature persisted 'medium' was cosmetic; runs gain flags only when the user picks a level).

**Building.** Master plan + core specs complete; cross-provider portability spike-validated. **M0-7 done** (scaffold + tracer). **Test harness** in (vitest, 6 tests, `6f6e570`). **M1 shell skeleton** in (`0275ea9`) — three-pane IDE chrome (top/status bar, left rail, chat view, inspector) + design tokens as CSS variables; the tracer stream is wired into the chat view (user/assistant turns + blinking cursor). All typecheck/build/test green; GUI is `npm run dev`-verifiable.

**Next step:** M1's core surfaces are in — all 3 views (chat/context/changes), inspector, model + **agent pickers** (`917c0aa`), ⌘K palette, Studio/Cockpit/Focus layouts incl. the **Cockpit rail**. M5: **real Claude + Codex adapters both run** (`5762809`); Claude has multi-turn memory via `--resume` (verified vs the real binary). All three cloud CLIs are installed (claude / codex / copilot) — the owner has subs for each. 22 tests; typecheck/build green. Persisted-state hydration is now tolerant of schema drift (`3a085ad`).

**🎯 GOAL ACHIEVED — cross-provider context replay works** (`f043a43`): switching a chat between Claude and Codex preserves context. Native `--resume` is the same-provider Claude fast-path; any switch (or non-Claude provider) replays the stored transcript as priming context (the universal `buildContext` path, M0-8 Part B). **Verified end-to-end vs the real binaries** — a codeword planted in a Claude turn was recalled by Codex after the switch.

**✅ Compaction-aware replay** (`287ae7b`): real compaction (was a mock) summarizes into a provider-neutral checkpoint (`summary` + `summarizedThrough`) and invalidates the native session, so replay = `summary + tail` (never the whole raw transcript) — bounded context no matter how many compactions, on any provider. One-shot `runs.summarize` runs the harness with no chat wiring. **Verified vs real binaries**: Claude summarized a planted codeword; Codex recalled it from the summary alone. Also fixed collision-prone `c_${Date.now()}` chat ids.

**✅ All three providers real** (`b7fb68d`): Claude + Codex + Copilot each run via their CLIs and normalize into the one `AgentEvent` model; cross-provider replay + compaction work across all three (each verified vs the real binary — a planted fact survives every switch). Copilot token-streams (message_delta); it's selectable in the model modal. **the owner's headline goal — switch Claude/Codex/Copilot mid-conversation without losing context — is complete and verified.**

**✅ Workspace setup** (`392744d`): workspaces now bind to a project folder and **harness runs execute in that `cwd`** (`paths.resolveCwd` expands `~`; empty = process cwd). Add/remove workspaces from the left rail via a native folder picker (`dialog.pickDirectory`); bound path shown per workspace; remove guarded (never an in-use or last workspace). Decision: v1 = one folder per workspace (per-workspace defaults + the PRD multi-repo model deferred).

**✅ Per-workspace defaults** (`07f16be`): each workspace can set a default provider/model/agent (gear → WorkspaceModal); new chats seed from the workspace's defaults first, then active-chat inheritance (M0-4). `newChat(workspaceId?)` + a per-workspace "+" make a freshly-added workspace reachable.

**✅ YOLO wired to real permissions** (`01fd622`): the toggle now maps to claude `--dangerously-skip-permissions`, codex `-s read-only`↔`workspace-write`, copilot `--allow-all-tools`↔`--yolo` (safe by default). Arg-building is pure/tested (`claudeArgs`/`codexArgs`/`copilotArgs`).

**✅ OpenCode adapter — 4th provider + the local-model carrier** (`80f634c`): `opencode run --format json`; cross-provider replay verified to reach it (and LM Studio models via the same path). Model threading landed via `modelIdFor` (opencode requires real `provider/model` ids). the owner's OpenCode is already configured with LM Studio (local + remote) + free opencode models. Local-models-with-context-intact requirement is now satisfied end-to-end.

**✅ Claude `--model` wired** (`43dfbb8`): opus/sonnet/haiku aliases (account-independent, verified). **Finding that changes the plan:** hardcoding model ids is unsafe for the other clouds — codex `-m gpt-5-codex` **400s** on a ChatGPT-account ("not supported"), copilot `--model gpt-5.4` returns empty (plan-gated). So codex/copilot are left on their working account defaults; exposing their model selection needs **real per-account model discovery** (promotes M4).

**✅ Model discovery + spacing fix** (`3f0a521`, `c9bbff1`): assistant messages strip leading whitespace (reasoning-model gap). Live model discovery wired — the picker queries `opencode models` and shows the account's real 17 configured models (verified). **Finding:** only OpenCode exposes a model-list command — codex has none (`codex models` errors), copilot/claude only have `--model`. So cloud model discovery isn't possible via CLI; claude uses its aliases, codex/copilot stay on account default.

**Local-model coupling — DECIDED: thin** (2026-06-29). NAC relies on the carrier (OpenCode) for the local-model list and does **not** sync OpenCode config, query LM Studio directly, or manage model loading. Each LM Studio instance's own JIT + Auto-Evict (server settings, local *and* remote) handle auto-load + one-at-a-time; the owner owns the OpenCode + LM Studio config. The `LocalModelManager`, OpenCode auto-config, and the read-only-picker are **declined for v1** to avoid coupling NAC to OpenCode's config schema + LM Studio's API. Research retained for reference: `docs/research/lm-studio-model-management.md`. Accepted tradeoff: OpenCode's local model list can go stale (fixed in *the owner's* OpenCode setup, e.g. a discovery plugin), not by NAC.

**✅ Native resume — all providers** (`bdc8b00`): same-provider turns reuse the harness session (claude `--resume`, codex `exec <flags> resume <id>`, copilot `--resume=<id>`, opencode `-s <id>`) and send only the new message; cross-provider switches still replay. `useNative` generalized to `sessionProvider === provider && sessionId`. Verified vs each real binary (2-turn recall).

**✅ Real file-changes view** (`489ba42`): the Changes view reads the active workspace's git working tree (status + numstat + per-file diff/source); ChatView "Files" badge is a live count refreshed after each run. Pure git parsers verified vs real output. Multi-repo (OUTSIDE-WS) deferred.

**✅ Live cost/stats** (`70bc7e6`): real per-provider metering (turns/tokens/$ split by provider) captured from each harness's completion event; StatsModal is real. Claude $+tokens, Codex/OpenCode tokens (OpenCode $), Copilot turns-only (no token/$ via CLI).

**✅ Context library v1** (`27e7e93`, `8c4d63f`): pillar 1 is real — authored **notes** (in-app form) + **file** attach (picker) become items with real content/path; attaching injects them as a leading context block on the non-native send path (seeds the session; resume turns inherit, re-seeded on switch/compaction). Persisted. Verified vs a real harness (an attached note's rule was followed). The "seeds once per session" behavior is **surfaced in the UI**: a "context changed · apply now" pill (composer) + banner (library) appear when attachments differ from what was seeded (`contextPending`); **Apply now** (`reseedContext`) drops the session so the next send re-seeds.

**Next (follow-on options, the owner to prioritize):**
- **Context library polish** — edit notes; mid-conversation re-seed on attachment change; per-harness-native injection (vs the universal prompt block).
- **Thinking-level / agent wiring** — make those toggles real per harness (like YOLO/model); needs per-CLI flag verification (reasoning-effort, --agent), some account-gating risk.
- **PRD multi-repo** workspace model; **packaging** (electron-builder) — *deferred (the owner: not worrying about real builds yet)*.

**▶ Loop paused** — a very complete v1 is in (4 providers, cross-provider replay, compaction, workspace setup + defaults, real YOLO, Claude model selection). The model-discovery finding is a natural point for the owner to steer next priorities.
- **Codex token-streaming** (item.updated deltas); **`--model` wiring** (selected model → harness `--model`).

**▶ Loop paused** at the headline-goal milestone — awaiting the owner's GUI test (all 3 providers + compaction) and direction on the above.

## Locked decisions (newest first)

- **2026-06-28 — v1 persistence = JSON file** (`userData/nac-state.json`, atomic temp+rename write) rather than SQLite — native-module-free and adequate for v1 data volumes; SQLite (better-sqlite3) stays the scale target. Implementation detail, not a functional divergence.
- **2026-06-28 — Model/provider modal shows HARNESSES as providers** (claude/codex/cursor/opencode; local models under the OpenCode carrier) — reconciles the PRD's provider/model modal (FR-7) with the wrapper architecture. Not a functional divergence.
- **2026-06-28 — Frontend state = Zustand** (chosen over Redux Toolkit — lighter, fits the per-chat store). Tooling: electron-vite + React + TS; vitest for tests.
- **2026-06-28 — Repo is the source of truth.** Docs live in-repo, organized under `docs/`; this file is the canonical state across devices.
- **2026-06-28 — Local models only via a carrier harness; carrier = OpenCode (v1).** pi.dev deferred (it IS agentic but non-ACP → needs a bespoke adapter). NAC auto-configures the carrier (`CliRegistry.configureLocalBackend`). → `docs/research/carrier-harnesses.md`
- **2026-06-28 — NAC Code is a wrapper, never a harness.** No agent loop, no raw model endpoints; every model runs inside an agentic harness CLI.
- **2026-06-28 — Multi-harness wrapping = ACP-first structured-protocol adapters → ONE canonical `AgentEvent` union** (pattern learned from t3code). → `docs/specs/...` Part A, `docs/research/` (t3code findings folded into the plan)
- **2026-06-28 — Cross-provider context portability (super-hard requirement).** Provider-neutral transcript = single source of truth; universal `buildContext` replay; switch provider/model mid-conversation (incl. local) with context intact. Native-session resume is a same-provider optimization only. → `docs/specs/...` Part B
- **2026-06-28 — Durable persistence in v1** (promotes roadmap FR-4.3 to P0).
- **2026-06-28 — Stack: Electron + React + TypeScript** (pixel-identical cross-OS rendering; single language). macOS + Linux first; Windows additive behind a `PlatformServices` interface.
- **2026-06-28 — Providers reached by delegating to installed harness CLIs** (CLIs own auth). Session cost is a per-provider, multi-unit breakdown (not a scalar).

## Validated

- **Cross-provider context portability principle** — captured Claude turns into the neutral transcript, replayed via `buildContext` so a local model (LM Studio) recalled first-message content across the switch; the no-replay control reproduced the t3code "empty context" bug. → `spikes/cross-provider-portability/`

## Open / pending

- Remaining M0 specs to close (write alongside the surfaces they govern): **M0-2** autonomy/security, **M0-3** thinking-levels, **M0-4** new-chat seeding, **M0-5** error/empty states, **M0-6** file-context lifecycle.
- **Provider-switch UX:** in-place on the same chat (recommended) vs branch into a new chat — confirm before M5.
- **OpenCode adapter transport:** `opencode acp` (uniform, recommended) vs `opencode serve` + SDK (t3code's proven path) — validate during build.
- ~~Git remote for cross-device sync~~ — ✅ done (2026-06-28): private `origin` at the private GitHub remote; `main` pushed & tracking.
