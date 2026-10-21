import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import type { RpcClient } from '@nessy-agent/server-core/transport'
import {
  hasMcpbArchiveExtension,
  MAX_MCPB_ARCHIVE_BYTES,
} from '@nessy-agent/shared/plugins/mcpb-archive'
import {
  RPC_CHANNELS,
  type SafeMarketplacePluginInstallProposal,
} from '@nessy-agent/shared/protocol'
import { invokeChunked, prepareChunkedBytes } from '../main/chunked-rpc'

const MCPB_PICKER_SPEC = {
  title: 'Import MCPB extension',
  properties: ['openFile'],
  filters: [{ name: 'MCPB extensions', extensions: ['mcpb', 'dxt'] }],
} as const

const UNSUPPORTED_MCPB: Extract<SafeMarketplacePluginInstallProposal, { status: 'unsupported' }> = {
  status: 'unsupported',
  displaySource: 'MCPB extension',
  diagnosticCodes: ['marketplace.mcpb.invalid_archive'],
}

export async function proposeMcpbFromNativePicker(
  client: RpcClient,
  pick: (spec: typeof MCPB_PICKER_SPEC) => Promise<unknown>,
): Promise<SafeMarketplacePluginInstallProposal | null> {
  try {
    const selection = await pick(MCPB_PICKER_SPEC)
    if (!isFileSelection(selection)) return UNSUPPORTED_MCPB
    if (selection.canceled) return null

    const sourcePath = selection.filePaths[0]!
    if (!hasMcpbArchiveExtension(sourcePath)) return UNSUPPORTED_MCPB
    const source = await lstat(sourcePath)
    if (!source.isFile() || source.isSymbolicLink() || source.size < 1 || source.size > MAX_MCPB_ARCHIVE_BYTES) {
      return UNSUPPORTED_MCPB
    }

    const handle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.size !== source.size) return UNSUPPORTED_MCPB
      const bytes = await handle.readFile()
      if (bytes.length !== opened.size) return UNSUPPORTED_MCPB
      return await invokeChunked(
        client,
        RPC_CHANNELS.marketplace.UPLOAD_MCPB,
        [null],
        0,
        undefined,
        prepareChunkedBytes(bytes),
      ) as SafeMarketplacePluginInstallProposal
    } finally {
      await handle.close()
    }
  } catch {
    return UNSUPPORTED_MCPB
  }
}

function isFileSelection(value: unknown): value is { canceled: boolean; filePaths: string[] } {
  if (!value || typeof value !== 'object') return false
  const selection = value as { canceled?: unknown; filePaths?: unknown }
  return typeof selection.canceled === 'boolean'
    && Array.isArray(selection.filePaths)
    && selection.filePaths.every(path => typeof path === 'string')
    && (selection.canceled ? selection.filePaths.length === 0 : selection.filePaths.length === 1)
}
