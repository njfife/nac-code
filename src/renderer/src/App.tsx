function App() {
  return (
    <div
      style={{
        fontFamily: 'system-ui, sans-serif',
        background: '#0c0c0f',
        color: '#e9e9ee',
        height: '100vh',
        padding: 32,
        boxSizing: 'border-box'
      }}
    >
      <h1 style={{ fontWeight: 600 }}>NAC Code</h1>
      <p style={{ color: '#9a9aa4' }}>
        Electron + React + TypeScript scaffold (M0-7). The three-pane IDE shell lands in M1.
      </p>
      <p style={{ fontFamily: 'monospace', color: '#7c7cf0' }}>
        electron {window.nac?.version?.() ?? '—'}
      </p>
    </div>
  )
}

export default App
