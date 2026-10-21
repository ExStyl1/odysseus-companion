import { describe, expect, test } from 'bun:test'
import { WsRpcClient } from './client'
import { WsRpcServer } from './server'

describe('RPC sequence barrier', () => {
  test('is client-scoped, monotonic and read-only', () => {
    const server = new WsRpcServer()
    const clients = (server as any).clients as Map<string, any>
    const connection = (id: string) => ({
      id, workspaceId: 'w', webContentsId: null, capabilities: new Set(),
      eventBuffer: [], lastAckedSeq: 0, lastSentSeq: 0,
      ws: { OPEN: 1, readyState: 1, send() {} }, alive: true, missedPongs: 0,
    })
    clients.set('a', connection('a'))
    clients.set('b', connection('b'))
    server.push('session:event', { to: 'client', clientId: 'a' }, { value: 1 })
    server.push('session:event', { to: 'client', clientId: 'a' }, { value: 2 })
    server.push('session:event', { to: 'client', clientId: 'b' }, { value: 3 })
    expect(server.getClientLastSentSeq('a')).toBe(2)
    expect(server.getClientLastSentSeq('b')).toBe(1)
    expect(server.getClientLastSentSeq('a')).toBe(2)
    expect(server.getClientLastSentSeq('missing')).toBeUndefined()
  })

  test('sequenced callbacks expose seq without changing ordinary callbacks', () => {
    const client = new WsRpcClient('ws://127.0.0.1:1', { autoReconnect: false })
    const ordinary: unknown[] = []
    const sequenced: unknown[] = []
    client.on('session:event', value => ordinary.push(value))
    client.onSequenced('session:event', event => sequenced.push(event))
    ;(client as any).onMessage(JSON.stringify({ id: 'event', type: 'event', channel: 'session:event', args: [{ type: 'x' }], seq: 9 }))
    expect(ordinary).toEqual([{ type: 'x' }])
    expect(sequenced).toEqual([{ seq: 9, args: [{ type: 'x' }] }])
  })
})
