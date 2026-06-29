import type { FileStatus } from '../../../shared/runtime'

// Status glyphs for the Changes view. Real working-tree data comes from the git reader (main process).
export const STATUS_META: Record<FileStatus, { letter: string; color: string; label: string }> = {
  added: { letter: 'A', color: 'var(--success)', label: 'Added' },
  modified: { letter: 'M', color: 'var(--warning)', label: 'Modified' },
  deleted: { letter: 'D', color: 'var(--error)', label: 'Deleted' }
}
