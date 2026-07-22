import { homedir } from 'os'
import { join } from 'path'
import type { ProviderAgents } from '../../../shared/agents'
import { scanAgentDir, realFs, type FsDeps } from './claude'

export const COPILOT_NOTE = "Copilot CLI doesn't expose agent selection to integrations — synced agents work in copilot's own CLI"

export async function discoverCopilotAgents(cwd: string | undefined, deps?: { fs?: FsDeps; home?: string }): Promise<ProviderAgents> {
  const fs = deps?.fs ?? realFs
  const home = deps?.home ?? homedir()
  const agents = [
    ...(await scanAgentDir(fs, join(home, '.copilot', 'agents'), 'user', '.agent.md', false)),
    ...(cwd ? await scanAgentDir(fs, join(cwd, '.github', 'agents'), 'project', '.agent.md', false) : [])
  ]
  return { provider: 'copilot', support: 'sync-only', agents, note: COPILOT_NOTE, fetchedAt: Date.now() }
}
