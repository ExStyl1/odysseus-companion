/**
 * Carrying an RPC error's `code` across the contextBridge.
 *
 * ## What is broken, measured rather than reasoned
 *
 * The transport is not at fault. `ws-rpc-server` maps a thrown `CodedError`
 * through `isErrorCode` and sends `{ code, message }`; the client rebuilds an
 * `Error` and re-attaches `err.code`. Both halves are correct.
 *
 * The value then crosses `contextBridge.exposeInMainWorld`, and Electron
 * reconstructs a rejected promise's Error in the renderer world with the
 * message alone. Measured on a packaged build, Electron 39.2.7:
 *
 * | channel | survives? | evidence |
 * | --- | --- | --- |
 * | own property `code` | no | `getOwnPropertyNames` → `["stack","message"]` |
 * | `name` | no | `CodedError` sets `CodedError`; the renderer reads `Error` |
 * | `stack` | no — REGENERATED | the renderer receives `Error: <message>`, one line, zero frames |
 * | `message` | yes | translated and user-visible, so not usable as a channel |
 *
 * A first fix smuggled the code through `stack`; it shipped into a packaged
 * build and was **inert**, because that row is a regeneration rather than a
 * copy. That measurement is why this file does not try to make an Error carry
 * anything.
 *
 * ## The shape that works
 *
 * Stop letting an Error be the thing that crosses. The preload seam RESOLVES
 * with a plain envelope — plain objects survive structured cloning, which is
 * the one thing measured to work — and the renderer entry, running in the MAIN
 * world, turns the envelope back into a real `Error` and throws it.
 *
 * The Error is then constructed where it is consumed, so `instanceof Error`
 * holds, `error.code` is present, `message` stays clean and translatable, and
 * no call site changes: the wrapper still throws, exactly as before.
 *
 * The envelope must never escape the transport wrapper. If one is ever seen by
 * product code, the wrapper was bypassed — which is why `isRpcErrorEnvelope` is
 * exported and asserted in tests rather than kept private.
 */

/**
 * Marker key. Deliberately not a value any channel could resolve with: it is a
 * symbol-ish string, not a field name any DTO in this app uses, and every
 * envelope is additionally shape-checked before it is unwrapped.
 */
export const RPC_ERROR_MARKER = '__nessyRpcError__' as const

export interface RpcErrorEnvelope {
  readonly [RPC_ERROR_MARKER]: true
  /** The wire `ErrorCode`, when the thrown error carried one. */
  readonly code?: string
  /**
   * D1.150 — `WireError.data`, the part of a refusal a translation cannot
   * supply: `CONNECTION_IN_USE` names the chats and automations still holding a
   * connection, and those names are user-authored text the renderer must print
   * verbatim beside a sentence it builds itself.
   *
   * It rides the envelope for exactly the reason the header above gives. A
   * rejected promise's Error loses every own property across
   * `contextBridge.exposeInMainWorld`, `code` included — that is the measured
   * table at the top of this file — so `data` would be lost the same way. A
   * plain object survives structured cloning, and `data` is one: the
   * `CONNECTION_IN_USE` payload is string arrays and numbers.
   *
   * `unknown` and not a union of payload types: this seam is generic and every
   * consumer already narrows on `code` first. Typing it per code would put the
   * protocol's error vocabulary into the bridge, where it has no reader.
   */
  readonly data?: unknown
  readonly message: string
}

/** True only for an envelope this module produced. */
export function isRpcErrorEnvelope(value: unknown): value is RpcErrorEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record[RPC_ERROR_MARKER] === true && typeof record.message === 'string'
}

/**
 * Package a rejection for the trip across the bridge.
 *
 * A NON-coded failure keeps today's behaviour rather than gaining a fake code:
 * the envelope carries no `code`, the renderer rethrows a plain `Error`, and
 * every existing `catch` sees what it saw before.
 */
export function toRpcErrorEnvelope(error: unknown): RpcErrorEnvelope {
  const record = (typeof error === 'object' && error !== null)
    ? error as { code?: unknown; data?: unknown; message?: unknown }
    : null
  const code = typeof record?.code === 'string' && /^[A-Z0-9_]+$/.test(record.code)
    ? record.code
    : undefined
  const message = typeof record?.message === 'string' ? record.message : String(error)
  // D1.150 — carried only beside a `code`. A `data` on an error with no code is
  // not this protocol's payload, and forwarding an arbitrary object across the
  // bridge is how a field nobody declared starts reaching the renderer.
  const data = code !== undefined ? record?.data : undefined
  return {
    [RPC_ERROR_MARKER]: true,
    ...(code ? { code } : {}),
    ...(data !== undefined ? { data } : {}),
    message,
  }
}

/**
 * Rebuild the Error — in whichever world this runs in.
 *
 * Called from the renderer entry, so the object is a main-world `Error` and
 * `instanceof Error` holds for every consumer.
 */
export function rehydrateRpcError(envelope: RpcErrorEnvelope): Error {
  const error = new Error(envelope.message)
  if (envelope.code) {
    ;(error as { code?: string }).code = envelope.code
    error.name = 'CodedError'
  }
  // D1.150 — the same shape `packages/server-core/src/transport/client.ts`
  // already puts on the error it rebuilds, so a renderer reads `error.data`
  // whichever side of the bridge it is on.
  if (envelope.data !== undefined) (error as { data?: unknown }).data = envelope.data
  return error
}
