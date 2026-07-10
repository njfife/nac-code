import { useEffect, useState, type CSSProperties } from 'react'
import { useApp, type Layout } from '../store/store'

interface Cmd {
  id: string
  group: string
  label: string
  run: () => void
}

// Command palette (FR-14): fuzzy search across Chats / Actions / Layouts; ↑↓ to move, ↵ to run, esc to close.
export default function CommandPalette() {
  const chats = useApp((s) => s.chats)
  const selectChat = useApp((s) => s.selectChat)
  const setView = useApp((s) => s.setView)
  const setLayout = useApp((s) => s.setLayout)
  const openModal = useApp((s) => s.openModal)
  const setPalette = useApp((s) => s.setPalette)
  const newChat = useApp((s) => s.newChat)

  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)

  const close = (): void => setPalette(false)

  const commands: Cmd[] = []
  for (const c of Object.values(chats)) {
    commands.push({ id: `chat-${c.id}`, group: 'Chats', label: c.title, run: () => { selectChat(c.id); setView('chat'); close() } })
  }
  commands.push({ id: 'a-context', group: 'Actions', label: 'Open Context Library', run: () => { setView('context'); close() } })
  commands.push({ id: 'a-model', group: 'Actions', label: 'Model & provider…', run: () => { openModal('model'); close() } })
  commands.push({ id: 'a-new', group: 'Actions', label: 'New chat', run: () => { newChat(); close() } })
  for (const l of ['studio', 'cockpit', 'focus'] as Layout[]) {
    commands.push({ id: `lay-${l}`, group: 'Layouts', label: `Layout: ${l[0].toUpperCase()}${l.slice(1)}`, run: () => { setLayout(l); close() } })
  }

  const q = query.trim().toLowerCase()
  const filtered = q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands
  const clampedSel = Math.min(sel, Math.max(0, filtered.length - 1))

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        close()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSel((s) => Math.min(s + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((s) => Math.max(s - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        filtered[clampedSel]?.run()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // group filtered, tracking the flat index for highlight
  const groups: { name: string; items: { cmd: Cmd; index: number }[] }[] = []
  filtered.forEach((cmd, index) => {
    let g = groups.find((x) => x.name === cmd.group)
    if (!g) {
      g = { name: cmd.group, items: [] }
      groups.push(g)
    }
    g.items.push({ cmd, index })
  })

  return (
    <div onClick={close} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={card}>
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSel(0)
          }}
          placeholder="Search chats, actions, layouts…"
          style={input}
        />
        <div style={{ maxHeight: 360, overflow: 'auto', padding: 6 }}>
          {filtered.length === 0 && <div style={{ padding: 16, color: 'var(--faint)', fontSize: 13 }}>No matches.</div>}
          {groups.map((g) => (
            <div key={g.name}>
              <div style={groupLabel}>{g.name}</div>
              {g.items.map(({ cmd, index }) => (
                <div
                  key={cmd.id}
                  onMouseEnter={() => setSel(index)}
                  onClick={() => cmd.run()}
                  style={{ ...rowStyle, background: index === clampedSel ? 'var(--accent-tint)' : 'transparent' }}
                >
                  {cmd.label}
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="mono" style={footer}>↑↓ navigate · ↵ run · esc close</div>
      </div>
    </div>
  )
}

const backdrop: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '12vh', zIndex: 200 }
const card: CSSProperties = { width: 560, maxWidth: '90vw', display: 'flex', flexDirection: 'column', background: 'var(--panel)', border: '1px solid var(--line-2)', borderRadius: 14, boxShadow: '0 30px 90px rgba(0,0,0,.6)', overflow: 'hidden' }
const input: CSSProperties = { background: 'transparent', border: 'none', borderBottom: '1px solid var(--line)', padding: '14px 16px', color: 'var(--text)', fontSize: 14, outline: 'none' }
const groupLabel: CSSProperties = { fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--muted-2)', fontWeight: 600, padding: '8px 10px 4px' }
const rowStyle: CSSProperties = { padding: '8px 10px', borderRadius: 8, fontSize: 13, color: 'var(--text-2)', cursor: 'pointer' }
const footer: CSSProperties = { borderTop: '1px solid var(--line)', padding: '8px 14px', fontSize: 11, color: 'var(--faint)' }
