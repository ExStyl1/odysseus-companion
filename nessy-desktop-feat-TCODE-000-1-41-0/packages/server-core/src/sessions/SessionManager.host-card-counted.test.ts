/**
 * D1.355 `[host]` `[safety]` — the seven remaining HOST-raised permission cards
 * are counted while they wait, by the producer every counted card is counted by.
 *
 * D1.346 fixed the command hook's card and named the rest of its family: a raise
 * site that registers a resolver in `directPermissionResolvers` and sends
 * `permission_request` WITHOUT going through `handleAgentPermissionRequest`
 * writes no `pendingPermissionRequests` record, and `awaitingApprovalCount` is
 * derived from that map and from nothing else — so the session badge,
 * `sessionAttentionState`, the iOS client's `isAwaitingApproval` predicate and
 * every automated approver read zero while the card is on screen. Measured on
 * the packaged 1.40.0 by SIT-5f on the hook card: four sessions reading 0 with
 * the Allow once button visible and clickable, the harness never clicking, the
 * turn sitting 180 s and again for 300 s.
 *
 * The instrument is the production producer read INSIDE the `sendEvent` that
 * publishes the card — the reading the sitting took — and the answer arrives on
 * a later tick through the public `respondToPermission`, the same entry point
 * the desktop's click and the harness's approver use.
 *
 * The CONTROL is `requestPiToolApproval`, the seam whose cards have always been
 * counted because it routes through `handleAgentPermissionRequest`. It reads 1
 * on this rig before and after the row, which is what makes each site's zero a
 * fact about that site rather than about the way this file reads the count.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeNormalizedBundleHash } from '@nessy-agent/shared/plugins/bundle-hash'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'

import { createTestSessionManager } from './__tests__/test-session-manager.ts'

type SessionStub = {
  id: string
  workspace: { id: string; rootPath: string }
  [key: string]: unknown
}

function sessionStub(id: string, extra: Record<string, unknown> = {}): SessionStub {
  return {
    id: `session-${id}`,
    // `resolveManagedProvider` answers off this field alone, so nothing on the
    // settlement path reads a workspace config file.
    activeProvider: 'pi',
    permissionMode: 'default',
    // A host card is raised during a turn; saying so also keeps the settlement's
    // invalidation from scheduling a goal continuation this rig has no service
    // for.
    isProcessing: true,
    backgroundShellCommands: new Map<string, unknown>(),
    workspace: { id: `workspace-${id}`, rootPath: process.cwd() },
    workingDirectory: process.cwd(),
    ...extra,
  }
}

function harness(...sessions: SessionStub[]) {
  const manager = createTestSessionManager() as any
  manager.persistSession = () => undefined
  // A notification, never the count: stubbed so the rig stays quiet and so a
  // stub session is never walked for a harness invalidation it cannot answer.
  manager.emitPiHarnessInvalidation = () => undefined
  for (const session of sessions) {
    manager.sessions.set(
      encodeSessionKey({ workspaceId: session.workspace.id, sessionId: session.id }),
      session,
    )
  }
  return manager
}

/**
 * Record the count AT THE MOMENT the card is published, and answer it on a
 * later tick if the case asked for an answer.
 */
function watchCards(manager: any, shownIn: SessionStub) {
  const rig: {
    counts: number[]
    ids: string[]
    answer?: (requestId: string) => void
  } = { counts: [], ids: [] }
  manager.sendEvent = (event: any) => {
    if (event?.type !== 'permission_request') return
    rig.counts.push(manager.awaitingApprovalCount(shownIn))
    const requestId = event.request?.requestId
    if (typeof requestId !== 'string') return
    rig.ids.push(requestId)
    const answer = rig.answer
    if (answer) setTimeout(() => answer(requestId), 0)
  }
  return rig
}

function answerWith(manager: any, shownIn: SessionStub, allowed: boolean) {
  return (requestId: string) => {
    manager.respondToPermission(shownIn.id, requestId, allowed, false, undefined, shownIn.workspace.id)
  }
}

async function runtimeSkillFixture() {
  const root = await mkdtemp(join(tmpdir(), 'd1355-skill-context-'))
  await writeFile(join(root, 'SKILL.md'), '!printf context\n')
  const bundleHash = await computeNormalizedBundleHash(root)
  const skill = {
    key: 'plugin://market/context@1.0.0#hash#skill@workspace:ws',
    logicalName: 'context',
    description: 'Context',
    selectedAsUnqualifiedAlias: true,
    resource: {
      pluginInstanceId: 'plugin://market/context@1.0.0#hash',
      relativePath: 'skills/context/SKILL.md',
      contentHash: 'a'.repeat(64),
    },
    pluginRuntime: { rootPath: root, dataPath: root, bundleHash, profile: 'generic-plugin-env-v1' as const },
  }
  const runtime = {
    provider: 'pi' as const,
    projectTrustState: 'trusted' as const,
    view: { generation: 'generation-d1355-skill', skills: [skill], permissionLayers: [] },
    materializer: { assertActive() {}, async verifyPlugin() {}, async readText() { throw new Error('unused') } },
  }
  return { root, skill, runtime }
}

describe('D1.355 — every host-raised card is counted while it waits', () => {
  test('the CONTROL: an ordinary card through requestPiToolApproval reads 1 on this instrument', async () => {
    const managed = sessionStub('control')
    const manager = harness(managed)
    const watch = watchCards(manager, managed)
    watch.answer = answerWith(manager, managed, false)

    const answer = await manager.requestPiToolApproval(managed, {
      decisionId: 'd1355-control-request',
      toolName: 'Bash',
      type: 'bash',
      description: 'Run a command',
      command: 'echo control',
    })

    expect(watch.counts).toEqual([1])
    expect(answer.allowed).toBe(false)
    expect(manager.awaitingApprovalCount(managed)).toBe(0)
  })

  test('authorizeMonitor — the ws watch', async () => {
    const managed = sessionStub('monitor-ws')
    const manager = harness(managed)
    // The address guard runs before the card; both of its inputs are stubbed so
    // the case measures the card and never the network.
    manager.resolveMonitorTargetHost = async () => 'example.test'
    manager.resolveNetworkAddressesFn = async () => ['93.184.216.34']
    const watch = watchCards(manager, managed)
    watch.answer = answerWith(manager, managed, true)

    await manager.authorizeMonitor({
      sessionKey: { workspaceId: managed.workspace.id, sessionId: managed.id },
      ws: { url: 'wss://example.test/feed' },
    })

    expect(watch.counts).toEqual([1])
    expect(manager.awaitingApprovalCount(managed)).toBe(0)
  })

  test('authorizeMonitorCommand — the command watch', async () => {
    const managed = sessionStub('monitor-command')
    const manager = harness(managed)
    // Not Pi FOR THIS GATE (Pi answers in its own pre-tool gate), and no rule
    // matches — the two conditions that reach the card.
    manager.monitorGateSessionIsPi = () => false
    manager.evaluateMonitorCommandRules = () => undefined
    const watch = watchCards(manager, managed)
    watch.answer = answerWith(manager, managed, true)

    await manager.authorizeMonitorCommand({
      sessionKey: { workspaceId: managed.workspace.id, sessionId: managed.id },
      command: 'tail -f build.log',
    })

    expect(watch.counts).toEqual([1])
    expect(manager.awaitingApprovalCount(managed)).toBe(0)
  })

  test('authorizeWorktreeEnter — the floor card, released on a DENIAL too', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'd1355-repo-'))
    try {
      const managed = sessionStub('worktree-enter', { projectKey: repoRoot, workingDirectory: repoRoot })
      const manager = harness(managed)
      const watch = watchCards(manager, managed)
      // DENIED on purpose: the floor throws on a denial, so this arm proves the
      // release runs on the path that leaves through an exception.
      watch.answer = answerWith(manager, managed, false)

      await expect(
        manager.authorizeWorktreeEnter(managed, { path: join(tmpdir(), 'd1355-elsewhere') }),
      ).rejects.toThrow('was denied')

      expect(watch.counts).toEqual([1])
      expect(manager.awaitingApprovalCount(managed)).toBe(0)
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  test('raiseCrossSessionApprovalDialog — counted against the session it is SHOWN in', async () => {
    const sender = sessionStub('xsession-sender')
    const target = sessionStub('xsession-target')
    const manager = harness(sender, target)
    const watch = watchCards(manager, target)
    watch.answer = answerWith(manager, target, false)

    manager.raiseCrossSessionApprovalDialog(sender, target, 'please look at this', 'd1355-xsession-1')

    expect(watch.counts).toEqual([1])
    // The card belongs to the TARGET and to nobody else: the sender's own count
    // must not move, or a badge would appear on the wrong session.
    expect(manager.awaitingApprovalCount(sender)).toBe(0)
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })
    expect(manager.awaitingApprovalCount(target)).toBe(0)
  })

  test('archiveSessionForAgent — counted against the CALLER', async () => {
    const caller = sessionStub('archive-caller')
    const target = sessionStub('archive-target', {
      workspace: caller.workspace,
      isArchived: false, isProcessing: false, // UA3.8 — idle: the processing arm refuses a target mid-turn before any card
    })
    const manager = harness(caller, target)
    const watch = watchCards(manager, caller)
    watch.answer = answerWith(manager, caller, false)

    const verdict = await manager.archiveSessionForAgent(caller, target.id, true)

    expect(verdict.status).toBe('denied')
    expect(watch.counts).toEqual([1])
    expect(manager.awaitingApprovalCount(caller)).toBe(0)
  })

  test('runtimeSkillContextExecutor — a skill\'s `!` line', async () => {
    const fixture = await runtimeSkillFixture()
    try {
      const managed = sessionStub('skill-context', {
        capabilityRuntime: fixture.runtime,
        enabledSourceSlugs: [],
      })
      const manager = harness(managed)
      manager.piWorkspaceDrainParticipant = {
        processSupervisorPort: {
          start: async (request: any) => {
            await request.beforeStart?.()
            return {
              handle: 'process-d1355', stdout: 'context', stderr: '', output: 'context',
              nextCursor: 0, isRunning: false, exitCode: 0, signal: null,
              isolationProfile: 'workspace:test', environmentProfile: 'restricted',
              environmentDigest: 'a'.repeat(64),
            }
          },
        },
      }
      manager.appendPiExecutionReceipt = () => undefined
      manager.piGoalReceiptReference = () => undefined
      manager.emitPiTelemetry = () => undefined
      const watch = watchCards(manager, managed)
      watch.answer = answerWith(manager, managed, true)

      const output = await manager.runtimeSkillContextExecutor(managed, fixture.runtime)({
        skillKey: fixture.skill.key,
        command: 'printf context',
        cwd: process.cwd(),
        generation: fixture.runtime.view.generation,
        resourceHash: fixture.skill.resource.contentHash,
        timeoutMs: 5_000,
      }, new AbortController().signal)

      expect(output).toBe('context')
      expect(watch.counts).toEqual([1])
      expect(manager.awaitingApprovalCount(managed)).toBe(0)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('requestDirectShellPermission — composer ! mode', async () => {
    const managed = sessionStub('direct-shell')
    const manager = harness(managed)
    const watch = watchCards(manager, managed)
    watch.answer = answerWith(manager, managed, true)

    const allowed = await manager.requestDirectShellPermission(managed, 'ls -la')

    expect(allowed).toBe(true)
    expect(watch.counts).toEqual([1])
    expect(manager.awaitingApprovalCount(managed)).toBe(0)
  })

  /**
   * The boundary the record's SHAPE carries, and the reason
   * {@link countHostRaisedCard} refuses a `command` by construction: an Always
   * answer on a `bash`-typed host card must not mint the permanent
   * repository-wide rule `persistBashAlwaysAllowRule` writes. These resolvers
   * take `{allowed, canonicalInput}` (plus a denial `comment`), never the Always flag, so the click is a
   * one-off allow today and stays one.
   */
  test('an Always answer on a host card mints no permanent repository rule', async () => {
    const managed = sessionStub('always')
    const manager = harness(managed)
    const persisted: unknown[][] = []
    manager.persistBashAlwaysAllowRule = (...args: unknown[]) => { persisted.push(args) }
    const watch = watchCards(manager, managed)
    watch.answer = requestId => {
      manager.respondToPermission(managed.id, requestId, true, true, undefined, managed.workspace.id)
    }

    const allowed = await manager.requestDirectShellPermission(managed, 'rm -rf build')

    expect(allowed).toBe(true)
    expect(watch.counts).toEqual([1])
    expect(persisted).toEqual([])
    expect(manager.awaitingApprovalCount(managed)).toBe(0)
  })
})
