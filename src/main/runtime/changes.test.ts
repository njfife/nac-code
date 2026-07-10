import { describe, it, expect } from 'vitest'
import { parseStatus, parseNumstat, parseDiff, readFileForContext } from './changes'

describe('readFileForContext', () => {
  it('returns null for a missing/unreadable file (so the renderer can flag it, not treat "" as valid)', async () => {
    expect(await readFileForContext('/definitely/not/a/real/path/xyz-clp.txt')).toBeNull()
  })
})

describe('parseStatus', () => {
  it('maps porcelain codes to statuses, incl. untracked + rename', () => {
    const out = ' M src/a.ts\nA  src/b.ts\n D src/c.ts\n?? src/new.ts\nR  old.ts -> src/renamed.ts'
    expect(parseStatus(out)).toEqual([
      { path: 'src/a.ts', status: 'modified', untracked: false },
      { path: 'src/b.ts', status: 'added', untracked: false },
      { path: 'src/c.ts', status: 'deleted', untracked: false },
      { path: 'src/new.ts', status: 'added', untracked: true },
      { path: 'src/renamed.ts', status: 'modified', untracked: false }
    ])
  })
})

describe('parseNumstat', () => {
  it('parses adds/dels and treats binary - as 0', () => {
    expect(parseNumstat('12\t3\tsrc/a.ts\n-\t-\timg.png')).toEqual({
      'src/a.ts': { adds: 12, dels: 3 },
      'img.png': { adds: 0, dels: 0 }
    })
  })
})

describe('parseDiff', () => {
  it('keeps +/- as add/del, hunk headers as context, drops file headers', () => {
    const out = ['diff --git a/x b/x', 'index 111..222 100644', '--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', ' ctx line', '-removed', '+added'].join('\n')
    expect(parseDiff(out)).toEqual([
      { type: 'ctx', text: '@@ -1,2 +1,2 @@' },
      { type: 'ctx', text: 'ctx line' },
      { type: 'del', text: 'removed' },
      { type: 'add', text: 'added' }
    ])
  })
})
