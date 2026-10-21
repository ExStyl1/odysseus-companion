/**
 * D1.248 — `HANDLED_CHANNELS` and the registrations AGREE, asserted rather than
 * transcribed.
 *
 * ## The class this closes, and it had already happened three times
 *
 * A module's `HANDLED_CHANNELS` is a hand-kept copy of what its registrar hands
 * to `server.handle`, and nothing in `packages/server-core` compared the two.
 * Three separate commits shipped a `server.handle` with no declaration:
 * `notification:*` (P3.317, `0b6f3eada`), `sessions:reconnectMcpServer` +
 * `sessions:getMcpServerStatuses` (`59ad1034c`), and — found by WI-t on
 * 2026-09-17 and fixed by WI-q in `a8a43a793` — `codexSubagents:get/setEnabled`
 * and `primaryDirectory:get/set`, four channels this module registered and
 * declared nowhere while declaring 79 others.
 *
 * Each was caught only by `apps/electron/src/main/handlers/__tests__/registration-profiles.test.ts`,
 * which loads 26 module graphs behind a 600 000 ms hook budget — expensive
 * enough that lanes skip it, and it lives in a different package from the
 * declaration it is checking. This case costs one module graph and fails in the
 * package that owns the mistake.
 *
 * ## Why an ASSERTION and not a DERIVATION
 *
 * The row offers both. A derivation is not available for this shape:
 * `HANDLED_CHANNELS` is read at MODULE level by two Electron registration suites
 * and by the profile sets, i.e. without ever constructing `HandlerDeps`, while
 * the registrations only exist once `registerSettingsHandlers` has been called
 * with a server and deps. Making the registrar return its channels would leave
 * the module-level readers with nothing to import. So the two stay separate and
 * this is the thing that keeps them equal.
 *
 * ## Both directions, because each hides a different defect
 *
 * A channel REGISTERED and not declared is the shape above: the handler works,
 * and every consumer of the declaration (the profile sets, the "core channels
 * only" assertions) is wrong about what this module owns. A channel DECLARED and
 * not registered is the opposite and quieter one: a profile promises a channel
 * that answers nothing, which presents to the renderer as a hang or an unknown
 * channel rather than as a missing feature.
 *
 * In-process and cheap on purpose: the registrar only stores closures, so the
 * recording server below is the whole rig and no handler is ever invoked.
 */

import { describe, expect, it } from 'bun:test'
import type { HandlerFn, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { HANDLED_CHANNELS, registerSettingsHandlers } from '../settings'

/** Every channel `registerSettingsHandlers` actually hands to `server.handle`. */
function registeredChannels(): string[] {
  const channels: string[] = []
  const server = {
    handle(channel: string, _handler: HandlerFn) { channels.push(channel) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as unknown as RpcServer
  // The registrar stores closures and reads nothing at registration time, which
  // is why this stub is enough; a handler that needed a real dep would fail on
  // INVOCATION, and nothing here invokes one.
  const deps = {
    sessionManager: {},
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerSettingsHandlers(server, deps)
  return channels
}

describe('D1.248 · the settings module declares exactly what it registers', () => {
  it('names every channel it registers', () => {
    const declared = new Set<string>(HANDLED_CHANNELS)
    const undeclared = registeredChannels().filter(channel => !declared.has(channel))
    // Named, not counted: the four that were open on 2026-09-17 were found by
    // reading their names out of a failure, and a count would have said only
    // that something was wrong.
    expect(undeclared).toEqual([])
  })

  it('registers every channel it declares', () => {
    const registered = new Set(registeredChannels())
    expect(HANDLED_CHANNELS.filter(channel => !registered.has(channel))).toEqual([])
  })

  it('and the instrument can see a channel at all', () => {
    // The positive control both cases need: an empty registration list satisfies
    // "nothing undeclared" perfectly, and a stub server that silently dropped
    // `handle` would pass the first case forever.
    const registered = registeredChannels()
    expect(registered.length).toBeGreaterThan(50)
    expect(new Set(registered).size).toBe(registered.length)
    expect(new Set(HANDLED_CHANNELS).size).toBe(HANDLED_CHANNELS.length)
  })
})
