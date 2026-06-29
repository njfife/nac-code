// Stubbed Changes data — stands in for the GitReader (v1-stub; real working-tree read is roadmap FR-12.9).

export type FileStatus = 'added' | 'modified' | 'deleted'

export interface DiffLine {
  type: 'ctx' | 'add' | 'del'
  text: string
}

export interface ChangedFile {
  path: string
  dir: string
  name: string
  status: FileStatus
  adds: number
  dels: number
  language: string
  diff: DiffLine[]
  source: string
}

export interface Repo {
  id: string
  name: string
  path: string
  branch: string
  inWorkspace: boolean
  files: ChangedFile[]
}

export const STATUS_META: Record<FileStatus, { letter: string; color: string; label: string }> = {
  added: { letter: 'A', color: 'var(--success)', label: 'Added' },
  modified: { letter: 'M', color: 'var(--warning)', label: 'Modified' },
  deleted: { letter: 'D', color: 'var(--error)', label: 'Deleted' }
}

export const REPOS: Repo[] = [
  {
    id: 'nac-code',
    name: 'nac-code',
    path: '~/Code/nac-code',
    branch: 'main',
    inWorkspace: true,
    files: [
      {
        path: 'src/renderer/src/store/store.ts',
        dir: 'src/renderer/src/store',
        name: 'store.ts',
        status: 'modified',
        adds: 12,
        dels: 2,
        language: 'ts',
        diff: [
          { type: 'ctx', text: 'export interface Chat {' },
          { type: 'del', text: '  attached: number' },
          { type: 'add', text: '  attachedIds: string[]' },
          { type: 'add', text: '  dirty: boolean' },
          { type: 'ctx', text: '}' }
        ],
        source: 'export interface Chat {\n  id: string\n  attachedIds: string[]\n  dirty: boolean\n}\n'
      },
      {
        path: 'src/renderer/src/components/CommandPalette.tsx',
        dir: 'src/renderer/src/components',
        name: 'CommandPalette.tsx',
        status: 'added',
        adds: 96,
        dels: 0,
        language: 'tsx',
        diff: [
          { type: 'add', text: 'export default function CommandPalette() {' },
          { type: 'add', text: '  const [query, setQuery] = useState("")' },
          { type: 'add', text: '  // …' },
          { type: 'add', text: '}' }
        ],
        source: 'export default function CommandPalette() {\n  const [query, setQuery] = useState("")\n  return null\n}\n'
      }
    ]
  },
  {
    id: 'shared-ui',
    name: 'shared-ui',
    path: '~/Code/shared-ui',
    branch: 'feature/tokens',
    inWorkspace: false,
    files: [
      {
        path: 'src/tokens.ts',
        dir: 'src',
        name: 'tokens.ts',
        status: 'modified',
        adds: 4,
        dels: 1,
        language: 'ts',
        diff: [
          { type: 'ctx', text: 'export const tokens = {' },
          { type: 'del', text: '  accent: "#6c6cf0"' },
          { type: 'add', text: '  accent: "#7c7cf0",' },
          { type: 'add', text: '  accentHover: "#8b8bf2"' },
          { type: 'ctx', text: '}' }
        ],
        source: 'export const tokens = {\n  accent: "#7c7cf0",\n  accentHover: "#8b8bf2"\n}\n'
      }
    ]
  }
]

export function changesSummary(): { repos: number; files: number; adds: number; dels: number } {
  let files = 0
  let adds = 0
  let dels = 0
  for (const r of REPOS) {
    for (const f of r.files) {
      files++
      adds += f.adds
      dels += f.dels
    }
  }
  return { repos: REPOS.length, files, adds, dels }
}
