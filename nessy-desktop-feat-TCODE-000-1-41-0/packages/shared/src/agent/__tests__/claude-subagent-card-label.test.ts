/**
 * C3.370 — a background subagent's permission card names the subagent.
 *
 * ## What was measured, and why it is two files rather than one
 *
 * R6b drove RS-14 on the packaged 1.37.0 (C5.11): a background subagent's
 * `Write` raised a card in the PARENT's pane — so the routing was right — whose
 * text was shape-identical to a main-thread control's, and the `Agent` tool
 * result's own agent id appeared nowhere on it.
 *
 * The cause was two fields for one fact. `claudeToolApprovalRequest` spelled the
 * subagent into `reason`, which **no permission card renders**; the card renders
 * `agentLabel`, whose only producer was `SessionManager.permissionSurfaceRouting`
 * — gated on `managed.piParentSessionKey`, i.e. Pi-only. A claude subagent runs
 * inside the claude child and has no `ManagedSession`, so the field the card
 * reads was never set on this runtime.
 *
 * ## Why this file drives the REAL projection and does not stop at the mapper
 *
 * `ClaudeAgent.askToolApproval` builds the emitted `PermissionRequest`
 * FIELD BY FIELD, not by spreading the approval request. A test that asserted
 * `claudeToolApprovalRequest(...).agentLabel` alone would have gone green against
 * a build where the value is dropped one call later and the card is still
 * anonymous — the planted-collaborator shape AGENTS.md §Traps records. The
 * mapper half is pinned in `claude-can-use-tool-approval.test.ts`; this file
 * pins the half that ships, through the real agent and its real
 * `onPermissionRequest`.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ClaudeAgent } from '../claude-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

describe('C3.370 — the subagent label reaches the emitted card', () => {
  const agents: ClaudeAgent[] = []
  afterEach(() => { for (const agent of agents.splice(0)) agent.destroy() })

  interface Internals {
    onPermissionRequest: ((request: Record<string, unknown>) => void) | null
    askToolApproval: (request: unknown, signal?: AbortSignal) => Promise<unknown>
    respondToPermission: (requestId: string, allowed: boolean, alwaysAllow?: boolean) => void
  }

  function drive(agentLabel?: string): Record<string, unknown> | undefined {
    const root = mkdtempSync(join(tmpdir(), 'c3370-ws-'))
    const agent = new ClaudeAgent({
      provider: 'anthropic',
      providerType: 'anthropic',
      model: 'claude-sonnet-4-6',
      isHeadless: true,
      skipConfigWatcher: true,
      workspace: {
        id: 'ws-c3370', name: 'C3370', rootPath: root,
        workspaceRootPath: root, sessionRootPath: join(root, 'sessions'),
      } as never,
      session: { id: 'sess-c3370', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: root } as never,
    } as BackendConfig)
    agents.push(agent)
    const internals = agent as unknown as Internals
    let card: Record<string, unknown> | undefined
    internals.onPermissionRequest = request => { card = request }
    void internals.askToolApproval({
      requestId: 'perm-c3370',
      toolName: 'Write',
      command: join(root, 'child.txt'),
      description: 'Write a file',
      ...(agentLabel ? { agentLabel } : {}),
    })
    // Settle it so the promise is not left pending for the whole run.
    internals.respondToPermission('perm-c3370', false)
    return card
  }

  it('carries the label the runtime supplied', () => {
    expect(drive('code-reviewer')?.agentLabel).toBe('code-reviewer')
  })

  /**
   * The negative arm, and the whole reason the chip means anything: a
   * main-thread call must carry NO label. Without this, a projection that hard-
   * coded a value would satisfy the case above while every card grew a
   * permanent "from agent" row.
   */
  it('leaves it off a main-thread call', () => {
    const card = drive()
    expect(card).toBeDefined()
    expect(card).not.toHaveProperty('agentLabel')
  })
})
