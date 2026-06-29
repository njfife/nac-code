# NAC Code — Decisions & Current State

> **Source of truth across devices.** Keep this updated as decisions are made (dated entries, newest first). Concise by design — detailed rationale lives in `docs/plans/`, `docs/specs/`, `docs/research/`. The agent memory under `~/.claude/` is device-local convenience only; **this file is canonical.**

## Current phase

**Building.** Master plan + core specs complete; cross-provider portability spike-validated. **M0-7 done** (scaffold + tracer). **Test harness** in (vitest, 6 tests, `6f6e570`). **M1 shell skeleton** in (`0275ea9`) — three-pane IDE chrome (top/status bar, left rail, chat view, inspector) + design tokens as CSS variables; the tracer stream is wired into the chat view (user/assistant turns + blinking cursor). All typecheck/build/test green; GUI is `npm run dev`-verifiable.

**Next step:** M1's core surfaces are in — all 3 views (chat/context/changes), inspector, model + **agent pickers** (`917c0aa`), ⌘K palette, Studio/Cockpit/Focus layouts incl. the **Cockpit rail**. Compaction & branching + **context-configuration picker** (FR-6.2/6.3, `e5f9995`) are in; 10 tests. Remaining M1 polish: Session Stats modal (FR-11) and Cockpit chat tabs. Then close the rest of M0 (autonomy/security, thinking-levels, new-chat, errors, file lifecycle) and wire real harness adapters (M5).

## Locked decisions (newest first)

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
- ~~Git remote for cross-device sync~~ — ✅ done (2026-06-28): private `origin` at github.com/njfife/nac-code; `main` pushed & tracking.
