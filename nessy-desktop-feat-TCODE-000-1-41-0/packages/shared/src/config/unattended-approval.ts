/**
 * P6.531 — what an UNATTENDED turn answers when no rule and no floor covers the
 * call.
 *
 * ## The divergence this closes
 *
 * All three runtimes reach a moment with no human to ask: a headless run, a
 * scheduled turn, a subagent. Pi and claude both REFUSE there
 * (`pi-agent.ts`'s fail-closed fallback, `claude-agent.ts`'s
 * `CAN_USE_TOOL_NO_SURFACE_DENIAL`). Codex approved. So on one runtime the
 * absence of a human WIDENED what could run, and nothing said so — the
 * silent-divergence shape that is this fork's largest defect class.
 *
 * The floor was never the gap: `CodexAgent` refuses a floor match with no user
 * present, and P2.140's gate sits above the headless answer. The auto-approve
 * fired only when NO floor matched, which is exactly the case Pi and claude
 * refuse.
 *
 * ## The decision (Q-den 68 = A + C)
 *
 * **A** — deny by default. **C** — an operator escape hatch, whose default is
 * deny. **B** — keep auto-approving and pay the honesty in documentation — was
 * refused, because a documented divergence is copy, not protection.
 *
 * The escape hatch is not decoration: an unattended pipeline that used to
 * complete will now stop at the first uncovered call, and an operator who has
 * decided that trade is theirs to make needs a way to make it that is not
 * "downgrade the product".
 *
 * ## Two values, not a free-form policy
 *
 * `deny` and `allow`, and nothing else. A richer vocabulary here would be a
 * second permission system beside the rules and the floors, and the thing that
 * decides *which calls* run is already the rule layer — this setting only says
 * what happens when the rule layer said nothing at all.
 *
 * An unrecognised value reads as `deny`. That direction is deliberate and is
 * the opposite of the usual tolerant-parse rule elsewhere in this package: a
 * typo in a RESTRICTION must not silently open it.
 */

export type UnattendedApprovalEnvRecord = Record<string, string | undefined>

/** What an unattended turn answers when nothing else did. */
export type UnattendedApprovalFallback = 'deny' | 'allow'

/** The one value this ships with, on every runtime. */
export const UNATTENDED_APPROVAL_FALLBACK_DEFAULT: UnattendedApprovalFallback = 'deny'

/** The settings-file key. */
export const UNATTENDED_APPROVAL_FALLBACK_SETTING_KEY = 'unattendedApprovalFallback'

/** The env spelling, for an operator who cannot write the settings file. */
export const UNATTENDED_APPROVAL_FALLBACK_ENV_VAR = 'NESSY_UNATTENDED_APPROVAL_FALLBACK'

function readFallback(value: unknown): UnattendedApprovalFallback | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return normalized === 'allow' || normalized === 'deny' ? normalized : undefined
}

/**
 * The composed answer: the settings key first, then the env, then `deny`.
 *
 * Settings ahead of env, unlike the aliased-pair readers in this package, and
 * for a reason: those pairs are one lever with two spellings, while these are
 * two scopes. The settings file is the durable, reviewable statement of an
 * operator's decision; an env var is per-launch. A per-launch value that could
 * override the reviewed one would make the reviewed one unverifiable.
 *
 * Anything unrecognised in EITHER scope falls to `deny` without consulting the
 * other — a value that was meant to open the gate and failed to parse must not
 * be silently replaced by whatever the other scope happens to say.
 *
 * A managed policy's `deny` outranks both, and only in that direction — see the
 * `managed` parameter.
 */
export function resolveUnattendedApprovalFallback(
  config: unknown,
  env: UnattendedApprovalEnvRecord = process.env,
  managed?: UnattendedApprovalFallback,
): UnattendedApprovalFallback {
  // P6.531 residue — the managed floor, and it NARROWS ONLY.
  //
  // A one-way test rather than a third tier of the precedence chain below: a
  // managed `deny` cannot be widened by an operator's settings key or env var,
  // while a managed `allow` grants nothing on its own and leaves that chain
  // standing. A floor that hands capability out is not a floor, which is the rule
  // `ManagedPiPolicyV1.channelsEnabled` already states for its own grant.
  //
  // Passed in rather than read here on purpose: this module is a LEAF with no
  // imports, and reading `resolveManagedPiPolicyFloor()` would point `config/` at
  // `agent/pi-harness/` while that module already imports four files from
  // `config/`. The caller holds the policy anyway. An unrecognised managed value
  // never reaches this parameter — `parsePolicy` reinterprets it at the enforcing
  // pole and reports the tightening.
  if (managed === 'deny') return 'deny'
  if (config !== null && typeof config === 'object' && !Array.isArray(config)) {
    const stored = (config as Record<string, unknown>)[UNATTENDED_APPROVAL_FALLBACK_SETTING_KEY]
    if (stored !== undefined) return readFallback(stored) ?? UNATTENDED_APPROVAL_FALLBACK_DEFAULT
  }
  const fromEnv = env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR]
  if (fromEnv !== undefined) return readFallback(fromEnv) ?? UNATTENDED_APPROVAL_FALLBACK_DEFAULT
  return UNATTENDED_APPROVAL_FALLBACK_DEFAULT
}

/**
 * The sentence an unattended refusal carries, in ONE wording.
 *
 * It names the setting, because a person reading a stopped pipeline's log needs
 * to know both what happened and what to change — and because the alternative
 * (a bare "denied") is indistinguishable from the floor refusals that sit above
 * this one and are NOT negotiable.
 */
export function describeUnattendedApprovalRefusal(): string {
  return 'Refused with no user present: nothing in your permission rules covers this call, and an '
    + `unattended turn denies by default. Set \`${UNATTENDED_APPROVAL_FALLBACK_SETTING_KEY}\` to `
    + '"allow" to approve uncovered calls on unattended turns instead.'
}
