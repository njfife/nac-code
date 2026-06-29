import type { CSSProperties } from 'react'
import { useApp, chatsForWorkspace, type Chat } from '../store/store'

const ACCOUNT = '@you'

export default function LeftRail() {
  const workspaces = useApp((s) => s.workspaces)
  const chats = useApp((s) => s.chats)
  const expanded = useApp((s) => s.expanded)
  const activeChatId = useApp((s) => s.activeChatId)
  const selectChat = useApp((s) => s.selectChat)
  const toggleWorkspace = useApp((s) => s.toggleWorkspace)
  const newChat = useApp((s) => s.newChat)
  const addWorkspace = useApp((s) => s.addWorkspace)
  const removeWorkspace = useApp((s) => s.removeWorkspace)
  const openWorkspaceModal = useApp((s) => s.openWorkspaceModal)

  const onAddWorkspace = async (): Promise<void> => {
    const picked = await window.nac?.dialog?.pickDirectory()
    if (picked) addWorkspace(picked.name, picked.path)
  }

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
        <div style={{ display: 'flex', gap: 6 }}>
          <button style={ghostBtn} onClick={onAddWorkspace} title="Add a workspace folder">+ Workspace</button>
          <button style={ghostBtn} onClick={() => newChat()}>+ Chat</button>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
        {workspaces.map((ws) => {
          const list = chatsForWorkspace(chats, ws.id)
          const open = expanded[ws.id]
          return (
            <div key={ws.id} style={{ marginBottom: 4 }}>
              <div style={wsRow}>
                <button onClick={() => toggleWorkspace(ws.id)} style={wsHeader}>
                  <span style={{ color: 'var(--faint)', width: 12 }}>{open ? '▾' : '▸'}</span>
                  <span className="mono" style={{ color: 'var(--text-2)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ws.name}
                  </span>
                  <span style={countPill}>{list.length}</span>
                </button>
                <button title="New chat in this workspace" onClick={() => newChat(ws.id)} style={iconBtn}>
                  +
                </button>
                <button
                  title={ws.defaults ? 'Workspace defaults (set)' : 'Workspace defaults'}
                  onClick={() => openWorkspaceModal(ws.id)}
                  style={{ ...iconBtn, color: ws.defaults ? 'var(--accent-light)' : 'var(--faint)' }}
                >
                  ⚙
                </button>
                {list.length === 0 && (
                  <button title="Remove empty workspace" onClick={() => removeWorkspace(ws.id)} style={iconBtn}>
                    ✕
                  </button>
                )}
              </div>
              {open && ws.path && (
                <div className="mono" style={wsPath} title={ws.path}>
                  {ws.path}
                </div>
              )}
              {open &&
                list.map((c) => (
                  <ChatRow key={c.id} chat={c} active={c.id === activeChatId} onSelect={() => selectChat(c.id)} />
                ))}
            </div>
          )
        })}
      </div>

      <div className="mono" style={{ padding: '10px 14px', borderTop: '1px solid var(--line)', fontSize: 12, color: 'var(--muted)' }}>
        {ACCOUNT}
      </div>
    </aside>
  )
}

function ChatRow(props: { chat: Chat; active: boolean; onSelect: () => void }) {
  const { chat, active } = props
  return (
    <div
      onClick={props.onSelect}
      style={{
        padding: '8px 10px',
        margin: '2px 0 2px 6px',
        borderRadius: 8,
        background: active ? 'var(--accent-tint)' : 'transparent',
        boxShadow: active ? 'inset 0 0 0 1px var(--line-2)' : 'none',
        borderLeft: active ? '2.5px solid var(--accent)' : '2.5px solid transparent',
        cursor: 'pointer'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {chat.branchedFrom && <span style={{ color: 'var(--accent-light)', fontSize: 11 }}>⑂</span>}
        <span style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {chat.title}
        </span>
        {chat.dirty && <span title="modified" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warning)', flexShrink: 0 }} />}
      </div>
      <div className="mono" style={{ display: 'flex', gap: 8, marginTop: 3, fontSize: 11, color: 'var(--muted)' }}>
        <span>{chat.time}</span>
        <span style={{ color: 'var(--accent-light)' }}>{chat.model}</span>
      </div>
    </div>
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
const wsRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center'
}
const wsHeader: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 8px',
  background: 'transparent',
  border: 'none',
  fontSize: 12.5,
  cursor: 'pointer'
}
const iconBtn: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--faint)',
  fontSize: 11,
  padding: '0 6px',
  cursor: 'pointer',
  flexShrink: 0
}
const wsPath: CSSProperties = {
  fontSize: 10.5,
  color: 'var(--muted)',
  padding: '0 8px 5px 26px',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis'
}
const countPill: CSSProperties = {
  marginLeft: 'auto',
  fontSize: 10.5,
  color: 'var(--faint)',
  background: 'var(--card)',
  borderRadius: 5,
  padding: '0 6px'
}
