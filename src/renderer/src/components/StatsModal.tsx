import { useEffect, type CSSProperties, type ReactNode } from 'react'
import { useApp, selectActiveChat } from '../store/store'

const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)
const fmtCost = (n: number): string => `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`

// Session Stats modal (FR-11): real per-provider metering accumulated from the run completion events.
export default function StatsModal() {
  const active = useApp(selectActiveChat)
  const close = useApp((s) => s.closeModal)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const usage = active?.usage ?? {}
  const providers = Object.entries(usage)
  const totalTurns = providers.reduce((s, [, u]) => s + u.turns, 0)
  const totalIn = providers.reduce((s, [, u]) => s + u.inputTokens, 0)
  const totalOut = providers.reduce((s, [, u]) => s + u.outputTokens, 0)
  const totalCost = providers.reduce((s, [, u]) => s + u.costUsd, 0)

  return (
    <div onClick={close} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={card}>
        <div style={header}>
          <span style={{ fontWeight: 600 }}>Session Stats</span>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }}>this chat</span>
          <button onClick={close} style={closeBtn} aria-label="Close">✕</button>
        </div>
        <div style={{ overflow: 'auto', padding: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 18 }}>
            <Stat label="Messages" value={`${active?.messages?.length ?? 0}`} />
            <Stat label="Turns" value={`${totalTurns}`} />
            <Stat label="Tokens" value={fmtTok(totalIn + totalOut)} />
            <Stat label="Cost" value={totalCost > 0 ? fmtCost(totalCost) : 'free'} accent={totalCost > 0 ? undefined : 'var(--success)'} />
          </div>

          <Section title="Per-provider usage">
            {providers.length === 0 ? (
              <Row label="No runs yet — send a message to start metering." value="" />
            ) : (
              providers
                .sort((a, b) => b[1].turns - a[1].turns)
                .map(([prov, u]) => (
                  <div key={prov} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                    <span className="mono" style={{ fontSize: 13, color: 'var(--text)', minWidth: 86 }}>{prov}</span>
                    <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>{u.turns} {u.turns === 1 ? 'turn' : 'turns'}</span>
                    <span className="mono" style={{ fontSize: 12, color: 'var(--faint)' }}>
                      {u.inputTokens + u.outputTokens > 0 ? (
                        <>
                          <span style={{ color: 'var(--accent-light)' }}>↑{fmtTok(u.inputTokens)}</span> <span style={{ color: 'var(--accent-light)' }}>↓{fmtTok(u.outputTokens)}</span>
                        </>
                      ) : (
                        '— tokens'
                      )}
                    </span>
                    <span className="mono" style={{ marginLeft: 'auto', fontSize: 12.5, color: u.costUsd > 0 ? 'var(--text)' : 'var(--success)' }}>
                      {u.costUsd > 0 ? fmtCost(u.costUsd) : u.turns > 0 && u.costKnown ? '$0.00' : '—'}
                    </span>
                  </div>
                ))
            )}
          </Section>

          <p style={{ fontSize: 11.5, color: 'var(--muted-2)', lineHeight: 1.5, marginTop: 4 }}>
            Metered from each harness's real completion data — Claude reports $ + tokens, Codex/OpenCode report tokens (OpenCode also $; local models are free), copilot reports cost via ACP usage frames.
          </p>
        </div>
      </div>
    </div>
  )
}

function Stat(props: { label: string; value: string; accent?: string }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: 22, fontWeight: 600, color: props.accent ?? 'var(--text)' }}>{props.value}</div>
      <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 2 }}>{props.label}</div>
    </div>
  )
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 10.5, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--muted-2)', fontWeight: 600, marginBottom: 8 }}>{props.title}</div>
      {props.children}
    </div>
  )
}

function Row(props: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 13 }}>
      <span style={{ color: 'var(--muted)' }}>{props.label}</span>
      <span className="mono" style={{ color: 'var(--text-2)' }}>{props.value}</span>
    </div>
  )
}

const backdrop: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }
const card: CSSProperties = { width: 560, maxWidth: '92vw', maxHeight: '82vh', display: 'flex', flexDirection: 'column', background: 'var(--panel)', border: '1px solid var(--line-2)', borderRadius: 16, boxShadow: '0 30px 90px rgba(0,0,0,.6)', overflow: 'hidden' }
const header: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--line)' }
const closeBtn: CSSProperties = { background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14 }
