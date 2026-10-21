import { describe, expect, it } from 'bun:test'

import { RPC_ERROR_MARKER, isRpcErrorEnvelope, rehydrateRpcError, toRpcErrorEnvelope } from '../rpc-error'
import { wrapElectronApi } from '../../renderer/lib/rpc-error-rehydration'

/**
 * Lane N. `contextBridge` rebuilds a rejected promise's Error in the renderer
 * world from the message alone — the `code` property, the `name` and even the
 * `stack` are lost (the stack is regenerated, not copied; measured on a
 * packaged build as a single line with zero frames). So the error crosses as a
 * plain envelope and is rebuilt on the far side.
 *
 * `bridged()` reproduces the reconstruction, which is what makes these rows a
 * test of the defect rather than of the helper.
 */
function bridged<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function coded(code: string, message = 'nope'): Error {
  return Object.assign(new Error(message), { code })
}

describe('rpc error envelope', () => {
  it('carries the code across a structured-clone boundary and rebuilds a real Error', () => {
    const rebuilt = rehydrateRpcError(bridged(toRpcErrorEnvelope(coded('SESSION_BUSY'))))

    expect(rebuilt).toBeInstanceOf(Error)
    expect((rebuilt as { code?: string }).code).toBe('SESSION_BUSY')
    expect(rebuilt.message).toBe('nope')
  })

  // The costly one: the only message telling a user their uncommitted work is
  // why the switch was refused. `SESSION_BUSY` is the one reproduced live; this
  // row is why the other is not left to inference.
  it('carries WORKTREE_DIRTY too', () => {
    const rebuilt = rehydrateRpcError(bridged(toRpcErrorEnvelope(coded('WORKTREE_DIRTY'))))
    expect((rebuilt as { code?: string }).code).toBe('WORKTREE_DIRTY')
  })

  // The negative subject: an uncoded failure must keep today's behaviour rather
  // than acquire a fake code, or every transport hiccup renders as a specific
  // and wrong explanation.
  it('does not invent a code for an uncoded failure', () => {
    const envelope = toRpcErrorEnvelope(new Error('socket closed'))
    expect(envelope.code).toBeUndefined()
    const rebuilt = rehydrateRpcError(bridged(envelope))
    expect(rebuilt).toBeInstanceOf(Error)
    expect((rebuilt as { code?: string }).code).toBeUndefined()
    expect(rebuilt.message).toBe('socket closed')
  })

  it('recognises only its own envelopes', () => {
    expect(isRpcErrorEnvelope(toRpcErrorEnvelope(coded('SESSION_BUSY')))).toBe(true)
    // A channel legitimately resolving with data must never be unwrapped as an
    // error. The marker is shape-checked, not merely present.
    expect(isRpcErrorEnvelope({ message: 'a normal DTO with a message field' })).toBe(false)
    expect(isRpcErrorEnvelope({ [RPC_ERROR_MARKER]: true })).toBe(false)
    expect(isRpcErrorEnvelope(null)).toBe(false)
    expect(isRpcErrorEnvelope('string')).toBe(false)
  })
})

describe('wrapElectronApi — built from the channel map, not from the object', () => {
  function fakeApi() {
    const busy = () => Promise.resolve(toRpcErrorEnvelope(coded('SESSION_BUSY')))
    return {
      sessionCommand: busy,
      getSessions: () => Promise.resolve([{ id: 's1' }]),
      capabilities: {
        getCatalog: busy,
        // A listener: returns an unsubscribe FUNCTION, not a promise. Awaiting
        // one would break the subscription.
        onChanged: (cb: unknown) => { void cb; return () => 'unsubscribed' },
      },
      isChannelAvailable: (channel: string) => channel === 'known',
    }
  }

  it('rehydrates a TOP-LEVEL invoke', async () => {
    const api = wrapElectronApi(fakeApi() as never) as unknown as ReturnType<typeof fakeApi>
    await expect(api.sessionCommand()).rejects.toThrow(/nope/)
    await api.sessionCommand().catch((e: unknown) => {
      expect((e as { code?: string }).code).toBe('SESSION_BUSY')
      expect(e).toBeInstanceOf(Error)
    })
  })

  /**
   * The row that separates a fix from a half-fix. 39 methods live one level
   * down (`capabilities` 14, `browserPane` 13, `marketplace` 11, `plugin` 1),
   * and a wrapper that walks top-level callables covers `sessionCommand` while
   * leaving all of them bare — with every switch-refusal test still green.
   */
  it('rehydrates a NESTED invoke', async () => {
    const api = wrapElectronApi(fakeApi() as never) as unknown as ReturnType<typeof fakeApi>
    await api.capabilities.getCatalog().catch((e: unknown) => {
      expect((e as { code?: string }).code).toBe('SESSION_BUSY')
    })
    await expect(api.capabilities.getCatalog()).rejects.toBeInstanceOf(Error)
  })

  it('leaves a listener untouched', () => {
    const api = wrapElectronApi(fakeApi() as never) as unknown as ReturnType<typeof fakeApi>
    expect(api.capabilities.onChanged(() => {})()).toBe('unsubscribed')
  })

  it('leaves a non-channel helper untouched', () => {
    const api = wrapElectronApi(fakeApi() as never) as unknown as ReturnType<typeof fakeApi>
    expect(api.isChannelAvailable('known')).toBe(true)
    expect(api.isChannelAvailable('other')).toBe(false)
  })

  // A successful call must pass its value through unchanged — the wrapper only
  // intercepts envelopes.
  it('passes a successful result through', async () => {
    const api = wrapElectronApi(fakeApi() as never) as unknown as ReturnType<typeof fakeApi>
    expect(await api.getSessions()).toEqual([{ id: 's1' }])
  })
})

/**
 * The install must be `main.tsx`'s FIRST import, and the reason is not style.
 *
 * ES module bodies run before the importing module's own statements, so every
 * transitively imported module gets its chance to touch `window.electronAPI`
 * before any statement in `main.tsx` executes. The install is therefore an
 * import rather than a call, and its POSITION is the safety argument.
 *
 * Asserted structurally rather than left to a comment: there is no
 * import-order rule in this repo's eslint config today, so a future formatter
 * or a well-meant tidy could reorder it silently and nothing else would fail.
 * A disable directive for a rule that is not configured would be inert; this
 * is not.
 */
describe('the rpc install is main.tsx\'s first import', () => {
  it('appears above every other import', async () => {
    const source = await Bun.file(new URL('../../renderer/main.tsx', import.meta.url)).text()
    const imports = source
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('import '))
    expect(imports[0]).toBe("import './lib/install-rpc-api'")
  })
})

/**
 * D1.267 — the two halves are paired by a STRING, and nothing pinned it.
 *
 * The preload publishes the raw surface under `__nessyRpcRaw` precisely so the
 * renderer entry can be the `window.electronAPI` product code reaches. The row
 * that asked for a census of envelope-blind readers found no blind reader and
 * this seam instead: rename that global on either side — or let the preload go
 * back to exposing `electronAPI` itself — and the wrapper installs nothing,
 * every invoke keeps resolving with the envelope `asEnvelopeOnReject` built, and
 * the renderer's awaited reads (271 of them over 72 files, measured
 * 2026-09-18) take an error as data with no `catch` firing and no test failing.
 *
 * Asserted over the SOURCE for the same reason the first-import case above is:
 * there is no runtime in `bun test` where a contextBridge exists, so the only
 * instrument that can see a rename is the text of the two files.
 */
describe('the preload and the renderer entry name the same raw global (D1.267)', () => {
  it('bootstrap exposes it under the raw name, and the entry wraps exactly that', async () => {
    const bootstrap = await Bun.file(new URL('../../preload/bootstrap.ts', import.meta.url)).text()
    const install = await Bun.file(new URL('../../renderer/lib/install-rpc-api.ts', import.meta.url)).text()

    expect(bootstrap).toContain("contextBridge.exposeInMainWorld('__nessyRpcRaw', api)")
    // The negative: exposing the product name directly is the shape that makes
    // the wrapper unreachable, and it is what this file's header forbids.
    expect(bootstrap).not.toContain("exposeInMainWorld('electronAPI'")

    expect(install).toContain('window.__nessyRpcRaw')
    expect(install).toContain('wrapElectronApi(raw)')
  })
})

/**
 * D1.150 — the bridge carries `WireError.data` too, or the field reaches nobody.
 *
 * `CONNECTION_IN_USE` names the chats and automations holding a connection, and
 * those names are user-authored text a translation cannot supply. They arrive on
 * the rebuilt error's `data` (`packages/server-core/src/transport/client.ts`
 * already copies them there) and then meet the same contextBridge this file
 * exists for — which drops every own property, `code` included, per the measured
 * table in the module header. So `data` rides the envelope for exactly the
 * reason `code` does.
 */
describe('the envelope carries a coded error\'s data (D1.150)', () => {
  it('carries it across, and rehydrates it onto the error', () => {
    const thrown = Object.assign(new Error('Connection is still in use'), {
      code: 'CONNECTION_IN_USE',
      data: { sessions: ['Отчёт Q3'], automations: [], moreSessions: 2, moreAutomations: 0 },
    })

    const envelope = toRpcErrorEnvelope(thrown)
    expect(envelope.data).toEqual(thrown.data)
    // The envelope is a PLAIN object, which is the one channel measured to
    // survive structured cloning — so the payload must be plain too.
    expect(JSON.parse(JSON.stringify(envelope)).data).toEqual(thrown.data)

    const rebuilt = rehydrateRpcError(envelope) as Error & { data?: unknown }
    expect(rebuilt.data).toEqual(thrown.data)
    expect((rebuilt as { code?: string }).code).toBe('CONNECTION_IN_USE')
  })

  it('and drops a `data` that comes with no code — two controls', () => {
    // (1) An ordinary rejection that happens to carry a field called `data` is
    //     not this protocol's payload, and forwarding it is how an undeclared
    //     field starts reaching the renderer.
    const uncoded = Object.assign(new Error('boom'), { data: { anything: true } })
    expect(toRpcErrorEnvelope(uncoded).data).toBeUndefined()
    expect('data' in toRpcErrorEnvelope(uncoded)).toBe(false)

    // (2) The unchanged case: a coded error with no data gains no field, so
    //     every existing `catch` sees exactly what it saw before.
    const coded = Object.assign(new Error('nope'), { code: 'SESSION_BUSY' })
    expect('data' in toRpcErrorEnvelope(coded)).toBe(false)
    expect((rehydrateRpcError(toRpcErrorEnvelope(coded)) as { data?: unknown }).data).toBeUndefined()
  })
})
