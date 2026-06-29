# Spike: cross-provider context portability

A throwaway tracer-bullet for the **super-hard requirement** — switch providers
mid-conversation (incl. a local model) with full context preserved. It validates
the core of plan milestone **M0-8** before we spec it:

> the canonical **provider-neutral transcript** is the source of truth, and a
> universal `buildContext()` replay carries context across a provider switch —
> *not* any provider's native session.

## What it does

1. **Capture (agentic provider).** Drives the **Claude CLI** for two turns
   (Claude keeps its own context across them via `--resume`), and records the
   turns into a minimal provider-neutral transcript.
2. **Replay (stateless local provider).** Renders that transcript into
   **LM Studio**'s OpenAI-compatible `messages[]` via `buildContext()`, then asks
   it to recall a unique codeword planted in the **first** message.
3. **Negative control (the t3code bug).** Asks LM Studio the same recall question
   with **no transcript replayed**. This must *fail* — proving the pass comes
   from our replay, not the model guessing.

**PASS = recalls with replay AND does not recall without it.** One run
demonstrates both the failure mode you hit in t3code and our fix, across a real
Claude → LM Studio provider switch.

## Prerequisites

- **Node 18+** (uses global `fetch`; no `npm install`).
- **Claude CLI** installed and authenticated (`claude`). Skip with `--synthetic`.
- **LM Studio** running with a model loaded and the local server started
  (default `http://localhost:1234`). Any chat model works; a small instruct
  model is fine.

## Run

```bash
node spikes/cross-provider-portability/spike.mjs
# or, to test only the LM Studio replay half (no Claude needed):
node spikes/cross-provider-portability/spike.mjs --synthetic
```

Env overrides: `LMSTUDIO_URL`, `LMSTUDIO_MODEL`, `CLAUDE_BIN`.

## Expected output (PASS)

```
[control: no replay]  LM Studio: "I don't have a record of a codeword…"
                      recalls codeword? false   (expected: false — the bug)
[test: Claude→LM Studio replay]  LM Studio: "BANANAPHONE-7731"
                      recalls codeword? true    (expected: true — context crossed providers)
=== PASS ✅ ===
```

## Deliberately NOT covered yet (these feed M0-8 next)

- **Tool-call/result flattening** across providers (transcript here is text-only).
- **Reverse direction** (LM Studio → Claude: replay a transcript *into* an
  agentic harness by priming a fresh session).
- **Window deltas / compaction on switch** (re-tokenizing against the target
  model's smaller window).
- Native-session fast-path (same-provider `--resume`) as an optimization.

If the text-turn case passes, the next spike iteration adds tool-call flattening
and the reverse direction — the two genuinely hard parts.
