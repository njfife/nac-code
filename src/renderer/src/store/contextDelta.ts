// Pure delta computation: compares attached context ids against what was seeded into the live session.
// Seed-key diff detects both brand-new attachments and edits to attached user items (rev bump).

import { ITEMS_BY_ID, seedKey, type ContextItem } from '../data/context'

export interface ContextDelta {
  addedOrChanged: ContextItem[]
  removedNames: string[]
}

export function computeContextDelta(chat: { attachedIds: string[]; seededAttachments: string[] | null }, userItems: ContextItem[]): ContextDelta {
  const addedOrChanged: ContextItem[] = []
  const removedNames: string[] = []

  // Build a map of userItems by id for quick lookup
  const userItemsById: Record<string, ContextItem> = {}
  for (const item of userItems) {
    userItemsById[item.id] = item
  }

  // Get the seeded keys as a Set for O(1) lookup
  const seededKeysSet = new Set(chat.seededAttachments || [])

  // Find added/changed: attachedIds whose seedKey is not in seededAttachments
  for (const attachedId of chat.attachedIds) {
    const item = userItemsById[attachedId] ?? ITEMS_BY_ID[attachedId]
    if (!item) continue // Item not found, skip

    const key = seedKey(item)
    if (!seededKeysSet.has(key)) {
      addedOrChanged.push(item)
    }
  }

  // Find removed: items in seededAttachments whose id is no longer in attachedIds
  if (chat.seededAttachments) {
    for (const seededKey_str of chat.seededAttachments) {
      // Extract the id part from the seed key (e.g., "u_1_1@0" → "u_1_1", "sk-tdd" → "sk-tdd")
      const id = seededKey_str.includes('@') ? seededKey_str.split('@')[0] : seededKey_str
      if (!chat.attachedIds.includes(id)) {
        // Item was removed; try to find its name
        const item = userItemsById[id] ?? ITEMS_BY_ID[id]
        const name = item?.name ?? id
        removedNames.push(name)
      }
    }
  }

  return { addedOrChanged, removedNames }
}
