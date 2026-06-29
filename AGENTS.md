# AGENTS.md — working in the NAC Code repo

NAC Code ("Not-A-CLI Code") is a desktop (Electron) GUI that **wraps** agentic coding-harness CLIs. It is a **wrapper, never a harness**. This repo is the **source of truth across devices** — keep it organized and current.

## Read first (every session)

1. **`docs/DECISIONS.md`** — current state, next step, and locked decisions.
2. **`docs/plans/`** — the master engineering plan.
3. **`docs/specs/`** — closed specs (M0-1 agent runtime + adapter interface; M0-8 cross-provider context).

## Architecture invariants (do not violate)

- **Wrapper, never a harness:** no agent loop, no raw model endpoints; every model runs inside a harness CLI.
- **ACP-first normalization:** integrate at each harness's structured protocol (ACP where supported, else app-server/SDK); normalize everything into ONE canonical `AgentEvent` union; never scrape stdout.
- **The provider-neutral transcript is the single source of truth** for both the UI and the agent's context; a harness's native session is an optimization only.
- **Cross-provider context portability is a hard requirement:** the user can switch provider/model mid-conversation (including to/from a local model) with full context intact, via the universal `buildContext` replay.
- **Local models only via a carrier harness** (OpenCode in v1; NAC auto-configures it). pi.dev deferred (non-ACP).
- **Stack:** Electron + React + TypeScript; macOS + Linux first, Windows additive behind a `PlatformServices` interface.

## Keep docs updated (this is part of the job)

- When a decision is made or scope changes, add a dated entry to **`docs/DECISIONS.md`** and update the relevant plan/spec **in the same change**.
- Update **`docs/README.md`** when adding or moving docs.
- Prefer updating an existing doc over creating a new one.

## Build / run

- `npm install` — install deps (Electron + React + TS via electron-vite).
- `npm run dev` — launch the app with HMR.
- `npm run build` — production build to `out/`.
- `npm run typecheck` — `tsc --noEmit` (run before committing).
- Packaging (electron-builder) — TBD.

App layout: `src/main` (Node main process — privileged seams), `src/preload` (typed IPC bridge = the only renderer→main surface), `src/renderer` (React UI).
