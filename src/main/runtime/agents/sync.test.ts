import { describe, it, expect } from 'vitest'
import { renderClaudeAgent, renderCopilotAgent, renderOpenCodeAgent, syncAgents, type SyncFsDeps } from './sync'
import { parseFrontmatter } from './frontmatter'
import type { NacAgent } from '../../../shared/agents'

const nac = (over: Partial<NacAgent> = {}): NacAgent => ({ id: 'u_ag_1_1', name: 'My Reviewer', description: 'Reviews', prompt: 'You review.', rev: 2, ...over })

describe('render functions', () => {
  it('claude file carries name/description/marker/rev + prompt body', () => {
    const p = parseFrontmatter(renderClaudeAgent(nac()))!
    expect(p.attrs).toEqual({ name: 'my-reviewer', description: 'Reviews', 'managed-by': 'nac-code', 'nac-rev': '2' })
    expect(p.body).toBe('You review.')
  })
  it('opencode file adds mode: primary; copilot matches claude shape', () => {
    expect(parseFrontmatter(renderOpenCodeAgent(nac()))!.attrs.mode).toBe('primary')
    expect(parseFrontmatter(renderCopilotAgent(nac()))!.attrs['managed-by']).toBe('nac-code')
  })
})

const memFs = (initial: Record<string, string> = {}): SyncFsDeps & { files: Record<string, string> } => {
  const files = { ...initial }
  return {
    files,
    readFile: async (p) => {
      if (!(p in files)) throw new Error('ENOENT')
      return files[p]
    },
    writeFile: async (p, s) => void (files[p] = s),
    mkdir: async () => {},
    readdir: async (dir) => Object.keys(files).filter((p) => p.startsWith(dir + '/')).map((p) => p.slice(dir.length + 1)).filter((n) => !n.includes('/')),
    unlink: async (p) => void delete files[p]
  }
}

describe('syncAgents', () => {
  const home = '/h'
  const target = (rest: string): string => `${home}/${rest}`

  it('writes all three targets with markers, reports written', async () => {
    const fs = memFs()
    const report = await syncAgents([nac()], { fs, home })
    expect(report.filter((r) => r.action === 'written')).toHaveLength(3)
    expect(fs.files[target('.claude/agents/my-reviewer.md')]).toContain('managed-by: nac-code')
    expect(fs.files[target('.copilot/agents/my-reviewer.agent.md')]).toBeDefined()
    expect(fs.files[target('.config/opencode/agent/my-reviewer.md')]).toContain('mode: primary')
  })

  it('unchanged rev → skipped (idempotent)', async () => {
    const fs = memFs()
    await syncAgents([nac()], { fs, home })
    const report = await syncAgents([nac()], { fs, home })
    expect(report.every((r) => r.action === 'skipped')).toBe(true)
  })

  it('NEVER touches a foreign file at a colliding path — reports conflict', async () => {
    const fs = memFs({ [target('.claude/agents/my-reviewer.md')]: '---\nname: my-reviewer\n---\nhand-authored' })
    const report = await syncAgents([nac()], { fs, home })
    expect(fs.files[target('.claude/agents/my-reviewer.md')]).toContain('hand-authored')
    expect(report.find((r) => r.provider === 'claude')!.action).toBe('conflict')
    expect(report.filter((r) => r.action === 'written')).toHaveLength(2) // other targets proceed
  })

  it('prunes marker files whose agent no longer exists; leaves foreign files alone', async () => {
    const fs = memFs()
    await syncAgents([nac()], { fs, home })
    fs.files[target('.claude/agents/handmade.md')] = '---\nname: handmade\n---\nkeep me'
    const report = await syncAgents([], { fs, home })
    expect(fs.files[target('.claude/agents/my-reviewer.md')]).toBeUndefined()
    expect(fs.files[target('.claude/agents/handmade.md')]).toContain('keep me')
    expect(report.some((r) => r.action === 'pruned' && r.provider === 'claude')).toBe(true)
  })
})
