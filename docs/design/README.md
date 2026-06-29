# Handoff: NAC Code — Agentic Coding Harness

## Overview
NAC Code ("Not-A-CLI Code") is a desktop, IDE-style GUI wrapper around agentic coding models. It replaces terminal-bound CLI harnesses with a familiar three-pane IDE layout: a left rail of chats grouped by workspace, a central conversation surface where the agent works, and a right inspector showing live session state. It is built around three ideas: **static context as a managed, reusable library**; **all configuration is per-chat** (model, provider, agent, context all belong to the individual chat); and **first-class visibility into the agent's work and cost** (file changes per git repo, cost in each provider's real billing unit).

The full product spec is in **`NAC Code PRD.dc.html`** (open in a browser). This README is the implementation-facing companion — it should be sufficient on its own.

## About the Design Files
The files in this bundle are **design references created in HTML** — interactive prototypes showing the intended look and behavior. **They are not production code to copy directly.** They are written in a small in-house component format (`.dc.html` + `support.js` runtime); do **not** port that runtime.

The task is to **recreate these designs in the target codebase's environment** using its established patterns and libraries. If no codebase exists yet, this is a desktop app — the recommended stack is **Electron or Tauri + React + TypeScript**, since it needs local filesystem/git/process access (launching IDEs, reading repos, running the agent) that a pure web app can't provide.

## Fidelity
**High-fidelity.** Final colors, typography, spacing, and interactions are all specified below and in the prototypes. Recreate the UI faithfully using the target codebase's component library, matching the exact tokens in the Design Tokens section.

## How to view the prototypes
Open `Harness.dc.html` in a modern browser (it loads `support.js` and the three child files automatically). The other `.dc.html` files are components/routes mounted by the shell. `NAC Code PRD.dc.html` is the written spec.

---

## Screens / Views

The app is one desktop window: persistent **top bar** + **status bar**, with a body that shows one of three primary views. In the default Chat view the body is framed by the **left rail** and **right inspector**.

### 1. Application shell
- **Purpose**: Persistent frame around all content.
- **Layout**: Vertical flex — top bar (46px) / body (flex:1) / status bar (28px). Body is a horizontal flex of: [activity rail, Cockpit only] · left rail (300px) · center (flex) · inspector (344px). Whole shell has `min-width: 1180px` and scrolls horizontally below that (panes never collapse/overlap).
- **Top bar**: traffic-light dots (left), centered product identity `NAC Code / <workspace>`, right side has the layout switcher (segmented Studio/Cockpit/Focus) and account handle `@nfife_fontfife`.
- **Status bar**: left = green dot + git glyph + account; MCP status ("MCP not checked"); right = live context summary (`5 ctx · ~12k / 128K tokens`) + `Version 0.10.0`.

### 2. Layout modes (top-bar switcher)
- **Studio** (default): balanced three-pane (rail + chat + docked inspector).
- **Cockpit**: adds a 54px **activity rail** (icon shortcuts: context library, stats, command palette) on the far left, plus **chat tabs** above the thread.
- **Focus**: hides the inspector (toggled open as a right-side drawer via an "Inspector" button in the chat header) and widens the conversation.

### 3. Left rail — workspaces & chats
- **Purpose**: Navigate chats grouped by workspace.
- **Layout**: 300px column. Header row: "CHAT HISTORY" label + "New Chat" button. Scrollable list of collapsible **workspace groups**. Account footer at bottom.
- **Workspace group**: clickable header with disclosure chevron, mono workspace name, and a count pill. Expanded → nested chat rows.
- **Chat row**: title (1 line, ellipsis), relative time, model pill. Active chat: indigo-tinted background `rgba(124,124,240,.1)`, inset ring, and a 2.5px indigo left bar. Branched chats (from compaction) show a small branch icon + "Compacted · …" title and sit at the top of their group.

### 4. Chat view — header, thread, composer
- **Chat header bar** (46px, above thread): chat title + model pill (left); right side hosts per-chat actions — **Files** button (with live changed-count badge), **Compact**, **New from compacted**, context **configuration picker** ("Context: Standard ▾"), and in Focus mode the **Inspector** toggle.
- **Thread**: centered column, max-width 840px, 40px side padding. Message rows = 30px avatar + body. User avatar is a gray rounded square with initials; assistant avatar is an indigo gradient square "NC". Each turn: name + "·" + timestamp, then content.
  - **Tool-call cards**: dark card (`#121216`, 1px border), status icon (green check / red x / amber spinner), mono tool name, mono command (ellipsis), status pill (Completed/Error/Running). Error cards expand to show stderr.
  - **Inline diff**: card with file header (`+N −M`) and colored diff rows (add = green tint, del = red tint).
  - **Streaming**: assistant text with a blinking 7px indigo cursor block.
- **Composer**: rounded container (`#121216`, 14px radius). Top strip = context quick action: "Context" button with count badge + preview chips + "Manage" link. Textarea. Bottom toolbar: Attach · model selector button (provider dot + model name) · "Thinking: Medium" · **YOLO** toggle (amber when on) · **Send** (indigo).

### 5. Context Library (full-screen route — `ContextManager.dc.html`)
- **Purpose**: Browse, search, and attach static context at scale (100s of items).
- **Layout**: header (back button + title + **context budget meter**) / body = 240px category nav · center list · 340px detail panel.
- **Category nav**: "Attached to chat" (★) then Skills / Agents / Instructions / Files, each with a count pill. "New / Import" button at bottom.
- **Budget meter** (header, 230px): "Context budget · N items" + `~6.3k / 128k tok`, with a fill bar that shifts color green→amber→red as it fills (thresholds: >76k amber, >108k red).
- **List**: search input + "Attached only" filter. Each row: type-letter tile (S/A/I/F in its color), mono name + uppercase type label, description, token/size meta, and an **Attach/Attached** toggle button.
- **Detail panel**: selected item's icon, name, type, description, an attach/detach button, a Details block (type/size/source), and a workspace-vs-global **scope** segmented control (display-only in v1).

### 6. Changes (full-screen route — `FileExplorer.dc.html`)
- **Purpose**: Review every file the agent changed, grouped by git repo (including repos outside the workspace), viewable in-app or launchable in an IDE.
- **Layout**: header (back + "Changes" + `N repos · M files +X −Y`) / body = 340px repo+file tree · center viewer.
- **Repo card** (per impacted repo): repo-name + branch chip + `+adds −dels`, repo path, "OUTSIDE WS" amber badge if outside workspace, and two launch buttons: **IntelliJ** (gradient chip icon) and **VS Code** (blue glyph). Below: file rows grouped Added/Modified/Deleted (status letter A/M/D in green/amber/red, name, dir, per-file `+/−`).
- **Viewer**: toolbar shows file path + `repo · branch`, status, a **Diff / Source** toggle, and **Finder** reveal button. Content area: Diff mode = colored unified diff with `+/−` gutter; Source mode = full source with line numbers.
- **Toast**: bottom-center confirmation for Finder/editor/IDE-launch actions (auto-dismiss ~2.4s).

### 7. Right inspector (`HarnessInspector.dc.html`)
- **Purpose**: Live, present-tense session state. 344px (docked) / 360px (Focus drawer).
- **Header**: "INSPECTOR" + a **Stats** button (opens the stats modal).
- **Collapsible panels** (each a section with disclosure chevron):
  - **CLI Connections**: rows with status dot + mono name + detail + status badge (Authenticated/Expired/Not authenticated/Not installed). Failed rows show an inline **Re-auth** button that flips to "Authenticated".
  - **MCP Servers**: empty-state placeholder in v1.
  - **Token & Cost** (live): "Tokens this session" + provider-aware cost (see Cost model).
  - **Session**: model, AI credits, thinking level, duration, working dir, and a context-window meter (`53K/128K (41%)` + bar).
  - **Attached Context**: one row per type with a count, each clickable into the Context Library.
  - **Local Models**, **Activity**: status/in-flight info.

### 8. Overlays
- **Model & provider modal**: choose provider (Anthropic / OpenAI / GitHub Copilot / LM Studio) then a model within it; supports connecting a new provider (API-key field). Selection applies to the active chat only.
- **Agent menu**: pick the active agent (name + role) for the chat; links to "Browse all agents" in the library.
- **Session Stats modal**: stat cards (Duration / Messages / Tool calls / Errors), a per-turn token-usage chart with input/output/peak totals, a provider-aware **cost breakdown**, and the **Tool Timeline** (chronological tool calls with durations + status) — relocated here to keep the inspector focused on live state.
- **Command palette (⌘K / Ctrl-K)**: fuzzy search across Chats / Actions / Layouts, grouped; Enter runs the top result; Esc dismisses.

---

## Interactions & Behavior
- **Layout switch**: instant; preserves active chat and view; inspector docking adapts (docked in Studio/Cockpit, drawer in Focus).
- **Chat switch (critical)**: selecting a chat restores its full per-chat config (model, provider, agent, attached context, active configuration, context-window/compaction state). Returning restores the prior chat. **No configuration is global.**
- **Attach/detach context**: toggling updates the budget meter, the inspector's Attached Context summary, the composer count, and sets the config picker's "modified" marker if it diverges from the applied configuration — all immediately.
- **Apply configuration**: replaces the active chat's attached set with the configuration's items; clears the "modified" marker.
- **Compact**: shows in-progress (spinner) → "Compacted"; reduces the chat's context-window usage (~×0.4 in the mock).
- **New from compacted**: spawns a new chat inheriting the compacted context + config + model + agent, placed at the top of the source chat's workspace and marked as branched; the **original chat is untouched**; the two are independent thereafter.
- **Provider switch**: changes the cost unit/breakdown everywhere cost is shown.
- **IDE launch / Finder / editor**: confirm with a toast (these are stubs in the mock; wire to real OS calls).
- **⌘K**: toggles the palette; arrow/Enter to run.
- **Animations**: spinners (`spin` 0.9–1s linear), streaming cursor (`blink` 1.1s step), color/width transitions ~0.12–0.25s.

## State Management
Per the prototype, the central state is a **map of chats**, each chat owning: `provider, model, agent, activeConfig, attached{} , dirty, contextK, compacting, compacted`. Plus app-level: `activeChat`, `view` ('chat'|'context'|'files'), `layout`, `expanded{}` (workspace open state), `configs[]`, `spawned[]` (branched chats), `reauthed{}`, and transient UI flags (menus, modals, palette, query strings). The **per-chat state object is the backbone** — most features read/write it. See PRD §7.4 (FR-4.1) and §8 (relationships) and §10 (data model).

## Design Tokens

### Colors
- App background: `#0c0c0f`; panels/bars: `#101013`, `#0e0e11`; cards/inputs: `#121216`, `#16161a`, `#1a1a1f`; activity rail: `#0a0a0d`; code/viewer bg: `#0a0a0d`.
- Borders/hairlines: `rgba(255,255,255,.06)`–`.10`.
- Text: primary `#e9e9ee`; secondary `#c8c8d0` / `#b8b8c2`; muted `#9a9aa4` / `#8a8a92`; faint `#777781` (min — do not go fainter); on dim `#70707a`.
- **Accent (indigo)**: primary `#7c7cf0`, hover `#8b8bf2`, light `#a6a6f5` / `#cfcff7`; tints `rgba(124,124,240,.1/.12/.22)`.
- Status: success `#46cf8b`; error `#f0726a`; warning/running/amber `#e3b25f`; info/blue `#5fb3e3`.
- Context-type colors: Skill `#8b8bf2` (indigo), Agent `#5fb3e3` (blue), Instruction `#e3b25f` (amber), File `#46cf8b` (green).
- Assistant avatar gradient: `linear-gradient(135deg,#7c7cf0,#5b5bd6)`.

### Typography
- **Body/UI**: `IBM Plex Sans` (400/500/600/700). Base 14px UI; thread body 14.5px / line-height ~1.65.
- **Mono** (IDs, paths, code, metrics): `IBM Plex Mono` (400/500/600).
- **PRD display headings**: `Newsreader` serif (the product UI itself does not use Newsreader — only the PRD document does).
- Section/eyebrow labels: 10–11px, letter-spacing 1.1–1.6px, uppercase, weight 600.

### Spacing / radius / shadow
- Radius: inputs/cards 8–14px; pills/badges 5–6px; avatars/tiles 8–9px; modals 14–16px.
- Panel widths: activity rail 54px, left rail 300px, inspector 344px (docked) / 360px (drawer), library nav 240px / detail 340px, changes tree 340px.
- Shadows: popovers/modals `0 16px 48px rgba(0,0,0,.55)` / `0 30px 90px rgba(0,0,0,.6)`; drawer `-16px 0 48px rgba(0,0,0,.5)`.
- Min app width: **1180px** (horizontal scroll below).

## Screenshots
High-resolution reference captures are in `screenshots/` (the chat view is shown in all three layout modes; routes and overlays are each captured in a representative state):
- `01-chat-studio.png` — Chat view, Studio layout (default three-pane).
- `02-chat-cockpit.png` — Chat view, Cockpit layout (activity rail + chat tabs).
- `03-chat-focus.png` — Chat view, Focus layout (inspector hidden).
- `04-config-picker.png` — Chat header context-configuration picker, open.
- `05-context-library.png` — Context Library route (Attached category).
- `06-changes-diff.png` — Changes route, Diff mode, repos grouped (incl. OUTSIDE WS).
- `07-changes-source.png` — Changes route, Source mode with line numbers.
- `08-command-palette.png` — ⌘K command palette.
- `09-stats.png` — Session Stats modal (cards, token chart, cost breakdown, tool timeline).
- `10-model-provider.png` — Model & provider modal.

> The captures are from the prototype rendered at ~924px wide (narrower than the 1180px min); a couple of right-anchored popovers clip at the edge. At full desktop width nothing clips — see FR-1.5.

## Assets
No raster assets — all icons are inline SVG, all type is from Google Fonts (IBM Plex Sans, IBM Plex Mono; Newsreader for the PRD only). The IntelliJ launch button uses a simple CSS gradient chip as a stand-in; replace with the official JetBrains/VS Code marks in production, respecting their brand guidelines.

## Files
- `Harness.dc.html` — main shell: layouts, top/status bar, left rail, chat header, thread, composer, model/agent/config pickers, compaction + branching, command palette, stats modal. Contains the demo data (`buildFiles`, `buildLibrary`, workspace/chat seed, providers, agents, configs).
- `HarnessInspector.dc.html` — right inspector panel (child component).
- `ContextManager.dc.html` — full-screen Context Library route.
- `FileExplorer.dc.html` — full-screen Changes / git review route.
- `NAC Code PRD.dc.html` — full product requirements document (45 v1 requirements + 7 committed roadmap requirements, relationships, data model, glossary).
- `support.js` — the prototype runtime. **Reference only — do not port.**

> Note on the `.dc.html` format: these files use an in-house component runtime. Read them as design references — markup shows structure/styles, the embedded `class Component` shows state and behavior. Reimplement both in your framework of choice; do not reuse `support.js`.
