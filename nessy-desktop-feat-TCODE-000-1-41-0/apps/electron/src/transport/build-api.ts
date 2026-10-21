/**
 * Build the client API proxy.
 *
 * Replaces the 329-line preload. The ElectronAPI TypeScript interface still
 * enforces types at compile time — this proxy provides runtime dispatch.
 */

import type { RpcClient } from '@nessy-agent/server-core/transport'
import type { ElectronAPI } from '../shared/types'
import { toRpcErrorEnvelope } from '../shared/rpc-error'

/**
 * A rejection becomes a RESOLVED envelope here, at the one seam every channel
 * passes through.
 *
 * `contextBridge` rebuilds a rejected promise's Error in the renderer world
 * from the message alone — the property, the name and even the stack are lost
 * (the stack is regenerated, not copied). A plain object survives intact, so
 * the error crosses as data and `installRpcErrorRehydration` turns it back into
 * a real Error in the MAIN world, where `instanceof Error` and `error.code`
 * both hold again.
 *
 * The envelope must never reach product code. That is the renderer entry's job
 * and it is asserted in tests; a consumer that ever sees one is reading the raw
 * preload object rather than the wrapped API.
 */
function asEnvelopeOnReject(result: Promise<any>): Promise<any> {
  return result.catch((error: unknown) => toRpcErrorEnvelope(error))
}

// ---------------------------------------------------------------------------
// Channel map entry
// ---------------------------------------------------------------------------

export type ChannelMapEntry =
  | { type: 'invoke'; channel: string; transform?: (result: any) => any }
  | { type: 'listener'; channel: string }

export type ChannelMap = Record<string, ChannelMapEntry>

// ---------------------------------------------------------------------------
// Proxy builder
// ---------------------------------------------------------------------------

export function buildClientApi(
  client: RpcClient,
  channelMap: ChannelMap,
  isChannelAvailable?: (channel: string) => boolean,
): ElectronAPI {
  const api: Record<string, any> = {}
  const nested: Record<string, Record<string, any>> = {}

  for (const [key, entry] of Object.entries(channelMap)) {
    let fn: (...a: any[]) => any
    if (entry.type === 'listener') {
      fn = (cb: (...args: any[]) => void) => client.on(entry.channel, cb)
    } else if (entry.transform) {
      const t = entry.transform
      // The transform runs only on success; a rejection is enveloped instead,
      // so a transform never has to defend against an error value.
      fn = (...args: any[]) => asEnvelopeOnReject(
        client.invoke(entry.channel, ...args).then(result => t(result)),
      )
    } else {
      fn = (...args: any[]) => asEnvelopeOnReject(client.invoke(entry.channel, ...args))
    }

    // Dotted keys like "browserPane.create" become nested: api.browserPane.create
    const dotIdx = key.indexOf('.')
    if (dotIdx !== -1) {
      const ns = key.slice(0, dotIdx)
      const method = key.slice(dotIdx + 1)
      if (!nested[ns]) nested[ns] = {}
      nested[ns][method] = fn
    } else {
      api[key] = fn
    }
  }

  // Attach nested namespaces as plain objects
  for (const [ns, methods] of Object.entries(nested)) {
    api[ns] = methods
  }

  // Expose channel availability check for GUI-aware code
  api.isChannelAvailable = isChannelAvailable ?? (() => true)

  return api as ElectronAPI
}
