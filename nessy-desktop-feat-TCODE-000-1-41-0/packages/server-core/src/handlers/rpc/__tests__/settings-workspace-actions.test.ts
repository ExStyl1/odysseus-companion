/**
 * P6.361's entry point — the seam, not the store.
 *
 * W8-r landed the store, the per-platform resolution and the kill switch
 * (`config/workspace-actions.ts`, 26 cases of its own). What this file pins is
 * the part that could go wrong in the entry point and nowhere else:
 *
 *  - the channel takes an **id**, never a command, so the renderer cannot become
 *    a second route to arbitrary shell beside the one that asks for approval;
 *  - the resolution is re-done on the HOST at RUN time, so an action removed (or
 *    an operator switch flipped) between the render and the click is refused
 *    rather than executed from a stale list;
 *  - execution is `SessionManager.runShellCommand` and nothing else, which is
 *    the row's clause *"under the same command approval the agent's Bash goes
 *    through"*;
 *  - the refusal does not distinguish "no such action" from "actions are turned
 *    off", because the read answers `[]` for both and a caller has no business
 *    learning that a policy exists.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { CONFIG_DIR, loadStoredConfig, saveConfig } from '@nessy-agent/shared/config/storage'
import type { HandlerFn, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { registerSettingsHandlers } from '../settings'

const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

function seed(extra: Record<string, unknown>): void {
  saveConfig({
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    ...extra,
  } as never)
}

function harness() {
  const ran: Array<{ sessionId: string; command: string; workspaceId: string | undefined; relativeCwd: string | undefined }> = []
  const registered = new Map<string, HandlerFn>()
  const server = {
    handle(channel: string, handler: HandlerFn) { registered.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as RpcServer
  const deps = {
    sessionManager: {
      async runShellCommand(sessionId: string, command: string, workspaceId?: string, relativeCwd?: string) {
        ran.push({ sessionId, command, workspaceId, relativeCwd })
        return { success: true, executed: true, command }
      },
    },
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerSettingsHandlers(server, deps)
  return { registered, ran }
}

const ctx = { clientId: 'client-a', workspaceId: 'ws-a', webContentsId: null }

const DEV_SERVER = { id: 'dev', name: 'Dev server', command: 'bun run dev' }

beforeEach(() => { seed({ workspaceActions: [DEV_SERVER] }) })
afterEach(() => { if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE, { force: true }) })

describe('the saved-action entry point', () => {
  /**
   * The bug this whole item nearly shipped with. `workspaceActions` is the ONLY
   * place an action can be declared and `StoredConfigTopLevelSchema` is
   * `.strict()`, so before the key was declared a user who wrote one did not get
   * it ignored — their whole `config.json` was REFUSED. The feature would have
   * been unreachable by construction and would have cost them every other
   * setting they had.
   */
  it('survives the strict config envelope at all', () => {
    const stored = loadStoredConfig()
    expect(stored).not.toBeNull()
    expect((stored as unknown as Record<string, unknown>).workspaceActions).toBeDefined()
  })

  it('lists the declared actions, already resolved for this host', async () => {
    const { registered } = harness()
    const listed = await registered.get(RPC_CHANNELS.workspaceActions.LIST)!(ctx)
    expect(listed).toEqual([{ id: 'dev', name: 'Dev server', command: 'bun run dev' }])
  })

  it('runs BY ID, through the session shell path, and never takes a command from the caller', async () => {
    const { registered, ran } = harness()
    await registered.get(RPC_CHANNELS.workspaceActions.RUN)!(ctx, 'session-1', 'workspace-1', 'dev')
    expect(ran).toEqual([{
      sessionId: 'session-1',
      command: 'bun run dev',
      workspaceId: 'workspace-1',
      // P6.720's control: an action that declares no `cwd` passes `undefined`,
      // which is how the seam says "run where the session runs". Byte-identical
      // to the behaviour before the argument existed.
      relativeCwd: undefined,
    }])
  })

  /**
   * P6.720 — the declared `cwd` reaches the executor, RELATIVE.
   *
   * Relative on purpose: `runShellCommand` contains it against the session's own
   * working directory, and a path this handler had already joined would arrive
   * there as an absolute string with no memory of having been checked. The
   * manager is reachable from the session `command` verb too, so the containment
   * has to live at the executor rather than at one of its callers.
   */
  it('forwards a declared cwd to the shell path, unresolved', async () => {
    seed({ workspaceActions: [{ ...DEV_SERVER, cwd: 'apps/web' }] })
    const { registered, ran } = harness()
    await registered.get(RPC_CHANNELS.workspaceActions.RUN)!(ctx, 'session-1', 'workspace-1', 'dev')
    expect(ran).toEqual([{
      sessionId: 'session-1',
      command: 'bun run dev',
      workspaceId: 'workspace-1',
      relativeCwd: 'apps/web',
    }])
  })

  /**
   * The escaping arm, and it never reaches the executor.
   *
   * The parser refuses the DECLARATION, so `getUserWorkspaceActions` rejects the
   * whole `workspaceActions` layer and the action is not in the list to be
   * found. Two things follow, and the second is the one worth pinning: nothing
   * ran, and the caller gets the SAME `No saved action` it gets for an id that
   * never existed — the RUN surface does not disclose why, for the reason the
   * kill-switch case above records. The name of the offending field reaches the
   * person who wrote it through `reportRejectedUserSettingsLayer`
   * (`workspaceActions: [0].cwd must not contain ".."`), which is the channel
   * that can carry it without telling a caller about the operator's config.
   *
   * Asserted here rather than only in the store's own test because the row's
   * clause is about the RUN path: the point is that nothing ran, not merely that
   * a parser said no somewhere.
   */
  it('an escaping cwd never reaches the shell path, and the refusal discloses nothing', async () => {
    seed({ workspaceActions: [{ ...DEV_SERVER, cwd: '../elsewhere' }] })
    const { registered, ran } = harness()
    await expect(registered.get(RPC_CHANNELS.workspaceActions.RUN)!(ctx, 'session-1', 'workspace-1', 'dev'))
      .rejects.toThrow(/No saved action/)
    expect(ran).toEqual([])
  })

  it('refuses an unknown id, and refuses it identically when the kill switch is on', async () => {
    const { registered, ran } = harness()
    const run = registered.get(RPC_CHANNELS.workspaceActions.RUN)!
    await expect(run(ctx, 'session-1', 'workspace-1', 'nope')).rejects.toThrow(/No saved action/)
    await expect(run(ctx, 'session-1', 'workspace-1', '  ')).rejects.toThrow(/saved action id is required/)

    // `disableSkillShellExecution` empties the read, so the SAME refusal comes
    // back for an action that exists — the surface must not disclose the policy.
    seed({ workspaceActions: [DEV_SERVER], disableSkillShellExecution: true })
    expect(await registered.get(RPC_CHANNELS.workspaceActions.LIST)!(ctx)).toEqual([])
    await expect(run(ctx, 'session-1', 'workspace-1', 'dev')).rejects.toThrow(/No saved action/)

    expect(ran).toEqual([])
  })

  it('re-reads the store on RUN, so a stale list cannot execute a removed action', async () => {
    const { registered, ran } = harness()
    const run = registered.get(RPC_CHANNELS.workspaceActions.RUN)!
    seed({ workspaceActions: [] })
    await expect(run(ctx, 'session-1', 'workspace-1', 'dev')).rejects.toThrow(/No saved action/)
    expect(ran).toEqual([])
  })
})
