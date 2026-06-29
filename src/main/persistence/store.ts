import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, rename, mkdir } from 'fs/promises'

// Durable persistence (M2 / FR-4.3). v1 uses a single JSON file under userData — pragmatic and
// native-module-free; SQLite (better-sqlite3) remains the target once data volume warrants it.
// The store treats the payload as opaque JSON; the renderer owns its shape.

function stateFile(): string {
  return join(app.getPath('userData'), 'nac-state.json')
}

export async function loadPersistedState(): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(stateFile(), 'utf8'))
  } catch {
    return null // no file yet, or unreadable — caller falls back to defaults
  }
}

export async function savePersistedState(data: unknown): Promise<void> {
  const dir = app.getPath('userData')
  await mkdir(dir, { recursive: true })
  // Atomic replace: write a temp file then rename over the target.
  const tmp = join(dir, `nac-state.json.${process.pid}.tmp`)
  await writeFile(tmp, JSON.stringify(data), 'utf8')
  await rename(tmp, stateFile())
}
