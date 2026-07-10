// Shared context renderer: produces the block format injected into every replay (M0-8).
// Client-side (renderContextText) + server-side (agent harness) use the same canonical format.

export interface ContextPayload {
  items: { name: string; content: string; path?: string }[]
  removed: string[]
  notes?: string[]
}

export function renderContextText(payload: ContextPayload): string {
  // Empty payload → empty string
  if (!payload.items.length && !payload.removed.length && !payload.notes?.length) {
    return ''
  }

  const parts: string[] = []

  // Render items if present
  if (payload.items.length) {
    parts.push('Attached context for this conversation:')
    const itemLines: string[] = []
    for (const it of payload.items) {
      if (it.path) {
        itemLines.push(`## ${it.name} (${it.path})\n\`\`\`\n${it.content}\n\`\`\``)
      } else {
        itemLines.push(`## ${it.name}\n${it.content}`)
      }
    }
    parts.push(itemLines.join('\n\n'))
  }

  // Render removal notes before the trailing separator
  if (payload.removed.length) {
    parts.push(`The following attached context was removed — disregard it going forward: ${payload.removed.join(', ')}`)
  }

  // Render refused-file notes before the trailing separator
  if (payload.notes?.length) {
    parts.push(payload.notes.join('\n'))
  }

  // Join all parts and add the trailing separator
  return `${parts.join('\n\n')}\n\n---\n\n`
}
