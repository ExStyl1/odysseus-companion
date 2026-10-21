/**
 * The retention RPC surface — the reach R12 was missing.
 *
 * `setRetentionDays` and the sweep's paused state were both correct and both
 * unreachable: no channel, no handler, no renderer. These tests assert the
 * channel exists, that the write goes THROUGH the validator rather than around
 * it, and that the payload the settings card renders carries the effective window.
 *
 * In-process on purpose: the root `bunfig.toml` `[test].preload` points
 * `NESSY_CONFIG_DIR` at a private temp directory, so a write here never touches
 * the developer's real `~/.nessy-agent/config.json`. Nothing here runs a sweep;
 * the destructive paths are exercised in `retention-failsafe.isolated.ts`, which
 * builds its own config directory per case.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import {
  CONFIG_DIR,
  getRetentionSettings,
  saveConfig,
  setRetentionDays,
  setRetentionSweepEnabled,
} from '@nessy-agent/shared/config/storage'
import type { HandlerFn, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { registerSettingsHandlers } from '../settings'

// Every config writer in this codebase no-ops when there is no config.json yet
// (`loadStoredConfig()` returns null), so the suite seeds one — and removes it
// again, because `bun test` shares one isolated config directory across files
// and a suite must not leave state behind for the next one.
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

describe('retention RPC surface', () => {
  it('registers the window, the off switch and the read', () => {
    const registered = handlers()
    expect(registered.has(RPC_CHANNELS.retention.GET_SETTINGS)).toBe(true)
    expect(registered.has(RPC_CHANNELS.retention.SET_DAYS)).toBe(true)
    expect(registered.has(RPC_CHANNELS.retention.SET_SWEEP_ENABLED)).toBe(true)
  })

  /**
   * The mutation target. `settings-reference.md#cleanupperioddays` — "**Type**:
   * number of days, a whole number, minimum `1`", "**Default**: `30`", and
   * "Setting `0` fails validation, so pick a large value such as `3650` for
   * long retention." A handler that wrote the
   * value itself instead of calling `setRetentionDays` would put the write back
   * out of the validator's reach, which is exactly the state this task closed.
   */
  it('rejects 0 and every other value below the documented minimum', async () => {
    const registered = handlers()
    const setDays = registered.get(RPC_CHANNELS.retention.SET_DAYS)!
    const before = getRetentionSettings()

    for (const invalid of [0, -7, 1.5, Number.NaN]) {
      await expect(setDays(ctx, invalid)).rejects.toThrow('retentionDays must be an integer >= 1')
    }

    // Nothing was written by any of the refusals.
    expect(getRetentionSettings().days).toBe(before.days)
  })

  it('writes an accepted window and reads it back through the settings payload', async () => {
    const registered = handlers()
    const restore = getRetentionSettings()
    try {
      await registered.get(RPC_CHANNELS.retention.SET_DAYS)!(ctx, 9)
      const settings = await registered.get(RPC_CHANNELS.retention.GET_SETTINGS)!(ctx)
      expect(settings).toMatchObject({ days: 9, sweepEnabled: true, effectiveDays: 9, source: 'user', minDays: 1 })
    } finally {
      setRetentionDays(restore.days)
      setRetentionSweepEnabled(restore.sweepEnabled)
    }
  })

  it('turns the sweep off without inventing a window, and back on again', async () => {
    const registered = handlers()
    const setEnabled = registered.get(RPC_CHANNELS.retention.SET_SWEEP_ENABLED)!
    const restore = getRetentionSettings()
    try {
      await setEnabled(ctx, false)
      const off = await registered.get(RPC_CHANNELS.retention.GET_SETTINGS)!(ctx) as { sweepEnabled: boolean; effectiveDays: number; days: number }
      // Off means the sweep does not run — `effectiveDays: 0` — while the window
      // the user chose is preserved rather than replaced by a huge number.
      expect(off.sweepEnabled).toBe(false)
      expect(off.effectiveDays).toBe(0)
      expect(off.days).toBe(restore.days)

      await setEnabled(ctx, true)
      expect((await registered.get(RPC_CHANNELS.retention.GET_SETTINGS)!(ctx) as { effectiveDays: number }).effectiveDays)
        .toBe(restore.days)
    } finally {
      setRetentionSweepEnabled(restore.sweepEnabled)
    }
  })

  it('refuses a non-boolean off switch', async () => {
    const setEnabled = handlers().get(RPC_CHANNELS.retention.SET_SWEEP_ENABLED)!
    await expect(setEnabled(ctx, 'yes')).rejects.toThrow('must be a boolean')
  })
})
