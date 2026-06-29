# Research — LM Studio model management (JIT load, single-model, context length)

**Question (Nathan):** Can NAC select an LM Studio model that isn't loaded and have it auto-load on query? Can we enforce "only one model loaded at a time"? Can we configure the context length? (Slow first token is acceptable; the convenience is the point.)

**Short answer:** Yes / Yes / Yes — but #1 and #2 are LM Studio *server settings* (already on by default and work today via OpenCode), while #3 (context length) is a **load-time** parameter that NAC must set via the `lms` CLI or the LM Studio SDK, not via the OpenAI `/v1` request.

## What was verified on Nathan's machine (2026-06-29)

- `lms` CLI installed (`~/.cache/lm-studio/bin/lms`); LM Studio server **running on `localhost:1234`**.
- `/v1/models` lists *downloaded-but-unloaded* models → JIT is active. `lms ps` showed **no models loaded**; `lms ls` shows 5 local models.
- OpenCode connects via plain OpenAI-compatible transport (`@ai-sdk/openai-compatible`). Two instances configured: **local** `localhost:1234` and **remote** `lmstudio-remote → http://100.117.200.8:1234/v1`.

## 1. Auto-load on query — JIT loading

- **JIT loading is enabled by default.** "A model loads automatically when it receives its first request via API; you don't need to manually load the model first." So selecting an LM Studio model in NAC → OpenCode sends a chat request → LM Studio loads it on demand (slow first token, then normal). **Works today with zero NAC code.**

## 2. Only one model at a time — Auto-Evict

- **Auto-Evict** (default ON): "unloads previously JIT-loaded models before loading new ones… at most 1 model is kept loaded in memory at a time (when loaded via JIT)." Non-JIT (manually loaded) models are unaffected.
- Toggle: **Developer tab → Server Settings**. So switching models from NAC already auto-evicts the previous one.

## 3. Context length (and other load params)

- Context length is a **load-time** parameter. It is **not** an OpenAI `/v1` field, so it can't be set per chat request. To control it NAC must load the model itself with config:
  - **CLI:** `lms load <model> -c <tokens> [--gpu max|0..1] [--ttl <s>] [--parallel <n>] [--identifier <id>] -y` (also `--estimate-only` to size it first).
  - **SDK** (`@lmstudio/sdk`, a Node lib usable in Electron main): `await client.llm.load(model, { config: { contextLength, gpu }, onProgress: p => …, verbose: false })` — gives a **load-progress callback**.
- **TTL** *can* be set per request (`"ttl"` field, seconds; default 60 min) or via `lms load --ttl`.

## Implementation options for NAC

**Level 0 — rely on LM Studio settings (works now, no code):** JIT + Auto-Evict are default-on. Pick an LM Studio model in NAC → it auto-loads, one-at-a-time, at the model's *saved default* context. Downsides: silent slow first token (no UI feedback) and no per-chat context control.

**Level 1 — NAC orchestrates loading (the requested convenience):** a main-process **`LocalModelManager`** using `@lmstudio/sdk` (preferred) or the `lms` CLI:
- **Discover** downloaded + loaded models with state/size (`listDownloaded`/`listLoaded`, or `lms ls`/`lms ps`) — richer than `opencode models`.
- **Pre-warm on select** with `contextLength` + `gpu` and an `onProgress` callback → show "Loading model… 42%" instead of a silent stall; sets the context length.
- Expose NAC knobs: **context length**, **keep-only-one-loaded** (maps to Auto-Evict, or `unload` before `load`), **idle TTL**. Natural home: per-workspace defaults or a model-settings popover.
- Inference still runs through **OpenCode** (the carrier). The SDK is only the *management plane* — NAC stays a wrapper, never a harness (LM Studio is a model server, not an agentic harness, so we don't drive inference directly).

**Caveat — two instances:** `lms`/SDK manage the **local** instance by default. The **remote** box (`100.117.200.8`) needs **LM Link** (`lms link`) or pointing the SDK at that host. v1 can orchestrate the local instance and let the remote rely on its own JIT/Auto-Evict.

## Recommendation

Build the **`LocalModelManager` (Level 1)** for the local instance: SDK-based discover + load-with-progress + context/TTL/single-model knobs, surfaced when an OpenCode/LM Studio model is selected. Keep OpenCode as the inference carrier. Remote-instance management (LM Link) is a fast follow.

## Sources

- [Idle TTL and Auto-Evict | LM Studio](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict)
- [Manage Models in Memory (TypeScript SDK) | LM Studio](https://lmstudio.ai/docs/typescript/manage-models/loading)
- [LLMLoadModelConfig | LM Studio](https://lmstudio.ai/docs/typescript/api-reference/llm-load-model-config)
- [Run LM Studio as a service (headless) | LM Studio](https://lmstudio.ai/docs/developer/core/headless)
- `lms load --help`, `lms ls`, `lms ps` (LM Studio CLI, verified locally)
