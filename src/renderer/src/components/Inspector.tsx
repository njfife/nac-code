import { useState, type CSSProperties, type ReactNode } from 'react'
import { useApp, selectActiveChat } from '../store/store'
import { PROVIDERS, STATUS_LABEL, STATUS_COLOR } from '../data/providers'

// Live, present-tense session state (FR-10.x). Panels are independently collapsible.
export default function Inspector() {
  const active = useApp(selectActiveChat)
  const [reauthed, setReauthed] = useState<Record<string, boolean>>({})
  const pct = Math.min(100, Math.round((active.contextK / active.windowK) * 100))

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
        <button style={ghostBtn}>Stats</button>
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
            <span className="mono" style={val}>~{active.contextK}k</span>
          </Row>
          <Row>
            <span style={lbl}>Cost</span>
            <span className="mono" style={val}>{costLabel(active.provider)}</span>
          </Row>
        </Panel>

        <Panel title="Session" defaultOpen>
          <Row>
            <span style={lbl}>Model</span>
            <span className="mono" style={val}>{active.model}</span>
          </Row>
          <Row>
            <span style={lbl}>Thinking</span>
            <span className="mono" style={val}>Medium</span>
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
          {attachedSplit(active.attached).map(([type, n, color]) => (
            <Row key={type}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 14, height: 14, borderRadius: 4, background: color, color: '#0c0c0f', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {type[0]}
                </span>
                <span style={lbl}>{type}</span>
              </span>
              <span className="mono" style={val}>{n}</span>
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

function costLabel(provider: string): string {
  return provider === 'opencode' ? 'free · local' : '$0.42'
}

function attachedSplit(total: number): [string, number, string][] {
  const skills = Math.min(total, 2)
  const agents = total > 2 ? 1 : 0
  const instructions = total > 3 ? 1 : 0
  const files = Math.max(0, total - skills - agents - instructions)
  return [
    ['Skills', skills, 'var(--type-skill)'],
    ['Agents', agents, 'var(--type-agent)'],
    ['Instructions', instructions, 'var(--type-instruction)'],
    ['Files', files, 'var(--type-file)']
  ]
}

const eyebrow: CSSProperties = { fontSize: 10.5, letterSpacing: 1.4, textTransform: 'uppercase', color: 'var(--muted-2)', fontWeight: 600 }
const eyebrowSm: CSSProperties = { fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--muted-2)', fontWeight: 600 }
const ghostBtn: CSSProperties = { background: 'var(--card)', color: 'var(--text-2)', border: '1px solid var(--line)', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }
const panelHeader: CSSProperties = { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', background: 'transparent', border: 'none', cursor: 'pointer' }
const miniBtn: CSSProperties = { background: 'var(--accent-tint-3)', color: 'var(--accent-light)', border: 'none', borderRadius: 5, padding: '2px 8px', fontSize: 11, cursor: 'pointer' }
const lbl: CSSProperties = { color: 'var(--muted)' }
const val: CSSProperties = { color: 'var(--text-2)' }
