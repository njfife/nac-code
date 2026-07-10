import { describe, it, expect, afterEach } from 'vitest'
import { writeFile, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseStatus, parseNumstat, parseDiff, readFileForContext } from './changes'

describe('readFileForContext', () => {
  it('returns null for a missing/unreadable file (so the renderer can flag it, not treat "" as valid)', async () => {
    expect(await readFileForContext('/definitely/not/a/real/path/xyz-clp.txt')).toBeNull()
  })

  describe('oversized files', () => {
    const bigPath = join(tmpdir(), 'clp-oversized-test.txt')

    afterEach(async () => {
      await unlink(bigPath).catch(() => {})
    })

    it('does NOT pre-truncate below the renderer refusal threshold (262144) — full text passes through so the real toolarge check fires', async () => {
      // One char over the renderer's 262144 threshold; well under our own 2_000_000 defensive cap.
      const text = 'x'.repeat(262_145)
      await writeFile(bigPath, text, 'utf8')
      const result = await readFileForContext(bigPath)
      expect(result).not.toBeNull()
      expect(result!.length).toBeGreaterThan(262_144)
      expect(result).toBe(text) // returned whole, not truncated/annotated
    })
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
