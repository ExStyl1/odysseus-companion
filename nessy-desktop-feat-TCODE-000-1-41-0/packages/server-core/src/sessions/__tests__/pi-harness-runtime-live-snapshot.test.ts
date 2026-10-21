/**
 * D1.264 — the snapshot a LIVE session PRODUCES is parsed by the parser that
 * guards it, which is the gap every existing test of this pair shares.
 *
 * ## What sitting 4 measured, and why no unit test could see it
 *
 * `RS-56` on the packaged 1.39.0, one session, minutes apart:
 * `getPiHarnessRuntime` ANSWERS before the first turn (`available: false`,
 * `unavailableReason: 'pi-runtime-not-started'`) and THROWS
 * `pi-harness-runtime-invalid` after ONE plain turn that used no tool. The
 * before-read is the control: the RPC, the preload's `barrierSeq` guard and
 * `parsePiHarnessRuntimeSnapshotV1` all work on that build. So the rejected
 * thing is the PAYLOAD a live session makes.
 *
 * Every test of the parser until now fed it a FIXTURE — a payload written by
 * hand to the shape the parser expects — so all of them agreed with each other
 * and none of them could disagree with the producer. This file drives the real
 * `SessionManager.getPiHarnessRuntimeSnapshot` and hands its output to the real
 * parser.
 *
 * ## The defect it pins, and why it compiled
 *
 * `mcpHealth` was built as `{ ...rawMcpHealth, connected, failed }` — a SPREAD
 * of `McpClientPool.health()`, which since P6.715 returns a FOURTH key,
 * `failureReasons`. The wire type `PiHarnessMcpHealthV1` declares three, and the
 * parser's `exact()` rejects a fourth. TypeScript's excess-property check does
 * not apply to properties introduced by a spread, so the producer type-checked
 * against a wire type it was violating. `managed.mcpPool` is assigned when the
 * first agent is constructed, which is exactly why the read parsed before a
 * session's first turn and threw after it.
 *
 * The pool double below returns the REAL `McpPoolHealth` shape and is TYPED as
 * one, so this case cannot drift from the interface: a field added to
 * `McpPoolHealth` lands here, and the assertion is that it does NOT reach the
 * wire — which is the direction the repair chose (bound the producer, because
 * those reasons are free-form text from a server this app does not control).
 */
import { describe, expect, test } from 'bun:test'
import type { McpPoolHealth } from '@nessy-agent/shared/mcp/mcp-pool'
import { parsePiHarnessRuntimeSnapshotV1 } from '@nessy-agent/shared/protocol/pi-harness-runtime'
import { SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager.ts'

/**
 * A pool health answer in the shape the REAL pool returns it — typed, so the
 * interface and this fixture cannot part company silently.
 */
const LIVE_POOL_HEALTH: McpPoolHealth = {
  status: 'degraded',
  connected: ['alpha'],
  failed: ['beta'],
  failureReasons: { beta: 'connect ECONNREFUSED 127.0.0.1:9999' },
}

function liveSession(options: { withPool?: boolean } = {}) {
  const manager = createTestSessionManager() as any
  const managed = {
    id: 'session-1',
    // EPHEMERAL on purpose: it is the one flag that keeps this drive off the
    // filesystem (no checkpoint listing, no stored pending plan) without
    // stubbing anything the snapshot is about.
    ephemeral: true,
    isProcessing: false,
    permissionMode: 'default',
    workspace: { id: 'workspace-1', rootPath: '/tmp/workspace-1' },
    agent: {
      // What `PiAgent.getHarnessDiagnostics()` returns once a turn has run —
      // and `available: !!manifest` is what makes a live snapshot differ from
      // the before-first-turn one that RS-56 used as its control.
      getHarnessDiagnostics: () => ({
        surfaceVersion: 2 as const,
        generation: 'gen-1',
        manifestHash: 'hash-1',
        provenance: ['skill@1'],
        contextProfile: 'bare' as const,
        responseEpoch: 3,
      }),
    },
    ...(options.withPool === false ? {} : { mcpPool: { health: () => LIVE_POOL_HEALTH }, mcpLeaserId: 'leaser-1' }),
  }
  manager.getManaged = () => managed
  manager.resolveManagedProvider = () => 'pi'
  manager.managedKey = () => 'workspace-1|session-1'
  manager.piProcessSupervisor = { snapshot: async () => [] }
  manager.sessionStore = { getSessionPath: () => '/tmp/workspace-1/sessions/session-1' }
  manager.projectHandleService = { resolveHandle: async () => null }
  manager.projectFileCheckpoints = () => Object.freeze([])
  manager.pendingPermissionRequests = new Map()
  manager.piLspPort = () => undefined
  for (const map of [
    'piTaskServices', 'piGoalServices', 'piAskUserServices', 'piPlanModeServices',
    'piChildSessionServices', 'piWorktreeLeaseServices',
  ]) manager[map] = new Map()
  return {
    snapshot: () => SessionManager.prototype.getPiHarnessRuntimeSnapshot.call(
      manager,
      { workspaceId: 'workspace-1', sessionId: 'session-1' },
    ),
  }
}

describe('D1.264 · a live Pi snapshot survives its own parser', () => {
  test('the producer\'s output parses, which is what RS-56 measured it not doing', async () => {
    const produced = await liveSession().snapshot()
    // The whole claim: no cast, no fixture, no hand-written payload between the
    // two. This line threw `pi-harness-runtime-invalid` before the repair.
    const parsed = parsePiHarnessRuntimeSnapshotV1(JSON.parse(JSON.stringify(produced)))
    expect(parsed.available).toBe(true)
    expect(parsed.mcpHealth).toEqual({ status: 'degraded', connected: ['alpha'], failed: ['beta'] })
  })

  test('failureReasons does NOT reach the wire — the repair\'s direction, asserted', async () => {
    const produced = await liveSession().snapshot()
    // The pool really answered with it (the fixture is typed as McpPoolHealth),
    // so this is a statement about the producer rather than about the double.
    expect(LIVE_POOL_HEALTH.failureReasons).toBeDefined()
    expect(Object.keys(produced.mcpHealth ?? {})).toEqual(['status', 'connected', 'failed'])
  })

  test('THE CONTROL — the before-first-turn shape parsed all along', async () => {
    // RS-56's own control, reproduced here so a future failure can be read as
    // "the payload" rather than "the parser": a session with no pool and no
    // manifest is the shape that parsed on the packaged build, and it must keep
    // parsing after any repair to this pair.
    const { snapshot } = liveSession({ withPool: false })
    const produced = await snapshot()
    expect(produced.mcpHealth).toBeUndefined()
    expect(() => parsePiHarnessRuntimeSnapshotV1(JSON.parse(JSON.stringify(produced)))).not.toThrow()
  })
})
