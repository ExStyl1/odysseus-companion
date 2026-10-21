/**
 * Workflow governance settings — `settings.md` §Workflow and skill settings and
 * `workflows.md` §Set a size guideline / §Turn workflows off.
 *
 * Three documented keys, parsed with the same strictness `sandbox` and
 * `worktree` use: an unknown key or a bad value THROWS rather than silently
 * dropping to a default, because one of the three is an off switch an
 * organization relies on.
 *
 * ## The two dials do NOT behave alike
 *
 * `sizeGuideline` is ADVICE. Claude documents it as "advice, not an enforced
 * cap, so a prompt that calls for a different scale still overrides it". It
 * reaches the model as prose (see `PromptBuilder.buildStableContextParts`) and
 * it moves the advisory large-run warning threshold. It never blocks a run and
 * it never reduces `maxAgents` — the runtime caps are separate and still apply.
 *
 * `disableWorkflows` is a HARD off switch. It removes the `workflow` tool from
 * the signed execution manifest, removes every workflow-derived slash command,
 * and takes the keyword trigger with it. It composes "tighter wins": any layer
 * that turns workflows off wins, and no more-specific layer can turn them back
 * on. That is what makes the managed tier usable as the org switch Claude
 * documents ("To turn workflows off for your whole organization, set
 * `"disableWorkflows": true` in managed settings").
 *
 * ## Defaults we did and did not copy
 *
 * ## `disableBundledSkills` is the third input
 *
 * It is not a fourth key here: it contributes a `disableWorkflows: true` LAYER
 * (`workflowDisableEnvLayer` for the env half, `getUserWorkflowSettings` for
 * the settings half), so it rides the same tighter-wins rule as everything
 * else and no caller has to learn about it.
 *
 * `unrestricted` is our `sizeGuideline` default. Claude changed its own default
 * to `medium` in v2.1.219; we keep `unrestricted` because it is what the R4
 * contract specifies and what preserves the documented 25-agent warning
 * baseline ("The built-in default guideline leaves the threshold at 25").
 *
 * ## Three runtimes, one vocabulary — where each stands (owner answer QH9 = B, 2026-09-11)
 *
 * **Pi — UNCHANGED by this round, and the absence of change IS the decision
 * (C3.117).** Pi's own engine stays the product's authored-workflow path: the
 * keyword trigger (`workflows/workflow-keyword.ts`), the recipe loader and the
 * save-this-run affordance are exactly as they were, and the owner's answer
 * ("Pi stays as is") did not reopen any of them. Enabling the claude SDK's own
 * engine is NOT a decision to move the engine off Pi, and this paragraph exists
 * so that a later reader does not read it as one. The neighbouring question —
 * whether the product should SHIP a bundled workflow — was decided separately
 * and stays decided: triage §29 (owner, 2026-09-05), none; workflows stay
 * user-authored.
 *
 * **Claude — the runtime's OWN engine, enabled (C3.116).**
 * `buildClaudeWorkflowSettings` (`agent/claude-auto-mode-policy.ts`) projects
 * this resolver's answer onto the SDK's own `Settings` keys, in both directions
 * since C3.116. Nothing of Pi's is reused there and nothing is re-implemented;
 * `agent/__tests__/claude-workflow-engine-reachability.test.ts` carries the
 * measurement, including why an UNSET key was never an "off".
 *
 * **Codex — an honest null, dated by the protocol tag it was measured at
 * (C3.118).** At `packages/codex-protocol/manifest.json`'s `rust-v0.150.1`,
 * `generated/ClientRequest.ts` declares 98 methods and NONE of them names a
 * workflow; no file under `packages/codex-protocol/` mentions the word. The
 * shipped `codex-app-server 0.150.1` binary does spell `workflow` 94 times, and
 * every occurrence read is prompt PROSE — the Guardian's risk rubric and the
 * memory-block template — not a feature; `thread/start` (17) and `turn/start`
 * (19) are the live controls on the same read, a nonsense token scores 0, and
 * `ultracode` scores 0. So there is no surface to enable and nothing for this
 * host to supply. Re-probe at the next codex lift rather than carrying this
 * paragraph forward: it is a reading with a date, not a standing fact.
 */

import { bundledSkillsDisabledByEnv } from './bundled-skills-settings.ts'

export type WorkflowSizeGuideline = 'unrestricted' | 'small' | 'medium' | 'large'

export interface WorkflowSettingsV1 {
  /**
   * Hard off switch. Removes the workflow tool, every workflow-derived slash
   * command, and the keyword trigger. Env equivalent: `NESSY_DISABLE_WORKFLOWS`.
   */
  disableWorkflows?: boolean
  /** Advice sent to the model, and the large-run warning threshold. Never a cap. */
  sizeGuideline?: WorkflowSizeGuideline
  /** The keyword trigger only. Independent of `disableWorkflows` when it is on. */
  keywordTriggerEnabled?: boolean
}

export interface ResolvedWorkflowSettings {
  disableWorkflows: boolean
  sizeGuideline: WorkflowSizeGuideline
  keywordTriggerEnabled: boolean
}

const WORKFLOW_SETTING_KEYS = ['disableWorkflows', 'sizeGuideline', 'keywordTriggerEnabled'] as const
/**
 * The four values, in the order a control offers them: least to most
 * permissive, with our own default (`unrestricted`) first. Exported (P6.319) so
 * the settings row enumerates the union rather than re-typing it — a hand-typed
 * list is how a fifth guideline would reach the resolver and never reach a user.
 */
export const WORKFLOW_SIZE_GUIDELINES: readonly WorkflowSizeGuideline[] =
  Object.freeze(['unrestricted', 'small', 'medium', 'large'])

/** Agent count each guideline asks the model to aim for (`workflows.md`). */
export const WORKFLOW_SIZE_GUIDELINE_AGENT_COUNTS: Readonly<Record<Exclude<WorkflowSizeGuideline, 'unrestricted'>, number>> =
  Object.freeze({ small: 5, medium: 15, large: 50 })

/** Documented baseline for the advisory large-run warning. */
export const LARGE_WORKFLOW_AGENT_THRESHOLD = 25
/** Documented projected-token half of the same warning. */
export const LARGE_WORKFLOW_TOKEN_THRESHOLD = 1_500_000

/**
 * **`sizeGuideline` DIVERGES from the documented default, deliberately (P6.319).**
 *
 * `workflows.md` and the vendored SDK's own `workflowSizeGuideline` declaration
 * in `sdk.d.ts` both give `medium` as the default; ours is `unrestricted`. Named
 * by DECLARATION rather than by line: the anchor this sentence used to carry was
 * measured dead at bundle `0.3.247` (it lands in an unrelated shell-hook comment
 * block), the file moves with every SDK lift, and a correction that respells the
 * number re-creates the finding it repairs (C3.258, 2026-09-12).
 * Kept, not silently: `workflowSizeGuidanceText` returns `undefined` at
 * `unrestricted`, so our default costs zero prompt bytes and cannot re-stamp a
 * cached system prefix, while `medium` would add a sentence to every session's
 * prefix on every runtime.
 *
 * The consequence, stated because it is the honest half: on a claude session the
 * host sends the key only when a layer actually set it (see
 * `buildClaudeWorkflowSettings`), so an unset install leaves that child on the
 * vendor's `medium` while Pi gets `unrestricted`. Setting the key anywhere makes
 * the three agree.
 */
export const WORKFLOW_SETTINGS_DEFAULTS: ResolvedWorkflowSettings = Object.freeze({
  disableWorkflows: false,
  sizeGuideline: 'unrestricted',
  keywordTriggerEnabled: true,
})

function assertKnownKeys(layer: object): void {
  const allowed = new Set<string>(WORKFLOW_SETTING_KEYS)
  for (const key of Object.keys(layer)) {
    if (!allowed.has(key)) throw new Error(`invalid workflow setting: ${key}`)
  }
}

function booleanValue(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`invalid workflow ${key}`)
  return value
}

function guidelineValue(value: unknown): WorkflowSizeGuideline | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !WORKFLOW_SIZE_GUIDELINES.includes(value as WorkflowSizeGuideline)) {
    throw new Error('invalid workflow sizeGuideline')
  }
  return value as WorkflowSizeGuideline
}

/** Strict parser for one layer arriving from an untrusted-shape source. */
export function parseWorkflowSettingsV1(value: unknown): WorkflowSettingsV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid workflow settings')
  }
  const layer = value as Record<string, unknown>
  assertKnownKeys(layer)
  const disableWorkflows = booleanValue(layer.disableWorkflows, 'disableWorkflows')
  const sizeGuideline = guidelineValue(layer.sizeGuideline)
  const keywordTriggerEnabled = booleanValue(layer.keywordTriggerEnabled, 'keywordTriggerEnabled')
  return Object.freeze({
    ...(disableWorkflows === undefined ? {} : { disableWorkflows }),
    ...(sizeGuideline === undefined ? {} : { sizeGuideline }),
    ...(keywordTriggerEnabled === undefined ? {} : { keywordTriggerEnabled }),
  })
}

/**
 * Resolve ordered layers, least- to most-specific.
 *
 * - `disableWorkflows` is the RESTRICTING key, so it is tighter-wins: any layer
 *   asking for `true` gets it and no later layer can relax it. Same rule
 *   `resolveWorktreeSettings` applies to `bgIsolation`.
 * - `keywordTriggerEnabled` is also tighter-wins (any explicit `false` wins) and
 *   is forced off whenever workflows are off, matching "the `ultracode` keyword
 *   no longer triggers a run".
 * - `sizeGuideline` is an ordinary preference: last explicit value wins.
 */
export function resolveWorkflowSettings(
  layers: readonly WorkflowSettingsV1[],
): ResolvedWorkflowSettings {
  for (const layer of layers) assertKnownKeys(layer)
  let sizeGuideline = WORKFLOW_SETTINGS_DEFAULTS.sizeGuideline
  for (const layer of layers) {
    const value = guidelineValue(layer.sizeGuideline)
    if (value !== undefined) sizeGuideline = value
  }
  const disableWorkflows = layers.some(layer => booleanValue(layer.disableWorkflows, 'disableWorkflows') === true)
  const keywordTriggerEnabled = !disableWorkflows
    && !layers.some(layer => booleanValue(layer.keywordTriggerEnabled, 'keywordTriggerEnabled') === false)
  return Object.freeze({ disableWorkflows, sizeGuideline, keywordTriggerEnabled })
}

/**
 * The env off switch as its own layer — Claude's `CLAUDE_CODE_DISABLE_WORKFLOWS`
 * equivalent. Only the enabling direction is expressed: an env var must be able
 * to turn workflows OFF, never to turn them back on over a settings or managed
 * layer that turned them off.
 */
export function workflowDisableEnvLayer(
  env: Record<string, string | undefined> = process.env,
): WorkflowSettingsV1 {
  const raw = (env.NESSY_DISABLE_WORKFLOWS ?? '').trim().toLowerCase()
  // `settings-reference.md#disablebundledskills` / `env-vars.md:225` — "Claude
  // Code removes bundled skills and workflows entirely, while built-in commands
  // such as `/init` stay typable but are hidden from the model." So
  // `disableBundledSkills` removes workflows too. It COMPOSES with the
  // workflows switch rather than replacing it, and `disableWorkflows` is
  // tighter-wins, so the two cannot contradict each other in a way that
  // re-enables anything: whichever asks for OFF wins, and neither can turn
  // workflows back on.
  const bundledSkillsOff = bundledSkillsDisabledByEnv(env)
  return ['1', 'true', 'yes', 'on'].includes(raw) || bundledSkillsOff
    ? Object.freeze({ disableWorkflows: true })
    : Object.freeze({})
}

/**
 * The advice text the model sees. `undefined` at `unrestricted`, so the default
 * costs zero prompt bytes and cannot re-stamp a cached system prefix.
 */
export function workflowSizeGuidanceText(guideline: WorkflowSizeGuideline): string | undefined {
  if (guideline === 'unrestricted') return undefined
  const count = WORKFLOW_SIZE_GUIDELINE_AGENT_COUNTS[guideline]
  return `When you write a workflow script, aim for fewer than ${count} agents (${guideline} size). `
    + 'This is advice, not a cap: a task that genuinely needs a different scale still overrides it.'
}

/** The agent count an explicit guideline substitutes for the 25-agent baseline. */
export function largeWorkflowAgentThreshold(guideline: WorkflowSizeGuideline): number {
  return guideline === 'unrestricted'
    ? LARGE_WORKFLOW_AGENT_THRESHOLD
    : WORKFLOW_SIZE_GUIDELINE_AGENT_COUNTS[guideline]
}

/**
 * The advisory large-run warning. Returns text to SHOW, never a decision to
 * enforce — the caller must not stop, pause, or trim a run because of it.
 * Suppressed at max effort, matching "Sessions with ultracode on don't show the
 * warning, because turning ultracode on already opts you in to large runs".
 */
export function evaluateLargeWorkflowWarning(input: {
  scheduledAgents: number
  projectedTokens: number
  sizeGuideline: WorkflowSizeGuideline
  maxEffort: boolean
}): string | undefined {
  if (input.maxEffort) return undefined
  const agentThreshold = largeWorkflowAgentThreshold(input.sizeGuideline)
  if (input.scheduledAgents > agentThreshold) {
    return `Large workflow: ${input.scheduledAgents} agents scheduled (advisory threshold ${agentThreshold}).`
  }
  if (input.projectedTokens > LARGE_WORKFLOW_TOKEN_THRESHOLD) {
    return `Large workflow: ${input.projectedTokens} projected tokens (advisory threshold ${LARGE_WORKFLOW_TOKEN_THRESHOLD}).`
  }
  return undefined
}
