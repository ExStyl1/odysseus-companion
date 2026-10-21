/**
 * F1.409 (origin: the WJ-ff verifier on F1.265) — `source_manage: remove` never
 * tells the model that a removal which LANDED failed.
 *
 * F1.211's class, on a third channel. `removeSourceEverywhere` does three things
 * in order: delete the folder, prune the workspace's default list, then
 * `notifyRevoked` — bound by `SessionManager` to `afterAgentPluginMutation`, which
 * refreshes the live sessions with a STRICT dispose and throws
 * `pluginRuntimeRefreshFailure(summary)` when one of them fails. The tool's
 * `catch` read every throw as a failed removal: "Removing "x" failed:
 * codex-runtime-session-disposal-failed" for a source whose folder was already
 * gone, and the F1.265 summary the error carries was discarded.
 *
 * The rig is F1.211's (`plugin-install-refresh-failure.test.ts`): the real tool
 * handler, the real shared removal, the real `afterAgentPluginMutation`, the
 * real refresh and the real strict dispose; the one planted fact is an idle
 * codex session whose runtime teardown rejects.
 *
 * CONTROL — the same removal with no codex session answers byte-identically to
 * before; a removal that fails BEFORE the folder is gone is still a failure.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeSourceEverywhere } from '@nessy-agent/shared/sources'
import { createNodeFileSystem, SESSION_TOOL_REGISTRY, type SessionToolContext } from '@nessy-agent/session-tools-core'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const roots: string[] = []
const locked: string[] = []
afterEach(() => {
  for (const dir of locked.splice(0)) chmodSync(dir, 0o755)
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const REMOVED_BEFORE = 'Source "jira" was removed: its folder is deleted, the workspace default list no longer names it, and active sessions have had it revoked.'

/**
 * Can an r-x PARENT actually stop the delete on THIS host? (F1.59 CI, MR !49 row 3)
 *
 * The delete-failure CONTROL stages its failure the honest way: the real `deleteSource` refused by real directory
 * permissions. As ROOT (the Kubernetes runner the `test` job uses) or with `CAP_DAC_OVERRIDE` the delete SUCCEEDS,
 * op (1) throws nothing, and the case failed on `existsSync(sourceDir)` with nothing naming root. So the precondition
 * is MEASURED, by doing exactly what the rig does — `deleteSource`'s own `rmSync(dir, { recursive: true })` on a
 * folder under a 0o555 parent — the probe `codex-teardown-failure-attribution.test.ts` uses for the same reason
 * (deliberately not `process.getuid() === 0`: a capability, not a uid, decides). The residue is stated where it
 * lands: on such a host the control is skipped with a stderr line, and the macOS guard below keeps the skip from
 * ever hiding it on a developer's (non-root) Mac.
 */
const readOnlyParentBlocksDelete = (() => {
  const parent = mkdtempSync(join(tmpdir(), 'f1409-precondition-'))
  const victim = join(parent, 'probe')
  try {
    mkdirSync(victim)
    writeFileSync(join(victim, 'config.json'), '{}\n')
    chmodSync(parent, 0o555)
    try {
      rmSync(victim, { recursive: true })
    } catch {
      return existsSync(victim)
    }
    return false
  } catch {
    return false
  } finally {
    chmodSync(parent, 0o755)
    rmSync(parent, { recursive: true, force: true })
  }
})()
if (!readOnlyParentBlocksDelete) {
  // stderr, so the reason travels with the run rather than living only here.
  console.warn(
    '[source-manage-remove-refresh-failure.test.ts] the delete-failure CONTROL is SKIPPED: on this host an r-x '
    + 'parent directory does not prevent the delete (root, or CAP_DAC_OVERRIDE), so the real deleteSource failure '
    + 'it needs cannot be staged. Every other case in this file still runs.',
  )
}

function rig(options: { codexSession: boolean; deleteFails?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'f1409-'))
  roots.push(dir)
  const sm = createTestSessionManager()
  const workspaceId = 'ws-f1409'
  const workspacePath = join(dir, 'workspace')
  const sourceDir = join(workspacePath, 'sources', 'jira')
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({ slug: 'jira', name: 'jira', type: 'mcp', enabled: true }))
  if (options.deleteFails) {
    // The source's parent directory refuses the delete: the folder cannot go, so op (1) throws.
    chmodSync(join(workspacePath, 'sources'), 0o555)
    locked.push(join(workspacePath, 'sources'))
  }
  const workspace = { id: workspaceId, name: workspaceId, slug: workspaceId, rootPath: workspacePath, createdAt: Date.now() }
  const sessions = (sm as unknown as { sessions: Map<string, unknown> }).sessions
  sessions.set(`${workspaceId}:caller`, createManagedSession({ id: 'caller' }, workspace, { messagesLoaded: true, ephemeral: true }))

  if (options.codexSession) {
    const codex = createManagedSession({ id: 'codex-idle' }, workspace, { messagesLoaded: true, ephemeral: true })
    ;(codex as { agent: unknown }).agent = {
      isProcessing: () => false,
      setCapabilityTurnRuntime: () => {},
      setAutomationSystem: () => {},
      drainAutomationEvents: async () => {},
      disposeForRestart: async () => { throw new AggregateError([new Error('CODEX_HOME rm EBUSY')], 'codex-runtime-cleanup-failed') },
      dispose: () => {},
    }
    sessions.set(`${workspaceId}:codex-idle`, codex)
    const internals = sm as unknown as { resolveManagedProvider(managed: { id: string }): string }
    const realProvider = internals.resolveManagedProvider.bind(sm)
    internals.resolveManagedProvider = managed => managed.id === 'codex-idle' ? 'codex-runtime' : realProvider(managed as never)
  }

  const defaults: string[][] = []
  const ctx = {
    configRoot: workspacePath,
    sessionId: 'caller',
    workspacePath,
    get sourcesPath() { return join(workspacePath, 'sources') },
    get skillsPath() { return join(workspacePath, 'skills') },
    plansFolderPath: join(workspacePath, 'plans'),
    callbacks: { onPlanSubmitted: () => {}, onAuthRequest: () => {} },
    fs: createNodeFileSystem(),
    loadSourceConfig: () => null,
    // Production's own binding (`SessionManager`'s `removeSourceFn`): the shared
    // three-op removal, its revoke bound to the SAME host hook.
    removeSource: async (sourceSlug: string) => {
      await removeSourceEverywhere(sourceSlug, {
        workspaceRootPath: workspacePath,
        enabledSourceSlugs: ['jira', 'github'],
        updateEnabledSourceSlugs: next => { defaults.push(next) },
        notifyRevoked: () => (sm as unknown as {
          afterAgentPluginMutation(w: string, p: undefined, r: string, t?: undefined, e?: 'remove'): Promise<void>
        }).afterAgentPluginMutation(workspaceId, undefined, 'source_manage:remove', undefined, 'remove'),
      })
    },
  } as unknown as SessionToolContext
  return { sm, ctx, sourceDir, defaults }
}

async function removeThroughTheTool(ctx: SessionToolContext) {
  const result = await SESSION_TOOL_REGISTRY.get('source_manage')!.handler!(ctx, { sourceSlug: 'jira', action: 'remove' })
  return { isError: result.isError === true, text: result.content.map(part => ('text' in part ? part.text : '')).join('') }
}

describe('F1.409 — a removal that landed is answered as removed, with the refresh failure beside it', () => {
  it('THE DEFECT — an idle codex session whose teardown fails: the folder is gone, and the answer must say so', async () => {
    const r = rig({ codexSession: true })
    const answer = await removeThroughTheTool(r.ctx)
    // The removal itself landed (read from the disk and the defaults writer, not the answer).
    expect(existsSync(r.sourceDir)).toBe(false)
    expect(r.defaults).toEqual([['github']])

    expect(answer.isError).toBe(false)
    expect(answer.text).toContain('Source "jira" was removed: its folder is deleted and the workspace default list no longer names it.')
    expect(answer.text).not.toContain('[ERROR]')
    expect(answer.text).toContain('Revoking it from the sessions that were already running failed (codex-runtime-session-disposal-failed)')
    // The F1.265 summary reaches the model: the counts, and the session that failed.
    expect(answer.text).toContain('1 failed (codex-idle)')
    expect(answer.text).toContain('until its runtime restarts')
  })
})

describe('F1.409 — CONTROLS', () => {
  it('no codex session: the answer is byte-identical to before', async () => {
    const r = rig({ codexSession: false })
    const answer = await removeThroughTheTool(r.ctx)
    expect(existsSync(r.sourceDir)).toBe(false)
    expect(answer).toEqual({ isError: false, text: REMOVED_BEFORE })
  })

  it('the delete-failure precondition cannot be skipped away on a non-root macOS host', () => {
    // A non-root user on macOS has no DAC override, so there the probe MUST say the delete can be blocked; if the
    // probe itself breaks, this fails instead of the control below silently skipping.
    if (process.platform === 'darwin' && process.getuid?.() !== 0) expect(readOnlyParentBlocksDelete).toBe(true)
  })

  it.skipIf(!readOnlyParentBlocksDelete)('a removal that fails BEFORE the folder is gone is still a failure, and names its own error', async () => {
    const r = rig({ codexSession: true, deleteFails: true })
    const answer = await removeThroughTheTool(r.ctx)
    expect(existsSync(r.sourceDir)).toBe(true)
    expect(r.defaults).toEqual([])
    expect(answer.isError).toBe(true)
    expect(answer.text).toStartWith('[ERROR] Removing "jira" failed: ')
    expect(answer.text).not.toContain('was removed')
  })
})
