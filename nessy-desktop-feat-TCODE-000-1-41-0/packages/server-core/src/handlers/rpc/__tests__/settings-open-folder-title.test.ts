/**
 * P6.623 — `dialog:openFolder` carries the caller's title.
 *
 * The channel already existed and already used Electron's own
 * `showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })` through
 * the client capability, so the download-folder Browse button needed no new
 * channel — the row's premise that it did is refuted in the lane report. What it
 * DID need is a title: the handler hardcoded `Select Working Directory`, its
 * one caller's wording, and a picker that says that while the user is choosing
 * where downloads land is a lie the user has no way to correct.
 *
 * Two directions are asserted, because widening a shared channel can break the
 * caller it was written for: a supplied title reaches the capability spec, and
 * an absent or unusable one leaves the working-directory picker exactly as it
 * was. The `properties` array is asserted in both, since that is what makes it a
 * FOLDER picker rather than a file one.
 */

import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { HandlerFn, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { registerSettingsHandlers } from '../settings'

interface DialogSpec { title?: string; properties?: string[] }

/**
 * The registered handlers plus the specs the client capability was asked for.
 * `invokeClient` returns a picked path, so the handler's own return value is
 * exercised too rather than short-circuiting on a cancel.
 */
function harness(picked: { canceled: boolean; filePaths: string[] }) {
  const specs: DialogSpec[] = []
  const registered = new Map<string, HandlerFn>()
  const server = {
    handle(channel: string, handler: HandlerFn) { registered.set(channel, handler) },
    push() {},
    async invokeClient(_clientId: string, _capability: string, spec: DialogSpec) {
      specs.push(spec)
      return picked
    },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as unknown as RpcServer
  const deps = {
    sessionManager: {},
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerSettingsHandlers(server, deps)
  return { registered, specs }
}

const ctx = { clientId: 'client-a', workspaceId: 'ws-a', webContentsId: null }

describe('P6.623 — the folder picker takes its title from the caller', () => {
  it('passes a supplied title through to the native dialog, still as a folder picker', async () => {
    const { registered, specs } = harness({ canceled: false, filePaths: ['/Users/you/Downloads/nessy'] })
    const handler = registered.get(RPC_CHANNELS.dialog.OPEN_FOLDER)
    expect(handler).toBeDefined()

    const picked = await handler!(ctx, { title: 'Select the download folder' })

    expect(specs).toHaveLength(1)
    expect(specs[0]?.title).toBe('Select the download folder')
    expect(specs[0]?.properties).toEqual(['openDirectory', 'createDirectory'])
    expect(picked).toBe('/Users/you/Downloads/nessy')
  })

  it('NEGATIVE: no title, an empty one and a non-string all keep the working-directory wording', async () => {
    // The caller this channel was written for passes nothing at all, so the
    // default is what stops P6.623 from being a regression for it. The junk
    // cases matter because the parameter now crosses the RPC boundary.
    for (const params of [undefined, {}, { title: '   ' }, { title: 42 } as unknown as { title?: string }]) {
      const { registered, specs } = harness({ canceled: true, filePaths: [] })
      const handler = registered.get(RPC_CHANNELS.dialog.OPEN_FOLDER)!
      const picked = await handler(ctx, params)

      expect(specs[0]?.title).toBe('Select Working Directory')
      expect(specs[0]?.properties).toEqual(['openDirectory', 'createDirectory'])
      // A cancel writes nothing and says so, unchanged by the widening.
      expect(picked).toBeNull()
    }
  })
})
