import { useEffect } from 'react'
import { useApp, selectActiveChat, workspaceName, type Layout } from '../store/store'
import LeftRail from './LeftRail'
import ChatView from './ChatView'
import Inspector from './Inspector'
import ModelModal from './ModelModal'
import AgentModal from './AgentModal'
import StatsModal from './StatsModal'
import ContextLibrary from './ContextLibrary'
import Changes from './Changes'
import CommandPalette from './CommandPalette'

const ACCOUNT = '@nfife_fontfife'

// The persistent application frame: top bar (46) / body (left rail · center · inspector) / status bar (28).
// 1180px min-width with horizontal scroll — panes never collapse (FR-1.5 / NFR-4). Focus layout hides the inspector.
export default function Shell() {
  const layout = useApp((s) => s.layout)
  const modal = useApp((s) => s.modal)
  const view = useApp((s) => s.view)
  const palette = useApp((s) => s.palette)
  const togglePalette = useApp((s) => s.togglePalette)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        togglePalette()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePalette])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        minWidth: 'var(--min-app-w)',
        overflowX: 'auto'
      }}
    >
      <TopBar />
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {view === 'context' ? (
          <ContextLibrary />
        ) : view === 'changes' ? (
          <Changes />
        ) : (
          <>
            {layout === 'cockpit' && <ActivityRail />}
            <LeftRail />
            <ChatView />
            {layout !== 'focus' && <Inspector />}
          </>
        )}
      </div>
      <StatusBar />
      {modal === 'model' && <ModelModal />}
      {modal === 'agent' && <AgentModal />}
      {modal === 'stats' && <StatsModal />}
      {palette && <CommandPalette />}
    </div>
  )
}

const MODES: { label: string; value: Layout }[] = [
  { label: 'Studio', value: 'studio' },
  { label: 'Cockpit', value: 'cockpit' },
  { label: 'Focus', value: 'focus' }
]

// Cockpit activity rail (FR-1.3): slim icon rail with quick jumps.
function ActivityRail() {
  const setView = useApp((s) => s.setView)
  const togglePalette = useApp((s) => s.togglePalette)
  return (
    <div style={{ width: 'var(--activity-w)', flexShrink: 0, background: 'var(--rail)', borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '10px 0', gap: 6 }}>
      <RailBtn glyph="◧" title="Context Library" onClick={() => setView('context')} />
      <RailBtn glyph="▤" title="Changes" onClick={() => setView('changes')} />
      <RailBtn glyph="⌘K" title="Command palette" onClick={() => togglePalette()} />
    </div>
  )
}

function RailBtn(props: { glyph: string; title: string; onClick: () => void }) {
  return (
    <button title={props.title} onClick={props.onClick} style={{ width: 36, height: 36, borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--muted)', fontSize: 14, cursor: 'pointer' }}>
      {props.glyph}
    </button>
  )
}

function TopBar() {
  const workspaces = useApp((s) => s.workspaces)
  const active = useApp(selectActiveChat)
  const layout = useApp((s) => s.layout)
  const setLayout = useApp((s) => s.setLayout)

  return (
    <header
      style={{
        height: 'var(--topbar-h)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        padding: '0 14px',
        background: 'var(--panel)',
        borderBottom: '1px solid var(--line)'
      }}
    >
      <div style={{ display: 'flex', gap: 8 }}>
        {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
          <span key={c} style={{ width: 12, height: 12, borderRadius: '50%', background: c }} />
        ))}
      </div>
      <div style={{ flex: 1, textAlign: 'center', fontSize: 13, color: 'var(--text-2)' }}>
        NAC Code <span style={{ color: 'var(--faint)' }}>/ {workspaceName(workspaces, active.workspaceId)}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', background: 'var(--card)', borderRadius: 8, padding: 2, border: '1px solid var(--line)' }}>
          {MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => setLayout(m.value)}
              style={{
                border: 'none',
                cursor: 'pointer',
                fontSize: 12,
                padding: '3px 10px',
                borderRadius: 6,
                color: layout === m.value ? 'var(--text)' : 'var(--muted)',
                background: layout === m.value ? 'var(--accent-tint-3)' : 'transparent'
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
        <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
          {ACCOUNT}
        </span>
      </div>
    </header>
  )
}

function StatusBar() {
  const active = useApp(selectActiveChat)
  return (
    <footer
      className="mono"
      style={{
        height: 'var(--statusbar-h)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '0 12px',
        background: 'var(--panel-2)',
        borderTop: '1px solid var(--line)',
        fontSize: 11.5,
        color: 'var(--muted)'
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--success)' }} /> {ACCOUNT}
      </span>
      <span>MCP not checked</span>
      <span style={{ marginLeft: 'auto' }}>
        {active.attachedIds.length} attached · ~{active.contextK}k / {active.windowK}K tokens
      </span>
      <span>Version 0.10.0</span>
    </footer>
  )
}
