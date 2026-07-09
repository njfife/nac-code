import { describe, it, expect } from 'vitest'
import { TURN_WATCHDOG_MS, CodexSession, shouldFinishOnTurnCompleted } from './codexSession'
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
  // Rider 2 (inactivity watchdog): touchWatchdog() re-arms on every activity notification instead
  // of only at turn/start, but the CEILING itself is unchanged — same PROMPT_TIMEOUT_MS as pillar 1.
  it('rider 2 (inactivity watchdog) does not change the ceiling', () => {
    expect(TURN_WATCHDOG_MS).toBe(PROMPT_TIMEOUT_MS)
  })
})

describe('shouldFinishOnTurnCompleted', () => {
  it('finishes when the notified turn id matches the current one', () => {
    expect(shouldFinishOnTurnCompleted('turn_1', 'turn_1')).toBe(true)
  })
  it('ignores a stale turn/completed for a different, prior turn', () => {
    expect(shouldFinishOnTurnCompleted('turn_2', 'turn_1')).toBe(false)
  })
  it('proceeds when currentTurnId is still null (turn/start ack not landed yet)', () => {
    expect(shouldFinishOnTurnCompleted(null, 'turn_1')).toBe(true)
  })
  it('proceeds when the notification carries no turn id', () => {
    expect(shouldFinishOnTurnCompleted('turn_1', undefined)).toBe(true)
    expect(shouldFinishOnTurnCompleted('turn_1', null)).toBe(true)
  })
})
