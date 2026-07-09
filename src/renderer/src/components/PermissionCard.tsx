import { type CSSProperties } from 'react'
import type { PermissionCard as CardData } from '../store/store'

export default function PermissionCard(props: { card: CardData; onRespond: (optionId: string) => void }) {
  const c = props.card
  if (c.resolvedOptionId) {
    const chosen = c.options.find((o) => o.id === c.resolvedOptionId)
    const label = c.resolvedOptionId === 'stale' ? '· expired' : chosen ? `${chosen.kind === 'deny' ? '✗' : '✓'} ${chosen.label}` : `· ${c.resolvedOptionId}`
    return (
      <div style={{ ...resolvedLine }}>
        {label} — {c.title}
      </div>
    )
  }
  return (
    <div style={card}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{c.title}</div>
      {c.detail && <pre className="mono" style={detail}>{c.detail}</pre>}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        {c.options.map((o) => (
          <button key={o.id} onClick={() => props.onRespond(o.id)} style={{ ...btn, ...(o.kind === 'deny' ? denyBtn : {}) }}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

const card: CSSProperties = { margin: '6px 0', padding: '10px 12px', background: 'var(--card)', border: '1px solid var(--warning)', borderRadius: 8 }
const detail: CSSProperties = { margin: '4px 0 0', padding: '6px 10px', background: 'var(--card-3, var(--panel))', borderRadius: 6, fontSize: 11.5, color: 'var(--text-2)', whiteSpace: 'pre-wrap' }
const btn: CSSProperties = { background: 'var(--accent-tint-3)', color: 'var(--accent-light)', border: '1px solid var(--accent)', borderRadius: 6, padding: '4px 12px', fontSize: 12, cursor: 'pointer' }
const denyBtn: CSSProperties = { background: 'var(--card)', color: 'var(--muted)', border: '1px solid var(--line-2)' }
const resolvedLine: CSSProperties = { margin: '4px 0', fontSize: 11.5, color: 'var(--muted)' }
