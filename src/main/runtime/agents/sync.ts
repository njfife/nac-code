// NAC→harness one-way sync. THE contract (spec §3): only files carrying `managed-by: nac-code`
// are ever created, updated, deleted, or pruned. A colliding foreign file → conflict, untouched.
import { homedir } from 'os'
import { readFile, writeFile, mkdir, readdir, unlink } from 'fs/promises'
import { join } from 'path'
import { slugify, type NacAgent, type SyncReportEntry } from '../../../shared/agents'
import { parseFrontmatter, renderFrontmatter, hasNacMarker } from './frontmatter'
import { invalidateAgents } from './index'

export interface SyncFsDeps {
  readFile(p: string): Promise<string>
  writeFile(p: string, s: string): Promise<void>
  mkdir(dir: string): Promise<void>
  readdir(dir: string): Promise<string[]>
  unlink(p: string): Promise<void>
}
const realFs: SyncFsDeps = {
  readFile: (p) => readFile(p, 'utf8'),
  writeFile: (p, s) => writeFile(p, s, 'utf8'),
  mkdir: async (d) => void (await mkdir(d, { recursive: true })),
  readdir: (d) => readdir(d),
  unlink: (p) => unlink(p)
}

const baseAttrs = (a: NacAgent): Record<string, string> => ({
  name: slugify(a.name),
  description: a.description,
  'managed-by': 'nac-code',
  'nac-rev': String(a.rev)
})

export const renderClaudeAgent = (a: NacAgent): string => renderFrontmatter(baseAttrs(a), a.prompt)
export const renderCopilotAgent = (a: NacAgent): string => renderFrontmatter(baseAttrs(a), a.prompt)
export const renderOpenCodeAgent = (a: NacAgent): string => renderFrontmatter({ ...baseAttrs(a), mode: 'primary' }, a.prompt)

interface Target {
  provider: 'claude' | 'copilot' | 'opencode'
  dir: (home: string) => string
  file: (slug: string) => string
  render: (a: NacAgent) => string
}
const TARGETS: Target[] = [
  { provider: 'claude', dir: (h) => join(h, '.claude', 'agents'), file: (s) => `${s}.md`, render: renderClaudeAgent },
  { provider: 'copilot', dir: (h) => join(h, '.copilot', 'agents'), file: (s) => `${s}.agent.md`, render: renderCopilotAgent },
  { provider: 'opencode', dir: (h) => join(h, '.config', 'opencode', 'agent'), file: (s) => `${s}.md`, render: renderOpenCodeAgent }
]

export async function syncAgents(nacAgents: NacAgent[], deps?: { fs?: SyncFsDeps; home?: string }): Promise<SyncReportEntry[]> {
  const fs = deps?.fs ?? realFs
  const home = deps?.home ?? homedir()
  const report: SyncReportEntry[] = []
  for (const t of TARGETS) {
    const dir = t.dir(home)
    const wanted = new Set(nacAgents.map((a) => t.file(slugify(a.name))))
    for (const a of nacAgents) {
      const path = join(dir, t.file(slugify(a.name)))
      try {
        let existing: { attrs: Record<string, string> } | null = null
        try {
          existing = parseFrontmatter(await fs.readFile(path))
        } catch {
          existing = null // no file — free to create
        }
        if (existing && !hasNacMarker(existing.attrs)) {
          report.push({ provider: t.provider, agentId: a.id, action: 'conflict', detail: `${path} exists and is not NAC-managed` })
          continue
        }
        if (existing && existing.attrs['nac-rev'] === String(a.rev)) {
          report.push({ provider: t.provider, agentId: a.id, action: 'skipped' })
          continue
        }
        await fs.mkdir(dir)
        await fs.writeFile(path, t.render(a))
        report.push({ provider: t.provider, agentId: a.id, action: 'written' })
      } catch (e) {
        report.push({ provider: t.provider, agentId: a.id, action: 'error', detail: (e as Error).message })
      }
    }
    // Prune: marker-bearing files in our dir that no current NacAgent claims (deleted/renamed in NAC).
    try {
      for (const name of await fs.readdir(dir)) {
        if (wanted.has(name)) continue
        const path = join(dir, name)
        try {
          const parsed = parseFrontmatter(await fs.readFile(path))
          if (parsed && hasNacMarker(parsed.attrs)) {
            await fs.unlink(path)
            report.push({ provider: t.provider, agentId: name, action: 'pruned' })
          }
        } catch {
          // unreadable/foreign — leave it
        }
      }
    } catch {
      // dir missing — nothing to prune
    }
  }
  invalidateAgents() // discovery must re-see the world after any sync
  return report
}
