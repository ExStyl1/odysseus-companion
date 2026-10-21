/**
 * Composing the two admin-controlled managed sources.
 *
 * We have exactly two, and they are the two the documentation names:
 *
 * - the SERVER-managed source — the delivered payload (`managed-delivery.ts`),
 *   live from a fetch or read back from the 0600 cache;
 * - the ENDPOINT-managed source — the host-owned policy FILE,
 *   `managed-policy.json` plus its `managed-policy.d/` fragments
 *   (`pi-harness/managed-policy-loader.ts`).
 *
 * ## The rule, and why it is not a merge
 *
 * `server-managed-settings.md#settings-precedence` puts both in the highest
 * tier: "Server-managed settings and endpoint-managed settings both occupy the
 * highest tier in the Claude Code settings hierarchy. No other settings level
 * can override them, including command line arguments, apart from the exceptions
 * to managed settings precedence." That sentence is about the tier's
 * relationship to everything BELOW it, and it is easy to read as *peers, so
 * merge them*. The next paragraph says the opposite:
 *
 * Same section — "Within the managed tier, Claude Code by default uses the first
 * source that delivers at least one policy key, checking server-managed settings
 * first and then endpoint-managed settings, apart from the exception keys covered
 * next."
 *
 * `managed-settings.md#how-claude-code-combines-managed-sources` states it from
 * the settings side and orders the whole tier — under the default
 * `"first-wins"`, Claude Code "uses the highest-ranked source that delivers at
 * least one policy key and ignores the rest rather than merging them, apart from
 * the few keys in Keys read from every admin source"; remote > MDM > file-based
 * > HKCU, with a `policyHelper`'s output replacing its own source.
 *
 * THREE of the sentences this block used to quote no longer exist on any page in
 * the corpus, which is why it now cites sections rather than lines (P3.209). The
 * losses were not cosmetic and no renumbering would have surfaced them: the
 * first quote was cut before "apart from the exceptions to managed settings
 * precedence", so it asserted an absolute the page does not; "Sources don't
 * merge" is gone outright, replaced by a "by default" that names
 * `managedSourcesBehavior`; and "non-empty configuration" is now "at least one
 * policy key", which the page defines as excluding the two control keys. Read
 * the sections, not this paragraph's memory of them.
 *
 * So the composition is WINNER-TAKES-ALL, not a union: a delivered payload that
 * carries any setting replaces the file policy wholesale. Both sources belong to
 * the same administrator, and a rule that unioned them would make it impossible
 * for that administrator to RELAX anything from the console — every stale deny
 * rule left on a disk image would outlive the policy that replaced it.
 *
 * ## `managedSourcesBehavior` — the switch this module does NOT honour (P3.290)
 *
 * The paragraph above used to rest on an absolute the corpus no longer states,
 * and P3.209 caught the quote going missing without following what its
 * replacement meant. Winner-takes-all is now the DEFAULT, not the law:
 * `settings-reference.md#managedsourcesbehavior` gives the key two values —
 * *"`"first-wins"`: the highest-priority source that carries a policy key
 * supplies the policy, and lower sources contribute only the keys Claude Code
 * reads from every admin source"* and *"`"merge"`: every admin source you
 * deliver contributes its keys, combined by the rules below"* — with
 * *"**Default**: `"first-wins"`"*. What this module implements is exactly
 * `"first-wins"`.
 *
 * The key is REFUSED BY NAME rather than honoured, and the whole argument sits
 * beside the refusal, in `pi-harness/managed-policy.ts`'s
 * `DOCUMENTED_UNENFORCED_KEYS`. In one line each: the vendor's mechanism
 * combines the four sources the binary reads for ITSELF, where our two are
 * composed here and handed down already resolved, so there is no native switch
 * to enable; honouring `"merge"` means re-implementing the six-rule per-kind
 * algebra of `managed-settings.md#compose-every-managed-source` for a key the
 * page dates *"Requires Claude Code v2.1.242 or later"* against a vendored
 * 2.1.233; and ignoring it leaves the STRICTER composition in force, because
 * `"merge"` is a widening in the page's own words — *"Claude Code then adds
 * entries from a lower source, such as `permissions.allow` rules, to the
 * policy."*
 *
 * ONE ARM OF THAT IS NOT STRICTLY SAFE, named rather than glossed: a LOCK set
 * only in the LOSING source is applied under `"merge"` (*"Applies the strictest
 * value any source sets"*) and dropped under first-wins. For the documented
 * cross-source lock keys this module already honours either source in both
 * directions, so the exposure is a lock OUTSIDE that set — of which our schema's
 * are `allowPluginHooks`, `channelsEnabled` and
 * `sandbox.allowUnsandboxedCommands`, all of which enforce at `false`. An
 * administrator who needs one of those from the losing source has to put it in
 * the winning one, and the refusal message says the composition is first-wins so
 * that conclusion is reachable from the diagnostic alone.
 *
 * **One of those three reasons has EXPIRED and the verdict stands on the other
 * two (P7.1's XS remainder, re-measured 2026-09-11 at the vendored `0.3.247`;
 * re-taken 2026-09-17 at `0.3.251` for I2.1 — the same 1 / 6 / 8, and
 * `sdk.d.ts` is byte-identical on this key between the two versions, so the
 * paragraph below needs no number changed. The page still gives `"first-wins"`
 * as the default, in the key's own declaration: "Controls how the managed
 * settings sources compose. \"first-wins\" (default): the highest-priority
 * source present … is the managed tier alone." What DID arrive beside it is a
 * second behaviour key, `parentSettingsBehavior`, and it is not a duplicate of
 * this one and not unread here: it governs whether the SDK PARENT tier — our own
 * `Options.managedSettings` — layers under an admin tier, and it is
 * `claude-managed-settings.ts` that reads it, under P6.234, which detects an
 * admin source on the machine and says that our whole slice is discarded rather
 * than merged. Two keys, two tiers, one already answered).**
 * The middle clause used to end *"for a key the page dates 'Requires Claude Code
 * v2.1.242 or later' against a vendored 2.1.233"*, and the bundle has since
 * crossed that line: `managedSourcesBehavior` scores 1 in `sdk.d.ts`, 6 in
 * `sdk.mjs` and 8 in the native binary, against `nessyNotARealSdkKey` -> 0. It is
 * struck rather than renumbered, because a cost sentence that reads like a
 * version wait invites the next reader to conclude the wait is over. What is
 * left is the part that never depended on a version: there is no native switch
 * to enable for OUR two sources, the per-kind algebra is still ours to write if
 * we ever say yes, and refusing keeps the stricter composition in force.
 * Adopting it is therefore a size-M build whose outcome is a WIDENING — an
 * owner's call, not a lift's.
 *
 * ## The cross-source exception
 *
 * A small set of keys is read from EVERY admin source rather than only the
 * winning one. The list this module used to cite by line is dead at the PAGE
 * level: `settings.md` split, and the enumeration now lives at
 * `managed-settings.md#keys-read-from-every-admin-source` (fetched 2026-08-31),
 * whose §-intro sentence is "A few keys work differently. Claude Code reads them
 * from every admin source, so a lower-ranked MDM policy or managed settings file
 * can still set them when the selected source doesn't." The same section excludes
 * the user-writable HKCU tier, which we do not have: both of our sources are
 * admin-controlled, so both are read for these keys. The rule holds under BOTH
 * values of `managedSourcesBehavior` — the `"first-wins"` bullet exempts "the
 * few keys in Keys read from every admin source", and the `"merge"` bullet sends
 * the reader to `managed-settings.md#compose-every-managed-source` for how each
 * kind of key combines. So this section states the part of the contract that
 * holds whichever way P3.290 went, which is why refusing the key leaves it
 * untouched.
 *
 * Of that set we implement THREE keys — the two that were here, plus the sandbox
 * FILESYSTEM lock, which this comment asserted had "no counterpart in our
 * schema" and does (P6.2, measured 2026-08-31):
 *
 * - `forceRemoteSettingsRefresh`. Already read cross-source at its own
 *   enforcement point in `managed-refresh-gate.ts`; carried here as well so a
 *   reader of the composed policy sees the same answer the gate computes.
 * - `sandbox.network.allowManagedDomainsOnly` together with its associated
 *   allowlist `sandbox.network.allowedDomains`.
 * - `sandbox.filesystem.allowManagedReadPathsOnly` together with its associated
 *   allowlist `sandbox.filesystem.allowRead`. The page names the two locks in ONE
 *   sentence, verbatim: "`sandbox.network.allowManagedDomainsOnly` and
 *   `sandbox.filesystem.allowManagedReadPathsOnly`: a `true` in any admin source
 *   turns the lock on. While a lock is on, Claude Code unions the allowlist it
 *   locks, `sandbox.network.allowedDomains` together with `WebFetch(domain:...)`
 *   allow rules, or `sandbox.filesystem.allowRead`, across every admin source."
 *
 * `allowAllClaudeAiMcps`, `sandbox.bwrapPath` and `sandbox.socatPath` have no
 * counterpart in our schema; there is nothing to compose for them.
 *
 * ## P6.2 — the filesystem twin of P2.136, and it was the LAX side that won
 *
 * P2.136 fixed the network lock. Its filesystem twin was left out on a premise
 * that is false: `SandboxFilesystemSettingsV1.allowManagedReadPathsOnly` and
 * `.allowRead` are both in this repo's schema, both parsed by
 * `parseManagedSandboxSettingsV1`, both enforced by `resolveSandboxSettings`
 * (the lock caps `allowedReadRoots` to the FLOOR's `allowRead`) and both mapped
 * into `Options.managedSettings` by `mapSandbox`. So an administrator whose
 * endpoint-managed FILE carried `allowManagedReadPathsOnly: true` lost the lock
 * outright the moment a delivered payload carried any setting at all — and
 * losing that lock does not fail closed the way the unlocked network allowlist
 * did. It re-opens `allowRead` merging to the user, project and local layers,
 * which is precisely the widening
 * `sandboxing.md#keep-developers-from-widening-the-policy` says the key exists to
 * prevent. The stricter admin value lost to the laxer one, silently, on a
 * security key. That is a DEFECT against the page, not a documented behaviour,
 * and it is fixed by {@link composeFilesystemLock}.
 *
 * ## What P6.2 is NOT, measured, so the next lane does not re-derive it
 *
 * `settings.md#exceptions-to-managed-settings-precedence` (the explicit span
 * anchor `#security-keys-where-the-stricter-value-applies` names the same
 * section) carves out a LOWER-SCOPE exception: "For a few security-sensitive
 * keys, Claude Code honors a restrictive value from a scope that otherwise
 * couldn't override managed settings." Its table lists SEVEN keys, not six —
 * `enableArtifact` (with `disableArtifact`) joined it and needs Claude Code
 * v2.1.242 — and the strict pole is NOT uniform: `true` for
 * `disableClaudeAiConnectors` and `isolatePeerMachines`, `false` for
 * `remoteControlAtStartup`, `useAutoModeDuringPlan`, `syncClaudeAiSkills` and
 * `enableArtifact`, and for `crossSessionInbound` not a boolean at all but the
 * maximum of the `accept` < `hold` < `refuse` ladder.
 *
 * NONE of the seven is a key of {@link ManagedPiPolicyV1} (`grep -ac` over
 * `pi-harness/managed-policy.ts` scores 0 for each; positive control
 * `connectSourcesOnStartup` scores 7), and `refuseUnknownKeys` strips any key
 * outside `MANAGED_PI_POLICY_KEYS`. So no managed source we accept can set one,
 * and the row's headline — a managed `false` overriding a user's stricter `true`
 * on those keys — is not reachable here. The only managed-versus-lower-scope
 * merge in this tree where a managed value wins at the LAX pole is
 * `resolveSandboxEnabled`, and that one is documented: `sandboxing.md`, verbatim,
 * "For boolean keys such as `enabled` and `failIfUnavailable`, Claude Code uses
 * the managed value and ignores anything a developer sets locally." `enabled` is
 * not in the exceptions table, so nothing there needs changing. Every other such
 * merge already resolves at the tighter pole
 * (`resolveConnectSourcesOnStartup`, `resolveAutoCompactionEnabled`,
 * `resolveManagedInAppUpdatesDisabled`, `resolveAutoModeClassifyAllShell`).
 *
 * What is therefore still OPEN, and belongs to whichever lane adds one of the
 * seven to the schema: a managed key from that table needs the lower-scope
 * exception applied at its own resolution point, not the default managed-wins.
 * Adding a strict pole here now would be a control this repo states and does not
 * enforce — the failure class this module exists to avoid — so the seven are left
 * refused at parse, which is the only outcome that cannot be laxer than what the
 * user asked for.
 *
 * ## `env` is the third exception, and it is not a lock
 *
 * The two above are locks: either source turning one on turns it on. `env` is a
 * MERGE, and it was added to the contract in Claude Code v2.1.223 —
 * `managed-settings.md#keys-read-from-every-admin-source`: "`env`, merged per
 * variable across the admin sources: each variable comes from the
 * highest-priority source that defines it, so lower sources fill in variables
 * the higher ones leave unset. … Before v2.1.223, Claude Code applied the
 * selected source's whole `env` block only" — no terminal period, because that
 * bullet has none; `server-managed-settings.md#per-key-exceptions-across-managed-sources`
 * carries the same sentence in the PRESENT tense ("applies") and with one, so a
 * quote here has to name which page it came from.
 *
 * We applied the pre-v2.1.223 behaviour until this change. `managed-env.ts`
 * owns the merge — including the telemetry-unit carve-out, without which the
 * merge would newly permit pairing one source's exporter endpoint with the
 * other's credentials — and this module only calls it and carries the result.
 * The composition is returned BESIDE the policy as well as folded into
 * `policy.env`, because the withhold rule is decided per variable against that
 * variable's ORIGIN and a merged block alone cannot say where a variable came
 * from.
 *
 * ## The four questions this module answers
 *
 * 1. **Deny lists in both sources.** NOT a union. The winning source's list is
 *    enforced and the other is ignored
 *    (`server-managed-settings.md#settings-precedence`,
 *    `managed-settings.md#how-claude-code-combines-managed-sources`). This is the
 *    documented behaviour and it is the opposite of the intuitive one; it is
 *    stated here explicitly so nobody has to re-derive it.
 * 2. **An allow list present in one source and absent in the other.** Only the
 *    winner is read, so the question reduces to what an ABSENT key means in the
 *    winner — and absent is "no constraint", never "empty". That is R25a's rule,
 *    unchanged: `parsePolicy` only classifies a list as a grant or a restriction
 *    when `root[field] !== undefined`, so an INVALID allowlist is enforced as
 *    empty (admit nothing) while an ABSENT one imposes no narrowing at all
 *    (`isManagedMcpServerAllowed`, `isManagedModelAllowed`). Present-but-broken
 *    and never-written are different states, and only the first fails closed.
 *    No second algebra is introduced here.
 * 3. **A boolean lock `false` in one source and absent in the other.** For the
 *    cross-source keys above, the ENFORCING pole wins —
 *    `server-managed-settings.md#per-key-exceptions-across-managed-sources` says
 *    the cross-source lock keys are "honored when any admin-controlled managed
 *    source sets them". Our poles are
 *    not always Claude's: `allowPluginHooks`, `channelsEnabled` and
 *    `sandbox.allowUnsandboxedCommands` all enforce at `false`, which is why
 *    `securitySwitch` carries the pole rather than a literal `true`. Those three
 *    are NOT in the documented cross-source set, so they follow the first-wins
 *    rule like every other key: the winner's value, whichever pole it is on.
 * 4. **Scalars such as `cleanupPeriodDays`.** The winner's value. Not the
 *    smaller, not the larger — first-wins uses one source, and a retention
 *    window is
 *    not a boundary with a safe direction to guess (see the field's own comment:
 *    guessing one "would delete sessions no admin asked to delete").
 */

import {
  carriesManagedSettings,
  DEFAULT_MANAGED_PI_POLICY,
  type ManagedPiPolicyV1,
} from '../agent/pi-harness/managed-policy.ts'
import {
  composeManagedEnv,
  EMPTY_MANAGED_ENV_COMPOSITION,
  type ManagedEnvCompositionV1,
} from './managed-env.ts'
import type {
  SandboxFilesystemSettingsV1,
  SandboxNetworkSettingsV1,
} from './sandbox-settings.ts'

export interface ManagedPolicySourcesV1 {
  /**
   * The server-delivered payload, when one applies right now. Highest
   * precedence within the managed tier —
   * `managed-settings.md#how-claude-code-combines-managed-sources` ranks remote
   * settings first of the three admin sources.
   *
   * An UNAPPROVED payload must never be passed here — `loadCachedManagedDelivery`
   * and the approval gate hold those back, so what reaches this function is
   * always a payload that needed no approval or was approved.
   */
  readonly delivered?: ManagedPiPolicyV1 | undefined
  /** The host-owned policy file and its drop-in fragments. */
  readonly file?: ManagedPiPolicyV1 | undefined
}

/**
 * Which source supplied the composed policy — for diagnostics, never a gate.
 *
 * `documented, implemented`. This is the computed half of
 * `settings.md#confirm-what-loaded`, whose `Setting sources` line — "When managed
 * settings are in effect, the managed settings entry shows in parentheses how
 * they reached your machine" — and of
 * `server-managed-settings.md#settings-precedence`, which sends a user there
 * precisely when a cleared server configuration should have fallen back to the
 * local policy: "Run `/status` to see which managed source is active."
 *
 * The old citation here put *shows the delivery channel in parentheses, for
 * example Enterprise managed settings (remote) … or (file)* inside quotation
 * marks. No page in the corpus says that; it is a paraphrase that had hardened
 * into a quote, and neither example string appears anywhere (P3.209).
 *
 * R30b gave it its reader: `resolveEnforcedManagedPolicy` now carries the label
 * out beside the policy it labels, `nessy-general-agent doctor` prints it, and
 * `createStorageRuntime` warns at startup for the one combination that misleads
 * — a delivered payload winning over a file policy that carries settings.
 * Carrying it rather than re-deriving it is deliberate:
 * {@link composeManagedPolicySources} is pure, so the label and the policy can
 * only ever disagree if they are derived twice.
 */
export type ManagedPolicyWinnerV1 = 'delivered' | 'file' | 'none'

export interface ManagedPolicyCompositionV1 {
  readonly policy: ManagedPiPolicyV1
  readonly winner: ManagedPolicyWinnerV1
  /**
   * The per-variable `env` merge, with each variable's source and the
   * endpoint-managed stand-ins for withheld delivered values.
   *
   * Carried BESIDE the policy rather than only folded into `policy.env` because
   * the withhold rule is per ORIGIN and `policy.env` cannot say where a variable
   * came from. `policy.env` holds the same merged block for every reader that
   * only needs the values.
   */
  readonly envComposition: ManagedEnvCompositionV1
}

function union(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined,
): readonly string[] | undefined {
  if (first === undefined) return second
  if (second === undefined) return first
  const merged = [...first]
  for (const entry of second) {
    if (!merged.includes(entry)) merged.push(entry)
  }
  return Object.freeze(merged)
}

/**
 * The sandbox NETWORK lock and the allowlist it locks —
 * `managed-settings.md#keys-read-from-every-admin-source`, "a `true` in any admin
 * source turns the lock on. While a lock is on, Claude Code unions the allowlist
 * it locks … across every admin source."
 *
 * The lock is honoured when EITHER source sets it. The allowlist has to travel
 * with it: honouring a lock from one source while reading only the other
 * source's allowlist would enforce "deny everything outside this list" against a
 * list its author never wrote, which denies traffic no administrator denied.
 * Under an unset lock the allowlist is inert (`allowedDomains` is "meaningless
 * on its own"), so nothing is widened by composing it only when the lock fires.
 *
 * Returns `undefined` when neither source locks — leave the winner's section
 * exactly as it is.
 */
function composeNetworkLock(
  winner: SandboxNetworkSettingsV1 | undefined,
  other: SandboxNetworkSettingsV1 | undefined,
): SandboxNetworkSettingsV1 | undefined {
  if (winner?.allowManagedDomainsOnly !== true && other?.allowManagedDomainsOnly !== true) return undefined
  const allowedDomains = union(winner?.allowedDomains, other?.allowedDomains)
  return Object.freeze({
    ...winner,
    allowManagedDomainsOnly: true,
    ...(allowedDomains === undefined ? {} : { allowedDomains }),
  })
}

/**
 * The sandbox FILESYSTEM lock and the allowlist it locks — the second half of
 * the one sentence quoted above, and the half this module did not implement
 * (P6.2). Deliberately the same shape as {@link composeNetworkLock}, because the
 * page states one rule for both keys and two shapes is how one of them drifts.
 *
 * The DIRECTION is what makes this a security fix rather than a tidy-up, and it
 * is the opposite of the network case. An unlocked `allowedDomains` is inert, so
 * dropping the network lock failed closed. Dropping THIS lock fails OPEN:
 * without `allowManagedReadPathsOnly`, `resolveSandboxSettings` merges
 * `filesystem.allowRead` from the user, project and local layers instead of
 * capping the resolved `allowedReadRoots` to the floor's list, which is exactly
 * the widening `sandboxing.md#keep-developers-from-widening-the-policy` says the
 * key exists to prevent — "Set `allowManagedReadPathsOnly` to `true` in managed
 * settings so that only `allowRead` entries from managed settings are honored.
 * This prevents developers from widening read access beyond the
 * organization-approved paths."
 *
 * (The first of those two sentences used to read *User, project, and local
 * `allowRead` entries are ignored.* inside the same quotation marks. It is on no
 * page in the corpus; the anchor was right and the quote was invented — the
 * third such case in this file, found by re-verifying rather than renumbering,
 * P3.209.)
 *
 * So the stricter admin value must survive a laxer winner. Returns `undefined`
 * when neither source locks — leave the winner's section exactly as it is, since
 * a fabricated `allowManagedReadPathsOnly: false` would read as an administrator
 * decision nobody made.
 */
function composeFilesystemLock(
  winner: SandboxFilesystemSettingsV1 | undefined,
  other: SandboxFilesystemSettingsV1 | undefined,
): SandboxFilesystemSettingsV1 | undefined {
  if (winner?.allowManagedReadPathsOnly !== true && other?.allowManagedReadPathsOnly !== true) {
    return undefined
  }
  const allowRead = union(winner?.allowRead, other?.allowRead)
  return Object.freeze({
    ...winner,
    allowManagedReadPathsOnly: true,
    ...(allowRead === undefined ? {} : { allowRead }),
  })
}

/**
 * Compose the two managed sources into the ONE policy the app enforces.
 *
 * See the module comment for the rule and its citations. In one line: the
 * delivered payload wins wholesale when it carries any setting, otherwise the
 * file policy applies, and the documented cross-source lock keys are honoured
 * from either source in both directions.
 */
export function composeManagedPolicySources(
  sources: ManagedPolicySourcesV1,
): ManagedPolicyCompositionV1 {
  const { delivered, file } = sources
  // `server-managed-settings.md#settings-precedence` — the first source "that
  // delivers at least one policy key" wins. A delivered policy that parsed down
  // to nothing is not a delivery, and must not silently erase a file policy that
  // is still valid.
  //
  // "Policy key" is the page's own term and it EXCLUDES two control keys,
  // `wslInheritsWindowsSettings` and `managedSourcesBehavior`: a source carrying
  // only those "doesn't count, and Claude Code moves on to the next source". Our
  // schema carries neither key, so `carriesManagedSettings` cannot currently
  // disagree with that definition — the divergence is vacuous, not absent, and it
  // becomes real the moment either key is added here (P3.209). P3.290 decided
  // NOT to add `managedSourcesBehavior`, and preserving that vacuity is half the
  // reason: a schema field would make a payload carrying only the control key
  // count as a delivery here and erase a valid file policy, which is exactly what
  // the page's "doesn't count" clause exists to prevent.
  const deliveredWins = delivered !== undefined && carriesManagedSettings(delivered)
  const winner = (deliveredWins ? delivered : file) ?? DEFAULT_MANAGED_PI_POLICY
  const other = deliveredWins ? file : delivered
  // A source that carries no setting cannot be the reason anything is enforced,
  // so it is reported as `none` even when it is the object we returned.
  const label: ManagedPolicyWinnerV1 = deliveredWins
    ? 'delivered'
    : carriesManagedSettings(winner) ? 'file' : 'none'
  // `env` is composed from the two SOURCES, never from winner/loser: the
  // per-variable rule is ordered by source priority, and which source won the
  // rest of the policy has nothing to do with it. A delivered payload that
  // carries no setting still loses the policy wholesale while contributing
  // nothing here either, because it has no `env` to contribute.
  const envComposition = composeManagedEnv(delivered?.env, file?.env)
  if (other === undefined) {
    return Object.freeze({
      policy: withComposedEnv(winner, envComposition),
      winner: label,
      envComposition,
    })
  }

  const forceRemoteSettingsRefresh =
    winner.forceRemoteSettingsRefresh === true || other.forceRemoteSettingsRefresh === true
      ? true
      : winner.forceRemoteSettingsRefresh
  const network = composeNetworkLock(winner.sandbox?.network, other.sandbox?.network)
  const filesystem = composeFilesystemLock(winner.sandbox?.filesystem, other.sandbox?.filesystem)
  // One section built from both locks. Two independent spreads of
  // `{ sandbox: ... }` would have the later one erase the earlier one's section,
  // which is how a lock that IS composed still fails to reach the policy.
  const sandbox = network === undefined && filesystem === undefined
    ? undefined
    : Object.freeze({
        ...winner.sandbox,
        ...(network === undefined ? {} : { network }),
        ...(filesystem === undefined ? {} : { filesystem }),
      })
  return Object.freeze({
    policy: withComposedEnv(Object.freeze({
      ...winner,
      ...(forceRemoteSettingsRefresh === undefined ? {} : { forceRemoteSettingsRefresh }),
      ...(sandbox === undefined ? {} : { sandbox }),
    }), envComposition),
    winner: label,
    envComposition,
  })
}

/**
 * Put the merged block on the composed policy.
 *
 * An empty composition leaves the key ABSENT rather than writing `{}`, keeping
 * R25a's distinction intact: `carriesManagedSettings` counts any key other than
 * the stamp, so fabricating an empty `env` would turn every policy into a
 * delivery.
 */
function withComposedEnv(
  policy: ManagedPiPolicyV1,
  composition: ManagedEnvCompositionV1,
): ManagedPiPolicyV1 {
  if (composition === EMPTY_MANAGED_ENV_COMPOSITION) return policy
  return Object.freeze({ ...policy, env: composition.env })
}
