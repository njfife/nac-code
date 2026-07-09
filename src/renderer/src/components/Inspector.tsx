import { useState, type CSSProperties, type ReactNode } from 'react'
import { useApp, selectActiveChat, type Chat } from '../store/store'
import { PROVIDERS, STATUS_LABEL, STATUS_COLOR } from '../data/providers'
import { ITEMS_BY_ID, TYPE_META, type ItemType } from '../data/context'

const TYPE_ORDER: ItemType[] = ['skill', 'instruction', 'file']

// Live, present-tense session state (FR-10.x). Panels are independently collapsible.
export default function Inspector() {
  const active = useApp(selectActiveChat)
  const setView = useApp((s) => s.setView)
  const openModal = useApp((s) => s.openModal)
  const [reauthed, setReauthed] = useState<Record<string, boolean>>({})

  if (!active) {
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid var(--line)' }}>
          <span style={eyebrow}>Inspector</span>
        </div>
        <div style={{ padding: '16px 14px', fontSize: 12.5, color: 'var(--muted)' }}>No active chat</div>
      </aside>
    )
  }

  const pct = Math.min(100, Math.round((active.contextK / active.windowK) * 100))

  const counts: Record<ItemType, number> = { skill: 0, agent: 0, instruction: 0, file: 0 }
  for (const id of active.attachedIds) {
    const it = ITEMS_BY_ID[id]
    if (it) counts[it.type]++
  }

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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid var(--line)' }}>
        <span style={eyebrow}>Inspector</span>
        <button style={ghostBtn} onClick={() => openModal('stats')}>Stats</button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
        <Panel title="CLI Connections" defaultOpen>
          {PROVIDERS.map((p) => {
            const status = p.status === 'expired' && reauthed[p.id] ? 'authenticated' : p.status
            return (
              <Row key={p.id}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_COLOR[status] }} />
                  <span className="mono" style={{ color: 'var(--text-2)' }}>{p.id}</span>
                </span>
                {status === 'expired' ? (
                  <button style={miniBtn} onClick={() => setReauthed((r) => ({ ...r, [p.id]: true }))}>
                    Re-auth
                  </button>
                ) : (
                  <span style={{ fontSize: 11, color: STATUS_COLOR[status] }}>{STATUS_LABEL[status]}</span>
                )}
              </Row>
            )
          })}
        </Panel>

        <Panel title="MCP Servers">
          <div style={{ fontSize: 12, color: 'var(--faint)', padding: '4px 2px' }}>No MCP servers configured.</div>
        </Panel>

        <Panel title="Token & Cost" defaultOpen>
          <Row>
            <span style={lbl}>Tokens this session</span>
            <span className="mono" style={val}>{active.contextLive ? '' : '~'}{active.contextK}k</span>
          </Row>
          <Row>
            <span style={lbl}>Cost</span>
            <span className="mono" style={val}>{costFor(active)}</span>
          </Row>
        </Panel>

        <Panel title="Session" defaultOpen>
          <Row>
            <span style={lbl}>Model</span>
            <span className="mono" style={val}>{active.model}</span>
          </Row>
          <Row>
            <span style={lbl}>Effort</span>
            <span className="mono" style={val}>{active.effort ?? 'default'}</span>
          </Row>
          <Row>
            <span style={lbl}>Working dir</span>
            <span className="mono" style={{ ...val, fontSize: 11 }}>~/Code/nac-code</span>
          </Row>
          <div style={{ padding: '6px 2px 2px' }}>
            <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
              <span>Context window</span>
              <span>
                {active.contextK}K/{active.windowK}K ({pct}%)
              </span>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: 'var(--card-3)', overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)' }} />
            </div>
          </div>
        </Panel>

        <Panel title="Attached Context" defaultOpen>
          {TYPE_ORDER.map((t) => (
            <Row key={t}>
              <button onClick={() => setView('context')} style={attachRow}>
                <span style={{ ...tile, background: TYPE_META[t].color }}>{TYPE_META[t].letter}</span>
                <span style={lbl}>{TYPE_META[t].label}s</span>
              </button>
              <span className="mono" style={val}>{counts[t]}</span>
            </Row>
          ))}
        </Panel>
      </div>
    </aside>
  )
}

function Panel(props: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(props.defaultOpen ?? false)
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, margin: '4px 0' }}>
      <button onClick={() => setOpen(!open)} style={panelHeader}>
        <span style={eyebrowSm}>{props.title}</span>
        <span style={{ color: 'var(--faint)' }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && <div style={{ padding: '0 12px 8px' }}>{props.children}</div>}
    </div>
  )
}

function Row(props: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 0', fontSize: 12.5 }}>
      {props.children}
    </div>
  )
}

function costFor(chat: Chat): string {
  if (chat.provider === 'opencode') return 'free · local'
  const real = Object.values(chat.usage).reduce((sum, u) => sum + (u.costUsd ?? 0), 0)
  return real > 0 ? `$${real.toFixed(2)}` : '$0.42'
}

const eyebrow: CSSProperties = { fontSize: 10.5, letterSpacing: 1.4, textTransform: 'uppercase', color: 'var(--muted-2)', fontWeight: 600 }
const eyebrowSm: CSSProperties = { fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--muted-2)', fontWeight: 600 }
const ghostBtn: CSSProperties = { background: 'var(--card)', color: 'var(--text-2)', border: '1px solid var(--line)', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }
const panelHeader: CSSProperties = { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', background: 'transparent', border: 'none', cursor: 'pointer' }
const miniBtn: CSSProperties = { background: 'var(--accent-tint-3)', color: 'var(--accent-light)', border: 'none', borderRadius: 5, padding: '2px 8px', fontSize: 11, cursor: 'pointer' }
const attachRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }
const tile: CSSProperties = { width: 14, height: 14, borderRadius: 4, color: '#0c0c0f', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }
const lbl: CSSProperties = { color: 'var(--muted)' }
const val: CSSProperties = { color: 'var(--text-2)' }
