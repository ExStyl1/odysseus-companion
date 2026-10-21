/**
 * UB4.8 — the automation loop guard, driven along the REAL path.
 *
 * Every `PendingPrompt` in this file is produced by the real builders: Arm 1 by a real
 * `PromptHandler` (subscribed to a real `EventBus`) fed from a real `AutomationSystem`
 * parsing a real `automations.json`, and Arm 2 by the real `runMissedRunSweep` catch-up.
 * The prompts are then handed to the REAL `deliverPromptAutomations` of a REAL
 * `SessionManager` (`createTestSessionManager`), whose `executePromptAutomation` is
 * stubbed at the boundary exactly where upstream's own loop-guard test stubs it —
 * the guard, the skipped history row and the execute call's arguments are the
 * behaviour under test, not the agent run.
 *
 * The stated divergence under test: our `buildPendingPromptsForMatchers` sets
 * `event`/`eventPayload` on EVERY prompt (upstream sets them only under a
 * `semanticCondition` and protects only those matchers), so a self-labelling
 * matcher with NO condition is silenced too.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutomationSystem, type PendingPrompt } from '@nessy-agent/shared/automations'
import { AUTOMATIONS_CONFIG_FILE, MAX_AUTOMATION_CHAIN_DEPTH } from '@nessy-agent/shared/automations/constants'
import { writeScheduleState } from '@nessy-agent/shared/automations/schedule-state'
import { WorkspaceEventBus } from '@nessy-agent/shared/automations/event-bus'
import { PromptHandler } from '@nessy-agent/shared/automations/handlers/prompt-handler'
import { createTestSessionManager } from './test-session-manager'
import { createManagedSession, SessionManager } from '../SessionManager.ts'

describe('automation loop guard (UB4.8)', () => {
  let tmpRoot: string
  let sm: SessionManager
  const NOW = Date.parse('2026-08-07T11:23:45.000Z')
  const TODAY_9AM = Date.parse('2026-08-07T09:00:00.000Z')

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-automation-loop-'))
    sm = createTestSessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function workspace() {
    return { id: 'ws-test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() }
  }

  function sessionWith(id: string, triggeredBy?: Record<string, unknown>) {
    const managed = createManagedSession({ id, name: id }, workspace() as never, { messagesLoaded: true })
    if (triggeredBy) managed.triggeredBy = triggeredBy as never
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  const pending = (sessionId: string, matcherId = 'packing', automationName = 'Packing list'): PendingPrompt => ({
    sessionId: undefined,
    matcherId,
    automationName,
    prompt: 'List 5 things to pack',
    mentions: [],
    event: 'LabelAdd',
    eventPayload: { sessionId, label: 'trip' },
  })

  function writeSelfLabellingAutomation(): void {
    // The self-labelling matcher: it puts 'trip' on the sessions it creates and
    // listens for LabelAdd events carrying 'trip' — no semanticCondition.
    writeFileSync(join(tmpRoot, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
      automations: {
        LabelAdd: [{
          id: 'packing',
          matcher: 'trip',
          labels: ['trip'],
          actions: [{ type: 'prompt', prompt: 'Pack for the trip' }],
        }],
      },
    }))
  }

  it('never lets an automation re-trigger itself through the session it created', () => {
    sessionWith('user-session')
    sessionWith('auto-session', { automationName: 'Packing list', automationId: 'packing', depth: 1 })
    sessionWith('legacy-auto-session', { automationName: 'Packing list' })

    expect((sm as any).automationLoopGuard(pending('user-session'))).toEqual({ run: true, depth: 1 })
    expect((sm as any).automationLoopGuard(pending('auto-session')).run).toBe(false)
    // UB12.20 — the skip names its arm, so the timeline can localise the reason.
    expect((sm as any).automationLoopGuard(pending('auto-session')).code).toBe('self-trigger')
    // Sessions created before ids were recorded match by name.
    expect((sm as any).automationLoopGuard(pending('legacy-auto-session')).run).toBe(false)
    // Another automation may react to it, one level deeper.
    expect((sm as any).automationLoopGuard(pending('auto-session', 'triage', 'Bug triage'))).toEqual({ run: true, depth: 2 })
  })

  it('stops chains through other automations at the depth cap', () => {
    sessionWith('deep', { automationName: 'A', automationId: 'a', depth: SessionManager.MAX_AUTOMATION_CHAIN_DEPTH })
    const verdict = (sm as any).automationLoopGuard(pending('deep', 'b', 'B'))
    expect(verdict.run).toBe(false)
    expect(verdict.reason).toContain('chain')
    // UB12.20 — the arm, and the ONE cap: the host's static is the shared constant
    // the timeline interpolates into `automations.skippedLoopChainDepth`.
    expect(verdict.code).toBe('chain-depth')
    expect(SessionManager.MAX_AUTOMATION_CHAIN_DEPTH).toBe(MAX_AUTOMATION_CHAIN_DEPTH)
    expect(verdict.reason).toContain(`deeper than ${MAX_AUTOMATION_CHAIN_DEPTH} sessions`)
  })

  it('UB12.20 — a skipped history row carries its loop-guard arm: chain depth here, self-trigger below', async () => {
    sessionWith('deep', { automationName: 'A', automationId: 'a', depth: SessionManager.MAX_AUTOMATION_CHAIN_DEPTH })
    let created = 0
    ;(sm as any).executePromptAutomation = async () => { created++; return { sessionId: 'x' } }

    await (sm as any).deliverPromptAutomations('ws-test', tmpRoot, [pending('deep', 'b', 'B')])
    // The history write is fire-and-forget; let it land before reading the file.
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(created).toBe(0)
    const entry = JSON.parse(readFileSync(join(tmpRoot, 'automations-history.jsonl'), 'utf-8').trim().split('\n').at(-1)!)
    expect(entry).toMatchObject({ id: 'b', ok: true, skippedLoopGuard: 'chain-depth' })
    // The stored English reason stays beside the code (logs, and readers older than UB12.20).
    expect(entry.skipped).toContain('loop guard')
  })

  // Upstream v0.15.1 `automation-loop-and-retry.test.ts`, the loop-guard describe's third case,
  // on our delivery (`deliverPromptAutomations`; upstream's is `runReadyPrompts`). It could not be
  // copied with the guard: the condition check it counts arrived with UB6.9.
  it('skips a looping run before its condition check and records it as skipped', async () => {
    sessionWith('auto-session', { automationName: 'Packing list', automationId: 'packing', depth: 1 })
    let created = 0
    ;(sm as any).executePromptAutomation = async () => { created++; return { sessionId: 'x' } }
    let conditionChecks = 0
    ;(sm as any).shouldRunPromptAutomation = async () => { conditionChecks++; return { run: true } }

    await (sm as any).deliverPromptAutomations('ws-test', tmpRoot, [{ ...pending('auto-session'), semanticCondition: { question: 'Trip?' } }])
    // The history write is fire-and-forget; let it land before reading the file.
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(created).toBe(0)
    expect(conditionChecks).toBe(0)
    const history = join(tmpRoot, 'automations-history.jsonl')
    expect(existsSync(history)).toBe(true)
    const entry = JSON.parse(readFileSync(history, 'utf-8').trim().split('\n').at(-1)!)
    expect(entry).toMatchObject({ id: 'packing', ok: true })
    expect(entry.skipped).toContain('loop guard')
    expect(entry.skippedLoopGuard).toBe('self-trigger') // UB12.20

    // Control on the same instrument (ours, not upstream's): the same prompt about a session no
    // automation created IS judged, then runs — so the zero above is the guard, not a dead stub.
    sessionWith('user-session')
    await (sm as any).deliverPromptAutomations('ws-test', tmpRoot, [{ ...pending('user-session'), semanticCondition: { question: 'Trip?' } }])
    expect(conditionChecks).toBe(1)
    expect(created).toBe(1)
  })

  it('positive — a matcher on another session\'s event runs, carrying event and payload', async () => {
    sessionWith('user-session')
    let created: Record<string, unknown> | undefined
    ;(sm as any).executePromptAutomation = async (value: Record<string, unknown>) => {
      created = value
      return { sessionId: 'x' }
    }

    await (sm as any).deliverPromptAutomations('ws-test', tmpRoot, [pending('user-session')])

    expect(created).toMatchObject({
      matcherId: 'packing',
      triggerEvent: 'LabelAdd',
      chainDepth: 1,
    })
  })

  it('arm 1 — the real PromptHandler carries event/eventPayload on every prompt, and a self-labelling matcher is skipped exactly once with a skipped history row', async () => {
    writeSelfLabellingAutomation()
    // The automation's own session: created by 'packing', carrying the label it listens to.
    sessionWith('auto-session', { automationName: 'Packing list', automationId: 'packing', depth: 1 })

    const system = new AutomationSystem({ workspaceRootPath: tmpRoot, workspaceId: 'ws-test' })
    let delivered: PendingPrompt[] = []
    const handler = new PromptHandler({ onPromptsReady: (prompts) => { delivered = prompts } }, system)
    const bus = new WorkspaceEventBus('ws-test')
    handler.subscribe(bus)

    // The synthetic payload carries `sessionId` (what the loop guard reads) beside the
    // label; `LabelEventPayload`'s own type does not spell it, so the cast is local.
    const labelAddPayload = { workspaceId: 'ws-test', sessionId: 'auto-session', label: 'trip' } as never
    await bus.emit('LabelAdd', labelAddPayload)
    // The real builder set the fields on EVERY prompt (the divergence from upstream).
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.matcherId).toBe('packing')
    expect(delivered[0]!.event).toBe('LabelAdd')
    expect(delivered[0]!.eventPayload).toMatchObject({ sessionId: 'auto-session', label: 'trip' })

    let created = 0
    ;(sm as any).executePromptAutomation = async () => { created++; return { sessionId: 'x' } }

    // The real delivery: the guard silences the self-trigger.
    await (sm as any).deliverPromptAutomations('ws-test', tmpRoot, delivered)
    expect(created).toBe(0)
    expect((sm as any).sessions.has('auto-session')).toBe(true)
    // The history write is fire-and-forget; let it land before reading the file.
    await new Promise(resolve => setTimeout(resolve, 50))

    const history = join(tmpRoot, 'automations-history.jsonl')
    expect(existsSync(history)).toBe(true)
    const entry = JSON.parse(readFileSync(history, 'utf-8').trim().split('\n').at(-1)!)
    expect(entry).toMatchObject({ id: 'packing', ok: true })
    expect(entry.skipped).toContain('loop guard')

    await system.dispose()
  })

  it('arm 2 — a catch-up run from the real missed-run sweep carries its SchedulerTick event and is not skipped as a loop', async () => {
    writeFileSync(join(tmpRoot, AUTOMATIONS_CONFIG_FILE), JSON.stringify({
      automations: {
        SchedulerTick: [{
          id: 'abc123',
          cron: '0 9 * * *',
          timezone: 'UTC',
          actions: [{ type: 'prompt', prompt: 'daily review' }],
        }],
      },
    }))
    writeScheduleState(tmpRoot, { abc123: TODAY_9AM - 6 * 24 * 60 * 60 * 1000 })

    const prompts: PendingPrompt[][] = []
    const system = new AutomationSystem({
      workspaceRootPath: tmpRoot,
      workspaceId: 'ws-test',
      onPromptsReady: batch => { prompts.push(batch) },
    })

    expect(await system.runMissedRunSweep(NOW)).toEqual({ fired: 1 })
    expect(prompts).toHaveLength(1)
    // The real builder set the fields on the sweep's prompts too (both producers).
    expect(prompts[0]![0]!.event).toBe('SchedulerTick')
    expect(prompts[0]![0]!.eventPayload).toMatchObject({ timestamp: TODAY_9AM })
    // No `sessionId` in the payload → no origin → the guard runs it at depth 1.
    let created: Record<string, unknown> | undefined
    ;(sm as any).executePromptAutomation = async (value: Record<string, unknown>) => {
      created = value
      return { sessionId: 'x' }
    }

    await (sm as any).deliverPromptAutomations('ws-test', tmpRoot, prompts[0]!)
    expect(created).toMatchObject({ matcherId: 'abc123', triggerEvent: 'SchedulerTick', chainDepth: 1 })

    await system.dispose()
  })
})
