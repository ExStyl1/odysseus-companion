/**
 * The environment this process STARTED with, captured once.
 *
 * `managed-mcp.md#how-policy-entries-expand` splits the two sides of a policy
 * match across two different environments, and the split is the whole point:
 *
 *   "The server's configured value expands from the live process environment,
 *   like the rest of `.mcp.json`. A policy entry expands from a pinned
 *   environment instead, so a variable set by a project or user settings file
 *   can't change what an allowlist entry means."
 *
 * The table under it names the pinned one for both lists — `allowedMcpServers`
 * expands from "The environment Claude Code started with, plus `env` values
 * from managed settings", and `deniedMcpServers` from "The same, and a variable
 * with no startup value and no `:-default` fills from settings files outside
 * the repository, such as user or managed settings, which only ever widens what
 * the entry matches". The section closes "Requires Claude Code v2.1.219 or
 * later."
 *
 * We expanded BOTH sides through the live `process.env`, so a variable changed
 * after startup changed what an operator's policy meant — P2.396. This module
 * is the pinned half. The live half stays live, deliberately: pinning the
 * SERVER's configured value would fail OPEN, because a `${VAR}` server URL
 * steered mid-session to a denied host would then be judged on its startup
 * value and slip the deny.
 *
 * ## Why a module-scope snapshot rather than an explicit boot step
 *
 * The snapshot is taken when this module is first imported, which the bootstrap
 * graph does at process start — `storage-runtime.ts` imports it at the top, and
 * nothing here runs later than that. An explicit `captureStartupEnvironment()`
 * a host had to remember to call would be a second thing to forget, and the one
 * host that forgot it would silently go back to reading the live environment,
 * which is the exact defect this closes and is invisible when it recurs.
 *
 * It is not the whole pinned environment on its own: the managed `env` block is
 * composed in at the one place both halves are in hand (`createStorageRuntime`,
 * from `EnforcedManagedPolicyV1.envComposition`). This module owns the half
 * that can only be captured EARLY.
 */

/**
 * A copy, not a reference. `process.env` is a live object with getters, so
 * holding it would pin nothing at all — the first thing this had to not be.
 */
const STARTUP_ENVIRONMENT: Readonly<Record<string, string | undefined>> = Object.freeze({
  ...(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env,
})

/**
 * The environment this process started with.
 *
 * Frozen and shared: every caller wants the same snapshot, and a per-call copy
 * would let one caller's mutation look like a policy change to the next.
 */
export function startupEnvironment(): Readonly<Record<string, string | undefined>> {
  return STARTUP_ENVIRONMENT
}

/**
 * The environment a managed POLICY ENTRY expands from — the page's sentence,
 * assembled.
 *
 * `managedEnv` is `EnforcedManagedPolicyV1.envComposition.env`, the per-variable
 * merge of both admin sources. The COMPOSED block rather than the block as
 * applied to `process.env`, and that choice is load-bearing rather than
 * incidental: a delivered variable can be WITHHELD pending server confirmation
 * (`managed-env.ts`), so the applied block changes when a fetch lands — and a
 * policy whose meaning moved when a fetch landed would reproduce the very
 * defect this function exists to close, one tier up.
 *
 * The deny row's extra clause — a variable with no startup value and no
 * `:-default` filling "from settings files outside the repository" — is NOT
 * modelled. There is no user-settings `env` tier in this fork for it to read,
 * and the direction it describes ("only ever widens what the entry matches") is
 * already enforced structurally by P2.375's deny-side neutralisation of the
 * variable's own span to `*`. Recorded here rather than invented.
 */
export function managedPolicyExpansionEnvironment(
  managedEnv: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string | undefined>> {
  if (managedEnv === undefined || Object.keys(managedEnv).length === 0) {
    return STARTUP_ENVIRONMENT
  }
  return Object.freeze({ ...STARTUP_ENVIRONMENT, ...managedEnv })
}
