import { describe, it, expect } from 'vitest'
import { parseFrontmatter, renderFrontmatter, hasNacMarker } from './frontmatter'

describe('parseFrontmatter', () => {
  it('parses key: value lines between --- fences and returns the body', () => {
    const r = parseFrontmatter('---\nname: reviewer\ndescription: Reviews code\n---\nYou review code.\n')
    expect(r).toEqual({ attrs: { name: 'reviewer', description: 'Reviews code' }, body: 'You review code.' })
  })
  it('tolerates missing keys, colons in values, and CRLF', () => {
    const r = parseFrontmatter('---\r\nname: a\r\ndescription: b: with colon\r\n---\r\nbody')
    expect(r!.attrs.description).toBe('b: with colon')
  })
  it('returns null when fences are absent or unclosed', () => {
    expect(parseFrontmatter('no fences here')).toBeNull()
    expect(parseFrontmatter('---\nname: x\nnobody closed me')).toBeNull()
  })
})

describe('renderFrontmatter + marker', () => {
  it('round-trips through parseFrontmatter', () => {
    const raw = renderFrontmatter({ name: 'x', 'managed-by': 'nac-code', 'nac-rev': '3' }, 'PROMPT')
    const back = parseFrontmatter(raw)!
    expect(back.attrs['managed-by']).toBe('nac-code')
    expect(back.body).toBe('PROMPT')
    expect(hasNacMarker(back.attrs)).toBe(true)
    expect(hasNacMarker({ name: 'x' })).toBe(false)
  })
})
