import { describe, it, expect } from 'vitest'
import { TURN_WATCHDOG_MS, CodexSession } from './codexSession'
import { PROMPT_TIMEOUT_MS } from './acpSession'

describe('CodexSession constants', () => {
  it('watchdog matches the pillar-1 turn ceiling', () => {
    expect(TURN_WATCHDOG_MS).toBe(PROMPT_TIMEOUT_MS)
  })
  it('exports a TransportSession-shaped class', () => {
    expect(typeof CodexSession.prototype.prompt).toBe('function')
    expect(typeof CodexSession.prototype.respondPermission).toBe('function')
    expect(typeof CodexSession.prototype.cancel).toBe('function')
    expect(typeof CodexSession.prototype.dispose).toBe('function')
  })
})
