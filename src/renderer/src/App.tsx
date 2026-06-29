import { useEffect, useRef, useState } from 'react'

type Status = 'idle' | 'running' | 'done' | 'error'

function App() {
  const [prompt, setPrompt] = useState('Hello from NAC Code')
  const [output, setOutput] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const runIdRef = useRef<string | null>(null)

  useEffect(() => {
    // AgentEvent type is inferred from the typed preload bridge (window.nac).
    const off = window.nac.runs.onEvent((event) => {
      if (event.runId !== runIdRef.current) return
      if (event.type === 'content.delta') {
        setOutput((o) => o + event.text)
      } else if (event.type === 'run.completed') {
        setStatus(event.stopReason === 'canceled' ? 'idle' : 'done')
      } else if (event.type === 'run.errored') {
        setStatus('error')
        setOutput((o) => o + `\n[error] ${event.message}`)
      }
    })
    return off
  }, [])

  async function run(): Promise<void> {
    setOutput('')
    setStatus('running')
    const { runId } = await window.nac.runs.start({ prompt })
    runIdRef.current = runId
  }

  return (
    <div
      style={{
        fontFamily: 'system-ui, sans-serif',
        background: '#0c0c0f',
        color: '#e9e9ee',
        height: '100vh',
        padding: 32,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 16
      }}
    >
      <div>
        <h1 style={{ fontWeight: 600, margin: '0 0 4px' }}>NAC Code</h1>
        <p style={{ color: '#9a9aa4', margin: 0 }}>
          M0-7 tracer — streaming a harness subprocess through the preload bridge. The real shell lands in M1.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && status !== 'running' && run()}
          placeholder="Type a prompt…"
          style={{
            flex: 1,
            background: '#121216',
            color: '#e9e9ee',
            border: '1px solid rgba(255,255,255,.1)',
            borderRadius: 8,
            padding: '10px 12px',
            fontSize: 14
          }}
        />
        <button
          onClick={run}
          disabled={status === 'running'}
          style={{
            background: status === 'running' ? '#3a3a44' : '#7c7cf0',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            padding: '10px 18px',
            fontWeight: 600,
            cursor: status === 'running' ? 'default' : 'pointer'
          }}
        >
          {status === 'running' ? 'Running…' : 'Run'}
        </button>
      </div>

      <pre
        style={{
          flex: 1,
          margin: 0,
          background: '#0a0a0d',
          border: '1px solid rgba(255,255,255,.06)',
          borderRadius: 8,
          padding: 16,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          fontFamily: 'ui-monospace, monospace',
          fontSize: 13,
          color: '#c8c8d0'
        }}
      >
        {output || 'Output will stream here.'}
      </pre>

      <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#777781' }}>
        status: {status} · electron {window.nac?.version?.() ?? '—'}
      </div>
    </div>
  )
}

export default App
