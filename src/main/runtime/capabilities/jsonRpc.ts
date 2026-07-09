import { spawn, type ChildProcess } from 'child_process'
import { StringDecoder } from 'string_decoder'

// Minimal newline-delimited JSON-RPC 2.0 client over a child process's stdio. Used for
// `codex app-server` (which omits the jsonrpc field in responses) and `copilot --acp`.

export interface RpcMessage {
  id?: number
  result?: unknown
  error?: { code?: number; message?: string }
  method?: string
  params?: unknown
}

/** Pure + exported for testing: chunk-boundary-safe newline splitter (multi-byte UTF-8 can split across chunks). */
export class LineDecoder {
  private decoder = new StringDecoder('utf8')
  private buffer = ''

  push(chunk: Buffer): string[] {
    this.buffer += this.decoder.write(chunk)
    const lines: string[] = []
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      lines.push(this.buffer.slice(0, nl))
      this.buffer = this.buffer.slice(nl + 1)
    }
    return lines
  }
}

/** Pure + exported for testing: one stdout line → an RPC message (responses and notifications). */
export function parseRpcLine(line: string): RpcMessage | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let m: RpcMessage
  try {
    m = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof m !== 'object' || m === null) return null
  return m
}

/** Pure + exported for testing: incoming message kind. A server-initiated message carries `method`;
 *  with an id it's a request we must answer, without one a notification. Anything else is a response. */
export function classifyRpcMessage(m: RpcMessage): 'response' | 'server-request' | 'notification' {
  if (m.method !== undefined) return m.id !== undefined ? 'server-request' : 'notification'
  return 'response'
}

export class JsonRpcClient {
  private child: ChildProcess
  private lines = new LineDecoder()
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private notificationHandlers = new Map<string, (params: unknown) => void>()
  private requestHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>()
  private closed = false

  constructor(command: string, args: string[]) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] })
    this.child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of this.lines.push(chunk)) {
        const msg = parseRpcLine(line)
        if (!msg) continue
        const kind = classifyRpcMessage(msg)
        if (kind === 'response' && msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          if (msg.error) p.reject(new Error(msg.error.message ?? `rpc error ${msg.error.code}`))
          else p.resolve(msg.result)
        } else if (kind === 'server-request') {
          this.answer(msg)
        } else if (kind === 'notification') {
          this.notificationHandlers.get(msg.method!)?.(msg.params)
        }
      }
    })
    this.child.on('error', (err) => this.failAll(err))
    this.child.on('close', () => {
      this.closed = true
      this.failAll(new Error('rpc server closed'))
    })
  }

  /** True once the child process has exited — further requests would hang forever on a dead pipe. */
  get isClosed(): boolean {
    return this.closed
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  private answer(msg: RpcMessage): void {
    const handler = this.requestHandlers.get(msg.method!)
    const write = (body: object): void => {
      this.child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body }) + '\n')
    }
    if (!handler) {
      write({ error: { code: -32601, message: `unhandled: ${msg.method}` } })
      return
    }
    Promise.resolve()
      .then(() => handler(msg.params))
      .then((result) => write({ result }))
      .catch((e: Error) => write({ error: { code: -32000, message: e.message ?? 'handler error' } }))
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler)
  }

  onRequest(method: string, handler: (params: unknown) => Promise<unknown> | unknown): void {
    this.requestHandlers.set(method, handler)
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }) + '\n')
  }

  request(method: string, params?: unknown, timeoutMs = 5000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('rpc: server closed'))
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`rpc timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      this.child.stdin?.write(payload + '\n')
    })
  }

  close(): void {
    this.child.kill()
  }
}
