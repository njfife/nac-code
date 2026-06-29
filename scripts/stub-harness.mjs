#!/usr/bin/env node
// Stub "harness": emits a short NDJSON stream simulating a streaming agent turn.
// Stands in for a real CLI (e.g. `claude -p --output-format stream-json`) so the M0-7 tracer
// proves the spawn -> stream -> parse -> normalize -> IPC -> render path end to end.
// Protocol: one JSON object per line. { "type": "delta", "text": "..." } then { "type": "done" }.

const prompt = process.argv[2] ?? ''
const words = `You said: "${prompt}". This is a streamed response from the stub harness, proving the AgentRuntime path end to end.`.split(
  ' '
)

// Exit cleanly if the consumer (the main process) goes away mid-stream — e.g. on cancel.
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0)
  throw err
})

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

let i = 0
const timer = setInterval(() => {
  if (i < words.length) {
    emit({ type: 'delta', text: words[i] + ' ' })
    i++
  } else {
    emit({ type: 'done' })
    clearInterval(timer)
    process.exit(0)
  }
}, 60)
