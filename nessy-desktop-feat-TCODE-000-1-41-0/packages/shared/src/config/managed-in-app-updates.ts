/**
 * The managed kill switch for the app's OWN in-app updater.
 *
 * ## What it is
 *
 * An organization that manages this install can forbid the desktop host from
 * updating itself, so the version on the machine is whatever the org's own
 * distribution channel put there. Upstream states the contract for the same
 * capability in `learn.chatgpt.com/docs/enterprise/manage-app-updates.md`: the
 * `[features]` `in_app_updates = false` entry of a deployed `requirements.toml`
 * disables the host's in-app updates (§ Turn off in-app updates, anchor
 * `#turn-off-in-app-updates`), a "Managed" indicator in Settings is how a user
 * confirms it (§ Verify the managed setting, `#verify-the-managed-setting`:
 * "Find **In-app updates** and confirm that it shows **Managed**"), and — the
 * part that decides what we do NOT build — "The **Check for Updates** menu
 * option can remain visible even when the policy blocks in-app updates" (same
 * section). So the entry points stay where they are and REFUSE; nothing is
 * hidden from the menu.
 *
 * **The host prefix is load-bearing and was missing until P2.377.** This page is
 * codex's, not Claude's: measured 2026-09-03 it returns 404 on
 * `code.claude.com/docs/en/` and appears in none of the pages of
 * `scripts/claude-doc-pages.tsv`, while `learn.chatgpt.com/docs/` serves it 200.
 * Cited bare it read as a dead Claude citation to every human reader. The line
 * anchors it used to carry (`:54`-`:55`, `:79`-`:80`, `:84`-`:86`) all still
 * resolve on the page as fetched 2026-09-03, and were replaced anyway: a section
 * anchor is part of the page's published link contract and a line number has a
 * measured half-life of about two days. Codex-page anchors are read from the
 * `.md`, never from the rendered page — those are client-rendered and the
 * `id="…"` recipe scores badly on them.
 *
 * ## Why the key lives here and not on `ManagedPiPolicyV1`
 *
 * This switch governs the ELECTRON HOST, not an agent session: its only
 * consumer is `apps/electron/src/main/auto-update.ts`, which has no parsed
 * policy object in hand and cannot grow a dependency on the Pi harness to get
 * one. `config/` is also where the two existing managed bridges of exactly this
 * shape live — `registerManagedRetentionDaysProvider` and
 * `registerManagedSandboxEnabledProvider` in `config/storage.ts` — for the same
 * reason those give: the managed policy is composed in `server-core`, which
 * `packages/shared` cannot import, so the value arrives through a registered
 * reader instead of an import.
 *
 * This module is deliberately import-free (like `managed-model-allowlist.ts`):
 * it is reachable from the `@nessy-agent/shared/config` barrel, which the Vite
 * renderer bundles, and a transitive `node:` import through that barrel breaks
 * the renderer build.
 *
 * ## Precedence
 *
 * Managed beats user by construction: there is no user-tier spelling of this
 * key — the app ships no "turn off automatic updates" preference — so the only
 * two states are "an administrator forbade it" and "unset". Unset is today's
 * behavior, unchanged, which is also why the three-site config default rule
 * (`config-defaults.json` + `FALLBACK_CONFIG_DEFAULTS` + schema) does NOT apply
 * here: those three sites exist to give a USER setting one default, and this
 * key is not a user setting.
 *
 * ## Who sets it — TWO tiers, not one (P2.7)
 *
 * This module used to prescribe a single registration, from the codex
 * `configRequirements` read, on the reasoning that nothing else could carry the
 * key. That reasoning had a hole and P2.7 clause (d) is the hole: the key had no
 * field on `ManagedPiPolicyV1`, so `refuseUnknownKeys` STRIPPED it out of a
 * host-owned `managed-policy.json`. Now that the field exists, the switch has
 * two writers, and they are not alternatives:
 *
 *  - {@link registerManagedInAppUpdatesDisabledProvider} — the HOST policy tier,
 *    fed by the composed `managed-policy.json` (file or server-delivered) at
 *    bootstrap, before the launch update check runs.
 *  - {@link recordCodexInAppUpdatesRequirement} — the CODEX tier, fed by
 *    `configRequirements/read` after a codex app-server `initialize`. Arrives
 *    mid-session, whenever the first codex runtime starts, which is why
 *    {@link subscribeManagedInAppUpdatesChange} exists: a settings page already
 *    on screen has to flip without the user doing anything.
 *
 * `featureRequirements` is `{ [key: string]?: boolean } | null` on the generated
 * `ConfigRequirements` — the `[features]` table of `requirements.toml` — so
 * `in_app_updates = false` is what arrives there. Codex types are NOT imported
 * here on purpose: this module must stay import-free, and the mapping is
 * `agent/codex-config-requirements.ts`'s to own.
 *
 * ## How the two compose
 *
 * TIGHTEST WINS, and only in the disabling direction: any tier that says `true`
 * disables. There is no precedence order to get wrong, because the two tiers
 * answer the same question from two administrators who are in practice the same
 * administrator, and the alternative — one slot, last writer wins — makes a
 * codex session start quietly re-enable updates an MDM policy had turned off.
 */

/**
 * The managed key name.
 *
 * Exported as a constant because the writer (P2.7) and the reader
 * ({@link readManagedInAppUpdatesDisabled}) are in different packages, and a
 * key spelled twice is a key that eventually disagrees with itself.
 */
export const MANAGED_IN_APP_UPDATES_KEY = 'disableInAppUpdates'

/**
 * The codex spelling of the same policy, in `requirements.toml`'s `[features]`
 * table. Named here so P2.7's mapping has one place to bind, and so the two
 * spellings of one policy are visible side by side.
 */
export const CODEX_IN_APP_UPDATES_FEATURE_KEY = 'in_app_updates'

/**
 * Read {@link MANAGED_IN_APP_UPDATES_KEY} out of a managed settings record.
 *
 * Only a literal boolean counts. Anything else — a string `"true"`, a number, a
 * missing key — reads as "unset", which leaves updates working: a malformed
 * managed value must not silently disable a security-update channel, and it
 * must not silently enable one either, so it decides nothing at all.
 */
export function readManagedInAppUpdatesDisabled(
  source: Record<string, unknown> | null | undefined,
): boolean | undefined {
  const value = source?.[MANAGED_IN_APP_UPDATES_KEY]
  return typeof value === 'boolean' ? value : undefined
}

/**
 * The reader for THIS process.
 *
 * Process-scoped for the reason `managed-model-allowlist.ts` states for its own
 * registry: the managed policy is a property of the host process, composed once
 * at bootstrap, while the read happens deep inside the updater.
 */
let managedInAppUpdatesDisabledProvider: (() => boolean | undefined) | undefined

/** The codex tier's last answer. `undefined` until a codex runtime reports one. */
let codexInAppUpdatesDisabled: boolean | undefined

/**
 * Listeners that want to hear when either tier changes its answer.
 *
 * P2.7 clause (b). The registrars are the trigger point rather than each of
 * their callers, because the caller that mattered most is the one nobody would
 * remember to instrument: the codex `configRequirements` read lands whenever the
 * first codex runtime starts, long after the settings page rendered. Anchoring
 * the notification to the WRITE means every present and future writer flips a
 * live page, and the electron host subscribes exactly once.
 */
const managedInAppUpdatesListeners = new Set<() => void>()

/**
 * Subscribe to managed in-app-update policy changes; returns the unsubscribe.
 *
 * A throwing listener is swallowed: a broken renderer broadcast must not take
 * down the policy write that triggered it, and the write has already happened by
 * the time listeners run.
 */
export function subscribeManagedInAppUpdatesChange(listener: () => void): () => void {
  managedInAppUpdatesListeners.add(listener)
  return () => { managedInAppUpdatesListeners.delete(listener) }
}

function notifyManagedInAppUpdatesChanged(): void {
  for (const listener of [...managedInAppUpdatesListeners]) {
    try { listener() } catch { /* a broken listener is not the policy's problem */ }
  }
}

/**
 * Register the managed in-app-updates reader — the HOST policy tier.
 *
 * Mirrors {@link registerManagedRetentionDaysProvider} /
 * {@link registerManagedSandboxEnabledProvider} in `storage.ts` exactly,
 * including the null case: an unregistered provider means "no managed value",
 * which is every non-managed install and every test that never calls this.
 *
 * Notifies {@link subscribeManagedInAppUpdatesChange} on every call, including
 * the de-registration a test does in its `afterEach` — the policy's answer
 * changed either way, and a subscriber that has to guess when to re-read is a
 * subscriber that will guess wrong.
 */
export function registerManagedInAppUpdatesDisabledProvider(
  provider: (() => boolean | undefined) | undefined,
): void {
  managedInAppUpdatesDisabledProvider = provider
  notifyManagedInAppUpdatesChanged()
}

/**
 * Record what a codex app-server's `configRequirements` said — the CODEX tier.
 *
 * `true` means the deployed `requirements.toml` carries
 * `[features] in_app_updates = false`. `undefined` clears the tier, which is
 * what a server that reports no requirement (or a probe that could not run)
 * says: a codex runtime that fails to answer must not be read as an
 * administrator turning updates off.
 */
export function recordCodexInAppUpdatesRequirement(disabled: boolean | undefined): void {
  const next = typeof disabled === 'boolean' ? disabled : undefined
  if (next === codexInAppUpdatesDisabled) return
  codexInAppUpdatesDisabled = next
  notifyManagedInAppUpdatesChanged()
}

/**
 * What the managed layer says, or `undefined` when it says nothing —
 * unregistered provider, a provider that returns `undefined`, or one that
 * throws. A throwing provider is tolerated rather than propagated for the same
 * reason `readManagedRetentionDays` tolerates one: an unreadable policy file
 * must not take the app down on the update path.
 *
 * TIGHTEST WINS across the two tiers: either saying `true` is `true`. Only when
 * neither disables and at least one answered does this report `false`, so
 * "nobody has an opinion" stays distinguishable from "an administrator says
 * updates are allowed".
 */
export function resolveManagedInAppUpdatesDisabled(): boolean | undefined {
  let host: boolean | undefined
  try {
    const value = managedInAppUpdatesDisabledProvider?.()
    host = typeof value === 'boolean' ? value : undefined
  } catch {
    host = undefined
  }
  if (host === true || codexInAppUpdatesDisabled === true) return true
  if (host === false || codexInAppUpdatesDisabled === false) return false
  return undefined
}

/**
 * The single predicate every update entry point asks.
 *
 * Only an explicit `true` disables: `false` and "unset" are both "updates
 * work", which keeps a managed deployment that spells the key `false` on the
 * same path as an unmanaged one.
 */
export function areInAppUpdatesManagedDisabled(): boolean {
  return resolveManagedInAppUpdatesDisabled() === true
}

/**
 * WHICH administrator's document turned updates off — P3.240.
 *
 * ## The residue this closes, and the two claims it corrects on the way
 *
 * P3.240 said managed policy has no operator-facing surface at all, that
 * {@link areInAppUpdatesManagedDisabled} has no renderer consumer, and that the
 * "Managed" indicator in Settings the docblock above cites does not exist. All
 * three are false, and measuring them is what left the real gap visible:
 *
 *  - the predicate is main-process by design and its ANSWER reaches the renderer
 *    as `UpdateInfo.managedDisabled` (`main/auto-update.ts`);
 *  - the indicator was built by P2.10 — `isUpdatesManagedOff` in
 *    `renderer/pages/settings/AppSettingsPage.tsx`, rendering
 *    `settings.about.updatesManaged` under a disabled "Check now";
 *  - `subscribeManagedInAppUpdatesChange` already flips that page mid-session.
 *
 * What the indicator could NOT say is whose decision it was. Two tiers write
 * this switch and they are two different documents, in two different places,
 * remediated by two different people: the host's composed `managed-policy.json`
 * (file or server-delivered, present from bootstrap) and a codex deployment's
 * `requirements.toml` (read by `configRequirements/read`, and only ARMED once
 * the first codex runtime of the process has started). "Your organization's
 * policy disables in-app updates" is true of both and actionable for neither.
 *
 * ## Why a source and not a whole managed-policy page
 *
 * The smallest honest thing: this pairs with the surface that already exists
 * rather than inventing a second one, and it adds one muted line to the card the
 * user is already looking at. It reports only what the two tiers already answer
 * — no new reader, no new persistence, no new channel.
 *
 * ## What it returns
 *
 * The tiers that said `true`, because only `true` disables — a tier answering
 * `false` has an opinion but is not the reason anything is off. `undefined`
 * whenever updates are not disabled, so the source and the predicate can never
 * disagree: there is no state in which this names a tier and
 * {@link areInAppUpdatesManagedDisabled} is `false`.
 */
export type ManagedInAppUpdatesSourceV1 = 'host' | 'codex' | 'both'

export function resolveManagedInAppUpdatesSource(): ManagedInAppUpdatesSourceV1 | undefined {
  let host: boolean | undefined
  try {
    const value = managedInAppUpdatesDisabledProvider?.()
    host = typeof value === 'boolean' ? value : undefined
  } catch {
    host = undefined
  }
  const hostDisables = host === true
  const codexDisables = codexInAppUpdatesDisabled === true
  if (hostDisables && codexDisables) return 'both'
  if (hostDisables) return 'host'
  if (codexDisables) return 'codex'
  return undefined
}
