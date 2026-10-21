/**
 * D1.333 `[host]` `[pi]` — the call site: a command hook whose approval nobody
 * answers now ENDS, with a sentence, instead of wedging the turn for ever.
 *
 * The cause, the six-rung ladder it explains and the gate verdicts that match it
 * rung for rung are in `packages/shared/src/automations/hook-approval-deadline.test.ts`
 * and in `raceHookApprovalDeadline`'s own docblock. What is pinned HERE is the
 * one thing those cannot see: that `pluginCommandHookRunner` — the production
 * execution authority, not the `runHookCommand` fallback — actually bounds the
 * wait and reports it.
 *
 * The REAL runner runs: the real `PermissionManager`, the real
 * `shouldPromptInAutoMode` verdict, the real `createPiPermissionService`, the
 * real approval promise. Nothing answers the card, which is the whole case.
 *
 * The POSITIVE CONTROLS come first: three commands the gate ALLOWS must still
 * reach the spawn and succeed, or a runner that denied everything would pass the
 * timeout assertion without bounding anything. The third of them is the sharp
 * one — `cat` is the rung that hung MINUS its redirect.
 *
 * **One rung of the packaged ladder is deliberately NOT asserted here, and the
 * reason is worth more than the assertion would be.** On this harness
 * `cat > /dev/null` is `ask` and times out (measured: 405 ms against a declared
 * 400 ms budget), while on the packaged build it ANSWERED, twice, in 6 s. The
 * harness hands the runner `view.permissionLayers: []` and a materializer that
 * reads nothing, so the built-in permission layers the real app loads are
 * absent, and that rung's verdict is decided by exactly those. Pinning it here
 * would pin the harness rather than the product.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_MANAGED_PI_POLICY } from '@nessy-agent/shared/agent/pi-harness/managed-policy'

import { createTestSessionManager } from './__tests__/test-session-manager.ts'

function harness() {
  const manager = createTestSessionManager() as any
  manager.appendPiExecutionReceipt = () => undefined
  manager.piGoalReceiptReference = () => undefined
  manager.emitPiTelemetry = () => undefined
  manager.sendEvent = () => undefined
  manager.managedPiPolicyCurrent = DEFAULT_MANAGED_PI_POLICY
  return manager
}

function managedSession(root: string) {
  return {
    id: 'session-d1333',
    provider: 'pi',
    permissionMode: 'auto',
    workspace: { id: 'workspaced1333', rootPath: root },
    workingDirectory: root,
  }
}

const capabilityRuntime = {
  projectTrustState: 'trusted',
  view: { generation: 'gen-d1333', hooks: [], permissionLayers: [] },
  materializer: { assertActive() {}, async readText() { return '' } },
}

describe('D1.333 — pluginCommandHookRunner bounds the approval wait', () => {
  test('an unanswered card ends at the hook budget with a sentence, while an allowed hook still runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd1333-sm-'))
    const manager = harness()
    const managed = managedSession(root)
    const runner = manager.pluginCommandHookRunner(managed, capabilityRuntime)
    const options = {
      event: 'UserPromptSubmit' as const,
      input: { hook_event_name: 'UserPromptSubmit', prompt: 'hello' },
      cwd: root,
    }

    // POSITIVE CONTROLS FIRST, three of them, because a runner that refused
    // every hook would satisfy the one assertion that matters below without
    // bounding anything. The third is the sharp one: `cat` is the rung that
    // HUNG minus its redirect — same command, same stdin, same EOF — so the
    // pair isolates the redirect and nothing else.
    for (const command of ['true', 'echo D1333-CONTROL', 'cat']) {
      const allowed = await runner({ type: 'command', command, timeoutMs: 20_000 }, options)
      expect(allowed.error ?? '').not.toContain('needed your approval')
      expect(allowed.success).toBe(true)
    }

    // THE RUNG THAT HUNG. `cat >> <path>` is `ask` on the same gate; nothing
    // answers the card. Before this row the promise below never settled, the
    // turn never ended and the file was never created — the spawn sits BELOW
    // the await, which is why `>>`, an operator that opens its target before
    // the command runs, still left nothing on disk.
    const capture = join(root, 'capture.jsonl')
    const startedAt = Date.now()
    const denied = await runner({ type: 'command', command: `cat >> ${capture}`, timeoutMs: 300 }, options)
    const elapsed = Date.now() - startedAt

    expect(denied.success).toBe(false)
    expect(denied.error ?? '').toContain('needed your approval')
    expect(denied.error ?? '').toContain('did not run')
    // Bounded by the hook's OWN declared budget rather than by a number this
    // fork invented. The ceiling is generous on purpose: a wall-clock assertion
    // on a loaded box is the one that flakes, and what is under test is that it
    // ends at all.
    expect(elapsed).toBeLessThan(30_000)
    expect(existsSync(capture)).toBe(false)
  }, 60_000)
})
