import { spawn } from 'child_process'
import type { ProviderProbe } from '../../shared/runtime'

// CliRegistry v0 (starts M4): probe each adapter-backed CLI with `--version`. Probed on each
// modal open — cheap and always honest. Cursor is absent until it has an adapter.

export const ADAPTER_PROVIDERS = ['claude', 'codex', 'copilot', 'opencode'] as const

/** Pure + exported for testing: extract a version token from `<cli> --version` stdout. */
export function parseVersionLine(stdout: string): string | undefined {
  const first = stdout.trim().split('\n')[0]?.trim()
  if (!first) return undefined
  return first.match(/\d+\.\d+[\w.-]*/)?.[0] ?? first
}

function probeOne(id: string, timeoutMs = 3000): Promise<ProviderProbe> {
  return new Promise((resolve) => {
    let settled = false
    const done = (p: ProviderProbe): void => {
      if (!settled) {
        settled = true
        resolve(p)
      }
    }
    let out = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(id, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      done({ id, installed: false })
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      done({ id, installed: false })
    }, timeoutMs)
    child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.on('error', () => {
      clearTimeout(timer)
      done({ id, installed: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done(code === 0 ? { id, installed: true, version: parseVersionLine(out) } : { id, installed: false })
    })
  })
}

export function probeProviders(): Promise<ProviderProbe[]> {
  return Promise.all(ADAPTER_PROVIDERS.map((id) => probeOne(id)))
}
