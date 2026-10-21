/**
 * D1.343 `[product]` `[host]` — a command hook the OPERATOR declared runs
 * without a permission card; one a plugin supplied still asks.
 *
 * `hooks.md#workspace-trust` is the documented gate and it is a WORKSPACE one:
 * *"Claude Code checks workspace trust before it runs any hook from a settings
 * file"*, and past that check the hook simply runs. This fork gated every
 * command hook on a Bash card instead, so the rung D1.333 measured —
 * `cat >> <path>`, one redirect away from an allowed `cat` — asked, and on an
 * unattended profile never ran at all.
 *
 * What is driven here is the REAL `pluginCommandHookRunner`: the real
 * `PermissionManager`, the real `shouldPromptInAutoMode` verdict, the real
 * `createPiPermissionService` and the real spawn. Nothing answers a card, which
 * is what makes "no card was raised" and "the file exists" two readings of the
 * same run rather than one assertion trusted twice.
 *
 * **The sitting's control, inverted.** RS-77 §9's rung F left NO file on disk
 * because the spawn sits below the approval await; the first case asserts the
 * file IS created, and the second asserts the identical command with a plugin
 * attribution still ends with D1.333's sentence and no file. Same bytes, same
 * gate, same budget — only the RECORD of which config declared the hook differs,
 * which is the whole seam.
 *
 * `cat > /dev/null` is deliberately absent, for the reason
 * `SessionManager.hook-approval-deadline.test.ts` states at length: this harness
 * supplies `view.permissionLayers: []`, so that rung's verdict is decided by
 * built-in layers the harness does not load, and pinning it would pin the
 * harness rather than the product.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_MANAGED_PI_POLICY } from '@nessy-agent/shared/agent/pi-harness/managed-policy'

import { createTestSessionManager } from './__tests__/test-session-manager.ts'

type SentEvent = { type: string; message?: string }

function harness(): { manager: any; sent: SentEvent[] } {
  const sent: SentEvent[] = []
  const manager = createTestSessionManager() as any
  manager.appendPiExecutionReceipt = () => undefined
  manager.piGoalReceiptReference = () => undefined
  manager.emitPiTelemetry = () => undefined
  // F1.142 — the disclosure is now a transcript row too; the row lands on
  // `managed.messages` (read below) and the disk write is not this suite's subject.
  manager.persistSession = () => undefined
  // The instrument for "no card was raised": the runner announces a card by
  // sending `permission_request` on this very channel, so recording it is a
  // reading of the production path and not of a flag beside it.
  manager.sendEvent = (event: SentEvent) => { sent.push(event) }
  manager.managedPiPolicyCurrent = DEFAULT_MANAGED_PI_POLICY
  return { manager, sent }
}

function managedSession(root: string) {
  return {
    id: 'session-d1343',
    provider: 'pi',
    permissionMode: 'auto',
    workspace: { id: 'workspaced1343', rootPath: root },
    workingDirectory: root,
    messages: [] as Array<{ role: string; content?: string }>,
  }
}

/** F1.142 — the transcript rows a case reads (`getSessionMessages` returns `managed.messages`). */
function infoRows(managed: { messages: Array<{ role: string; content?: string }> }): string[] {
  return managed.messages.filter(message => message.role === 'info').map(message => message.content ?? '')
}

function capabilityRuntime(projectTrustState: 'trusted' | 'none') {
  return {
    projectTrustState,
    view: { generation: 'gen-d1343', hooks: [], permissionLayers: [] },
    materializer: { assertActive() {}, async readText() { return '' } },
  }
}

const hookOptions = {
  event: 'UserPromptSubmit' as const,
  input: { hook_event_name: 'UserPromptSubmit', prompt: 'hello' },
}

describe('D1.343 — the declaring tier decides whether a command hook needs a card', () => {
  test('a hook from the user\'s own settings RUNS and creates its file, with no card raised', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd1343-user-'))
    const { manager, sent } = harness()
    const runner = manager.pluginCommandHookRunner(managedSession(root), capabilityRuntime('trusted'))
    const capture = join(root, 'capture.jsonl')

    const result = await runner(
      { type: 'command', command: `cat >> ${capture}`, timeoutMs: 20_000 },
      { ...hookOptions, cwd: root, hookSource: 'user' },
    )

    expect(result.success).toBe(true)
    expect(result.error ?? '').not.toContain('needed your approval')
    // The sitting's own control, inverted: rung F left nothing on disk because
    // the spawn sat below an approval await that never settled.
    expect(existsSync(capture)).toBe(true)
    expect(sent.filter(event => event.type === 'permission_request')).toEqual([])
    // The disclosure, once, on the settings-tiers channel — an unasked spawn
    // nobody was told about is indistinguishable from a defect.
    const info = sent.filter(event => event.type === 'info')
    expect(info).toHaveLength(1)
    expect(info[0]?.message ?? '').toContain('without asking')
  }, 60_000)

  test('the IDENTICAL command from a plugin still asks and still ends at the hook budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd1343-plugin-'))
    const { manager, sent } = harness()
    const runner = manager.pluginCommandHookRunner(managedSession(root), capabilityRuntime('trusted'))
    const capture = join(root, 'capture.jsonl')
    const startedAt = Date.now()

    const result = await runner(
      { type: 'command', command: `cat >> ${capture}`, timeoutMs: 300 },
      { ...hookOptions, cwd: root, hookSource: 'plugin' },
    )
    const elapsed = Date.now() - startedAt

    // Same bytes, same gate, same budget as the case above — only the record of
    // which config declared the hook differs. So the pair isolates the
    // attribution and nothing else, the way `cat` against `cat >> <path>`
    // isolated the redirect for D1.333.
    expect(result.success).toBe(false)
    expect(result.error ?? '').toContain('needed your approval')
    expect(existsSync(capture)).toBe(false)
    expect(sent.filter(event => event.type === 'permission_request')).toHaveLength(1)
    // D1.333's bound is intact on the arm that keeps the card: nothing answers,
    // and the runner still ends rather than wedging the turn.
    expect(elapsed).toBeLessThan(30_000)
  }, 60_000)

  test('a project\'s settings run unasked only once that project is TRUSTED', async () => {
    const untrustedRoot = mkdtempSync(join(tmpdir(), 'd1343-project-none-'))
    const untrusted = harness()
    const untrustedCapture = join(untrustedRoot, 'capture.jsonl')
    const refused = await untrusted.manager
      .pluginCommandHookRunner(managedSession(untrustedRoot), capabilityRuntime('none'))(
        { type: 'command', command: `cat >> ${untrustedCapture}`, timeoutMs: 300 },
        { ...hookOptions, cwd: untrustedRoot, hookSource: 'project' },
      )

    expect(refused.success).toBe(false)
    expect(existsSync(untrustedCapture)).toBe(false)
    expect(untrusted.sent.filter(event => event.type === 'permission_request')).toHaveLength(1)

    // The positive control on the same instrument, same tier, same command: the
    // ONLY difference is the trust decision the page makes the gate.
    const trustedRoot = mkdtempSync(join(tmpdir(), 'd1343-project-trusted-'))
    const trusted = harness()
    const trustedCapture = join(trustedRoot, 'capture.jsonl')
    const admitted = await trusted.manager
      .pluginCommandHookRunner(managedSession(trustedRoot), capabilityRuntime('trusted'))(
        { type: 'command', command: `cat >> ${trustedCapture}`, timeoutMs: 20_000 },
        { ...hookOptions, cwd: trustedRoot, hookSource: 'project' },
      )

    expect(admitted.success).toBe(true)
    expect(existsSync(trustedCapture)).toBe(true)
    expect(trusted.sent.filter(event => event.type === 'permission_request')).toEqual([])
  }, 60_000)

  test('an UNATTRIBUTED hook keeps the card — absence fails closed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd1343-absent-'))
    const { manager, sent } = harness()
    const runner = manager.pluginCommandHookRunner(managedSession(root), capabilityRuntime('trusted'))
    const capture = join(root, 'capture.jsonl')

    // No `hookSource` at all, which is what a dispatch site added later that
    // forgets to declare its tier looks like from in here.
    const result = await runner(
      { type: 'command', command: `cat >> ${capture}`, timeoutMs: 300 },
      { ...hookOptions, cwd: root },
    )

    expect(result.success).toBe(false)
    expect(existsSync(capture)).toBe(false)
    expect(sent.filter(event => event.type === 'permission_request')).toHaveLength(1)
  }, 60_000)
})

/**
 * F1.142 (origin SIT-10 P-SIT10-5) — the D1.343 disclosure must reach the
 * TRANSCRIPT, not only the live event stream.
 *
 * SIT-10 read both D1.429 arms — the model-created hook and the operator's own
 * `hooks.json` — off `getSessionMessages` and found ZERO info rows on each, so
 * "absent for the model's hook, present once for the operator's" read
 * identically and the comparison was vacuous. The line was sent as a bare
 * `info` EVENT, which the renderer draws and the host never keeps: gone at a
 * reload, invisible to a case, to `-p` and to an export. What it records is an
 * EVENT — a command a hook ran without anyone being asked — so it is kept the
 * way the host keeps its other unasked records (`recordSessionInfoEntry`),
 * once per session per tier as before.
 *
 * The first arm is the row's own control, inverted into the fix: the operator
 * arm's line IS a transcript row (RED before: zero rows). The second is its
 * pair: the arm that keeps its card writes no such row.
 */
describe('F1.142 — the pre-authorised-tier line is a transcript row, once', () => {
  test('the user-tier hook that ran unasked leaves exactly one info row saying so, however many times it runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f1142-user-'))
    const { manager } = harness()
    const managed = managedSession(root)
    const runner = manager.pluginCommandHookRunner(managed, capabilityRuntime('trusted'))
    for (const run of [1, 2]) {
      const capture = join(root, `capture-${run}.jsonl`)
      const result = await runner(
        { type: 'command', command: `cat >> ${capture}`, timeoutMs: 20_000 },
        { ...hookOptions, cwd: root, hookSource: 'user' },
      )
      expect(result.success).toBe(true)
    }
    const rows = infoRows(managed)
    expect(rows).toHaveLength(1)
    expect(rows[0] ?? '').toContain('without asking')
  }, 60_000)

  test('CONTROL: the plugin hook that keeps its card leaves no such row', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f1142-plugin-'))
    const { manager } = harness()
    const managed = managedSession(root)
    const runner = manager.pluginCommandHookRunner(managed, capabilityRuntime('trusted'))
    const result = await runner(
      { type: 'command', command: `cat >> ${join(root, 'capture.jsonl')}`, timeoutMs: 300 },
      { ...hookOptions, cwd: root, hookSource: 'plugin' },
    )
    expect(result.success).toBe(false)
    expect(infoRows(managed)).toEqual([])
  }, 60_000)
})
