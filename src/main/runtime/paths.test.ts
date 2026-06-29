import { describe, it, expect } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'
import { resolveCwd } from './paths'

describe('resolveCwd', () => {
  it('returns undefined for empty/blank/undefined (run falls back to process cwd)', () => {
    expect(resolveCwd(undefined)).toBeUndefined()
    expect(resolveCwd('')).toBeUndefined()
    expect(resolveCwd('   ')).toBeUndefined()
  })

  it('passes absolute paths through', () => {
    expect(resolveCwd('/Users/x/proj')).toBe('/Users/x/proj')
  })

  it('expands a leading ~', () => {
    expect(resolveCwd('~')).toBe(homedir())
    expect(resolveCwd('~/Code/nac-code')).toBe(join(homedir(), 'Code/nac-code'))
  })
})
