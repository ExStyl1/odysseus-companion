/**
 * P6.868 — the `crossSessionInbound` RPC pair, the surface half of the row.
 *
 * The shared half landed first (`4c27aadef`): four states in one read, and a
 * writer for the fourth. It had no reach — no channel, no handler, no renderer —
 * which is the same shape R12 left retention in, and these tests are its
 * siblings.
 *
 * Two things are asserted, because either alone would let the surface lie:
 *  1. `null` CLEARS the key, rather than storing a sentinel — the page's
 *     *"unset, so Claude Code decides per message"* is a documented behaviour of
 *     its own, and a sentinel would make the app's unset and a hand-edited file's
 *     unset two different states;
 *  2. a value outside the vendor's three is REFUSED at the handler, not stored
 *     and dropped later by the reader — a value that persists and does nothing is
 *     the stated-but-not-enforced shape this key's own module exists to avoid.
 *
 * In-process on purpose: the root `bunfig.toml` `[test].preload` points
 * `NESSY_CONFIG_DIR` at a private temp directory, so a write here never touches
 * the developer's real `~/.nessy-agent/config.json`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import {
  CONFIG_DIR,
  CROSS_SESSION_INBOUND_ENV_NAME,
  getCrossSessionInbound,
  getCrossSessionInboundSettings,
  saveConfig,
} from '@nessy-agent/shared/config/storage'
import type { HandlerFn, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { registerSettingsHandlers } from '../settings'

const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
let seeded = false

beforeAll(() => {
  if (existsSync(CONFIG_FILE)) return
  saveConfig({ workspaceRefs: [], activeWorkspaceId: null, activeSessionId: null })
  seeded = true
})

afterAll(() => {
  if (seeded) rmSync(CONFIG_FILE, { force: true })
})

afterEach(async () => {
  const clear = handlers().get(RPC_CHANNELS.settings.SET_CROSS_SESSION_INBOUND)!
  await clear(ctx, null)
})

function handlers(): Map<string, HandlerFn> {
  const registered = new Map<string, HandlerFn>()
  const server = {
    handle(channel: string, handler: HandlerFn) { registered.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as RpcServer
  const deps = {
    sessionManager: {},
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerSettingsHandlers(server, deps)
  return registered
}

const ctx = { clientId: 'client-a', workspaceId: 'ws-a', webContentsId: null }

describe('P6.868 — the cross-session inbound RPC pair', () => {
  it('registers the read and the write', () => {
    const registered = handlers()
    expect(registered.has(RPC_CHANNELS.settings.GET_CROSS_SESSION_INBOUND)).toBe(true)
    expect(registered.has(RPC_CHANNELS.settings.SET_CROSS_SESSION_INBOUND)).toBe(true)
  })

  it('writes one of the three and reads it back through the resolved view', async () => {
    const registered = handlers()
    const write = registered.get(RPC_CHANNELS.settings.SET_CROSS_SESSION_INBOUND)!
    const read = registered.get(RPC_CHANNELS.settings.GET_CROSS_SESSION_INBOUND)!

    expect(await write(ctx, 'hold')).toBe(true)
    // Read into a local BEFORE asserting a shape: `toMatchObject` with an
    // asymmetric matcher overwrites the field it matched (AGENTS.md §Traps).
    const view = await read(ctx)
    expect(view).toEqual({ mode: 'hold', operatorLocked: false })
    expect(getCrossSessionInbound()).toBe('hold')
  })

  /**
   * The fourth state, as a write. `null` deletes the key — the read then reports
   * `mode: undefined`, which is the page's documented default and not `accept`.
   */
  it('clears the key on null rather than storing a sentinel', async () => {
    const registered = handlers()
    const write = registered.get(RPC_CHANNELS.settings.SET_CROSS_SESSION_INBOUND)!
    const read = registered.get(RPC_CHANNELS.settings.GET_CROSS_SESSION_INBOUND)!

    await write(ctx, 'refuse')
    expect(await write(ctx, null)).toBe(true)

    const view = await read(ctx) as { mode?: string }
    expect(view.mode).toBeUndefined()
    expect(getCrossSessionInbound()).toBeUndefined()
    // Not merely absent from the view — absent from the FILE, so a later reader
    // of `config.json` sees no key at all.
    expect(getCrossSessionInboundSettings().mode).toBeUndefined()
  })

  it('refuses anything outside the vendor spelling instead of storing it', async () => {
    const registered = handlers()
    const write = registered.get(RPC_CHANNELS.settings.SET_CROSS_SESSION_INBOUND)!

    for (const invalid of ['reject', 'HOLD', '', 7, true, {}]) {
      await expect(write(ctx, invalid)).rejects.toThrow('cross-session inbound mode must be one of')
    }
    expect(getCrossSessionInbound()).toBeUndefined()
  })

  /**
   * The operator rung has no writer here on purpose: an in-app control that
   * appeared to relax an environment value would write something the resolver
   * then ignores. The READ reports it, so the surface can say so.
   */
  it('reports the operator lock without offering a way to change it', async () => {
    const registered = handlers()
    const read = registered.get(RPC_CHANNELS.settings.GET_CROSS_SESSION_INBOUND)!
    const before = process.env[CROSS_SESSION_INBOUND_ENV_NAME]
    // `delete` first, then assign: Bun 1.3.14 leaves a plain assignment
    // invisible to `Object.keys` and to every spread (AGENTS.md §Traps).
    delete process.env[CROSS_SESSION_INBOUND_ENV_NAME]
    process.env[CROSS_SESSION_INBOUND_ENV_NAME] = 'refuse'
    try {
      const view = await read(ctx) as { operatorLocked: boolean; operatorMode?: string }
      expect(view.operatorLocked).toBe(true)
      expect(view.operatorMode).toBe('refuse')
    } finally {
      delete process.env[CROSS_SESSION_INBOUND_ENV_NAME]
      if (before !== undefined) process.env[CROSS_SESSION_INBOUND_ENV_NAME] = before
    }
  })
})
