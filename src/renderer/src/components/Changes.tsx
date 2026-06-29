import { useState, type CSSProperties } from 'react'
import { useApp } from '../store/store'
import { REPOS, STATUS_META, changesSummary } from '../data/changes'

// Full-screen Changes route (FR-12): repos (incl. out-of-workspace) · files · in-app diff/source viewer.
export default function Changes() {
  const setView = useApp((s) => s.setView)
  const sum = changesSummary()
  const [selected, setSelected] = useState<{ repo: string; path: string }>({ repo: REPOS[0].id, path: REPOS[0].files[0].path })
  const [mode, setMode] = useState<'diff' | 'source'>('diff')
  const [toast, setToast] = useState<string | null>(null)

  const repo = REPOS.find((r) => r.id === selected.repo) ?? REPOS[0]
  const file = repo.files.find((f) => f.path === selected.path) ?? repo.files[0]

  function showToast(msg: string): void {
    setToast(msg)
    setTimeout(() => setToast(null), 2400)
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--app-bg)', position: 'relative' }}>
      <div style={{ height: 'var(--topbar-h)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 14, padding: '0 16px', borderBottom: '1px solid var(--line)' }}>
        <button onClick={() => setView('chat')} style={backBtn}>← Back</button>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Changes</span>
        <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
          {sum.repos} repos · {sum.files} files <span style={{ color: 'var(--success)' }}>+{sum.adds}</span>{' '}
          <span style={{ color: 'var(--error)' }}>−{sum.dels}</span>
        </span>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* repo + file tree */}
        <div style={{ width: 340, flexShrink: 0, borderRight: '1px solid var(--line)', overflow: 'auto', padding: 10 }}>
          {REPOS.map((r) => (
            <div key={r.id} style={repoCard}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                <span className="mono" style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600 }}>{r.name}</span>
                <span style={branchChip}>{r.branch}</span>
                {!r.inWorkspace && <span style={outsideBadge}>OUTSIDE WS</span>}
              </div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--faint)', marginBottom: 8 }}>{r.path}</div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                <button onClick={() => showToast(`Launching IntelliJ → ${r.path}`)} style={ideBtn}>IntelliJ</button>
                <button onClick={() => showToast(`Launching VS Code → ${r.path}`)} style={ideBtn}>VS Code</button>
              </div>
              {r.files.map((f) => {
                const m = STATUS_META[f.status]
                const isSel = selected.repo === r.id && selected.path === f.path
                return (
                  <div
                    key={f.path}
                    onClick={() => setSelected({ repo: r.id, path: f.path })}
                    style={{ ...fileRow, background: isSel ? 'var(--accent-tint)' : 'transparent' }}
                  >
                    <span className="mono" style={{ color: m.color, fontWeight: 700, width: 12 }}>{m.letter}</span>
                    <span className="mono" style={{ fontSize: 12.5, color: 'var(--text-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</span>
                    <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, flexShrink: 0 }}>
                      <span style={{ color: 'var(--success)' }}>+{f.adds}</span> <span style={{ color: 'var(--error)' }}>−{f.dels}</span>
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        {/* viewer */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
            <span className="mono" style={{ fontSize: 12, color: 'var(--text-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{file.path}</span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--faint)', flexShrink: 0 }}>{repo.name} · {repo.branch}</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 2, background: 'var(--card)', borderRadius: 6, padding: 2, border: '1px solid var(--line)', flexShrink: 0 }}>
              {(['diff', 'source'] as const).map((mm) => (
                <button key={mm} onClick={() => setMode(mm)} style={{ ...toggleBtn, background: mode === mm ? 'var(--accent-tint-3)' : 'transparent', color: mode === mm ? 'var(--text)' : 'var(--muted)' }}>
                  {mm[0].toUpperCase() + mm.slice(1)}
                </button>
              ))}
            </div>
            <button onClick={() => showToast(`Revealed ${file.name} in Finder`)} style={ideBtn}>Finder</button>
          </div>
          <div style={{ flex: 1, overflow: 'auto', background: 'var(--code-bg)', fontSize: 12.5, lineHeight: 1.6 }} className="mono">
            {mode === 'diff'
              ? file.diff.map((l, i) => (
                  <div key={i} style={{ display: 'flex', background: l.type === 'add' ? 'rgba(70,207,139,.08)' : l.type === 'del' ? 'rgba(240,114,106,.08)' : 'transparent' }}>
                    <span style={{ width: 20, textAlign: 'center', color: 'var(--faint)', userSelect: 'none' }}>{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
                    <span style={{ color: l.type === 'add' ? 'var(--success)' : l.type === 'del' ? 'var(--error)' : 'var(--text-3)', whiteSpace: 'pre' }}>{l.text}</span>
                  </div>
                ))
              : file.source.split('\n').map((line, i) => (
                  <div key={i} style={{ display: 'flex' }}>
                    <span style={{ width: 36, textAlign: 'right', paddingRight: 12, color: 'var(--faint)', userSelect: 'none' }}>{i + 1}</span>
                    <span style={{ color: 'var(--text-3)', whiteSpace: 'pre' }}>{line}</span>
                  </div>
                ))}
          </div>
        </div>
      </div>

      {toast && <div style={toastStyle}>{toast}</div>}
    </div>
  )
}

const backBtn: CSSProperties = { background: 'var(--card)', color: 'var(--text-2)', border: '1px solid var(--line)', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }
const repoCard: CSSProperties = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: 12, marginBottom: 10 }
const branchChip: CSSProperties = { fontSize: 10.5, fontFamily: 'IBM Plex Mono, monospace', color: 'var(--accent-light)', background: 'var(--accent-tint)', borderRadius: 5, padding: '1px 6px' }
const outsideBadge: CSSProperties = { fontSize: 9.5, letterSpacing: 0.6, fontWeight: 700, color: 'var(--warning)', background: 'rgba(227,178,95,.12)', borderRadius: 5, padding: '1px 6px' }
const ideBtn: CSSProperties = { background: 'var(--card-2)', color: 'var(--text-2)', border: '1px solid var(--line)', borderRadius: 6, padding: '4px 10px', fontSize: 11.5, cursor: 'pointer', flexShrink: 0 }
const fileRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 6, cursor: 'pointer' }
const toggleBtn: CSSProperties = { border: 'none', cursor: 'pointer', fontSize: 12, padding: '3px 10px', borderRadius: 5 }
const toastStyle: CSSProperties = { position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: 'var(--card-3)', color: 'var(--text)', border: '1px solid var(--line-2)', borderRadius: 8, padding: '8px 16px', fontSize: 12.5, boxShadow: '0 16px 48px rgba(0,0,0,.55)' }
