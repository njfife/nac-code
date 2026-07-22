// Tolerant frontmatter: `key: value` lines between --- fences. Deliberately not YAML — every agent
// file format in play (claude, copilot .agent.md, opencode) uses flat scalar keys, and a YAML dep
// would be the only one in main. Unknown/list-valued lines are kept as raw strings.

export function parseFrontmatter(raw: string): { attrs: Record<string, string>; body: string } | null {
  const text = raw.replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) return null
  const end = text.indexOf('\n---', 4)
  if (end < 0) return null
  const attrs: Record<string, string> = {}
  for (const line of text.slice(4, end).split('\n')) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    attrs[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  const body = text.slice(end + 4).replace(/^\n/, '').trimEnd()
  return { attrs, body }
}

export function renderFrontmatter(attrs: Record<string, string>, body: string): string {
  const lines = Object.entries(attrs).map(([k, v]) => `${k}: ${v}`)
  return `---\n${lines.join('\n')}\n---\n${body}\n`
}

export const NAC_MARKER_KEY = 'managed-by'
export const NAC_MARKER_VALUE = 'nac-code'

export function hasNacMarker(attrs: Record<string, string>): boolean {
  return attrs[NAC_MARKER_KEY] === NAC_MARKER_VALUE
}
