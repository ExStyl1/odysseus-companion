/**
 * The managed switch for this app's OWN local automations — D1.205.
 *
 * ## What it is, and what I2.24 left open
 *
 * A codex deployment can forbid the desktop app from running local automations:
 * `requirements.toml`'s `[features] in_app_local_automation = false`, whose own
 * doc line is *"Allow desktop apps to run local automations"*
 * (`Stage::Stable, default_enabled: true`). The subject here is
 * `packages/shared/src/automations/` — the hook side AND the scheduler side.
 *
 * I2.24 classified the key `'client'` — *"only the client can, and this build
 * does not"* — because nothing read it. WI-r then measured the halves apart, and
 * the correction is why this module exists rather than a second kill switch:
 *
 *  - the HOOK half already has a managed kill switch,
 *    `ManagedPiPolicyV1.disableAllHooks` (`isManagedAllHooksDisabled`, four
 *    readers), which codex's key reached from nowhere;
 *  - the SCHEDULER half — `new AutomationSystem({ … enableScheduler: true … })`
 *    in `SessionManager` — had no managed key at all, from any tier.
 *
 * So what was missing is a PATH for one half and a GATE for the other, and the
 * row's own "a gate beside the existing one" would have built a second kill
 * switch next to one that works.
 *
 * ## ONE tier, deliberately, and this is the part to read before adding another
 *
 * The in-app-browser and in-app-updates modules carry two tiers each (a host
 * `managed-policy.json` key and a codex `[features]` key, tightest wins). This
 * one carries the CODEX tier only.
 *
 * A host tier would be a NEW managed key — `disableLocalAutomation` on
 * `ManagedPiPolicyV1` — and that is a new operator contract, which D1.205's own
 * note calls a product posture rather than a lane's call. The alternative of
 * MAPPING the existing `disableAllHooks` onto the scheduler was weighed and
 * refused: that key is documented (Claude's `hooks.md`) as being about hooks, a
 * cron record that sends a prompt is not a hook, and widening it here would
 * silently stop the scheduler on every fleet that already deploys it. Either
 * change is one an administrator must be told about first.
 *
 * If a host tier is added later, add it the way `managed-in-app-browser.ts` did
 * — a registered provider plus tightest-wins — rather than widening this one.
 *
 * ## The posture: REFUSE BY NAME, do not hide the surface
 *
 * `managed-in-app-browser.ts`'s documented choice for this same class, and for
 * its reason: a scheduler that silently never fires is indistinguishable from a
 * bug, and the user cannot tell whether their automation is broken or forbidden.
 * The automations surface stays visible and
 * {@link describeManagedLocalAutomationRefusal} names the document to go and
 * change.
 *
 * ## Import-free, like its two siblings
 *
 * It is reachable from the `@nessy-agent/shared/config` barrel, which the Vite
 * renderer bundles, and a transitive `node:` import through that barrel breaks
 * the renderer build.
 */

/**
 * The codex spelling of this policy, in `requirements.toml`'s `[features]`
 * table — *"Allow desktop apps to run local automations"*.
 *
 * Here rather than in `agent/codex-config-requirements.ts` for the two
 * siblings' reason: that module RE-EXPORTS it, so the mapping has one place to
 * bind and the key cannot be renamed in one spelling only.
 *
 * `false` is the disabling value — codex's table states a feature's
 * AVAILABILITY where ours states a restriction — which is why
 * {@link recordCodexLocalAutomationRequirement} takes an already-normalised
 * `disabled` boolean rather than the raw wire value.
 */
export const CODEX_LOCAL_AUTOMATION_FEATURE_KEY = 'in_app_local_automation'

/** The codex tier's last answer. `undefined` until a codex runtime reports one. */
let codexLocalAutomationDisabled: boolean | undefined

/**
 * Listeners that want to hear when the answer changes.
 *
 * Anchored to the WRITE for `managed-in-app-browser.ts`'s reason: the caller
 * that matters is the one nobody would remember to instrument — a codex
 * `configRequirements` read lands whenever the FIRST codex runtime of the
 * process starts, which on a Pi-only session is never and on a mixed one is
 * long after a workspace's `AutomationSystem` was constructed.
 */
const managedLocalAutomationListeners = new Set<() => void>()

/**
 * Subscribe to managed local-automation policy changes; returns the unsubscribe.
 *
 * A throwing listener is swallowed: a broken subscriber must not take down the
 * policy write that triggered it, and the write has already happened by the
 * time listeners run.
 */
export function subscribeManagedLocalAutomationChange(listener: () => void): () => void {
  managedLocalAutomationListeners.add(listener)
  return () => { managedLocalAutomationListeners.delete(listener) }
}

/**
 * Record what a codex app-server's `configRequirements` said.
 *
 * `true` means the deployed `requirements.toml` carries
 * `[features] in_app_local_automation = false`. `undefined` clears the tier,
 * which is what an administrator withdrawing the requirement says.
 *
 * The CALLER carries the other half of that contract and it is load-bearing: it
 * writes only when the probe ANSWERED (`status` `read` or `none`), because a
 * `failed` or `unsupported` probe produces the same `undefined` reading as "no
 * requirement" and clearing on it would silently re-enable automations an
 * administrator had turned off. P2.137 measured exactly that split on the
 * in-app-updates twin.
 */
export function recordCodexLocalAutomationRequirement(disabled: boolean | undefined): void {
  const next = typeof disabled === 'boolean' ? disabled : undefined
  if (next === codexLocalAutomationDisabled) return
  codexLocalAutomationDisabled = next
  for (const listener of [...managedLocalAutomationListeners]) {
    try { listener() } catch { /* a broken listener is not the policy's problem */ }
  }
}

/**
 * What the managed layer says, or `undefined` when it says nothing.
 *
 * Three values on purpose: "nobody has an opinion" (no codex runtime has
 * started, or none carries the key) must stay distinguishable from "an
 * administrator says local automations are allowed", because only the first is
 * a reason to ask again later.
 */
export function resolveManagedLocalAutomationDisabled(): boolean | undefined {
  return codexLocalAutomationDisabled
}

/**
 * The single predicate every local-automation entry point asks.
 *
 * Only an explicit `true` disables: `false` and unset are both "automations
 * work", which keeps a deployment that spells the key `true` on the same path
 * as an unmanaged one.
 */
export function isLocalAutomationManagedDisabled(): boolean {
  return codexLocalAutomationDisabled === true
}

/**
 * The refusal sentence every entry point shares.
 *
 * Here rather than at the gates so the scheduler, the hook builder and any
 * later entry point cannot drift into three English strings for one policy —
 * and so the sentence names the document to go and fix, which is the whole
 * difference between an explained refusal and a feature that quietly stopped.
 */
export function describeManagedLocalAutomationRefusal(): string {
  return 'Local automations are disabled by a codex deployment\'s requirements.toml '
    + '([features] in_app_local_automation = false), so this app runs no scheduled automations '
    + 'and no hooks. Ask whoever manages this install to change that policy; nothing in the app '
    + 'can re-enable it.'
}

/**
 * TEST SEAM. Clears the codex tier so a suite cannot inherit a neighbour's
 * answer — the module is process-scoped by design, which is right in production
 * and is exactly what makes a test order-dependent.
 */
export function resetManagedLocalAutomationForTests(): void {
  recordCodexLocalAutomationRequirement(undefined)
}
