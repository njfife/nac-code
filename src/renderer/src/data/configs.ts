import { ITEMS_BY_ID, type ContextItem } from './context'

// Saved context configurations (FR-6.1): named, reusable bundles of context items.
export interface Configuration {
  id: string
  name: string
  itemIds: string[]
}

export const CONFIGURATIONS: Configuration[] = [
  { id: 'standard', name: 'Standard', itemIds: ['sk-tdd', 'in-style'] },
  { id: 'security', name: 'Security', itemIds: ['in-security', 'in-style'] },
  { id: 'minimal', name: 'Minimal', itemIds: ['in-style'] }
]

export const CONFIGS_BY_ID: Record<string, Configuration> = Object.fromEntries(CONFIGURATIONS.map((c) => [c.id, c]))

// userItems is optional so existing callers (static-only configs) don't need updating; user-saved
// configs (u_-prefixed ids) can reference user items (notes/files), which live outside ITEMS_BY_ID.
export function configTokens(c: Configuration, userItems: ContextItem[] = []): number {
  const userById = new Map(userItems.map((i) => [i.id, i]))
  return c.itemIds.reduce((sum, id) => sum + (ITEMS_BY_ID[id]?.tokens ?? userById.get(id)?.tokens ?? 0), 0)
}
