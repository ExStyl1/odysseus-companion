/**
 * The managed model allowlist primitive, and the process registry that holds it.
 *
 * ## Why this is its own module, with no imports at all
 *
 * Three consumers need the allowlist and they cannot share one module otherwise:
 *
 * - `config/llm-connections.ts` (`getMiniModel`, `getSummarizationModel`,
 *   `resolveGatewayFastModelId`) is **bundled into the Vite renderer**. Its own
 *   header records what that costs: a transitive `node:` import breaks the
 *   renderer build. `agent/pi-harness/managed-policy.ts` reaches `node:os` and
 *   `node:path` through the permission DSL, so `llm-connections.ts` must not
 *   import it, directly or otherwise.
 * - `orchestrator/spawner.ts` runs in the Pi **subprocess** and holds the
 *   allowlist as a manifest field, not as a parsed policy document.
 * - `agent/pi-harness/managed-policy.ts` owns the parse and states the rule.
 *
 * All three ask the same matcher here, which is what stops the host and the
 * subprocess enforcing two different allowlists from one deployed list.
 *
 * Zero imports is a constraint, not an accident. Keep it that way.
 */

/**
 * `pi/` is OUR routing prefix, not part of a model id — `model-resolution.ts`
 * strips it before every Pi SDK lookup ("Pi SDK uses bare model IDs"), and
 * `isDeniedMiniModelId` already normalizes it the same way. Stripping it on both
 * sides is what lets an administrator write the id the provider documents
 * instead of the id our catalog happens to store.
 *
 * `model-config.md#pin-models-for-third-party-deployments`'s "Provider-specific
 * prefixes such as `us.anthropic.` are not stripped" is about a PROVIDER's own
 * id namespace and is unaffected:
 * that rule keeps `us.anthropic.` on the id, and this one removes a prefix the
 * provider never sees.
 */
function bareModelId(value: string): string {
  return value.startsWith('pi/') ? value.slice(3) : value
}

/**
 * Whether one allowlist entry names a model.
 *
 * `model-config.md#restrict-model-selection` — "Entries match a model family
 * such as `sonnet`, a version prefix such as `claude-sonnet-4-5`, or a full
 * model ID such as `claude-sonnet-4-5-20250929`."
 *
 * Two of the three are implemented: the full id, and the version prefix, which
 * matches only at a `-` boundary so `claude-sonnet-4-5` cannot capture a
 * hypothetical `claude-sonnet-4-56`. The FAMILY ALIAS is not:
 * `documented, not implemented — #restrict-model-selection's family aliases
 * ("sonnet") need a family taxonomy over provider-specific ids, and
 * model-config.md#merge-behavior makes a family entry conditional on the rest of
 * the list ("an entry naming a specific model in a family, whether a version
 * prefix or a full model ID, disables that family's wildcard entry"). Half of
 * that rule WIDENS an administrator's list, which is the one direction an
 * allowlist must never move by accident, so the alias case falls through to
 * exact match and permits nothing extra. A family-only list therefore leaves
 * only the Default reachable — managed-settings.md#keys-that-fail-closed's own
 * posture for a value that needs fixing — and nessy-general-agent doctor prints
 * the deployed list so the state is visible. Cost: ~1 small slice in
 * config/models.ts, where the family of each registry entry is already known,
 * plus #merge-behavior's specific-entry precedence.`
 *
 * :256's worked example still comes out right without aliases:
 * `["sonnet", "claude-sonnet-4-5"]` "allows only Sonnet 4.5 versions, not every
 * Sonnet model" — here the family entry matches nothing and the version prefix
 * decides, which is the same set.
 */
export function matchesManagedModelEntry(entry: string, candidate: string): boolean {
  const wanted = bareModelId(entry)
  const model = bareModelId(candidate)
  return model === wanted || model.startsWith(`${wanted}-`)
}

/**
 * Whether a NAMED model selection is permitted by an allowlist.
 *
 * `undefined` imposes no narrowing; an EMPTY list admits nothing, which is
 * `managed-settings.md#keys-that-fail-closed`'s enforced reading of an invalid
 * value: `availableModels` is "enforced as an empty allowlist until fixed, so
 * only the Default model is available".
 *
 * Named selection only. `model-config.md#default-model-behavior` keeps the Default option
 * reachable through a list this predicate rejects, so a catalog projection must
 * ask both this and the Default resolver — see `config/managed-models.ts`, which
 * is the one place that combines them.
 */
export function isModelInManagedAllowlist(
  allowlist: readonly string[] | undefined,
  modelId: string,
): boolean {
  return allowlist === undefined
    || allowlist.some(entry => matchesManagedModelEntry(entry, modelId))
}

/**
 * The enforced allowlist for THIS process.
 *
 * A process-scoped registry rather than a threaded parameter, for the same
 * reason `managed-env.ts` keeps one: the managed policy is a property of the
 * host process (one policy source, composed once at bootstrap by
 * `createStorageRuntime`), and the reads that need it — `resolveSessionConnection`,
 * `getMiniModel`, `resolveGatewayFastModelId` — are pure helpers far below the
 * layer that owns the composition. `setManagedModelPolicy` in
 * `config/managed-models.ts` is the single writer, and it sets this from the
 * same value it hands `SessionManager`, so the process registry and the session
 * layer cannot disagree.
 *
 * Nothing recomposes the policy after bootstrap, so this value is FIXED for the
 * process lifetime. A policy delivered mid-run takes effect at the next start,
 * which is why no session can find itself running a model that became forbidden
 * underneath it.
 */
let activeAllowlist: readonly string[] | undefined

export function setManagedModelAllowlist(allowlist: readonly string[] | undefined): void {
  activeAllowlist = allowlist
}

export function managedModelAllowlist(): readonly string[] | undefined {
  return activeAllowlist
}

/** Whether a named model selection is permitted in this process. */
export function isManagedModelSelectable(modelId: string): boolean {
  return isModelInManagedAllowlist(activeAllowlist, modelId)
}
