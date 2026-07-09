import { homedir } from 'os'
import { JsonRpcClient } from './jsonRpc'
import type { DiscoveredModel, ProviderCapabilities } from '../../../shared/runtime'

// Copilot ACP (`copilot --acp`; verified live 2026-07-08): initialize(protocolVersion 1) →
// session/new → result.models.availableModels + currentModelId. The docs-reported `models.list`
// method does not exist on this surface (-32601).

interface AcpModel {
  modelId?: string
  name?: string
  _meta?: { copilotUsage?: string; copilotEnablement?: string }
}

/** Pure + exported for testing: availableModels → DiscoveredModel[] with default + usage note. */
export function mapCopilotModels(available: unknown[], currentModelId?: string): DiscoveredModel[] {
  const out: DiscoveredModel[] = []
  for (const raw of available) {
    const m = raw as AcpModel | null
    if (!m || typeof m !== 'object' || !m.modelId) continue
    const model: DiscoveredModel = { id: m.modelId, label: m.name ?? m.modelId, isDefault: m.modelId === currentModelId }
    if (m._meta?.copilotUsage) model.note = `${m._meta.copilotUsage} usage`
    out.push(model)
  }
  return out
}

export async function discoverCopilot(): Promise<ProviderCapabilities | null> {
  const client = new JsonRpcClient('copilot', ['--acp'])
  try {
    await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
    })
    const res = (await client.request('session/new', { cwd: homedir(), mcpServers: [] })) as {
      models?: { availableModels?: unknown[]; currentModelId?: string }
    }
    const models = mapCopilotModels(res?.models?.availableModels ?? [], res?.models?.currentModelId)
    if (models.length === 0) return null
    return {
      provider: 'copilot',
      source: 'protocol',
      models,
      efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      fetchedAt: Date.now()
    }
  } catch {
    return null
  } finally {
    client.close()
  }
}
