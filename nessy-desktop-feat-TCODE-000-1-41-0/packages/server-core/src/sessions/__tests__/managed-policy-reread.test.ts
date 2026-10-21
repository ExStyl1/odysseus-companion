/**
 * D4 — a tightened managed policy reaches a RUNNING session.
 *
 * `managed-policy-resolution.ts` said so itself, before this change: "What this
 * does NOT do is re-compose mid-session when a later fetch lands.
 * `SessionManager` captures the policy once at construction". So an
 * administrator who denied an MCP server after an incident reached only the
 * desktops that were restarted afterwards, and could not see who was stale.
 *
 * These assertions drive the SHIPPED readers — `resolveChannelPolicy`, which is
 * what gates a channel MCP server's pushes, and `normalizePiPermissionMode`,
 * which every session mode change and every child clamp goes through — rather
 * than reading the policy field back. The failure mode is a policy that updates
 * somewhere nothing consults.
 *
 * The policy sources are seams here, always. A managed-policy test must never
 * read the machine's real `/etc/nessy/managed-policy.json` or its real config
 * directory.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import type { ManagedPiPolicyV1 } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { createTestSessionManager } from './test-session-manager.ts'

const LOOSE: ManagedPiPolicyV1 = Object.freeze({
  schemaVersion: 1 as const,
  disabledPermissionModes: Object.freeze([]),
})

/** The post-incident policy: one MCP server denied, one permission mode off. */
const TIGHTENED: ManagedPiPolicyV1 = Object.freeze({
  schemaVersion: 1 as const,
  disabledPermissionModes: Object.freeze(['bypassPermissions' as const]),
  deniedMcpServers: Object.freeze([{ serverName: 'acme-chat' }]),
})

/** A widening: the incident is over and the administrator lifts the denial. */
const WIDENED: ManagedPiPolicyV1 = Object.freeze({
  schemaVersion: 1 as const,
  disabledPermissionModes: Object.freeze([]),
  deniedMcpServers: Object.freeze([]),
})

interface Internals {
  sessions: Map<string, unknown>
  resolveChannelPolicy(): { enabled: boolean; deniedSources?: readonly string[] }
  normalizePiPermissionMode(mode: string): string
  refreshManagedPiPolicy(when: 'immediate' | 'turn-boundary'): void
}

function harness(seed: ManagedPiPolicyV1 = LOOSE) {
  const source = { policy: seed }
  const listeners = new Set<() => void>()
  const manager = createTestSessionManager({
    managedPiPolicy: seed,
    resolveManagedPiPolicy: () => source.policy,
    subscribeManagedPolicyChange: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  })
  const internals = manager as unknown as Internals
  // A session that is already running, so nothing below is a restart.
  const sessionKey = { workspaceId: 'workspace-1', sessionId: 'session-1' }
  internals.sessions.set(encodeSessionKey(sessionKey), {
    id: sessionKey.sessionId,
    workspace: { id: sessionKey.workspaceId, rootPath: '/tmp/workspace-1' },
    permissionMode: 'bypassPermissions',
    isProcessing: true,
    messages: [],
    // Required on `ManagedSession` and set for every production session. A
    // supervised process left in the shared durable store under
    // `workspace-1:session-1` is recovered by a LATER file's manager, whose
    // `onChanged` fires `void reconcileEndedBackgroundShells(managed)` on this
    // stub; the voided async call makes that an unhandled rejection, which bun
    // charges to whichever test is running by then.
    //
    // Honest scope: an instrumented probe in a clean worktree named THIS
    // object's exact key set as the source of six such rejections, charged to
    // `filesystem-scope-revocation`. But removing this line again does not
    // reproduce it — the same source gave 6 TypeErrors in one pair of runs and
    // 0 in another, because bun's file order varies and the leftover record only
    // exists when `monitor-ws-approval` (whose own identical omission was the
    // deterministic failure, and IS re-breakable) ran first. So this line is a
    // required field restored, not a fix with a demonstration behind it.
    backgroundShellCommands: new Map<string, string>(),
  })
  return {
    manager,
    internals,
    sessionKey,
    /** The administrator publishes a new policy through the existing signal. */
    deliver(policy: ManagedPiPolicyV1) {
      source.policy = policy
      for (const listener of listeners) listener()
    },
    listenerCount: () => listeners.size,
  }
}

describe('a tightened managed policy reaches a running session (D4)', () => {
  test('a newly-denied MCP server is denied on the next call, with no restart', () => {
    const h = harness()
    expect(h.internals.resolveChannelPolicy().deniedSources).toBeUndefined()

    h.deliver(TIGHTENED)

    // Same manager, same session, no reconstruction anywhere.
    expect(h.internals.resolveChannelPolicy().deniedSources).toEqual(['acme-chat'])
    h.manager.cleanup?.()
  })

  test('a second live reader sees the same tightening, so this is not one wired path', () => {
    const h = harness()
    expect(h.internals.normalizePiPermissionMode('bypassPermissions')).toBe('bypassPermissions')
    h.deliver(TIGHTENED)
    // `disabledPermissionModes: ['allow-all']` now clamps it down.
    expect(h.internals.normalizePiPermissionMode('bypassPermissions')).toBe('auto')
    h.manager.cleanup?.()
  })

  test('the app\'s own defaults are untouched by the tightening', () => {
    const h = harness()
    const before = h.internals.resolveChannelPolicy()
    h.deliver(TIGHTENED)
    const after = h.internals.resolveChannelPolicy()
    // The user switch still decides `enabled`; the managed layer only denies.
    expect(after.enabled).toBe(before.enabled)
    // A server the administrator did not name is not swept up.
    expect(after.deniedSources).not.toContain('other-chat')
    // And a mode the policy says nothing about is unchanged.
    expect(h.internals.normalizePiPermissionMode('default')).toBe('default')
    h.manager.cleanup?.()
  })

  test('an in-flight session is not re-decided — the change reaches the NEXT call only', () => {
    // The stated in-flight contract: a permission decision is minted as a
    // receipt bound to the manifest generation, hash and response epoch, and the
    // executor authorizes against that receipt. The policy is read by the GATE,
    // before the receipt exists, so a policy change cannot reach backwards. The
    // observable half of that here is that adopting a policy mutates no session
    // state: the running session's mode is NOT retroactively re-clamped.
    const h = harness()
    const session = h.internals.sessions.get(encodeSessionKey(h.sessionKey)) as {
      permissionMode: string
      isProcessing: boolean
    }
    h.deliver(TIGHTENED)
    expect(session.permissionMode).toBe('bypassPermissions')
    expect(session.isProcessing).toBe(true)
    // It is the next NORMALIZATION — the next gate — that applies the clamp.
    expect(h.internals.normalizePiPermissionMode(session.permissionMode)).toBe('auto')
    h.manager.cleanup?.()
  })
})

describe('a widening waits for the turn boundary (D4)', () => {
  test('lifting a denial does not land mid-turn', () => {
    const h = harness(TIGHTENED)
    expect(h.internals.resolveChannelPolicy().deniedSources).toEqual(['acme-chat'])
    h.deliver(WIDENED)
    // Still denied: a widening between the gate and the next tool call of the
    // same turn is the case this rule exists to refuse.
    expect(h.internals.resolveChannelPolicy().deniedSources).toEqual(['acme-chat'])
    expect(h.internals.normalizePiPermissionMode('bypassPermissions')).toBe('auto')
    h.manager.cleanup?.()
  })

  test('and lands at the turn boundary', () => {
    const h = harness(TIGHTENED)
    h.deliver(WIDENED)
    h.internals.refreshManagedPiPolicy('turn-boundary')
    expect(h.internals.resolveChannelPolicy().deniedSources).toBeUndefined()
    expect(h.internals.normalizePiPermissionMode('bypassPermissions')).toBe('bypassPermissions')
    h.manager.cleanup?.()
  })

  test('the turn boundary is where the capability runtime is pinned', () => {
    // A source pin: the branch is what a future edit would drop, and every
    // other assertion here would keep passing while the widening never landed.
    // The call sits at the turn boundary, ahead of the
    // `SessionCapabilityTurnRuntime` literal — the one place every per-turn
    // managed value is captured.
    //
    // 2026-09-11 (W12-c) · this pin demanded the two lines be ADJACENT, and
    // `df51f7132` (P6.493) put a second per-turn read between them
    // (`readUserScopeAutoMode`). That insertion is the pin's own subject — a
    // value read at this boundary — so adjacency was never what the row meant,
    // and the next such read would break it again. Re-spelled as ORDER inside
    // ONE method body: the call exists, the literal follows it, and no method
    // ends in between, so a call that drifted into a different method or below
    // the literal still fails.
    const source = readFileSync(join(import.meta.dir, '..', 'SessionManager.ts'), 'utf8')
    const call = source.indexOf("\n      this.refreshManagedPiPolicy('turn-boundary')\n")
    const literal = source.indexOf('\n      const runtime: SessionCapabilityTurnRuntime = {')
    expect(call).toBeGreaterThan(-1)
    expect(literal).toBeGreaterThan(call)
    // `\n  }\n` is a class member closing at this file's indentation, so its
    // absence is what makes "the same method" measurable rather than asserted.
    expect(source.slice(call, literal)).not.toContain('\n  }\n')
  })
})

describe('the re-read fails safe (D4)', () => {
  test('a resolver that throws keeps the policy already being enforced', () => {
    const listeners = new Set<() => void>()
    const manager = createTestSessionManager({
      managedPiPolicy: TIGHTENED,
      resolveManagedPiPolicy: () => { throw new Error('managed-pi-policy-invalid') },
      subscribeManagedPolicyChange: listener => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    })
    const internals = manager as unknown as Internals
    for (const listener of listeners) listener()
    // NOT the empty default policy: an unreadable source must never be a way to
    // clear a fleet's rules.
    expect(internals.resolveChannelPolicy().deniedSources).toEqual(['acme-chat'])
    internals.refreshManagedPiPolicy('turn-boundary')
    expect(internals.resolveChannelPolicy().deniedSources).toEqual(['acme-chat'])
    manager.cleanup?.()
  })

  test('with no resolver seam the construction snapshot stays frozen', () => {
    // Every caller that predates this seam keeps exactly today's behaviour.
    const manager = createTestSessionManager({ managedPiPolicy: TIGHTENED })
    const internals = manager as unknown as Internals
    internals.refreshManagedPiPolicy('turn-boundary')
    expect(internals.resolveChannelPolicy().deniedSources).toEqual(['acme-chat'])
    manager.cleanup?.()
  })
})

/**
 * P6.463 — a delivered managed policy that arrives or changes reaches an audit
 * sink, not only a console warning.
 *
 * `runConfigChangeHooks` has carried the `policy_settings` carve-out since R73
 * with a comment saying "nothing produces `policy_settings` today". This is the
 * producer. Going past the vendor is deliberate: `hooks.md#configchange` says
 * Claude Code "applies server-managed settings ... without running them", so
 * nothing native covers the arrival — while the same page names audit logging
 * as the reason the source exists at all.
 */
describe('an adopted managed policy dispatches ConfigChange (P6.463)', () => {
  type Captured = { event: string; input: Record<string, unknown> }

  const withAutomation = (h: ReturnType<typeof harness>): Captured[] => {
    const captured: Captured[] = []
    for (const managed of (h.internals.sessions as Map<string, Record<string, unknown>>).values()) {
      managed.agentAutomationSystem = {
        hasAgentEventMatchers: () => true,
        executeAgentEvent: async (event: string, input: Record<string, unknown>) => {
          captured.push({ event, input })
          return undefined
        },
      }
    }
    return captured
  }

  test('the event names policy_settings and the KEYS that changed', async () => {
    const h = harness()
    const captured = withAutomation(h)

    h.deliver(TIGHTENED)
    await Promise.resolve()

    expect(captured).toHaveLength(1)
    expect(captured[0]!.event).toBe('ConfigChange')
    expect(captured[0]!.input.source).toBe('policy_settings')
    expect(captured[0]!.input.config_keys).toEqual(['disabledPermissionModes', 'deniedMcpServers'])
    expect(typeof captured[0]!.input.config_digest).toBe('string')
    h.manager.cleanup?.()
  })

  test('no VALUES travel, because a ConfigChange hook is arbitrary shell', async () => {
    const h = harness()
    const captured = withAutomation(h)
    h.deliver(TIGHTENED)
    await Promise.resolve()

    // A managed `env` block routinely holds a credential. The whole payload is
    // searched rather than the fields we happen to think of.
    const payload = JSON.stringify(captured[0]!.input)
    expect(payload).not.toContain('acme-chat')
    expect(payload).not.toContain('bypassPermissions')
    // And no file is named: the enforced policy is composed from two admin
    // sources and naming either would be a guess an audit sink reads as fact.
    expect(captured[0]!.input.file_path).toBeUndefined()
    h.manager.cleanup?.()
  })

  test('fired at ADOPTION — a widening held for the turn boundary emits nothing yet', async () => {
    const h = harness(TIGHTENED)
    const captured = withAutomation(h)

    // Not a pure tightening, so `immediate` holds it.
    h.deliver(WIDENED)
    await Promise.resolve()
    expect(captured).toEqual([])

    // Telling an audit sink a policy is in force before it is would be worse
    // than saying nothing; the turn boundary is where it becomes true.
    h.internals.refreshManagedPiPolicy('turn-boundary')
    await Promise.resolve()
    expect(captured).toHaveLength(1)
    // Both keys moved: the widening lifts the mode clamp AND the denial.
    expect(captured[0]!.input.config_keys).toEqual(['disabledPermissionModes', 'deniedMcpServers'])
    h.manager.cleanup?.()
  })

  test('CONTROL — an unchanged policy dispatches nothing', async () => {
    const h = harness(TIGHTENED)
    const captured = withAutomation(h)
    h.deliver(TIGHTENED)
    await Promise.resolve()
    expect(captured).toEqual([])
    h.manager.cleanup?.()
  })

  /**
   * P6.289 — the one source whose block the page forbids honouring, pinned now
   * that a producer exists. `hooks.md#configchange`: "policy_settings changes
   * can't be blocked. Hooks still fire for policy_settings sources, so you can
   * use them for audit logging, but any blocking decision is ignored."
   *
   * The subject is the SHIPPED reader, not the returned boolean: a blocked
   * dispatch must leave the tightened policy in force, which is what
   * `normalizePiPermissionMode` answers on every mode change and child clamp.
   */
  test('a blocking hook does NOT hold back a managed policy (policy_settings is unblockable)', async () => {
    const h = harness()
    const blocking: { event: string; input: Record<string, unknown> }[] = []
    for (const managed of (h.internals.sessions as Map<string, Record<string, unknown>>).values()) {
      managed.agentAutomationSystem = {
        hasAgentEventMatchers: () => true,
        executeAgentEvent: async (event: string, input: Record<string, unknown>) => {
          blocking.push({ event, input })
          // The documented shape of a hook that says no.
          return { decision: { decision: 'block' as const, reason: 'audit hook says no' } }
        },
      }
    }

    // Control: before the delivery the clamp is not in force.
    expect(h.internals.normalizePiPermissionMode('bypassPermissions')).toBe('bypassPermissions')

    h.deliver(TIGHTENED)
    await Promise.resolve()
    await Promise.resolve()

    // The hook DID fire — audit logging is the reason the source exists.
    expect(blocking).toHaveLength(1)
    expect(blocking[0]!.input.source).toBe('policy_settings')
    // And its block changed nothing: the tightened policy is in force.
    expect(h.internals.normalizePiPermissionMode('bypassPermissions')).not.toBe('bypassPermissions')
    expect(h.internals.resolveChannelPolicy().deniedSources).toContain('acme-chat')
    h.manager.cleanup?.()
  })
})
