import { homedir } from 'os'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import type { DiscoveredAgent, ProviderAgents } from '../../../shared/agents'
import { parseFrontmatter, hasNacMarker } from './frontmatter'

// claude has NO enumeration command (probe 2026-07-10: `claude agents` lists running sessions, not
// types) — discovery is a filesystem scan of the three locations custom agents live in.

export interface FsDeps {
  readdir(dir: string): Promise<string[]>
  readFile(p: string): Promise<string>
  exists(p: string): Promise<boolean>
}
export const realFs: FsDeps = {
  readdir: (d) => readdir(d),
  readFile: (p) => readFile(p, 'utf8'),
  exists: async (p) => {
    try {
      await readdir(p)
      return true
    } catch {
      return false
    }
  }
}

export async function scanAgentDir(
  fs: FsDeps,
  dir: string,
  source: DiscoveredAgent['source'],
  suffix = '.md',
  selectable = true
): Promise<DiscoveredAgent[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return [] // missing dir — the common case, never an error
  }
  const out: DiscoveredAgent[] = []
  for (const n of names.filter((n) => n.endsWith(suffix))) {
    try {
      const parsed = parseFrontmatter(await fs.readFile(join(dir, n)))
      const fallback = n.slice(0, -suffix.length)
      out.push({
        id: parsed?.attrs.name || fallback,
        name: parsed?.attrs.name || fallback,
        description: parsed?.attrs.description || undefined,
        source: parsed && hasNacMarker(parsed.attrs) ? 'nac' : source,
        selectable
      })
    } catch {
      // unreadable file — skip it, never fail the scan
    }
  }
  return out
}

/** Bounded walk for plugin agents: any dir literally named `agents` under ~/.claude/plugins, ≤6 deep. */
async function scanPluginAgents(fs: FsDeps, root: string): Promise<DiscoveredAgent[]> {
  const found: DiscoveredAgent[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6) return
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e)
      if (e === 'agents') found.push(...(await scanAgentDir(fs, p, 'plugin')))
      else if (!e.includes('.')) await walk(p, depth + 1) // extension-less entry = likely dir; cheap heuristic, wrong guesses just ENOENT-skip
    }
  }
  await walk(root, 0)
  return found
}

export async function discoverClaudeAgents(cwd: string | undefined, deps?: { fs?: FsDeps; home?: string }): Promise<ProviderAgents> {
  const fs = deps?.fs ?? realFs
  const home = deps?.home ?? homedir()
  const agents = [
    ...(await scanAgentDir(fs, join(home, '.claude', 'agents'), 'user')),
    ...(cwd ? await scanAgentDir(fs, join(cwd, '.claude', 'agents'), 'project') : []),
    ...(await scanPluginAgents(fs, join(home, '.claude', 'plugins')))
  ]
  // Dedup by id — precedence: project > user/nac > plugin, matching claude's own resolution order.
  const rank = { project: 0, nac: 1, user: 1, plugin: 2, builtin: 3 } as const
  const byId = new Map<string, DiscoveredAgent>()
  for (const a of [...agents].sort((x, y) => rank[x.source] - rank[y.source])) if (!byId.has(a.id)) byId.set(a.id, a)
  return { provider: 'claude', support: 'full', agents: [...byId.values()], fetchedAt: Date.now() }
}
