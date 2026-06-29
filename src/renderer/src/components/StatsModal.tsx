import { useEffect, type CSSProperties, type ReactNode } from 'react'
import { useApp, selectActiveChat } from '../store/store'

// Stub session data (v1-stub; live metering is roadmap FR-13.2).
const TOKEN_SERIES = [
  { turn: 1, input: 1200, output: 600 },
  { turn: 2, input: 1800, output: 950 },
  { turn: 3, input: 2400, output: 700 },
  { turn: 4, input: 3100, output: 1400 },
  { turn: 5, input: 2600, output: 900 },
  { turn: 6, input: 3400, output: 1800 }
]
const TIMELINE: { name: string; detail: string; dur: string; status: 'ok' | 'error' }[] = [
  { name: 'Read', detail: 'store.ts', dur: '0.2s', status: 'ok' },
  { name: 'Edit', detail: 'ChatView.tsx', dur: '0.4s', status: 'ok' },
  { name: 'Bash', detail: 'npm test', dur: '1.1s', status: 'ok' },
  { name: 'Bash', detail: 'npm run build', dur: '0.9s', status: 'ok' },
  { name: 'Bash', detail: 'eslint .', dur: '0.3s', status: 'error' }
]

// Session Stats modal (FR-11): cards, token chart, provider-aware cost, tool timeline.
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

  const maxTok = Math.max(...TOKEN_SERIES.map((t) => t.input + t.output))
  const totalIn = TOKEN_SERIES.reduce((s, t) => s + t.input, 0)
  const totalOut = TOKEN_SERIES.reduce((s, t) => s + t.output, 0)
  const local = active.provider === 'opencode'

  return (
    <div onClick={close} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={card}>
        <div style={header}>
          <span style={{ fontWeight: 600 }}>Session Stats</span>
          <button onClick={close} style={closeBtn} aria-label="Close">✕</button>
        </div>
        <div style={{ overflow: 'auto', padding: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 18 }}>
            <Stat label="Duration" value="14m" />
            <Stat label="Messages" value="23" />
            <Stat label="Tool calls" value="47" />
            <Stat label="Errors" value="1" accent="var(--error)" />
          </div>

          <Section title="Token usage per turn">
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 120, padding: '8px 4px' }}>
              {TOKEN_SERIES.map((t) => (
                <div key={t.turn} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 2 }}>
                  <div style={{ height: `${(t.output / maxTok) * 100}%`, background: 'var(--accent)', borderRadius: '3px 3px 0 0' }} />
                  <div style={{ height: `${(t.input / maxTok) * 100}%`, background: 'var(--accent-tint-3)' }} />
                </div>
              ))}
            </div>
            <div className="mono" style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
              <span>input {(totalIn / 1000).toFixed(1)}k</span>
              <span>output {(totalOut / 1000).toFixed(1)}k</span>
              <span>peak {(maxTok / 1000).toFixed(1)}k</span>
            </div>
          </Section>

          <Section title="Cost breakdown">
            {local ? (
              <Row label="Local model" value="free" />
            ) : (
              <>
                <Row label="Input" value="$0.21" />
                <Row label="Output" value="$0.21" />
                <Row label="Total" value="$0.42" strong />
              </>
            )}
          </Section>

          <Section title="Tool Timeline">
            {TIMELINE.map((t, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
                <span style={{ color: t.status === 'ok' ? 'var(--success)' : 'var(--error)' }}>{t.status === 'ok' ? '✓' : '✕'}</span>
                <span className="mono" style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{t.name}</span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>{t.detail}</span>
                <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)' }}>{t.dur}</span>
              </div>
            ))}
          </Section>
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

function Row(props: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 13 }}>
      <span style={{ color: 'var(--muted)' }}>{props.label}</span>
      <span className="mono" style={{ color: props.strong ? 'var(--text)' : 'var(--text-2)', fontWeight: props.strong ? 600 : 400 }}>{props.value}</span>
    </div>
  )
}

const backdrop: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }
const card: CSSProperties = { width: 620, maxWidth: '92vw', maxHeight: '82vh', display: 'flex', flexDirection: 'column', background: 'var(--panel)', border: '1px solid var(--line-2)', borderRadius: 16, boxShadow: '0 30px 90px rgba(0,0,0,.6)', overflow: 'hidden' }
const header: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid var(--line)' }
const closeBtn: CSSProperties = { background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14 }
