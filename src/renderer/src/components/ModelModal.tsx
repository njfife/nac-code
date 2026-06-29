import { useEffect, useState, type CSSProperties } from 'react'
import { useApp, selectActiveChat } from '../store/store'
import { PROVIDERS, STATUS_LABEL, STATUS_COLOR, type ModelDef } from '../data/providers'

// Model & provider modal (FR-7.1). Selecting a model applies to the ACTIVE chat only (FR-7.4).
export default function ModelModal() {
  const active = useApp(selectActiveChat)
  const setModel = useApp((s) => s.setModel)
  const close = useApp((s) => s.closeModal)
  const [discovered, setDiscovered] = useState<Record<string, ModelDef[]>>({})

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  // Live model discovery (OpenCode reflects the account's real configured models); falls back to static.
  useEffect(() => {
    let live = true
    window.nac?.models
      ?.discover('opencode')
      .then((ids) => {
        if (live && ids.length) setDiscovered({ opencode: ids.map((id) => ({ id, label: id })) })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  function pick(provider: string, model: string): void {
    setModel(provider, model)
    close()
  }

  return (
    <div onClick={close} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={card}>
        <div style={modalHeader}>
          <span style={{ fontWeight: 600 }}>Model &amp; provider</span>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }}>applies to this chat only</span>
          <button onClick={close} style={closeBtn} aria-label="Close">
            ✕
          </button>
        </div>

        <div style={{ overflow: 'auto' }}>
          {PROVIDERS.map((p) => (
            <div key={p.id} style={{ padding: '10px 16px', borderTop: '1px solid var(--line)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.dot }} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</span>
                <span style={{ fontSize: 11, color: STATUS_COLOR[p.status] }}>{STATUS_LABEL[p.status]}</span>
                <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--faint)' }}>{p.detail}</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {(discovered[p.id] ?? p.models).map((m) => {
                  const isActive = active.provider === p.id && active.model === m.label
                  return (
                    <button
                      key={m.id}
                      onClick={() => pick(p.id, m.label)}
                      className="mono"
                      style={{
                        ...modelChip,
                        background: isActive ? 'var(--accent-tint-3)' : 'var(--card)',
                        color: isActive ? 'var(--text)' : 'var(--text-2)',
                        borderColor: isActive ? 'var(--accent)' : 'var(--line)'
                      }}
                    >
                      {m.label}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--line)' }}>
            <button style={connectBtn}>+ Connect a provider…</button>
          </div>
        </div>
      </div>
    </div>
  )
}

const backdrop: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100
}
const card: CSSProperties = {
  width: 480,
  maxWidth: '90vw',
  maxHeight: '74vh',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--panel)',
  border: '1px solid var(--line-2)',
  borderRadius: 16,
  boxShadow: '0 30px 90px rgba(0,0,0,.6)',
  overflow: 'hidden'
}
const modalHeader: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px' }
const closeBtn: CSSProperties = { background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14 }
const modelChip: CSSProperties = { border: '1px solid var(--line)', borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer' }
const connectBtn: CSSProperties = { background: 'transparent', border: '1px dashed var(--line-2)', color: 'var(--accent-light)', borderRadius: 8, padding: '8px 12px', fontSize: 12.5, cursor: 'pointer', width: '100%' }
