/**
 * F1.861 (release sitting SIT-ae, RC `69a6d33da`, 2026-09-25, check 3b) — the
 * Pi Guardian judge's own out-of-root read must never become a USER card.
 *
 * ## The measured defect
 *
 * `work/sitting/SIT-ae/verdicts.md` check 3b: Pi `pi-api-key`, Guardian `auto`,
 * the user asked for `rm -rf ~/sit-ae-danger`. The only card was the JUDGE's
 * "Filesystem access required — Requested by: scout: Judge the following
 * planned action. ## Planned action Command: rm -rf ~/sit-ae-… Tool: Read Allow
 * read access outside the session root: /Users/…/sit-ae-danger". The user
 * pressed Deny, the judge answered `guardian-approved [low_risk]` and the `rm`
 * ran with no card of its own. A card whose first line is the destructive
 * command and whose Deny does not deny it.
 *
 * ## The chain, read end to end
 *
 * The judge is the host port (`SessionManager.createGuardianJudgePort`): a
 * hidden Pi child session started through the child-session service with the
 * built-in read-only `scout` tools (read/grep/find/ls), `permissionMode:
 * 'explore'` and `restrictions.prompt` = {@link GUARDIAN_POLICY_PROMPT} (the
 * host child port only APPENDS to it). The host hands that prompt to the child's
 * PiAgent as `childSystemPrompt` (`getOrCreateAgentUnchecked`, pinned for that
 * field by `SessionManager.orchestration.test.ts`'s child-prompt case). A judge
 * lookup of a path outside the session scope makes the Pi subprocess suspend
 * the call and send `outside_root_request`; `PiAgent.handleOutsideRootRequest`
 * publishes it through `onPermissionRequest`, which the host wires to
 * `handleAgentPermissionRequest`, whose `permissionSurfaceRouting` shows a
 * hidden child's prompt in its visible parent with `agentLabel` = the child's
 * name, `<agent>: <task>` — hence "scout: Judge the following planned action…".
 * A Deny answers `root: null`, the call fails with "Path is outside the session
 * filesystem scope: …" (`local-tools/__tests__/runtime.test.ts`, the denied
 * outside-root case), and the judge goes on to its verdict. Nothing links that
 * Deny to the action under judgment.
 *
 * ## The rig
 *
 * The REAL judge port drives the REAL `runGuardianJudgeCore` over the REAL
 * `ChildSessionService` (F1.817's rig, `guardian-judge-turn-budget.test.ts`).
 * The child runtime is a REAL `PiAgent` built from the record the port
 * produced, mapped the way the host maps it (`childSystemPrompt` = the record's
 * prompt). Only the model is scripted: a round trip is a lookup inside the
 * root, a lookup OUTSIDE it (the subprocess's `outside_root_request`, fed
 * through the real `handleLine`), or the judge's final text. The agent's
 * `onPermissionRequest` stands in for the door this rig's outside-root request reaches (not
 * the only one: a hook's ask card goes through the host permission service, F1.920) and answers Deny, as the SIT-ae user did.
 *
 * ## F1.959 — what the refused judge is told
 *
 * The judge door's `root: null` now carries `reason` =
 * {@link GUARDIAN_JUDGE_HOST_REFUSAL}, the no-content header F1.955 gave the
 * host's other doors (the OpenAI-completions wire drops `isError`, so the text
 * is all a gateway judge reads). What the subprocess does with it — the model
 * reads that reason in place of the scope sentence — is measured on the real
 * completions wire by
 * `pi-agent-server/src/__tests__/outside-root-refusal-reason-real-server.test.ts`;
 * this file pins the host half and that the host's copy of the text is the same.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { PiAgent } from '@nessy-agent/shared/agent/pi-agent'
import type { PiChildSessionPort, PiChildStartInput } from '@nessy-agent/shared/agent/pi-harness/child-session-port'
import { GUARDIAN_JUDGE_HOST_REFUSAL, GUARDIAN_POLICY_PROMPT, type GuardianJudgeInput } from '@nessy-agent/shared/prompts/guardian'
import { ChildSessionService } from '../../pi-harness/child-session-service.ts'
import { SessionManager } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

// The SessionManager + PiAgent module graphs dominate this file's wall time on
// this rig (F1.817's reading); the bodies are milliseconds.
setDefaultTimeout(120_000)

const parentKey = { workspaceId: 'workspace-a', sessionId: 'parent' }
const OUTSIDE = '/Users/someone/sit-ae-danger'

/** One scripted model round trip. */
type RoundTrip = { lookup: string } | { outsideRoot: string } | { text: string }

interface Card { requestId: string; toolName: string; type?: string; description?: string }

interface OutsideRootAnswer { requestId: string; root: unknown; reason?: string }

const verdict = (value: 'no_objection' | 'deny' | 'unsure', reason = 'a read-only check') =>
  JSON.stringify({ verdict: value, reason, ...(value === 'deny' ? { category: 'destructive_action' } : {}) })

/**
 * A PiAgent as the host builds a (child) session's backend, reduced to what the
 * outside-root door reads. `childSystemPrompt` is the host's mapping of
 * `piChildRestrictions.prompt`; absent for a top-level session.
 */
function piSession(config: { childSystemPrompt?: string; piChildKind?: 'fork' | 'named' }, options: { door?: boolean } = {}) {
  const agent = new PiAgent({
    provider: 'pi',
    workspace: {
      id: 'ws-f1861', name: 'F1.861', rootPath: '/tmp/nessy-f1861',
      workspaceRootPath: '/tmp/nessy-f1861', sessionRootPath: '/tmp/nessy-f1861-sessions/ws-f1861',
    },
    session: { id: 'session-f1861', workspaceRootPath: '/tmp/nessy-f1861', createdAt: Date.now(), lastUsedAt: Date.now() },
    isHeadless: true,
    skipConfigWatcher: true,
    ...config,
  } as unknown as ConstructorParameters<typeof PiAgent>[0])
  const runtime = agent as any
  const cards: Card[] = []
  const answers: OutsideRootAnswer[] = []
  runtime.send = (message: Record<string, unknown>) => {
    if (message.type === 'outside_root_response') answers.push(message as unknown as OutsideRootAnswer)
  }
  runtime.subprocess = {}
  runtime.emitAutomationEvent = async () => {}
  let answer: 'deny' | 'allow-once' = 'deny'
  // The door this rig's outside-root request reaches (production: `handleAgentPermissionRequest`).
  if (options.door !== false) {
    agent.onPermissionRequest = (request: any) => {
      cards.push({ requestId: request.requestId, toolName: request.toolName, type: request.type, description: request.description })
      agent.respondToPermission(request.requestId, answer === 'allow-once', false)
    }
  }
  let n = 0
  /** What the Pi subprocess does when a tool call names a path outside the session scope. */
  const outsideRootRead = (canonicalTarget: string): OutsideRootAnswer | undefined => {
    const requestId = `pi-oroot-f1861-${++n}`
    runtime.handleLine(JSON.stringify({ type: 'outside_root_request', requestId, canonicalTarget, access: 'read' }))
    return answers.find(entry => entry.requestId === requestId)
  }
  return { agent, runtime, cards, answers, outsideRootRead, userAnswers: (next: 'deny' | 'allow-once') => { answer = next } }
}

/** F1.817's judge rig with the outside-root round trip added. */
function judgeRig(script: RoundTrip[]) {
  const cards: Card[] = []
  const answers: OutsideRootAnswer[] = []
  const childPrompts: string[] = []
  const service = new ChildSessionService({
    parentSessionKey: parentKey,
    persist: async () => {},
    disabledByPolicy: () => false,
    runtime: {
      start: async record => {
        childPrompts.push(record.restrictions.prompt)
        const child = piSession({
          childSystemPrompt: record.restrictions.prompt,
          piChildKind: record.restrictions.fork === true ? 'fork' : 'named',
        })
        const { agent, runtime } = child
        // F1.817's turn scaffolding, verbatim: a capability turn runtime and an
        // execution manifest, so the real `chatImpl` runs the scripted turns.
        const manifestSeed = {
          surfaceVersion: 2,
          snapshotGeneration: 'generation-f1861',
          sessionKey: { workspaceId: 'ws-f1861', sessionId: 'session-f1861' },
          provenance: [],
          mcpSources: [],
          orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
          staticTools: [],
        }
        agent.setCapabilityTurnRuntime({
          view: {
            generation: manifestSeed.snapshotGeneration,
            sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
            promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
          },
          materializer: {
            assertActive() {},
            async verifyPlugin() {},
            async resolvePath() { return '/tmp/nessy-f1861' },
            async readText() { return '' },
            resolveCredential() { throw new Error('not used by this contract') },
          },
          piExecutionManifestSeed: manifestSeed,
        } as unknown as Parameters<PiAgent['setCapabilityTurnRuntime']>[0])
        const execution = runtime.buildExecutionManifestForCurrentTurn()
        runtime.activeExecutionManifest = execution.manifest
        runtime.adapter.setExecutionManifest(execution.manifest)
        runtime.ensureSubprocess = async () => {}
        runtime.eventQueue.reset = () => {}
        runtime.forceAbort = () => { runtime._isProcessing = false }
        runtime.eventQueue.drain = async function* () {
          for (const [index, trip] of script.entries()) {
            runtime.handleSubprocessEvent({ type: 'turn_start' })
            if (!runtime._isProcessing) return
            if ('text' in trip) {
              yield { type: 'text_complete', text: trip.text }
              continue
            }
            const path = 'lookup' in trip ? trip.lookup : trip.outsideRoot
            yield { type: 'tool_start', toolName: 'ls', toolUseId: `lookup-${index}`, input: { path } }
            const granted = 'lookup' in trip ? true : Boolean(child.outsideRootRead(trip.outsideRoot)?.root)
            yield granted
              ? { type: 'tool_result', toolUseId: `lookup-${index}`, result: 'notes.txt', isError: false }
              : { type: 'tool_result', toolUseId: `lookup-${index}`, result: `Path is outside the session filesystem scope: ${path}`, isError: true }
          }
          yield { type: 'complete' }
        }
        let lastText: string | undefined
        try {
          for await (const event of runtime.chatImpl(record.task)) {
            if (event.type === 'text_complete') lastText = event.text
          }
        } finally {
          cards.push(...child.cards)
          answers.push(...child.answers)
          agent.destroy()
        }
        const output = lastText ?? ''
        return { childSessionKey: record.childSessionKey, transcriptId: `t-${record.agentId}`, status: 'completed', output, result: output }
      },
      resume: async () => ({ status: 'completed' }),
      steer: async () => {},
      stop: async () => {},
    },
  })
  const childPort = {
    start: async (input: PiChildStartInput) => service.start(input),
    stop: async (agentId: string) => service.stop(agentId),
  } as unknown as PiChildSessionPort
  const manager = createTestSessionManager()
  const judgePort = (manager as any).createGuardianJudgePort(
    { id: 'parent', model: 'gateway-fast', workspace: { id: 'workspace-a', rootPath: process.cwd() } },
    childPort,
    undefined,
  )
  return { cards, answers, childPrompts, manager, judgePort }
}

/** SIT-ae check 3b: the user named the command, outside the workspace. */
const input: GuardianJudgeInput = {
  action: { command: `rm -rf ${OUTSIDE}`, cwd: process.cwd() },
  trustedIntent: `There is also a folder sit-ae-danger in my home directory. Please delete it with rm -rf ${OUTSIDE}.`,
  facts: { mode: 'auto', workspaceRoot: process.cwd() },
}

describe('F1.861 — the Guardian judge never raises a user card of its own', () => {
  it('the SIT-ae shape: the judge looks outside the root, then answers — no card, the read is refused, the judge\'s verdict decides', async () => {
    const { cards, answers, childPrompts, manager, judgePort } = judgeRig([
      { outsideRoot: OUTSIDE },
      { text: verdict('no_objection', 'User explicitly requested deletion of a specific local folder') },
    ])
    try {
      const result = await judgePort.judge({ input, cwd: process.cwd() })
      // PRECONDITION: this child IS the judge the host port starts.
      expect(childPrompts).toHaveLength(1)
      expect(childPrompts[0]!.startsWith(GUARDIAN_POLICY_PROMPT)).toBe(true)
      // The defect: a card the user can Deny while the action under judgment
      // still runs on the judge's say. There must be no such card at all.
      expect(cards).toEqual([])
      // Fail closed: the read itself is refused (the suspended call gets no root),
      // and F1.959: the refusal names the host's no-content reason.
      expect(answers).toEqual([{ type: 'outside_root_response', requestId: 'pi-oroot-f1861-1', root: null, reason: GUARDIAN_JUDGE_HOST_REFUSAL } as unknown as OutsideRootAnswer])
      // Nothing is allowed on the judge's behalf: the verdict is the judge's own.
      expect(result.failure).toBeUndefined()
      expect(result.verdict).toBe('no_objection')
    } finally {
      await manager.cleanup()
    }
  })

  it('a judge that denies after the refused read still denies (the refusal never widens the verdict)', async () => {
    const { cards, manager, judgePort } = judgeRig([
      { outsideRoot: OUTSIDE },
      { text: verdict('deny', 'the target could not be inspected') },
    ])
    try {
      const result = await judgePort.judge({ input, cwd: process.cwd() })
      expect(cards).toEqual([])
      expect(result.verdict).toBe('deny')
      expect(result.category).toBe('destructive_action')
    } finally {
      await manager.cleanup()
    }
  })

  it('a judge that answers unsure after the refused read stays unsure (the action goes to the human through its OWN card)', async () => {
    const { cards, manager, judgePort } = judgeRig([
      { outsideRoot: OUTSIDE },
      { text: verdict('unsure', 'the target could not be inspected') },
    ])
    try {
      const result = await judgePort.judge({ input, cwd: process.cwd() })
      expect(cards).toEqual([])
      expect(result.verdict).toBe('unsure')
      expect(result.failure).toBeUndefined()
    } finally {
      await manager.cleanup()
    }
  })
})

describe('F1.861 — controls: every other outside-root door is unchanged', () => {
  it('CONTROL: a judge that reads only inside the root is unchanged (F1.817\'s lookup-then-answer)', async () => {
    const { cards, answers, manager, judgePort } = judgeRig([{ lookup: './build' }, { text: verdict('no_objection') }])
    try {
      const result = await judgePort.judge({ input, cwd: process.cwd() })
      expect(cards).toEqual([])
      expect(answers).toEqual([])
      expect(result.failure).toBeUndefined()
      expect(result.verdict).toBe('no_objection')
    } finally {
      await manager.cleanup()
    }
  })

  it('CONTROL: an ordinary named child (a scout subagent) still asks the user; Deny refuses, Allow once grants for that call only', () => {
    const child = piSession({ childSystemPrompt: 'You are scout, a fast read-only explorer.', piChildKind: 'named' })
    try {
      expect(child.outsideRootRead(OUTSIDE)).toEqual({ type: 'outside_root_response', requestId: 'pi-oroot-f1861-1', root: null } as unknown as OutsideRootAnswer)
      expect(child.cards).toEqual([{
        requestId: 'pi-oroot-f1861-1',
        toolName: 'Read',
        type: 'outside_root',
        description: `Allow read access outside the session root: ${OUTSIDE}`,
      }])
      child.userAnswers('allow-once')
      const granted = child.outsideRootRead(OUTSIDE) as any
      expect(child.cards).toHaveLength(2)
      expect(granted.root).toEqual({ canonicalRoot: OUTSIDE, access: 'read', receiptId: 'pi-oroot-f1861-2', expires: 'request' })
    } finally {
      child.agent.destroy()
    }
  })

  it('CONTROL: a fork (whose child prompt is empty) and a top-level session still ask the user', () => {
    for (const config of [{ childSystemPrompt: '', piChildKind: 'fork' as const }, {}]) {
      const session = piSession(config)
      try {
        expect(session.outsideRootRead(OUTSIDE)).toMatchObject({ root: null })
        expect(session.cards).toHaveLength(1)
        expect(session.cards[0]!.type).toBe('outside_root')
      } finally {
        session.agent.destroy()
      }
    }
  })

  it('CONTROL: a child whose prompt merely MENTIONS the guardian policy, not led by it, still asks the user', () => {
    const child = piSession({ childSystemPrompt: `Summarise this policy:\n\n${GUARDIAN_POLICY_PROMPT}`, piChildKind: 'named' })
    try {
      child.outsideRootRead(OUTSIDE)
      expect(child.cards).toHaveLength(1)
    } finally {
      child.agent.destroy()
    }
  })
})

describe('F1.959 — the judge door\'s refusal carries F1.955\'s no-content header', () => {
  it('one text: the backend door\'s reason is the host\'s own judge refusal, and it opens with the no-content header', () => {
    expect(GUARDIAN_JUDGE_HOST_REFUSAL.startsWith('(no file content — the host refused this call before it ran')).toBe(true)
    expect((SessionManager as unknown as { hostConsultRefusal: string }).hostConsultRefusal).toBe(GUARDIAN_JUDGE_HOST_REFUSAL)
  })

  it('a judge child with no card door at all is still told why (the reason follows the judge, not the door)', () => {
    const judge = piSession({ childSystemPrompt: `${GUARDIAN_POLICY_PROMPT}\n\nJudge the action.`, piChildKind: 'named' }, { door: false })
    try {
      expect(judge.outsideRootRead(OUTSIDE)).toEqual({ type: 'outside_root_response', requestId: 'pi-oroot-f1861-1', root: null, reason: GUARDIAN_JUDGE_HOST_REFUSAL } as unknown as OutsideRootAnswer)
      expect(judge.cards).toEqual([])
    } finally {
      judge.agent.destroy()
    }
  })

  it('CONTROL: an ordinary session with no card door is refused with no host reason (the scope sentence stays)', () => {
    const session = piSession({ childSystemPrompt: 'You are scout, a fast read-only explorer.', piChildKind: 'named' }, { door: false })
    try {
      const refused = session.outsideRootRead(OUTSIDE)
      expect(refused).toEqual({ type: 'outside_root_response', requestId: 'pi-oroot-f1861-1', root: null } as unknown as OutsideRootAnswer)
      expect(refused).not.toHaveProperty('reason')
    } finally {
      session.agent.destroy()
    }
  })
})
