/**
 * C3.312 — the claude card's "always allow" answer, as the producer C3.278's
 * seam was built for.
 *
 * C3.278 wired the echo seam and C3.279 the boundary that vets it, and both
 * landed with nothing able to fire them: the card was raised with
 * `noAlwaysAllow: true` unconditionally and `ClaudeToolApprovalAnswer` carried no
 * remember field, so C3.7's measured mid-turn grant was unreachable by a user.
 *
 * ## The measurement that shaped the predicate, and it is the row's real finding
 *
 * The runtime's own `suggestions` are the documented mechanism behind this
 * button — and they are NOT one kind. Driven 2026-09-12 through the offline
 * loopback rig (`fixtures/claude-permission-update-probe.ts`, extended to record
 * the option) against the vendored `2.1.247`, on a three-request turn in
 * `default` mode, the runtime offered a suggestion on BOTH consultations:
 *
 *  - for the `Write` inside the working directory:
 *    `{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }`
 *  - for the `Read` of a path outside it:
 *    `{ type: 'addRules', behavior: 'allow', destination: 'session',
 *       rules: [{ toolName: 'Read', ruleContent: '//<dir>/**' }] }`
 *
 * So "always allow this edit" is a MODE CHANGE here, which
 * `claudeSessionPermissionUpdateBoundary` refuses — C3.281 measured the runtime
 * reporting success for a `setMode` it does not apply. A button offered there
 * would be a click that does nothing followed by C3.314's notice explaining why.
 * Hence the predicate is the BOUNDARY, run over the runtime's own suggestions,
 * asking whether anything survives.
 *
 * ## Both shapes are pinned below as CONSTANTS taken from that run
 *
 * The rig is gated on the native binary; these two suggestion payloads are not,
 * so the predicate's two arms are a committed gate. If the runtime starts
 * offering a different kind for either call, the arm that matters — an edit card
 * must not offer the button — is the one that goes red.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ClaudeAgent, claudeToolApprovalRequest, buildClaudeCanUseTool } from '../claude-agent.ts'
import type { BackendConfig } from '../backend/types.ts'
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'

/** Verbatim from the 2026-09-12 run, for the `Write` inside the working directory. */
const EDIT_SUGGESTION = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]

/** Verbatim from the same run, for the `Read` of a path outside it. */
const OUTSIDE_READ_SUGGESTION = [{
  type: 'addRules',
  rules: [{ toolName: 'Read', ruleContent: '//private/var/folders/T/outside/**' }],
  behavior: 'allow',
  destination: 'session',
}]

function callOptions(overrides: Record<string, unknown> = {}): Parameters<CanUseTool>[2] {
  return {
    signal: new AbortController().signal,
    toolUseID: 'toolu_c3312',
    requestId: 'req_c3312',
    ...overrides,
  } as never
}

describe('C3.312 — which cards may offer the button', () => {
  it('OFFERS it for the outside read, whose suggestion the boundary forwards', () => {
    const request = claudeToolApprovalRequest(
      'Read',
      { file_path: '/private/var/folders/T/outside/notes.md' },
      callOptions({ suggestions: OUTSIDE_READ_SUGGESTION, blockedPath: '/private/var/folders/T/outside/notes.md' }),
    )

    expect(request.canRememberForSession).toBe(true)
  })

  it('WITHHOLDS it for an edit, because the runtime\'s own suggestion is a setMode', () => {
    const request = claudeToolApprovalRequest(
      'Write',
      { file_path: '/repo/scratch.txt' },
      callOptions({ suggestions: EDIT_SUGGESTION }),
    )

    // The arm this row turns on. A `setMode` is refused by the boundary AND
    // measured to do nothing on this runtime, so offering the button would
    // promise what neither side delivers.
    expect(request.canRememberForSession).toBeUndefined()
    expect(request.type).toBe('file_write')
  })

  it('WITHHOLDS it when the runtime offered nothing at all', () => {
    const noOption = claudeToolApprovalRequest('WebFetch', {}, callOptions())
    const emptyArray = claudeToolApprovalRequest('WebFetch', {}, callOptions({ suggestions: [] }))

    // Absent and empty are the same answer here, and neither may be read as
    // "offer it and hope".
    expect(noOption.canRememberForSession).toBeUndefined()
    expect(emptyArray.canRememberForSession).toBeUndefined()
  })

  /**
   * C4.46 (OWNER, 2026-09-13) — this arm is INVERTED, and the inversion is the
   * row.
   *
   * It read *"WITHHOLDS it on a Bash card even with a forwardable suggestion —
   * the stated posture"* and asserted `canRememberForSession` undefined. C3.312
   * held `bash` back because `SessionManager.persistBashAlwaysAllowRule` fires
   * on the same click and writes a PERMANENT per-repository rule; the owner took
   * the session grant and the persist cut together, so the clause is gone here
   * and the permanent write is refused for a `claude_native` card in
   * `SessionManager.respondToPermission` (pinned by
   * `packages/server-core/src/sessions/__tests__/claude-bash-session-grant-persist-cut.test.ts`).
   *
   * The two halves must not be assertable apart, which is why this arm also
   * pins WHAT the grant covers: the runtime's own `ruleContent`, and nothing
   * wider.
   */
  it('C4.46 · OFFERS it on a Bash card whose suggestion the boundary forwards', () => {
    const bashSuggestion = [{
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }],
      behavior: 'allow',
      destination: 'session',
    }]
    const request = claudeToolApprovalRequest('Bash', { command: 'ls' }, callOptions({ suggestions: bashSuggestion }))

    expect(request.canRememberForSession).toBe(true)
    expect(request.type).toBe('bash')

    // The predicate is the boundary and nothing else now, so the same
    // suggestion answers the same way on a non-Bash call — the pair that made
    // the old exclusion a posture rather than a coincidence, kept as the
    // evidence that nothing else moved.
    const sameSuggestionOnANonBashCall = claudeToolApprovalRequest(
      'mcp__github__create_issue',
      {},
      callOptions({ suggestions: bashSuggestion }),
    )
    expect(sameSuggestionOnANonBashCall.canRememberForSession).toBe(true)
  })

  it('C4.46 · NEGATIVE — a Bash card whose suggestion is NOT session-scoped still withholds it', () => {
    // The grant is session-scoped ONLY. A `localSettings` destination is what a
    // permanent per-repository rule would arrive as, and the boundary refuses
    // it — so the widening the owner declined cannot re-enter through the
    // runtime's own suggestion either.
    const durable = claudeToolApprovalRequest('Bash', { command: 'ls' }, callOptions({
      suggestions: [{
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }],
        behavior: 'allow',
        destination: 'localSettings',
      }],
    }))
    expect(durable.canRememberForSession).toBeUndefined()

    // And an edit card is untouched by this row: its suggestion is a `setMode`,
    // which the boundary refuses for its own reasons (C3.281).
    const edit = claudeToolApprovalRequest('Write', { file_path: '/repo/a.txt' }, callOptions({
      suggestions: EDIT_SUGGESTION,
    }))
    expect(edit.canRememberForSession).toBeUndefined()
  })
})

describe('C4.46 — the Bash grant covers the runtime\'s own rule and nothing wider', () => {
  const BASH_SUGGESTION = [{
    type: 'addRules',
    rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }],
    behavior: 'allow',
    destination: 'session',
  }]

  function canUseTool(answer: { allowed: boolean; rememberForSession?: boolean }) {
    return buildClaudeCanUseTool({
      askUser: async () => { throw new Error('not used') },
      askPermission: async () => answer,
      alreadyApprovedByGate: () => false,
      permissionMode: () => 'default',
      sessionPermissionGrant: ({ answer: given, suggestions }) => (
        given.rememberForSession === true ? suggestions : undefined
      ),
    })
  }

  it('POSITIVE — a remembered Bash approval echoes the runtime\'s session rule', async () => {
    const result = await canUseTool({ allowed: true, rememberForSession: true })(
      'Bash',
      { command: 'ls -la' },
      callOptions({ suggestions: BASH_SUGGESTION }),
    )

    const updates = (result as { updatedPermissions?: unknown[] }).updatedPermissions
    // This IS the mechanism by which the next identical call in the same session
    // is answered without a card: the runtime applies its own suggestion at
    // `destination: 'session'`. C3.7 measured on the vendored 2.1.247 that such
    // an entry binds for the rest of the turn and writes nothing anywhere.
    expect(updates).toEqual(BASH_SUGGESTION)
  })

  it('NEGATIVE — a differently-shaped command is not covered, and nothing leaves the session', async () => {
    const result = await canUseTool({ allowed: true, rememberForSession: true })(
      'Bash',
      { command: 'ls -la' },
      callOptions({ suggestions: BASH_SUGGESTION }),
    )
    const updates = (result as { updatedPermissions?: Array<Record<string, unknown>> }).updatedPermissions

    // Read into locals first, then assert — the echoed rule is the runtime's
    // own `ls:*`, so `rm -rf /` is not in it, and the destination is `session`,
    // so a new session inherits nothing. The grant cannot be widened here: the
    // boundary forwards only an entry that ECHOES what was offered for THIS
    // call.
    const rules = updates?.[0]?.rules as Array<Record<string, unknown>> | undefined
    expect(rules?.[0]?.ruleContent).toBe('ls:*')
    expect(updates?.[0]?.destination).toBe('session')
    expect(updates).toHaveLength(1)
  })

  it('NEGATIVE — an allow-once Bash answer produces no grant at all', async () => {
    const result = await canUseTool({ allowed: true })(
      'Bash',
      { command: 'ls -la' },
      callOptions({ suggestions: BASH_SUGGESTION }),
    )

    expect(result).toEqual({ behavior: 'allow' })
  })
})

describe('C3.312 — the answer produces the grant, and only what the runtime offered', () => {
  function canUseTool(answer: { allowed: boolean; rememberForSession?: boolean }) {
    return buildClaudeCanUseTool({
      askUser: async () => { throw new Error('not used') },
      askPermission: async () => answer,
      alreadyApprovedByGate: () => false,
      permissionMode: () => 'default',
      // The production wiring, copied so the test measures the seam rather than
      // a convenient stand-in.
      sessionPermissionGrant: ({ answer: given, suggestions }) => (
        given.rememberForSession === true ? suggestions : undefined
      ),
    })
  }

  it('echoes the runtime\'s own suggestion when the user said always', async () => {
    const result = await canUseTool({ allowed: true, rememberForSession: true })(
      'Read',
      { file_path: '/private/var/folders/T/outside/notes.md' },
      callOptions({ suggestions: OUTSIDE_READ_SUGGESTION }),
    )

    const updates = (result as { updatedPermissions?: unknown[] }).updatedPermissions
    expect(updates).toEqual(OUTSIDE_READ_SUGGESTION)
  })

  it('returns nothing when the user said allow-once', async () => {
    const result = await canUseTool({ allowed: true })(
      'Read',
      { file_path: '/private/var/folders/T/outside/notes.md' },
      callOptions({ suggestions: OUTSIDE_READ_SUGGESTION }),
    )

    expect(result).toEqual({ behavior: 'allow' })
  })

  it('a setMode suggestion cannot escape even if a remember answer reaches the seam', async () => {
    // Defence in depth: the card should never have offered the button here, and
    // if a client ignored `noAlwaysAllow` the boundary is still the thing that
    // decides. Belt and braces, because `apps/ios/PROTOCOL-CONFORMANCE.md`
    // records ignoring that field as a real client shape.
    const result = await canUseTool({ allowed: true, rememberForSession: true })(
      'Write',
      { file_path: '/repo/scratch.txt' },
      callOptions({ suggestions: EDIT_SUGGESTION }),
    )

    expect(result).toEqual({ behavior: 'allow' })
    expect('updatedPermissions' in (result as object)).toBe(false)
  })
})

describe('C3.312 — the card and the answer, through the real agent', () => {
  const agents: ClaudeAgent[] = []
  afterEach(() => { for (const agent of agents.splice(0)) agent.destroy() })

  function makeAgent(): ClaudeAgent {
    const root = mkdtempSync(join(tmpdir(), 'c3312-ws-'))
    const agent = new ClaudeAgent({
      provider: 'anthropic',
      providerType: 'anthropic',
      model: 'claude-sonnet-4-6',
      isHeadless: true,
      skipConfigWatcher: true,
      workspace: {
        id: 'ws-c3312', name: 'C3312', rootPath: root,
        workspaceRootPath: root, sessionRootPath: join(root, 'sessions'),
      } as never,
      session: { id: 'sess-c3312', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: root } as never,
    } as BackendConfig)
    agents.push(agent)
    return agent
  }

  interface Internals {
    onPermissionRequest: ((request: Record<string, unknown>) => void) | null
    askToolApproval: (request: unknown, signal?: AbortSignal) => Promise<unknown>
    respondToPermission: (requestId: string, allowed: boolean, alwaysAllow?: boolean) => void
    permissionManager: {
      getWhitelistedCommands: () => Set<string>
      whitelistCommand: (baseCommand: string) => void
      getBaseCommand: (command: string) => string
    }
  }

  function drive(canRememberForSession: boolean, alwaysAllow: boolean) {
    const agent = makeAgent()
    const internals = agent as unknown as Internals
    let card: Record<string, unknown> | undefined
    internals.onPermissionRequest = request => { card = request }
    const answer = internals.askToolApproval({
      requestId: 'perm-c3312',
      toolName: 'Read',
      command: '/private/var/folders/T/outside/notes.md',
      description: 'Read a file outside the working directory',
      ...(canRememberForSession ? { canRememberForSession: true } : {}),
    })
    internals.respondToPermission('perm-c3312', true, alwaysAllow)
    return { agent, internals, card: () => card, answer }
  }

  it('sends noAlwaysAllow: false and brings the answer back as rememberForSession', async () => {
    const driven = drive(true, true)

    expect(driven.card()?.noAlwaysAllow).toBe(false)
    // `claude_native` unchanged: the card's origin is still the runtime's own
    // rules asking, which is what the renderer reads to label it.
    expect(driven.card()?.origin).toBe('claude_native')
    expect(await driven.answer).toEqual({ allowed: true, rememberForSession: true })
  })

  it('still withholds the button, and the field, on a card the predicate refused', async () => {
    const driven = drive(false, true)

    expect(driven.card()?.noAlwaysAllow).toBe(true)
    // Re-tested at the settle: a client that ignored `noAlwaysAllow` and sent
    // `alwaysAllow` anyway produces NO grant.
    expect(await driven.answer).toEqual({ allowed: true })
  })

  it('an allow-once answer carries no remember field', async () => {
    const driven = drive(true, false)

    expect(await driven.answer).toEqual({ allowed: true })
  })

  it('does NOT write the host command whitelist, which is the wrong store here', async () => {
    const driven = drive(true, true)
    await driven.answer
    const manager = driven.internals.permissionManager

    // The path `command` is not a command; its `getBaseCommand` is not one
    // either, and on this runtime a host whitelist entry cannot suppress a
    // prompt the SDK's own rules raise. So the runtime's session rule is the
    // whole effect of the click, and the host store stays clean.
    const base = manager.getBaseCommand('/private/var/folders/T/outside/notes.md')
    expect([...manager.getWhitelistedCommands()]).not.toContain(base)

    // POSITIVE CONTROL on the same rig and the same reader: without it this is
    // an absence measured through a getter that might not exist (the first draft
    // of this test read `getAlwaysAllowedCommands`, which does not, and passed
    // vacuously).
    manager.whitelistCommand(base)
    expect([...manager.getWhitelistedCommands()]).toContain(base.toLowerCase())
  })
})
