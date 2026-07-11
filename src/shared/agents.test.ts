import { describe, it, expect } from 'vitest'
import { slugify, AGENTS_CHANNELS } from './agents'

describe('slugify', () => {
  it('lowercases and hyphenates non-alphanumerics, collapsing runs', () => {
    expect(slugify('My Reviewer!')).toBe('my-reviewer')
    expect(slugify('  Infra / Ops agent ')).toBe('infra-ops-agent')
    expect(slugify('already-good')).toBe('already-good')
  })
  it('never returns an empty slug', () => {
    expect(slugify('!!!')).toBe('agent')
  })
})

describe('channels', () => {
  it('exposes the two agent channels', () => {
    expect(AGENTS_CHANNELS).toEqual({ get: 'agents:get', sync: 'agents:sync' })
  })
})
