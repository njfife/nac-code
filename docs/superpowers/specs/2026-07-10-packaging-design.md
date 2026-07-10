# Packaging (electron-builder) — Design

**Date:** 2026-07-10
**Status:** Approved (approach A — login-shell PATH merge; daily-drivable local build)
**Scope decision:** A working, installable, Finder-launchable build for macOS + Linux, ad-hoc/self-signed, NO Apple notarization. DEFERRED to their own passes: notarization/Gatekeeper distribution (needs an Apple Developer account + secrets), Windows, user-configurable CLI paths, auto-update, the SQLite migration.

## Goal

`npm run package` produces an installable `.app`/DMG (macOS) and AppImage/deb (Linux) that WORKS when launched from Finder — the whole app spawns four external CLIs (claude/codex/copilot/opencode) plus git by bare name against `PATH`, and a Finder-launched `.app` inherits a minimal PATH that excludes where those CLIs live. This closes roadmap item 4.

## Survey findings driving this spec (main @ f9d90e6)

1. **Every CLI spawn resolves a bare name against `PATH`** — registry probe (`registry.ts:29`), the four one-shot adapters (`*Adapter.ts` spawn lines), all interactive transport classes (`JsonRpcClient` `capabilities/jsonRpc.ts:64`, `StreamJsonClient` `acp/streamJson.ts:16`, `AcpProfile` copilot/opencode commands, `ClaudeSession` `'claude'`, `CodexSession` `'codex'`), capability discovery (`capabilities/{codex,copilot,opencode}.ts`), and git (`changes.ts:12`). No PATH augmentation, `which` lookup, or shell-env resolution exists anywhere. **Because all resolution is bare-name, ONE correction to `process.env.PATH` fixes every site — no per-site plumbing.**
2. The stub-harness spawn (`ipc.ts` → `harnessRunner.ts:68`) uses `process.execPath` (absolute) + a script path — immune to the PATH problem, but the packaged script-path branch (`stubHarnessPath()` `ipc.ts:44-49`: dev `scripts/`, packaged `process.resourcesPath/scripts/`) needs an `extraResources` copy that does not exist yet.
3. `app.getVersion()` (`ipc.ts:60`) reads `package.json.version` = `0.0.0`; the footer already surfaces it (no-fake-pixels sweep). `setAppUserModelId('com.naccode.app')` (`index.ts:53`) is the natural `appId`.
4. `userData`-based persistence (`persistence/store.ts`, `ledgerStore.ts`) is already packaging-safe. No native modules. electron-vite output (`out/main`, `out/preload`, `out/renderer`) already matches electron-builder's default `files` shape. `electron-builder` is 100% absent (no dep, no config, no icons, no entitlements).

## Design

### 1. Shell-PATH resolution (`src/main/runtime/shellPath.ts` — new)

The load-bearing fix. Pure-where-possible, thin at the spawn boundary.

- `shellPathArgs(): string[]` (pure, exported) → `['-ilc', 'command -v true >/dev/null 2>&1; printf "%s" "$PATH"']` — interactive+login shell so rc files that set PATH are sourced; the `printf` (no trailing newline) is the only stdout we trust; the `command -v true` prefix is a harmless marker keeping the intent explicit.
- `mergePath(current: string | undefined, discovered: string): string` (pure, exported) → union of `current` (kept first, so nothing already resolvable breaks) then discovered entries not already present, joined by `:`. Empty/whitespace discovered → returns `current ?? ''` unchanged.
- `async resolveShellPath(spawnImpl?, opts?): Promise<string | null>` — spawns `process.env.SHELL || '/bin/zsh'` with `shellPathArgs()`, 3000ms timeout, captures stdout; returns the trimmed PATH string, or `null` on timeout / nonzero exit / empty output / spawn error. `spawnImpl` is injectable for tests (defaults to `child_process.spawn`).
- `async applyShellPath(): Promise<void>` — the orchestrator called from `index.ts`. Guards (return early, no-op):
  - `!app.isPackaged` → dev already inherited the terminal's PATH.
  - `process.platform === 'win32'` → Windows PATH/shell semantics differ; deferred with the `PlatformServices` note.
  - Otherwise: `const discovered = await resolveShellPath()`; if non-null, `process.env.PATH = mergePath(process.env.PATH, discovered)`. On null, leave PATH untouched (the app still runs; CLIs honestly probe as "not installed" — already-modeled UX).

### 2. Startup wiring (`src/main/index.ts`)

In `app.whenReady().then(...)`, call `await applyShellPath()` FIRST — before `registerRuntimeIpc(...)` and before `createWindow()` — so the registry probe (which runs on the picker's first mount) and every subsequent spawn see the corrected PATH. The existing `setAppUserModelId` and window creation follow unchanged.

### 3. electron-builder config (`electron-builder.yml` — new, + package.json)

- Add `electron-builder` (latest 24.x) to `devDependencies`.
- `package.json` version `0.0.0` → `0.1.0`; new scripts:
  - `"package": "electron-vite build && electron-builder"`
  - `"package:dir": "electron-vite build && electron-builder --dir"` (unpacked, fast iteration)
- `electron-builder.yml`:
  ```yaml
  appId: com.naccode.app
  productName: NAC Code
  directories:
    output: release
    buildResources: build
  files:
    - out/**/*
    - package.json
  extraResources:
    - from: scripts
      to: scripts
  asar: true
  mac:
    target:
      - dmg
      - zip
    category: public.app-category.developer-tools
    identity: null            # ad-hoc/self-signed for a local build; notarization is a later pass
    hardenedRuntime: false    # OFF so an unsigned build can spawn subprocesses locally
    icon: build/icon.icns
  linux:
    target:
      - AppImage
      - deb
    category: Development
    icon: build/icon.png
  ```
  (Windows target intentionally omitted — deferred.)
- `directories.output: release` → add `release/` to `.gitignore`.

### 4. Icons (`build/` — new)

Single source of truth: commit `build/icon.png` at 1024×1024 — an "NC" monogram on the app accent color. electron-builder's own icon pipeline derives the macOS `.icns` and the Linux size variants from that one PNG (it accepts a single ≥512×512 `build/icon.png`), so the config's `mac.icon`/`linux.icon` both point at it (or omit the explicit paths and let electron-builder auto-discover `build/icon.png`). The PNG is generated once by a committed helper `scripts/make-icon.mjs` — it writes a hand-authored SVG (`build/icon.svg`, committed) and rasterizes it to `build/icon.png` via a minimal path (sharp is a heavyweight native dep to avoid; use the already-present Electron/Chromium `nativeImage`-free route: render the SVG through a tiny data-URI `<img>` in an offscreen `BrowserWindow` during a one-off `npm run make-icon`, or — simplest and dependency-free — hand-produce the 1024×1024 PNG once and commit it, keeping `scripts/make-icon.mjs` as the documented regeneration recipe). DECISION: commit `build/icon.png` (1024×1024) + `build/icon.svg` source; the PNG is the artifact electron-builder consumes. This is a REAL functioning icon — placeholder art, explicitly swap-later, not a fake pixel.

### 5. Error handling

- `resolveShellPath` never throws to the caller — all failure modes (timeout, nonzero exit, empty output, ENOENT on the shell itself) resolve to `null`.
- `applyShellPath` is fire-and-awaited but its failure never blocks startup (it only ever no-ops PATH).
- Packaged-path `ENOENT` on `stub-harness.mjs` is prevented by `extraResources`; if the copy were ever missing, the existing run-error path surfaces it inline (no crash).

## Testing

- `src/main/runtime/shellPath.test.ts`: `shellPathArgs` exact shape; `mergePath` (union, dedup, order-preserving, empty-discovered passthrough, undefined-current); `resolveShellPath` with an injected fake spawn (success → trimmed PATH; timeout → null; nonzero exit → null; empty stdout → null; spawn 'error' event → null). `applyShellPath` guard behavior via injected `app.isPackaged`/`platform` seams (extract the guard predicate as a pure `shouldResolveShellPath(isPackaged, platform)` for direct testing).
- Full `npx vitest run` + `npm run typecheck` stay green; `electron-vite build` clean.
- **Live verification (mandatory final task):** run `npm run package`; install/mount the DMG; launch the **.app from Finder** (NOT terminal — the entire point). Matrix:
  1. CLI-connections panel shows the four providers `authenticated` — proving the shell-PATH merge worked from a Finder launch.
  2. **Control check**: confirm the fix is load-bearing — temporarily neuter it (e.g. a `package:dir` build with `applyShellPath` short-circuited, or launch with a scrubbed PATH) and observe the panel showing `not installed`, then the real build showing `authenticated`.
  3. A real interactive claude turn runs end-to-end (proving transport spawn resolves).
  4. The stub/fallback provider finds `resources/scripts/stub-harness.mjs` (send on a stub provider or trigger the fallback).
  5. Footer shows version `0.1.0`; app quits and relaunches cleanly.
  - (Linux AppImage smoke is best-effort — verify it builds; a full Linux launch needs a Linux host, noted if unavailable.)

## Non-goals

Apple notarization / Developer-ID signing / Gatekeeper distribution (own pass, needs the Apple Developer account). Windows target + Windows PATH resolution. User-configurable CLI binary paths (follow-up feature; the `binPath` seam + transport-layer override plumbing would land then). Auto-update. Final icon art. SQLite migration.
