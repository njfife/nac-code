import { useEffect, useState, type CSSProperties } from 'react'
import { useApp } from '../store/store'
import { slugify, type DiscoveredAgent, type NacAgent } from '../../../shared/agents'

// Agent picker (agent-picker spec): lists the ACTIVE chat's provider's harness-native agents grouped
// by source, plus the NAC-authored agents (create/edit/delete → agents:sync fan-out). Follows
// ModelModal's overlay/card idioms; selection applies to the active chat only.

const GROUP_LABEL: Record<DiscoveredAgent['source'], string> = {
  nac: 'NAC-managed',
  user: 'Yours',
  project: 'Project',
  plugin: 'Plugins',
  builtin: 'Built-in'
}
const GROUP_ORDER: DiscoveredAgent['source'][] = ['nac', 'user', 'project', 'plugin', 'builtin']

export default function AgentModal(): React.JSX.Element {
  const { chats, activeChatId, agents, nacAgents, lastSyncReport, openModal, setAgent, loadAgents, saveNacAgent, deleteNacAgent } = useApp()
  const active = chats[activeChatId]
  const provider = active?.provider ?? 'claude'
  const pa = agents[provider]
  const [editing, setEditing] = useState<NacAgent | null>(null)

  useEffect(() => {
    void loadAgents(provider)
  }, [provider, loadAgents])

  if (!active) return <></>

  const pick = (name: string | null): void => {
    setAgent(name)
    openModal(null)
  }

  const groups = GROUP_ORDER.map((src) => ({ src, items: (pa?.agents ?? []).filter((a) => a.source === src) })).filter((g) => g.items.length)

  return (
    <div onClick={() => openModal(null)} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <strong>Agent — {provider}</strong>
          <span style={{ cursor: 'pointer', color: 'var(--muted)' }} onClick={() => void loadAgents(provider, true)}>refresh</span>
        </div>
        {pa?.support === 'none' ? (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>{pa.note}</div>
        ) : (
          <>
            <div onClick={() => pick(null)} style={{ padding: '7px 9px', borderRadius: 6, cursor: 'pointer', background: active.agent === null ? 'var(--accent-tint-3)' : 'transparent' }}>
              No agent <span style={{ color: 'var(--muted)', fontSize: 12 }}>(harness default)</span>
            </div>
            {groups.map((g) => (
              <div key={g.src} style={{ marginTop: 10 }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{GROUP_LABEL[g.src]}</div>
                {g.items.map((a) => {
                  const nacEntry = g.src === 'nac' ? nacAgents.find((n) => slugify(n.name) === a.id) : undefined
                  return (
                    <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderRadius: 6, cursor: a.selectable ? 'pointer' : 'default', opacity: a.selectable ? 1 : 0.5, background: active.agent === a.id ? 'var(--accent-tint-3)' : 'transparent' }} onClick={() => a.selectable && pick(a.id)}>
                      <span style={{ flex: 1 }}>
                        {a.name}
                        {a.description && <span style={{ color: 'var(--muted)', fontSize: 12 }}> — {a.description}</span>}
                      </span>
                      {nacEntry && (
                        <>
                          <span style={{ fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); setEditing(nacEntry) }}>edit</span>
                          <span style={{ fontSize: 12, color: 'var(--warning)', cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); void deleteNacAgent(nacEntry.id) }}>delete</span>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
            {pa?.note && <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>{pa.note}</div>}
          </>
        )}
        <div style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          {editing ? (
            <AgentForm agent={editing} onSave={(a) => { void saveNacAgent(a); setEditing(null) }} onCancel={() => setEditing(null)} />
          ) : (
            <span style={{ cursor: 'pointer', color: 'var(--accent)' }} onClick={() => setEditing({ id: `u_ag_${Date.now()}`, name: '', description: '', prompt: '', rev: 0 })}>
              + New agent…
            </span>
          )}
          {lastSyncReport && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
              {lastSyncReport.map((r, i) => (
                <div key={i} style={{ color: r.action === 'conflict' || r.action === 'error' ? 'var(--warning)' : 'var(--muted)' }}>
                  {r.provider}: {r.action}{r.detail ? ` — ${r.detail}` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function AgentForm({ agent, onSave, onCancel }: { agent: NacAgent; onSave: (a: NacAgent) => void; onCancel: () => void }): React.JSX.Element {
  const [a, setA] = useState(agent)
  const input = { width: '100%', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 6, color: 'var(--text)', padding: '6px 8px', fontSize: 13, marginBottom: 6 } as const
  return (
    <div>
      <input style={input} placeholder="Name" value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} />
      <input style={input} placeholder="Description" value={a.description} onChange={(e) => setA({ ...a, description: e.target.value })} />
      <textarea style={{ ...input, resize: 'vertical' }} rows={4} placeholder="System prompt" value={a.prompt} onChange={(e) => setA({ ...a, prompt: e.target.value })} />
      <div style={{ display: 'flex', gap: 10 }}>
        <span style={{ cursor: 'pointer', color: 'var(--accent)', opacity: a.name.trim() && a.prompt.trim() ? 1 : 0.4 }} onClick={() => a.name.trim() && a.prompt.trim() && onSave(a)}>Save + sync</span>
        <span style={{ cursor: 'pointer', color: 'var(--muted)' }} onClick={onCancel}>Cancel</span>
      </div>
    </div>
  )
}

// Container idioms shared with ModelModal (backdrop + card tokens).
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
  width: 460,
  maxWidth: '90vw',
  maxHeight: '70vh',
  overflowY: 'auto',
  background: 'var(--panel)',
  border: '1px solid var(--line-2)',
  borderRadius: 16,
  boxShadow: '0 30px 90px rgba(0,0,0,.6)',
  padding: 18,
  fontSize: 13
}
