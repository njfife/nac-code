import { homedir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import type { DiscoveredAgent, ProviderAgents } from '../../../shared/agents'
import { scanAgentDir, realFs, type FsDeps } from './claude'

// opencode HAS enumeration: `opencode agent list` prints `name (primary|subagent)` lines (each
// followed by a permission-ruleset JSON line we ignore). Primaries minus the internal set are the
// user-facing agents; ACP exposes exactly those as the `mode` configOption (pillar-4 mechanism).

export const INTERNAL_PRIMARIES = new Set(['compaction', 'summary', 'title'])
const LIST_TIMEOUT_MS = 3000

export interface ExecDeps {
  exec(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string }>
}
export const realExec: ExecDeps = {
  exec: (cmd, args, timeoutMs) =>
    new Promise((resolve) => {
      let out = ''
      let done = false
      const finish = (code: number): void => {
        if (!done) {
          done = true
          resolve({ code, stdout: out })
        }
      }
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {
        finish(1)
        return
      }
      const timer = setTimeout(() => {
        child.kill()
        finish(1)
      }, timeoutMs)
      child.stdout?.on('data', (c) => (out += c.toString()))
      child.on('error', () => {
        clearTimeout(timer)
        finish(1)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        finish(code ?? 1)
      })
    })
}

export function parseAgentList(stdout: string): DiscoveredAgent[] {
  const out: DiscoveredAgent[] = []
  for (const line of stdout.split('\n')) {
    const m = /^(\S+)\s+\((primary|subagent)\)\s*$/.exec(line.trim())
    if (!m) continue
    const [, id, mode] = m
    if (mode !== 'primary' || INTERNAL_PRIMARIES.has(id)) continue
    out.push({ id, name: id, source: 'builtin', selectable: true })
  }
  return out
}

const BUILTIN_FLOOR: DiscoveredAgent[] = [
  { id: 'build', name: 'build', description: 'The default agent. Executes tools based on configured permissions.', source: 'builtin', selectable: true },
  { id: 'plan', name: 'plan', description: 'Plan mode. Disallows all edit tools.', source: 'builtin', selectable: true }
]

export async function discoverOpenCodeAgents(
  cwd: string | undefined,
  deps?: { exec?: ExecDeps; fs?: FsDeps; home?: string }
): Promise<ProviderAgents> {
  const exec = deps?.exec ?? realExec
  const fs = deps?.fs ?? realFs
  const home = deps?.home ?? homedir()
  // fs scan runs regardless — it carries source fidelity (nac marker / user / project) the list output lacks.
  const fsAgents = [
    ...(await scanAgentDir(fs, join(home, '.config', 'opencode', 'agent'), 'user')),
    ...(cwd ? await scanAgentDir(fs, join(cwd, '.opencode', 'agent'), 'project') : [])
  ]
  const bySlug = new Map(fsAgents.map((a) => [a.id, a]))
  const { code, stdout } = await exec.exec('opencode', ['agent', 'list'], LIST_TIMEOUT_MS)
  let agents: DiscoveredAgent[]
  if (code === 0 && stdout.trim()) {
    agents = parseAgentList(stdout).map((a) => bySlug.get(a.id) ?? a) // fs entry wins: carries real source
  } else if (fsAgents.length) {
    agents = [...BUILTIN_FLOOR, ...fsAgents]
  } else {
    agents = BUILTIN_FLOOR
  }
  return { provider: 'opencode', support: 'full', agents, fetchedAt: Date.now() }
}
