/**
 * P2.402 — the PRODUCER for P2.385's child-side gate, and the mutant that lane
 * could not run.
 *
 * P2.385 landed a live gate with a deliberately EMPTY input: `BaseAgent`'s
 * constructor installs `BackendConfig.piSkillDisallowedTools` into the child's
 * `PrerequisiteManager`, the gate refuses correctly, and nothing on earth wrote
 * the field. Its own negative control — `installs nothing when the config
 * carries nothing` — was a description of production. This file is the other
 * end: the parent COLLECTS a preloaded skill's `disallowed-tools` at spawn time
 * and persists them onto the child's record, so the gate finally has something
 * to subtract.
 *
 * Why the removal has to travel at all, rather than being re-derived in the
 * child: `RuntimeSkillHandle` pins `allowed-tools` and NOT `disallowed-tools`,
 * so after `materializeRuntimeSkillInvocation` the names exist nowhere except
 * the parent's `skillInvocations` — and the child's own turn-scoped path never
 * fires, because a preloaded skill arrives as `formatRuntimeSkillInvocation`'s
 * `<invoked-skill …>` block while `parseSkillMentionOccurrences` matches only
 * `[skill:<name>]` (P2.327 measured this and pins it with six tests).
 *
 * The rows are ordered adversarial-first, because the friendly case is the one
 * that proves the least:
 *
 *  - a child with NO ceiling is where this field is the ONLY thing enforcing
 *    the author's removal — a positive NAME list cannot express "everything
 *    except X", so the host-side chokepoint above contributes nothing there;
 *  - a child WITH a ceiling is where the host already subtracted these names
 *    from `tools`, so the child's install is a REDUNDANT idempotent
 *    subtraction — and the field is still written, because one code path beats
 *    two whose difference nobody can see;
 *  - a child whose skills remove nothing must leave the key ABSENT, which is
 *    both the omission convention every optional restriction here follows and
 *    the exact shape a reverted producer takes. That row is the mutant's own
 *    negative control: with edit 2 reverted, rows 1 and 2 collapse INTO it.
 *
 * The gate at the end of each row is the REAL `PrerequisiteManager`, reached by
 * the same cross-package relative import `pi-agent-server`'s harness-contract
 * tests use. Nothing here is a double: the producer is the real port, the value
 * is the persisted record's, and the refusal is the child's own.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { readSessionHeader } from '@nessy-agent/shared/sessions'
import type { PiChildRestrictionsV1 } from '@nessy-agent/shared/agent/pi-harness/child-session-port'
import { PrerequisiteManager } from '../../../../shared/src/agent/core/prerequisite-manager.ts'
import { createTestSessionManager } from './test-session-manager.ts'
import { createPiPermissionService } from '../../pi-harness/permission-service.ts'

const allowAgentAdmission = createPiPermissionService({})

/**
 * The child's install, verbatim: `BaseAgent`'s constructor calls
 * `setPreloadedSkillDeniedTools(config.piSkillDisallowedTools)` and nothing
 * else. Driving the REAL manager is what makes "the child stops subtracting"
 * an observation rather than an inference — feed it `undefined` (a reverted
 * producer) and `checkPrerequisites` says `allowed: true`.
 */
const childGateFor = (restrictions: PiChildRestrictionsV1 | undefined) => {
  const gate = new PrerequisiteManager({ workspaceRootPath: process.cwd() })
  // The projection this row also adds to `SessionManager`, applied to a Pi
  // session: `piSkillDisallowedTools: managed.piChildRestrictions?.skillDisallowedTools`.
  gate.setPreloadedSkillDeniedTools(restrictions?.skillDisallowedTools)
  return gate
}

/**
 * The real `createPiChildSessionPort`, driven to the point where a record is
 * handed to `startPiChildRuntime` — which is the object that gets persisted and
 * the object a restart reloads.
 */
const admitChild = async (options: {
  requestTools?: string[]
  skillDisallowedTools?: string
}): Promise<PiChildRestrictionsV1> => {
  const manager = createTestSessionManager()
  const parent: any = {
    id: 'parent-preloaded-denial',
    workspace: { id: 'workspace-preloaded-denial', rootPath: process.cwd() },
    permissionMode: 'bypassPermissions',
    thinkingLevel: 'off',
    llmConnection: 'pi',
    model: 'm',
    messages: [],
    childSessionState: undefined,
    messagesLoaded: true,
  }
  ;(manager as any).sessions.set(
    encodeSessionKey({ workspaceId: parent.workspace.id, sessionId: parent.id }),
    parent,
  )
  ;(manager as any).persistSession = () => {}
  ;(manager as any).sendEvent = () => {}
  let admitted: any
  ;(manager as any).startPiChildRuntime = async (_parent: unknown, record: any) => {
    admitted = record
    return {
      childSessionKey: { workspaceId: parent.workspace.id, sessionId: 'child-preloaded-denial' },
      transcriptId: 'child-preloaded-denial', status: 'completed', output: 'done', result: 'done',
    }
  }
  const view: any = {
    generation: 'g-preloaded-denial',
    sources: [], mcpServers: [], hooks: [], automations: [], agents: [],
    promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    skills: options.skillDisallowedTools
      ? [{
          key: 'skill://blocker', logicalName: 'blocker', selectedAsUnqualifiedAlias: true,
          resource: { source: 'workspace', resourceId: 'blocker', contentHash: 'e'.repeat(64) },
        }]
      : [],
  }
  const port = await (manager as any).createPiChildSessionPort(
    parent,
    {
      view,
      projectTrustState: 'trusted',
      materializer: {
        assertActive() {},
        async readText() {
          return `---\ndisallowed-tools: ${options.skillDisallowedTools ?? ''}\n---\nBlock.`
        },
      },
    },
    allowAgentAdmission,
    async () => {}, async () => {}, async () => {},
  )
  await port.start({
    requestedAgentId: 'agent-preloaded-denial', agent: 'scout', task: 'inspect', background: false,
    restrictions: {
      prompt: 'p', model: 'm', worktreePolicy: 'shared', thinkingLevel: 'off',
      ...(options.requestTools ? { tools: options.requestTools } : {}),
      ...(options.skillDisallowedTools ? { skillKeys: ['skill://blocker'] } : {}),
    },
    budgets: {
      depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100,
      costLimitUsd: 1, deadlineAt: Date.now() + 60_000, ancestry: [],
    },
  })
  manager.cleanup()
  expect(admitted).toBeDefined()
  return admitted.restrictions as PiChildRestrictionsV1
}

describe('P2.402 — a preloaded skill\'s disallowed-tools reaches the child that was preloaded with it', () => {
  /**
   * THE row. No `tools:` on the request and no parent ceiling, so
   * `narrowedGrantedTools` has nothing to filter and the host-side chokepoint
   * contributes exactly nothing — P2.301 wrote that cost down and P2.385
   * measured its consequence. This field is the whole enforcement.
   */
  test('carries the removal to a child with NO ceiling, where nothing else can', async () => {
    const restrictions = await admitChild({ skillDisallowedTools: 'Bash' })

    // Absent by omission, not `[]`: an absent ceiling means "inherit the parent
    // pool", so the subtraction had no positive list to bite on.
    expect('tools' in restrictions).toBe(false)
    // Canonicalised by `parseSkillToolEntry`, which is why frontmatter `Bash`
    // persists as `bash` — the same normalisation the gate applies to the
    // incoming tool name, so the two sides cannot drift.
    expect(restrictions.skillDisallowedTools).toEqual(['bash'])

    const gate = childGateFor(restrictions)
    expect(gate.checkPrerequisites('Bash')).toEqual({
      allowed: false,
      blockReason: 'Tool "Bash" was removed by a preloaded skill\'s disallowed-tools.',
    })
    // A subtraction, never a ceiling: a tool the author did not name is
    // untouched, so this can never become the host-side pool enumeration
    // P2.301 refused to write.
    expect(gate.checkPrerequisites('Read')).toEqual({ allowed: true })
  })

  /**
   * The redundant case, asserted BECAUSE it is redundant. With a ceiling the
   * host already removed `bash` from `tools`, so the child's install subtracts
   * something already gone — and the field is written anyway. Two code paths
   * whose difference nobody can observe is how one of them rots; the cost here
   * is a string array on a record that already carries six.
   */
  test('writes the field UNCONDITIONALLY, including where the host-side narrowing already removed the tool', async () => {
    const restrictions = await admitChild({ requestTools: ['read', 'bash'], skillDisallowedTools: 'Bash' })

    // The host-side chokepoint did its job…
    expect(restrictions.tools).toEqual(['read'])
    // …and the removal still travels, so the child does not depend on the
    // ceiling having existed.
    expect(restrictions.skillDisallowedTools).toEqual(['bash'])

    const gate = childGateFor(restrictions)
    expect(gate.checkPrerequisites('Bash').allowed).toBe(false)
    expect(gate.checkPrerequisites('Read').allowed).toBe(true)
  })

  /**
   * The negative control, and the mutant's own shape: a child whose skills
   * remove nothing leaves the key ABSENT — the same omission convention
   * `tools`, `maxTurns`, `memory` and `componentHooks` follow, because the
   * record is persisted and a key holding `undefined` is a different record.
   *
   * Revert the producer and rows 1 and 2 become THIS row: the field is absent,
   * `setPreloadedSkillDeniedTools(undefined)` installs nothing, and the child
   * stops subtracting.
   */
  test('leaves the key absent when nothing was removed, and the child then subtracts nothing', async () => {
    const restrictions = await admitChild({ requestTools: ['read', 'bash'] })

    expect('skillDisallowedTools' in restrictions).toBe(false)
    expect(restrictions.skillDisallowedTools).toBeUndefined()
    expect(childGateFor(restrictions).checkPrerequisites('Bash')).toEqual({ allowed: true })
    // The floor: no restrictions at all is the pre-P2.402 world, and it allows.
    expect(childGateFor(undefined).checkPrerequisites('Bash')).toEqual({ allowed: true })
  })

  /**
   * Resume is where a restriction is most likely to be dropped, so it is
   * measured rather than argued. Both host paths that hand restrictions to a
   * child session (`createSession`'s `hostContext.piChild` seed and
   * `startPiChildRuntime`'s post-creation assignment) are one
   * `structuredClone` of the whole object, and the record itself round-trips
   * through the session header — `piChildRestrictions` is one of the persisted
   * header keys, and `readSessionHeader` is the reader a restart uses.
   */
  test('survives the clone both host paths perform and a session-header round trip', async () => {
    const restrictions = await admitChild({ skillDisallowedTools: 'Bash, WebFetch' })
    expect(restrictions.skillDisallowedTools).toEqual(['bash', 'web_fetch'])

    expect(structuredClone(restrictions).skillDisallowedTools).toEqual(['bash', 'web_fetch'])

    const dir = mkdtempSync(join(tmpdir(), 'p2402-header-'))
    try {
      const file = join(dir, 'session.jsonl')
      writeFileSync(file, `${JSON.stringify({
        id: 'child-preloaded-denial',
        workspaceRootPath: process.cwd(),
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        messageCount: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
        piChildRestrictions: restrictions,
      })}\n`, 'utf-8')

      const reloaded = readSessionHeader(file)
      // Positive control: the header really was read, so an absent field below
      // could not be a silently failed read.
      expect(reloaded?.piChildRestrictions?.prompt).toBe(restrictions.prompt)
      expect(reloaded?.piChildRestrictions?.skillDisallowedTools).toEqual(['bash', 'web_fetch'])

      const gate = childGateFor(reloaded?.piChildRestrictions)
      expect(gate.checkPrerequisites('Bash').allowed).toBe(false)
      expect(gate.checkPrerequisites('WebFetch').allowed).toBe(false)
      expect(gate.checkPrerequisites('Read').allowed).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const readSource = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

/**
 * The projection lives inside `getOrCreateAgentUnchecked`, which a unit test
 * cannot drive without constructing an agent — the same constraint
 * `claude-cron-port-binding.test.ts` recorded for its two bindings, and the
 * same remedy: read the file as text, with a positive control so an emptied or
 * moved file cannot read as a pass.
 */
describe('P2.402 — the projection is wired, and it is Pi-only on purpose', () => {
  test('projects the persisted names onto the Pi backend config, beside the ceiling', () => {
    const source = readSource('../SessionManager.ts')
    const line = "piSkillDisallowedTools: provider === 'pi' ? managed.piChildRestrictions?.skillDisallowedTools : undefined,"
    expect(source.split(line).length - 1).toBe(1)
    // Positive control: the sibling it sits beside, read from the same
    // persisted object, is still there — so the assertion above is measuring
    // this binding rather than the whole expression style.
    //
    // 2026-09-11 (W12-c) · this control was a single-line literal and the
    // binding became a four-line expression — `56ae4a7cd` wrapped it, then
    // `fb011ffcb` (P6.940) put `intersectSessionToolCeilings(…)` on its `??`
    // arm — so the control failed on formatting while the binding it guards was
    // intact. Whitespace-collapsed, and pinned on the two halves that carry the
    // control's meaning (the `'pi'` gate, and the SAME persisted object the
    // assertion above reads) rather than on the ceiling expression, which is a
    // separate row's and has already moved twice. Same remedy as
    // `claude-worktree-port-binding.test.ts`'s G-1.
    const flat = source.replace(/\s+/g, ' ')
    expect(flat).toContain("piAllowedTools: provider === 'pi' ? (managed.piChildRestrictions?.tools")
  })

  /**
   * The asymmetry is the FINDING, not an oversight, so it is measured at the
   * other runtime rather than asserted in a comment here: Claude's route
   * already unions the same names into `AgentDefinition.disallowedTools`, an
   * agent-LIFETIME field the SDK enforces. Projecting them onto that route as
   * well would double-apply a removal it never dropped.
   */
  test('the claude route already enforces the same removal natively', () => {
    const source = readSource('../../../../shared/src/agent/claude-runtime-agents.ts')
    expect(source).toContain('invocation.restrictions.disallowedTools')
    expect(source).toContain('disallowedTools: [...effectiveDisallowedTools]')
    // Positive control: this is the agent-definition builder and not some
    // unrelated file that happens to mention the word.
    expect(source).toContain('AgentDefinition')
  })
})
