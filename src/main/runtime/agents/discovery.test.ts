import { describe, it, expect } from 'vitest'
import { discoverClaudeAgents, type FsDeps } from './claude'
import { discoverCopilotAgents } from './copilot'
import { discoverOpenCodeAgents, parseAgentList, INTERNAL_PRIMARIES, type ExecDeps } from './opencode'
import { codexAgents } from './codex'

const fakeFs = (files: Record<string, string>): FsDeps => ({
  readdir: async (dir) => {
    const names = Object.keys(files).filter((p) => p.startsWith(dir + '/')).map((p) => p.slice(dir.length + 1))
    const direct = [...new Set(names.map((n) => n.split('/')[0]))]
    if (!direct.length) throw new Error('ENOENT')
    return direct
  },
  readFile: async (p) => {
    if (!(p in files)) throw new Error('ENOENT')
    return files[p]
  },
  exists: async (p) => p in files || Object.keys(files).some((f) => f.startsWith(p + '/'))
})

const agentMd = (name: string, marker = false): string =>
  `---\nname: ${name}\ndescription: d-${name}\n${marker ? 'managed-by: nac-code\nnac-rev: 1\n' : ''}---\nprompt`

describe('discoverClaudeAgents', () => {
  it('merges user + project agents, marks nac-managed files, and is selectable', async () => {
    const fs = fakeFs({
      '/home/.claude/agents/rev.md': agentMd('rev'),
      '/home/.claude/agents/mine.md': agentMd('mine', true),
      '/ws/.claude/agents/proj.md': agentMd('proj')
    })
    const r = await discoverClaudeAgents('/ws', { fs, home: '/home' })
    expect(r.support).toBe('full')
    const by = Object.fromEntries(r.agents.map((a) => [a.id, a]))
    expect(by.rev.source).toBe('user')
    expect(by.mine.source).toBe('nac')
    expect(by.proj.source).toBe('project')
    expect(r.agents.every((a) => a.selectable)).toBe(true)
  })
  it('missing dirs → empty list, support intact, never throws', async () => {
    const r = await discoverClaudeAgents('/nowhere', { fs: fakeFs({}), home: '/home' })
    expect(r.support).toBe('full')
    expect(r.agents).toEqual([])
  })
  it('falls back to the filename slug when frontmatter has no name', async () => {
    const fs = fakeFs({ '/home/.claude/agents/anon.md': '---\ndescription: x\n---\nbody' })
    const r = await discoverClaudeAgents(undefined, { fs, home: '/home' })
    expect(r.agents[0].id).toBe('anon')
  })
})

describe('discoverCopilotAgents', () => {
  it('scans both dirs, everything selectable:false, support sync-only with the honest note', async () => {
    const fs = fakeFs({
      '/home/.copilot/agents/a.agent.md': agentMd('a'),
      '/ws/.github/agents/b.agent.md': agentMd('b', true)
    })
    const r = await discoverCopilotAgents('/ws', { fs, home: '/home' })
    expect(r.support).toBe('sync-only')
    expect(r.note).toContain("doesn't expose agent selection")
    expect(r.agents.map((a) => a.selectable)).toEqual([false, false])
    expect(r.agents.find((a) => a.id === 'b')!.source).toBe('nac')
  })
})

describe('opencode', () => {
  it('parseAgentList keeps primaries, drops internals and subagents', () => {
    const out = 'build (primary)\n{"permission":{}}\ncompaction (primary)\nexplore (subagent)\nplan (primary)\nmy-agent (primary)\n'
    expect(parseAgentList(out).map((a) => a.id)).toEqual(['build', 'plan', 'my-agent'])
  })
  it('INTERNAL_PRIMARIES is the spec set', () => {
    expect(INTERNAL_PRIMARIES).toEqual(new Set(['compaction', 'summary', 'title']))
  })
  it('exec failure falls back to fs scan, then to the static builtins floor', async () => {
    const failExec: ExecDeps = { exec: async () => ({ code: 1, stdout: '' }) }
    const withFile = await discoverOpenCodeAgents('/ws', { exec: failExec, fs: fakeFs({ '/home/.config/opencode/agent/c.md': agentMd('c', true) }), home: '/home' })
    expect(withFile.agents.some((a) => a.id === 'c' && a.source === 'nac')).toBe(true)
    const bare = await discoverOpenCodeAgents('/ws', { exec: failExec, fs: fakeFs({}), home: '/home' })
    expect(bare.agents.map((a) => a.id)).toEqual(['build', 'plan'])
    expect(bare.agents[0].source).toBe('builtin')
  })
  it('marks nac-managed customs from the fs even when exec succeeds', async () => {
    const exec: ExecDeps = { exec: async () => ({ code: 0, stdout: 'build (primary)\nplan (primary)\nmine (primary)\n' }) }
    const r = await discoverOpenCodeAgents('/ws', { exec, fs: fakeFs({ '/home/.config/opencode/agent/mine.md': agentMd('mine', true) }), home: '/home' })
    expect(r.agents.find((a) => a.id === 'mine')!.source).toBe('nac')
    expect(r.agents.find((a) => a.id === 'build')!.source).toBe('builtin')
  })
})

describe('codexAgents', () => {
  it('is the honest static none', () => {
    const r = codexAgents()
    expect(r.support).toBe('none')
    expect(r.agents).toEqual([])
    expect(r.note).toBe('Codex has no agent concept (profiles are config presets)')
  })
})
