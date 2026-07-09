import { describe, it, expect } from 'vitest'
import { ClaudeSession, RESUME_VERIFY_MS, needsRespawn } from './claudeSession'
import { StreamJsonClient } from './streamJson'
import { PROMPT_TIMEOUT_MS } from './acpSession'
import type { AgentEvent } from '../../../shared/runtime'

describe('ClaudeSession constants + respawn predicate', () => {
  it('verifies resume inside a window well under the prompt ceiling', () => {
    expect(RESUME_VERIFY_MS).toBe(2000)
    expect(RESUME_VERIFY_MS).toBeLessThan(PROMPT_TIMEOUT_MS)
  })
  it('needsRespawn: only when a known session exists and model/effort actually changed', () => {
    expect(needsRespawn({ model: 'a', effort: 'high' }, { model: 'a', effort: 'high' }, 'sid')).toBe(false)
    expect(needsRespawn({ model: 'a' }, { model: 'b' }, 'sid')).toBe(true)
    expect(needsRespawn({ model: 'a' }, { model: 'b' }, null)).toBe(false) // no session to resume — never respawn mid-air
    expect(needsRespawn({}, {}, 'sid')).toBe(false)
    expect(needsRespawn({ effort: 'high' }, {}, 'sid')).toBe(false) // requested field undefined = no preference
  })
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- reaching into private fields is the
// cheapest seam that exercises the real `attach()` handler-registration code without spawning a real
// `claude` binary (model/effort/cwd are baked into argv, so `newClient()` can't be pointed at a fake).
type Peek = any

function fakeChild(script: string): StreamJsonClient {
  return new StreamJsonClient(process.execPath, ['-e', script])
}

describe('ClaudeSession respawn vs stale-client races (attach)', () => {
  it('does not error the new run when the OLD client (killed on respawn) closes on a later tick', async () => {
    const events: AgentEvent[] = []
    const session = new ClaudeSession((e) => events.push(e), false, {}) as Peek

    // Old child stays alive until explicitly killed — mirrors `this.client.close()` in prompt()'s
    // respawn branch, where the kill signal is sent but Node's 'close' fires on a later tick.
    const oldClient = fakeChild('setInterval(() => {}, 1000)')
    session.client = oldClient
    session.attach(oldClient)
    session.currentRunId = 'run-old'

    // Respawn: kill the old child, then swap in the new one — same order as prompt().
    oldClient.close()
    const newClient = fakeChild('setInterval(() => {}, 1000)')
    session.client = newClient
    session.attach(newClient)
    session.currentRunId = 'run-new'

    // Wait for the OLD child's process to actually exit and fire its close handler.
    await new Promise<void>((resolve) => oldClient.onClose(() => resolve()))
    await new Promise((r) => setTimeout(r, 20)) // let the (buggy) handler's synchronous body run

    expect(events.find((e) => e.type === 'run.errored')).toBeUndefined()
    expect(session.currentRunId).toBe('run-new')

    newClient.close()
  })
})

describe('ClaudeSession respawn re-syncs permission mode to the new child', () => {
  it('resets appliedYolo on respawn so set_permission_mode is re-sent to the new child', () => {
    const events: AgentEvent[] = []
    const session = new ClaudeSession((e) => events.push(e), true, { model: 'a' }) as Peek // yolo already on

    const sent: Array<Record<string, unknown>> = []
    const makeFakeClient = (): StreamJsonClient => {
      const c = fakeChild('setInterval(() => {}, 1000)')
      ;(c as Peek).send = (frame: Record<string, unknown>) => sent.push(frame)
      return c
    }

    session.client = makeFakeClient()
    session.attach(session.client)
    session.knownSessionId = 'sid' // a resumable session must exist for needsRespawn to fire
    session.appliedYolo = true // yolo was already synced to the OLD child

    // Stand-in for the real `newClient()`, which hardcodes spawning the `claude` binary — swap only
    // the child-spawning mechanism, leave the rest of prompt()'s respawn branch (incl. the fix) real.
    // Matches newClient's real contract: build + attach a client and return it; the caller assigns
    // `this.client`.
    session.newClient = () => {
      const c = makeFakeClient()
      session.attach(c)
      return c
    }

    session.prompt('run1', 'hello', { model: 'b' }) // model changed -> triggers respawn

    const modeFrames = sent.filter((f) => (f.request as Record<string, unknown> | undefined)?.subtype === 'set_permission_mode')
    expect(modeFrames).toHaveLength(1)
    expect(session.appliedYolo).toBe(true)
  })
})
