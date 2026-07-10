import { useState, type CSSProperties } from 'react'
import { useApp, selectActiveChat, contextPending } from '../store/store'
import { CONTEXT_ITEMS, ITEMS_BY_ID, TYPE_META, budgetColor, type ItemType, type ContextItem } from '../data/context'

type Category = 'attached' | ItemType

// Full-screen Context Library route (FR-5): category nav · list · detail panel, with a budget meter.
export default function ContextLibrary() {
  const active = useApp(selectActiveChat)
  const setView = useApp((s) => s.setView)
  const toggleAttach = useApp((s) => s.toggleAttach)
  const userItems = useApp((s) => s.userItems)
  const addNote = useApp((s) => s.addNote)
  const updateNote = useApp((s) => s.updateNote)
  const addFileItem = useApp((s) => s.addFileItem)
  const removeUserItem = useApp((s) => s.removeUserItem)
  const reseedContext = useApp((s) => s.reseedContext)

  const allItems: ContextItem[] = [...userItems, ...CONTEXT_ITEMS]
  const byId = (id: string): ContextItem | undefined => userItems.find((u) => u.id === id) ?? ITEMS_BY_ID[id]
  const attachedIds = active?.attachedIds ?? [] // tolerate no active chat (empty install, or reached via ⌘K/cockpit rail)

  const [category, setCategory] = useState<Category>('attached')
  const [query, setQuery] = useState('')
  const [attachedOnly, setAttachedOnly] = useState(false)
  const [selectedId, setSelectedId] = useState<string>(attachedIds[0] ?? CONTEXT_ITEMS[0].id)
  const [noteForm, setNoteForm] = useState<{ name: string; content: string; editingId?: string } | null>(null)

  const attached = new Set(attachedIds)
  const attachedTokens = attachedIds.reduce((sum, id) => sum + (byId(id)?.tokens ?? 0), 0)
  const windowTokens = (active?.windowK ?? 128) * 1000
  const pct = Math.min(100, Math.round((attachedTokens / windowTokens) * 100))
  const pending = active ? contextPending(active, userItems) : false

  const onAddFile = async (): Promise<void> => {
    const picked = await window.nac?.dialog?.pickFile()
    if (picked) addFileItem(picked.name, picked.path)
  }

  const q = query.trim().toLowerCase()
  const list = allItems.filter((it) => {
    if (category === 'attached' ? !attached.has(it.id) : it.type !== category) return false
    if (attachedOnly && !attached.has(it.id)) return false
    if (q && !`${it.name} ${it.description} ${it.tags.join(' ')}`.toLowerCase().includes(q)) return false
    return true
  })

  const typeCount = (t: ItemType): number => allItems.filter((i) => i.type === t).length
  const selected = byId(selectedId)

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--app-bg)' }}>
      {/* Header */}
      <div style={{ height: 'var(--topbar-h)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 14, padding: '0 16px', borderBottom: '1px solid var(--line)' }}>
        <button onClick={() => setView('chat')} style={backBtn}>← Back</button>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Context Library</span>
        <div style={{ marginLeft: 'auto', width: 230 }}>
          <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
            <span>Context budget · {attachedIds.length} items</span>
            <span>~{(attachedTokens / 1000).toFixed(1)}k / {(windowTokens / 1000).toFixed(0)}k tok</span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: 'var(--card-3)', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: budgetColor(attachedTokens, windowTokens), transition: 'width .2s, background .2s' }} />
          </div>
        </div>
      </div>

      {pending && (
        <div style={pendingBanner}>
          <span>⚠ Attached context changed — it applies on your next message in this chat (sessions are seeded once for speed).</span>
          <button
            onClick={() => active && reseedContext(active.id)}
            title="starts a fresh harness session; in-session state is lost"
            style={pendingApply}
          >
            Re-seed fresh session
          </button>
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Category nav */}
        <nav style={{ width: 240, flexShrink: 0, borderRight: '1px solid var(--line)', padding: 8, display: 'flex', flexDirection: 'column' }}>
          <CatBtn label="★ Attached to chat" active={category === 'attached'} count={attachedIds.length} onClick={() => setCategory('attached')} />
          {(['skill', 'agent', 'instruction', 'file'] as ItemType[]).map((t) => (
            <CatBtn key={t} label={`${TYPE_META[t].label}s`} active={category === t} count={typeCount(t)} onClick={() => setCategory(t)} />
          ))}
          <div style={{ marginTop: 'auto', display: 'flex', gap: 6 }}>
            <button style={importBtn} onClick={() => setNoteForm({ name: '', content: '' })}>+ Note</button>
            <button style={importBtn} onClick={onAddFile}>+ File</button>
          </div>
        </nav>

        {/* List */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search context…"
              style={{ flex: 1, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 12px', color: 'var(--text)', fontSize: 13 }}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }}>
              <input type="checkbox" checked={attachedOnly} onChange={(e) => setAttachedOnly(e.target.checked)} />
              Attached only
            </label>
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
            {list.length === 0 && <div style={{ padding: 24, color: 'var(--faint)', fontSize: 13 }}>No items match.</div>}
            {list.map((it) => {
              const isAttached = attached.has(it.id)
              return (
                <div
                  key={it.id}
                  onClick={() => setSelectedId(it.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '10px 12px',
                    borderRadius: 8,
                    cursor: 'pointer',
                    background: selectedId === it.id ? 'var(--accent-tint)' : 'transparent'
                  }}
                >
                  <span style={{ ...tile, background: TYPE_META[it.type].color }}>{TYPE_META[it.type].letter}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <span className="mono" style={{ fontSize: 13, color: 'var(--text)' }}>{it.name}</span>
                      <span style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: 'uppercase', color: TYPE_META[it.type].color }}>{TYPE_META[it.type].label}</span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.description}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {it.fileState && (
                      <span style={{ fontSize: 9.5, letterSpacing: 0.5, textTransform: 'uppercase', padding: '2px 6px', borderRadius: 4, background: 'rgba(227,178,95,.15)', color: 'var(--warning)', fontWeight: 600 }}>
                        {it.fileState === 'toolarge' ? 'too large' : it.fileState}
                      </span>
                    )}
                    <span className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>~{it.tokens}t</span>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleAttach(it.id)
                    }}
                    style={isAttached ? attachedBtn : attachBtn}
                  >
                    {isAttached ? 'Attached' : 'Attach'}
                  </button>
                </div>
              )
            })}
          </div>
        </div>

        {/* Detail panel */}
        <aside style={{ width: 340, flexShrink: 0, borderLeft: '1px solid var(--line)', padding: 18, overflow: 'auto' }}>
          {selected && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <span style={{ ...tile, width: 22, height: 22, fontSize: 12, background: TYPE_META[selected.type].color }}>{TYPE_META[selected.type].letter}</span>
                <span className="mono" style={{ fontSize: 14, color: 'var(--text)' }}>{selected.name}</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted-2)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>{TYPE_META[selected.type].label}</div>
              <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6 }}>{selected.description}</p>
              <button onClick={() => toggleAttach(selected.id)} style={{ ...(attached.has(selected.id) ? attachedBtn : attachBtn), width: '100%', padding: '8px', margin: '8px 0 16px' }}>
                {attached.has(selected.id) ? 'Detach from chat' : 'Attach to chat'}
              </button>
              <Detail label="Type" value={TYPE_META[selected.type].label} />
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 12.5, borderBottom: '1px solid var(--line)', alignItems: 'center' }}>
                <span style={{ color: 'var(--muted)' }}>Size</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {selected.fileState && (
                    <span style={{ fontSize: 9.5, letterSpacing: 0.5, textTransform: 'uppercase', padding: '2px 6px', borderRadius: 4, background: 'rgba(227,178,95,.15)', color: 'var(--warning)', fontWeight: 600 }}>
                      {selected.fileState === 'toolarge' ? 'too large' : selected.fileState}
                    </span>
                  )}
                  <span className="mono" style={{ color: 'var(--text-2)' }}>~{selected.tokens} tokens</span>
                </div>
              </div>
              <Detail label="Source" value={selected.source} />
              <div style={{ fontSize: 11, color: 'var(--muted-2)', textTransform: 'uppercase', letterSpacing: 1, margin: '16px 0 6px' }}>Scope</div>
              <div style={{ display: 'flex', background: 'var(--card)', borderRadius: 8, padding: 2, border: '1px solid var(--line)' }}>
                {(['workspace', 'global'] as const).map((sc) => (
                  <span key={sc} style={{ flex: 1, textAlign: 'center', fontSize: 12, padding: '4px 0', borderRadius: 6, color: selected.scope === sc ? 'var(--text)' : 'var(--muted)', background: selected.scope === sc ? 'var(--accent-tint-3)' : 'transparent' }}>
                    {sc}
                  </span>
                ))}
              </div>
              {selected.content && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 11, color: 'var(--muted-2)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Content</div>
                  <div className="mono" style={{ fontSize: 12, color: 'var(--text-3)', background: 'var(--code-bg)', borderRadius: 8, padding: 10, whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>{selected.content}</div>
                </div>
              )}
              <div style={{ fontSize: 11.5, color: selected.content || selected.path ? 'var(--success)' : 'var(--faint)', marginTop: 10 }}>
                {selected.content || selected.path ? '✓ Injected into the agent context when attached' : 'Display-only (no content)'}
              </div>
              {selected.user && (
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  {selected.type === 'instruction' && (
                    <button
                      onClick={() => setNoteForm({ name: selected.name, content: selected.content ?? '', editingId: selected.id })}
                      style={{ ...attachBtn, flex: 1, padding: 8 }}
                    >
                      Edit
                    </button>
                  )}
                  <button
                    onClick={() => { removeUserItem(selected.id); setSelectedId(CONTEXT_ITEMS[0].id) }}
                    style={{ ...attachBtn, flex: 1, padding: 8, color: 'var(--error)', borderColor: 'var(--error)' }}
                  >
                    Delete item
                  </button>
                </div>
              )}
            </>
          )}
        </aside>
      </div>

      {noteForm && (
        <div onClick={() => setNoteForm(null)} style={noteBackdrop}>
          <div onClick={(e) => e.stopPropagation()} style={noteCard}>
            <div style={{ fontWeight: 600, marginBottom: 10 }}>{noteForm.editingId ? 'Edit note' : 'New note'}</div>
            <input autoFocus value={noteForm.name} onChange={(e) => setNoteForm({ ...noteForm, name: e.target.value })} placeholder="Name (e.g. api-conventions)" style={noteInput} />
            <textarea value={noteForm.content} onChange={(e) => setNoteForm({ ...noteForm, content: e.target.value })} placeholder="Text injected into the agent's context when this note is attached…" rows={6} style={{ ...noteInput, resize: 'vertical', fontFamily: 'inherit' }} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <button onClick={() => setNoteForm(null)} style={attachBtn}>Cancel</button>
              <button
                onClick={() => {
                  if (noteForm.content.trim()) {
                    if (noteForm.editingId) updateNote(noteForm.editingId, { name: noteForm.name, content: noteForm.content })
                    else addNote(noteForm.name, noteForm.content)
                    setNoteForm(null)
                  }
                }}
                style={attachedBtn}
              >
                Save note
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CatBtn(props: { label: string; active: boolean; count: number; onClick: () => void }) {
  return (
    <button
      onClick={props.onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        padding: '8px 10px',
        marginBottom: 2,
        borderRadius: 8,
        border: 'none',
        cursor: 'pointer',
        fontSize: 13,
        background: props.active ? 'var(--accent-tint)' : 'transparent',
        color: props.active ? 'var(--text)' : 'var(--text-2)'
      }}
    >
      <span>{props.label}</span>
      <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--faint)' }}>{props.count}</span>
    </button>
  )
}

function Detail(props: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 12.5, borderBottom: '1px solid var(--line)' }}>
      <span style={{ color: 'var(--muted)' }}>{props.label}</span>
      <span className="mono" style={{ color: 'var(--text-2)' }}>{props.value}</span>
    </div>
  )
}

const backBtn: CSSProperties = { background: 'var(--card)', color: 'var(--text-2)', border: '1px solid var(--line)', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }
const importBtn: CSSProperties = { flex: 1, background: 'transparent', border: '1px dashed var(--line-2)', color: 'var(--accent-light)', borderRadius: 8, padding: '8px', fontSize: 12.5, cursor: 'pointer' }
const pendingBanner: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px', background: 'rgba(227,178,95,.10)', borderBottom: '1px solid var(--line)', fontSize: 12.5, color: 'var(--warning)' }
const pendingApply: CSSProperties = { marginLeft: 'auto', flexShrink: 0, background: 'var(--warning)', color: '#1a1a1f', border: 'none', borderRadius: 6, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }
const noteBackdrop: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }
const noteCard: CSSProperties = { width: 460, maxWidth: '90vw', background: 'var(--panel)', border: '1px solid var(--line-2)', borderRadius: 14, boxShadow: '0 30px 90px rgba(0,0,0,.6)', padding: 16 }
const noteInput: CSSProperties = { width: '100%', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', color: 'var(--text)', fontSize: 13, marginBottom: 8, boxSizing: 'border-box' }
const tile: CSSProperties = { width: 26, height: 26, flexShrink: 0, borderRadius: 6, color: '#0c0c0f', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }
const attachBtn: CSSProperties = { background: 'var(--card)', color: 'var(--text-2)', border: '1px solid var(--line-2)', borderRadius: 6, padding: '4px 12px', fontSize: 12, cursor: 'pointer' }
const attachedBtn: CSSProperties = { background: 'var(--accent-tint-3)', color: 'var(--accent-light)', border: '1px solid var(--accent)', borderRadius: 6, padding: '4px 12px', fontSize: 12, cursor: 'pointer' }
