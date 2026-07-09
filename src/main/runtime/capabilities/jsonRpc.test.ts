import { describe, it, expect } from 'vitest'
import { parseRpcLine } from './jsonRpc'

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
