import { useState, type CSSProperties } from 'react'
import type { ToolRow as ToolRowData } from '../store/store'

const GLYPH: Record<ToolRowData['status'], string> = { pending: '·', running: '⟳', completed: '✓', failed: '✗' }
const GLYPH_COLOR: Record<ToolRowData['status'], string> = { pending: 'var(--muted)', running: 'var(--accent-light)', completed: 'var(--success)', failed: 'var(--error)' }

export default function ToolRow(props: { tool: ToolRowData }) {
  const [open, setOpen] = useState(false)
  const t = props.tool
  return (
    <div style={{ margin: '4px 0' }}>
      <button onClick={() => setOpen(!open)} style={row}>
        <span style={{ color: GLYPH_COLOR[t.status], width: 14, display: 'inline-block' }}>{GLYPH[t.status]}</span>
        <span className="mono" style={{ fontSize: 12, color: 'var(--text-2)' }}>{t.title}</span>
        {t.detail && <span style={{ marginLeft: 'auto', color: 'var(--faint)', fontSize: 11 }}>{open ? '▾' : '▸'}</span>}
      </button>
      {open && t.detail && (
        <pre className="mono" style={detailBox}>{t.detail}</pre>
      )}
    </div>
  )
}

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', textAlign: 'left' }
const detailBox: CSSProperties = { margin: '2px 0 0 22px', padding: '6px 10px', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 6, fontSize: 11, color: 'var(--muted)', whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }
