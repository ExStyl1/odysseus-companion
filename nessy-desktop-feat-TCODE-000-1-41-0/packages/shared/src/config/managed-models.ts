/**
 * The managed model allowlist, at the READ boundary.
 *
 * `settings-reference.md#availablemodels` — "Restrict which models people can
 * select for the main session, subagents, skills, and the advisor. … On its own
 * this doesn't touch the Default option; pair it with `enforceAvailableModels`".
 * (Cited as line 241 of the pre-split `settings.md` until 2026-08-28 — named in
 * WORDS on purpose: spelling the old anchor in its `path:line` form re-creates
 * the very finding this correction repairs, because a citation guard cannot
 * tell a dead anchor quoted as history from a live one. That page SPLIT and the
 * key-by-key reference moved, so the line anchor was dead at the PAGE level;
 * the entry was rewritten too — it read "which models users can select … Does
 * not affect the Default option unless `enforceAvailableModels` is also set".)
 *
 * `model-config.md#surface-coverage` decides where this module may act: "The model pickers on
 * claude.ai and in the Desktop app hide or grey out models excluded by your
 * organization's allowlist. **The picker state is a convenience for users;
 * enforcement happens in the session.**" So the allowlist narrows what a session
 * resolves to, and the picker is presentation.
 *
 * ## Why nothing here writes
 *
 * The obvious choke point is `getLlmConnections()`'s `connection.models`, which
 * every selector reads. Filtering there is DESTRUCTIVE, and reachably so:
 * `llmConnections.LIST_WITH_STATUS` hands the renderer whole connection records,
 * and `useModelVisionToggle` / the Settings rename flow send one straight back
 * through `llmConnections.SAVE` → `updateLlmConnection`, which rebuilds the
 * connection from a hardcoded field list. One vision toggle under a narrowed
 * list would delete every excluded model from the user's `config.json`
 * permanently, and withdrawing the policy would not bring them back.
 *
 * So the projection here is applied at `resolveSessionConnection` — the
 * session-side read that feeds model resolution and nothing else — and it
 * returns a COPY. The persistence-facing reads (`getLlmConnections`,
 * `getLlmConnection`, the RPC list handlers) are deliberately untouched.
 *
 * ## The one rule that keeps a policy from bricking a client
 *
 * The connection's effective Default always survives the filter.
 * `managed-settings.md#keys-that-fail-closed` — an invalid `availableModels` is
 * "enforced as an empty allowlist until fixed, so only the Default model is
 * available; a non-string entry is stripped and the valid subset enforced" (the
 * second clause is NEW since this file quoted the row, and the first was
 * re-ordered); `model-config.md#default-model-behavior` — "On its own,
 * `availableModels` leaves the Default option on the system's runtime default
 * for the account until you also set `enforceAvailableModels`" (this file
 * quoted it as "leaves Default available", which is no longer the page's
 * wording); and, same section, "with `availableModels: []`, named model
 * selections are blocked but the Default model for the account type remains
 * usable regardless of `enforceAvailableModels`." A naive
 * `models.filter(isManagedModelAllowed)` contradicts all three and leaves a
 * fleet with no model at all.
 */

import type { LlmConnection } from './llm-connections.ts'
import type { ModelDefinition } from './models.ts'
import { setManagedModelAllowlist } from './managed-model-allowlist.ts'
import {
  DEFAULT_MANAGED_PI_POLICY,
  isManagedModelAllowed,
  resolveManagedDefaultModel,
  type ManagedPiPolicyV1,
} from '../agent/pi-harness/managed-policy.ts'

/**
 * The allowlist primitive and the process registry live one module down, with no
 * imports at all, because `config/llm-connections.ts` needs them and is bundled
 * into the Vite renderer.
 *
 * Only the process-level predicate is re-exported, and only because it has a
 * consumer that reaches this module by package path
 * (`@nessy-agent/shared/config/managed-models`). Everything else in the leaf is
 * imported from the leaf directly — a barrel that re-exports names nobody asks
 * for through it is how a module ends up with exports no caller uses.
 */
export { isManagedModelSelectable } from './managed-model-allowlist.ts'

/**
 * The enforced policy for THIS process.
 *
 * Kept alongside the bare allowlist registry rather than replacing it: the
 * projection below needs `enforceAvailableModels` too, and the renderer-safe
 * leaf must not carry a policy type that drags `node:` imports with it.
 */
let activePolicy: ManagedPiPolicyV1 = DEFAULT_MANAGED_PI_POLICY

/**
 * Bootstrap seam — the SINGLE writer. `undefined` restores the built-in
 * (unrestricted) policy.
 */
export function setManagedModelPolicy(policy: ManagedPiPolicyV1 | undefined): void {
  activePolicy = policy ?? DEFAULT_MANAGED_PI_POLICY
  setManagedModelAllowlist(activePolicy.availableModels)
}

/** Test/process seam — the counterpart of `clearManagedOriginEnvVars()`. */
export function clearManagedModelPolicy(): void {
  setManagedModelPolicy(undefined)
}

const modelId = (model: ModelDefinition | string): string =>
  typeof model === 'string' ? model : model.id

/**
 * The catalog a session may select from, plus the Default it resolves to.
 *
 * Pure, and the only place the two halves of the policy are combined. Kept
 * separate from {@link applyManagedModelAllowlist} so the decision can be tested
 * without a connection record.
 */
export function resolveManagedModelCatalog<T extends ModelDefinition | string>(
  models: readonly T[],
  defaultModelId: string | undefined,
  policy: ManagedPiPolicyV1 = activePolicy,
): { models: readonly T[]; defaultModel: string | undefined } {
  if (policy.availableModels === undefined) {
    return { models, defaultModel: defaultModelId }
  }
  // `model-config.md#enforce-the-allowlist-for-the-default-model` — "When
  // `availableModels` is non-empty but no entry resolves to an allowed and
  // available model, enforcement is skipped and Default resolves to the
  // account-type default, with a warning visible only under `--debug`".
  // `resolveManagedDefaultModel`
  // reports that case as `undefined`, which is NOT "no model": falling through
  // to the user's own default is what the sentence asks for.
  const enforcedDefault = resolveManagedDefaultModel(
    policy,
    defaultModelId,
    models.map(modelId),
  ) ?? defaultModelId
  const allowed = models.filter(model => isManagedModelAllowed(policy, modelId(model)))
  // The Default survives the filter — `managed-settings.md#keys-that-fail-closed`
  // and `model-config.md#default-model-behavior`. Re-inserted at the FRONT
  // rather than appended so a picker
  // rendering this list in order shows the model the session will actually run
  // on first.
  const keepsDefault = enforcedDefault !== undefined
    && !allowed.some(model => modelId(model) === enforcedDefault)
  const defaultEntry = keepsDefault
    ? models.find(model => modelId(model) === enforcedDefault)
    : undefined
  return {
    models: defaultEntry === undefined ? allowed : [defaultEntry, ...allowed],
    defaultModel: enforcedDefault,
  }
}

/**
 * Project one connection through the allowlist.
 *
 * Returns a COPY with a fresh `models` array. Callers must never hand the result
 * to `updateLlmConnection` or any other writer; see this module's header for the
 * data-loss path that makes that a hard rule rather than a style preference.
 */
export function applyManagedModelAllowlist<
  T extends Pick<LlmConnection, 'models' | 'defaultModel'>,
>(connection: T, policy: ManagedPiPolicyV1 = activePolicy): T {
  // P6.238 — a managed `model` OUTRANKS the connection's stored default.
  // `model-config.md#organization-default-model` ranks "a `model` value in
  // managed settings or supplied through `--settings`" above "a `model` value
  // in your user, project, or local settings, including a model you save with
  // `/model`". A managed default a user's saved choice silently overrides is
  // not a managed default; it is a suggestion.
  //
  // It still passes through `resolveManagedModelCatalog`, so an administrator
  // who names a model their OWN allowlist excludes gets the documented
  // allowlist behaviour rather than a contradiction — the same resolution the
  // user's default gets.
  const managedDefault = policy.model
  // The early return has to see both keys now: a managed `model` with no
  // allowlist is a complete, meaningful policy on its own.
  if (policy.availableModels === undefined && managedDefault === undefined) return connection
  const resolved = resolveManagedModelCatalog(
    connection.models ?? [],
    managedDefault ?? connection.defaultModel,
    policy,
  )
  return {
    ...connection,
    ...(connection.models === undefined ? {} : { models: [...resolved.models] }),
    ...(resolved.defaultModel === undefined ? {} : { defaultModel: resolved.defaultModel }),
  }
}
