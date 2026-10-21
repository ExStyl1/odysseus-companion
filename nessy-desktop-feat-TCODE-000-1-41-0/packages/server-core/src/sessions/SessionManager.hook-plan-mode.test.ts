/**
 * F1.758 `[host]` — in PLAN mode, the user's own `UserPromptSubmit` command hook
 * must RUN, not be refused by the model's plan-mode shell block.
 *
 * ## The measured defect (release sitting SIT-g, packaged `5896a66d2`)
 *
 * A claude-gateway session in plan mode with a user-tier `hooks.json`
 * `UserPromptSubmit` hook printing only `{"hookSpecificOutput":{…,"sessionTitle":…}}`
 * dropped EVERY prompt with "Operation stopped by hook" (the child logged
 * `Hook UserPromptSubmit (callback) requested preventContinuation`), and the
 * session was not renamed. The same hook in bypass and `acceptEdits` sessions let
 * the prompt through; emptying `hooks.json` let the next plan prompt through.
 *
 * ## The cause, read before building
 *
 * The prompt was never stopped BY the hook — the hook never ran. Every command
 * hook reaches `pluginCommandHookRunner`, whose gate asks `shouldAllowToolInMode`
 * about the hook's command line in the SESSION's mode. In plan mode a command
 * outside the built-in read-only set is refused outright (`allowed: false`) unless
 * the caller opts into plan mode's shell band, and a refusal is an outright DENY
 * that D1.343's "the operator declared it, so it runs without a card" upgrade
 * never touches (only an `ask` is upgraded). The runner answered
 * `success: false`, a native automation's failed run is a block
 * (`getHookCommandPreToolDecision`, `blockOnNonZero` unset), and a block on
 * `UserPromptSubmit` ends the turn (`hookBlockEndsTurn`) — so the SDK callback
 * returned `continue: false` and the child dropped the prompt. In `acceptEdits`
 * the same command is an `ask` (`shouldPromptInAskMode`), which D1.343 upgrades
 * to a run; in bypass it is allowed outright. That is the whole A/B.
 *
 * Measured by this file's first run at `629087737`, before the fix: the
 * sessionTitle hook, the genuinely blocking hook AND a plain `true` were all
 * refused in plan mode ("… is not in the read-only allowlist … Call SubmitPlan
 * …"), so ANY user command hook on `UserPromptSubmit` dropped every plan prompt,
 * and a plugin's hook was refused without a card; the bypass/`acceptEdits`
 * controls and the floor boundary passed. The fix is `commandHookGateMode`
 * (`plugins/hooks-automation.ts`, where the decision and its reason live).
 *
 * Driven here is the REAL runner — the real `PermissionManager`, the real mode
 * gate, the real spawn — with nothing answering a card, so "no card was raised"
 * and "the hook's stdout came back" are two readings of the same run.
 *
 * ## F1.771 — the same cause, two modes over: `explore` (read as `plan` since F1.1050) and `dontAsk`
 *
 * `explore` and `dontAsk` refuse a command outside the read-only set exactly as
 * plan mode did, and `commandHookGateMode` mapped only `plan`. The second
 * describe block below adds their arms — the sessionTitle hook, a plain `true`,
 * a genuine block, a user `PreToolUse` hook, a floor, and a PLUGIN hook — and
 * measured them red before the fix. `dontAsk` cannot take `default`'s card, so
 * there the ask a third party's hook still raises is turned into a refusal
 * (`commandHookUnpromptedDecision`, beside `commandHookGateMode`).
 *
 * ## F1.772 — what claude is handed when the host still refuses a native hook
 *
 * The row: a host refusal reached the user only as claude's bare "Operation
 * stopped by hook". The last describe block drives the REAL runner through the
 * REAL claude SDK callback (`PluginScopedAutomationSystem.buildSdkHooks`, the
 * workspace `hooks.json` tier, `blockOnNonZero` unset — the native contract) in
 * `dontAsk`, where that tier is still refused (F1.785). On `UserPromptSubmit`
 * the answer is no stop at all and a `systemMessage` naming the refusal and the
 * mode (F1.863, `9fa33e612`), and on `PostToolBatch` too since F1.1037; where a
 * refused native hook still fails closed (`PreToolUse`), the deny's reason names
 * both, the field the runtime's consumer shows (F1.864, `fae8fa260`).
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_MANAGED_PI_POLICY } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import {
  getHookCommandPreToolDecision,
  hookBlockEndsTurn,
  isBlockingHookDecision,
  projectHookDecisionForEvent,
} from '@nessy-agent/shared/automations'
import { PluginScopedAutomationSystem } from '@nessy-agent/shared/plugins/hooks-automation'

import { createTestSessionManager } from './__tests__/test-session-manager.ts'

type SentEvent = { type: string; message?: string }

function harness(): { manager: any; sent: SentEvent[] } {
  const sent: SentEvent[] = []
  const manager = createTestSessionManager() as any
  manager.appendPiExecutionReceipt = () => undefined
  manager.piGoalReceiptReference = () => undefined
  manager.emitPiTelemetry = () => undefined
  manager.persistSession = () => undefined
  // The instrument for "no card was raised": the runner announces a card by
  // sending `permission_request` on this very channel.
  manager.sendEvent = (event: SentEvent) => { sent.push(event) }
  manager.managedPiPolicyCurrent = DEFAULT_MANAGED_PI_POLICY
  return { manager, sent }
}

function managedSession(root: string, permissionMode: string) {
  return {
    id: 'session-f1758',
    provider: 'anthropic',
    permissionMode,
    workspace: { id: 'workspacef1758', rootPath: root },
    workingDirectory: root,
    messages: [] as Array<{ role: string; content?: string }>,
  }
}

function capabilityRuntime() {
  return {
    projectTrustState: 'none' as const,
    view: { generation: 'gen-f1758', hooks: [], permissionLayers: [] },
    materializer: { assertActive() {}, async readText() { return '' } },
  }
}

const hookOptions = {
  event: 'UserPromptSubmit' as const,
  input: { hook_event_name: 'UserPromptSubmit', prompt: 'plan something' },
}

/** The sitting's hook, byte for byte (SIT-g FAILS 1, step 1). */
const TITLE_HOOK = `printf '%s' '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","sessionTitle":"cdp-title"}}'`
/** A hook that genuinely blocks, in the documented top-level form. */
const BLOCK_HOOK = `printf '%s' '{"decision":"block","reason":"f1758-genuine-block"}'`

/** F1.771 — a user `PreToolUse` hook: the model is about to read a file. */
const preToolHookOptions = {
  event: 'PreToolUse' as const,
  input: { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'README.md' } },
}

async function runHook(
  permissionMode: string,
  command: string,
  hookSource: 'user' | 'plugin',
  timeoutMs = 20_000,
  on: 'UserPromptSubmit' | 'PreToolUse' = 'UserPromptSubmit',
) {
  const root = mkdtempSync(join(tmpdir(), `f1758-${permissionMode}-`))
  const { manager, sent } = harness()
  const runner = manager.pluginCommandHookRunner(managedSession(root, permissionMode), capabilityRuntime())
  const action = { type: 'command' as const, command, timeoutMs }
  const result = await runner(action, { ...(on === 'PreToolUse' ? preToolHookOptions : hookOptions), cwd: root, hookSource })
  return { action, result, sent }
}

/** F1.771 — what the SDK callback does with this run on `PreToolUse`: does it deny the tool call? */
function blocksTheTool(action: { type: 'command'; command: string }, result: any): boolean {
  return isBlockingHookDecision(projectHookDecisionForEvent(
    'PreToolUse',
    getHookCommandPreToolDecision(action, result, { event: 'PreToolUse' }),
  ))
}

/** What the SDK callback does with this run on `UserPromptSubmit`: does it stop the prompt? */
function stopsThePrompt(action: { type: 'command'; command: string }, result: any): boolean {
  const decision = projectHookDecisionForEvent(
    'UserPromptSubmit',
    getHookCommandPreToolDecision(action, result, { event: 'UserPromptSubmit' }),
  )
  return isBlockingHookDecision(decision) && hookBlockEndsTurn('UserPromptSubmit')
}

describe('F1.758 — a user UserPromptSubmit hook runs in plan mode', () => {
  test('the sitting\'s sessionTitle hook RUNS in plan mode, prints its title, raises no card and does not stop the prompt', async () => {
    const { action, result, sent } = await runHook('plan', TITLE_HOOK, 'user')

    expect(result.success).toBe(true)
    expect(result.stdout ?? '').toContain('"sessionTitle":"cdp-title"')
    expect(sent.filter(event => event.type === 'permission_request')).toEqual([])
    expect(stopsThePrompt(action, result)).toBe(false)
  }, 60_000)

  test('CONTROL: a hook that genuinely blocks still stops the prompt in plan mode — by its own decision, not by the mode', async () => {
    const { action, result } = await runHook('plan', BLOCK_HOOK, 'user')

    expect(result.success).toBe(true)
    expect(result.stdout ?? '').toContain('f1758-genuine-block')
    expect(stopsThePrompt(action, result)).toBe(true)
  }, 60_000)

  test('CONTROL: a plain hook printing nothing (`true`) runs in plan mode and does not stop the prompt', async () => {
    const { action, result, sent } = await runHook('plan', 'true', 'user')

    expect(result.success).toBe(true)
    expect(sent.filter(event => event.type === 'permission_request')).toEqual([])
    expect(stopsThePrompt(action, result)).toBe(false)
  }, 60_000)

  for (const mode of ['bypassPermissions', 'acceptEdits', 'default']) {
    test(`CONTROL: the same sessionTitle hook in ${mode} runs exactly as before`, async () => {
      const { action, result, sent } = await runHook(mode, TITLE_HOOK, 'user')

      expect(result.success).toBe(true)
      expect(result.stdout ?? '').toContain('"sessionTitle":"cdp-title"')
      expect(sent.filter(event => event.type === 'permission_request')).toEqual([])
      expect(stopsThePrompt(action, result)).toBe(false)
    }, 60_000)
  }

  test('BOUNDARY: a PLUGIN\'s identical hook in plan mode asks, as it does in acceptEdits, and never runs unasked', async () => {
    const { result, sent } = await runHook('plan', TITLE_HOOK, 'plugin', 300)

    // Plan mode now treats a hook command the way `default`/`acceptEdits`
    // already did: outside the read-only set it needs approval. D1.343 keeps the
    // card for a third party's hook, and D1.333's budget still ends the wait.
    expect(result.success).toBe(false)
    expect(result.stdout ?? '').not.toContain('cdp-title')
    expect(result.error ?? '').toContain('needed your approval')
    expect(sent.filter(event => event.type === 'permission_request')).toHaveLength(1)
  }, 60_000)

  test('BOUNDARY: a floor still refuses a user hook in plan mode (a denied path is a deny, never upgraded)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f1758-floor-'))
    const { manager, sent } = harness()
    const runner = manager.pluginCommandHookRunner(managedSession(root, 'plan'), capabilityRuntime())
    const result = await runner(
      { type: 'command', command: `cat ${join(root, '.env')}`, timeoutMs: 20_000 },
      { ...hookOptions, cwd: root, hookSource: 'user' },
    )

    expect(result.success).toBe(false)
    expect(result.error ?? '').toContain('Sensitive path blocked')
    expect(sent.filter(event => event.type === 'permission_request')).toEqual([])
  }, 60_000)
})

describe('F1.771 — a user command hook runs in plan (a stored explore reads as it) and dontAsk too', () => {
  for (const mode of ['plan', 'dontAsk']) {
    test(`the sitting's sessionTitle hook RUNS in ${mode}, prints its title, raises no card and does not stop the prompt`, async () => {
      const { action, result, sent } = await runHook(mode, TITLE_HOOK, 'user')

      expect(result.success).toBe(true)
      expect(result.stdout ?? '').toContain('"sessionTitle":"cdp-title"')
      expect(sent.filter(event => event.type === 'permission_request')).toEqual([])
      expect(stopsThePrompt(action, result)).toBe(false)
    }, 60_000)

    test(`a plain hook printing nothing (\`true\`) runs in ${mode} and does not stop the prompt`, async () => {
      const { action, result, sent } = await runHook(mode, 'true', 'user')

      expect(result.success).toBe(true)
      expect(sent.filter(event => event.type === 'permission_request')).toEqual([])
      expect(stopsThePrompt(action, result)).toBe(false)
    }, 60_000)

    test(`CONTROL: a hook that genuinely blocks still stops the prompt in ${mode} — by its own decision, not by the mode`, async () => {
      const { action, result } = await runHook(mode, BLOCK_HOOK, 'user')

      expect(result.success).toBe(true)
      expect(result.stdout ?? '').toContain('f1758-genuine-block')
      expect(stopsThePrompt(action, result)).toBe(true)
    }, 60_000)

    test(`a user PreToolUse hook runs in ${mode} and does not deny the tool call`, async () => {
      const { action, result, sent } = await runHook(mode, 'true', 'user', 20_000, 'PreToolUse')

      expect(result.success).toBe(true)
      expect(sent.filter(event => event.type === 'permission_request')).toEqual([])
      expect(blocksTheTool(action, result)).toBe(false)
    }, 60_000)

    test(`BOUNDARY: a floor still refuses a user hook in ${mode} (a denied path is a deny, never upgraded)`, async () => {
      const root = mkdtempSync(join(tmpdir(), `f1771-floor-${mode}-`))
      const { manager, sent } = harness()
      const runner = manager.pluginCommandHookRunner(managedSession(root, mode), capabilityRuntime())
      const result = await runner(
        { type: 'command', command: `cat ${join(root, '.env')}`, timeoutMs: 20_000 },
        { ...hookOptions, cwd: root, hookSource: 'user' },
      )

      expect(result.success).toBe(false)
      expect(result.error ?? '').toContain('Sensitive path blocked')
      expect(sent.filter(event => event.type === 'permission_request')).toEqual([])
    }, 60_000)
  }

  test('BOUNDARY: a PLUGIN\'s hook in plan asks, as it does in Manual mode, and never runs unasked', async () => {
    const { result, sent } = await runHook('plan', TITLE_HOOK, 'plugin', 300)

    expect(result.success).toBe(false)
    expect(result.stdout ?? '').not.toContain('cdp-title')
    expect(result.error ?? '').toContain('needed your approval')
    expect(sent.filter(event => event.type === 'permission_request')).toHaveLength(1)
  }, 60_000)

  test('BOUNDARY: a PLUGIN\'s hook in dontAsk is REFUSED with no card — the mode never prompts, and the refusal says so', async () => {
    const { result, sent } = await runHook('dontAsk', TITLE_HOOK, 'plugin', 300)

    expect(result.success).toBe(false)
    expect(result.stdout ?? '').not.toContain('cdp-title')
    expect(sent.filter(event => event.type === 'permission_request')).toEqual([])
    expect(result.error ?? '').toContain("Don't ask mode never prompts")
  }, 60_000)
})

/**
 * F1.772 — the answer the claude SDK callback returns for a WORKSPACE-tier
 * (`hooks.json`) native hook the host refuses in `dontAsk`: the real runner,
 * the real dispatcher and the real SDK translation, with nothing answering a card.
 */
async function claudeSdkAnswerForRefusedHook(event: 'UserPromptSubmit' | 'PostToolBatch' | 'PreToolUse') {
  const root = mkdtempSync(join(tmpdir(), `f1772-${event}-`))
  const { manager, sent } = harness()
  const scoped = new PluginScopedAutomationSystem({
    pluginHookConfig: { automations: {} } as any,
    workspaceHookConfig: { automations: { [event]: [{ actions: [{ type: 'command', command: TITLE_HOOK, timeoutMs: 300 }] }] } } as any,
    workspaceRootPath: root,
    pluginCommandRunner: manager.pluginCommandHookRunner(managedSession(root, 'dontAsk'), capabilityRuntime()),
  })
  const matchers = scoped.buildSdkHooks()[event] ?? []
  expect(matchers).toHaveLength(1)
  const input = event === 'UserPromptSubmit'
    ? { prompt: 'plan something' }
    : event === 'PreToolUse' ? { tool_name: 'Read', tool_input: { file_path: 'README.md' } } : { tool_calls: [] }
  const answer = await matchers[0]!.hooks[0]!(
    { hook_event_name: event, session_id: 'session-f1772', ...input } as never,
    'hook-f1772',
    {},
  ) as Record<string, unknown>
  return { answer, cards: sent.filter(sentEvent => sentEvent.type === 'permission_request').length }
}

describe('F1.772 — a native hook the host refuses reaches claude with its refusal and the mode, never the bare stop', () => {
  test('UserPromptSubmit: the SDK is handed no stop and no block — the prompt goes on — and a notice naming the refusal and the mode', async () => {
    const { answer, cards } = await claudeSdkAnswerForRefusedHook('UserPromptSubmit')

    expect(cards).toBe(0)
    // Before F1.863 + F1.864 this was `continue: false` beside the block: the
    // runtime's "Operation stopped by hook", and the reason nowhere.
    expect(answer.continue).toBe(true)
    expect(answer.decision).toBeUndefined()
    expect(answer.stopReason).toBeUndefined()
    const notice = String(answer.systemMessage ?? '')
    expect(notice).toContain('hook error: Command hook not run')
    expect(notice).toContain("Don't ask mode never prompts")
  }, 60_000)

  test('PostToolBatch (F1.1037 — no longer fail-closed): the loop goes on, and the notice names the refusal and the mode', async () => {
    const { answer, cards } = await claudeSdkAnswerForRefusedHook('PostToolBatch')

    expect(cards).toBe(0)
    expect(answer.continue).toBe(true)
    expect(answer.decision).toBeUndefined()
    const notice = String(answer.systemMessage ?? '')
    expect(notice).toContain('hook error: Command hook not run')
    expect(notice).toContain("Don't ask mode never prompts")
  }, 60_000)

  test('BOUNDARY: PreToolUse, where a refused native hook still fails closed — the deny\'s reason names the refusal and the mode', async () => {
    const { answer, cards } = await claudeSdkAnswerForRefusedHook('PreToolUse')

    expect(cards).toBe(0)
    const output = (answer.hookSpecificOutput ?? {}) as Record<string, unknown>
    expect(output.permissionDecision).toBe('deny')
    const reason = String(output.permissionDecisionReason ?? '')
    expect(reason).toContain('Command hook not run')
    expect(reason).toContain("Don't ask mode never prompts")
  }, 60_000)
})
