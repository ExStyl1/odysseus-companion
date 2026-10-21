/**
 * Ultracode — the ONE host resolver behind the composer's per-session toggle.
 *
 * Owner answer QK5 (2026-09-11, `docs/superpowers/specs/2026-09-11-coverage-95-owner-answers.md`
 * §"Owner answers — 2026-09-11"): *"ultracode is a mode the user can switch on
 * and off: the vendored key on claude through `Options.settings` plus a
 * per-session toggle beside the effort control; Pi's plugin/keyword path stays;
 * refusing is not allowed; codex records honestly that the runtime has no such
 * mode and the toggle says so there."*
 *
 * ## What ultracode IS, in the vendor's own words
 *
 * `workflows.md#let-claude-decide-with-ultracode` — *"Ultracode is a Claude Code
 * setting that combines `xhigh` reasoning effort with automatic workflow
 * orchestration. With it on, Claude plans a workflow for each substantive task
 * instead of waiting for you to ask."* It is deliberately NOT a seventh effort
 * level: `model-config.md#adjust-effort-level` says *"Ultracode is a Claude Code
 * setting rather than a model effort level"*, and this fork's three recorded
 * max-effort decisions (`automations/types.ts`, `pi-agent-server`'s
 * `spawner.ts`, `thinking-levels.ts` with the loud
 * `environmentThinkingOverrideRejection`) stay true because nothing here
 * adds one.
 *
 * ## The four routes the page lists, and which one a host can take
 *
 * `model-config.md#adjust-effort-level` — *"You can turn on ultracode through
 * any of the following"*: `/effort ultracode`; `claude --effort ultracode`; the
 * **`ultracode` setting** — *"set `"ultracode": true` in a settings file, with
 * `--settings`, or in an Agent SDK control request"*; and the `/model` picker's
 * effort slider. Three of the four are interactive terminal affordances that an
 * SDK integration does not have. The fourth is ours, and we are already on the
 * seam it names: `Options.settings`.
 *
 * ## Why the FLAG tier and not the managed tier — measured, not chosen
 *
 * Measured 2026-09-11 on the vendored `0.3.247` bundle. The native binary
 * carries `ultracode` **156** times against this repo's standing control
 * `nessyNotARealSdkKey` → **0**, so the key is real on this runtime. The SDK's
 * restrictive managed-settings filter is a table of `{path:[…],restrictive:…}`
 * entries in `sdk.mjs`; extracted whole it holds **40** keys —
 * `autoContinueAtUsageLimit`, `skipWebFetchPreflight`, `enableWorkflows`,
 * `disableWorkflows` and `fastModePerSessionOptIn` among them — and `ultracode`
 * is **not one of them**. Its only three occurrences in `sdk.mjs` are the
 * settings Zod schema. So a managed projection would have been a SILENT DROP,
 * the P6.688 shape; `Options.settings` applies unconditionally, which is why
 * P3.147's credential floor and P3.94's `autoMode` block already live there.
 *
 * ## The three availability conditions, and the one we have no input for
 *
 * `model-config.md#when-ultracode-is-available` — *"Ultracode is unavailable
 * when: Workflows are turned off; The model doesn't support `xhigh` effort; An
 * effort cap below `xhigh` applies to the model"*. The first two are resolved
 * here. The third has NO host input to resolve: `maxEffortLevel` occurs in zero
 * source files of this repo (measured 2026-09-11 over `packages` and `apps`), so
 * this fork sets no cap and cannot consult one. Recorded as a null rather than
 * invented — and it is the safe direction, because the runtime applies its own
 * cap regardless of what we send: `settings-reference.md#ultracode` says
 * *"`ultracode: true` runs the session at `xhigh` effort, or at the cap when an
 * effort cap is lower"*.
 *
 * ## Three runtimes, three honest answers — the seam, not three mechanisms
 *
 * Native-first with the host as the seam (AGENTS.md §Native-first): the host
 * resolves ONE per-session boolean and each runtime meets it through the
 * mechanism it already has.
 *
 * - **claude** — the vendored `ultracode` settings key. Configuration; nothing
 *   is built beside it.
 * - **Pi** — the workflow keyword path that already exists
 *   (`WORKFLOW_TRIGGER_KEYWORD` is the literal `'ultracode'`). The toggle
 *   makes the turn take that path without the user typing the word; the typed
 *   keyword keeps working unchanged. A SECOND mechanism beside it is exactly
 *   what the owner's instruction refuses.
 * - **codex** — no such mode. The control says so, and NOTHING is written: a
 *   config key the runtime ignores is the `SILENT-LOOSER` shape P6.214 measured,
 *   and the ledger names visible degradation as the pattern to copy.
 *
 * That residual difference is DECLARED rather than smoothed: on claude the
 * runtime plans workflows by itself for every substantive task, on Pi the host
 * opts each turn into the orchestration directive, and on codex the capability
 * is absent. Making the three identical would mean building the missing two
 * thirds by hand, which is the opposite of native-first.
 */

import type { AgentProvider } from './backend/types.ts'
import { clampThinkingLevelToModel } from './thinking-levels.ts'
import { WORKFLOW_KEYWORD_DISPATCH_RUNTIMES } from '../workflows/workflow-keyword.ts'

/** How a runtime reaches ultracode, or that it cannot. */
export type UltracodeMechanism = 'native-setting' | 'workflow-keyword' | 'unsupported'

/**
 * Which runtimes carry the vendor's own `ultracode` settings key.
 *
 * TOTAL over the runtime vocabulary (P2.124): `Record`, not `Partial<Record>`,
 * so a runtime added to {@link AgentProvider} breaks the build here instead of
 * inheriting a silent `false`.
 *
 * Only the anthropic backend spawns the vendored Claude Code child, so only it
 * can be handed a key that child reads. A `claude-runtime` BYO connection is
 * still the anthropic backend — the key rides `Options.settings` into the same
 * child whichever endpoint the loopback adapter is pointed at.
 */
export const ULTRACODE_NATIVE_SETTING_RUNTIMES: Readonly<Record<AgentProvider, boolean>> = Object.freeze({
  anthropic: true,
  pi: false,
  'codex-runtime': false,
  'nestor-cloud-agent': false,
})

/**
 * The mechanism this runtime has, DERIVED rather than restated.
 *
 * The keyword arm reads {@link WORKFLOW_KEYWORD_DISPATCH_RUNTIMES} — the table
 * that already decides which runtimes can act on the workflow directive at all —
 * so a second table cannot drift away from the first. P2.315 is the measurement
 * behind that table: without it the directive reached a runtime with no
 * `workflow` tool and read as prose, which is the same defect this function
 * would re-open by hard-coding `pi`.
 */
export function ultracodeMechanism(provider: AgentProvider): UltracodeMechanism {
  if (ULTRACODE_NATIVE_SETTING_RUNTIMES[provider]) return 'native-setting'
  if (WORKFLOW_KEYWORD_DISPATCH_RUNTIMES[provider] === true) return 'workflow-keyword'
  return 'unsupported'
}

/**
 * Why ultracode is not on offer.
 *
 * - `runtime` — this runtime has no ultracode mode at all (codex, the remote
 *   agent). Turning workflows on would not change it.
 * - `workflows-off` — `model-config.md#when-ultracode-is-available`'s first
 *   condition, and the one that holds on BOTH live arms: the SDK requires
 *   workflows enabled, and `disableWorkflows` also forces the host's keyword
 *   trigger off.
 * - `model` — `model-config.md#when-ultracode-is-available`'s second condition,
 *   the active model cannot run `xhigh`.
 */
export type UltracodeUnavailableReason = 'runtime' | 'workflows-off' | 'model'

export type UltracodeAvailability =
  | { readonly available: true; readonly mechanism: 'native-setting' | 'workflow-keyword' }
  | { readonly available: false; readonly reason: UltracodeUnavailableReason }

/**
 * Can this session turn ultracode on, and if not, why not.
 *
 * The reasons are ordered most-structural first and that order is load-bearing
 * for the copy: a codex session must read *"this runtime has no ultracode
 * mode"*, never *"turn workflows on"* — the second sentence would send the user
 * to a switch that changes nothing there.
 *
 * The `model` condition is asked of the NATIVE arm only. On the keyword arm what
 * the toggle buys is the orchestration half — the directive naming the
 * `workflow` tool — and this fork deliberately has no `ultracode` EFFORT level
 * to raise, so gating Pi on `xhigh` would refuse a capability the runtime
 * actually has. An absent `model` is treated as capable for the same reason
 * `clampThinkingLevelToModel` treats an unlisted model as capable: an unknown
 * model is not a narrow one.
 */
export function resolveUltracodeAvailability(input: {
  readonly provider: AgentProvider
  readonly workflowsDisabled: boolean
  readonly model?: string | undefined
}): UltracodeAvailability {
  return ultracodeVerdict({
    mechanism: ultracodeMechanism(input.provider),
    workflowsDisabled: input.workflowsDisabled,
    modelCapable: modelSupportsUltracodeEffort(input.model),
  })
}

/**
 * The SAME verdict for a surface that was handed the two facts instead of the
 * inputs they were derived from — the composer, which reads
 * `ComposerCapabilities.ultracode`.
 *
 * ONE rule, two entrances, and that shape is deliberate: the renderer cannot
 * resolve the workflow settings (three layers, server-side), so it would
 * otherwise have re-spelled the mechanism-then-model ordering and the reason
 * names in TSX, where nothing would ever compare the two copies. The
 * `workflows-off` term is simply absent on this entrance and the host says that
 * sentence itself, once, when the toggle is switched on.
 */
export function ultracodeControlAvailability(capability: {
  readonly mechanism: UltracodeMechanism
  readonly modelCapable: boolean
}): UltracodeAvailability {
  return ultracodeVerdict({ ...capability, workflowsDisabled: false })
}

/**
 * The rule itself, in the ONE order that makes the copy honest: most-structural
 * first. A codex session must read *"this runtime has no ultracode mode"*, never
 * *"turn workflows on"*.
 */
function ultracodeVerdict(input: {
  readonly mechanism: UltracodeMechanism
  readonly workflowsDisabled: boolean
  readonly modelCapable: boolean
}): UltracodeAvailability {
  if (input.mechanism === 'unsupported') return { available: false, reason: 'runtime' }
  if (input.workflowsDisabled) return { available: false, reason: 'workflows-off' }
  if (input.mechanism === 'native-setting' && !input.modelCapable) {
    return { available: false, reason: 'model' }
  }
  return { available: true, mechanism: input.mechanism }
}

/**
 * `model-config.md#when-ultracode-is-available` — *"The model doesn't support
 * `xhigh` effort"*.
 *
 * Asked of {@link clampThinkingLevelToModel}, which is this repo's single
 * reading of the page's per-model table, rather than of a second list: a model
 * the clamp narrows away from `xhigh` is precisely a model that "doesn't support
 * `xhigh` effort".
 */
export function modelSupportsUltracodeEffort(model: string | undefined): boolean {
  if (model === undefined || model.length === 0) return true
  return clampThinkingLevelToModel('xhigh', model) === 'xhigh'
}

/**
 * The claude arm: the vendored key, or nothing at all.
 *
 * ONLY an explicit ON travels, and the reason is the one
 * `buildClaudeSwitchModelsOnFlagSettings` records for its own key: an install
 * that never touched the toggle must spawn byte-identically to one built before
 * this row. `settings-reference.md#ultracode` gives the unset default —
 * *"Default: unset, so ultracode is off"* — so emitting `false` would be a
 * change dressed as a no-op, and it would also overwrite a `ultracode: true` the
 * user put in their own settings file, which is a control this host never asked
 * to own.
 *
 * ## Which half of the availability question this one asks
 *
 * The WORKFLOWS half is the host's and is already spent by the time this runs:
 * `ChatOptions.ultracode` is set at exactly one place —
 * `SessionManager.sendMessage` — and only where
 * {@link resolveUltracodeAvailability} said yes, because that is the only layer
 * that holds the resolved three-layer workflow settings. Re-reading them here
 * would be a SECOND reader of those layers, which is the drift this repo has
 * already paid for elsewhere.
 *
 * The MODEL half IS re-asked, because the agent holds the authoritative answer:
 * `this._model` can move mid-session (`setModel`) after the host formed its
 * verdict, and the re-ask costs one table lookup. A request that cannot bind
 * produces nothing rather than a key the child will discard.
 */
export function buildClaudeUltracodeSettings(input: {
  readonly requested: boolean
  readonly model?: string | undefined
}): { ultracode?: true } {
  if (!input.requested) return {}
  if (!modelSupportsUltracodeEffort(input.model)) return {}
  return { ultracode: true as const }
}

/**
 * The Pi arm: does THIS turn take the workflow keyword path because the toggle
 * is on, rather than because the user typed the word.
 *
 * Deliberately a sibling of `detectWorkflowKeywordTrigger` and not a fourth gate
 * inside it. The two opt-ins are different in kind and the difference is a
 * security boundary:
 *
 * - the KEYWORD is read out of prompt TEXT, so `workflows.md` §Where the keyword
 *   works applies in full and the origin gate is fail-closed — a relayed
 *   payload, a webhook comment or a headless send must never opt in on the
 *   user's behalf;
 * - the TOGGLE is a session-scoped decision the person at the client made in the
 *   composer, so it holds for every turn of that session exactly as the vendor's
 *   own key does (`settings-reference.md#ultracode`: *"Start sessions with
 *   ultracode on. With it on, Claude plans a workflow for each substantive task
 *   instead of waiting for you to ask."*). No text is inspected, so there is no
 *   untrusted input to gate.
 *
 * Both still require the runtime to be able to dispatch a workflow and workflows
 * to be enabled, which is what {@link resolveUltracodeAvailability} answers.
 */
export function ultracodeTriggersWorkflowKeywordPath(input: {
  readonly provider: AgentProvider
  readonly requested: boolean
  readonly workflowsDisabled: boolean
}): boolean {
  if (!input.requested) return false
  const availability = resolveUltracodeAvailability({
    provider: input.provider,
    workflowsDisabled: input.workflowsDisabled,
  })
  return availability.available && availability.mechanism === 'workflow-keyword'
}

/**
 * The sentence a user meets where the toggle cannot be offered.
 *
 * Keys rather than text, resolved by whichever surface draws the control, so the
 * reason and its copy cannot drift: a reason added to
 * {@link UltracodeUnavailableReason} without a key fails to compile here.
 */
export const ULTRACODE_UNAVAILABLE_REASON_KEYS: Readonly<Record<UltracodeUnavailableReason, string>> = Object.freeze({
  runtime: 'chat.ultracode.unavailableRuntime',
  'workflows-off': 'chat.ultracode.unavailableWorkflowsOff',
  model: 'chat.ultracode.unavailableModel',
})
