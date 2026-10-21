/**
 * D1.282 — the dormant web surface builds the SAME client API and has to undo
 * the same envelope.
 *
 * `buildClientApi` resolves a failed call with `{ __nessyRpcError__: true, … }`
 * instead of rejecting, because a rejected promise's `Error` loses `code`,
 * `name` and its stack crossing Electron's contextBridge (`shared/rpc-error.ts`
 * carries that measurement). The Electron renderer undoes it in its entry —
 * `lib/install-rpc-api.ts` publishes `window.electronAPI` as
 * `wrapElectronApi(raw)` — and this adapter, which builds the same API from the
 * same `CHANNEL_MAP` and assigns it to the same global, had only the first half.
 *
 * The consequence is not "an error is worded oddly": a reader ported from the
 * renderer takes a FAILURE AS DATA. Its `catch` never fires, the value it
 * received is an object rather than the DTO, and a fail-soft consumer renders
 * an empty list for a failed call — silently, on a surface where no test fails.
 *
 * Two halves, because either alone passes on the bug: the wrapper's BEHAVIOUR
 * over a real `buildClientApi` proxy, and the adapter's own composition read
 * from source (the adapter cannot be imported here — its module body reaches
 * for `window.matchMedia`, `i18next` and a WebSocket client).
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildClientApi } from '../../../../electron/src/transport/build-api'
import { wrapElectronApi } from '../../../../electron/src/renderer/lib/rpc-error-rehydration'
import { isRpcErrorEnvelope } from '../../../../electron/src/shared/rpc-error'

/** A client whose every invoke fails with the shape the wire really produces. */
function failingClient(error: unknown): { invoke: () => Promise<never>; on: () => () => void } {
  return {
    invoke: () => Promise.reject(error),
    on: () => () => {},
  }
}

function codedError(): Error {
  const error = new Error('That connection is in use.') as Error & { code: string; data: unknown }
  error.code = 'CONNECTION_IN_USE'
  error.data = { chats: ['one'] }
  return error
}

/**
 * The two channel shapes that matter — a top-level key and a NAMESPACED one —
 * and the keys are the REAL map's, measured rather than invented.
 *
 * `wrapElectronApi` walks the real `CHANNEL_MAP`, not whatever map built the
 * object, so an invented key produces an object the wrapper never touches and
 * the case reads as "the namespace is not wrapped". The first draft of this
 * file used `capabilities.list`, which no channel map declares, and it failed
 * exactly that way.
 */
const MAP = {
  getSessions: { type: 'invoke' as const, channel: 'sessions:list' },
  'capabilities.getCatalog': { type: 'invoke' as const, channel: 'capabilities:getCatalog' },
  onSessionEvent: { type: 'listener' as const, channel: 'sessions:event' },
}

describe('the web adapter rehydrates a failed call (D1.282)', () => {
  it('the RAW proxy RESOLVES with an envelope — the state this surface shipped in', async () => {
    // The negative half, and it is what makes the positive one mean something:
    // without the wrapper the call does not throw at all, so a `try`/`catch`
    // reader receives the envelope as if it were the answer.
    const raw = buildClientApi(failingClient(codedError()) as never, MAP) as unknown as
      Record<string, () => Promise<unknown>>
    const value = await raw.getSessions()
    expect(isRpcErrorEnvelope(value)).toBe(true)
  })

  it('the WRAPPED proxy throws a real Error carrying `code` and `data`', async () => {
    const wrapped = wrapElectronApi(
      buildClientApi(failingClient(codedError()) as never, MAP) as unknown as Record<string, unknown>,
    ) as Record<string, () => Promise<unknown>>
    let thrown: unknown
    try {
      await wrapped.getSessions()
    } catch (cause) {
      thrown = cause
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe('That connection is in use.')
    expect((thrown as { code?: string }).code).toBe('CONNECTION_IN_USE')
    expect((thrown as { data?: unknown }).data).toEqual({ chats: ['one'] })
  })

  it('a NAMESPACED method is wrapped too, and a listener is left alone', async () => {
    // The namespace arm is why the wrapper walks `CHANNEL_MAP` instead of the
    // object: 39 of the methods sit one level down, and a walker that wrapped
    // top-level callables would leave every one of them returning an envelope
    // while the case everyone tests (`getSessions`) passed.
    const wrapped = wrapElectronApi(
      buildClientApi(failingClient(codedError()) as never, MAP) as unknown as Record<string, unknown>,
    ) as Record<string, unknown>
    const capabilities = wrapped.capabilities as Record<string, () => Promise<unknown>>
    await expect(capabilities.getCatalog()).rejects.toThrow('That connection is in use.')
    // A listener returns an unsubscribe FUNCTION, not a promise; awaiting one
    // would break the subscription, so it must come through untouched.
    const unsubscribe = (wrapped.onSessionEvent as (cb: () => void) => unknown)(() => {})
    expect(typeof unsubscribe).toBe('function')
  })

  it('the adapter composes its API from the WRAPPED object, not the raw one', () => {
    // The behaviour above is the renderer's module and would pass whatever this
    // adapter does with it. This is the adapter's own wiring, and it is read
    // from source because importing the module here costs a WebSocket client,
    // `i18next` and `window.matchMedia`.
    const source = readFileSync(join(import.meta.dir, '..', 'web-api.ts'), 'utf8')
    const assignment = source.split('\n').filter(line => /^\s*const (raw|base)Api = /.test(line))
    // Non-vacuity: both assignments, or the lines below assert nothing.
    expect(assignment).toHaveLength(2)
    expect(assignment.find(line => line.includes('rawApi'))).toContain('buildClientApi(')
    expect(assignment.find(line => line.includes('baseApi'))).toContain('wrapElectronApi(')
    const composed = source.split('\n').filter(line => line.includes('} as ElectronAPI'))
    expect(composed).toHaveLength(1)
    expect(composed[0]).toContain('...baseApi')
    expect(composed[0]).not.toContain('...rawApi')
  })
})
