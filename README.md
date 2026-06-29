# NAC Code

A desktop (Electron) GUI that **wraps** agentic coding-harness CLIs (Claude Code, Codex, Cursor, OpenCode) — workspace-organized chats, reusable static context, multi-harness model selection, and first-class visibility into cost and the files the agent changes. **NAC Code is a wrapper, never a harness** (no agent loop, no raw model endpoints).

> **Status:** pre-implementation. The engineering plan and core specs are complete, and cross-provider context portability is validated by a spike. **Next: scaffold the Electron app (M0-7), then the shell (M1).**

## Orientation

Start with **[docs/DECISIONS.md](docs/DECISIONS.md)** — the current state, next step, and locked decisions (the source of truth across devices). Then read the plan and specs.

## Layout

| Path | What |
|---|---|
| `docs/DECISIONS.md` | Living decision log / current state — **read first** |
| `docs/plans/` | Master engineering plan (scope, architecture, milestones) |
| `docs/specs/` | Closed specs (agent runtime + adapter interface; cross-provider context) |
| `docs/research/` | Investigations (t3code wrapping patterns; OpenCode/pi carrier evaluation) |
| `docs/reviews/` | PRD / handoff reviews |
| `docs/design/` | Design reference: PRD, interactive prototypes (`*.dc.html`), screenshots |
| `spikes/` | Throwaway validations (e.g. cross-provider context portability) |
| `AGENTS.md` / `CLAUDE.md` | How an agent should work in this repo + keep docs updated |

Full docs index: [docs/README.md](docs/README.md).
