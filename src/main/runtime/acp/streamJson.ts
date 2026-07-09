import { spawn, type ChildProcess } from 'child_process'
import { LineDecoder } from '../capabilities/jsonRpc'

// Newline-delimited TYPED frames (claude stream-json). Not JSON-RPC: no id/method envelope, so no
// request/response correlation lives here — control_request/control_response matching is the
// session's job. Close semantics mirror JsonRpcClient (b9e618b/700b170): idempotent, late
// registration fires immediately, error→close collapses to one firing.
export class StreamJsonClient {
  private child: ChildProcess
  private lines = new LineDecoder()
  private frameHandlers = new Map<string, (frame: Record<string, unknown>) => void>()
  private closeHandlers: Array<() => void> = []
  private closed = false

  constructor(command: string, args: string[], cwd?: string) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], ...(cwd ? { cwd } : {}) })
    this.child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of this.lines.push(chunk)) {
        let frame: unknown
        try {
          frame = JSON.parse(line)
        } catch {
          continue
        }
        if (!frame || typeof frame !== 'object') continue
        const t = (frame as { type?: unknown }).type
        if (typeof t === 'string') this.frameHandlers.get(t)?.(frame as Record<string, unknown>)
      }
    })
    this.child.on('error', () => this.handleClose())
    this.child.on('close', () => this.handleClose())
  }

  private handleClose(): void {
    if (this.closed) return
    this.closed = true
    for (const h of this.closeHandlers) {
      try {
        h()
      } catch {
        // a broken close handler must not crash the transport
      }
    }
  }

  onFrame(type: string, handler: (frame: Record<string, unknown>) => void): void {
    this.frameHandlers.set(type, handler)
  }

  onClose(handler: () => void): void {
    if (this.closed) {
      try {
        handler()
      } catch {
        // a broken close handler must not crash the transport
      }
      return
    }
    this.closeHandlers.push(handler)
  }

  get isClosed(): boolean {
    return this.closed
  }

  send(frame: object): void {
    this.child.stdin?.write(JSON.stringify(frame) + '\n')
  }

  close(): void {
    this.child.kill()
  }
}
