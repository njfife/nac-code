import { homedir } from 'os'
import { join } from 'path'

// Resolve a stored workspace path into an absolute cwd for spawning a harness (expands a leading ~).
// Empty/blank → undefined, so the run falls back to the process cwd (pre-workspace-binding behavior).
export function resolveCwd(p?: string): string | undefined {
  if (!p || !p.trim()) return undefined
  const t = p.trim()
  if (t === '~') return homedir()
  if (t.startsWith('~/')) return join(homedir(), t.slice(2))
  return t
}
