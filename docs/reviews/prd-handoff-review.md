# NAC Code PRD and Handoff Review

Date: June 28, 2026 · **Resolutions added 2026-06-29**

> **Resolution status (2026-06-29).** This review was written against the *original* PRD/handoff, before the v1 build. The engineering plan adopted most of its recommendations, and the v1 implementation has since **resolved the majority of findings** — durable persistence, real read-only git change review, real per-provider cost metering, four real harness adapters, permission wiring, and context-file semantics are all in. Each finding and open question below now carries a **Status** line. Canonical current state lives in [`docs/DECISIONS.md`](../DECISIONS.md). The reviewed `design_handoff_nac_code/*` files now live under [`docs/design/`](../design/).

Scope reviewed:
- `design_handoff_nac_code/NAC Code PRD.dc.html`
- `design_handoff_nac_code/README.md`
- Prototype source files in `design_handoff_nac_code/*.dc.html`
- Screenshot metadata in `design_handoff_nac_code/screenshots/`

## Executive Summary

The product direction is coherent and the handoff is unusually concrete for a prototype bundle. The strongest through-line is the "per-chat state" spine: model, provider, agent, attached context, active configuration, and compaction state all belong to the individual chat. That is the right central abstraction and the rest of the product hangs off it cleanly.

The main issue is scope clarity. The PRD repeatedly marks prototype behavior as "Implemented" even where the handoff or prototype source shows hard-coded demo data, toast-only actions, placeholder health, or planned production integrations. That creates implementation risk because an engineer could interpret visual/prototype coverage as production acceptance.

The highest-value cleanup is to split each requirement into two statuses:
- Prototype coverage: whether the interactive mock demonstrates the surface.
- Product delivery status: whether the actual app must ship the behavior in v1.

## Findings

### P0 - Durable Resume Is Promised, But Not In v1

**Status: ✅ Resolved.** Durable persistence was promoted to v1/P0 — the per-chat transcript, config, workspaces, and saved context persist across launches (JSON `userData/nac-state.json`, atomic write; tolerant hydration on schema drift). Resume across restarts is a v1 guarantee, not roadmap.

The product problem and representative use cases center on resuming yesterday's task with model, agent, context, and setup restored exactly. The PRD also states that "sessions bleed together" because prior work is not bound to a durable conversation.

However, the non-functional persistence requirement only promises persistence "within a session", while durable persistence across launches is listed as a roadmap requirement.

Evidence:
- `design_handoff_nac_code/NAC Code PRD.dc.html:129`
- `design_handoff_nac_code/NAC Code PRD.dc.html:156`
- `design_handoff_nac_code/NAC Code PRD.dc.html:581`
- `design_handoff_nac_code/NAC Code PRD.dc.html:633`

Recommendation:
Promote durable chat/config persistence to v1/P0, or narrow the v1 promise so it is explicit that resume is only guaranteed during the current app session. If the product is meant to replace CLI harnesses for real daily work, durable persistence should probably be in v1.

### P0 - "Implemented" Conflates Prototype UI With Production Behavior

**Status: ✅ Largely resolved.** v1 ships real behavior rather than prototype stubs: four real harness adapters (Claude/Codex/Copilot/OpenCode), a real git-backed Changes view, and real per-provider cost/token metering. The status-taxonomy concern is largely moot for shipped surfaces. Still stubs: IDE/Finder launch (toast) and the provider-connection UI (credentials are delegated to the harness CLIs, not stored by NAC).

The PRD marks many requirements as implemented, but the prototype often implements only a visual state or toast. The handoff explicitly says the `.dc.html` files are reference prototypes and that OS actions are stubs.

Examples:
- IDE launch and Finder reveal are marked implemented in the PRD, but the prototype only shows toast messages.
- Changed files and repos are generated from hard-coded demo data.
- Cost values are provider-aware, but they are illustrative constants rather than live metering.
- Provider connection flips a local `connected` boolean after an API-key field interaction; it does not specify credential storage or provider validation.

Evidence:
- `design_handoff_nac_code/README.md:8`
- `design_handoff_nac_code/README.md:92`
- `design_handoff_nac_code/FileExplorer.dc.html:160`
- `design_handoff_nac_code/FileExplorer.dc.html:203`
- `design_handoff_nac_code/Harness.dc.html:781`
- `design_handoff_nac_code/Harness.dc.html:1041`
- `design_handoff_nac_code/NAC Code PRD.dc.html:485`
- `design_handoff_nac_code/NAC Code PRD.dc.html:500`

Recommendation:
Replace blanket "Implemented" labels with clearer wording such as:
- `Prototype: implemented`
- `Product v1: required`
- `Product v1: stub`
- `Roadmap: planned`

This will keep the design reference useful without overstating product readiness.

### P1 - The Data Model Is Too Thin For The Promised Surfaces

**Status: 🟡 Partially resolved.** Added since the review: `Turn`/`messages` (the provider-neutral transcript), `ProviderUsage` (per-provider token/cost metering = TokenUsage + CostEvent), compaction checkpoints (`summary`/`summarizedThrough`), and `seededAttachments`. Not yet modeled as first-class entities: structured `ToolCall`/`ToolResult` (tool actions are currently flattened into transcript text) and `ChangeSet` (changes are read live from git rather than stored).

The conceptual data model lists top-level entities such as Workspace, Chat, ContextItem, Configuration, Provider, Agent, Repository, ChangedFile, and Connection. That is a good start, but it does not model the data needed for the session stats, token chart, cost breakdown, tool timeline, or reliable change review.

Missing model concepts:
- `Message` or `Turn`
- `ToolCall`
- `ToolResult`
- `TokenUsage`
- `CostEvent`
- `SessionStats`
- `ChangeSet`
- `AttachmentSnapshot`
- `ProviderCredential` or `ProviderConnection`

Evidence:
- `design_handoff_nac_code/NAC Code PRD.dc.html:448`
- `design_handoff_nac_code/NAC Code PRD.dc.html:456`
- `design_handoff_nac_code/NAC Code PRD.dc.html:460`
- `design_handoff_nac_code/NAC Code PRD.dc.html:464`
- `design_handoff_nac_code/NAC Code PRD.dc.html:585`

Recommendation:
Extend section 10 before implementation starts. The missing entities are not implementation details; they define what the product can faithfully restore, summarize, and audit.

### P1 - Security And Trust Requirements Are Missing

**Status: 🟡 Partially resolved.** In place: Electron hardening (contextIsolation + sandbox on, nodeIntegration off; the renderer reaches main only through a typed, allowlisted preload bridge); the YOLO toggle maps to each harness's real permission flags (codex sandbox, copilot tool grants, claude permission mode); credentials are **delegated to the harness CLIs**, so NAC stores no provider keys. Still open and tracked for M0-2: secrets redaction in logs/prompts/tool output, an audit trail for re-auth/provider/destructive-git actions, and secret-bearing context-file handling.

The recommended app stack needs local filesystem, git, process, IDE launch, and provider credential access. The PRD also includes CLI auth and provider API-key flows. The NFR section does not yet cover credential storage, secrets redaction, command permissions, local process boundaries, or auditability.

Evidence:
- `design_handoff_nac_code/README.md:11`
- `design_handoff_nac_code/NAC Code PRD.dc.html:361`
- `design_handoff_nac_code/NAC Code PRD.dc.html:409`
- `design_handoff_nac_code/NAC Code PRD.dc.html:531`
- `design_handoff_nac_code/NAC Code PRD.dc.html:573`

Recommendation:
Add a security and trust NFR group covering:
- API key storage in OS keychain or equivalent secure store.
- Redaction rules for logs, prompts, tool output, and screenshots.
- Confirmation/permission model for file writes, shell commands, IDE launch, and out-of-workspace repo actions.
- Audit trail for re-auth, provider changes, and destructive git operations.
- Handling of secret-bearing context files.

### P1 - Live VCS Integration Is Roadmap, But Change Review Is A Core Promise

**Status: ✅ Resolved (read-only, as recommended).** The Changes view now reads the real git working tree of the active workspace — branch, `status --porcelain`, `diff --numstat`, and per-file unified diff + source. Staging/commit/push are intentionally left to roadmap, exactly as the recommendation suggested.

The PRD's goals and handoff position full change review as one of the product's central differentiators. Yet live VCS integration, staging, committing, and pushing are roadmap requirements. The v1 PRD marks the Changes view as implemented, but the prototype is driven by fixed demo data.

Evidence:
- `design_handoff_nac_code/NAC Code PRD.dc.html:140`
- `design_handoff_nac_code/NAC Code PRD.dc.html:471`
- `design_handoff_nac_code/NAC Code PRD.dc.html:621`
- `design_handoff_nac_code/Harness.dc.html:781`
- `design_handoff_nac_code/Harness.dc.html:818`

Recommendation:
Decide whether v1 includes live read-only VCS integration. It is reasonable to leave staging/commit/push for later, but the v1 product should probably read real git status, diffs, branches, and repo roots if "visibility into work" is a core launch promise.

### P2 - Context File Lifecycle Is Underspecified

**Status: 🟡 Mostly resolved (decided + implemented).** Attached files are **live path references**, read at send time (not attach-time snapshots); content is size-capped (~200 KB, truncated) and read best-effort as UTF-8; a missing/unreadable file injects nothing. Authored **notes** are stored inline. Workspace scope is displayed, not enforced in v1. Remaining: explicit binary detection and re-tokenization of counts.

Files are treated as first-class static context items, but the PRD does not define whether attached files are snapshots or live references, what happens when files change or disappear, how large/binary files are handled, or whether token counts are recalculated.

Evidence:
- `design_handoff_nac_code/README.md:50`
- `design_handoff_nac_code/README.md:54`
- `design_handoff_nac_code/README.md:56`
- `design_handoff_nac_code/Harness.dc.html:866`
- `design_handoff_nac_code/ContextManager.dc.html:247`

Recommendation:
Specify file context semantics:
- Snapshot at attach time vs live path reference.
- Refresh/re-tokenize behavior.
- Missing/deleted file state.
- Binary and oversized file handling.
- Workspace-scope enforcement in v1 or clear non-enforcement.

### P2 - Screenshots Are Below The Declared Minimum Width

**Status: ⬜ Open (design artifact, low impact).** Not relevant to the implemented app (the real UI enforces `minWidth` 1180); the reference screenshots were not regenerated.

The handoff says the app has a minimum width of 1180px, but all provided screenshots are 924px wide. The README also notes that some right-anchored popovers clip at that capture width.

Evidence:
- `design_handoff_nac_code/README.md:27`
- `design_handoff_nac_code/README.md:120`
- `design_handoff_nac_code/README.md:135`

Recommendation:
Regenerate the reference screenshots at 1180px or wider, and optionally keep the 924px captures as "below-min-width stress examples." The primary implementation reference should not show known clipping.

## Open Questions

1. Is v1 intended to be useful across app restarts, or is it acceptable for v1 to be a single-session shell?
2. Should the Changes view in v1 be connected to real git status and diffs, even if commit/push remain roadmap?
3. Are provider credentials stored by the app, delegated to existing CLIs, or both?
4. Are attached files immutable snapshots or live file references?
5. Should workspace/global context scope be enforced in v1 or only displayed?
6. Does "New Chat" inherit anything from the active chat, workspace defaults, or no configuration at all?

**Answers (2026-06-29):**
1. **Useful across restarts** — yes; durable persistence is in v1.
2. **Changes view on real git** — yes (read-only: status/diff/branches/roots); commit/push remain roadmap.
3. **Provider credentials** — delegated to the existing harness CLIs; NAC stores none.
4. **Attached files** — live path references, read at send time (not snapshots).
5. **Workspace/global scope** — displayed, not enforced in v1.
6. **New Chat inheritance** — workspace defaults first (provider/model/agent), then the active chat, then the `Standard` configuration (M0-4).

## Suggested PRD Edits

> Addressed via the engineering plan, `docs/DECISIONS.md`, and the M0 specs rather than by editing the original (reference-only) PRD. Items 1–5 below are substantially done — see the **Status** lines above.

1. Add a status taxonomy:
   - `Prototype implemented`
   - `V1 required`
   - `V1 stub`
   - `Roadmap planned`

2. Promote or reframe durable persistence:
   - If promoted: move `FR-4.3` into v1 and make it P0.
   - If reframed: update the summary/use cases to say resume is session-scoped in v1.

3. Add production acceptance criteria for integration-heavy requirements:
   - Provider auth.
   - IDE/Finder launch.
   - Real git read model.
   - Cost metering.
   - MCP/CLI health.

4. Expand the conceptual data model with event/history objects:
   - Messages, turns, tool calls, usage, cost events, change sets, and context attachment snapshots.

5. Add security/trust NFRs before implementation.

## Suggested Handoff Edits

1. Keep the high-fidelity UI tokens and layout specs as-is.
2. Add a "Do not infer production readiness from prototype state" note near the top.
3. Add an "Integration contracts needed" section for:
   - Agent runtime adapter.
   - Filesystem and workspace indexer.
   - Git/VCS reader.
   - Provider credential and model registry.
   - Cost/usage collector.
   - OS launch service.
4. Regenerate screenshots at the supported minimum width.

## Bottom Line

The design is directionally strong and internally consistent around the per-chat state model. The documents need one cleanup pass before they are implementation-ready: separate visual prototype completion from product delivery, promote or narrow durable resume, and specify the integration/security model for the desktop app.

**Update (2026-06-29):** the v1 build acted on this review. Durable resume was promoted; change review and cost metering are real; the integration model (four real harness adapters + cross-provider context portability) and the security baseline (Electron hardening, delegated credentials, YOLO→permission mapping) are in. The remaining open items are secrets redaction/audit (M0-2), structured tool-call modeling, and design-artifact cleanup — none blocking.
