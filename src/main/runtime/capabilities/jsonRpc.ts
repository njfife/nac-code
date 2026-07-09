import { spawn, type ChildProcess } from 'child_process'
import { StringDecoder } from 'string_decoder'

// Minimal newline-delimited JSON-RPC 2.0 client over a child process's stdio. Used for
// `codex app-server` (which omits the jsonrpc field in responses) and `copilot --acp`.

export interface RpcMessage {
  id?: number
  result?: unknown
  error?: { code?: number; message?: string }
  method?: string
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

export class JsonRpcClient {
  private child: ChildProcess
  private lines = new LineDecoder()
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  constructor(command: string, args: string[]) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] })
    this.child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of this.lines.push(chunk)) {
        const msg = parseRpcLine(line)
        if (msg?.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          if (msg.error) p.reject(new Error(msg.error.message ?? `rpc error ${msg.error.code}`))
          else p.resolve(msg.result)
        }
        // notifications (method, no id) are ignored — discovery only awaits responses
      }
    })
    this.child.on('error', (err) => this.failAll(err))
    this.child.on('close', () => this.failAll(new Error('rpc server closed')))
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  request(method: string, params?: unknown, timeoutMs = 5000): Promise<unknown> {
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
