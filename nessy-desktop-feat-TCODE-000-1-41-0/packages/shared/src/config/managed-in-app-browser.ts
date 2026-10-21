/**
 * The managed kill switch for the app's OWN built-in browser — P2.399.
 *
 * ## What it is, and what P2.373 left open
 *
 * An organization that manages this install can forbid the desktop host from
 * opening its built-in browser. Codex states the same capability as the
 * `[features]` `in_app_browser = false` entry of a deployed
 * `requirements.toml` — *"Disable the desktop app's built-in browser"*.
 *
 * P2.373 measured, at the STRONG tier (`github.com/openai/codex` at
 * `rust-v0.150.1`, `codex-rs/features/src/lib.rs`, the `FEATURES` registry
 * entries `Feature::InAppBrowser` and `Feature::InAppUpdates`), that
 * `in_app_browser` and `in_app_updates` are `Stage::Stable,
 * default_enabled: true` registry entries with NO consumer in
 * `feature_configs.rs`. One word of that is RETIRED rather than re-stamped: it
 * said the two were ADJACENT, and at the new tag `in_app_chat` and
 * `in_app_dictation` sit between them, so the argument rests on the two entries
 * being identical in SHAPE and not on where they sit. Codex does not act on either; `ManagedFeatures` pins the
 * FLAG, and pinning a flag is not enforcing the thing the flag names. The twin
 * settles who the subject is: a fleet disabling `in_app_updates` is asking the
 * DESKTOP HOST to stop updating, which is why `managed-in-app-updates.ts`
 * exists. `in_app_browser` asks the same host to stop opening
 * `apps/electron/src/main/browser-pane-manager.ts`, which codex cannot reach
 * from inside its own process.
 *
 * So P2.373 closed the FALSE ASSURANCE (the report stopped claiming the control
 * was in force) and left the control itself absent. This module plus the gate in
 * `browser-pane-manager.ts` is the control.
 *
 * ## The posture, which is a product decision and is stated here on purpose
 *
 * Three postures were available and they are not interchangeable, because they
 * differ in what a user can TELL: no pane at all, a pane that opens and refuses
 * to navigate, or a pane restricted to an allowlist. The posture chosen is
 * **NO PANE AT ALL, with the affordance kept and REFUSING by name**:
 *
 *  - the allowlist posture was rejected because there is nothing to read it
 *    from. `in_app_browser` is a BOOLEAN in `requirements.toml`'s `[features]`
 *    table and there is no host-side allowlist key either. Building one would
 *    be inventing a mechanism where the documentation speaks, and the thing it
 *    says is "disable".
 *  - the refusing-pane posture was rejected because a chromeless window with
 *    tabs and a toolbar that cannot load anything is the failure mode this row
 *    names outright: indistinguishable from a bug.
 *  - the affordance is NOT hidden, which is the twin's documented posture for
 *    exactly this class —
 *    `learn.chatgpt.com/docs/enterprise/manage-app-updates.md#verify-the-managed-setting`:
 *    "The **Check for Updates** menu option can remain visible even when the
 *    policy blocks in-app updates". (Host prefix added by P2.377: that is a
 *    codex page, and cited bare it read as a Claude one — it 404s on
 *    `code.claude.com/docs/en/` and is in no corpus page, measured 2026-09-03.)
 *    The entry point stays and refuses with a legible reason, so the
 *    user reads *your administrator disabled this* rather than meeting a button
 *    that vanished.
 *
 * A pane already open when the policy arrives is CLOSED, not left running: the
 * codex tier lands whenever the first codex runtime of the process starts, long
 * after a window could have been opened, and "no NEW pane" is not what
 * "disable the built-in browser" says.
 *
 * ## Why the key lives here and not on `ManagedPiPolicyV1` alone
 *
 * Same reason the twin gives: this switch governs the ELECTRON HOST, not an
 * agent session, and its consumer (`main/browser-pane-manager.ts`) has no parsed
 * policy object in hand and cannot grow a dependency on the Pi harness to get
 * one. The value arrives through a registered reader instead of an import.
 *
 * This module is deliberately import-free (like `managed-in-app-updates.ts` and
 * `managed-model-allowlist.ts`): it is reachable from the
 * `@nessy-agent/shared/config` barrel, which the Vite renderer bundles, and a
 * transitive `node:` import through that barrel breaks the renderer build.
 *
 * ## Who sets it — TWO tiers, and BOTH are fed
 *
 *  - {@link registerManagedInAppBrowserDisabledProvider} — the HOST policy tier,
 *    fed by the composed `managed-policy.json` (file or server-delivered)
 *    through `ManagedPiPolicyV1.disableInAppBrowser`. Landed with P2.399.
 *  - {@link recordCodexInAppBrowserRequirement} — the CODEX tier, fed by
 *    `configRequirements/read` after a codex app-server `initialize`. Bound in
 *    P2.463 by one call in `agent/codex-agent.ts`, beside the twin's
 *    `recordCodexInAppUpdatesRequirement(requirements.inAppUpdatesDisabled)` and
 *    inside the same `requirementAnswered` guard — a probe that FAILED, or that
 *    found the method absent, must leave the tier standing rather than clear a
 *    disable an administrator deployed. That is P2.137's measurement, and it
 *    applies here for the same reason it applied to the updates tier: the
 *    reading is `undefined` for a transport hiccup exactly as it is for "the
 *    server carries no requirement", and those are not one fact.
 *
 * P2.399 landed the codex tier ARMED AND UNFED and stated it in four places,
 * because a half-built gate that reads as closed is the defect this plan keeps
 * finding. P2.463 fed it, so all four statements moved in the SAME commit as the
 * call — including the one that used to sit here, which is why the codex
 * spelling of this switch now lives in this module.
 *
 * ## One switch, two spellings, one home for both
 *
 * {@link MANAGED_IN_APP_BROWSER_KEY} is the host spelling and
 * {@link CODEX_IN_APP_BROWSER_FEATURE_KEY} the codex one. Both live here and
 * `agent/codex-config-requirements.ts` RE-EXPORTS the second rather than
 * declaring it — exactly the twin's arrangement — so the two spellings of one
 * policy are visible side by side and neither can be renamed alone. The codex
 * key used to be declared there instead, on the stated ground that "this build
 * has no consumer to import it from"; that was true until the gate landed, and
 * it is why the move belongs in the binding commit rather than a later tidy-up.
 *
 * ## Precedence
 *
 * TIGHTEST WINS, and only in the disabling direction: any tier that says `true`
 * disables. Same reasoning as the twin — the two tiers answer one question from
 * two administrators who are in practice the same administrator, and the
 * alternative (one slot, last writer wins) makes a codex session start quietly
 * re-enable a browser an MDM policy had turned off.
 */

/**
 * The managed key name, and the host-policy spelling of this switch.
 *
 * Exported as a constant because the writer (`ManagedPiPolicyV1`, in
 * `agent/pi-harness/managed-policy.ts`) and the readers are in different
 * packages, and a key spelled twice is a key that eventually disagrees with
 * itself.
 *
 * The name mirrors the twin's `disableInAppUpdates` on purpose. There is no
 * documented Claude spelling to defer to instead: probed on
 * `scripts/claude-doc-pages.tsv` (snapshot 2026-08-25, 191 pages),
 * `grep -ai 'browser'` matches ZERO pages, with `settings` → 13 as the positive
 * control that the probe reads the file. Claude's corpus names no built-in
 * browser surface at all, so the nearest documented solution is this repo's own
 * established convention for a host-facing codex `[features]` switch.
 */
export const MANAGED_IN_APP_BROWSER_KEY = 'disableInAppBrowser'

/**
 * The codex spelling of the same policy, in `requirements.toml`'s `[features]`
 * table — *"Disable the desktop app's built-in browser"*.
 *
 * Here rather than in `agent/codex-config-requirements.ts` for the twin's
 * reason: that module re-exports it, so P2.463's mapping has one place to bind
 * and the two spellings of one policy are visible side by side.
 *
 * `false` is the disabling value, which is the opposite polarity to
 * {@link MANAGED_IN_APP_BROWSER_KEY}'s `true` — codex's table states a feature's
 * AVAILABILITY and ours states a restriction. That inversion is why
 * {@link recordCodexInAppBrowserRequirement} takes the already-normalised
 * `disabled` boolean rather than the raw wire value.
 */
export const CODEX_IN_APP_BROWSER_FEATURE_KEY = 'in_app_browser'

/**
 * The reader for THIS process.
 *
 * Process-scoped for the reason `managed-in-app-updates.ts` gives for its own:
 * the managed policy is a property of the host process, composed once at
 * bootstrap, while the read happens deep inside the browser pane manager.
 */
let managedInAppBrowserDisabledProvider: (() => boolean | undefined) | undefined

/** The codex tier's last answer. `undefined` until a codex runtime reports one. */
let codexInAppBrowserDisabled: boolean | undefined

/**
 * Listeners that want to hear when either tier changes its answer.
 *
 * Anchored to the WRITE rather than to each writer's callers, for the twin's
 * reason: the caller that matters most is the one nobody would remember to
 * instrument — a codex `configRequirements` read that lands whenever the first
 * codex runtime starts, long after a browser window was opened. The pane manager
 * subscribes exactly once and closes what the policy now forbids.
 */
const managedInAppBrowserListeners = new Set<() => void>()

/**
 * Subscribe to managed in-app-browser policy changes; returns the unsubscribe.
 *
 * A throwing listener is swallowed: a broken subscriber must not take down the
 * policy write that triggered it, and the write has already happened by the time
 * listeners run.
 */
export function subscribeManagedInAppBrowserChange(listener: () => void): () => void {
  managedInAppBrowserListeners.add(listener)
  return () => { managedInAppBrowserListeners.delete(listener) }
}

function notifyManagedInAppBrowserChanged(): void {
  for (const listener of [...managedInAppBrowserListeners]) {
    try { listener() } catch { /* a broken listener is not the policy's problem */ }
  }
}

/**
 * Register the managed in-app-browser reader — the HOST policy tier.
 *
 * Mirrors {@link registerManagedInAppUpdatesDisabledProvider} exactly, including
 * the null case: an unregistered provider means "no managed value", which is
 * every non-managed install and every test that never calls this.
 *
 * Notifies on every call, including the de-registration a test does in its
 * `afterEach` — the policy's answer changed either way, and a subscriber that
 * has to guess when to re-read is a subscriber that will guess wrong.
 */
export function registerManagedInAppBrowserDisabledProvider(
  provider: (() => boolean | undefined) | undefined,
): void {
  managedInAppBrowserDisabledProvider = provider
  notifyManagedInAppBrowserChanged()
}

/**
 * Record what a codex app-server's `configRequirements` said — the CODEX tier.
 *
 * `true` means the deployed `requirements.toml` carries
 * `[features] in_app_browser = false`. `undefined` clears the tier, which is
 * what a server reporting no requirement says: an administrator withdrawing the
 * requirement has to take effect.
 *
 * FED since P2.463, by `agent/codex-agent.ts`'s spawn path. The `undefined`
 * clear is therefore load-bearing in one direction only, and the CALLER carries
 * the other half: it writes this tier only when the probe ANSWERED
 * (`status` `read` or `none`), because a `failed` or `unsupported` probe produces
 * the same `undefined` reading as "no requirement" and clearing on it would
 * silently re-open a browser an administrator had closed. This registrar's
 * contract is unchanged and correct at its own layer — see P2.137, which
 * measured exactly that split on the twin.
 */
export function recordCodexInAppBrowserRequirement(disabled: boolean | undefined): void {
  const next = typeof disabled === 'boolean' ? disabled : undefined
  if (next === codexInAppBrowserDisabled) return
  codexInAppBrowserDisabled = next
  notifyManagedInAppBrowserChanged()
}

function readHostTier(): boolean | undefined {
  try {
    const value = managedInAppBrowserDisabledProvider?.()
    return typeof value === 'boolean' ? value : undefined
  } catch {
    // An unreadable policy file must not take the app down on the browser path,
    // for the reason `readManagedRetentionDays` tolerates a throwing provider.
    return undefined
  }
}

/**
 * What the managed layer says, or `undefined` when it says nothing —
 * unregistered provider, a provider that returns `undefined`, or one that
 * throws.
 *
 * TIGHTEST WINS across the two tiers: either saying `true` is `true`. Only when
 * neither disables and at least one answered does this report `false`, so
 * "nobody has an opinion" stays distinguishable from "an administrator says the
 * browser is allowed".
 */
export function resolveManagedInAppBrowserDisabled(): boolean | undefined {
  const host = readHostTier()
  if (host === true || codexInAppBrowserDisabled === true) return true
  if (host === false || codexInAppBrowserDisabled === false) return false
  return undefined
}

/**
 * The single predicate every browser entry point asks.
 *
 * Only an explicit `true` disables: `false` and "unset" are both "the browser
 * works", which keeps a managed deployment that spells the key `false` on the
 * same path as an unmanaged one.
 */
export function isInAppBrowserManagedDisabled(): boolean {
  return resolveManagedInAppBrowserDisabled() === true
}

/**
 * WHICH administrator's document turned the browser off.
 *
 * Two tiers write this switch and they are two different documents, in two
 * different places, remediated by two different people: the host's composed
 * `managed-policy.json` and a codex deployment's `requirements.toml`. "Your
 * organization's policy disables the built-in browser" is true of both and
 * actionable for neither, so the refusal names the tier.
 *
 * Returns only the tiers that said `true`, because only `true` disables — a tier
 * answering `false` has an opinion but is not the reason anything is off.
 * `undefined` whenever the browser is not disabled, so the source and the
 * predicate can never disagree: there is no state in which this names a tier and
 * {@link isInAppBrowserManagedDisabled} is `false`.
 */
export type ManagedInAppBrowserSourceV1 = 'host' | 'codex' | 'both'

export function resolveManagedInAppBrowserSource(): ManagedInAppBrowserSourceV1 | undefined {
  const hostDisables = readHostTier() === true
  const codexDisables = codexInAppBrowserDisabled === true
  if (hostDisables && codexDisables) return 'both'
  if (hostDisables) return 'host'
  if (codexDisables) return 'codex'
  return undefined
}

/**
 * The refusal sentence every entry point shares.
 *
 * Here rather than in the pane manager so the host tier, the codex tier and any
 * later entry point cannot drift into three different English strings for one
 * policy — and so the sentence names the document to go and fix, which is the
 * whole difference between "your administrator disabled this" and a dead button.
 */
export function describeManagedInAppBrowserRefusal(): string {
  const source = resolveManagedInAppBrowserSource()
  const document = source === 'codex'
    ? "a codex deployment's requirements.toml ([features] in_app_browser = false)"
    : source === 'both'
      ? "your organization's managed policy AND a codex requirements.toml"
      : "your organization's managed policy (disableInAppBrowser)"
  return `The built-in browser is disabled by ${document}. `
    + 'Ask whoever manages this install to change that policy; nothing in the app can re-enable it.'
}

/**
 * P6.536 — the CDP lock, and it is a SEPARATE switch from the pane's.
 *
 * `done_means`, verbatim: *"an administrator can lock CDP off SEPARATELY from
 * the pane"*. Reading a page and driving its DevTools are different powers, and
 * an operator who is content for people to browse documentation may still not
 * want an agent attaching a debugger to it — which the all-or-nothing
 * `disableInAppBrowser` could only express by taking the browser away entirely.
 *
 * Modelled on {@link registerManagedInAppBrowserDisabledProvider} in every
 * respect, with ONE deliberate difference: there is no codex tier. codex
 * publishes `browser_use_full_cdp_access` in the vendored
 * `packages/codex-protocol/schema/config-schema.json`, but P2.373 measured that
 * codex does not act on its own `in_app_browser` flag at all, and the pane is
 * OUR Electron surface — so a codex tier here would be a second opinion about a
 * debugger codex never attaches. If that changes, add the tier the way the twin
 * above did rather than widening this one.
 *
 * The pane switch still dominates: a disabled browser has no page to attach to.
 * That is enforced by construction rather than by a rule here — the attach gate
 * runs inside a pane, and a forbidden pane never opens.
 */
let managedBrowserCdpDisabledProvider: (() => boolean | undefined) | undefined

export function registerManagedBrowserCdpDisabledProvider(
  provider: (() => boolean | undefined) | undefined,
): void {
  managedBrowserCdpDisabledProvider = provider
  notifyManagedInAppBrowserChanged()
}

/**
 * The single predicate the CDP attach gate asks.
 *
 * Only an explicit `true` disables — `false` and unset both mean the debugger
 * is permitted, keeping a managed deployment that spells the key `false` on the
 * same path as an unmanaged one. A throwing provider reads as no opinion, for
 * the reason `readHostTier` tolerates one: an unreadable policy file must not
 * take the app down on the browser path.
 */
export function isBrowserCdpManagedDisabled(): boolean {
  try {
    return managedBrowserCdpDisabledProvider?.() === true
  } catch {
    return false
  }
}

/**
 * P6.338 — the GRADED browser controls, between "the pane is gone" and nothing.
 *
 * ## What changed since this module's docblock rejected an allowlist
 *
 * It rejected one on the ground that *"there is no host-side allowlist key
 * either. Building one would be inventing a mechanism where the documentation
 * speaks, and the thing it says is 'disable'."* That was true of the ONE key
 * P2.399 had — codex's `[features] in_app_browser` boolean. It is no longer the
 * whole documentation: `settings-reference.md`'s §Tools now publishes
 * `disableBrowserExternalNavigation` and `browserExternalPageTools`, both scope
 * `Managed`, and `desktop.md#restrict-which-ssh-hosts-users-can-connect-to`
 * publishes `sshHostAllowlist` — a host-pattern allowlist read from managed
 * settings only. So the graded posture is now the documented one, and the
 * allowlist has a documented SHAPE to copy rather than one to invent.
 *
 * ## Three locks, one classifier, and the gate that already exists
 *
 * These are LOCKS the existing `browser-trust-gate.ts` consumes, never a second
 * gate. The consequence is the whole point of putting them there: **a managed
 * refusal outranks a user's stored "Always allow"** (the gate asks the
 * administrator first and the store second), and **a managed ALLOW does not
 * skip the card** — being on the allowlist means the person may still be asked,
 * because the operator's list answers "may this origin be reached at all", not
 * "does this person trust it".
 *
 * ## Host-side for all three runtimes, measured rather than preferred
 *
 * None of the vendor keys is in the vendored `2.1.247` bundle — re-measured
 * 2026-09-12 (C3.252) with a positive control in the SAME probe run, as
 * AGENTS.md requires of an absence claim: `disableBrowserExternalNavigation`,
 * `disableBrowserCdp` and `browserHostAllowlist` all 0 lines / 0 occurrences
 * against `companyAnnouncements` 4/5. And each is
 * documented with *"The desktop app reads this key; the terminal CLI ignores
 * it"* — every claude child we spawn is that CLI. There is no native mechanism
 * to enable, so the host is the only seam, and it is the same seam on Pi,
 * claude and codex.
 */
export type ManagedBrowserNavigationActorV1 = 'agent' | 'person'

let managedBrowserExternalNavigationDisabledProvider: (() => boolean | undefined) | undefined
let managedBrowserHostAllowlistProvider: (() => readonly string[] | undefined) | undefined
let managedBrowserExternalPageToolsDisabledProvider: (() => boolean | undefined) | undefined

export function registerManagedBrowserExternalNavigationDisabledProvider(
  provider: (() => boolean | undefined) | undefined,
): void {
  managedBrowserExternalNavigationDisabledProvider = provider
  notifyManagedInAppBrowserChanged()
}

export function registerManagedBrowserHostAllowlistProvider(
  provider: (() => readonly string[] | undefined) | undefined,
): void {
  managedBrowserHostAllowlistProvider = provider
  notifyManagedInAppBrowserChanged()
}

export function registerManagedBrowserExternalPageToolsDisabledProvider(
  provider: (() => boolean | undefined) | undefined,
): void {
  managedBrowserExternalPageToolsDisabledProvider = provider
  notifyManagedInAppBrowserChanged()
}

/**
 * Is this URL somewhere OTHER than this machine?
 *
 * Both vendor keys exempt localhost in the same words — *"Localhost dev server
 * previews keep working"* — so the exemption is the documented behaviour rather
 * than a convenience. A non-`http(s)` URL is not an external navigation at all:
 * `about:blank`, a `file:` preview and the pane's own internal pages are not
 * egress, and treating them as external would break the pane under every lock.
 *
 * An UNPARSEABLE url reads as external. A lock that cannot tell where it is
 * being pointed must not conclude "somewhere safe".
 */
export function isExternalBrowserNavigation(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return true
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  if (host === '::1' || host === '0.0.0.0') return false
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return false
  return true
}

/**
 * Does a hostname match one allowlist pattern?
 *
 * `sshHostAllowlist`'s shape: an exact hostname, or a `*.` label wildcard in
 * front of one (`"*.devboxes.example.com"`). The wildcard requires at least one
 * label, so `*.example.com` admits `docs.example.com` and NOT the bare
 * `example.com` — an operator who wants both writes both, which is the reading
 * that cannot silently admit a registrable domain nobody listed.
 */
export function browserHostMatchesManagedPattern(host: string, pattern: string): boolean {
  const subject = host.toLowerCase().replace(/^\[|\]$/g, '')
  const rule = pattern.trim().toLowerCase()
  if (rule.length === 0) return false
  if (!rule.startsWith('*.')) return subject === rule
  const suffix = rule.slice(1)
  return subject.length > suffix.length && subject.endsWith(suffix)
}

function readBoolean(provider: (() => boolean | undefined) | undefined): boolean {
  try {
    return provider?.() === true
  } catch {
    // An unreadable policy must not take the app down on the browser path — the
    // reason `readHostTier` above tolerates a throwing provider.
    return false
  }
}

/**
 * WHY this navigation is refused, or `undefined` when nothing refuses it.
 *
 * Returns the sentence rather than a boolean, for
 * {@link describeManagedInAppBrowserRefusal}'s reason: the refusal has to name
 * the KEY an administrator would go and change, and three locks with one
 * message would send them to the wrong one.
 *
 * Order is tightest-first, so an operator who set two keys is told about the
 * one that would still refuse after they relaxed the other.
 */
export function resolveManagedBrowserNavigationRefusal(
  url: string,
  actor: ManagedBrowserNavigationActorV1,
): string | undefined {
  if (!isExternalBrowserNavigation(url)) return undefined

  if (readBoolean(managedBrowserExternalNavigationDisabledProvider)) {
    return "Your organization's managed policy turns off external browsing in the built-in browser "
      + '(disableBrowserExternalNavigation). Local dev server previews keep working. '
      + 'Ask whoever manages this install to change that policy.'
  }

  let allowlist: readonly string[] | undefined
  try {
    allowlist = managedBrowserHostAllowlistProvider?.()
  } catch {
    allowlist = undefined
  }
  if (allowlist !== undefined) {
    let host = ''
    try { host = new URL(url).hostname } catch { host = '' }
    const permitted = host.length > 0
      && allowlist.some(pattern => browserHostMatchesManagedPattern(host, pattern))
    if (!permitted) {
      return `${host.length > 0 ? host : url} is not on your organization's browser allowlist `
        + '(browserHostAllowlist). Local dev server previews keep working. '
        + 'Ask whoever manages this install to add it.'
    }
  }

  // LAST, and only for the agent: this key is the one that leaves the person's
  // own browsing alone — "People in your organization can still open external
  // sites themselves". A refusal here is about Claude's tools, so it must not
  // fire on a navigation the person drove.
  if (actor === 'agent' && readBoolean(managedBrowserExternalPageToolsDisabledProvider)) {
    return "Your organization's managed policy keeps Claude's tools off external pages "
      + '(browserExternalPageTools: "disabled"). You can still open this site yourself, and local '
      + 'dev server previews keep working with the agent.'
  }

  return undefined
}
