import type { ProviderCapabilities } from './runtime'

// Static capability floor (the degradation ladder's bottom). Live discovery replaces these when it
// succeeds; claude's entry is also the protocol-less base merged with the gating ledger.
export const STATIC_CAPABILITIES: Record<string, ProviderCapabilities> = {
  claude: {
    provider: 'claude',
    source: 'static',
    models: [
      { id: 'opus', label: 'Opus 4.8' },
      { id: 'sonnet', label: 'Sonnet 4.6', variants: [{ id: 'sonnet[1m]', label: 'Sonnet 4.6 · 1M' }] },
      { id: 'haiku', label: 'Haiku 4.5' }
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
    effortNote: 'max & ultracode are session-only; per-model support varies',
    fetchedAt: 0
  },
  codex: {
    provider: 'codex',
    source: 'static',
    models: [], // no reliable static ids (plan-gated); Account default is always offered by the UI
    efforts: ['low', 'medium', 'high', 'xhigh'],
    fetchedAt: 0
  },
  copilot: {
    provider: 'copilot',
    source: 'static',
    models: [],
    efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    fetchedAt: 0
  },
  opencode: {
    provider: 'opencode',
    source: 'static',
    models: [
      { id: 'opencode/deepseek-v4-flash-free', label: 'DeepSeek V4 Flash (free)' },
      { id: 'lmstudio/qwen/qwen3-coder-30b', label: 'Qwen3 Coder 30B (local)' },
      { id: 'lmstudio-remote/qwen/qwen3.6-27b', label: 'qwen3.6-27b (remote)' }
    ],
    efforts: ['low', 'medium', 'high'],
    effortNote: 'maps to --variant; model-dependent',
    fetchedAt: 0
  }
}

/** Resolve a display label to the harness model id: live caps first, then the static floor. */
export function modelIdFor(provider: string, label: string, caps?: ProviderCapabilities): string | undefined {
  for (const source of [caps, STATIC_CAPABILITIES[provider]]) {
    for (const m of source?.models ?? []) {
      if (m.label === label) return m.id
      const v = m.variants?.find((x) => x.label === label)
      if (v) return v.id
    }
  }
  // Discovered opencode models historically use the raw `provider/model` id as their label.
  if (provider === 'opencode' && label.includes('/')) return label
  return undefined
}

/** The effort scale that applies to the chat's current model: per-model when it carries one. */
export function effortScaleFor(caps: ProviderCapabilities | undefined, modelLabel: string): string[] {
  const m = caps?.models.find((x) => x.label === modelLabel || x.variants?.some((v) => v.label === modelLabel))
  if (m?.efforts?.length) return m.efforts
  if (caps?.efforts.length) return caps.efforts
  return ['low', 'medium', 'high']
}

