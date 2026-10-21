/**
 * C3.301 — the host half: which of the two documented sinks each background-hook
 * note reaches, and that the emitter is supplied on every runtime.
 *
 * ## What only the source can see
 *
 * The executor half is behavioural and pinned where it lives
 * (`packages/shared/src/plugins/__tests__/async-hook-delivery.test.ts`: the
 * flag through the action builder, both deliveries, the exit-2 exception and
 * its four negatives). Two facts are invisible from there and are the reason
 * C3.283 priced this row at M:
 *
 * 1. whether the emitter is supplied AT ALL — an option nobody passes is the
 *    `advertised` shape, and P6.117 measured four action runners shipping inert
 *    for exactly that reason;
 * 2. whether a `delivery` note WAKES an idle session. `hooks.md#limitations` is
 *    explicit that it must not — *"Hook output is delivered on the next
 *    conversation turn. If the session is idle, the response waits until the
 *    next user interaction. Exception: an `asyncRewake` hook that exits with
 *    code 2 wakes Claude immediately even when the session is idle."* — and the
 *    difference between the two arms is one call to
 *    `flushPendingTaskNotifications`.
 *
 * A behavioural test of (2) would need a live session, an agent and a real turn
 * to observe an absence of a turn. The source says it in one read, with the
 * `rewake` arm as its own positive control.
 */
import { describe, expect, test } from 'bun:test'
import { bracedRegion } from '@nessy-agent/shared/testing/source-regions'

const SESSION_MANAGER = new URL('../SessionManager.ts', import.meta.url).pathname

async function manager(): Promise<string> {
  return await Bun.file(SESSION_MANAGER).text()
}

describe('C3.301 — the emitter is wired, for every runtime', () => {
  test('the one construction site supplies it unconditionally', async () => {
    const src = await manager()
    expect(src).toContain('pluginAsyncHookNoteEmitter: note => { this.deliverAsyncHookNote(managed, note) }')
    // Unconditional: no provider ternary, no `runners.has(...)` gate. The line
    // sits inside `buildAgentAutomationSystem`, whose four action runners ARE
    // gated — that contrast is the POSITIVE CONTROL that this read found the
    // real builder and not some other options literal.
    const call = src.indexOf('pluginAsyncHookNoteEmitter:')
    const builder = src.indexOf('private async buildAgentAutomationSystem(')
    expect(builder).toBeGreaterThan(0)
    expect(call).toBeGreaterThan(builder)
    expect(src).toContain("...(runners.has('agent')")
    // The emitter's own line carries no condition.
    const line = src.slice(src.lastIndexOf('\n', call) + 1, src.indexOf('\n', call))
    expect(line).not.toContain('?')
    expect(line.trimStart().startsWith('pluginAsyncHookNoteEmitter:')).toBe(true)
  })
})

describe('C3.301 — the two sinks, and only the exception wakes', () => {
  test('a `rewake` note goes through the host wake; a `delivery` note does not', async () => {
    const src = await manager()
    const start = src.indexOf('private deliverAsyncHookNote(managed: ManagedSession, note: PluginAsyncHookNote): void')
    expect(start).toBeGreaterThan(0)
    // D1.111 — the method's own braces, not 1 600 characters of it.
    const body = bracedRegion(src, start)
    // BOUNDARY CONTROL, and this case already had it: `flushPendingTaskNotifications`
    // is DECLARED about a thousand lines below this method, so the
    // `not.toContain` further down fails on a brace scan that ran away — which
    // is the failure mode the matcher has to be watched for.
    // The exception: `deliverMonitorEvent` IS the wake — it starts a turn for an
    // idle session. Nothing new was built for it, which was C3.283's third
    // finding.
    expect(body).toContain("if (note.kind === 'rewake') {")
    expect(body).toContain('void this.deliverMonitorEvent({')
    // The rule: the same queue, WITHOUT the flush. This absence is the page's
    // sentence, and it is the single line the whole `kind` field exists for.
    expect(body).toContain('managed.pendingTaskNotifications = pending')
    expect(body).not.toContain('flushPendingTaskNotifications')
    // POSITIVE CONTROL on the same file: the sink that DOES flush still does,
    // so the absence above is this method's choice and not a repo-wide rename.
    expect(src).toContain('await this.flushPendingTaskNotifications(managed)')
  })

  test('an empty note is dropped and the hook is named in the log', async () => {
    const src = await manager()
    const start = src.indexOf('private deliverAsyncHookNote(managed: ManagedSession, note: PluginAsyncHookNote): void')
    expect(start).toBeGreaterThan(0)
    const body = bracedRegion(src, start)
    // BOUNDARY CONTROL: this case is all positives, so without it a runaway
    // region would satisfy every line below for anything in the file.
    expect(body).not.toContain('private async flushPendingTaskNotifications(')
    expect(body).toContain('if (!note.text) return')
    // Machine-readable first, as every other out-of-band producer in this file
    // does it, and the hook and event are named so two hooks' notes are
    // distinguishable in a log.
    expect(body).toContain('sessionLog.info(')
    expect(body).toContain('note.kind')
    expect(body).toContain('note.hookName')
    // The taskId names the hook, so two hooks never collapse into one entry.
    expect(body).toContain('taskId: `async-hook:${note.event}:${note.hookName}`')
  })
})
