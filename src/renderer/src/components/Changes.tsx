import { useEffect, useState, type CSSProperties } from 'react'
import { useApp, selectActiveChat } from '../store/store'
import { STATUS_META } from '../data/changes'
import type { ChangesResult, FileDiffResult } from '../../../shared/runtime'

const basename = (p: string): string => p.split('/').pop() || p
const dirname = (p: string): string => {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(0, i) : ''
}

// Full-screen Changes route (FR-12): the real git working-tree of the active chat's workspace.
export default function Changes() {
  const setView = useApp((s) => s.setView)
  const active = useApp(selectActiveChat)
  const cwd = useApp((s) => s.workspaces.find((w) => w.id === active.workspaceId)?.path) ?? ''

  const [changes, setChanges] = useState<ChangesResult | null | undefined>(undefined) // undefined = loading
  const [selected, setSelected] = useState<string | null>(null)
  const [fileDiff, setFileDiff] = useState<FileDiffResult | null>(null)
  const [mode, setMode] = useState<'diff' | 'source'>('diff')

  function refresh(): void {
    if (!cwd) {
      setChanges(null)
      return
    }
    setChanges(undefined)
    window.nac?.changes
      ?.get(cwd)
      .then((c) => {
        setChanges(c)
        setSelected((prev) => (c?.files.some((f) => f.path === prev) ? prev : c?.files[0]?.path ?? null))
      })
      .catch(() => setChanges(null))
  }
  useEffect(refresh, [cwd])

  useEffect(() => {
    if (!selected) {
      setFileDiff(null)
      return
    }
    let live = true
    window.nac?.changes
      ?.diff(cwd, selected)
      .then((d) => {
        if (live) setFileDiff(d)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [cwd, selected])

  const files = changes?.files ?? []
  const adds = files.reduce((s, f) => s + f.additions, 0)
  const dels = files.reduce((s, f) => s + f.deletions, 0)
  const wsName = useApp((s) => s.workspaces.find((w) => w.id === active.workspaceId)?.name) ?? 'workspace'

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--app-bg)', position: 'relative' }}>
      <div style={{ height: 'var(--topbar-h)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 14, padding: '0 16px', borderBottom: '1px solid var(--line)' }}>
        <button onClick={() => setView('chat')} style={backBtn}>← Back</button>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Changes</span>
        <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
          {files.length} files <span style={{ color: 'var(--success)' }}>+{adds}</span> <span style={{ color: 'var(--error)' }}>−{dels}</span>
        </span>
        <button onClick={refresh} style={{ ...backBtn, marginLeft: 'auto' }}>↻ Refresh</button>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* file tree (single repo = the workspace) */}
        <div style={{ width: 340, flexShrink: 0, borderRight: '1px solid var(--line)', overflow: 'auto', padding: 10 }}>
          {changes === undefined && <div style={hint}>Reading working tree…</div>}
          {changes === null && <div style={hint}>{cwd ? 'Not a git repository.' : 'This workspace has no folder bound. Use “+ Workspace” in the rail.'}</div>}
          {changes && files.length === 0 && <div style={hint}>No changes — working tree clean.</div>}
          {changes && files.length > 0 && (
            <div style={repoCard}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                <span className="mono" style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600 }}>{wsName}</span>
                <span style={branchChip}>{changes.branch}</span>
              </div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--faint)', marginBottom: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={changes.root}>{changes.root}</div>
              {files.map((f) => {
                const m = STATUS_META[f.status]
                const isSel = selected === f.path
                return (
                  <div key={f.path} onClick={() => setSelected(f.path)} style={{ ...fileRow, background: isSel ? 'var(--accent-tint)' : 'transparent' }}>
                    <span className="mono" style={{ color: m.color, fontWeight: 700, width: 12, flexShrink: 0 }}>{m.letter}</span>
                    <span className="mono" style={{ fontSize: 12.5, color: 'var(--text-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={f.path}>{basename(f.path)}</span>
                    <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, flexShrink: 0 }}>
                      <span style={{ color: 'var(--success)' }}>+{f.additions}</span> <span style={{ color: 'var(--error)' }}>−{f.deletions}</span>
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* viewer */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {selected ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
                <span className="mono" style={{ fontSize: 12, color: 'var(--text-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{selected}</span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--faint)', flexShrink: 0 }}>{dirname(selected) || '.'}</span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 2, background: 'var(--card)', borderRadius: 6, padding: 2, border: '1px solid var(--line)', flexShrink: 0 }}>
                  {(['diff', 'source'] as const).map((mm) => (
                    <button key={mm} onClick={() => setMode(mm)} style={{ ...toggleBtn, background: mode === mm ? 'var(--accent-tint-3)' : 'transparent', color: mode === mm ? 'var(--text)' : 'var(--muted)' }}>
                      {mm[0].toUpperCase() + mm.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ flex: 1, overflow: 'auto', background: 'var(--code-bg)', fontSize: 12.5, lineHeight: 1.6 }} className="mono">
                {!fileDiff ? (
                  <div style={hint}>Loading diff…</div>
                ) : mode === 'diff' ? (
                  fileDiff.diff.length === 0 ? (
                    <div style={hint}>No textual diff (binary or unchanged).</div>
                  ) : (
                    fileDiff.diff.map((l, i) => (
                      <div key={i} style={{ display: 'flex', background: l.type === 'add' ? 'rgba(70,207,139,.08)' : l.type === 'del' ? 'rgba(240,114,106,.08)' : 'transparent' }}>
                        <span style={{ width: 20, textAlign: 'center', color: 'var(--faint)', userSelect: 'none', flexShrink: 0 }}>{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
                        <span style={{ color: l.type === 'add' ? 'var(--success)' : l.type === 'del' ? 'var(--error)' : 'var(--text-3)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{l.text}</span>
                      </div>
                    ))
                  )
                ) : (
                  fileDiff.source.split('\n').map((line, i) => (
                    <div key={i} style={{ display: 'flex' }}>
                      <span style={{ width: 44, textAlign: 'right', paddingRight: 12, color: 'var(--faint)', userSelect: 'none', flexShrink: 0 }}>{i + 1}</span>
                      <span style={{ color: 'var(--text-3)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{line}</span>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            <div style={{ ...hint, margin: 'auto' }}>Select a file to view its diff.</div>
          )}
        </div>
      </div>
    </div>
  )
}

const backBtn: CSSProperties = { background: 'var(--card)', color: 'var(--text-2)', border: '1px solid var(--line)', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }
const repoCard: CSSProperties = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: 12, marginBottom: 10 }
const branchChip: CSSProperties = { fontSize: 10.5, fontFamily: 'IBM Plex Mono, monospace', color: 'var(--accent-light)', background: 'var(--accent-tint)', borderRadius: 5, padding: '1px 6px' }
const fileRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 6, cursor: 'pointer' }
const toggleBtn: CSSProperties = { border: 'none', cursor: 'pointer', fontSize: 12, padding: '3px 10px', borderRadius: 5 }
const hint: CSSProperties = { padding: '16px 14px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }
