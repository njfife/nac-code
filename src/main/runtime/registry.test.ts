import { describe, it, expect } from 'vitest'
import { parseVersionLine, ADAPTER_PROVIDERS } from './registry'

describe('parseVersionLine', () => {
  it('extracts the version token from real CLI outputs', () => {
    expect(parseVersionLine('2.0.14 (Claude Code)')).toBe('2.0.14')
    expect(parseVersionLine('codex-cli 0.46.0')).toBe('0.46.0')
    expect(parseVersionLine('0.0.339\n')).toBe('0.0.339')
  })
  it('falls back to the first line when no version token exists', () => {
    expect(parseVersionLine('dev build')).toBe('dev build')
  })
  it('returns undefined for empty output', () => {
    expect(parseVersionLine('')).toBeUndefined()
    expect(parseVersionLine('  \n ')).toBeUndefined()
  })
  it('probes exactly the adapter-backed providers', () => {
    expect([...ADAPTER_PROVIDERS]).toEqual(['claude', 'codex', 'copilot', 'opencode'])
  })
})
