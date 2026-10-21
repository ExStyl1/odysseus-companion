/**
 * F1.1219 (I2.7) — the two rendering hints the Claude Agent SDK hands
 * `canUseTool` since 0.3.268 reach the card.
 *
 * `agent-sdk/typescript.md#canusetool`, verbatim:
 *  - `defaultToNo`: *"When `true`, a single stray keystroke must not approve this
 *    request: open your prompt on its decline option, don't pre-select approve,
 *    and offer no one-key approve shortcut."*
 *  - `suppressAlwaysAllowRule`: *"When `true`, don't offer a persistent
 *    always-allow choice for this request, because the rule it would write
 *    grants more than the request's own action."*
 *
 * Both halves are driven: the projection (`claudeToolApprovalRequest`) and the
 * field-by-field hand-off to `onPermissionRequest` in `askToolApproval`, which
 * is the line that actually ships a field (C3.370 learnt that the hard way).
 * Each hint has its no-flag control, which is today's card.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ClaudeAgent, claudeToolApprovalRequest } from '../claude-agent.ts'
import type { BackendConfig } from '../backend/types.ts'
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'

/** A session-scoped `addRules` the boundary forwards, so the button WOULD be offered. */
const FORWARDABLE_SUGGESTION = [{
  type: 'addRules',
  rules: [{ toolName: 'Bash', ruleContent: 'git push:*' }],
  behavior: 'allow',
  destination: 'session',
}]

function callOptions(overrides: Partial<Parameters<CanUseTool>[2]> = {}): Parameters<CanUseTool>[2] {
  return {
    signal: new AbortController().signal,
    toolUseID: 'toolu_f1219',
    requestId: 'req_f1219',
    suggestions: FORWARDABLE_SUGGESTION as never,
    ...overrides,
  }
}

describe('F1.1219 — the projection reads both hints', () => {
  it('suppressAlwaysAllowRule withholds the always-allow a forwardable suggestion would offer', () => {
    const suppressed = claudeToolApprovalRequest('Bash', { command: 'git push' },
      callOptions({ suppressAlwaysAllowRule: true }))
    expect(suppressed.canRememberForSession).toBeUndefined()

    // CONTROL on the identical call: without the hint the same suggestion offers
    // the button, so the absence above is the hint's and not the suggestion's.
    const control = claudeToolApprovalRequest('Bash', { command: 'git push' }, callOptions())
    expect(control.canRememberForSession).toBe(true)
    // `false` is the SDK saying nothing, not a reason to withhold.
    expect(claudeToolApprovalRequest('Bash', { command: 'git push' },
      callOptions({ suppressAlwaysAllowRule: false })).canRememberForSession).toBe(true)
  })

  it('defaultToNo rides the request, and is absent when the SDK did not set it', () => {
    const asked = claudeToolApprovalRequest('Bash', { command: 'git push' }, callOptions({ defaultToNo: true }))
    expect(asked.defaultToNo).toBe(true)
    // It constrains the rendering only; the remember predicate is untouched.
    expect(asked.canRememberForSession).toBe(true)

    expect(claudeToolApprovalRequest('Bash', { command: 'git push' }, callOptions()))
      .not.toHaveProperty('defaultToNo')
    expect(claudeToolApprovalRequest('Bash', { command: 'git push' }, callOptions({ defaultToNo: false })))
      .not.toHaveProperty('defaultToNo')
  })
})

describe('F1.1219 — through the real agent, onto the card the renderer gets', () => {
  const agents: ClaudeAgent[] = []
  afterEach(() => { for (const agent of agents.splice(0)) agent.destroy() })

  function raise(overrides: Partial<Parameters<CanUseTool>[2]>): Record<string, unknown> | undefined {
    const root = mkdtempSync(join(tmpdir(), 'f1219-ws-'))
    const agent = new ClaudeAgent({
      provider: 'anthropic',
      providerType: 'anthropic',
      model: 'claude-sonnet-4-6',
      isHeadless: true,
      skipConfigWatcher: true,
      workspace: {
        id: 'ws-f1219', name: 'F1219', rootPath: root,
        workspaceRootPath: root, sessionRootPath: join(root, 'sessions'),
      } as never,
      session: { id: 'sess-f1219', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: root } as never,
    } as BackendConfig)
    agents.push(agent)
    const internals = agent as unknown as {
      onPermissionRequest: ((request: Record<string, unknown>) => void) | null
      askToolApproval: (request: unknown, signal?: AbortSignal) => Promise<unknown>
      respondToPermission: (requestId: string, allowed: boolean, alwaysAllow?: boolean) => void
    }
    let card: Record<string, unknown> | undefined
    internals.onPermissionRequest = request => { card = request }
    const request = claudeToolApprovalRequest('Bash', { command: 'git push' }, callOptions(overrides))
    void internals.askToolApproval(request)
    internals.respondToPermission(request.requestId, false)
    return card
  }

  it('both hints set: the card opens on Deny and offers no Always Allow', () => {
    const card = raise({ defaultToNo: true, suppressAlwaysAllowRule: true })
    expect(card?.defaultToNo).toBe(true)
    expect(card?.noAlwaysAllow).toBe(true)
    expect(card?.origin).toBe('claude_native')
  })

  it('no hints: today\'s card — Always Allow offered, no defaultToNo field', () => {
    const card = raise({})
    expect(card).toBeDefined()
    expect(card).not.toHaveProperty('defaultToNo')
    expect(card?.noAlwaysAllow).toBe(false)
  })
})
