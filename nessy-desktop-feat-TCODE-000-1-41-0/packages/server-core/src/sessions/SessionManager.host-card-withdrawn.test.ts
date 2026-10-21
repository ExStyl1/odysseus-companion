/**
 * F1.186 (origin WJ-h P-WJ-h-1) — the SEVEN other host-raised cards leave the
 * screen when their wait ends any way but the answer, and leave the COUNT when
 * they leave the screen.
 *
 * ## The census this file pins
 *
 * F1.97 (`SessionManager.hook-card-withdrawn.test.ts`) taught the command hook's
 * card to withdraw itself; D1.355 (`SessionManager.host-card-counted.test.ts`)
 * had already given the other seven a shared raise/release pair,
 * `countHostRaisedCard`, whose release removed the pending record and told the
 * client NOTHING. Read against the one producer of `permission_request_cancelled`
 * at the time — `cancelCrossSessionApprovalDialog` — the seven were:
 *
 * | Raise site | Terminal paths that release | Record still live there? | Card withdrawn? |
 * | --- | --- | --- | --- |
 * | `authorizeMonitor` (ws) | answer · failed publish | no · yes | — · **no** |
 * | `authorizeMonitorCommand` | answer · failed publish | no · yes | — · **no** |
 * | `authorizeWorktreeEnter` | answer · failed publish | no · yes | — · **no** |
 * | `raiseCrossSessionApprovalDialog` | answer · failed publish · the CANCEL | no · yes · **never released** | — · no · yes |
 * | `archiveSessionForAgent` | answer · failed publish | no · yes | — · **no** |
 * | `runtimeSkillContextExecutor` | answer · **abort** · failed publish | no · yes · yes | — · **no** · **no** |
 * | `requestDirectShellPermission` | answer (release after the await) | no | — |
 *
 * Two raise sites joined the census later and are driven here like the five of the publish shape:
 * `raiseArtifactPublishCard` (UA1.18) and `confirmPageDeleteForAgent` (UA6.2, `delete_page`; UA12.45 adds its
 * turn-end and timeout arms — answer · failed publish · turn end · timeout, the last three with the record live).
 *
 * So the one site with an abort path left a live-looking Allow on every aborted
 * turn, five sites could not take a half-published card back, and the one
 * producer that DID withdraw forgot the other half: it deleted the resolver
 * without calling it, so `releaseCard` never ran and the session's
 * `awaitingApprovalCount` stayed at 1 with nothing on screen to answer.
 *
 * ## The fix, and the path that deliberately stays silent
 *
 * `countHostRaisedCard`'s release now reads `removePendingPermissionRequest`'s
 * boolean, exactly as F1.97's `releaseHookCard` does: when the record was still
 * live, the card is withdrawn through `withdrawHostRaisedCard`. The ANSWER stays
 * silent for the reason F1.97 measured — `respondToPermission` removes the
 * record before it resolves the direct resolver, so the release finds nothing
 * and the renderer has already cleared the card — and every negative arm below
 * is that measurement for one site. `cancelCrossSessionApprovalDialog` now
 * removes the record it was leaving behind.
 *
 * ## The rig
 *
 * `SessionManager.host-card-counted.test.ts`'s, unchanged in kind: the real
 * raise sites, the real `respondToPermission`, and `sendEvent` as the
 * instrument. A failed publish is `sendEvent` throwing for the card and only
 * for the card, so the withdrawal it provokes is still observable.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
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
    activeProvider: 'pi',
    permissionMode: 'default',
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
  manager.emitPiHarnessInvalidation = () => undefined
  for (const session of sessions) {
    manager.sessions.set(
      encodeSessionKey({ workspaceId: session.workspace.id, sessionId: session.id }),
      session,
    )
  }
  return manager
}

type Mode = 'answer' | 'publish-fails' | 'silent'

/**
 * The instrument. `answer` clicks on a later tick, as a person does;
 * `publish-fails` throws for the card and ONLY for the card; `silent` leaves the
 * card up for the case to end some other way.
 */
function watch(manager: any, mode: Mode, allowed = false) {
  const rig = { raised: [] as string[], withdrawn: [] as string[] }
  manager.sendEvent = (event: any) => {
    if (event?.type === 'permission_request_cancelled') {
      rig.withdrawn.push(event.requestId)
      return
    }
    if (event?.type !== 'permission_request') return
    const requestId = event.request?.requestId as string
    rig.raised.push(requestId)
    if (mode === 'publish-fails') throw new Error('F1.186 rig: the publish failed')
    if (mode === 'answer') {
      const session = event.sessionId as string
      const workspace = [...manager.sessions.values()].find((s: SessionStub) => s.id === session)?.workspace.id
      setTimeout(() => manager.respondToPermission(session, requestId, allowed, false, undefined, workspace), 0)
    }
  }
  return rig
}

async function runtimeSkillFixture() {
  const root = await mkdtemp(join(tmpdir(), 'f1186-skill-context-'))
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
    view: { generation: 'generation-f1186-skill', skills: [skill], permissionLayers: [] },
    materializer: { assertActive() {}, async verifyPlugin() {}, async readText() { throw new Error('unused') } },
  }
  return { root, skill, runtime }
}

function skillContextManager(fixture: Awaited<ReturnType<typeof runtimeSkillFixture>>) {
  const managed = sessionStub('skill-context', { capabilityRuntime: fixture.runtime, enabledSourceSlugs: [] })
  const manager = harness(managed)
  manager.piWorkspaceDrainParticipant = {
    processSupervisorPort: {
      start: async (request: any) => {
        await request.beforeStart?.()
        return {
          handle: 'process-f1186', stdout: 'context', stderr: '', output: 'context',
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
  return { managed, manager }
}

const skillRequest = (fixture: Awaited<ReturnType<typeof runtimeSkillFixture>>) => ({
  skillKey: fixture.skill.key,
  command: 'printf context',
  cwd: process.cwd(),
  generation: fixture.runtime.view.generation,
  resourceHash: fixture.skill.resource.contentHash,
  timeoutMs: 5_000,
})

/**
 * UA12.45 — a caller a person can answer (a user turn, a window that can confirm), so UA1.18's unattended predicate
 * lets `confirmPageDeleteForAgent` raise its card. The page itself is never touched: the confirm runs before the delete.
 */
function pageDeleteManager(id: string) {
  const shownIn = sessionStub(id, {
    processingGeneration: 1,
    messages: [{ id: 'u1', role: 'user', content: 'delete the old dashboard', timestamp: 1 }],
  })
  const manager = harness(shownIn)
  manager.rpcServer = { findClientsWithCapability: () => ['window-1'], hasClientCapability: () => false }
  return { manager, shownIn }
}

const pageDeleteSubject = { slug: 'old-dashboard', name: 'Old Dashboard' }

/** Each site's own way to raise its card, so one pair of arms covers all five of this shape. */
const publishSites: Array<{
  name: string
  run: (mode: Mode) => Promise<{ manager: any; shownIn: SessionStub; rig: ReturnType<typeof watch>; outcome: unknown }>
}> = [
  {
    name: 'authorizeMonitor (ws)',
    run: async mode => {
      const shownIn = sessionStub('monitor-ws')
      const manager = harness(shownIn)
      manager.resolveMonitorTargetHost = async () => 'example.test'
      manager.resolveNetworkAddressesFn = async () => ['93.184.216.34']
      const rig = watch(manager, mode, true)
      const outcome = await manager.authorizeMonitor({
        sessionKey: { workspaceId: shownIn.workspace.id, sessionId: shownIn.id },
        ws: { url: 'wss://example.test/feed' },
      }).then(() => 'allowed', (error: Error) => error.message)
      return { manager, shownIn, rig, outcome }
    },
  },
  {
    name: 'authorizeMonitorCommand',
    run: async mode => {
      const shownIn = sessionStub('monitor-command')
      const manager = harness(shownIn)
      manager.monitorGateSessionIsPi = () => false
      manager.evaluateMonitorCommandRules = () => undefined
      const rig = watch(manager, mode, true)
      const outcome = await manager.authorizeMonitorCommand({
        sessionKey: { workspaceId: shownIn.workspace.id, sessionId: shownIn.id },
        command: 'tail -f build.log',
      }).then(() => 'allowed', (error: Error) => error.message)
      return { manager, shownIn, rig, outcome }
    },
  },
  {
    name: 'authorizeWorktreeEnter',
    run: async mode => {
      const repoRoot = await mkdtemp(join(tmpdir(), 'f1186-repo-'))
      try {
        const shownIn = sessionStub('worktree-enter', { projectKey: repoRoot, workingDirectory: repoRoot })
        const manager = harness(shownIn)
        const rig = watch(manager, mode, false)
        const outcome = await manager.authorizeWorktreeEnter(shownIn, { path: join(tmpdir(), 'f1186-elsewhere') })
          .then(() => 'allowed', (error: Error) => error.message)
        return { manager, shownIn, rig, outcome }
      } finally {
        await rm(repoRoot, { recursive: true, force: true })
      }
    },
  },
  {
    name: 'archiveSessionForAgent',
    run: async mode => {
      const shownIn = sessionStub('archive-caller')
      const target = sessionStub('archive-target', { workspace: shownIn.workspace, isArchived: false, isProcessing: false }) // UA3.8 — idle (the processing arm)
      const manager = harness(shownIn, target)
      const rig = watch(manager, mode, false)
      const outcome = await manager.archiveSessionForAgent(shownIn, target.id, true)
        .then((verdict: { status: string }) => verdict.status, (error: Error) => error.message)
      return { manager, shownIn, rig, outcome }
    },
  },
  {
    // UA1.18 — `publish_artifact`'s card (raised by `publishArtifactForAgent` through `raiseArtifactPublishCard`).
    name: 'raiseArtifactPublishCard',
    run: async mode => {
      const root = await mkdtemp(join(tmpdir(), 'ua118-publish-'))
      try {
        await writeFile(join(root, 'page.html'), '<p>hello</p>')
        const shownIn = sessionStub('publish-caller', {
          workspace: { id: 'workspace-publish-caller', rootPath: root },
          workingDirectory: root,
          messages: [{ id: 'u1', role: 'user', content: 'publish page.html', timestamp: 1 }],
        })
        const manager = harness(shownIn)
        // A window that can show the card is attached (the unattended predicate's client fact).
        manager.rpcServer = { findClientsWithCapability: () => ['window-1'], hasClientCapability: () => false }
        manager.getSessionPath = () => null
        const rig = watch(manager, mode, false)
        const outcome = await manager.publishArtifactForAgent(shownIn, { filePath: 'page.html' })
          .then((verdict: { status: string }) => verdict.status, (error: Error) => error.message)
        return { manager, shownIn, rig, outcome }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  },
  {
    // UA6.2 / UA12.45 — `delete_page`'s card (reached through `pagesToolCallbacksForAgent`'s `confirmDelete`).
    name: 'confirmPageDeleteForAgent',
    run: async mode => {
      const { manager, shownIn } = pageDeleteManager('delete-page-caller')
      const rig = watch(manager, mode, false)
      const outcome = await manager.confirmPageDeleteForAgent(shownIn, pageDeleteSubject)
        .then((verdict: { allowed: boolean; refusal?: string }) => verdict.refusal ?? 'allowed', (error: Error) => error.message)
      return { manager, shownIn, rig, outcome }
    },
  },
  {
    name: 'runtimeSkillContextExecutor',
    run: async mode => {
      const fixture = await runtimeSkillFixture()
      try {
        const { managed: shownIn, manager } = skillContextManager(fixture)
        const rig = watch(manager, mode, true)
        const outcome = await manager.runtimeSkillContextExecutor(shownIn, fixture.runtime)(
          skillRequest(fixture), new AbortController().signal,
        ).then((output: string) => output, (error: Error) => error.message)
        return { manager, shownIn, rig, outcome }
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
  },
]

describe('F1.186 — a host card whose publish failed is taken back, one arm per site', () => {
  for (const site of publishSites) {
    test(`${site.name}: the half-published card is withdrawn and the count released`, async () => {
      const { manager, shownIn, rig, outcome } = await site.run('publish-fails')

      // The positive control: the card really was raised, so an empty
      // withdrawal list below is about the withdrawal, never a missing card.
      expect(rig.raised).toHaveLength(1)
      expect(typeof outcome).toBe('string')
      expect(rig.withdrawn).toEqual(rig.raised)
      expect(manager.awaitingApprovalCount(shownIn)).toBe(0)
    })

    test(`${site.name}: CONTROL — an ANSWERED card is not withdrawn, the click already cleared it`, async () => {
      const { manager, shownIn, rig } = await site.run('answer')

      expect(rig.raised).toHaveLength(1)
      expect(rig.withdrawn).toEqual([])
      expect(manager.awaitingApprovalCount(shownIn)).toBe(0)
    })
  }
})

describe('F1.186 — the skill-context card, the one with an ABORT path', () => {
  test('an aborted turn takes its card off the screen', async () => {
    const fixture = await runtimeSkillFixture()
    try {
      const { managed, manager } = skillContextManager(fixture)
      const rig = watch(manager, 'silent')
      const controller = new AbortController()
      const pending = manager.runtimeSkillContextExecutor(managed, fixture.runtime)(
        skillRequest(fixture), controller.signal,
      ).then(() => 'ran', (error: Error) => `refused: ${error.message}`)
      // The card is up and counted before the abort arrives.
      await new Promise<void>(resolve => { setTimeout(resolve, 20) })
      expect(rig.raised).toHaveLength(1)
      expect(manager.awaitingApprovalCount(managed)).toBe(1)

      controller.abort()
      await pending

      expect(rig.withdrawn).toEqual(rig.raised)
      expect(manager.awaitingApprovalCount(managed)).toBe(0)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})

describe('F1.186 — the cross-session dialog, the one that withdrew and never released', () => {
  test('a cancelled dialog leaves the screen AND the count', async () => {
    const sender = sessionStub('xsession-sender')
    const target = sessionStub('xsession-target')
    const manager = harness(sender, target)
    const rig = watch(manager, 'silent')

    manager.raiseCrossSessionApprovalDialog(sender, target, 'please look at this', 'f1186-xsession-cancel')
    expect(rig.raised).toEqual(['f1186-xsession-cancel'])
    expect(manager.awaitingApprovalCount(target)).toBe(1)

    manager.cancelCrossSessionApprovalDialog(target, 'f1186-xsession-cancel')

    expect(rig.withdrawn).toEqual(['f1186-xsession-cancel'])
    expect(manager.awaitingApprovalCount(target)).toBe(0)
  })

  test('a failed publish is withdrawn and released, and the raise itself does not throw', () => {
    const sender = sessionStub('xsession-sender-fail')
    const target = sessionStub('xsession-target-fail')
    const manager = harness(sender, target)
    const rig = watch(manager, 'publish-fails')

    manager.raiseCrossSessionApprovalDialog(sender, target, 'please look at this', 'f1186-xsession-fail')

    expect(rig.raised).toEqual(['f1186-xsession-fail'])
    expect(rig.withdrawn).toEqual(['f1186-xsession-fail'])
    expect(manager.awaitingApprovalCount(target)).toBe(0)
  })

  test('CONTROL — an answered dialog is not withdrawn', async () => {
    const sender = sessionStub('xsession-sender-answer')
    const target = sessionStub('xsession-target-answer')
    const manager = harness(sender, target)
    const rig = watch(manager, 'answer', false)

    manager.raiseCrossSessionApprovalDialog(sender, target, 'please look at this', 'f1186-xsession-answer')
    await new Promise<void>(resolve => { setTimeout(resolve, 10) })

    expect(rig.raised).toEqual(['f1186-xsession-answer'])
    expect(rig.withdrawn).toEqual([])
    expect(manager.awaitingApprovalCount(target)).toBe(0)
  })
})

describe('UA12.45 — the delete-page card, withdrawn on the paths that end its wait without an answer', () => {
  test('the raising turn stops while the card is open: the card leaves the screen AND the count, the delete is refused', async () => {
    const { manager, shownIn } = pageDeleteManager('delete-page-stop')
    const rig = watch(manager, 'silent')
    const pending = manager.confirmPageDeleteForAgent(shownIn, pageDeleteSubject)
    // The card is up and counted before the turn ends.
    expect(rig.raised).toHaveLength(1)
    expect(manager.awaitingApprovalCount(shownIn)).toBe(1)

    manager.releaseTurnBoundHostCards(shownIn, 'Stop')
    const verdict = await pending

    expect(verdict.allowed).toBe(false)
    expect(verdict.refusal).toContain('the turn was stopped')
    expect(rig.withdrawn).toEqual(rig.raised)
    expect(manager.awaitingApprovalCount(shownIn)).toBe(0)
  })

  test('nobody answers within the timeout: the card leaves the screen AND the count', async () => {
    const { manager, shownIn } = pageDeleteManager('delete-page-timeout')
    manager.pageDeleteCardTimeoutMs = 20
    const rig = watch(manager, 'silent')
    const verdict = await manager.confirmPageDeleteForAgent(shownIn, pageDeleteSubject)

    expect(rig.raised).toHaveLength(1)
    expect(verdict.allowed).toBe(false)
    expect(verdict.refusal).toContain('nobody answered it within')
    expect(rig.withdrawn).toEqual(rig.raised)
    expect(manager.awaitingApprovalCount(shownIn)).toBe(0)
  })
})

describe('F1.186 — the census is the seven it names', () => {
  test('every countHostRaisedCard call site is one this file drives or states', () => {
    const source = readFileSync(new URL('./SessionManager.ts', import.meta.url), 'utf8')
    // The enclosing method of each `this.countHostRaisedCard(` call, read off
    // the source so a NEW raise site reddens here instead of joining silently.
    const sites = [...source.matchAll(/this\.countHostRaisedCard\(/g)].map(match => {
      const before = source.slice(0, match.index)
      const methods = [...before.matchAll(/\n {2}(?:private |public |protected )?(?:async )?([A-Za-z]+)\s*\(/g)]
      return methods.at(-1)?.[1]
    })
    expect(sites.sort()).toEqual([
      'archiveSessionForAgent',
      'authorizeMonitor',
      'authorizeMonitorCommand',
      'authorizeWorktreeEnter',
      // UA6.2 / UA12.45 — the delete-page card; driven above in both arms, plus its turn-end and timeout arms.
      'confirmPageDeleteForAgent',
      // UA1.18 — the publish card; driven above in both arms.
      'raiseArtifactPublishCard',
      'raiseCrossSessionApprovalDialog',
      // Released after its await, on the answer only — no terminal path finds
      // the record live, so there is nothing for it to withdraw (a throwing
      // publish rejects before the release runs; its own comment states that).
      'requestDirectShellPermission',
      'runtimeSkillContextExecutor',
    ])
  })
})
