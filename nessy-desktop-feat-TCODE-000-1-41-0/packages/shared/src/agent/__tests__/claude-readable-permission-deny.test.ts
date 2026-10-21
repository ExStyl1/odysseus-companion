/**
 * F1.813 — A READABLE PERMISSION DENY RULE MUST BIND THE CLAUDE RUNTIME.
 *
 * ## The defect, measured before the fix (lane WJ-crit-kk, 2026-09-25)
 *
 * The readable permission DSL (`permissionDsl`) is evaluated by the host on Pi
 * (`PiAgent.handlePreToolUseRequest`, the merged config's `permissionDsl`) and on
 * codex (`CodexAgent.consultPermissionRules`), and `claude-managed-settings.ts`'s
 * gap table said "the PreToolUse gate enforces every rule of it" on claude. It did
 * not: `claude-agent.ts` evaluated no readable rule at all, and the shared gate
 * (`core/pre-tool-use.ts`, `mode-manager.ts`) reads no `permissionDsl`. Driven
 * through this file's rig for `rm -rf x`, a DENY rule delivered as a workspace
 * `permissions.json` (structural `{kind:'bash', executable:'rm'}` and Claude-form
 * `Bash(rm *)`), as a capability permission layer, and as a managed rule written
 * directly in `permissionDsl` raised a CARD in `default` (the user could approve
 * what the policy denies) and was ALLOWED outright in `bypassPermissions`; the SDK
 * options carried none of them. Only a managed `claudeRules` entry bound, because
 * it reaches the SDK as `managedSettings.permissions.deny`. The same rules on Pi
 * refused the call in both modes — the positive control below.
 *
 * ## The fix under test
 *
 * The claude PreToolUse hook now asks `claudeReadablePermissionDeny`
 * (`claude-readable-permission-deny.ts`) for the DENY half of the same merged
 * policy Pi evaluates — capability layers or the workspace files, session rules,
 * the managed `permissionDsl` and the managed-only lock — and refuses the call
 * naming the rule. An allow rule is not honoured here (it fails closed to the
 * mode's own answer), asserted below as what it is, not as a defect fixed. The
 * ASK half, which this suite first recorded as raising no card, is F1.830's.
 *
 * ## The discipline
 *
 * A real `ClaudeAgent` runs a real `chatImpl` turn; the SDK `query` is the only
 * double, and the verdict is read from the REAL PreToolUse hook that turn
 * registered with the SDK. Every deny arm runs in `default` AND
 * `bypassPermissions`, beside controls on the same rig that must NOT deny (no
 * rule, an unrelated deny, an allow rule, an invalid document), so a rig that
 * denied everything could not pass.
 *
 * ## F1.830 — the ASK half (lane WJ-crit-nn, 2026-09-25)
 *
 * `permission-modes.md#actions-no-mode-auto-approves`: "Claude Code doesn't
 * auto-approve the following in any mode, including `bypassPermissions`" — the
 * first bullet is "Tools matched by an explicit ask rule" — and the per-mode
 * sections say what happens instead: `auto` "Explicit ask rules still force a
 * prompt", `dontAsk` "Claude Code denies calls matching your explicit `ask`
 * rules rather than prompting", and bypass-available planning "Explicit ask rules
 * ... still prompt". Measured before the fix through this same rig
 * (`work/wjcritnn/probe-before.log`): a readable ASK for `rm` delivered four
 * ways was ALLOWED by the hook in `bypassPermissions`; a readable ASK for `Read`
 * was allowed in all seven modes (`dontAsk` included); and where the mode itself
 * carded (`rm` in `default`), the card was marked `modePrompt`, i.e. offered as
 * a card a mode switch would remove. Pi raised the ask for every one of them
 * (its positive control below). The describe blocks tagged F1.830 are the
 * failing arm and the controls of that fix.
 *
 * ## F1.860 — no remember window on an ask-rule card (lane WJ-crit-tt, 2026-09-25)
 *
 * SIT-ae (packaged build of `69a6d33da`): in Manual, "Allow for this session" on
 * the ask-rule card for `rm` let every later identical `rm` run with no card,
 * while bypass's host card asked again. Measured before the fix end to end —
 * this rig's real hook feeding the REAL `SessionManager.handleAgentPermissionRequest`
 * and `respondToPermission` (`work/wjcrittt/probe-before.log`): the Manual,
 * `auto`, `acceptEdits` and `plan` ask-rule cards carried the mode prompt's
 * `commandHash` + `rememberForMinutes: 10`, the session remember window was
 * stored under that hash, and the second identical call was answered with no
 * card; the bypass card carried neither and asked again; a no-rule Manual card
 * kept its window (the control). The server half is not reachable from this
 * package, so the blocks tagged F1.860 pin the card's contract with that
 * consumer: an ask-rule card carries neither field and names the rule, in
 * every mode, and the host's own session whitelist cannot clear the ask either.
 *
 * ## F1.921 — the ask card says WHAT it approves (lane WJ-crit-hhh, 2026-09-25)
 *
 * Delta review 2's probe (`work/review-142/claude/probe/ask-card.ts`), re-run
 * before the fix: over a call the gate would have run, the card
 * `claudeReadablePermissionAskCheckResult` builds carried a subject only for
 * Bash (the command) and a file write (the path); a `Read` of `/Users/me/.ssh/id_rsa`,
 * a `WebFetch` of a URL, a `Grep` and an MCP call were each carded as the bare
 * tool name (`"command":"Read"`), and the renderer shows `command` as the
 * card's only preview. The blocks tagged F1.921 are the failing arm and the
 * controls (Bash and file-write cards unchanged, the rule sentence unchanged,
 * no remember window, and no host whitelist key minted from a path).
 *
 * ## F1.923 — a readable rule binds a large image's ORIGINAL path (lane WJ-crit-hhh, 2026-09-25)
 *
 * Measured first through this rig with a host resizer: a Read of an image
 * above `IMAGE_LIMITS.MAX_RAW_SIZE` inside a directory a readable DENY covers
 * was ALLOWED (the hook's revalidate step swapped `file_path` for the resized
 * copy before the rule was consulted, so the rule saw only the copy's path), and
 * an ASK over the same directory raised no card. The blocks tagged F1.923 are
 * that failing arm and its controls.
 *
 * ## F1.842 — the ask-rule card offers no Always Allow (lane DN-019, 2026-09-26)
 *
 * After F1.860 an Always answer on an ask-rule card runs the one call and the
 * next one asks again (the rule outranks whatever the click saves), yet the card
 * still offered the button: the host card carried no `noAlwaysAllow`, the field
 * the renderer's `canRemember` reads. Codex (F1.870) and Pi (F1.913) already send
 * it. The blocks tagged F1.842 pin it on the readable-ask card and keep it off
 * the mode's own card and a floor's.
 *
 * ## F1.843 — an ask rule on AskUserQuestion: one dialog, the question (lane DN-031, 2026-09-26)
 *
 * The row said such a rule shows the approval card and then the question. Measured
 * at `f92977ad6` through the real hook and the real `canUseTool`, it does not: the
 * gate marks the call's prompt `requiresUserInteraction` (a `toolRules` ask only
 * rewords that prompt), a readable ask keeps a floor's marker
 * (`claudeReadablePermissionAskCheckResult`), and so
 * `askUserQuestionPromptBelongsToCanUseTool` hands the call to `canUseTool`,
 * where the question itself is the consent — as the SDK's own route has it,
 * because `AskUserQuestion` always falls through to that callback. The blocks
 * tagged F1.843 pin that, beside a deny that still refuses and a Read ask that
 * shows the rig does see host cards.
 *
 * ## F1.833 — a rule under Pi's id binds Glob, Agent and Task (lane DN-078, 2026-09-26)
 *
 * A claude built-in was read under the Pi descriptor of the SAME permission name
 * only, so `Glob` (Pi's `find`) and `Agent`/`Task` (Pi's `subagent`) answered to
 * their claude name alone, and `Task` landed on Pi's pi-only session task-graph
 * `Task`. Measured before the fix: a deny under `find` or `Find` did not refuse
 * `Glob`, a deny under `subagent` did not refuse `Agent`, and a deny under `task`
 * refused claude's `Task`. The blocks tagged F1.833 are that arm and its controls.
 *
 * ## F1.935 — an ask rule's large image is copied only after its card is approved (lane DN-156, 2026-09-26)
 *
 * F1.923 kept a DENY from ever copying the image; an ASK still had the resized
 * copy written to the session's tmp BEFORE the card, and nothing removed it when
 * the card was refused (or when `dontAsk` refused the call). Measured before the
 * fix through this rig: a refused card in default and bypass, and the `dontAsk`
 * refusal, each left the resizer called once (`[large]`). The blocks tagged
 * F1.935 are that arm and its controls (an approved card still reads the copy; a
 * resizer that gives none still refuses).
 */
import { afterAll, describe, expect, mock, setDefaultTimeout, test } from 'bun:test'
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts'
import type { PermissionMode } from '../mode-types.ts'
import { finalizePiExecutionManifest, type PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts'
import { PI_STATIC_MODEL_CONTRACT_HASHES, PI_TOOL_BINDINGS, getHarnessToolDescriptor } from '../pi-harness/harness-tool-descriptor.ts'
import { parseAndFreezePiPermissionReceipt, type PiPermissionServicePort } from '../pi-harness/permission-receipt.ts'
import { parsePermissionDslV1 } from '../pi-harness/permission-dsl.ts'
import { parseManagedPiPolicyV1, registerManagedPiPolicyProvider, type ManagedPiPolicyV1 } from '../pi-harness/managed-policy.ts'
import { IMAGE_LIMITS } from '../../utils/files.ts'

// The module graph (the whole claude and Pi agents) is the cost, not the bodies.
setDefaultTimeout(180_000)

/** A SNAPSHOT of the SDK's exports, never the live namespace (AGENTS.md §Traps, `mock.module`). */
const realSdk = { ...sdkPackage }
type HookFn = (input: Record<string, unknown>, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<unknown>
let capturedOptions: Record<string, unknown> | undefined
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    capturedOptions = input.options
    const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]()
    async function* serve(): AsyncGenerator<unknown> {
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
        yield { type: 'result', subtype: 'success', result: 'ok', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
      }
    }
    const stream = serve() as AsyncGenerator<unknown> & { interrupt(): Promise<unknown> }
    stream.interrupt = async () => ({ still_queued: [] })
    return stream
  },
}))
afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk)
  registerManagedPiPolicyProvider(undefined)
})

const { ClaudeAgent } = await import('../claude-agent.ts')
const { PiAgent } = await import('../pi-agent.ts')
const { claudeReadablePermissionAskCheckResult, claudeReadablePermissionDeny } = await import('../claude-readable-permission-deny.ts')
const { PI_RUNTIME_AGENT_TOOL_ALIASES } = await import('../pi-harness/runtime-agent-definition.ts') // F1.833
const { parsePermissionsJson } = await import('../permissions-config.ts') // F1.1002

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'f1813-')))
const COMMAND = 'rm -rf x'
const MODES = ['default', 'bypassPermissions'] as const
type Mode = typeof MODES[number]

const STRUCTURAL_DENY = { id: 'deny-rm-structural', action: 'deny', match: { kind: 'bash', executable: 'rm' } }
const CLAUDE_FORM_DENY = { id: 'deny-rm-claude-form', action: 'deny', match: { kind: 'bash', pattern: 'rm *' } }
const UNRELATED_DENY = { id: 'deny-git', action: 'deny', match: { kind: 'bash', executable: 'git' } }
const STRUCTURAL_ALLOW = { id: 'allow-rm', action: 'allow', match: { kind: 'bash', executable: 'rm' } }
const MANAGED_NATIVE = parseManagedPiPolicyV1({ schemaVersion: 1, permissionDsl: { version: 1, rules: [STRUCTURAL_DENY] } })
const MANAGED_CLAUDE_RULES = parseManagedPiPolicyV1({ schemaVersion: 1, claudeRules: { deny: ['Bash(rm *)'] } })

let wsCounter = 0
/** A fresh workspace per case, so no merged-config cache entry is shared between cases. */
function workspace(permissions?: unknown): string {
  wsCounter += 1
  const ws = join(ROOT, `ws-${wsCounter}`)
  mkdirSync(ws, { recursive: true })
  if (permissions !== undefined) {
    writeFileSync(join(ws, 'permissions.json'), typeof permissions === 'string' ? permissions : JSON.stringify(permissions))
  }
  return ws
}
const dsl = (...rules: unknown[]) => ({ permissionDsl: { version: 1, rules } })

// ---------------------------------------------------------------- claude rig

interface ClaudeVerdict {
  decision: 'deny' | 'allow' | 'card' | 'other'
  reason: string
  sdkManagedDeny: readonly string[]
  /**
   * F1.830 — the card the host raised, when it raised one. F1.860 — with the two
   * fields that ARE the remember window (`SessionManager` keys "Allow for this
   * session" on `commandHash`).
   */
  card?: { type?: string; description?: string; modePrompt?: true; commandHash?: string; rememberForMinutes?: number; command?: string; noAlwaysAllow?: boolean }
  /** F1.923 — the input the hook hands the SDK (`updatedInput`), on an allow or after an approved card. */
  updatedInput?: Record<string, unknown>
  /** F1.921 — `permissionManager.isCommandWhitelisted` for each `probeWhitelist` key, read after the card was answered. */
  whitelisted?: Record<string, boolean>
  /** F1.860 — the SAME call fired again after the first card was answered (`thenSameCallAgain`). */
  again?: { decision: 'deny' | 'allow' | 'card' | 'other'; card?: { description?: string; commandHash?: string; rememberForMinutes?: number } }
  /** F1.830 — the hook's answer once the card was answered (`answerCard`). */
  afterCard?: string
  /** F1.830 — the SDK's own `canUseTool` for the same call after the card (`askCanUseToolAfter`). */
  canUseToolAfter?: string
  sdkManagedAsk: readonly string[]
}

let sessionCounter = 0
async function claudeVerdict(options: {
  mode: PermissionMode
  ws: string
  /** F1.830 — the call; `Bash` running {@link COMMAND} when absent. */
  call?: { toolName: string; input: Record<string, unknown> }
  /** F1.830 — how the host card is answered (refused when absent). */
  answerCard?: boolean
  /** F1.830 — after an APPROVED card, ask the SDK's own `canUseTool` for the same call. */
  askCanUseToolAfter?: boolean
  /** F1.860 — answer the card "Allow for this session" (`alwaysAllow`), implies `answerCard`. */
  answerAlwaysAllow?: boolean
  /** F1.860 — then fire the SAME call through the hook again; a second card is refused. */
  thenSameCallAgain?: boolean
  policy?: ManagedPiPolicyV1
  /** The production capability path: the layers `buildPinnedCapabilityContext` publishes each turn. */
  layers?: Array<{ content: string; scope: 'workspace' }>
  /** F1.923 — the host's image resizer (`BackendConfig.onImageResize`); absent means none, as before. */
  onImageResize?: (filePath: string, maxSize: number) => Promise<string | undefined>
  /** F1.921 — keys to read back from the host's session command whitelist after the card is answered. */
  probeWhitelist?: string[]
}): Promise<ClaudeVerdict> {
  registerManagedPiPolicyProvider(options.policy ? () => options.policy : undefined)
  capturedOptions = undefined
  sessionCounter += 1
  const agent = new ClaudeAgent({
    provider: 'anthropic', providerType: 'anthropic', model: 'claude-sonnet-4-6', isHeadless: true, skipConfigWatcher: true,
    workspace: { id: `ws-f1813-${sessionCounter}`, name: 'F1813', rootPath: options.ws, workspaceRootPath: options.ws, sessionRootPath: join(ROOT, 'sessions') } as never,
    session: { id: `session-f1813-${sessionCounter}`, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: options.ws, permissionMode: options.mode } as never,
    ...(options.onImageResize ? { onImageResize: options.onImageResize } : {}),
  } as BackendConfig)
  try {
    agent.setPermissionMode(options.mode)
    const cards: Array<{ requestId: string; type?: string; description?: string; modePrompt?: true; commandHash?: string; rememberForMinutes?: number; command?: string; noAlwaysAllow?: boolean }> = []
    let raiseCard: (requestId: string) => void = () => {}
    const nextCard = () => new Promise<string>(resolve => { raiseCard = resolve })
    const carded = nextCard()
    agent.onPermissionRequest = request => {
      cards.push(request as never)
      raiseCard(request.requestId)
    }
    const chatImpl = (agent as unknown as { chatImpl(message: string): AsyncGenerator<unknown> }).chatImpl.bind(agent)
    for await (const _ of chatImpl('go')) { /* drain the one turn */ }
    if (options.layers) {
      (agent as unknown as { permissionManager: { setCapabilityPermissionLayers(l: unknown[], g: string, t: boolean): void } })
        .permissionManager.setCapabilityPermissionLayers(options.layers.map(layer => ({ ...layer, sourceRoot: options.ws })), 'gen-f1813', true)
    }
    // Read through a cast: TypeScript narrowed the module variable to `undefined` at the reset above.
    const seen = capturedOptions as Record<string, unknown> | undefined
    const hook = (seen?.hooks as { PreToolUse?: Array<{ hooks: HookFn[] }> } | undefined)?.PreToolUse?.[0]?.hooks?.[0]
    if (!hook) throw new Error('the turn registered no PreToolUse hook')
    const call = options.call ?? { toolName: 'Bash', input: { command: COMMAND } }
    const answer = hook(
      { hook_event_name: 'PreToolUse', tool_name: call.toolName, tool_use_id: 'toolu_f1813', tool_input: call.input, session_id: 'sdk-f1813', transcript_path: join(ROOT, 't.jsonl'), cwd: options.ws },
      'toolu_f1813',
      { signal: new AbortController().signal },
    ) as Promise<{ hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } }>
    const settled = await Promise.race([answer.then(value => ({ value })), carded.then(requestId => ({ requestId }))])
    const whitelistRead = () => options.probeWhitelist
      ? { whitelisted: Object.fromEntries(options.probeWhitelist.map(key => [key, (agent as unknown as { permissionManager: { isCommandWhitelisted(k: string): boolean } }).permissionManager.isCommandWhitelisted(key)])) }
      : {}
    const sdkManagedDeny = ((seen?.managedSettings as { permissions?: { deny?: string[] } } | undefined)?.permissions?.deny) ?? []
    const sdkManagedAsk = ((seen?.managedSettings as { permissions?: { ask?: string[] } } | undefined)?.permissions?.ask) ?? []
    if ('requestId' in settled) {
      agent.respondToPermission(settled.requestId, options.answerCard === true || options.answerAlwaysAllow === true, options.answerAlwaysAllow === true)
      const afterOut = (await answer)?.hookSpecificOutput
      const after = afterOut?.permissionDecision
      const raised = cards.find(card => card.requestId === settled.requestId)
      let canUseToolAfter: string | undefined
      if (options.askCanUseToolAfter) {
        const canUseTool = seen?.canUseTool as (name: string, input: unknown, opts: unknown) => Promise<{ behavior?: string }>
        const cardsBefore = cards.length
        const verdict = await Promise.race([
          canUseTool(call.toolName, call.input, { signal: new AbortController().signal, toolUseID: 'toolu_f1813', suggestions: [] }).then(value => value.behavior ?? 'none'),
          new Promise<string>(resolve => setTimeout(() => resolve('pending'), 2_000)),
        ])
        canUseToolAfter = cards.length > cardsBefore ? `second card (${verdict})` : verdict
        for (const extra of cards.slice(cardsBefore)) agent.respondToPermission(extra.requestId, false)
      }
      const rememberFields = (card?: { commandHash?: string; rememberForMinutes?: number }) => ({
        ...(card?.commandHash === undefined ? {} : { commandHash: card.commandHash }),
        ...(card?.rememberForMinutes === undefined ? {} : { rememberForMinutes: card.rememberForMinutes }),
      })
      let again: ClaudeVerdict['again']
      if (options.thenSameCallAgain) {
        const cardedAgain = nextCard()
        const answerAgain = hook(
          { hook_event_name: 'PreToolUse', tool_name: call.toolName, tool_use_id: 'toolu_f1860_again', tool_input: call.input, session_id: 'sdk-f1813', transcript_path: join(ROOT, 't.jsonl'), cwd: options.ws },
          'toolu_f1860_again',
          { signal: new AbortController().signal },
        ) as Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>
        const settledAgain = await Promise.race([answerAgain.then(value => ({ value })), cardedAgain.then(requestId => ({ requestId }))])
        if ('requestId' in settledAgain) {
          agent.respondToPermission(settledAgain.requestId, false)
          await answerAgain
          const raisedAgain = cards.find(card => card.requestId === settledAgain.requestId)
          again = { decision: 'card', card: { description: raisedAgain?.description, ...rememberFields(raisedAgain) } }
        } else {
          const decisionAgain = settledAgain.value?.hookSpecificOutput?.permissionDecision
          again = { decision: decisionAgain === 'deny' || decisionAgain === 'allow' ? decisionAgain : 'other' }
        }
      }
      return {
        decision: 'card', reason: '', sdkManagedDeny, sdkManagedAsk,
        card: { type: raised?.type, description: raised?.description, ...(raised?.modePrompt ? { modePrompt: raised.modePrompt } : {}), ...rememberFields(raised), ...(raised?.command === undefined ? {} : { command: raised.command }), ...(raised?.noAlwaysAllow === undefined ? {} : { noAlwaysAllow: raised.noAlwaysAllow }) },
        afterCard: String(after),
        ...(afterOut?.updatedInput ? { updatedInput: afterOut.updatedInput } : {}),
        ...whitelistRead(),
        ...(canUseToolAfter === undefined ? {} : { canUseToolAfter }),
        ...(again === undefined ? {} : { again }),
      }
    }
    const out = settled.value?.hookSpecificOutput
    const decision = out?.permissionDecision === 'deny' || out?.permissionDecision === 'allow' ? out.permissionDecision : 'other'
    return { decision, reason: String(out?.permissionDecisionReason ?? ''), sdkManagedDeny, sdkManagedAsk, ...(out?.updatedInput ? { updatedInput: out.updatedInput } : {}) }
  } finally {
    agent.destroy()
    registerManagedPiPolicyProvider(undefined)
  }
}

describe('F1.813 — a readable DENY rule refuses the claude call in default AND bypass', () => {
  const denyCases: Array<{ name: string; ruleId: string; scope: string; setup: () => Omit<Parameters<typeof claudeVerdict>[0], 'mode'> }> = [
    { name: 'workspace permissions.json, structural', ruleId: 'deny-rm-structural', scope: 'workspace scope', setup: () => ({ ws: workspace(dsl(STRUCTURAL_DENY)) }) },
    { name: 'workspace permissions.json, Claude-form Bash(rm *)', ruleId: 'deny-rm-claude-form', scope: 'workspace scope', setup: () => ({ ws: workspace(dsl(CLAUDE_FORM_DENY)) }) },
    { name: 'capability permission layer (the production turn path)', ruleId: 'deny-rm-structural', scope: 'workspace scope', setup: () => ({ ws: workspace(), layers: [{ content: JSON.stringify(dsl(STRUCTURAL_DENY)), scope: 'workspace' as const }] }) },
    { name: 'managed rule written directly in permissionDsl', ruleId: 'deny-rm-structural', scope: 'managed scope', setup: () => ({ ws: workspace(), policy: MANAGED_NATIVE }) },
  ]
  for (const mode of MODES) {
    for (const c of denyCases) {
      test(`${c.name} — ${mode}`, async () => {
        const verdict = await claudeVerdict({ mode, ...c.setup() })
        expect(verdict.decision).toBe('deny')
        expect(verdict.reason).toContain(`\`${c.ruleId}\``)
        expect(verdict.reason).toContain(c.scope)
      })
    }
  }
})

describe('F1.813 — CONTROLS on the same rig: what must not become a deny', () => {
  for (const mode of MODES) {
    const unchanged = mode === 'default' ? 'card' : 'allow'
    test(`no rule — ${mode}: the mode's own answer (${unchanged})`, async () => {
      expect((await claudeVerdict({ mode, ws: workspace() })).decision).toBe(unchanged)
    })
    test(`an unrelated deny (git) — ${mode}: the mode's own answer (${unchanged})`, async () => {
      expect((await claudeVerdict({ mode, ws: workspace(dsl(UNRELATED_DENY)) })).decision).toBe(unchanged)
    })
    // Fail-closed, and stated: the allow half is not evaluated on claude, so an
    // allow rule changes nothing — the mode still asks in default.
    test(`an ALLOW rule for rm — ${mode}: not honoured, the mode's own answer (${unchanged})`, async () => {
      expect((await claudeVerdict({ mode, ws: workspace(dsl(STRUCTURAL_ALLOW)) })).decision).toBe(unchanged)
    })
    // codex's posture on a document that cannot answer (`consultPermissionRules`):
    // a failed document belongs to no rule anyone wrote, so it refuses nothing here.
    test(`an INVALID permissionDsl document — ${mode}: not consulted, the mode's own answer (${unchanged})`, async () => {
      expect((await claudeVerdict({ mode, ws: workspace({ permissionDsl: 'not a document' }) })).decision).toBe(unchanged)
    })
    // The SDK route is untouched: managed `claudeRules` still reaches the SDK as
    // `permissions.deny`; the host now refuses the same call too, naming the
    // administrator's own rule string (the parser keeps it as the rule's text).
    test(`managed claudeRules — ${mode}: still reaches the SDK, and the host refuses too`, async () => {
      const verdict = await claudeVerdict({ mode, ws: workspace(), policy: MANAGED_CLAUDE_RULES })
      expect(verdict.sdkManagedDeny).toContain('Bash(rm *)')
      expect(verdict.decision).toBe('deny')
      expect(verdict.reason).toContain('`Bash(rm *)` (managed scope)')
    })
  }
})

// ---------------------------------------------------------------- the module's own seams

describe('F1.813 — claudeReadablePermissionDeny, the seams the hook rig does not reach', () => {
  const ask = (ws: string, toolName: string, inputs: Array<Record<string, unknown>>, managedPolicy?: ManagedPiPolicyV1) =>
    claudeReadablePermissionDeny({ toolName, inputs, cwd: ws, permissionsContext: { workspaceRootPath: ws }, managedPolicy })

  test('a deny under the ORIGINAL spelling refuses even when the gate rewrote the input past it', () => {
    const ws = workspace(dsl(CLAUDE_FORM_DENY))
    expect(ask(ws, 'Bash', [{ command: 'rtk git status' }])).toBeUndefined()
    expect(ask(ws, 'Bash', [{ command: COMMAND }, { command: 'rtk git status' }])).toMatchObject({ kind: 'deny', ruleId: 'deny-rm-claude-form' })
  })

  test('the managed-only lock drops a workspace deny and keeps the managed one — Pi\'s own merge', () => {
    const ws = workspace(dsl(STRUCTURAL_DENY))
    const locked = parseManagedPiPolicyV1({ schemaVersion: 1, allowManagedPermissionRulesOnly: true })
    expect(ask(ws, 'Bash', [{ command: COMMAND }])).toMatchObject({ kind: 'deny', scope: 'workspace' })
    expect(ask(ws, 'Bash', [{ command: COMMAND }], locked)).toBeUndefined()
    const lockedWithRule = parseManagedPiPolicyV1({ schemaVersion: 1, allowManagedPermissionRulesOnly: true, permissionDsl: { version: 1, rules: [STRUCTURAL_DENY] } })
    expect(ask(ws, 'Bash', [{ command: COMMAND }], lockedWithRule)).toMatchObject({ kind: 'deny', scope: 'managed' })
  })

  test('a native rule written against Pi\'s ids binds the claude call of the same tool', () => {
    const ws = workspace(dsl(
      { id: 'deny-web-fetch', action: 'deny', match: { kind: 'tool', semanticId: 'web_fetch' } },
      { id: 'deny-remember', action: 'deny', match: { kind: 'tool', semanticId: 'remember' } },
    ))
    expect(ask(ws, 'WebFetch', [{ url: 'https://example.com' }])).toMatchObject({ kind: 'deny', ruleId: 'deny-web-fetch' })
    expect(ask(ws, 'mcp__session__remember', [{ text: 'x' }])).toMatchObject({ kind: 'deny', ruleId: 'deny-remember' })
    // Control: a tool no rule names.
    expect(ask(ws, 'Read', [{ file_path: join(ws, 'a.txt') }])).toBeUndefined()
  })

  // F1.831 (owner option A) — a broken workspace document is dropped WHOLE, as
  // `managed-settings.md#keys-that-fail-closed` says of a settings file, and the
  // other documents keep binding. Before, the whole program answered
  // `invalid-policy` and this module refused nothing, the managed deny included.
  test('F1.831 — a broken workspace document no longer switches off the managed deny', () => {
    const ws = workspace({ permissionDsl: 'x' })
    expect(ask(ws, 'Bash', [{ command: COMMAND }], MANAGED_NATIVE)).toMatchObject({ kind: 'deny', ruleId: 'deny-rm-structural', scope: 'managed' })
  })

  test('F1.831 — the broken document itself refuses nothing, its own readable deny included; the mode decides', () => {
    expect(ask(workspace({ permissionDsl: 'x' }), 'Bash', [{ command: COMMAND }])).toBeUndefined()
    const halfBroken = workspace(dsl(STRUCTURAL_DENY, { id: 'odd', action: 'deny', match: { kind: 'substring', value: 'rm' } }))
    expect(ask(halfBroken, 'Bash', [{ command: COMMAND }])).toBeUndefined()
  })

  // F1.1002 (option A's managed half) — a broken MANAGED document (a `builtin`
  // capability layer maps there) still fails the whole program closed, and that
  // deny now REFUSES here as Pi refuses it, with the compiler's diagnostic as
  // the reason and no rule id named. Until F1.1002 it came back `not-consulted`.
  test('F1.1002 — a broken managed document refuses every call, naming the diagnostic', () => {
    const ws = workspace()
    const brokenManaged = { workspaceRootPath: ws, pinnedRevision: 'g1', pinnedConfigs: [{ config: parsePermissionsJson('{"permissionDsl":{"version":1,"rules":"not-a-list"}}'), scope: 'managed' as const }] }
    const verdict = claudeReadablePermissionDeny({ toolName: 'Read', inputs: [{ file_path: join(ws, 'a.txt') }], cwd: ws, permissionsContext: brokenManaged, managedPolicy: undefined })
    expect(verdict).toMatchObject({ kind: 'deny', ruleId: 'invalid-policy', scope: 'managed', reason: 'Permission DSL document is invalid.' })
    // Boundary: the same broken document at the workspace tier is dropped whole and refuses nothing (F1.831).
    const brokenWorkspace = { ...brokenManaged, pinnedConfigs: [{ ...brokenManaged.pinnedConfigs[0]!, scope: 'workspace' as const }] }
    expect(claudeReadablePermissionDeny({ toolName: 'Read', inputs: [{ file_path: join(ws, 'a.txt') }], cwd: ws, permissionsContext: brokenWorkspace, managedPolicy: undefined })).toBeUndefined()
  })
})

// ---------------------------------------------------------------- Pi positive control

function recordingService(seen: string[]): PiPermissionServicePort {
  return {
    async authorize(request) {
      seen.push(request.decision.outcome)
      const outcome = request.decision.outcome === 'deny' ? 'deny' : 'allow'
      return parseAndFreezePiPermissionReceipt({
        version: 1, sessionKey: request.subject.sessionKey,
        binding: { provider: 'pi', surfaceVersion: request.subject.surfaceVersion, piName: request.subject.piName, bindingName: request.subject.bindingName, semanticId: request.subject.semanticId, descriptorId: request.subject.descriptorId },
        manifest: { generation: request.subject.manifestGeneration, hash: request.subject.manifestHash, provenance: request.subject.manifestProvenance, responseEpoch: request.subject.responseEpoch },
        decisionId: 'f1813', outcome,
        canonicalInput: (request.decision.outcome === 'allow' ? request.decision.canonicalInput : undefined) ?? request.canonicalInput,
        contextProfile: request.subject.contextProfile, sandboxRequirement: request.subject.sandboxRequirement,
        ...(request.decision.outcome === 'deny' ? { reason: request.decision.reason } : {}),
      }, request.subject)
    },
  }
}

async function piAction(mode: PermissionMode, deliver: (permissionManager: {
  setCapabilityPermissionLayers(layers: unknown[], generation: string, trusted: boolean, managed?: unknown): void
}, ws: string) => void): Promise<string> {
  return (await piRun(mode, deliver)).action
}

/** The Pi rig: the response the harness got, and what the host asked the permission service (`ask` = a card). */
async function piRun(mode: PermissionMode, deliver: (permissionManager: {
  setCapabilityPermissionLayers(layers: unknown[], generation: string, trusted: boolean, managed?: unknown): void
}, ws: string) => void): Promise<{ action: string; serviceSaw: string[] }> {
  const ws = workspace()
  const serviceSaw: string[] = []
  const agent = new PiAgent({
    provider: 'pi',
    workspace: { id: 'ws-f1813-pi', name: 'W', rootPath: ws, workspaceRootPath: ws, sessionRootPath: join(ROOT, 'sessions') } as never,
    session: { id: 'session-f1813-pi', workspaceRootPath: ws, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: ws } as never,
    model: 'pi/test-model', isHeadless: true, permissionServicePort: recordingService(serviceSaw), contextProfile: 'bare',
  } as BackendConfig)
  try {
    agent.setPermissionMode(mode)
    const state = agent as unknown as Record<string, any>
    const sent: Array<Record<string, unknown>> = []
    state.send = (message: Record<string, unknown>) => { sent.push(message) }
    state.emitAutomationEvent = async () => ({ matchedCount: 0 })
    const seed: PiExecutionManifestSeedV2 = {
      surfaceVersion: 2, snapshotGeneration: 'test-generation', sessionKey: { workspaceId: 'ws-f1813-pi', sessionId: 'session-f1813-pi' },
      provenance: [], mcpSources: [],
      orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
      staticTools: PI_TOOL_BINDINGS.flatMap(binding => {
        const modelContractHash = PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName]
        return modelContractHash ? [{ descriptor: getHarnessToolDescriptor(binding.descriptorId), binding, source: { kind: 'piBuiltin' as const, bindingId: binding.bindingName }, modelContractHash }] : []
      }),
    }
    const manifest = finalizePiExecutionManifest(seed, [])
    const tool = manifest.tools.find(candidate => candidate.binding.permissionName === 'Bash')!
    agent.setCapabilityTurnRuntime({ view: { generation: manifest.snapshotGeneration }, materializer: { assertActive() {} }, piExecutionManifestSeed: { snapshotGeneration: manifest.snapshotGeneration } } as unknown as CapabilityTurnRuntime)
    state.activeExecutionManifest = manifest
    deliver(state.permissionManager, ws)
    await state.handlePreToolUseRequest({
      requestId: 'r1', semanticId: tool.descriptor.id, piName: tool.binding.piName, surfaceVersion: manifest.surfaceVersion,
      manifestResponseEpoch: 0, manifestGeneration: manifest.snapshotGeneration, manifestHash: manifest.manifestHash,
      toolName: 'Bash', input: { command: COMMAND },
    })
    return { action: String(sent.filter(message => message.type === 'pre_tool_use_response').at(-1)?.action), serviceSaw }
  } finally {
    agent.destroy()
  }
}

describe('F1.813 — POSITIVE CONTROL: Pi refuses the same call under the same rules', () => {
  const layer = (ws: string, rule: unknown) => ({ content: JSON.stringify(dsl(rule)), scope: 'workspace', sourceRoot: ws })
  for (const mode of MODES) {
    test(`Pi — ${mode}`, async () => {
      expect(await piAction(mode, () => {})).not.toBe('block')
      expect(await piAction(mode, (pm, ws) => pm.setCapabilityPermissionLayers([layer(ws, STRUCTURAL_DENY)], 'test-generation', true))).toBe('block')
      expect(await piAction(mode, (pm, ws) => pm.setCapabilityPermissionLayers([layer(ws, CLAUDE_FORM_DENY)], 'test-generation', true))).toBe('block')
      expect(await piAction(mode, pm => pm.setCapabilityPermissionLayers([], 'test-generation', true, parsePermissionDslV1({ version: 1, rules: [STRUCTURAL_DENY] })))).toBe('block')
    })
  }
})

// ================================================================ F1.830 — the ASK half

const STRUCTURAL_ASK = { id: 'ask-rm-structural', action: 'ask', match: { kind: 'bash', executable: 'rm' } }
const CLAUDE_FORM_ASK = { id: 'ask-rm-claude-form', action: 'ask', match: { kind: 'bash', pattern: 'rm *' } }
const UNRELATED_ASK = { id: 'ask-git', action: 'ask', match: { kind: 'bash', executable: 'git' } }
const READ_ASK = { id: 'ask-read', action: 'ask', match: { kind: 'tool', semanticId: 'read' } }
const MANAGED_NATIVE_ASK = parseManagedPiPolicyV1({ schemaVersion: 1, permissionDsl: { version: 1, rules: [STRUCTURAL_ASK] } })
const MANAGED_CLAUDE_RULES_ASK = parseManagedPiPolicyV1({ schemaVersion: 1, claudeRules: { ask: ['Bash(rm *)'] } })
/** Every mode that can ask; `dontAsk` is the one that cannot, and has its own arm. */
const ASKING_MODES = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'] as const satisfies readonly PermissionMode[]

/** A `Read` of a real file inside the workspace: the one call every mode's gate lets through. */
function readCall(ws: string): { toolName: string; input: Record<string, unknown> } {
  const file = join(ws, 'a.txt')
  writeFileSync(file, 'x')
  return { toolName: 'Read', input: { file_path: file } }
}

describe('F1.830 — a readable ASK for rm is never auto-approved in bypassPermissions: the host raises a card naming the rule', () => {
  const askCases: Array<{ name: string; ruleId: string; scope: string; setup: () => Omit<Parameters<typeof claudeVerdict>[0], 'mode'> }> = [
    { name: 'workspace permissions.json, structural', ruleId: 'ask-rm-structural', scope: 'workspace scope', setup: () => ({ ws: workspace(dsl(STRUCTURAL_ASK)) }) },
    { name: 'workspace permissions.json, Claude-form Bash(rm *)', ruleId: 'ask-rm-claude-form', scope: 'workspace scope', setup: () => ({ ws: workspace(dsl(CLAUDE_FORM_ASK)) }) },
    { name: 'capability permission layer (the production turn path)', ruleId: 'ask-rm-structural', scope: 'workspace scope', setup: () => ({ ws: workspace(), layers: [{ content: JSON.stringify(dsl(STRUCTURAL_ASK)), scope: 'workspace' as const }] }) },
    { name: 'managed rule written directly in permissionDsl', ruleId: 'ask-rm-structural', scope: 'managed scope', setup: () => ({ ws: workspace(), policy: MANAGED_NATIVE_ASK }) },
  ]
  for (const c of askCases) {
    test(`${c.name} — bypassPermissions`, async () => {
      const verdict = await claudeVerdict({ mode: 'bypassPermissions', ...c.setup() })
      expect(verdict.decision).toBe('card')
      expect(verdict.card?.type).toBe('bash')
      expect(verdict.card?.description).toContain(`\`${c.ruleId}\``)
      expect(verdict.card?.description).toContain(c.scope)
      // A switch of mode does not remove an ask-rule prompt, so the card must not offer one.
      expect(verdict.card?.modePrompt).toBeUndefined()
      expect(verdict.afterCard).toBe('deny')
    })
  }

  test('an APPROVED ask card lets the call run, once — bypassPermissions', async () => {
    const verdict = await claudeVerdict({ mode: 'bypassPermissions', ws: workspace(dsl(STRUCTURAL_ASK)), answerCard: true })
    expect(verdict.decision).toBe('card')
    expect(verdict.afterCard).toBe('allow')
  })
})

describe('F1.830 — per mode, as the page says: a card wherever the mode can ask, a refusal in dontAsk', () => {
  for (const mode of ASKING_MODES) {
    test(`a readable ASK for Read — ${mode}: a card naming the rule`, async () => {
      const ws = workspace(dsl(READ_ASK))
      const verdict = await claudeVerdict({ mode, ws, call: readCall(ws) })
      expect(verdict.decision).toBe('card')
      expect(verdict.card?.description).toContain('`ask-read`')
      expect(verdict.card?.description).toContain('workspace scope')
      expect(verdict.card?.modePrompt).toBeUndefined()
    })
  }

  test('a readable ASK for Read — dontAsk: refused, naming the rule, because the mode never prompts', async () => {
    const ws = workspace(dsl(READ_ASK))
    const verdict = await claudeVerdict({ mode: 'dontAsk', ws, call: readCall(ws) })
    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toContain('`ask-read`')
    expect(verdict.reason).toContain('never prompts')
  })

  // Where the MODE already carded the call, the card stays — and stops claiming
  // that a mode switch would remove it (P6.863's `modePrompt`).
  for (const mode of ['default', 'auto'] as const) {
    test(`a readable ASK for rm where the mode already asks — ${mode}: the card carries no modePrompt`, async () => {
      const verdict = await claudeVerdict({ mode, ws: workspace(dsl(STRUCTURAL_ASK)) })
      expect(verdict.decision).toBe('card')
      expect(verdict.card?.modePrompt).toBeUndefined()
    })
  }
})

describe('F1.830 — CONTROLS on the same rig: what the ask half must not change', () => {
  test('no rule — bypassPermissions: rm still runs', async () => {
    expect((await claudeVerdict({ mode: 'bypassPermissions', ws: workspace() })).decision).toBe('allow')
  })
  test('an unrelated ask (git) — bypassPermissions: rm still runs', async () => {
    expect((await claudeVerdict({ mode: 'bypassPermissions', ws: workspace(dsl(UNRELATED_ASK)) })).decision).toBe('allow')
  })
  for (const mode of [...ASKING_MODES, 'dontAsk'] as const) {
    test(`no rule — ${mode}: Read still runs`, async () => {
      const ws = workspace()
      expect((await claudeVerdict({ mode, ws, call: readCall(ws) })).decision).toBe('allow')
    })
  }
  test('no rule — default: the mode\'s own card for rm still carries modePrompt', async () => {
    const verdict = await claudeVerdict({ mode: 'default', ws: workspace() })
    expect(verdict.decision).toBe('card')
    expect(verdict.card?.modePrompt).toBe(true)
  })
  for (const mode of ['default', 'bypassPermissions'] as const) {
    test(`a DENY and an ASK for the same call — ${mode}: the deny wins, no card (F1.813 unchanged)`, async () => {
      const verdict = await claudeVerdict({ mode, ws: workspace(dsl(STRUCTURAL_ASK, STRUCTURAL_DENY)) })
      expect(verdict.decision).toBe('deny')
      expect(verdict.reason).toContain('`deny-rm-structural`')
    })
  }
  // dontAsk's gate already refuses `rm` (not in the read-only allowlist), and
  // F1.813 keeps a gate block as it is — so the refusal stands and no card appears.
  test('a DENY and an ASK for the same call — dontAsk: still refused, no card', async () => {
    const verdict = await claudeVerdict({ mode: 'dontAsk', ws: workspace(dsl(STRUCTURAL_ASK, STRUCTURAL_DENY)) })
    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).not.toContain('`ask-rm-structural`')
  })
  test('an ALLOW rule for Read beside no ask — dontAsk: still the mode\'s own answer (allow is not honoured, nothing is refused)', async () => {
    const ws = workspace(dsl({ id: 'allow-read', action: 'allow', match: { kind: 'tool', semanticId: 'read' } }))
    expect((await claudeVerdict({ mode: 'dontAsk', ws, call: readCall(ws) })).decision).toBe('allow')
  })
  // The SDK route is untouched, and the two enforcers ask ONCE: the host card's
  // approval is the one the SDK's own ask-rule step reads (`gateApprovedToolUseIds`).
  test('managed claudeRules ask — bypassPermissions: still reaches the SDK, the host cards, and an approval is not asked twice', async () => {
    const verdict = await claudeVerdict({ mode: 'bypassPermissions', ws: workspace(), policy: MANAGED_CLAUDE_RULES_ASK, answerCard: true, askCanUseToolAfter: true })
    expect(verdict.sdkManagedAsk).toContain('Bash(rm *)')
    expect(verdict.decision).toBe('card')
    expect(verdict.card?.description).toContain('`Bash(rm *)` (managed scope)')
    expect(verdict.afterCard).toBe('allow')
    expect(verdict.canUseToolAfter).toBe('allow')
  })
})

describe('F1.830 — claudeReadablePermissionDeny\'s ask half, the seams the hook rig does not reach', () => {
  const judge = (ws: string, toolName: string, inputs: Array<Record<string, unknown>>) =>
    claudeReadablePermissionDeny({ toolName, inputs, cwd: ws, permissionsContext: { workspaceRootPath: ws }, managedPolicy: undefined })

  test('an ask under the REWRITTEN input asks, and a deny under either input still wins', () => {
    const ws = workspace(dsl(STRUCTURAL_ASK))
    expect(judge(ws, 'Bash', [{ command: 'rtk git status' }])).toBeUndefined()
    expect(judge(ws, 'Bash', [{ command: 'rtk git status' }, { command: COMMAND }])).toMatchObject({ kind: 'ask', ruleId: 'ask-rm-structural' })
    const both = workspace(dsl(STRUCTURAL_ASK, { id: 'deny-git', action: 'deny', match: { kind: 'bash', executable: 'rtk' } }))
    expect(judge(both, 'Bash', [{ command: COMMAND }, { command: 'rtk git status' }])).toMatchObject({ kind: 'deny', ruleId: 'deny-git' })
  })
})

describe('F1.830 — POSITIVE CONTROL: Pi raises the same ask', () => {
  const layer = (ws: string, rule: unknown) => ({ content: JSON.stringify(dsl(rule)), scope: 'workspace', sourceRoot: ws })
  test('Pi — bypassPermissions: no rule runs, a structural or managed ask for rm asks', async () => {
    expect((await piRun('bypassPermissions', () => {})).serviceSaw).toEqual(['allow'])
    expect((await piRun('bypassPermissions', (pm, ws) => pm.setCapabilityPermissionLayers([layer(ws, STRUCTURAL_ASK)], 'test-generation', true))).serviceSaw).toEqual(['ask'])
    expect((await piRun('bypassPermissions', pm => pm.setCapabilityPermissionLayers([], 'test-generation', true, parsePermissionDslV1({ version: 1, rules: [STRUCTURAL_ASK] })))).serviceSaw).toEqual(['ask'])
  })
})

// ================================================================ F1.860 — no remember window

/** The modes whose OWN gate cards `rm` (the prompt that used to carry the mode's remember window). */
const GATE_CARDING_MODES = ['default', 'auto', 'acceptEdits', 'plan'] as const satisfies readonly PermissionMode[]
const LS_ASK = { id: 'ask-ls', action: 'ask', match: { kind: 'bash', executable: 'ls' } }

describe('F1.860 — an ask-rule card carries no remember window and names the rule, in every mode (the failing arm)', () => {
  for (const mode of GATE_CARDING_MODES) {
    test(`a readable ASK for rm where the mode already asks — ${mode}: no commandHash, no rememberForMinutes, the rule named`, async () => {
      const verdict = await claudeVerdict({ mode, ws: workspace(dsl(STRUCTURAL_ASK)), answerAlwaysAllow: true })
      expect(verdict.decision).toBe('card')
      expect(verdict.card?.commandHash).toBeUndefined()
      expect(verdict.card?.rememberForMinutes).toBeUndefined()
      expect(verdict.card?.description).toBe('Bash requires approval by readable permission policy rule `ask-rm-structural` (workspace scope).')
      expect(verdict.card?.type).toBe('bash')
      expect(verdict.card?.modePrompt).toBeUndefined()
      // "Allow for this session" still runs the call it answered — once.
      expect(verdict.afterCard).toBe('allow')
    })
  }

  test('claudeReadablePermissionAskCheckResult — a mode prompt takes the host card\'s shape: type, command and rewrite kept, remember fields gone', () => {
    const ask = { kind: 'ask' as const, reason: 'r', named: 'rule `ask-rm` (workspace scope)', ruleId: 'ask-rm', scope: 'workspace' }
    const modePrompt = {
      type: 'prompt' as const, promptType: 'bash' as const, description: `Execute: ${COMMAND}`, command: COMMAND,
      modifiedInput: { command: `rtk ${COMMAND}` }, rememberForMinutes: 10, commandHash: 'h',
    }
    const asked = claudeReadablePermissionAskCheckResult(modePrompt, ask, { toolName: 'Bash', input: { command: COMMAND }, mode: 'default' })
    expect(asked).toEqual({
      type: 'prompt', promptType: 'bash', description: 'Bash requires approval by readable permission policy rule `ask-rm` (workspace scope).',
      command: COMMAND, modifiedInput: { command: `rtk ${COMMAND}` }, nonNegotiable: 'askRule', noAlwaysAllow: true, // F1.842
    })
  })
})

describe('F1.860 — CONTROLS: what the fix must not change', () => {
  test('claudeReadablePermissionAskCheckResult — a FLOOR prompt keeps its own card (no remember fields to drop, returned as is)', () => {
    const ask = { kind: 'ask' as const, reason: 'r', named: 'rule `ask-rm` (workspace scope)' }
    const floor = { type: 'prompt' as const, promptType: 'bash' as const, description: 'Removal targets your home directory', command: 'rm -rf ~', nonNegotiable: 'removalCircuitBreaker' as const }
    expect(claudeReadablePermissionAskCheckResult(floor, ask, { toolName: 'Bash', input: { command: 'rm -rf ~' }, mode: 'default' })).toBe(floor)
  })

  test('no rule — default: the mode\'s own card for rm keeps its session allow (commandHash + rememberForMinutes) and modePrompt', async () => {
    const verdict = await claudeVerdict({ mode: 'default', ws: workspace() })
    expect(verdict.decision).toBe('card')
    expect(typeof verdict.card?.commandHash).toBe('string')
    expect(verdict.card?.rememberForMinutes).toBe(10)
    expect(verdict.card?.modePrompt).toBe(true)
  })

  test('no rule — default: "Allow for this session" on ls keeps its session allow, the same ls runs with no card', async () => {
    const verdict = await claudeVerdict({ mode: 'default', ws: workspace(), call: { toolName: 'Bash', input: { command: 'ls -la' } }, answerAlwaysAllow: true, thenSameCallAgain: true })
    expect(verdict.decision).toBe('card')
    expect(verdict.again?.decision).toBe('allow')
  })

  // The host's own session whitelist does remember ls (the control above); an ask
  // rule is judged AFTER it, so the remembered click cannot clear the ask.
  for (const mode of ['default', 'bypassPermissions'] as const) {
    test(`a readable ASK for ls — ${mode}: "Allow for this session", then the same ls asks again, naming the rule`, async () => {
      const verdict = await claudeVerdict({ mode, ws: workspace(dsl(LS_ASK)), call: { toolName: 'Bash', input: { command: 'ls -la' } }, answerAlwaysAllow: true, thenSameCallAgain: true })
      expect(verdict.decision).toBe('card')
      expect(verdict.afterCard).toBe('allow')
      expect(verdict.again?.decision).toBe('card')
      expect(verdict.again?.card?.description).toContain('`ask-ls`')
      expect(verdict.again?.card?.commandHash).toBeUndefined()
      expect(verdict.again?.card?.rememberForMinutes).toBeUndefined()
    })
  }

  test('bypassPermissions — the ask-rule card is unchanged: the rule named, no remember window, and rm asks again', async () => {
    const verdict = await claudeVerdict({ mode: 'bypassPermissions', ws: workspace(dsl(STRUCTURAL_ASK)), answerAlwaysAllow: true, thenSameCallAgain: true })
    expect(verdict.card?.description).toBe('Bash requires approval by readable permission policy rule `ask-rm-structural` (workspace scope).')
    expect(verdict.card?.commandHash).toBeUndefined()
    expect(verdict.card?.rememberForMinutes).toBeUndefined()
    expect(verdict.again?.decision).toBe('card')
  })

  test('dontAsk — a readable ASK for Read is still refused, naming the rule', async () => {
    const ws = workspace(dsl(READ_ASK))
    const verdict = await claudeVerdict({ mode: 'dontAsk', ws, call: readCall(ws) })
    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toContain('`ask-read`')
  })

  test('default — a DENY beside the ASK still refuses with no card (F1.813)', async () => {
    const verdict = await claudeVerdict({ mode: 'default', ws: workspace(dsl(STRUCTURAL_ASK, STRUCTURAL_DENY)) })
    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toContain('`deny-rm-structural`')
  })
})

// ================================================================ F1.842 — no Always Allow on an ask-rule card

describe('F1.842 — an ask-rule card offers no Always Allow: the host sends noAlwaysAllow (the failing arm)', () => {
  // `default` reaches the mode-prompt branch (the mode already cards rm), bypass the
  // branch that turns a call the gate would run into a card; Read is a non-Bash card.
  for (const mode of ['default', 'bypassPermissions'] as const) {
    test(`a readable ASK for rm — ${mode}: the card carries noAlwaysAllow, and an Always answer still runs the call once and asks again`, async () => {
      const verdict = await claudeVerdict({ mode, ws: workspace(dsl(STRUCTURAL_ASK)), answerAlwaysAllow: true, thenSameCallAgain: true })
      expect(verdict.decision).toBe('card')
      expect(verdict.card?.noAlwaysAllow).toBe(true)
      expect(verdict.afterCard).toBe('allow')
      expect(verdict.again?.decision).toBe('card')
    })
  }
  test('a readable ASK for Read — default: the card carries noAlwaysAllow', async () => {
    const ws = workspace(dsl(READ_ASK))
    const verdict = await claudeVerdict({ mode: 'default', ws, call: readCall(ws) })
    expect(verdict.decision).toBe('card')
    expect(verdict.card?.noAlwaysAllow).toBe(true)
  })
})

describe('F1.842 — CONTROLS: the cards that keep their Always Allow', () => {
  test('no rule — default: the mode\'s own card for npm test sends no noAlwaysAllow (Always Allow still offered)', async () => {
    const verdict = await claudeVerdict({ mode: 'default', ws: workspace(), call: { toolName: 'Bash', input: { command: 'npm test' } } }) // UA12.70 — rm mints no key now
    expect(verdict.decision).toBe('card')
    expect(verdict.card?.modePrompt).toBe(true)
    expect(verdict.card?.noAlwaysAllow).toBeUndefined()
  })
  test('an unrelated ask (ls) — default: the mode\'s own card for npm test sends no noAlwaysAllow', async () => {
    const verdict = await claudeVerdict({ mode: 'default', ws: workspace(dsl(LS_ASK)), call: { toolName: 'Bash', input: { command: 'npm test' } } })
    expect(verdict.decision).toBe('card')
    expect(verdict.card?.noAlwaysAllow).toBeUndefined()
  })
  test('claudeReadablePermissionAskCheckResult — a FLOOR prompt under an ask keeps its own card, with no noAlwaysAllow added', () => {
    const ask = { kind: 'ask' as const, reason: 'r', named: 'rule `ask-rm` (workspace scope)' }
    const floor = { type: 'prompt' as const, promptType: 'bash' as const, description: 'Removal targets your home directory', command: 'rm -rf ~', nonNegotiable: 'removalCircuitBreaker' as const }
    const asked = claudeReadablePermissionAskCheckResult(floor, ask, { toolName: 'Bash', input: { command: 'rm -rf ~' }, mode: 'default' })
    expect(asked).toBe(floor)
    expect('noAlwaysAllow' in asked).toBe(false)
  })
})

// ================================================================ F1.921 — the subject the ask card approves

const WEBFETCH_ASK = { id: 'ask-webfetch', action: 'ask', match: { kind: 'tool', semanticId: 'WebFetch' } }

describe('F1.921 — the ask-rule card over a call the gate would run carries its subject (the failing arm)', () => {
  const ask = { kind: 'ask' as const, reason: 'r', named: 'rule `ask-home` (workspace scope)', ruleId: 'ask-home', scope: 'workspace' }
  const card = (toolName: string, input: Record<string, unknown>) =>
    claudeReadablePermissionAskCheckResult({ type: 'allow' }, ask, { toolName, input, mode: 'bypassPermissions' })

  test('Read — the path', () => {
    expect(card('Read', { file_path: '/Users/me/.ssh/id_rsa' })).toEqual({
      type: 'prompt', promptType: 'mcp_mutation', command: '/Users/me/.ssh/id_rsa',
      description: 'Read requires approval by readable permission policy rule `ask-home` (workspace scope).', nonNegotiable: 'askRule', noAlwaysAllow: true, // F1.842
    })
  })
  test('WebFetch — the URL', () => {
    expect(card('WebFetch', { url: 'https://evil.example/x?secret=1', prompt: 'p' })).toMatchObject({ command: 'https://evil.example/x?secret=1' })
  })
  test('Grep and Glob — the pattern and the path', () => {
    expect(card('Grep', { pattern: 'password', path: '/Users/me' })).toMatchObject({ command: 'pattern: password\npath: /Users/me' })
    expect(card('Glob', { pattern: '*.pem', path: '/Users/me' })).toMatchObject({ command: 'pattern: *.pem\npath: /Users/me' })
  })
  test('an MCP tool — a short summary of its arguments', () => {
    expect(card('mcp__linear__save_issue', { title: 'x', labels: ['a', 'b'] })).toMatchObject({ promptType: 'mcp_mutation', command: 'title: x\nlabels: ["a","b"]' })
  })
})

describe('F1.921 — CONTROLS: what the subject must not change', () => {
  const ask = { kind: 'ask' as const, reason: 'r', named: 'rule `ask-home` (workspace scope)', ruleId: 'ask-home', scope: 'workspace' }
  const card = (toolName: string, input: Record<string, unknown>, checkResult: Parameters<typeof claudeReadablePermissionAskCheckResult>[0] = { type: 'allow' }) =>
    claudeReadablePermissionAskCheckResult(checkResult, ask, { toolName, input, mode: 'bypassPermissions' })

  test('a Bash card and a file-write card are byte-identical to before (F1.842 adds only noAlwaysAllow)', () => {
    expect(card('Bash', { command: COMMAND })).toEqual({
      type: 'prompt', promptType: 'bash', command: COMMAND,
      description: 'Bash requires approval by readable permission policy rule `ask-home` (workspace scope).', nonNegotiable: 'askRule', noAlwaysAllow: true, // F1.842
    })
    expect(card('Write', { file_path: '/tmp/f1921.txt', content: 'x' })).toEqual({
      type: 'prompt', promptType: 'file_write', command: '/tmp/f1921.txt',
      description: 'Write requires approval by readable permission policy rule `ask-home` (workspace scope).', nonNegotiable: 'askRule', noAlwaysAllow: true, // F1.842
    })
  })
  test('a gate rewrite still travels as modifiedInput; the subject is the call as asked', () => {
    expect(card('Read', { file_path: '/a' }, { type: 'modify', input: { file_path: '/b' } })).toMatchObject({ command: '/a', modifiedInput: { file_path: '/b' } })
  })
  test('no argument to show — the tool name, as before; an over-long argument is cut, never dropped whole', () => {
    expect(card('mcp__linear__list_teams', {})).toMatchObject({ command: 'mcp__linear__list_teams' })
    const long = card('mcp__linear__save_issue', { body: 'y'.repeat(1_000) }) as { command: string }
    expect(long.command.startsWith(`body: ${'y'.repeat(100)}`)).toBe(true)
    expect(long.command.length).toBeLessThan(400)
    expect(long.command.endsWith('…')).toBe(true)
  })
  test('dontAsk still refuses naming the rule, and a gate block is kept (deny refusals unchanged)', () => {
    expect(claudeReadablePermissionAskCheckResult({ type: 'allow' }, ask, { toolName: 'Read', input: { file_path: '/a' }, mode: 'dontAsk' }))
      .toEqual({ type: 'block', reason: 'Tool blocked: Read requires approval by readable permission policy rule `ask-home` (workspace scope), and Don\'t ask mode never prompts.' })
    const block = { type: 'block' as const, reason: 'denied path' }
    expect(card('Read', { file_path: '/a' }, block)).toBe(block)
  })
})

describe('F1.921 — end to end through the real hook: the card the host raises names the subject', () => {
  test('Read — bypassPermissions: the card carries the path; the rule sentence is unchanged', async () => {
    const ws = workspace(dsl(READ_ASK))
    const call = readCall(ws)
    const verdict = await claudeVerdict({ mode: 'bypassPermissions', ws, call })
    expect(verdict.decision).toBe('card')
    expect(verdict.card?.command).toBe(call.input.file_path as string)
    expect(verdict.card?.description).toBe('Read requires approval by readable permission policy rule `ask-read` (workspace scope).')
    expect(verdict.card?.commandHash).toBeUndefined()
    expect(verdict.card?.rememberForMinutes).toBeUndefined()
  })
  test('WebFetch — bypassPermissions: the card carries the URL', async () => {
    const verdict = await claudeVerdict({ mode: 'bypassPermissions', ws: workspace(dsl(WEBFETCH_ASK)), call: { toolName: 'WebFetch', input: { url: 'https://evil.example/x?secret=1', prompt: 'p' } } })
    expect(verdict.decision).toBe('card')
    expect(verdict.card?.command).toBe('https://evil.example/x?secret=1')
  })
  // The card's `command` feeds `ClaudeAgent.respondToPermission`'s session
  // whitelist, whose fallback key is `getBaseCommand(command)` — a Bash key. So a
  // path on the card must not become a stored key: "Allow for this session" on a
  // READ would otherwise grant EXECUTING that path in Bash for the session.
  test('Read — "Allow for this session": no whitelist key is minted from the path, and the same Read asks again', async () => {
    const ws = workspace(dsl(READ_ASK))
    const call = readCall(ws)
    const verdict = await claudeVerdict({ mode: 'default', ws, call, answerAlwaysAllow: true, thenSameCallAgain: true, probeWhitelist: [call.input.file_path as string, 'Read'] })
    expect(verdict.decision).toBe('card')
    expect(verdict.afterCard).toBe('allow')
    expect(verdict.whitelisted).toEqual({ [call.input.file_path as string]: false, Read: false })
    expect(verdict.again?.decision).toBe('card')
  })
  test('CONTROL — a Bash ask card keeps its command and its session whitelist key (unchanged)', async () => {
    const verdict = await claudeVerdict({ mode: 'bypassPermissions', ws: workspace(dsl(LS_ASK)), call: { toolName: 'Bash', input: { command: 'ls -la' } }, answerAlwaysAllow: true, probeWhitelist: ['exact:["ls","-la"]', 'ls'] })
    expect(verdict.card?.command).toBe('ls -la')
    expect(verdict.card?.type).toBe('bash')
    // UA12.70 — `bashSessionWhitelistKey` keys `ls -la` by its exact argv (upstream v0.14.0), never `ls`.
    expect(verdict.whitelisted).toEqual({ 'exact:["ls","-la"]': true, ls: false })
  })
})

// ================================================================ F1.923 — a large image under a readable rule

/** A workspace with `scans/` holding a large image, a small one and a text file, and `rule` (if any) over `scans/`. */
function scansWorkspace(action?: 'deny' | 'ask'): { ws: string; large: string; small: string; text: string } {
  const ws = workspace()
  const scans = join(ws, 'scans')
  mkdirSync(scans)
  const large = join(scans, 'passport.jpg')
  writeFileSync(large, Buffer.alloc(IMAGE_LIMITS.MAX_RAW_SIZE + 1_024))
  const small = join(scans, 'small.jpg')
  writeFileSync(small, Buffer.alloc(64))
  const text = join(scans, 'notes.txt')
  writeFileSync(text, 'x')
  if (action) writeFileSync(join(ws, 'permissions.json'), JSON.stringify(dsl({ id: `${action}-scans`, action, match: { kind: 'path', root: scans } })))
  return { ws, large, small, text }
}

/** The host's resizer, as `SessionManager` wires it: it writes a copy under the session's tmp and returns it. */
function resizer(): { resize: (filePath: string, maxSize: number) => Promise<string | undefined>; calls: string[] } {
  const calls: string[] = []
  const dir = join(ROOT, `resized-${sessionCounter + 1}-${Math.random().toString(36).slice(2)}`)
  return {
    calls,
    resize: async filePath => {
      calls.push(filePath)
      mkdirSync(dir, { recursive: true })
      const copy = join(dir, `resized-${calls.length}.jpg`)
      writeFileSync(copy, Buffer.alloc(32))
      return copy
    },
  }
}

describe('F1.923 — a readable rule over a directory binds a Read of a LARGE image in it (the failing arm)', () => {
  for (const mode of MODES) {
    test(`deny — ${mode}: refused naming the rule, and no resized copy of the denied image is made`, async () => {
      const { ws, large } = scansWorkspace('deny')
      const r = resizer()
      const verdict = await claudeVerdict({ mode, ws, call: { toolName: 'Read', input: { file_path: large } }, onImageResize: r.resize })
      expect(verdict.decision).toBe('deny')
      expect(verdict.reason).toContain('`deny-scans`')
      expect(r.calls).toEqual([])
    })
  }
  test('ask — bypassPermissions: a card naming the rule and the ORIGINAL path; approved, the call still reads the resized copy', async () => {
    const { ws, large } = scansWorkspace('ask')
    const r = resizer()
    const verdict = await claudeVerdict({ mode: 'bypassPermissions', ws, call: { toolName: 'Read', input: { file_path: large } }, onImageResize: r.resize, answerCard: true })
    expect(verdict.decision).toBe('card')
    expect(verdict.card?.description).toContain('`ask-scans`')
    expect(verdict.card?.command).toBe(large)
    expect(verdict.afterCard).toBe('allow')
    expect(r.calls).toEqual([large])
    expect(String(verdict.updatedInput?.file_path)).toContain('resized-1.jpg')
  })
})

describe('F1.923 — CONTROLS: a small image, a text file and an allowed large image', () => {
  for (const which of ['small', 'text'] as const) {
    test(`deny — bypassPermissions: the ${which} file under the rule is refused, as before`, async () => {
      const files = scansWorkspace('deny')
      const r = resizer()
      const verdict = await claudeVerdict({ mode: 'bypassPermissions', ws: files.ws, call: { toolName: 'Read', input: { file_path: files[which] } }, onImageResize: r.resize })
      expect(verdict.decision).toBe('deny')
      expect(verdict.reason).toContain('`deny-scans`')
      expect(r.calls).toEqual([])
    })
  }
  test('no rule — bypassPermissions: the large image is resized and the call reads the copy', async () => {
    const { ws, large } = scansWorkspace()
    const r = resizer()
    const verdict = await claudeVerdict({ mode: 'bypassPermissions', ws, call: { toolName: 'Read', input: { file_path: large } }, onImageResize: r.resize })
    expect(verdict.decision).toBe('allow')
    expect(r.calls).toEqual([large])
    expect(String(verdict.updatedInput?.file_path)).toContain('resized-1.jpg')
  })
  test('an unrelated deny (git) — default: the large image is still resized and read', async () => {
    const { ws, large } = scansWorkspace()
    writeFileSync(join(ws, 'permissions.json'), JSON.stringify(dsl(UNRELATED_DENY)))
    const r = resizer()
    const verdict = await claudeVerdict({ mode: 'default', ws, call: { toolName: 'Read', input: { file_path: large } }, onImageResize: r.resize })
    expect(verdict.decision).toBe('allow')
    expect(r.calls).toEqual([large])
  })
})

// ================================================================ F1.935 — an ask rule's large image is copied only once its card is approved

describe('F1.935 — a large image under a readable ASK leaves no resized copy when the read is refused (the failing arm)', () => {
  for (const mode of MODES) {
    test(`ask — ${mode}: the card names the ORIGINAL path; refused, no resized copy of the image was ever made`, async () => {
      const { ws, large } = scansWorkspace('ask')
      const r = resizer()
      const verdict = await claudeVerdict({ mode, ws, call: { toolName: 'Read', input: { file_path: large } }, onImageResize: r.resize })
      expect(verdict.decision).toBe('card')
      expect(verdict.card?.command).toBe(large)
      expect(verdict.afterCard).toBe('deny')
      expect(r.calls).toEqual([])
    })
  }
  test('ask — dontAsk: refused naming the rule, and no resized copy is made', async () => {
    const { ws, large } = scansWorkspace('ask')
    const r = resizer()
    const verdict = await claudeVerdict({ mode: 'dontAsk', ws, call: { toolName: 'Read', input: { file_path: large } }, onImageResize: r.resize })
    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).toContain('`ask-scans`')
    expect(r.calls).toEqual([])
  })
})

describe('F1.935 — CONTROLS: the approved read still gets its copy, and a failed resize still refuses', () => {
  test('ask — default: approved, the image is resized only then and the call reads the copy', async () => {
    const { ws, large } = scansWorkspace('ask')
    const r = resizer()
    const verdict = await claudeVerdict({ mode: 'default', ws, call: { toolName: 'Read', input: { file_path: large } }, onImageResize: r.resize, answerCard: true })
    expect(verdict.decision).toBe('card')
    expect(verdict.afterCard).toBe('allow')
    expect(r.calls).toEqual([large])
    expect(String(verdict.updatedInput?.file_path)).toContain('resized-1.jpg')
  })
  test('ask — bypassPermissions: approved, but the resizer gives no copy → refused as too large, never the original handed to the SDK', async () => {
    const { ws, large } = scansWorkspace('ask')
    const calls: string[] = []
    const verdict = await claudeVerdict({ mode: 'bypassPermissions', ws, call: { toolName: 'Read', input: { file_path: large } }, onImageResize: async filePath => { calls.push(filePath); return undefined }, answerCard: true })
    expect(verdict.decision).toBe('card')
    expect(verdict.afterCard).toBe('deny')
    expect(calls).toEqual([large])
    expect(verdict.updatedInput).toBeUndefined()
  })
})

// ================================================================ F1.843 — an ask rule on AskUserQuestion: the question is the one dialog

const AUQ_CALL = { toolName: 'AskUserQuestion', input: { questions: [{ question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red', description: 'r' }, { label: 'Blue', description: 'b' }] }] } as Record<string, unknown> }

/**
 * F1.843 — every dialog one call puts in front of the user, end to end: the REAL
 * PreToolUse hook, then (unless it refused) the REAL `canUseTool` the SDK calls
 * next, which is where the question itself is asked. A host card is refused, the
 * question is answered 'Red'.
 */
async function claudeDialogs(mode: PermissionMode, ws: string, call = AUQ_CALL): Promise<{ hook: string | undefined; reason: string; dialogs: string[]; canUseTool?: string }> {
  capturedOptions = undefined
  sessionCounter += 1
  const agent = new ClaudeAgent({
    provider: 'anthropic', providerType: 'anthropic', model: 'claude-sonnet-4-6', isHeadless: true, skipConfigWatcher: true,
    workspace: { id: `ws-f1843-${sessionCounter}`, name: 'F1843', rootPath: ws, workspaceRootPath: ws, sessionRootPath: join(ROOT, 'sessions') } as never,
    session: { id: `session-f1843-${sessionCounter}`, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: ws, permissionMode: mode } as never,
  } as BackendConfig)
  try {
    agent.setPermissionMode(mode)
    const dialogs: string[] = []
    agent.onPermissionRequest = request => {
      dialogs.push(request.type ?? 'untyped')
      setTimeout(() => request.type === 'ask_user'
        ? agent.respondToPermission(request.requestId, true, false, { askUserAnswer: { type: 'option', value: 'Red', optionIndex: 0 } })
        : agent.respondToPermission(request.requestId, false), 0)
    }
    const chatImpl = (agent as unknown as { chatImpl(message: string): AsyncGenerator<unknown> }).chatImpl.bind(agent)
    for await (const _ of chatImpl('go')) { /* drain the one turn */ }
    const seen = capturedOptions as Record<string, unknown> | undefined
    const hook = (seen?.hooks as { PreToolUse?: Array<{ hooks: HookFn[] }> } | undefined)?.PreToolUse?.[0]?.hooks?.[0]
    if (!hook) throw new Error('the turn registered no PreToolUse hook')
    const out = (await hook(
      { hook_event_name: 'PreToolUse', tool_name: call.toolName, tool_use_id: 'toolu_f1843', tool_input: call.input, session_id: 'sdk-f1843', transcript_path: join(ROOT, 't.jsonl'), cwd: ws },
      'toolu_f1843',
      { signal: new AbortController().signal },
    ) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } })?.hookSpecificOutput
    const verdict = { hook: out?.permissionDecision, reason: String(out?.permissionDecisionReason ?? ''), dialogs }
    if (out?.permissionDecision === 'deny') return verdict
    const canUseTool = seen?.canUseTool as (name: string, input: unknown, opts: unknown) => Promise<{ behavior?: string }>
    const behavior = await canUseTool(call.toolName, call.input, { signal: new AbortController().signal, toolUseID: 'toolu_f1843', suggestions: [] })
    return { ...verdict, canUseTool: behavior.behavior }
  } finally {
    agent.destroy()
  }
}

describe('F1.843 — an ask rule on AskUserQuestion adds no approval card on claude: the question is the one dialog', () => {
  const askRules: Array<[string, () => string]> = [
    ['a readable ask (workspace permissionDsl)', () => workspace(dsl({ id: 'ask-auq', action: 'ask', match: { kind: 'tool', semanticId: 'AskUserQuestion' } }))],
    ['the gate\'s own ask (workspace toolRules)', () => workspace({ toolRules: [{ pattern: 'AskUserQuestion', action: 'ask' }] })],
  ]
  for (const [name, ws] of askRules) {
    for (const mode of ['default', 'bypassPermissions'] as const) {
      test(`${name} — ${mode}: no host card, the question is asked once and answered`, async () => {
        const verdict = await claudeDialogs(mode, ws())
        expect(verdict.dialogs).toEqual(['ask_user'])
        expect(verdict.canUseTool).toBe('allow')
      })
    }
  }
})

describe('F1.843 — CONTROLS: a deny still refuses, and the same rig does see a host card', () => {
  for (const mode of ['default', 'bypassPermissions'] as const) {
    test(`a readable DENY on AskUserQuestion — ${mode}: refused naming the rule, no question asked`, async () => {
      const verdict = await claudeDialogs(mode, workspace(dsl({ id: 'deny-auq', action: 'deny', match: { kind: 'tool', semanticId: 'AskUserQuestion' } })))
      expect(verdict.hook).toBe('deny')
      expect(verdict.reason).toContain('`deny-auq`')
      expect(verdict.dialogs).toEqual([])
    })
  }
  test('a readable ASK on Read — bypassPermissions: the host card is raised (the instrument sees cards)', async () => {
    const ws = workspace(dsl(READ_ASK))
    const verdict = await claudeDialogs('bypassPermissions', ws, readCall(ws))
    expect(verdict.dialogs).toEqual(['mcp_mutation'])
    expect(verdict.hook).toBe('deny')
  })
})

// ================================================================ F1.833 — a rule under Pi's id binds the claude built-in of another name

describe('F1.833 — a native rule written with Pi\'s id binds a claude built-in whose Pi counterpart has another name', () => {
  const judge = (ws: string, toolName: string, input: Record<string, unknown>) =>
    claudeReadablePermissionDeny({ toolName, inputs: [input], cwd: ws, permissionsContext: { workspaceRootPath: ws }, managedPolicy: undefined })
  const toolRule = (id: string, action: 'deny' | 'ask', semanticId: string) => ({ id, action, match: { kind: 'tool', semanticId } })

  test('Glob is Pi\'s find: a deny under find or Find refuses it', () => {
    for (const semanticId of ['find', 'Find']) {
      const ws = workspace(dsl(toolRule('deny-find', 'deny', semanticId)))
      expect(judge(ws, 'Glob', { pattern: '**/*.ts', path: ws }), semanticId).toMatchObject({ kind: 'deny', ruleId: 'deny-find' })
    }
  })

  test('Agent, and its old name Task, is Pi\'s subagent: a deny refuses both, an ask asks', () => {
    const ws = workspace(dsl(toolRule('deny-subagent', 'deny', 'subagent')))
    for (const toolName of ['Agent', 'Task']) {
      expect(judge(ws, toolName, { description: 'x', prompt: 'y', subagent_type: 'general-purpose' }), toolName).toMatchObject({ kind: 'deny', ruleId: 'deny-subagent' })
    }
    const asking = workspace(dsl(toolRule('ask-subagent', 'ask', 'subagent')))
    expect(judge(asking, 'Agent', { description: 'x', prompt: 'y' })).toMatchObject({ kind: 'ask', ruleId: 'ask-subagent' })
  })

  test('CONTROL: a rule under the claude id still binds, and a Pi id binds nothing else', () => {
    const byClaudeId = workspace(dsl(toolRule('deny-glob', 'deny', 'Glob'), toolRule('deny-agent', 'deny', 'Agent')))
    expect(judge(byClaudeId, 'Glob', { pattern: '*' })).toMatchObject({ kind: 'deny', ruleId: 'deny-glob' })
    expect(judge(byClaudeId, 'Agent', { prompt: 'y' })).toMatchObject({ kind: 'deny', ruleId: 'deny-agent' })
    const byPiId = workspace(dsl(toolRule('deny-find', 'deny', 'find'), toolRule('deny-subagent', 'deny', 'subagent')))
    expect(judge(byPiId, 'Grep', { pattern: 'x', path: byPiId })).toBeUndefined()
    expect(judge(byPiId, 'Read', { file_path: join(byPiId, 'a.txt') })).toBeUndefined()
    expect(judge(byPiId, 'TaskCreate', { subject: 's', description: 'd' })).toBeUndefined()
  })

  test('BOUNDARY: claude\'s Task is the subagent, never Pi\'s session task-graph tool of the same name', () => {
    // Pi's session `Task` (descriptor `task`) is `visibility: 'pi-only'`, so claude never receives it;
    // the bare `Task` claude reports is its subagent tool (PI_RUNTIME_AGENT_TOOL_ALIASES `task: ['subagent']`).
    expect([PI_RUNTIME_AGENT_TOOL_ALIASES.glob, PI_RUNTIME_AGENT_TOOL_ALIASES.agent, PI_RUNTIME_AGENT_TOOL_ALIASES.task]).toEqual([['find'], ['subagent'], ['subagent']])
    const ws = workspace(dsl(toolRule('deny-task-graph', 'deny', 'task')))
    expect(judge(ws, 'Task', { prompt: 'y' })).toBeUndefined()
    expect(judge(ws, 'Agent', { prompt: 'y' })).toBeUndefined()
  })
})

// ================================================================ F1.1083 — AskUserQuestion under both vocabularies
// Origin DN-031. Measured before the fix: a managed `claudeRules` entry naming `AskUserQuestion` was STRIPPED as
// `claude_rule.unknown_tool` (the parser's known names held Pi's `ask_user` only), and a native rule under Pi's
// `ask_user` did not bind claude's `AskUserQuestion` (no counterpart pair, F1.833's seam).
describe('F1.1083 — AskUserQuestion is Pi\'s ask_user, in a managed claudeRules entry and in a native rule', () => {
  const judge = (ws: string) =>
    claudeReadablePermissionDeny({ toolName: 'AskUserQuestion', inputs: [{ questions: [] }], cwd: ws, permissionsContext: { workspaceRootPath: ws }, managedPolicy: undefined })
  const toolRule = (id: string, action: 'deny' | 'ask', semanticId: string) => ({ id, action, match: { kind: 'tool', semanticId } })

  test('a native rule under ask_user binds claude\'s AskUserQuestion: a deny refuses, an ask asks', () => {
    expect(judge(workspace(dsl(toolRule('deny-ask-user', 'deny', 'ask_user'))))).toMatchObject({ kind: 'deny', ruleId: 'deny-ask-user' })
    expect(judge(workspace(dsl(toolRule('ask-ask-user', 'ask', 'ask_user'))))).toMatchObject({ kind: 'ask', ruleId: 'ask-ask-user' })
  })

  test('a managed claudeRules entry naming AskUserQuestion (or another Claude name Pi binds since F1.1111) is accepted, not refused as an unknown tool', () => {
    expect(parseManagedPiPolicyV1({ schemaVersion: 1, claudeRules: { deny: ['AskUserQuestion'] } })?.claudeRules).toEqual({ deny: ['AskUserQuestion'] })
    expect(parseManagedPiPolicyV1({ schemaVersion: 1, claudeRules: { ask: ['Glob'] } })?.claudeRules).toEqual({ ask: ['Glob'] })
  })

  test('CONTROL: a typo is still refused (the strict parse throws), and a rule under the claude name still binds', () => {
    expect(() => parseManagedPiPolicyV1({ schemaVersion: 1, claudeRules: { deny: ['AskUserQuestions'] } })).toThrow('claude_rule.unknown_tool')
    expect(judge(workspace(dsl(toolRule('deny-auq', 'deny', 'AskUserQuestion'))))).toMatchObject({ kind: 'deny', ruleId: 'deny-auq' })
  })
})
