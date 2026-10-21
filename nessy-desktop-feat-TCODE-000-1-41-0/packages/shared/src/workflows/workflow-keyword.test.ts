/**
 * The workflow keyword trigger and its origin gate.
 *
 * `workflows.md` §Where the keyword works is a security boundary, not a UX
 * note: the keyword "is an opt-in only in a prompt you type yourself" and must
 * NOT start a workflow from a headless prompt, an unstamped SDK send, a
 * scheduled task, or a webhook / PR comment relayed into the conversation.
 * Claude records the permissive behaviour as a fixed bug (before v2.1.210), so
 * a fail-open default here would reproduce a known vulnerability.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { AGENT_PROVIDERS } from '../agent/backend/runtime-vocabulary.ts'
import {
  WORKFLOW_KEYWORD_DISPATCH_RUNTIMES,
  WORKFLOW_TRIGGER_KEYWORD,
  detectWorkflowKeywordTrigger,
} from './workflow-keyword.ts'

const human = { origin: 'human' as const, keywordTriggerEnabled: true, provider: 'pi' as const }

describe('workflow keyword trigger', () => {
  it('fires on a human-typed prompt containing the keyword', () => {
    expect(WORKFLOW_TRIGGER_KEYWORD).toBe('ultracode')
    expect(detectWorkflowKeywordTrigger('ultracode: audit every route handler', human)).toBe(true)
    expect(detectWorkflowKeywordTrigger('Please ULTRACODE this migration', human)).toBe(true)
  })

  it('does not fire without the standalone keyword', () => {
    expect(detectWorkflowKeywordTrigger('audit every route handler', human)).toBe(false)
    expect(detectWorkflowKeywordTrigger('ultracodex is a different thing', human)).toBe(false)
    expect(detectWorkflowKeywordTrigger('', human)).toBe(false)
  })

  it('fails closed for every non-human origin', () => {
    for (const origin of ['relayed', 'automation', 'headless'] as const) {
      expect(detectWorkflowKeywordTrigger('ultracode: audit routes', {
        origin,
        keywordTriggerEnabled: true,
        provider: 'pi',
      })).toBe(false)
    }
  })

  it('does not fire when the keyword toggle is off', () => {
    expect(detectWorkflowKeywordTrigger('ultracode: audit routes', {
      origin: 'human',
      keywordTriggerEnabled: false,
      provider: 'pi',
    })).toBe(false)
  })

  /**
   * P2.315 / F46.1. The keyword used to fire on every runtime, so a
   * claude-runtime session got a directive telling the model to "run it with
   * the workflow tool" — a tool it does not have. Same defect as P2.212 one
   * route up.
   */
  it('fails closed on a runtime that cannot dispatch a workflow', () => {
    for (const provider of ['anthropic', 'codex-runtime', 'nestor-cloud-agent'] as const) {
      expect(
        detectWorkflowKeywordTrigger('ultracode: audit routes', { ...human, provider }),
        `${provider} still opts into workflow orchestration`,
      ).toBe(false)
    }
    // Positive control on the same call: the only difference between these two
    // is the provider, so a detector that had stopped matching the keyword
    // altogether would fail here rather than read as a fix.
    expect(detectWorkflowKeywordTrigger('ultracode: audit routes', { ...human, provider: 'pi' })).toBe(true)
  })

  /**
   * The record is total over the vocabulary (compiler-enforced) AND its `true`
   * set must be the set of backends that CONSUME the invocation. Both halves
   * matter: totality stops a new runtime inheriting a default, and the
   * consumption tie stops the record claiming a dispatch nobody implements —
   * the property `runtime-capability-drift.test.ts` already holds for the
   * slash-command arm of the same feature.
   */
  it('claims dispatch for exactly the backends that consume a workflow invocation', () => {
    const backendSource = (file: string): string =>
      readFileSync(fileURLToPath(new URL(`../agent/${file}`, import.meta.url)), 'utf8')
    const sourceByProvider: Record<string, string> = {
      pi: 'pi-agent.ts',
      anthropic: 'claude-agent.ts',
      'codex-runtime': 'codex-agent.ts',
      'nestor-cloud-agent': 'nestor-cloud-agent.ts',
    }
    // `.workflowInvocation`, not `workflowInvocation`: in `pi-agent.ts` the bare
    // identifier also appears inside the string literal
    // `ChatOptions['workflowInvocation']`, and a type index is not a dispatch
    // (P2.122's recorded miscount).
    const consumes = AGENT_PROVIDERS
      .filter(provider => backendSource(sourceByProvider[provider]!).includes('.workflowInvocation'))
      .sort()
    const claims = AGENT_PROVIDERS
      .filter(provider => WORKFLOW_KEYWORD_DISPATCH_RUNTIMES[provider])
      .sort()
    expect(claims).toEqual(consumes)
    // Positive controls: a needle that stopped matching anything, or a record
    // emptied by a bad edit, must not read as agreement-by-vacuum — and the set
    // has to keep a negative side to fail on.
    expect(consumes.length).toBeGreaterThan(0)
    expect(consumes.length).toBeLessThan(AGENT_PROVIDERS.length)
    // Totality, checked at test time too: the compiler's `Record` catches a
    // missing key, this catches a record widened to `Partial` or to `string`.
    expect(Object.keys(WORKFLOW_KEYWORD_DISPATCH_RUNTIMES).sort()).toEqual([...AGENT_PROVIDERS].sort())
  })
})
