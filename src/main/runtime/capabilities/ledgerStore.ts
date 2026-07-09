import { app } from 'electron'
import { readFile, writeFile, rename } from 'fs/promises'
import { join } from 'path'
import type { Ledger } from './ledger'

// Persisted at userData/nac-capability-ledger.json; async atomic temp+rename like nac-state
// (src/main/persistence/store.ts). Writes are read-modify-write, so they're serialized on a
// promise chain — two runs completing concurrently must not lose each other's verdicts.

function ledgerPath(): string {
  return join(app.getPath('userData'), 'nac-capability-ledger.json')
}

export async function readLedger(): Promise<Ledger> {
  try {
    const parsed = JSON.parse(await readFile(ledgerPath(), 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Ledger) : {}
  } catch {
    return {} // no file yet, or unreadable — start empty
  }
}

let writeChain: Promise<void> = Promise.resolve()

export function recordOutcome(provider: string, modelId: string, verdict: 'gated' | 'works', message?: string): void {
  writeChain = writeChain.then(async () => {
    try {
      const ledger = await readLedger()
      ledger[provider] = ledger[provider] ?? {}
      ledger[provider][modelId] = { verdict, at: Date.now(), ...(message ? { message } : {}) }
      const tmp = ledgerPath() + '.tmp'
      await writeFile(tmp, JSON.stringify(ledger, null, 2), 'utf8')
      await rename(tmp, ledgerPath())
    } catch {
      // learning is best-effort; never break a run over it
    }
  })
}
