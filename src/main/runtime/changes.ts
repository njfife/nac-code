import { execFile } from 'child_process'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { ChangesResult, ChangedFileInfo, FileDiffResult, FileStatus, DiffSpan } from '../../shared/runtime'
import { resolveCwd } from './paths'

// Real working-tree reader (FR-12): the git diff of what the agent (or you) changed in a workspace.
// Pure parsers are exported for testing; the git invocations wrap them.

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout)
    })
  })
}

/** Parse `git status --porcelain=v1` into file entries. */
export function parseStatus(out: string): { path: string; status: FileStatus; untracked: boolean }[] {
  const res: { path: string; status: FileStatus; untracked: boolean }[] = []
  for (const line of out.split('\n')) {
    if (line.length < 4) continue
    const xy = line.slice(0, 2)
    let path = line.slice(3)
    if (path.includes(' -> ')) path = path.split(' -> ')[1] // rename: keep the new path
    const untracked = xy === '??'
    let status: FileStatus = 'modified'
    if (untracked || xy.includes('A')) status = 'added'
    else if (xy.includes('D')) status = 'deleted'
    res.push({ path, status, untracked })
  }
  return res
}

/** Parse `git diff --numstat` into path → {adds,dels} (binary files report '-'). */
export function parseNumstat(out: string): Record<string, { adds: number; dels: number }> {
  const map: Record<string, { adds: number; dels: number }> = {}
  for (const line of out.split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    map[parts[2]] = {
      adds: parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0,
      dels: parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0
    }
  }
  return map
}

/** Parse unified `git diff` text into renderable spans (drops file/index headers, keeps hunk headers as context). */
export function parseDiff(out: string): DiffSpan[] {
  const spans: DiffSpan[] = []
  for (const line of out.split('\n')) {
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('\\ No newline')) continue
    if (line.startsWith('@@')) spans.push({ type: 'ctx', text: line })
    else if (line.startsWith('+')) spans.push({ type: 'add', text: line.slice(1) })
    else if (line.startsWith('-')) spans.push({ type: 'del', text: line.slice(1) })
    else spans.push({ type: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line })
  }
  while (spans.length && spans[spans.length - 1].text === '' && spans[spans.length - 1].type === 'ctx') spans.pop()
  return spans
}

export async function getChanges(rawCwd: string): Promise<ChangesResult | null> {
  const cwd = resolveCwd(rawCwd)
  if (!cwd) return null
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (top == null) return null // not a git repo (or cwd missing)
  const root = top.trim()
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() || 'HEAD'
  const numstat = parseNumstat((await git(cwd, ['diff', 'HEAD', '--numstat'])) ?? '')
  const entries = parseStatus((await git(cwd, ['status', '--porcelain=v1'])) ?? '')
  const files: ChangedFileInfo[] = []
  for (const e of entries) {
    let counts = numstat[e.path] ?? { adds: 0, dels: 0 }
    if (e.untracked) counts = { adds: await countLines(join(root, e.path)), dels: 0 }
    files.push({ path: e.path, status: e.status, additions: counts.adds, deletions: counts.dels })
  }
  return { branch, root, files }
}

export async function getFileDiff(rawCwd: string, file: string): Promise<FileDiffResult> {
  const cwd = resolveCwd(rawCwd)
  if (!cwd) return { diff: [], source: '' }
  const root = (await git(cwd, ['rev-parse', '--show-toplevel']))?.trim() ?? cwd
  let diffOut = (await git(cwd, ['diff', 'HEAD', '--', file])) ?? ''
  if (!diffOut.trim()) diffOut = (await git(cwd, ['diff', '--no-index', '--', '/dev/null', file])) ?? '' // untracked
  const source = await readFileSafe(join(root, file))
  return { diff: parseDiff(diffOut), source }
}

async function countLines(path: string): Promise<number> {
  const text = await readFileSafe(path)
  if (!text) return 0
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}

async function readFileSafe(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

// Read a file for context injection (expands ~, caps size).
export async function readFileForContext(rawPath: string): Promise<string> {
  const text = await readFileSafe(resolveCwd(rawPath) ?? rawPath)
  return text.length > 200_000 ? `${text.slice(0, 200_000)}\n…[truncated]` : text
}
