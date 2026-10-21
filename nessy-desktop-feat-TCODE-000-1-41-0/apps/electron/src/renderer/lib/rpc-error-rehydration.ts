/**
 * Turn the preload's error envelopes back into real Errors, in the MAIN world.
 *
 * `build-api.ts` resolves with a plain `RpcErrorEnvelope` instead of rejecting,
 * because `contextBridge` strips everything but the message from an Error that
 * crosses it. This is the other half: it runs in renderer code, so the Error it
 * constructs is a main-world Error — `instanceof Error` holds and `error.code`
 * is present, which is what `ChatPage`'s refusal toasts branch on.
 *
 * ## Built from the CHANNEL MAP, never by walking the exposed object
 *
 * The map knows two things the object does not, and both produce a half-fix if
 * guessed:
 *
 * - **Namespaces.** `buildClientApi` splits a dotted key into a nested object,
 *   so `capabilities` (14 methods), `browserPane` (13), `marketplace` (11) and
 *   `plugin` (1) sit one level down — 39 of the methods that need wrapping. A
 *   walker that wraps top-level callables covers `sessionCommand`, the case
 *   everyone looks at, and silently leaves the other 39 throwing bare errors
 *   while every test written against the switch refusal passes.
 * - **Listeners.** `onChanged` and friends return an unsubscribe FUNCTION, not
 *   a promise. Awaiting one would break the subscription.
 *
 * Walking the map makes both fall out by construction instead of being
 * rediscovered.
 */

import { CHANNEL_MAP } from '../../transport/channel-map'
import { isRpcErrorEnvelope, rehydrateRpcError } from '../../shared/rpc-error'

type AnyFn = (...args: unknown[]) => unknown

function wrapInvoke(fn: AnyFn): AnyFn {
  return (...args: unknown[]) => {
    const result = fn(...args)
    if (!(result instanceof Promise)) return result
    return result.then(value => {
      if (isRpcErrorEnvelope(value)) throw rehydrateRpcError(value)
      return value
    })
  }
}

/**
 * Wrap every invoke method the channel map declares, leaving listeners and
 * non-channel helpers (`isChannelAvailable`) exactly as they are.
 *
 * Returns a NEW object rather than mutating the exposed one: a
 * contextBridge-exposed object may be frozen, and a silent no-op mutation is
 * the failure mode this whole lane exists to avoid.
 */
export function wrapElectronApi<T extends Record<string, unknown>>(api: T): T {
  const wrapped: Record<string, unknown> = { ...api }
  const namespaces = new Map<string, Record<string, unknown>>()

  for (const [key, entry] of Object.entries(CHANNEL_MAP)) {
    if ((entry as { type: string }).type !== 'invoke') continue

    const dot = key.indexOf('.')
    if (dot === -1) {
      const fn = api[key]
      if (typeof fn === 'function') wrapped[key] = wrapInvoke(fn as AnyFn)
      continue
    }

    const ns = key.slice(0, dot)
    const method = key.slice(dot + 1)
    const source = api[ns]
    if (typeof source !== 'object' || source === null) continue

    let target = namespaces.get(ns)
    if (!target) {
      target = { ...(source as Record<string, unknown>) }
      namespaces.set(ns, target)
      wrapped[ns] = target
    }
    const fn = (source as Record<string, unknown>)[method]
    if (typeof fn === 'function') target[method] = wrapInvoke(fn as AnyFn)
  }

  return wrapped as T
}
