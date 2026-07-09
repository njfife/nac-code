import { useEffect, type CSSProperties } from 'react'
import { useApp, selectActiveChat } from '../store/store'
import { CONTEXT_ITEMS } from '../data/context'

const AGENTS = CONTEXT_ITEMS.filter((i) => i.type === 'agent')

// Agent picker (FR-8.1). Selecting an agent applies to the ACTIVE chat only; links into the library.
export default function AgentModal() {
  const active = useApp(selectActiveChat)
  const setAgent = useApp((s) => s.setAgent)
  const setView = useApp((s) => s.setView)
  const close = useApp((s) => s.closeModal)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  function pick(name: string | null): void {
    setAgent(name)
    close()
  }

  return (
    <div onClick={close} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={card}>
        <div style={header}>
          <span style={{ fontWeight: 600 }}>Agent</span>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }}>applies to this chat only</span>
        </div>
        <div style={{ overflow: 'auto' }}>
          <Row name="No agent" role="Default — no agent persona" active={(active?.agent ?? null) === null} onClick={() => pick(null)} />
          {AGENTS.map((a) => (
            <Row key={a.id} name={a.name} role={a.description} active={active?.agent === a.name} onClick={() => pick(a.name)} />
          ))}
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--line)' }}>
            <button
              onClick={() => {
                setView('context')
                close()
              }}
              style={browseBtn}
            >
              Browse all agents →
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Row(props: { name: string; role: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={props.onClick} style={{ ...row, background: props.active ? 'var(--accent-tint)' : 'transparent' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: props.active ? 'var(--accent)' : 'var(--card-3)', marginTop: 5, flexShrink: 0 }} />
      <span style={{ textAlign: 'left' }}>
        <span className="mono" style={{ fontSize: 13, color: 'var(--text)', display: 'block' }}>{props.name}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{props.role}</span>
      </span>
    </button>
  )
}

const backdrop: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }
const card: CSSProperties = { width: 440, maxWidth: '90vw', maxHeight: '74vh', display: 'flex', flexDirection: 'column', background: 'var(--panel)', border: '1px solid var(--line-2)', borderRadius: 16, boxShadow: '0 30px 90px rgba(0,0,0,.6)', overflow: 'hidden' }
const header: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--line)' }
const row: CSSProperties = { display: 'flex', gap: 10, width: '100%', padding: '10px 16px', background: 'transparent', border: 'none', cursor: 'pointer' }
const browseBtn: CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent-light)', fontSize: 12.5, cursor: 'pointer', padding: 0 }
