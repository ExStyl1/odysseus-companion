/**
 * Which model runs the guardian judge for a given session.
 *
 * THE PROBLEM THIS EXISTS FOR (owner, 2026-08-15): «не может быть одна модель
 * судьей для разных интеграций». The setting used to be ONE global model id
 * applied to every Pi session on every connection — and entitlement varies per
 * key, so a judge model that works on one connection returns 403 on another.
 * The consult then falls back to `unsure` → ask, per risky action: fail-closed,
 * but silently degraded, and indistinguishable from a normal question.
 *
 * So the choice is per INTEGRATION, and the resolution is a chain rather than a
 * lookup — every step below is a real case that has to keep working:
 *
 * 1. This connection's own entry, when the model is still in its catalog AND
 *    the managed allowlist permits it. A stale entry — connection deleted,
 *    model dropped from the catalog, model since forbidden — falls THROUGH
 *    rather than erroring, because a broken preference must not disable the
 *    deny-net it configures.
 * 2. The legacy global id, if it happens to be valid on THIS connection. No
 *    data migration: the old setting stays readable and simply stops applying
 *    where it cannot work.
 * 3. The gateway `fast` alias, when this connection's catalog has one.
 * 4. Nothing — the caller's default, which is the session's own model.
 *
 * A single-model connection needs no choice: step 1 finds nothing, and the one
 * model arrives through the chain like any other. That is the owner's «если
 * модель вовсе одна — она и будет работать», implemented by not special-casing
 * it.
 */

/** How the judge model was chosen. Carried so a debug line can say WHY. */
export type GuardianJudgeModelSource =
  | 'connection-preference'
  | 'legacy-global'
  | 'fast-alias'
  | 'default'

export interface GuardianJudgeModelResolution {
  /** `undefined` means "use the caller's default" — the session model. */
  modelId?: string
  via: GuardianJudgeModelSource
}

export interface GuardianJudgeModelInput {
  /** The session's connection. Absent on a session with no connection yet. */
  connectionSlug?: string
  /** Ids this connection actually offers. A model outside it cannot be judged on. */
  catalog: readonly string[]
  /** The per-connection setting, `slug → modelId`. */
  perConnection?: Record<string, string>
  /** The pre-H1 global setting. Read, never written. */
  legacyGlobalId?: string
  /**
   * The managed-model allowlist. A forbidden judge model falls back to the
   * DEFAULT path, never to a disabled judge: disabling would turn a model
   * restriction into a safety reduction, since the judge is the deny-net over
   * auto mode.
   */
  isModelAllowed: (modelId: string) => boolean
}

/** The gateway's cheap-model alias, when a catalog carries one. */
const FAST_ALIAS = 'fast'

function usable(
  modelId: string | undefined,
  input: GuardianJudgeModelInput,
): modelId is string {
  const id = modelId?.trim()
  if (!id) return false
  if (!input.catalog.includes(id)) return false
  return input.isModelAllowed(id)
}

export function resolveGuardianJudgeModel(
  input: GuardianJudgeModelInput,
): GuardianJudgeModelResolution {
  const preference = input.connectionSlug
    ? input.perConnection?.[input.connectionSlug]
    : undefined
  if (usable(preference, input)) return { modelId: preference, via: 'connection-preference' }

  // The legacy global is checked against THIS connection, which is the whole
  // point: it stops applying where it never worked, without being deleted.
  if (usable(input.legacyGlobalId, input)) {
    return { modelId: input.legacyGlobalId.trim(), via: 'legacy-global' }
  }

  const fast = input.catalog.find(id => id === FAST_ALIAS || id.endsWith(`/${FAST_ALIAS}`))
  if (usable(fast, input)) return { modelId: fast, via: 'fast-alias' }

  return { via: 'default' }
}
