import { JsonRpcClient } from './jsonRpc'
import type { DiscoveredModel, ProviderCapabilities } from '../../../shared/runtime'

// Codex app-server v2 `model/list` (EXPERIMENTAL surface; verified live 2026-07-08).
// Handshake: initialize(clientInfo) → model/list → data[] (+ nextCursor pagination).

interface CodexEffort {
  reasoningEffort?: string
}
interface CodexModel {
  id?: string
  displayName?: string
  hidden?: boolean
  isDefault?: boolean
  supportedReasoningEfforts?: CodexEffort[]
  defaultReasoningEffort?: string
}

/** Pure + exported for testing: model/list `data` entries → DiscoveredModel[] (hidden dropped). */
export function mapCodexModels(data: unknown[]): DiscoveredModel[] {
  const out: DiscoveredModel[] = []
  for (const raw of data) {
    const m = raw as CodexModel | null
    if (!m || typeof m !== 'object' || !m.id || m.hidden) continue
    out.push({
      id: m.id,
      label: m.displayName ?? m.id,
      isDefault: m.isDefault === true,
      efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort).filter((x): x is string => Boolean(x)),
      defaultEffort: m.defaultReasoningEffort
    })
  }
  return out
}

export async function discoverCodex(): Promise<ProviderCapabilities | null> {
  const client = new JsonRpcClient('codex', ['app-server'])
  try {
    await client.request('initialize', { clientInfo: { name: 'nac-code', title: 'NAC Code', version: '0.1.0' } })
    const models: DiscoveredModel[] = []
    let cursor: string | null = null
    // Bounded pagination: the app-server is experimental — cap pages and bail if the cursor stops advancing.
    for (let page = 0; page < 10; page++) {
      const res = (await client.request('model/list', cursor ? { cursor } : {})) as { data?: unknown[]; nextCursor?: string | null }
      models.push(...mapCodexModels(res?.data ?? []))
      const next = res?.nextCursor ?? null
      if (!next || next === cursor) break
      cursor = next
    }
    if (models.length === 0) return null
    return { provider: 'codex', source: 'protocol', models, efforts: ['low', 'medium', 'high', 'xhigh'], fetchedAt: Date.now() }
  } catch {
    return null // caller falls back down the ladder
  } finally {
    client.close()
  }
}
