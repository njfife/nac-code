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

export function discoverOpenCode(): Promise<ProviderCapabilities | null> {
  return new Promise((resolve) => {
    let out = ''
    let child
    try {
      child = spawn('opencode', ['models'], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve(null)
      return
    }
    child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.on('error', () => resolve(null))
    child.on('close', () => {
      const ids = parseOpenCodeModels(out)
      if (ids.length === 0) {
        resolve(null)
        return
      }
      resolve({
        ...STATIC_CAPABILITIES.opencode,
        source: 'protocol',
        models: ids.map((id) => ({ id, label: id })),
        fetchedAt: Date.now()
      })
    })
  })
}
