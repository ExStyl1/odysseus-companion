import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionMemoryScopeOverride } from '@nessy-agent/shared/agent/memory/session-memory-scope'
import { createHeadlessPlatform } from '../../runtime/platform-headless.ts'
import { createManagedSession, setSessionPlatform } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

/**
 * D1.426 — the per-chat memory override, on the backend config where every
 * runtime reads it.
 *
 * The control shipped whole except for one hop: `setSessionMemoryScope` records
 * `memoryScopeOverride` on the `ManagedSession` and persists it, the RPC answers
 * `{ write: false }`, the session menu drops its check mark — and the
 * `sessionConfig` literal handed to the backend factory listed twelve fields
 * and not this one. All four production readers spell
 * `this.config.session?.memoryScopeOverride` (`pi-agent.ts`, `claude-agent.ts`
 * x4, `codex-agent.ts` x2), so every one of them resolved `undefined` and
 * `resolveSessionMemoryScope` returned the app-wide switch on both axes. A user
 * who turned "Remember from this chat" off kept having memories written from
 * it, on all three runtimes.
 *
 * The instrument is `agent-config-project-trust.test.ts`'s, for the same reason:
 * every step up to the factory boundary is production code, and the factory tail
 * (credentials, subprocess spawn) cannot run in a unit test and has no bearing
 * on what the config carries. So the config is captured at that boundary and
 * read.
 *
 * The THIRD case is the one that decides the shape of the fix rather than only
 * its presence. The override's ordinary life is a mid-session flip — open a
 * chat, run a turn, then untick "Remember from this chat" — and the backend
 * config is built ONCE per agent. A plain copy would have carried the value a
 * chat had before its first turn and nothing after it, which is the dominant
 * user path and the reproduction the review filed. The field is therefore a
 * live getter over the `ManagedSession` record, and the readers are all lazy
 * (`() => this.config.session?.memoryScopeOverride` on Pi, the same expression
 * per query on claude and codex), so the flip is picked up with no invalidation,
 * no new callback and no agent restart.
 */

setSessionPlatform(createHeadlessPlatform())

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface CapturedSessionConfig {
  memoryScopeOverride?: SessionMemoryScopeOverride
}

interface Harness {
  /** The `session` object the backend factory was handed, captured at that boundary. */
  sessionConfig: CapturedSessionConfig
  /** Record the chat's override through the production RPC path, after construction. */
  setOverride(override: SessionMemoryScopeOverride): Promise<void>
  cleanup(): void
}

async function harness(override?: SessionMemoryScopeOverride): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'nessy-agent-memory-scope-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })

  const manager = createTestSessionManager()
  const managed = createManagedSession({ id: 'session-a' }, {
    id: 'workspace-a',
    name: 'Workspace A',
    rootPath: workspaceRoot,
    createdAt: 1,
  }, {
    messagesLoaded: true,
    ephemeral: true,
  })
  managed.activeProvider = 'pi'
  const internals = manager as unknown as {
    sessions: Map<string, unknown>
    createCapabilityTurn(managed: unknown): Promise<{ runtime: unknown }>
    getOrCreateAgent(managed: unknown, runtime: unknown): Promise<unknown>
    createBackendFromManagedContext(args: { coreConfig: Record<string, unknown> }): unknown
    setSessionMemoryScope(sessionId: string, override: SessionMemoryScopeOverride, workspaceId: string): Promise<unknown>
    cleanup(): void
  }
  internals.sessions.set('workspace-a:session-a', managed)

  // Recorded BEFORE construction on the arms that need it, through the same
  // method the `SET_MEMORY_SCOPE` handler calls — never by assigning the field,
  // which would prove only that the test can write an object.
  if (override) await internals.setSessionMemoryScope('session-a', override, 'workspace-a')

  const turn = await internals.createCapabilityTurn(managed)
  let captured: Record<string, unknown> | undefined
  internals.createBackendFromManagedContext = args => {
    captured = args.coreConfig
    throw new Error('captured-before-construction')
  }
  await expect(internals.getOrCreateAgent(managed, turn.runtime)).rejects.toThrow('captured-before-construction')
  expect(captured).toBeTruthy()

  return {
    sessionConfig: captured!.session as CapturedSessionConfig,
    setOverride: async next => { await internals.setSessionMemoryScope('session-a', next, 'workspace-a') },
    cleanup: () => internals.cleanup(),
  }
}

describe('D1.426 — the backend config carries the per-chat memory override', () => {
  it('carries a recorded per-chat write-off onto the config every runtime reads', async () => {
    const rig = await harness({ write: false })
    try {
      expect(rig.sessionConfig.memoryScopeOverride).toEqual({ write: false })
    } finally {
      rig.cleanup()
    }
  })

  it('a chat that never touched the control carries no override at all', async () => {
    // The negative control, and the reason it is worth a case of its own: the
    // resolver reads `override?.write ?? globalEnabled`, so an override
    // invented here — `{}` included — would be indistinguishable from the
    // app-wide answer for a passing test and a DIFFERENT object for the codex
    // argv builder, which emits a flag only for a set axis.
    const rig = await harness()
    try {
      expect(rig.sessionConfig.memoryScopeOverride).toBeUndefined()
    } finally {
      rig.cleanup()
    }
  })

  it('a mid-session flip reaches the config the running agent already holds', async () => {
    const rig = await harness()
    try {
      expect(rig.sessionConfig.memoryScopeOverride).toBeUndefined()
      await rig.setOverride({ write: false })
      // The SAME captured object, re-read: this is the live-getter assertion,
      // and a plain copy fails it while passing both cases above.
      expect(rig.sessionConfig.memoryScopeOverride).toEqual({ write: false })
      // And back: "follow the app-wide setting" is expressed by absence, so the
      // config must be able to return to a chat that never touched the control.
      await rig.setOverride({})
      expect(rig.sessionConfig.memoryScopeOverride).toBeUndefined()
    } finally {
      rig.cleanup()
    }
  })
})
