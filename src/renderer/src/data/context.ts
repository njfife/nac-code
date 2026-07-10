// Static context catalog for the Context Library (FR-5). Real items come from disk/registry later.

export type ItemType = 'skill' | 'agent' | 'instruction' | 'file'

export interface ContextItem {
  id: string
  type: ItemType
  name: string
  description: string
  tokens: number
  scope: 'workspace' | 'global'
  source: string
  tags: string[]
  content?: string // authored text injected when attached (notes/skills/instructions)
  path?: string // file on disk; its content is read + injected when attached
  user?: boolean // created by the user (vs a seed) — removable
}

export const TYPE_META: Record<ItemType, { label: string; color: string; letter: string }> = {
  skill: { label: 'Skill', color: 'var(--type-skill)', letter: 'S' },
  agent: { label: 'Agent', color: 'var(--type-agent)', letter: 'A' },
  instruction: { label: 'Instruction', color: 'var(--type-instruction)', letter: 'I' },
  file: { label: 'File', color: 'var(--type-file)', letter: 'F' }
}

// Real items only — each carries actual `content` injected into the agent's context when attached.
// Token counts are computed from that content, not hand-guessed.
const est = (c: string): number => Math.ceil(c.length / 4)

export const CONTEXT_ITEMS: ContextItem[] = [
  { id: 'sk-tdd', type: 'skill', name: 'test-driven-development', description: 'Write the failing test first, then the minimal code to pass.', tokens: est('Follow strict TDD: write a failing test first, then the minimal code to make it pass, then refactor. Never write implementation before its test exists.'), scope: 'global', source: 'superpowers', tags: ['testing'], content: 'Follow strict TDD: write a failing test first, then the minimal code to make it pass, then refactor. Never write implementation before its test exists.' },
  { id: 'in-style', type: 'instruction', name: 'code-style', description: 'Match the surrounding code conventions.', tokens: est('Match the surrounding code: its naming, formatting, and comment density. Do not introduce new patterns, libraries, or abstractions unless necessary.'), scope: 'workspace', source: 'instructions', tags: ['style'], content: 'Match the surrounding code: its naming, formatting, and comment density. Do not introduce new patterns, libraries, or abstractions unless necessary.' },
  { id: 'in-security', type: 'instruction', name: 'security-baseline', description: 'No secrets in code; least privilege; validate input.', tokens: est('Never hardcode secrets or credentials. Validate and sanitize all external input. Apply least privilege. Never log sensitive values.'), scope: 'global', source: 'instructions', tags: ['security'], content: 'Never hardcode secrets or credentials. Validate and sanitize all external input. Apply least privilege. Never log sensitive values.' }
]

export const ITEMS_BY_ID: Record<string, ContextItem> = Object.fromEntries(CONTEXT_ITEMS.map((i) => [i.id, i]))

// Budget meter color: green (<60%), amber (60-85%), red (>85%) of the active chat's context window.
export function budgetColor(tokens: number, windowTokens: number): string {
  const frac = windowTokens > 0 ? tokens / windowTokens : 0
  if (frac > 0.85) return 'var(--error)'
  if (frac > 0.6) return 'var(--warning)'
  return 'var(--success)'
}
