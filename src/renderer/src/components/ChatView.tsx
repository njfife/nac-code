import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useApp, selectActiveChat } from '../store/store'
import { changesSummary } from '../data/changes'
import { CONFIGURATIONS, CONFIGS_BY_ID, configTokens } from '../data/configs'

type Status = 'idle' | 'running' | 'done' | 'error'

// Center pane: chat header · thread · composer. The composer's Send drives the M0-7 tracer
// (a harness subprocess streamed over the preload bridge) — the real per-chat run loop lands in M5.
export default function ChatView() {
  const active = useApp(selectActiveChat)
  const openModal = useApp((s) => s.openModal)
  const setView = useApp((s) => s.setView)
  const changed = changesSummary().files
  const compactChat = useApp((s) => s.compactChat)
  const newFromCompacted = useApp((s) => s.newFromCompacted)
  const applyConfig = useApp((s) => s.applyConfig)
  const toggleYolo = useApp((s) => s.toggleYolo)
  const setThinking = useApp((s) => s.setThinking)
  const [configOpen, setConfigOpen] = useState(false)
  const configLabel = active.activeConfig ? CONFIGS_BY_ID[active.activeConfig]?.name ?? 'Custom' : 'Custom'
  const [prompt, setPrompt] = useState('')
  const [sent, setSent] = useState('')
  const [output, setOutput] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const runIdRef = useRef<string | null>(null)

  useEffect(() => {
    const off = window.nac.runs.onEvent((event) => {
      if (event.runId !== runIdRef.current) return
      if (event.type === 'content.delta') setOutput((o) => o + event.text)
      else if (event.type === 'run.completed') setStatus(event.stopReason === 'canceled' ? 'idle' : 'done')
      else if (event.type === 'run.errored') {
        setStatus('error')
        setOutput((o) => o + `\n[error] ${event.message}`)
      }
    })
    return off
  }, [])

  async function run(): Promise<void> {
    if (!prompt.trim() || status === 'running') return
    setSent(prompt)
    setOutput('')
    setStatus('running')
    setPrompt('')
    const { runId } = await window.nac.runs.start({ prompt })
    runIdRef.current = runId
  }

  return (
    <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--app-bg)' }}>
      {/* Chat header bar */}
      <div
        style={{
          height: 'var(--topbar-h)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 18px',
          borderBottom: '1px solid var(--line)'
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {active.title}
        </span>
        <span className="mono" style={pill}>
          {active.model}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <span style={headerAction} onClick={() => setView('changes')}>
            Files {changed > 0 && <span style={badge}>{changed}</span>}
          </span>
          <span style={headerAction} onClick={() => !active.compacting && compactChat()}>
            {active.compacting ? (
              <>
                <span style={spinner} /> Compacting…
              </>
            ) : active.compacted ? (
              'Compacted ✓'
            ) : (
              'Compact'
            )}
          </span>
          {active.compacted && (
            <span style={headerAction} onClick={() => newFromCompacted()}>
              New from compacted
            </span>
          )}
          <div style={{ position: 'relative' }}>
            <span style={headerAction} onClick={() => setConfigOpen((o) => !o)}>
              Context: {configLabel}
              {active.dirty && <span style={{ color: 'var(--warning)', marginLeft: 4 }}>· modified</span>} ▾
            </span>
            {configOpen && (
              <div style={configPopover}>
                {CONFIGURATIONS.map((cfg) => (
                  <div
                    key={cfg.id}
                    onClick={() => {
                      applyConfig(cfg.id)
                      setConfigOpen(false)
                    }}
                    style={{ ...configRow, background: active.activeConfig === cfg.id ? 'var(--accent-tint)' : 'transparent' }}
                  >
                    <span style={{ color: 'var(--text)' }}>{cfg.name}</span>
                    <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--faint)' }}>
                      {cfg.itemIds.length} · ~{(configTokens(cfg) / 1000).toFixed(1)}k
                    </span>
                  </div>
                ))}
                <div style={configSaveRow}>Save current as configuration…</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Thread */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={{ maxWidth: 'var(--thread-max-w)', margin: '0 auto', padding: '24px 40px', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {!sent && (
            <p style={{ color: 'var(--muted)', fontSize: 14.5 }}>
              Type a prompt and hit Send to stream a turn through the harness bridge (M0-7 tracer).
            </p>
          )}
          {sent && <Message who="you" body={sent} />}
          {sent && <Message who="nc" body={output} streaming={status === 'running'} />}
        </div>
      </div>

      {/* Composer */}
      <div style={{ padding: '0 40px 20px' }}>
        <div style={{ maxWidth: 'var(--thread-max-w)', margin: '0 auto' }}>
          <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 4px 8px', fontSize: 12, color: 'var(--muted)' }}>
              <span style={pill}>Context · {active.attachedIds.length}</span>
              <span onClick={() => setView('context')} style={{ marginLeft: 'auto', color: 'var(--accent-light)', cursor: 'pointer' }}>
                Manage
              </span>
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  run()
                }
              }}
              placeholder="Message the agent…"
              rows={2}
              style={{
                width: '100%',
                resize: 'none',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: 'var(--text)',
                fontSize: 14.5,
                fontFamily: 'inherit',
                lineHeight: 1.5
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 8 }}>
              <span style={toolbarItem}>Attach</span>
              <span style={toolbarItem} onClick={() => openModal('model')}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', display: 'inline-block', marginRight: 6 }} />
                {active.model}
              </span>
              <span style={toolbarItem} onClick={() => openModal('agent')}>
                {active.agent ?? 'No agent'}
              </span>
              <span
                style={toolbarItem}
                onClick={() => {
                  const order = ['none', 'low', 'medium', 'high'] as const
                  setThinking(order[(order.indexOf(active.thinking) + 1) % order.length])
                }}
              >
                Thinking: {active.thinking[0].toUpperCase() + active.thinking.slice(1)}
              </span>
              <span
                onClick={() => toggleYolo()}
                style={{ ...toolbarItem, color: active.yolo ? 'var(--warning)' : 'var(--muted)', fontWeight: active.yolo ? 600 : 400 }}
              >
                YOLO{active.yolo ? ' ●' : ''}
              </span>
              <button
                onClick={run}
                disabled={status === 'running' || !prompt.trim()}
                style={{
                  marginLeft: 'auto',
                  background: status === 'running' || !prompt.trim() ? '#3a3a44' : 'var(--accent)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 8,
                  padding: '7px 16px',
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: status === 'running' || !prompt.trim() ? 'default' : 'pointer'
                }}
              >
                {status === 'running' ? 'Running…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}

function Message(props: { who: 'you' | 'nc'; body: string; streaming?: boolean }) {
  const isNc = props.who === 'nc'
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <div
        style={{
          width: 30,
          height: 30,
          flexShrink: 0,
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          fontWeight: 600,
          color: '#fff',
          background: isNc ? 'linear-gradient(135deg,#7c7cf0,#5b5bd6)' : 'var(--card-3)'
        }}
      >
        {isNc ? 'NC' : 'YOU'}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="mono" style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
          {isNc ? 'NAC Code' : 'You'}
        </div>
        <div style={{ fontSize: 14.5, lineHeight: 1.65, color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}>
          {props.body}
          {props.streaming && (
            <span
              style={{
                display: 'inline-block',
                width: 7,
                height: 15,
                marginLeft: 2,
                background: 'var(--accent)',
                verticalAlign: 'text-bottom',
                animation: 'nac-blink 1.1s step-end infinite'
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

const pill: CSSProperties = {
  fontSize: 11,
  padding: '2px 8px',
  borderRadius: 5,
  background: 'var(--accent-tint)',
  color: 'var(--accent-light)'
}
const headerAction: CSSProperties = {
  fontSize: 12,
  padding: '4px 10px',
  borderRadius: 6,
  background: 'var(--card)',
  border: '1px solid var(--line)',
  color: 'var(--text-2)',
  cursor: 'pointer'
}
const toolbarItem: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--muted)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center'
}
const badge: CSSProperties = { fontSize: 10, background: 'var(--accent)', color: '#fff', borderRadius: 8, padding: '0 5px', marginLeft: 4 }
const spinner: CSSProperties = { display: 'inline-block', width: 10, height: 10, border: '2px solid var(--line-2)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin .9s linear infinite', verticalAlign: 'middle', marginRight: 4 }
const configPopover: CSSProperties = { position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: 250, background: 'var(--panel)', border: '1px solid var(--line-2)', borderRadius: 10, boxShadow: '0 16px 48px rgba(0,0,0,.55)', padding: 6, zIndex: 50 }
const configRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, fontSize: 13, cursor: 'pointer' }
const configSaveRow: CSSProperties = { padding: '8px 10px', marginTop: 4, borderTop: '1px solid var(--line)', fontSize: 12.5, color: 'var(--accent-light)', cursor: 'pointer' }
