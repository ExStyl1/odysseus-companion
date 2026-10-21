/**
 * Chunked Transfer RPC Handlers
 *
 * Enables large-payload RPC calls (e.g. sessions:import, resources:import)
 * to be split across multiple small WebSocket messages. This works behind
 * proxies and tunnels (Cloudflare, nginx) that have message-size limits.
 *
 * Protocol:
 *   1. transfer:start  → allocate temp dir, return transferId
 *   2. transfer:chunk  → write one chunk to temp file (repeat N times)
 *   3. transfer:commit → reassemble, execute deferred RPC, clean up
 *   4. transfer:abort  → best-effort cleanup after client-side failure/cancel
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'

interface TransferState {
  id: string
  dir: string
  ownerClientId: string
  totalBytes: number
  chunkCount: number
  received: Set<number>
  receivedBytes: number
  chunkBytes: Map<number, number>
  channel: string
  args: any[]
  largeArgIndex: number
  checksum?: string
  payloadEncoding: 'json' | 'binary'
  handler: HandlerFn
  timer: ReturnType<typeof setTimeout> | null
}

const DEFAULT_TRANSFER_TTL_MS = 5 * 60 * 1000
const MAX_TRANSFER_CHUNKS = 4096
const MAX_TRANSFER_CHUNK_BYTES = 4 * 1024 * 1024
const MAX_TRANSFER_CHUNK_BASE64_CHARS = Math.ceil(MAX_TRANSFER_CHUNK_BYTES / 3) * 4

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.transfer.START,
  RPC_CHANNELS.transfer.CHUNK,
  RPC_CHANNELS.transfer.COMMIT,
  RPC_CHANNELS.transfer.ABORT,
] as const

const activeTransfers = new Map<string, TransferState>()
interface TransferableHandler {
  handler: HandlerFn
  payloadEncoding: 'json' | 'binary'
  maxBytes?: number
}

const transferableHandlers = new Map<string, TransferableHandler>()

function getTransferTtlMs(): number {
  const raw = Number(process.env.NESSY_TRANSFER_TTL_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TRANSFER_TTL_MS
}

async function cleanupTransfer(transferId: string): Promise<void> {
  const transfer = activeTransfers.get(transferId)
  if (!transfer) return

  if (transfer.timer) {
    clearTimeout(transfer.timer)
    transfer.timer = null
  }
  activeTransfers.delete(transferId)

  try {
    if (existsSync(transfer.dir)) {
      await rm(transfer.dir, { recursive: true, force: true })
    }
  } catch {
    // Best effort cleanup
  }
}

function rescheduleTransferCleanup(transfer: TransferState): void {
  if (transfer.timer) clearTimeout(transfer.timer)
  transfer.timer = setTimeout(() => {
    console.warn(`[Transfer:server] TTL expired for transfer ${transfer.id} — cleaning up`)
    void cleanupTransfer(transfer.id)
  }, getTransferTtlMs())
}

function assertTransferOwner(ctx: RequestContext, transfer: TransferState): void {
  if (ctx.clientId !== transfer.ownerClientId) {
    throw new Error('Transfer owned by different client')
  }
}

export function setTransferableHandler(
  channel: string,
  handler: HandlerFn,
  options: { payloadEncoding?: 'json' | 'binary'; maxBytes?: number } = {},
): void {
  transferableHandlers.set(channel, {
    handler,
    payloadEncoding: options.payloadEncoding ?? 'json',
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  })
}

export function __resetTransferStateForTests(): void {
  for (const transfer of activeTransfers.values()) {
    if (transfer.timer) clearTimeout(transfer.timer)
  }
  activeTransfers.clear()
  transferableHandlers.clear()
}

export function registerTransferHandlers(server: RpcServer): void {
  server.handle(RPC_CHANNELS.transfer.START, async (ctx, opts: {
    totalBytes: number
    chunkCount: number
    channel: string
    args: any[]
    largeArgIndex: number
    checksum?: string
  }) => {
    if (!opts || !Number.isSafeInteger(opts.chunkCount) || opts.chunkCount < 1 || opts.chunkCount > MAX_TRANSFER_CHUNKS) {
      throw new Error('Invalid chunkCount')
    }
    if (!Number.isSafeInteger(opts.totalBytes) || opts.totalBytes < 1) {
      throw new Error('Invalid totalBytes')
    }
    if (!opts.channel || typeof opts.channel !== 'string') {
      throw new Error('Missing target channel')
    }
    if (!Array.isArray(opts.args)) {
      throw new Error('Missing deferred args')
    }
    const registration = transferableHandlers.get(opts.channel)
    if (!registration) {
      throw new Error(`Channel ${opts.channel} does not support chunked transfer`)
    }
    if (registration.maxBytes !== undefined && opts.totalBytes > registration.maxBytes) {
      throw new Error('Payload exceeds channel limit')
    }
    if (!Number.isInteger(opts.largeArgIndex) || opts.largeArgIndex < 0 || opts.largeArgIndex >= opts.args.length) {
      throw new Error('Invalid largeArgIndex')
    }
    if (opts.checksum !== undefined && !/^[a-f0-9]{64}$/.test(opts.checksum)) {
      throw new Error('Invalid checksum')
    }

    const transferId = randomUUID()
    const dir = join(tmpdir(), `nessy-transfer-${transferId}`)
    await mkdir(dir, { recursive: true })

    const transfer: TransferState = {
      id: transferId,
      dir,
      ownerClientId: ctx.clientId,
      totalBytes: opts.totalBytes,
      chunkCount: opts.chunkCount,
      received: new Set(),
      receivedBytes: 0,
      chunkBytes: new Map(),
      channel: opts.channel,
      args: opts.args,
      largeArgIndex: opts.largeArgIndex,
      checksum: opts.checksum,
      payloadEncoding: registration.payloadEncoding,
      handler: registration.handler,
      timer: null,
    }
    activeTransfers.set(transferId, transfer)
    rescheduleTransferCleanup(transfer)

    const totalMB = (opts.totalBytes / (1024 * 1024)).toFixed(1)
    console.log(`[Transfer:server] Started transfer ${transferId}: ${opts.chunkCount} chunks, ${totalMB}MB, channel: ${opts.channel}`)

    return { transferId }
  })

  server.handle(RPC_CHANNELS.transfer.CHUNK, async (ctx, opts: {
    transferId: string
    index: number
    data: string
  }) => {
    const transfer = activeTransfers.get(opts.transferId)
    if (!transfer) {
      console.error(`[Transfer:server] Unknown transfer: ${opts.transferId}`)
      throw new Error(`Unknown transfer: ${opts.transferId}`)
    }
    assertTransferOwner(ctx, transfer)

    if (!Number.isInteger(opts.index) || opts.index < 0 || opts.index >= transfer.chunkCount) {
      throw new Error(`Invalid chunk index: ${opts.index}`)
    }
    if (typeof opts.data !== 'string' || opts.data.length === 0 || opts.data.length > MAX_TRANSFER_CHUNK_BASE64_CHARS) {
      throw new Error('Missing chunk data')
    }
    const decoded = Buffer.from(opts.data, 'base64')
    if (decoded.length === 0 || decoded.length > MAX_TRANSFER_CHUNK_BYTES || decoded.toString('base64') !== opts.data) {
      throw new Error('Invalid chunk data')
    }
    const previousBytes = transfer.chunkBytes.get(opts.index) ?? 0
    const receivedBytes = transfer.receivedBytes - previousBytes + decoded.length
    if (receivedBytes > transfer.totalBytes) {
      throw new Error('Chunk data exceeds declared payload size')
    }

    const chunkPath = join(transfer.dir, `chunk-${String(opts.index).padStart(6, '0')}`)
    await writeFile(chunkPath, opts.data, 'utf-8')
    transfer.received.add(opts.index)
    transfer.chunkBytes.set(opts.index, decoded.length)
    transfer.receivedBytes = receivedBytes
    rescheduleTransferCleanup(transfer)

    if ((opts.index + 1) % 10 === 0 || opts.index === transfer.chunkCount - 1) {
      console.log(`[Transfer:server] Received chunk ${opts.index + 1}/${transfer.chunkCount} for ${transfer.id.slice(0, 8)}`)
    }

    return { received: opts.index }
  })

  server.handle(RPC_CHANNELS.transfer.COMMIT, async (ctx, opts: {
    transferId: string
  }) => {
    const transfer = activeTransfers.get(opts.transferId)
    if (!transfer) {
      console.error(`[Transfer:server] Commit failed — unknown transfer: ${opts.transferId}`)
      throw new Error(`Unknown transfer: ${opts.transferId}`)
    }
    assertTransferOwner(ctx, transfer)

    console.log(`[Transfer:server] Committing transfer ${transfer.id.slice(0, 8)}: ${transfer.received.size}/${transfer.chunkCount} chunks received`)

    if (transfer.received.size !== transfer.chunkCount) {
      const missing: number[] = []
      for (let i = 0; i < transfer.chunkCount; i++) {
        if (!transfer.received.has(i)) missing.push(i)
      }
      throw new Error(`Missing ${missing.length} chunk(s): [${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '...' : ''}]`)
    }
    if (transfer.receivedBytes !== transfer.totalBytes) {
      await cleanupTransfer(transfer.id)
      throw new Error(`Payload size mismatch: expected ${transfer.totalBytes} bytes, got ${transfer.receivedBytes}`)
    }
    if (transfer.timer) {
      clearTimeout(transfer.timer)
      transfer.timer = null
    }

    const buffers: Buffer[] = []
    try {
      for (let i = 0; i < transfer.chunkCount; i++) {
        const chunkPath = join(transfer.dir, `chunk-${String(i).padStart(6, '0')}`)
        const encoded = await readFile(chunkPath, 'utf-8')
        buffers.push(Buffer.from(encoded, 'base64'))
      }
    } catch (error) {
      await cleanupTransfer(transfer.id)
      throw error
    }
    const reassembled = Buffer.concat(buffers)

    if (reassembled.length !== transfer.totalBytes) {
      await cleanupTransfer(transfer.id)
      throw new Error(`Payload size mismatch: expected ${transfer.totalBytes} bytes, got ${reassembled.length}`)
    }

    if (transfer.checksum) {
      const actual = createHash('sha256').update(reassembled).digest('hex')
      if (actual !== transfer.checksum) {
        console.error(`[Transfer:server] Checksum mismatch for ${transfer.id.slice(0, 8)}: expected ${transfer.checksum.slice(0, 12)}..., got ${actual.slice(0, 12)}...`)
        await cleanupTransfer(transfer.id)
        throw new Error(`Checksum mismatch: expected ${transfer.checksum.slice(0, 12)}..., got ${actual.slice(0, 12)}...`)
      }
      console.log(`[Transfer:server] Checksum verified: ${actual.slice(0, 12)}...`)
    }

    let payload: any = reassembled
    if (transfer.payloadEncoding === 'json') {
      try {
        payload = JSON.parse(reassembled.toString('utf-8'))
      } catch {
        await cleanupTransfer(transfer.id)
        throw new Error(`Failed to parse reassembled payload (${(reassembled.length / (1024 * 1024)).toFixed(1)}MB, ${transfer.chunkCount} chunks)`)
      }
    }

    const reassembledMB = (reassembled.length / (1024 * 1024)).toFixed(1)
    console.log(`[Transfer:server] Reassembled ${reassembledMB}MB payload for ${transfer.channel} — executing handler`)

    const args = [...transfer.args]
    args[transfer.largeArgIndex] = payload

    await cleanupTransfer(transfer.id)

    try {
      const result = await transfer.handler(ctx, ...args)
      console.log(`[Transfer:server] Handler ${transfer.channel} completed successfully`)
      return result
    } catch (err) {
      console.error(`[Transfer:server] Handler ${transfer.channel} failed:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.transfer.ABORT, async (ctx, opts: { transferId: string }) => {
    const transfer = activeTransfers.get(opts.transferId)
    if (!transfer) {
      return { aborted: false }
    }
    assertTransferOwner(ctx, transfer)
    await cleanupTransfer(transfer.id)
    console.warn(`[Transfer:server] Transfer aborted by client: ${transfer.id.slice(0, 8)}`)
    return { aborted: true }
  })
}
