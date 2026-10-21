/**
 * P6.319 — the workflow size guideline's RPC surface.
 *
 * The guideline was resolvable, prompt-visible and threshold-moving long before
 * this, and reachable from nowhere: `git grep sizeGuideline` over the renderer
 * scored 0, so an install could neither set it nor read what it had. These tests
 * assert the two channels exist, that the write goes THROUGH the union's own
 * parser rather than around it, and — the half the row's done_means names — that
 * `large` moves the advisory large-run threshold 25 → 50 on the read-back.
 *
 * In-process on purpose, exactly as `settings-retention.test.ts` is: the root
 * `bunfig.toml` `[test].preload` points `NESSY_CONFIG_DIR` at a private temp
 * directory, so a write here never touches the developer's real
 * `~/.nessy-agent/config.json`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { CONFIG_DIR, loadStoredConfig, saveConfig } from '@nessy-agent/shared/config/storage'
import {
  LARGE_WORKFLOW_AGENT_THRESHOLD,
  WORKFLOW_SIZE_GUIDELINES,
} from '@nessy-agent/shared/config/workflow-settings'
import type { SafeWorkflowSettingsView } from '@nessy-agent/shared/protocol/capabilities'
import type { HandlerFn, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { registerSettingsHandlers } from '../settings'

// Every config writer here no-ops without a config.json, so the suite seeds one
// and removes it again — `bun test` shares one isolated config directory across
// files and a suite must not leave state behind for the next.
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
let seeded = false

beforeAll(() => {
  if (existsSync(CONFIG_FILE)) return
  saveConfig({ workspaceRefs: [], activeWorkspaceId: null, activeSessionId: null })
  seeded = true
})

afterAll(() => {
  if (seeded) {
    rmSync(CONFIG_FILE, { force: true })
    return
  }
  // Not ours to delete — but the `workflow` key IS ours to undo.
  const config = loadStoredConfig()
  if (config) {
    const { workflow: _dropped, ...rest } = config
    saveConfig(rest)
  }
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

const read = async (): Promise<SafeWorkflowSettingsView> =>
  await handlers().get(RPC_CHANNELS.settings.GET_WORKFLOW)!(ctx) as SafeWorkflowSettingsView

describe('workflow settings RPC surface', () => {
  it('registers the resolved read and the one writable key', () => {
    const registered = handlers()
    expect(registered.has(RPC_CHANNELS.settings.GET_WORKFLOW)).toBe(true)
    expect(registered.has(RPC_CHANNELS.settings.SET_WORKFLOW_SIZE_GUIDELINE)).toBe(true)
    // The two off switches are tighter-wins in the resolver, so no channel
    // pretends a user control could relax them.
    expect([...registered.keys()].some(channel => /disableWorkflows|keywordTrigger/i.test(channel))).toBe(false)
  })

  /**
   * `workflows.md` §Set a size guideline — the guideline moves the advisory
   * large-run warning, and `large` is the value that moves it furthest. Our own
   * default is `unrestricted`, which is why the baseline read is 25 rather than
   * the vendor's `medium`/15 (the divergence stated in `workflow-settings.ts`).
   */
  it('moves the advisory threshold from the 25-agent baseline to 50 on large', async () => {
    const before = await read()
    expect(before.sizeGuideline).toBe('unrestricted')
    expect(before.agentThreshold).toBe(LARGE_WORKFLOW_AGENT_THRESHOLD)
    expect(before.agentThreshold).toBe(25)
    // Nothing was set by this user yet, so the control has no choice to show.
    expect(before.userSizeGuideline).toBeUndefined()

    await handlers().get(RPC_CHANNELS.settings.SET_WORKFLOW_SIZE_GUIDELINE)!(ctx, 'large')

    const after = await read()
    expect(after.sizeGuideline).toBe('large')
    expect(after.agentThreshold).toBe(50)
    // And the value is attributed to this user, which is what lets the page say
    // whether it is showing your choice or a layer above you.
    expect(after.userSizeGuideline).toBe('large')
    // The off switches are untouched by a guideline write.
    expect(after.disableWorkflows).toBe(false)
    expect(after.keywordTriggerEnabled).toBe(true)

    // Every documented value round-trips, so the row cannot offer one the
    // resolver refuses.
    for (const guideline of WORKFLOW_SIZE_GUIDELINES) {
      await handlers().get(RPC_CHANNELS.settings.SET_WORKFLOW_SIZE_GUIDELINE)!(ctx, guideline)
      expect((await read()).sizeGuideline).toBe(guideline)
    }
  })

  it('refuses a value the union does not carry, and writes nothing', async () => {
    await handlers().get(RPC_CHANNELS.settings.SET_WORKFLOW_SIZE_GUIDELINE)!(ctx, 'medium')
    const before = await read()

    for (const invalid of ['huge', '', 'MEDIUM', 42, null, { sizeGuideline: 'large' }]) {
      await expect(
        handlers().get(RPC_CHANNELS.settings.SET_WORKFLOW_SIZE_GUIDELINE)!(ctx, invalid),
      ).rejects.toThrow()
    }

    // The refusals went through the parser, not past it: the stored value is
    // exactly what it was, rather than a default the next load would invent.
    expect((await read()).sizeGuideline).toBe(before.sizeGuideline)
    expect((await read()).sizeGuideline).toBe('medium')
  })
})
