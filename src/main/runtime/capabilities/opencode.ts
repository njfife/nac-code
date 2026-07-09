import { spawn } from 'child_process'
import { STATIC_CAPABILITIES } from '../../../shared/capabilities'
import type { ProviderCapabilities } from '../../../shared/runtime'

/** Pure + exported for testing (relocated from discovery.ts): `opencode models` stdout → ids. */
export function parseOpenCodeModels(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[\w.@:-]+\/[\w./@:-]+$/.test(l))
}

// 5s timeout mirroring JsonRpcClient's per-request default (jsonRpc.ts): a hung `opencode models`
// must fall to the static floor via the degradation ladder, not pend forever in the coalescing
// cache (getCapabilities awaits this promise and callers would hang indefinitely).
const DISCOVERY_TIMEOUT_MS = 5000

export function discoverOpenCode(): Promise<ProviderCapabilities | null> {
  return new Promise((resolve) => {
    let out = ''
    let child
    let settled = false
    const finish = (result: ProviderCapabilities | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    try {
      child = spawn('opencode', ['models'], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      child?.kill()
      finish(null)
    }, DISCOVERY_TIMEOUT_MS)
    child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.on('error', () => finish(null))
    child.on('close', () => {
      const ids = parseOpenCodeModels(out)
      if (ids.length === 0) {
        finish(null)
        return
      }
      finish({
        ...STATIC_CAPABILITIES.opencode,
        source: 'protocol',
        models: ids.map((id) => ({ id, label: id })),
        fetchedAt: Date.now()
      })
    })
  })
}
