# Notarization pass (Developer-ID signing + Apple notarization + CI releases) — Design

**Date:** 2026-07-10
**Status:** Approved (approach A — layered config + electron-builder built-in notarization; enrollment-ready)
**Scope decision:** The feature lands **"enrollment-ready"**: the owner is enrolling in the Apple Developer Program now (approval takes ~24-48h), so all config/code/CI ships and is verified in dry-run form today, the ad-hoc daily build stays working unchanged, and `docs/RELEASING.md` documents the manual Apple-side steps. The first live notarized release is executed once Apple approves. CI also builds the Linux AppImage/deb (closing the never-built-on-mac gap). DEFERRED to their own passes: Windows, auto-update, final icon art.

## Goal

`npm run package:release` (locally) and a `v*` tag push (CI) produce a Developer-ID-signed, hardened-runtime, notarized, stapled macOS DMG/zip that passes Gatekeeper on any Mac — plus unsigned Linux AppImage/deb from CI — while the daily `npm run package` ad-hoc build (PR #10) keeps working exactly as it does today, with zero dependence on Apple credentials.

## Current state (main @ 75668fb)

- `electron-builder.yml` has `identity: null` + `hardenedRuntime: false` — ad-hoc local build only.
- **Zero code-signing identities on this Mac** (`security find-identity -v -p codesigning` → 0); no Apple Developer account yet (enrolling).
- `notarytool` available (Xcode CLT 1.1.2). electron-builder 26.15.3 has built-in notarization support.
- No entitlements file. `.gitignore` scopes `build/*` with explicit un-ignores for the two icon assets.
- No GitHub Actions workflows exist in the repo.

## Design

### 1. Config layering (`electron-builder.yml` tweak + `electron-builder.release.yml` new)

The subtlety driving the layout: `identity: null` **cannot be un-set by an extending config** (electron-builder deep-merges, and an explicit null force-disables signing). So:

- **Base `electron-builder.yml`**: REMOVE the `identity: null` line (everything else unchanged). The base no longer decides signing.
- **Daily scripts pin ad-hoc on the CLI** (highest precedence): 
  - `"package": "electron-vite build && electron-builder -c.mac.identity=null"`
  - `"package:dir": "electron-vite build && electron-builder --dir -c.mac.identity=null"`
  - Behavior is byte-for-byte today's; the skip-signing choice just moves from YAML to the script invocation, where it's explicit.
- **`electron-builder.release.yml`** (new):
  ```yaml
  extends: ./electron-builder.yml
  mac:
    hardenedRuntime: true
    gatekeeperAssess: false
    entitlements: build/entitlements.mac.plist
    entitlementsInherit: build/entitlements.mac.plist
    notarize: true
  ```
  No `identity` key → electron-builder auto-discovers the Developer ID Application cert (locally from the login keychain; in CI from `CSC_LINK`/`CSC_KEY_PASSWORD`). Note the merged base still carries `hardenedRuntime: false` → the release file overrides it to `true`.
- **New script**: `"package:release": "electron-vite build && electron-builder --config electron-builder.release.yml"`.
- A stray `npx electron-builder` (no flags) auto-discovers: with no cert it skips signing (harmless), with a cert it signs — acceptable.

### 2. Entitlements (`build/entitlements.mac.plist` — new)

Minimal hardened-runtime entitlements for Electron 31:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
  </dict>
</plist>
```

- `allow-jit` is required by V8 under hardened runtime. Nothing else: spawning the wrapped CLIs (claude/codex/copilot/opencode/git) needs **no entitlement** — hardened runtime constrains what loads *into* the process (libraries, injection), not what it spawns; children run under their own signatures. No native modules → no `disable-library-validation`.
- Documented fallback (in RELEASING.md): if the notarized app ever crashes at V8 startup, add `com.apple.security.cs.allow-unsigned-executable-memory` — but §5's pre-enrollment live test is expected to prove `allow-jit` alone suffices.
- `.gitignore` gains `!build/entitlements.mac.plist` (the `build/*` scoping from PR #10 would otherwise ignore it).

### 3. Notarization credentials (electron-builder built-in; no afterSign hook)

- **Local**: one-time `xcrun notarytool store-credentials <profile>` (Apple ID + app-specific password + team id, held in the login keychain), then `APPLE_KEYCHAIN_PROFILE=<profile> npm run package:release`. Fallback (guaranteed path if the keychain-profile env is finicky): `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` env vars.
- **CI**: repo secrets `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (notarization) + `CSC_LINK` (base64 .p12), `CSC_KEY_PASSWORD` (signing).
- electron-builder signs → submits to notarytool → **staples the .app** automatically; the DMG and zip then carry the stapled app. (A zip cannot itself be stapled — standard Electron practice; the stapled app inside satisfies Gatekeeper offline.)
- **Failure mode**: `package:release` without cert/creds fails loudly mid-build. Correct — a release is a deliberate act; the daily `package` path never touches any of this.

### 4. CI release workflow (`.github/workflows/release.yml` — new)

Trigger: push of tags matching `v*`. Two independent jobs, both attaching artifacts to one **draft** GitHub Release (owner publishes manually after a smoke check):

- **mac** (`macos-latest`): checkout → Node 20 + `npm ci` → `npm run package:release` with the five secrets in env → upload `release/*.dmg`, `release/*.zip` (+ blockmaps) via `softprops/action-gh-release` (`draft: true`).
- **linux** (`ubuntu-latest`): checkout → Node 20 + `npm ci` → `electron-vite build && electron-builder --linux` → upload `release/*.AppImage`, `release/*.deb`. Unsigned — normal for Linux. Closes the gap left by PR #10 (a mac host can't build these).
- Version source: tag must match `package.json` version (the workflow asserts this and fails early on mismatch — prevents a `v0.2.0` tag shipping a `0.1.0` build).

### 5. Verification

**Now, pre-enrollment (this pass):**
1. Suite + typecheck + `electron-vite build` green.
2. Daily path unchanged: `npm run package` produces the DMG, signing skipped, packaged binary boots under a scrubbed env (PR #10's smoke).
3. **Entitlements live test (the crash-risk component, provable without any Apple account):** build via `package:dir`, then manually `codesign --force --sign - --options runtime --entitlements build/entitlements.mac.plist "release/mac-arm64/NAC Code.app"`, launch, confirm the app boots and renders (V8 running under hardened runtime + our entitlements). This de-risks the only part of notarization that could break the app itself.
4. Release config parses: `package:release` runs and stops at the Apple-gated step — with no identity, electron-builder either hard-fails at signing or warn-skips it and fails at notarization (record which). Either outcome proves the config is valid end-to-end up to the parts that need the account.
5. Workflow YAML validated (actionlint if available, else `gh` parse / careful review).

**Later, post-enrollment (documented in RELEASING.md, executed as the first real release):**
`spctl --assess --type exec` passes on the .app; `xcrun stapler validate` passes; quarantine test (`xattr -w com.apple.quarantine ...` on the DMG or a fresh download on another Mac) opens without Gatekeeper warnings; tag push produces the draft release with all four artifacts.

### 6. Runbook (`docs/RELEASING.md` — new)

Step-by-step, written for the owner: enroll in the Apple Developer Program → create the **Developer ID Application** certificate (portal + CSR or Xcode) → export `.p12` → import to login keychain (local) + base64 into `CSC_LINK`/`CSC_KEY_PASSWORD` secrets (CI) → create app-specific password at appleid.apple.com → `notarytool store-credentials` (local) + the three `APPLE_*` secrets (CI) → bump `package.json` version → tag `vX.Y.Z` + push → smoke the draft release → publish. Plus the post-enrollment verification checklist from §5 and the `allow-unsigned-executable-memory` fallback note.

### 7. Docs

DECISIONS.md Current-phase entry marks the feature **"enrollment-ready — live notarization pending Apple approval"** (honest about what was and wasn't verified), and `docs/README.md` gains the RELEASING.md pointer.

## Non-goals

Windows signing/targets. Auto-update (Squirrel/electron-updater — its own pass; notarized zip+blockmaps land ready for it). Final icon art. Mac App Store distribution. Publishing releases automatically (draft-only by design).
