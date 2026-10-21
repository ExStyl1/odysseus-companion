import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  createAgentHarnessCapabilities,
  scoreAgentHarnessCapabilities,
  validateAgentHarnessBehaviorCorpus,
  type AgentHarnessBehaviorCorpusV1,
} from '../../../../shared/src/agent/pi-harness/agent-harness-capabilities.ts'

const corpus = JSON.parse(
  readFileSync(resolve(import.meta.dir, 'fixtures/behavior-corpus.json'), 'utf8'),
) as AgentHarnessBehaviorCorpusV1

const REQUIRED_HOOKS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PermissionDenied',
  'PostToolUse', 'PostToolUseFailure', 'Notification', 'SubagentStart', 'SubagentStop',
  'TaskCreated', 'TaskCompleted', 'Stop', 'CwdChanged', 'FileChanged', 'WorktreeCreate',
  'WorktreeRemove', 'PreCompact', 'PostCompact', 'McpElicitation', 'McpResult', 'SessionEnd',
] as const

const REQUIRED_ORDERED_CASES = [
  'lifecycle-init', 'lifecycle-turn', 'lifecycle-tool', 'lifecycle-permission',
  'lifecycle-compaction', 'lifecycle-task', 'lifecycle-child', 'lifecycle-process',
  'lifecycle-checkpoint', 'lifecycle-shutdown',
] as const

const POST_PARITY_HARNESS_CASES = [
  'hooks-semantics',
  'extension-runtime',
  'permission-policy',
  'tool-cancellation',
  'background-shell',
  'lifecycle-task',
  'tool-result-progress-envelope',
] as const

describe('extension-first behavior contract', () => {
  test('validates the qualified corpus without inflating remaining gaps', () => {
    expect(() => validateAgentHarnessBehaviorCorpus(corpus)).not.toThrow()
    expect(corpus.hookInventory).toEqual(REQUIRED_HOOKS)
    expect(corpus.cases.filter(value => value.priority === 'P0')).toHaveLength(26)
    expect(corpus.cases.filter(value => value.priority === 'P1').length).toBeGreaterThan(0)
    expect(corpus.cases.filter(value => value.priority === 'P2').length).toBeGreaterThan(0)

    const score = scoreAgentHarnessCapabilities(createAgentHarnessCapabilities(corpus.cases))
    // `expectedScore` is optional on the corpus type, and
    // `validateAgentHarnessBehaviorCorpus` only compares the score when it is
    // PRESENT (agent-harness-capabilities.ts:172) — so if the fixture ever drops
    // it, the validator above goes quiet and this line is the only pin left.
    // Fail on the absence by name rather than asserting against `undefined`.
    const { expectedScore } = corpus
    if (expectedScore === undefined) {
      throw new Error('behavior-corpus.json must declare expectedScore; nothing else pins the score')
    }
    expect(score).toEqual(expectedScore)
    expect(corpus.cases.filter(value => (
      (value.priority === 'P0' || value.priority === 'P1')
      && (value.currentStatus === 'missing' || value.currentStatus === 'blocked')
    ))).toEqual([])
    expect(corpus.cases.filter(value => value.currentStatus === 'partial').map(value => value.id).sort()).toEqual([])
    expect(corpus.cases.filter(value => value.currentStatus === 'accepted-difference').map(value => value.id).sort()).toEqual([
      'provider-nestor-a2a-dialect', 'provider-pi-qwen-dialect',
    ])
    expect(score.implementedPercentage).toBeLessThan(100)
  })

  test('pins ordered lifecycle outcomes and the complete hook inventory', () => {
    const byId = new Map(corpus.cases.map(value => [value.id, value]))
    for (const id of REQUIRED_ORDERED_CASES) {
      expect(byId.get(id)?.observable.sequence, id).toBeArray()
      expect(byId.get(id)?.observable.sequence?.length, id).toBeGreaterThan(1)
    }
    expect(byId.get('hooks-complete-inventory')?.observable.outcomes).toEqual(REQUIRED_HOOKS)
    for (const id of [
      'tool-strict-schema-scheduling', 'tool-result-progress-envelope', 'tool-permission-subject',
    ]) expect(byId.has(id), id).toBeTrue()
    const officialClaudeDocs = 'fixture://runtime-behavior.json#official-claude-docs'
    for (const priority of ['P0', 'P1', 'P2'] as const) {
      expect(corpus.cases.some(value => (
        value.priority === priority && value.sourceAnchors.includes(officialClaudeDocs)
      )), priority).toBeTrue()
    }
  })

  test('keeps post-parity effects grounded in implemented provider-neutral cases', () => {
    const byId = new Map(corpus.cases.map(value => [value.id, value]))
    for (const id of POST_PARITY_HARNESS_CASES) {
      const entry = byId.get(id)
      expect(entry?.currentStatus, id).toBe('implemented')
      expect(entry?.sourceAnchors.length, id).toBeGreaterThan(0)
      expect(entry?.observable.outcomes?.length ?? entry?.observable.sequence?.length, id).toBeGreaterThan(0)
    }
  })

  test('pins Desktop/headless gaps and sanitized Pi/Qwen and Nestor fixtures', () => {
    const caseIds = new Set(corpus.cases.map(value => value.id))
    for (const id of [
      'interaction-approval-question', 'interaction-cancellation', 'interaction-detach-resume',
      'interaction-crash-restart', 'interaction-unavailable-capability',
    ]) expect(caseIds.has(id), id).toBeTrue()

    expect(corpus.providerFixtures.map(value => value.id)).toEqual([
      'pi-qwen-tool-cycle', 'nestor-a2a-tool-cycle',
    ])
    expect(corpus.providerFixtures.map(value => value.dialect)).toEqual(['pi-qwen', 'nestor-a2a'])
    expect(JSON.stringify(corpus.providerFixtures)).not.toMatch(/credential|privateTranscript|requestId|sessionId|toolCallId|timestamp/i)
  })
})
