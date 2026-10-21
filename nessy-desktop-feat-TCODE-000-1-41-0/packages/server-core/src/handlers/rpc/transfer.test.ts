import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'
import {
  __resetTransferStateForTests,
  registerTransferHandlers,
  setTransferableHandler,
} from './transfer'

function createHarness() {
  const handlers = new Map<string, HandlerFn>()

  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {
      return undefined
    },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }

  registerTransferHandlers(server)

  const start = handlers.get(RPC_CHANNELS.transfer.START)
  const chunk = handlers.get(RPC_CHANNELS.transfer.CHUNK)
  const commit = handlers.get(RPC_CHANNELS.transfer.COMMIT)
  const abort = handlers.get(RPC_CHANNELS.transfer.ABORT)

  if (!start || !chunk || !commit || !abort) {
    throw new Error('transfer handlers not registered')
  }

  return { start, chunk, commit, abort }
}

function ctx(clientId: string): RequestContext {
  return {
    clientId,
    workspaceId: 'ws-1',
    webContentsId: 1,
  }
}

function encodeParts(value: unknown, splitAt?: number) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf-8')
  const checksum = createHash('sha256').update(bytes).digest('hex')
  if (!splitAt || splitAt <= 0 || splitAt >= bytes.length) {
    return { bytes, checksum, chunks: [bytes.toString('base64')] }
  }
  return {
    bytes,
    checksum,
    chunks: [
      bytes.subarray(0, splitAt).toString('base64'),
      bytes.subarray(splitAt).toString('base64'),
    ],
  }
}

afterEach(() => {
  delete process.env.NESSY_TRANSFER_TTL_MS
  __resetTransferStateForTests()
})

describe('chunked transfer handlers', () => {
  it('rejects chunk uploads from a different client', async () => {
    const { start, chunk } = createHarness()
    const payload = encodeParts({ hello: 'world' })

    setTransferableHandler('test:echo', async (_ctx, _placeholder, body) => body)

    const { transferId } = await start(ctx('client-1'), {
      totalBytes: payload.bytes.length,
      chunkCount: payload.chunks.length,
      channel: 'test:echo',
      args: [null, null],
      largeArgIndex: 1,
      checksum: payload.checksum,
    }) as { transferId: string }

    await expect(chunk(ctx('client-2'), {
      transferId,
      index: 0,
      data: payload.chunks[0],
    })).rejects.toThrow('Transfer owned by different client')
  })

  it('aborts and cleans up an active transfer', async () => {
    const { start, abort, commit } = createHarness()
    const payload = encodeParts({ hello: 'world' })

    setTransferableHandler('test:echo', async (_ctx, _placeholder, body) => body)

    const { transferId } = await start(ctx('client-1'), {
      totalBytes: payload.bytes.length,
      chunkCount: payload.chunks.length,
      channel: 'test:echo',
      args: [null, null],
      largeArgIndex: 1,
      checksum: payload.checksum,
    }) as { transferId: string }

    await expect(abort(ctx('client-1'), { transferId })).resolves.toEqual({ aborted: true })
    await expect(commit(ctx('client-1'), { transferId })).rejects.toThrow(`Unknown transfer: ${transferId}`)
  })

  it('rejects checksum mismatches', async () => {
    const { start, chunk, commit } = createHarness()
    const payload = encodeParts({ hello: 'world' })
    const tamperedBytes = Buffer.from(payload.bytes)
    const worldIndex = tamperedBytes.indexOf(Buffer.from('world'))
    if (worldIndex === -1) throw new Error('Expected payload to contain "world"')
    tamperedBytes[worldIndex] = 'x'.charCodeAt(0)

    setTransferableHandler('test:echo', async (_ctx, _placeholder, body) => body)

    const { transferId } = await start(ctx('client-1'), {
      totalBytes: payload.bytes.length,
      chunkCount: 1,
      channel: 'test:echo',
      args: [null, null],
      largeArgIndex: 1,
      checksum: payload.checksum,
    }) as { transferId: string }

    await chunk(ctx('client-1'), {
      transferId,
      index: 0,
      data: tamperedBytes.toString('base64'),
    })

    await expect(commit(ctx('client-1'), { transferId })).rejects.toThrow('Checksum mismatch')
  })

  it('rejects commits with missing chunks', async () => {
    const { start, chunk, commit } = createHarness()
    const payload = encodeParts({ hello: 'world', more: 'data' }, 5)

    setTransferableHandler('test:echo', async (_ctx, _placeholder, body) => body)

    const { transferId } = await start(ctx('client-1'), {
      totalBytes: payload.bytes.length,
      chunkCount: payload.chunks.length,
      channel: 'test:echo',
      args: [null, null],
      largeArgIndex: 1,
      checksum: payload.checksum,
    }) as { transferId: string }

    await chunk(ctx('client-1'), {
      transferId,
      index: 0,
      data: payload.chunks[0],
    })

    await expect(commit(ctx('client-1'), { transferId })).rejects.toThrow('Missing 1 chunk(s)')
  })

  it('refreshes TTL as chunks arrive so slow healthy uploads survive', async () => {
    // Sum of inter-chunk waits (2 x 150ms) must exceed the TTL so the test
    // proves refresh; each 150ms wait must stay well under the 250ms TTL so
    // full-suite scheduling contention cannot expire a healthy transfer.
    process.env.NESSY_TRANSFER_TTL_MS = '250'

    const { start, chunk, commit } = createHarness()
    const payload = encodeParts({ hello: 'world', slow: true }, 8)

    setTransferableHandler('test:echo', async (_ctx, _placeholder, body) => ({ ok: true, body }))

    const { transferId } = await start(ctx('client-1'), {
      totalBytes: payload.bytes.length,
      chunkCount: payload.chunks.length,
      channel: 'test:echo',
      args: [null, null],
      largeArgIndex: 1,
      checksum: payload.checksum,
    }) as { transferId: string }

    await new Promise(resolve => setTimeout(resolve, 150))
    await chunk(ctx('client-1'), {
      transferId,
      index: 0,
      data: payload.chunks[0],
    })

    await new Promise(resolve => setTimeout(resolve, 150))
    await chunk(ctx('client-1'), {
      transferId,
      index: 1,
      data: payload.chunks[1],
    })

    await expect(commit(ctx('client-1'), { transferId })).resolves.toEqual({
      ok: true,
      body: { hello: 'world', slow: true },
    })
  })

  it('enforces channel byte limits and passes binary payloads without JSON parsing', async () => {
    const { start, chunk, commit } = createHarness()
    const bytes = Buffer.from([0, 255, 1, 2])
    const checksum = createHash('sha256').update(bytes).digest('hex')
    setTransferableHandler(
      'test:binary',
      async (_ctx, body) => Buffer.isBuffer(body) ? [...body] : null,
      { payloadEncoding: 'binary', maxBytes: bytes.length },
    )

    await expect(start(ctx('client-1'), {
      totalBytes: bytes.length + 1,
      chunkCount: 1,
      channel: 'test:binary',
      args: [null],
      largeArgIndex: 0,
      checksum,
    })).rejects.toThrow('Payload exceeds channel limit')

    const { transferId } = await start(ctx('client-1'), {
      totalBytes: bytes.length,
      chunkCount: 1,
      channel: 'test:binary',
      args: [null],
      largeArgIndex: 0,
      checksum,
    }) as { transferId: string }
    await chunk(ctx('client-1'), {
      transferId,
      index: 0,
      data: bytes.toString('base64'),
    })
    await expect(commit(ctx('client-1'), { transferId })).resolves.toEqual([...bytes])
    await expect(commit(ctx('client-1'), { transferId })).rejects.toThrow(`Unknown transfer: ${transferId}`)
  })
})
