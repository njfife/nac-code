import { describe, it, expect } from 'vitest'
import { parseRpcLine, LineDecoder, classifyRpcMessage } from './jsonRpc'

describe('parseRpcLine', () => {
  it('parses codex-style responses that omit the jsonrpc field', () => {
    expect(parseRpcLine('{"id":1,"result":{"userAgent":"nac-code/0.142.3"}}')).toEqual({ id: 1, result: { userAgent: 'nac-code/0.142.3' } })
  })
  it('parses standard ACP responses and error responses', () => {
    expect(parseRpcLine('{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"\\"Method not found\\": models.list"}}')?.error?.code).toBe(-32601)
  })
  it('passes through server notifications (method, no id) and rejects noise', () => {
    expect(parseRpcLine('{"method":"remoteControl/status/changed","params":{"status":"disabled"}}')?.method).toBe('remoteControl/status/changed')
    expect(parseRpcLine('not json')).toBeNull()
    expect(parseRpcLine('')).toBeNull()
  })
})

describe('LineDecoder', () => {
  it('reassembles multi-byte UTF-8 characters split across chunk boundaries', () => {
    const d = new LineDecoder()
    const payload = Buffer.from('{"id":1,"result":{"label":"Sonnet 4.6 · 1M"}}\n', 'utf8')
    const splitAt = payload.indexOf(Buffer.from('·', 'utf8')) + 1 // mid-character
    const lines = [...d.push(payload.subarray(0, splitAt)), ...d.push(payload.subarray(splitAt))]
    expect(lines).toEqual(['{"id":1,"result":{"label":"Sonnet 4.6 · 1M"}}'])
    expect(lines[0]).not.toContain('�')
  })
  it('holds partial lines until the newline arrives', () => {
    const d = new LineDecoder()
    expect(d.push(Buffer.from('{"id":', 'utf8'))).toEqual([])
    expect(d.push(Buffer.from('1}\n{"id":2}\n', 'utf8'))).toEqual(['{"id":1}', '{"id":2}'])
  })
})

describe('classifyRpcMessage', () => {
  it('separates responses, server requests, and notifications', () => {
    expect(classifyRpcMessage({ id: 3, result: { stopReason: 'end_turn' } })).toBe('response')
    // Real captured frame: copilot's permission request arrived with id 0 — a server REQUEST has method+id.
    expect(classifyRpcMessage({ id: 0, method: 'session/request_permission' })).toBe('server-request')
    expect(classifyRpcMessage({ method: 'session/update' })).toBe('notification')
    expect(classifyRpcMessage({ id: 1, error: { code: -32601 } })).toBe('response')
  })
})
