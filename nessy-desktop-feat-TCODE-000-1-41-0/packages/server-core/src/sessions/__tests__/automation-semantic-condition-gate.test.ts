/**
 * UB6.9 — the semantic-condition gate in `deliverPromptAutomations`, driven along
 * the REAL delivery path (the same harness shape as automation-loop-guard.test.ts:
 * a real `SessionManager` whose `executePromptAutomation` is stubbed at the
 * boundary where upstream's own tests stub it).
 *
 * Arms:
 *  - skip with probability — a "no" below the threshold writes a skipped history
 *    row carrying the "yes" probability, creates no session, and the enrichment
 *    pass writes no second row for the same prompt;
 *  - one judgement per matcher — a matcher's prompt actions share one
 *    `shouldRunPromptAutomation` call (upstream's `conditionChecks` memo);
 *  - layer off → the run happens — through the real `shouldRunPromptAutomation`
 *    with the decision layer unconfigured, `checkAutomationCondition` answers
 *    null and the prompt runs as it always did (upstream: null = run).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PendingPrompt } from '@nessy-agent/shared/automations'
import { createTestSessionManager } from './test-session-manager'
import { SessionManager } from '../SessionManager.ts'

describe('automation semantic-condition gate (UB6.9)', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-automation-semcond-'))
    sm = createTestSessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function pending(overrides: Partial<PendingPrompt> = {}): PendingPrompt {
    return {
      sessionId: undefined,
      matcherId: 'triage',
      automationName: 'Bug triage',
      prompt: 'Triage the report',
      mentions: [],
      event: 'LabelAdd',
      eventPayload: { sessionId: 'user-session', label: 'bug' },
      semanticCondition: { question: 'Is it a crash report?', threshold: 0.9 },
      ...overrides,
    }
  }

  function historyRows(): Array<Record<string, unknown>> {
    const history = join(tmpRoot, 'automations-history.jsonl')
    if (!existsSync(history)) return []
    return readFileSync(history, 'utf-8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  }

  it('a "no" below the threshold skips with its probability — one skipped row, no session, no second row', async () => {
    ;(sm as any).shouldRunPromptAutomation = async () => ({ run: false, reason: 'condition not met ("yes" probability 0.42)', probability: 0.42 })
    let created = 0
    ;(sm as any).executePromptAutomation = async () => { created++; return { sessionId: 'x' } }

    await (sm as any).deliverPromptAutomations('ws-test', tmpRoot, [pending()])

    expect(created).toBe(0)
    // The history write is fire-and-forget; let it land before reading the file.
    await new Promise(resolve => setTimeout(resolve, 50))
    const rows = historyRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'triage', ok: true, skippedProbability: 0.42 })
    expect(String(rows[0]!.skipped)).toContain('condition not met')
    // UB12.20 — a condition skip is not a loop-guard skip: no arm code on its row.
    expect(rows[0]!.skippedLoopGuard).toBeUndefined()
    expect(rows[0]!.sessionId).toBeUndefined()
    expect(rows[0]!.error).toBeUndefined()
  })

  it('a matcher is judged once per batch: its prompt actions all skip on that one judgement', async () => {
    let judgements = 0
    ;(sm as any).shouldRunPromptAutomation = async () => { judgements++; return { run: false, reason: 'condition not met ("yes" probability 0.10)', probability: 0.10 } }
    ;(sm as any).executePromptAutomation = async () => ({ sessionId: 'x' })

    // Two prompt actions of the SAME matcher (same matcherId) in one batch.
    await (sm as any).deliverPromptAutomations('ws-test', tmpRoot, [pending(), pending({ prompt: 'Triage it harder' })])

    expect(judgements).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 50))
    const rows = historyRows()
    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.ok === true && row.skippedProbability === 0.1)).toBe(true)
  })

  it('layer off → the real check answers null and the prompt runs as without the condition', async () => {
    // No decision provider configured in the test environment: the real
    // `shouldRunPromptAutomation` (NOT overridden) must run the prompt.
    let created: Record<string, unknown> | undefined
    ;(sm as any).executePromptAutomation = async (value: Record<string, unknown>) => { created = value; return { sessionId: 'x' } }

    await (sm as any).deliverPromptAutomations('ws-test', tmpRoot, [pending()])

    expect(created).toMatchObject({ matcherId: 'triage', triggerEvent: 'LabelAdd', chainDepth: 1 })
    await new Promise(resolve => setTimeout(resolve, 50))
    const rows = historyRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'triage', ok: true, sessionId: 'x' })
    expect(rows[0]!.skipped).toBeUndefined()
    expect(rows[0]!.skippedProbability).toBeUndefined()
  })

  it('a prompt without a semanticCondition never waits on a condition judgement', async () => {
    let judgements = 0
    const realShouldRun = (sm as any).shouldRunPromptAutomation.bind(sm)
    ;(sm as any).shouldRunPromptAutomation = async (value: PendingPrompt) => {
      judgements++
      return realShouldRun(value)
    }
    let created = 0
    ;(sm as any).executePromptAutomation = async () => { created++; return { sessionId: 'x' } }

    await (sm as any).deliverPromptAutomations('ws-test', tmpRoot, [pending({ semanticCondition: undefined })])

    expect(judgements).toBe(1) // asked once, answered { run: true } without a model call
    expect(created).toBe(1)
  })
})
