import { ITEMS_BY_ID } from './context'

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

export function configTokens(c: Configuration): number {
  return c.itemIds.reduce((sum, id) => sum + (ITEMS_BY_ID[id]?.tokens ?? 0), 0)
}
