import { spawn } from 'child_process'

// Model discovery. Only OpenCode exposes a usable model list (`opencode models`) — it reflects the
// account's real, currently-configured models (OpenCode-hosted + LM Studio local/remote), which change
// as the user loads models. The cloud CLIs (claude/codex/copilot) have no list command, so they keep
// their known/default sets.

/** Pure + exported for testing: parse `opencode models` stdout into model ids (`provider/model`). */
export function parseOpenCodeModels(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[\w.@:-]+\/[\w./@:-]+$/.test(l)) // `provider/model[/variant]`, no spaces
}

export function discoverModels(provider: string): Promise<string[]> {
  if (provider !== 'opencode') return Promise.resolve([])
  return new Promise((resolve) => {
    let out = ''
    let child
    try {
      child = spawn('opencode', ['models'], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve([])
      return
    }
    child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.on('error', () => resolve([]))
    child.on('close', () => resolve(parseOpenCodeModels(out)))
  })
}
