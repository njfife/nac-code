# Research: carrier harnesses for local models (OpenCode, pi)

Date: 2026-06-28. Sources: official docs + the cloned t3code repo (which wraps OpenCode) + pi's repo/docs. Every nontrivial claim was adversarially verified (confirmed/high unless noted).

**Context:** NAC Code is a wrapper, never a harness. Local models (LM Studio / Ollama / OpenAI-compatible) are used *only through a carrier harness* that NAC Code **auto-configures** (writes the carrier's config to point at the local endpoint), then wraps like any other harness. No agent loop, no raw model connections. See the eng plan's Global Constraints + `CliRegistry.configureLocalBackend` + M0-8.

## Decision

- **v1 carrier = OpenCode.** Cleanest wrap: it speaks **ACP** (aligns with our ACP-first `AgentRuntime`) *and* offers an HTTP server + official SDK; local backends are first-class; config is JSON with a published schema — auto-config is **clean**.
- **pi = deferred (strong future option).** It is a capable agentic harness with excellent local-model support, but it does **not** speak ACP — it uses a custom JSONL RPC protocol, so it needs a **bespoke adapter** (the Codex-style path). Deferring keeps v1 to one adapter family. *(Correction to an earlier assumption: pi DOES support agents — tools, skills, multi-provider. The blocker is ACP, not agent capability.)*

---

## OpenCode (v1 carrier)

- **What:** open-source agentic coding harness by SST (`github.com/anomalyco/opencode`, formerly `sst/opencode`), MIT, built on the Vercel AI SDK. Ships TUI + headless HTTP server + ACP mode. npm `opencode-ai`, Homebrew `anomalyco/tap/opencode`. OpenAPI 3.1 at `/doc`; official SDK `@opencode-ai/sdk`; config schema at https://opencode.ai/config.json.

- **Local-backend support: YES.** Define a custom provider using `@ai-sdk/openai-compatible`; set `options.baseURL` to the local endpoint and declare models explicitly (no auto-discovery for openai-compatible). Models referenced as `<providerID>/<modelID>`. Covers LM Studio (`:1234/v1`), Ollama (`:11434/v1`), any OpenAI-compatible server.

- **Config (what we auto-write):**
  - Paths: global `~/.config/opencode/opencode.json`; project `./opencode.json`; **external file via `OPENCODE_CONFIG` env var** (recommended for us); inline via `OPENCODE_CONFIG_CONTENT` (JSON string).
  - Format: JSON/JSONC, `$schema`-backed. Configs **merge** (later overrides conflicting keys).
  - **Minimal working snippet (LM Studio):**
    ```json
    {
      "$schema": "https://opencode.ai/config.json",
      "provider": {
        "lmstudio": {
          "npm": "@ai-sdk/openai-compatible",
          "name": "LM Studio (local)",
          "options": { "baseURL": "http://127.0.0.1:1234/v1", "apiKey": "lm-studio" },
          "models": { "qwen2.5-coder-7b": { "name": "Qwen2.5 Coder 7B (local)" } }
        }
      },
      "model": "lmstudio/qwen2.5-coder-7b"
    }
    ```
  - **Auto-config approach:** write a NAC-owned config file and point `OPENCODE_CONFIG` at it (idempotent, doesn't clobber the user's `opencode.json`). Avoid `OPENCODE_CONFIG_CONTENT` for secrets — it does **not** do `{env:}`/`{file:}` substitution (issue #13219); api keys would have to be literal.

- **Wrapping / how we drive it (two options):**
  1. **`opencode acp`** — ACP-compatible subprocess over JSON-RPC/stdio. **Best fit for our ACP-first `AgentRuntime`** (uniform with Cursor/Gemini ACP adapters), no HTTP port.
  2. **`opencode serve --hostname=127.0.0.1 --port=<p>`** + `@opencode-ai/sdk` (`createOpencodeClient`, `session.prompt/promptAsync` with `{providerID, modelID}`, stream events). **This is the battle-tested path — t3code uses exactly this** (`opencodeRuntime.ts`, `OpenCodeAdapter.ts`), notably **not** ACP.
  - *Open sub-decision for the OpenCode adapter:* ACP (uniform) vs HTTP/SDK (proven, richer). Lean ACP for architectural uniformity; validate it in the redirected spike.

- **Feasibility: CLEAN.** Caveats to handle: write a dummy `apiKey` (some AI-SDK paths reject empty); model IDs containing `/` produce slugs like `lmstudio/google/gemma-3n-e4b` (split on first `/`); pin/validate against the published schema (OpenCode moves fast); confirm `@ai-sdk/openai-compatible` is fetched (offline-install risk); read-modify-write or use a dedicated `OPENCODE_CONFIG` file to avoid clobbering an existing provider map.

- **Sources:** opencode.ai/docs/{config,providers,server,acp}, opencode.ai/config.json, github issues #13219/#9086, t3code `apps/server/src/provider/{opencodeRuntime.ts, Layers/OpenCodeAdapter.ts, Drivers/OpenCodeDriver.ts}`.

---

## pi (deferred — agentic but non-ACP)

- **What:** `pi` coding-agent CLI, `github.com/earendil-works/pi` (monorepo, agent in `packages/coding-agent`), MIT, very popular (repo metadata ~66k stars, actively pushed). Full agentic harness: read/write/edit/bash/grep tools, skills, tree-structured sessions, 15+ providers + custom providers. *(Confirms pi is agentic — corrects the earlier "no agent support" assumption.)*

- **Local-backend support: YES.** Custom provider in `~/.pi/agent/models.json` with `baseUrl`, `api: "openai-completions"`, placeholder `apiKey`, `models: [{id}]`. Explicitly documents LM Studio, Ollama, vLLM, SGLang. Select via `--provider <name> --model <id>`. **Quirk:** keyless local servers still need a dummy `apiKey` (or `/login`/`--api-key`) or the model loads but stays unavailable in `--list-models`.

- **Config:** `~/.pi/agent/models.json` (JSON), root `providers` map. Auth can live in `~/.pi/agent/auth.json` or via `/login`/`--api-key`. `apiKey`/`headers` support `$ENV`/`${ENV}` interpolation and `!command` resolution. Feasibility: **workable** (read-modify-write the providers map; `registerProvider` replaces a provider's models — defensive merge needed).

- **Wrapping: NO ACP.** Custom protocol. Headless modes: `pi -p "..."` (print), `pi --mode json` (JSONL event stream: agent_start/turn_start/message_*/tool_execution_*/agent_end), `pi --mode rpc` (bidirectional JSONL request/response over stdio). **Warning:** Node `readline` is NOT RPC-protocol-compliant (it splits on U+2028/U+2029, valid in JSON strings) — a wrapper must split strictly on `\n`. Wrapping pi = a **bespoke adapter** (Codex-style), not ACP.

- **Why deferred (accurate reason):** not ACP → needs its own RPC adapter; v1 stays to one adapter family (ACP/OpenCode). pi is otherwise a strong future carrier (MIT, many providers, clean local support, embeddable SDK).

- **Open questions:** full RPC command catalog (interrupt/cancel/tool-approval) not captured; `compat` field values per backend; schema stability (fast-moving); governance/backing of pi.dev beyond the GitHub org.

- **Sources:** pi.dev/docs/latest/{usage,providers,models,custom-provider,rpc,json,sdk}, raw models.md, `api.github.com/repos/earendil-works/pi`, local `superpowers/.../references/pi-tools.md`.
