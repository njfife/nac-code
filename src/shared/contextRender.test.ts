import { describe, it, expect } from 'vitest'
import { renderContextText } from './contextRender'

describe('renderContextText', () => {
  it('renders items as ## sections with file fences, matching the v1 block shape', () => {
    const out = renderContextText({ items: [{ name: 'conventions', content: 'use tabs' }, { name: 'a.ts', content: 'code', path: '/x/a.ts' }], removed: [] })
    expect(out).toContain('Attached context for this conversation:')
    expect(out).toContain('## conventions\nuse tabs')
    expect(out).toContain('## a.ts (/x/a.ts)')
    expect(out).toContain('```\ncode\n```')
    expect(out.endsWith('---\n\n')).toBe(true)
  })
  it('renders removal + refused notes with the exact copy', () => {
    const out = renderContextText({ items: [], removed: ['old-note'], notes: ['attached file big.bin could not be included (too large)'] })
    expect(out).toContain('The following attached context was removed — disregard it going forward: old-note')
    expect(out).toContain('attached file big.bin could not be included (too large)')
  })
  it('empty payload renders empty string', () => {
    expect(renderContextText({ items: [], removed: [] })).toBe('')
  })
})
