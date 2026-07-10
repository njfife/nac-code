// Pure file-read orchestrator: checks path existence, content size, and binary encoding.
// Injected reader function allows testing and different backends (IPC, Node, etc).

export interface FileReadOk {
  ok: true
  content: string
  tokens: number
}

export interface FileReadError {
  ok: false
  state: 'missing' | 'binary' | 'toolarge'
}

export type FileReadResult = FileReadOk | FileReadError

export async function readFileItem(
  item: { path?: string },
  read: (path: string) => Promise<string | null | undefined>
): Promise<FileReadResult> {
  // Missing path
  if (!item.path) {
    return { ok: false, state: 'missing' }
  }

  let content: string | null | undefined
  try {
    content = await read(item.path)
  } catch {
    // Any read error (permissions, not found, etc) → missing
    return { ok: false, state: 'missing' }
  }

  // Null/undefined return → missing
  if (content == null) {
    return { ok: false, state: 'missing' }
  }

  // Check content size (> 262144 chars → toolarge)
  if (content.length > 262144) {
    return { ok: false, state: 'toolarge' }
  }

  // Check for binary content (NUL byte in first 8192 chars)
  const checkLength = Math.min(8192, content.length)
  for (let i = 0; i < checkLength; i++) {
    if (content.charCodeAt(i) === 0) {
      return { ok: false, state: 'binary' }
    }
  }

  // All checks pass: compute tokens and return ok
  const tokens = Math.ceil(content.length / 4)
  return { ok: true, content, tokens }
}
