# Packaging (electron-builder) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run package` produces an installable, Finder-launchable macOS `.app`/DMG + Linux AppImage/deb that actually works — the packaged app resolves the four wrapped CLIs by merging the login shell's PATH at startup.

**Architecture:** One new module (`shellPath.ts`) merges `$SHELL -ilc 'echo $PATH'` into `process.env.PATH` once at startup, before anything spawns — because every spawn site resolves bare names against PATH, this single correction fixes all of them. An `electron-builder.yml` + `extraResources` + a placeholder icon complete the packaging.

**Tech Stack:** Electron 31, electron-vite, electron-builder (new), vitest. No native modules.

**Spec:** `docs/superpowers/specs/2026-07-10-packaging-design.md`.

## Global Constraints

- Approach A only: fix `process.env.PATH` once; NEVER add per-spawn-site plumbing (the ~11 sites stay untouched).
- `applyShellPath` no-ops (never touches PATH) when `!app.isPackaged` OR `process.platform === 'win32'`; on any resolution failure it leaves PATH unchanged (the app still runs; CLIs honestly probe "not installed").
- `mergePath` keeps existing PATH entries first (nothing already resolvable breaks), appends only new ones, dedups, `:`-joined.
- Exact identity: `appId: com.naccode.app` (matches `setAppUserModelId` in index.ts), `productName: NAC Code`. Version `0.0.0` → `0.1.0`.
- `extraResources: [{ from: scripts, to: scripts }]` — makes the packaged `process.resourcesPath/scripts/stub-harness.mjs` branch (ipc.ts stubHarnessPath) real.
- mac: `identity: null`, `hardenedRuntime: false` (ad-hoc local build; notarization deferred). No Windows target.
- Electron-touching code stays thin + untested (verified live, per repo convention — main tests mock nothing, they test extracted pure fns). Pure helpers are unit-tested.
- All tests green + `npm run typecheck` + `electron-vite build` clean before every commit. Work in a NEW worktree from current main. NEVER touch the main checkout from implementers.

---

### Task 1: shellPath module (pure helpers + injectable resolver)

**Files:**
- Create: `src/main/runtime/shellPath.ts`
- Test: `src/main/runtime/shellPath.test.ts`

**Interfaces (Produces):**
- `shellPathArgs(): string[]` — the shell argv.
- `mergePath(current: string | undefined, discovered: string): string`.
- `shouldResolveShellPath(isPackaged: boolean, platform: NodeJS.Platform): boolean`.
- `resolveShellPath(spawnImpl?: SpawnLike, timeoutMs?: number): Promise<string | null>` — `SpawnLike = (cmd: string, args: string[]) => ChildProcessLike` where `ChildProcessLike` exposes `stdout: { on(ev:'data', cb:(c:Buffer)=>void):void }`, `on(ev:'error'|'close', cb:(arg:unknown)=>void):void`, `kill():void`. Injectable for tests; defaults to `child_process.spawn`.
- `applyShellPath(): Promise<void>` — reads `app.isPackaged`/`process.platform`, guards via `shouldResolveShellPath`, resolves + merges into `process.env.PATH`.

- [ ] **Step 1: Write failing tests**

```ts
// src/main/runtime/shellPath.test.ts
import { describe, it, expect } from 'vitest'
import { shellPathArgs, mergePath, shouldResolveShellPath, resolveShellPath } from './shellPath'

describe('shellPathArgs', () => {
  it('is a login+interactive shell that prints only $PATH', () => {
    expect(shellPathArgs()).toEqual(['-ilc', 'command -v true >/dev/null 2>&1; printf "%s" "$PATH"'])
  })
})

describe('mergePath', () => {
  it('keeps current entries first, appends new discovered ones, dedups, colon-joined', () => {
    expect(mergePath('/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin:/Users/x/.local/bin'))
      .toBe('/usr/bin:/bin:/opt/homebrew/bin:/Users/x/.local/bin')
  })
  it('handles an undefined current path', () => {
    expect(mergePath(undefined, '/opt/homebrew/bin:/usr/bin')).toBe('/opt/homebrew/bin:/usr/bin')
  })
  it('empty/whitespace discovered leaves current unchanged', () => {
    expect(mergePath('/usr/bin', '   ')).toBe('/usr/bin')
    expect(mergePath('/usr/bin', '')).toBe('/usr/bin')
    expect(mergePath(undefined, '')).toBe('')
  })
})

describe('shouldResolveShellPath', () => {
  it('only runs for a packaged, non-Windows app', () => {
    expect(shouldResolveShellPath(true, 'darwin')).toBe(true)
    expect(shouldResolveShellPath(true, 'linux')).toBe(true)
    expect(shouldResolveShellPath(false, 'darwin')).toBe(false) // dev already has the terminal PATH
    expect(shouldResolveShellPath(true, 'win32')).toBe(false)   // deferred
  })
})

describe('resolveShellPath', () => {
  const fakeSpawn = (stdout: string, opts: { errorEvent?: Error; exitCode?: number } = {}) => () => {
    const stdoutCbs: ((c: Buffer) => void)[] = []
    const closeCbs: ((code: number) => void)[] = []
    const errCbs: ((e: Error) => void)[] = []
    queueMicrotask(() => {
      if (opts.errorEvent) { errCbs.forEach((cb) => cb(opts.errorEvent!)); return }
      if (stdout) stdoutCbs.forEach((cb) => cb(Buffer.from(stdout)))
      closeCbs.forEach((cb) => cb(opts.exitCode ?? 0))
    })
    return {
      stdout: { on: (_e: string, cb: (c: Buffer) => void) => stdoutCbs.push(cb) },
      on: (e: string, cb: (a: never) => void) => { if (e === 'close') closeCbs.push(cb as never); if (e === 'error') errCbs.push(cb as never) },
      kill: () => {}
    }
  }

  it('returns the trimmed PATH on a clean exit', async () => {
    expect(await resolveShellPath(fakeSpawn('/opt/homebrew/bin:/usr/bin\n') as never)).toBe('/opt/homebrew/bin:/usr/bin')
  })
  it('returns null on a nonzero exit', async () => {
    expect(await resolveShellPath(fakeSpawn('/x', { exitCode: 1 }) as never)).toBeNull()
  })
  it('returns null on empty output', async () => {
    expect(await resolveShellPath(fakeSpawn('   ') as never)).toBeNull()
  })
  it('returns null on a spawn error', async () => {
    expect(await resolveShellPath(fakeSpawn('', { errorEvent: new Error('ENOENT') }) as never)).toBeNull()
  })
})
```

- [ ] **Step 2: Verify RED** — `npx vitest run src/main/runtime/shellPath.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement**

```ts
// src/main/runtime/shellPath.ts
import { spawn } from 'child_process'
import { app } from 'electron'

interface ChildLike {
  stdout: { on(ev: 'data', cb: (c: Buffer) => void): void } | null
  on(ev: 'error' | 'close', cb: (arg: never) => void): void
  kill(): void
}
type SpawnLike = (cmd: string, args: string[]) => ChildLike

const SHELL_TIMEOUT_MS = 3000

/** Interactive+login shell so rc files that set PATH are sourced; printf (no newline) is the only
 *  stdout we trust — the marker keeps the intent explicit and swallows any pre-prompt noise. */
export function shellPathArgs(): string[] {
  return ['-ilc', 'command -v true >/dev/null 2>&1; printf "%s" "$PATH"']
}

/** Union of the current PATH (kept first — nothing already resolvable breaks) with newly discovered
 *  entries, deduped, colon-joined. Empty/whitespace discovered → current unchanged. */
export function mergePath(current: string | undefined, discovered: string): string {
  const base = (current ?? '').split(':').filter(Boolean)
  const found = discovered.trim() ? discovered.split(':').filter(Boolean) : []
  const seen = new Set(base)
  for (const p of found) if (!seen.has(p)) { base.push(p); seen.add(p) }
  return base.join(':')
}

/** Only a packaged, non-Windows app needs the merge: dev already inherited the terminal's PATH, and
 *  Windows PATH/shell semantics differ (deferred with the PlatformServices note). */
export function shouldResolveShellPath(isPackaged: boolean, platform: NodeJS.Platform): boolean {
  return isPackaged && platform !== 'win32'
}

/** Never throws: timeout / nonzero exit / empty output / spawn error all resolve to null. */
export function resolveShellPath(spawnImpl: SpawnLike = spawn as unknown as SpawnLike, timeoutMs = SHELL_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (v: string | null): void => { if (!done) { done = true; resolve(v) } }
    let child: ChildLike
    try {
      child = spawnImpl(process.env.SHELL || '/bin/zsh', shellPathArgs())
    } catch {
      finish(null); return
    }
    const timer = setTimeout(() => { child.kill(); finish(null) }, timeoutMs)
    child.stdout?.on('data', (c) => { out += c.toString() })
    child.on('error', () => { clearTimeout(timer); finish(null) })
    child.on('close', ((code: number) => {
      clearTimeout(timer)
      finish(code === 0 && out.trim() ? out.trim() : null)
    }) as never)
  })
}

/** Merge the login shell's PATH into the process env once, so bare-name CLI spawns resolve from a
 *  Finder launch. No-ops in dev / on Windows / on any resolution failure. */
export async function applyShellPath(): Promise<void> {
  if (!shouldResolveShellPath(app.isPackaged, process.platform)) return
  const discovered = await resolveShellPath()
  if (discovered) process.env.PATH = mergePath(process.env.PATH, discovered)
}
```

- [ ] **Step 4: Verify GREEN** — `npx vitest run src/main/runtime/shellPath.test.ts` → PASS. Then `npx vitest run` full + `npm run typecheck`.
- [ ] **Step 5: Commit** — `git add src/main/runtime/shellPath.ts src/main/runtime/shellPath.test.ts && git commit -m "feat(pkg): shellPath — merge the login shell's PATH so packaged spawns resolve"`

---

### Task 2: startup wiring

**Files:**
- Modify: `src/main/index.ts` (the `app.whenReady().then(...)` callback)

- [ ] **Step 1: Implement** — make the whenReady callback async and `await applyShellPath()` FIRST, before `registerRuntimeIpc` (the registry probe runs on the picker's first mount, so PATH must be corrected before any spawn). Add the import; leave everything else identical.

```ts
// add to the imports at the top of src/main/index.ts:
import { applyShellPath } from './runtime/shellPath'

// replace the whenReady block:
app.whenReady().then(async () => {
  await applyShellPath() // merge the login shell's PATH BEFORE anything spawns (packaged Finder launch)
  electronApp.setAppUserModelId('com.naccode.app')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  registerRuntimeIpc(() => mainWindow)
  registerPersistenceIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
```

- [ ] **Step 2: Verify** — `npm run typecheck` clean; `npx vitest run` still green (no test imports index.ts); `electron-vite build` clean (confirms the async main entry compiles).
- [ ] **Step 3: Commit** — `git add src/main/index.ts && git commit -m "feat(pkg): apply the shell PATH at startup before the first spawn"`

---

### Task 3: placeholder icon

**Files:**
- Create: `scripts/make-icon.mjs` (the committed regeneration recipe), `build/icon.svg` (source), `build/icon.png` (the 1024×1024 artifact electron-builder consumes)

**Design:** a dependency-free generator — `make-icon.mjs` writes a 1024×1024 RGBA buffer (dark rounded-square background `#141418`, accent-purple `#7c6cf0` "NC" drawn from a 5×7 blocky font scaled up) and encodes it to PNG using ONLY Node built-ins (`zlib` for the IDAT deflate; a small inline CRC-32). A REAL functioning icon; placeholder art, swap-later.

- [ ] **Step 1: Write `scripts/make-icon.mjs`**

```js
// scripts/make-icon.mjs — regenerate build/icon.png (dependency-free; run: node scripts/make-icon.mjs)
import { deflateSync } from 'zlib'
import { writeFileSync } from 'fs'

const S = 1024, BG = [0x14, 0x14, 0x18], FG = [0x7c, 0x6c, 0xf0]
// 5x7 blocky glyphs for N and C (row-major, 1 = filled).
const GLYPHS = {
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110']
}
const buf = Buffer.alloc(S * S * 4)
const px = (x, y, [r, g, b]) => { const i = (y * S + x) * 4; buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255 }
// rounded-square background
const RAD = 180
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const cx = Math.min(x, S - 1 - x), cy = Math.min(y, S - 1 - y)
  const inCorner = cx < RAD && cy < RAD && ((RAD - cx) ** 2 + (RAD - cy) ** 2) > RAD ** 2
  if (!inCorner) px(x, y, BG)
}
// draw "NC": each glyph 5x7, scaled; two glyphs side by side, centered
const CELL = 90, GW = 5 * CELL, GAP = 60, total = GW * 2 + GAP
let ox = (S - total) / 2
const oy = (S - 7 * CELL) / 2
for (const letter of ['N', 'C']) {
  const g = GLYPHS[letter]
  for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (g[r][c] === '1') {
    for (let dy = 0; dy < CELL; dy++) for (let dx = 0; dx < CELL; dx++) px(ox + c * CELL + dx, oy + r * CELL + dy, FG)
  }
  ox += GW + GAP
}
// --- minimal PNG encoder (RGBA, filter 0) ---
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6 // 8-bit, RGBA
const raw = Buffer.alloc(S * (S * 4 + 1))
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4) }
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
])
writeFileSync(new URL('../build/icon.png', import.meta.url), png)
console.log('wrote build/icon.png')
```

- [ ] **Step 2: Create `build/` and `build/icon.svg`** (the human-readable source of the same design, committed for future real-art work):

```bash
mkdir -p build
cat > build/icon.svg <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="180" fill="#141418"/>
  <text x="512" y="600" font-family="monospace" font-weight="700" font-size="360" fill="#7c6cf0" text-anchor="middle">NC</text>
</svg>
SVG
```

- [ ] **Step 3: Generate the PNG** — `node scripts/make-icon.mjs` → writes `build/icon.png`. Verify: `file build/icon.png` reports `PNG image data, 1024 x 1024`.
- [ ] **Step 4: Commit** — `git add scripts/make-icon.mjs build/icon.svg build/icon.png && git commit -m "feat(pkg): placeholder NC app icon (build/icon.png + svg + generator)"`

---

### Task 4: electron-builder config, deps, scripts, version

**Files:**
- Create: `electron-builder.yml`
- Modify: `package.json` (version, scripts, devDependency), `.gitignore` (release/)

- [ ] **Step 1: Add electron-builder** — `npm install --save-dev electron-builder` (installs latest 25.x, compatible with Electron 31). Confirm it lands in `devDependencies`.
- [ ] **Step 2: package.json** — set `"version": "0.1.0"`; add scripts:

```json
"package": "electron-vite build && electron-builder",
"package:dir": "electron-vite build && electron-builder --dir"
```

- [ ] **Step 3: Create `electron-builder.yml`**

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
  identity: null
  hardenedRuntime: false
  icon: build/icon.png
linux:
  target:
    - AppImage
    - deb
  category: Development
  icon: build/icon.png
```

- [ ] **Step 4: `.gitignore`** — append `release/` (electron-builder output; never committed).
- [ ] **Step 5: Verify the config builds an unpacked app** — `npm run package:dir` → completes without error; `ls release/` shows a `mac*/NAC Code.app` (or `linux-unpacked/` on Linux). Confirm `release/**/Resources/scripts/stub-harness.mjs` exists (extraResources worked): on mac `ls "release/mac-arm64/NAC Code.app/Contents/Resources/scripts/stub-harness.mjs"`. (If `package:dir` can't run in this environment, run `npx electron-builder --dir --config electron-builder.yml` and report; the config is still asserted by Task 5's live build.)
- [ ] **Step 6: full gate** — `npx vitest run && npm run typecheck && npm run build`.
- [ ] **Step 7: Commit** — `git add electron-builder.yml package.json package-lock.json .gitignore && git commit -m "feat(pkg): electron-builder config, package scripts, version 0.1.0"`

---

### Task 5: live verification (controller, computer use) + docs + final review

**Files:**
- Modify: `docs/DECISIONS.md`

- [ ] **Step 1: Build the real DMG** — `npm run package` (full, not `--dir`). Report the artifact paths under `release/` (e.g. `release/NAC Code-0.1.0-arm64.dmg`, `.zip`). If mac signing balks even with `identity: null`, note the exact message; ad-hoc should proceed.
- [ ] **Step 2: Live matrix** (controller drives via computer use — the app is INSTALLED and launched from FINDER, never a terminal):
  1. Mount the DMG, drag NAC Code to /Applications (or launch the `.app` from `release/mac-*/`), quit any running dev instance first, and open it **from Finder/Launchpad**.
  2. **PATH fix works (headline)**: the Inspector CLI-Connections panel shows the four providers `authenticated` — proving the login-shell PATH merge resolved the CLIs from a Finder launch (which otherwise has a minimal PATH).
  3. **Control check (fix is load-bearing)**: quit; relaunch from a scrubbed environment to show the failure mode — `env -i "/Applications/NAC Code.app/Contents/MacOS/NAC Code"` (empty env → the shell probe still runs, so instead force the negative by temporarily renaming the user's shell rc or, simplest, launch the `package:dir` build with `applyShellPath` disabled via a one-line local patch) → panel shows `not installed`. Restore. This confirms the merge is what fixes it, not ambient PATH. (Record whichever negative-control method actually reproduced "not installed".)
  4. A real interactive **claude** turn runs end-to-end in the packaged app (transport spawn resolves post-merge): send "say exactly: packaged" → recall.
  5. Stub/fallback resource: confirm `Contents/Resources/scripts/stub-harness.mjs` exists and a fallback/stub run finds it (no ENOENT).
  6. Footer shows **Version 0.1.0**; quit and relaunch cleanly.
  7. Linux AppImage: best-effort — confirm `npm run package` emitted the AppImage/deb; a full Linux launch needs a Linux host (note if unavailable).
- [ ] **Step 3: Final gate** — `npm run typecheck && npx vitest run && npm run build`.
- [ ] **Step 4: DECISIONS entry** at the top of Current phase (replace `<commit>`) + roadmap item 4 checked off:

```markdown
**✅ Packaging — daily-drivable local build** (`<commit>`): `npm run package` produces an installable macOS DMG/zip + Linux AppImage/deb (electron-builder; appId com.naccode.app, productName "NAC Code", version 0.1.0). The hard blocker is solved: a Finder-launched .app inherits a minimal PATH that excludes where the four wrapped CLIs live, so `shellPath.applyShellPath()` merges the login shell's `$PATH` (`$SHELL -ilc printf $PATH`) into `process.env.PATH` ONCE at startup before any spawn — and because every spawn site (registry probe, four adapters, all transport classes, git) resolves bare names, that single correction cascades to all of them (zero per-site changes). No-ops in dev / on Windows / on any resolution failure (CLIs then honestly probe "not installed"). extraResources ships scripts/stub-harness.mjs to Resources/. Verified live: the packaged app launched FROM FINDER shows the four CLIs authenticated (a scrubbed-PATH control confirms the merge is load-bearing — without it they read "not installed"), a real interactive claude turn runs, footer shows 0.1.0. Placeholder NC icon (build/icon.png, swap-later). Ad-hoc/self-signed (identity: null, hardenedRuntime false) — Apple notarization/Gatekeeper distribution, Windows, and user-configurable CLI paths are their own later passes. Spec: `docs/superpowers/specs/2026-07-10-packaging-design.md`.
```

Also flip roadmap item 4 to ✅ in the same edit.
- [ ] **Step 5: Commit** — `git add docs/DECISIONS.md && git commit -m "docs: packaging done — Finder-launched build resolves CLIs via login-shell PATH"`

Then: final whole-branch review (most capable model), one fix subagent for findings, re-review, `superpowers:finishing-a-development-branch`.
