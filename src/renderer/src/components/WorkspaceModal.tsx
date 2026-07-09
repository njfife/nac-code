import { useEffect, type CSSProperties } from 'react'
import { useApp } from '../store/store'
import { PROVIDERS } from '../data/providers'
import { STATIC_CAPABILITIES } from '../../../shared/capabilities'

// Per-workspace defaults (M0-4): provider/model that new chats in this workspace inherit.
export default function WorkspaceModal() {
  const wsId = useApp((s) => s.wsModalId)
  const ws = useApp((s) => s.workspaces.find((w) => w.id === s.wsModalId))
  const setDefaults = useApp((s) => s.setWorkspaceDefaults)
  const close = useApp((s) => s.closeModal)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  if (!ws || !wsId) return null
  const d = ws.defaults
  const hasDefaults = Boolean(d && d.provider)

  return (
    <div onClick={close} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={card}>
        <div style={modalHeader}>
          <span style={{ fontWeight: 600 }}>
            Workspace defaults · <span className="mono">{ws.name}</span>
          </span>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }}>new chats here inherit these</span>
          <button onClick={close} style={closeBtn} aria-label="Close">
            ✕
          </button>
        </div>

        <div style={{ overflow: 'auto' }}>
          <div style={sectionLabel}>Default model</div>
          {PROVIDERS.map((p) => (
            <div key={p.id} style={{ padding: '6px 16px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.dot }} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {/* Account default chip — always present (selectable even when no static models exist) */}
                {(() => {
                  const isDefault = d?.provider === p.id && d?.model === 'Account default'
                  return (
                    <button
                      className="mono"
                      onClick={() => setDefaults(wsId, { provider: p.id, model: 'Account default' })}
                      style={{
                        ...chip,
                        background: isDefault ? 'var(--accent-tint-3)' : 'var(--card)',
                        color: isDefault ? 'var(--text)' : 'var(--text-2)',
                        borderColor: isDefault ? 'var(--accent)' : 'var(--line)'
                      }}
                    >
                      Account default
                    </button>
                  )
                })()}
                {(STATIC_CAPABILITIES[p.id]?.models ?? []).map((m) => {
                  const isDefault = d?.provider === p.id && d?.model === m.label
                  return (
                    <button
                      key={m.id}
                      className="mono"
                      onClick={() => setDefaults(wsId, { provider: p.id, model: m.label })}
                      style={{
                        ...chip,
                        background: isDefault ? 'var(--accent-tint-3)' : 'var(--card)',
                        color: isDefault ? 'var(--text)' : 'var(--text-2)',
                        borderColor: isDefault ? 'var(--accent)' : 'var(--line)'
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
            <button onClick={() => setDefaults(wsId, null)} disabled={!hasDefaults} style={{ ...clearBtn, opacity: hasDefaults ? 1 : 0.4, cursor: hasDefaults ? 'pointer' : 'default' }}>
              Clear defaults — use active-chat inheritance
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const backdrop: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }
const card: CSSProperties = { width: 480, maxWidth: '90vw', maxHeight: '78vh', display: 'flex', flexDirection: 'column', background: 'var(--panel)', border: '1px solid var(--line-2)', borderRadius: 16, boxShadow: '0 30px 90px rgba(0,0,0,.6)', overflow: 'hidden' }
const modalHeader: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--line)' }
const sectionLabel: CSSProperties = { fontSize: 10.5, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--muted-2)', fontWeight: 600, padding: '12px 16px 4px' }
const closeBtn: CSSProperties = { background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14 }
const chip: CSSProperties = { border: '1px solid var(--line)', borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer' }
const clearBtn: CSSProperties = { background: 'transparent', border: '1px dashed var(--line-2)', color: 'var(--text-2)', borderRadius: 8, padding: '8px 12px', fontSize: 12.5, width: '100%' }
