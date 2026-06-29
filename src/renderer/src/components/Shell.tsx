import type { CSSProperties } from 'react'
import { useApp, selectActiveChat, workspaceName, type Layout } from '../store/store'
import LeftRail from './LeftRail'
import ChatView from './ChatView'

const ACCOUNT = '@nfife_fontfife'

// The persistent application frame: top bar (46) / body (left rail · center · inspector) / status bar (28).
// 1180px min-width with horizontal scroll — panes never collapse (FR-1.5 / NFR-4). Focus layout hides the inspector.
export default function Shell() {
  const layout = useApp((s) => s.layout)
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
        <LeftRail />
        <ChatView />
        {layout !== 'focus' && <Inspector />}
      </div>
      <StatusBar />
    </div>
  )
}

const MODES: { label: string; value: Layout }[] = [
  { label: 'Studio', value: 'studio' },
  { label: 'Cockpit', value: 'cockpit' },
  { label: 'Focus', value: 'focus' }
]

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
        {active.attached} attached · ~{active.contextK}k / {active.windowK}K tokens
      </span>
      <span>Version 0.10.0</span>
    </footer>
  )
}

// Inspector — structure + tokens now; live panels fleshed out in later M1 chunks.
function Inspector() {
  return (
    <aside
      style={{
        width: 'var(--inspector-w)',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--panel-2)',
        borderLeft: '1px solid var(--line)'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 14px',
          borderBottom: '1px solid var(--line)'
        }}
      >
        <span style={eyebrow}>Inspector</span>
        <button style={ghostBtn}>Stats</button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
        {['CLI Connections', 'MCP Servers', 'Token & Cost', 'Session', 'Attached Context'].map((p) => (
          <div
            key={p}
            style={{
              padding: '10px 12px',
              margin: '4px 0',
              borderRadius: 8,
              background: 'var(--card)',
              border: '1px solid var(--line)',
              fontSize: 12.5,
              color: 'var(--text-3)',
              display: 'flex',
              justifyContent: 'space-between'
            }}
          >
            <span>{p}</span>
            <span style={{ color: 'var(--faint)' }}>▾</span>
          </div>
        ))}
      </div>
    </aside>
  )
}

const eyebrow: CSSProperties = {
  fontSize: 10.5,
  letterSpacing: 1.4,
  textTransform: 'uppercase',
  color: 'var(--muted-2)',
  fontWeight: 600
}
const ghostBtn: CSSProperties = {
  background: 'var(--card)',
  color: 'var(--text-2)',
  border: '1px solid var(--line)',
  borderRadius: 6,
  padding: '4px 10px',
  fontSize: 12,
  cursor: 'pointer'
}
