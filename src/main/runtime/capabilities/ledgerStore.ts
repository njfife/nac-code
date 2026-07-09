import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs'
import { join } from 'path'
import type { Ledger } from './ledger'

// Persisted at userData/nac-capability-ledger.json; same atomic temp+rename pattern as nac-state.

function ledgerPath(): string {
  return join(app.getPath('userData'), 'nac-capability-ledger.json')
}

export function readLedger(): Ledger {
  try {
    if (!existsSync(ledgerPath())) return {}
    const parsed = JSON.parse(readFileSync(ledgerPath(), 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Ledger) : {}
  } catch {
    return {}
  }
}

export function recordOutcome(provider: string, modelId: string, verdict: 'gated' | 'works', message?: string): void {
  try {
    const ledger = readLedger()
    ledger[provider] = ledger[provider] ?? {}
    ledger[provider][modelId] = { verdict, at: Date.now(), ...(message ? { message } : {}) }
    const tmp = ledgerPath() + '.tmp'
    writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf8')
    renameSync(tmp, ledgerPath())
  } catch {
    // learning is best-effort; never break a run over it
  }
}
