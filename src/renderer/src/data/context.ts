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
}

export const TYPE_META: Record<ItemType, { label: string; color: string; letter: string }> = {
  skill: { label: 'Skill', color: 'var(--type-skill)', letter: 'S' },
  agent: { label: 'Agent', color: 'var(--type-agent)', letter: 'A' },
  instruction: { label: 'Instruction', color: 'var(--type-instruction)', letter: 'I' },
  file: { label: 'File', color: 'var(--type-file)', letter: 'F' }
}

export const CONTEXT_ITEMS: ContextItem[] = [
  { id: 'sk-tdd', type: 'skill', name: 'test-driven-development', description: 'Write the failing test first, then the minimal code to pass.', tokens: 1800, scope: 'global', source: 'superpowers', tags: ['testing'] },
  { id: 'sk-debug', type: 'skill', name: 'systematic-debugging', description: 'Find the root cause before proposing a fix.', tokens: 1500, scope: 'global', source: 'superpowers', tags: ['debug'] },
  { id: 'sk-brainstorm', type: 'skill', name: 'brainstorming', description: 'Explore intent and design before implementation.', tokens: 1200, scope: 'workspace', source: 'superpowers', tags: ['planning'] },
  { id: 'sk-review', type: 'skill', name: 'requesting-code-review', description: 'Run an adversarial review pass before merging.', tokens: 1400, scope: 'global', source: 'superpowers', tags: ['review'] },
  { id: 'ag-nac', type: 'agent', name: 'nac-code', description: 'Default general-purpose coding agent.', tokens: 900, scope: 'workspace', source: 'agents', tags: ['general'] },
  { id: 'ag-infra', type: 'agent', name: 'infra', description: 'Infrastructure & deployment specialist.', tokens: 1100, scope: 'workspace', source: 'agents', tags: ['infra'] },
  { id: 'ag-reviewer', type: 'agent', name: 'backend-reviewer', description: 'Reviews backend changes for correctness.', tokens: 1000, scope: 'global', source: 'agents', tags: ['review'] },
  { id: 'ag-frontend', type: 'agent', name: 'frontend-reviewer', description: 'Reviews UI changes against the design system.', tokens: 1000, scope: 'global', source: 'agents', tags: ['review'] },
  { id: 'in-style', type: 'instruction', name: 'code-style', description: 'Match the surrounding code conventions.', tokens: 600, scope: 'workspace', source: 'instructions', tags: ['style'] },
  { id: 'in-security', type: 'instruction', name: 'security-baseline', description: 'No secrets in code; least privilege; validate input.', tokens: 800, scope: 'global', source: 'instructions', tags: ['security'] },
  { id: 'in-commit', type: 'instruction', name: 'commit-format', description: 'Conventional commits; imperative subject.', tokens: 400, scope: 'workspace', source: 'instructions', tags: ['git'] },
  { id: 'fl-readme', type: 'file', name: 'README.md', description: 'Project overview and orientation.', tokens: 1200, scope: 'workspace', source: 'docs/', tags: ['docs'] },
  { id: 'fl-spec', type: 'file', name: 'M0-agent-runtime-and-context.md', description: 'Agent runtime + cross-provider context spec.', tokens: 5400, scope: 'workspace', source: 'docs/specs/', tags: ['spec'] },
  { id: 'fl-deploy', type: 'file', name: 'deploy.yml', description: 'CI/CD pipeline definition.', tokens: 2200, scope: 'workspace', source: 'infra/', tags: ['infra'] },
  { id: 'fl-plan', type: 'file', name: 'engineering-plan.md', description: 'Master engineering plan.', tokens: 9800, scope: 'workspace', source: 'docs/plans/', tags: ['plan'] },
  { id: 'fl-tokens', type: 'file', name: 'tokens.css', description: 'Design token definitions.', tokens: 700, scope: 'workspace', source: 'src/', tags: ['design'] }
]

export const ITEMS_BY_ID: Record<string, ContextItem> = Object.fromEntries(CONTEXT_ITEMS.map((i) => [i.id, i]))

export const WINDOW_TOKENS = 128_000

// Budget meter color: green → amber (>76k) → red (>108k), per the design.
export function budgetColor(tokens: number): string {
  if (tokens > 108_000) return 'var(--error)'
  if (tokens > 76_000) return 'var(--warning)'
  return 'var(--success)'
}
