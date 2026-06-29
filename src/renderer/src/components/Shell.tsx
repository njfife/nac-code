import type { CSSProperties } from 'react'
import ChatView from './ChatView'

const WORKSPACE = 'nac-code'
const ACCOUNT = '@nfife_fontfife'

// The persistent application frame: top bar (46) / body (left rail · center · inspector) / status bar (28).
// Whole shell holds a 1180px minimum and scrolls horizontally below it — panes never collapse (FR-1.5 / NFR-4).
export default function Shell() {
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
        <Inspector />
      </div>
      <StatusBar />
    </div>
  )
}

function TopBar() {
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
        NAC Code <span style={{ color: 'var(--faint)' }}>/ {WORKSPACE}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div
          style={{
            display: 'flex',
            background: 'var(--card)',
            borderRadius: 8,
            padding: 2,
            border: '1px solid var(--line)'
          }}
        >
          {['Studio', 'Cockpit', 'Focus'].map((m, i) => (
            <span
              key={m}
              style={{
                fontSize: 12,
                padding: '3px 10px',
                borderRadius: 6,
                color: i === 0 ? 'var(--text)' : 'var(--muted)',
                background: i === 0 ? 'var(--accent-tint-3)' : 'transparent'
              }}
            >
              {m}
            </span>
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
      <span style={{ marginLeft: 'auto' }}>5 attached · ~12k / 128K tokens</span>
      <span>Version 0.10.0</span>
    </footer>
  )
}

// Placeholder panes — structure + tokens now; fleshed out in later M1 chunks.
function LeftRail() {
  return (
    <aside
      style={{
        width: 'var(--rail-w)',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--panel-2)',
        borderRight: '1px solid var(--line)'
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
        <span style={eyebrow}>Chat History</span>
        <button style={ghostBtn}>+ New Chat</button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
        <div style={{ padding: '6px 8px', fontSize: 12, color: 'var(--text-2)', fontWeight: 600 }} className="mono">
          ▾ nac-code <span style={{ color: 'var(--faint)' }}>2</span>
        </div>
        <ChatRow title="M0-7 scaffold + tracer" time="now" model="claude" active />
        <ChatRow title="Cross-provider spike" time="1h" model="lmstudio" />
      </div>
      <div className="mono" style={{ padding: '10px 14px', borderTop: '1px solid var(--line)', fontSize: 12, color: 'var(--muted)' }}>
        {ACCOUNT}
      </div>
    </aside>
  )
}

function ChatRow(props: { title: string; time: string; model: string; active?: boolean }) {
  return (
    <div
      style={{
        padding: '8px 10px',
        margin: '2px 0',
        borderRadius: 8,
        background: props.active ? 'var(--accent-tint)' : 'transparent',
        boxShadow: props.active ? 'inset 0 0 0 1px var(--line-2)' : 'none',
        borderLeft: props.active ? '2.5px solid var(--accent)' : '2.5px solid transparent',
        cursor: 'pointer'
      }}
    >
      <div style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {props.title}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 3, fontSize: 11, color: 'var(--muted)' }} className="mono">
        <span>{props.time}</span>
        <span style={{ color: 'var(--accent-light)' }}>{props.model}</span>
      </div>
    </div>
  )
}

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
