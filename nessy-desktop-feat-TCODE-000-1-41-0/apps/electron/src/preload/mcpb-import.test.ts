import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcClient } from '@nessy-agent/server-core/transport'
import { MAX_MCPB_ARCHIVE_BYTES } from '@nessy-agent/shared/plugins/mcpb-archive'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { proposeMcpbFromNativePicker } from './mcpb-import'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'nessy-preload-mcpb-'))
  roots.push(root)
  return root
}

function clientHarness() {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const proposal = {
    status: 'installable' as const,
    proposalId: 'proposal-1',
    displaySource: 'MCPB extension',
    detectedFormat: 'mcpb' as const,
    expiresAt: Date.now() + 60_000,
    diagnosticCodes: [],
  }
  const client: RpcClient = {
    async invoke(channel, ...args) {
      calls.push({ channel, args })
      if (channel === RPC_CHANNELS.transfer.START) return { transferId: 'transfer-1' }
      if (channel === RPC_CHANNELS.transfer.COMMIT) return proposal
      return { received: 0 }
    },
    on() { return () => {} },
    handleCapability() {},
  }
  return { calls, client, proposal }
}

describe('preload MCPB import', () => {
  it('keeps the preload dependency on the archive-only leaf export', () => {
    const source = readFileSync(join(import.meta.dir, 'mcpb-import.ts'), 'utf8')
    expect(source).toContain("from '@nessy-agent/shared/plugins/mcpb-archive'")
    expect(source).not.toMatch(/from ['"]@nessy-agent\/shared\/plugins['"]/)
  })

  it('uploads a native-picked regular file without sending its path', async () => {
    const root = temporaryDirectory()
    const archive = join(root, 'extension.mcpb')
    writeFileSync(archive, Buffer.from('mcpb bytes'))
    const { calls, client, proposal } = clientHarness()
    const pickerSpecs: unknown[] = []

    const result = await proposeMcpbFromNativePicker(client, async spec => {
      pickerSpecs.push(spec)
      return { canceled: false, filePaths: [archive] }
    })

    expect(result).toEqual(proposal)
    expect(pickerSpecs).toEqual([{
      title: 'Import MCPB extension',
      properties: ['openFile'],
      filters: [{ name: 'MCPB extensions', extensions: ['mcpb', 'dxt'] }],
    }])
    expect(calls.map(call => call.channel)).toEqual([
      RPC_CHANNELS.transfer.START,
      RPC_CHANNELS.transfer.CHUNK,
      RPC_CHANNELS.transfer.COMMIT,
    ])
    expect(JSON.stringify(calls)).not.toContain(root)
    expect(calls[0]?.args).toMatchObject([{
      channel: RPC_CHANNELS.marketplace.UPLOAD_MCPB,
      totalBytes: 10,
      chunkCount: 1,
      args: [null],
      largeArgIndex: 0,
    }])
  })

  it('rejects symlinks and archives over 256MiB before upload', async () => {
    const root = temporaryDirectory()
    const target = join(root, 'target.mcpb')
    const symlink = join(root, 'symlink.mcpb')
    const oversized = join(root, 'oversized.mcpb')
    writeFileSync(target, 'bytes')
    symlinkSync(target, symlink)
    writeFileSync(oversized, '')
    truncateSync(oversized, MAX_MCPB_ARCHIVE_BYTES + 1)
    const { calls, client } = clientHarness()

    for (const sourcePath of [symlink, oversized]) {
      await expect(proposeMcpbFromNativePicker(
        client,
        async () => ({ canceled: false, filePaths: [sourcePath] }),
      )).resolves.toEqual({
        status: 'unsupported',
        displaySource: 'MCPB extension',
        diagnosticCodes: ['marketplace.mcpb.invalid_archive'],
      })
    }
    expect(calls).toEqual([])
  })
})
