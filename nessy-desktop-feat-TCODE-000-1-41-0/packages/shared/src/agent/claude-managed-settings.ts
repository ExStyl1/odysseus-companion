/**
 * One managed floor, projected into the Claude Agent SDK's own policy tier.
 *
 * ## What this is
 *
 * Our administrators write ONE document — `managed-policy.json`, parsed into
 * {@link ManagedPiPolicyV1} — and until P2.7 it reached the Claude runtime only
 * through OUR gate: the PreToolUse hook, the capability filter, the sandbox
 * wrap. The SDK subprocess itself ran with no policy tier at all
 * (`managedSettings` occurred 0 times in `claude-agent.ts`, measured
 * 2026-08-24 with `grep -ac` against a control of 45 `export` hits in the same
 * file). Everything the SDK decides BEFORE our hook sees it — its own settings
 * cascade, its own hook loading, its own MCP admission — decided it unmanaged.
 *
 * This module is the translation, and {@link buildClaudeManagedSettingsOptions}
 * is what the spawn passes as `Options.managedSettings`.
 *
 * ## The SDK filter is not a guess — it was read out of the shipped binary
 *
 * `sdk.d.ts:1952` (vendored 0.3.223, line verified 2026-08-24) says the value is
 * "filtered restrictive-only" and names three examples. Examples are not an
 * allowlist, and a key we map that the filter drops is a SILENT drop — the
 * failure this row exists to remove. So the filter itself was measured, from
 * `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, the native CLI the SDK
 * actually spawns. The 2026-08-24 reading used `strings -a` — a THIRD
 * instrument beside the two AGENTS.md names, which is why the count beside it
 * cannot be compared with anything: positive control `permissions` → 616 hits
 * then, and re-measured 2026-09-12 at the vendored `2.1.247` it is 330 lines
 * (`grep -acF`) / 646 occurrences (`grep -aoF … | wc -l`) — name the instrument
 * beside every count here (C3.294). Negative control `nessyNotARealSdkKey`
 * → 0/0, unchanged:
 *
 * **HOW TO FIND IT AGAIN — by content, never by symbol (P3.309).** This block
 * used to name the two functions `vbg` and `Ebg`. The `0.3.223 → 0.3.233` bump
 * renamed both, and the `0.3.233 → 0.3.247` bump renamed them AGAIN (the filter
 * minifies as a two-argument function whose accumulator and parameters all
 * moved), so re-extract from these two anchors, counted against the FULL
 * binary with this section's own `nessyNotARealSdkKey` → **0** as the control:
 *
 * Both anchor counts are given as lines (`grep -acF`) / occurrences
 * (`grep -aoF … | wc -l`), re-measured 2026-09-12 on the vendored `2.1.247`,
 * because the two instruments disagree on a minified artefact (C3.294):
 *
 *  - `parentSettingsBehavior==="merge"` — **1/1** in the whole binary, at
 *    `2.1.233` and still at `2.1.247`, and it IS the predicate's body. The
 *    filter is the very next function after it, so one anchor lands both.
 *  - `allowManagedHooksOnly===!0` — **5/8**, and the filter's own first line;
 *    the same anchor §"Re-extracting when the SDK moves" below already
 *    prescribes. This bullet read **6** until 2026-09-12 while the P7.16
 *    paragraph below already carried the **8** — two numbers for one anchor
 *    inside one docblock, which is the drift C3.252 was opened for.
 *
 * The predicate/filter pair, re-read at `2.1.233` (the names are omitted on
 * purpose — the next bump will move them again):
 *
 * ```js
 * (e){return!e||e.parentSettingsBehavior==="merge"}
 * (e,t){let r={};
 *   if(e.allowManagedHooksOnly===!0)r.allowManagedHooksOnly=!0;
 *   if(e.disableCommandPluginSources===!0)r.disableCommandPluginSources=!0;
 *   if(e.allowManagedMcpServersOnly===!0)r.allowManagedMcpServersOnly=!0;
 *   if(e.disableClaudeAiConnectors===!0)r.disableClaudeAiConnectors=!0;
 *   if(e.allowManagedPermissionRulesOnly===!0)r.allowManagedPermissionRulesOnly=!0;
 *   … attribution → commitTrailers:false / sessionUrl:false …
 *   let n=e.strictPluginOnlyCustomization;
 *   if(n===!0||Array.isArray(n)&&n.length>0)r.strictPluginOnlyCustomization=n;
 *   if(e.deniedMcpServers)r.deniedMcpServers=e.deniedMcpServers;
 *   … forceLoginOrgUUID / allowedMcpServers / availableModels, each only when
 *   the parent tier left it unset; enforceAvailableModels …
 *   … permissions → pick(['deny','ask']) … sandbox → enabled/failIfUnavailable/
 *   allowUnsandboxedCommands:false/autoAllowBashIfSandboxed:false, network →
 *   pick(['deniedDomains']) + allowManagedDomainsOnly/strictAllowlist,
 *   filesystem → pick(['denyRead','denyWrite']) + allowManagedReadPathsOnly,
 *   credentials → files/envVars normalised to deny|mask …
 * ```
 *
 * **Re-extracted at the vendored `2.1.247` by these same two anchors (P7.16,
 * 2026-09-11), and the body above still reads true where this module depends on
 * it**: the predicate is unchanged, and the filter's copy list gained exactly two
 * members — `syncClaudeAiSkills===!1` and `syncClaudeAiPlugins===!1`, both
 * claude.ai-connector keys this fork has no policy for — while every key this
 * module reasons about (`modelPricing` among them) is still absent from it. The
 * anchor counts moved with the bundle and are a reading, not a fact:
 * `allowManagedHooksOnly===!0` scores 8 OCCURRENCES (`grep -aoF … | wc -l`; 5
 * by LINES — the instrument is named because the two disagree on a minified
 * artefact, C3.294, re-measured 2026-09-12; it was 6 at 2.1.233) and
 * `parentSettingsBehavior==="merge"` still 1/1, control `nessyNotARealSdkKey`
 * → 0/0.
 *
 * **I2.3 — those two connector keys are an EGRESS surface, and this fork's
 * exposure to it is narrower than "no policy for" suggests (re-derived
 * 2026-09-17 at the vendored `0.3.251`, where `sdk.d.ts` is byte-identical to
 * `0.3.247` on both keys; `sdk.mjs` 8 occurrences each, binary 12 each, control
 * 0).** Their own gloss: setting `syncClaudeAiSkills` false means "nothing more
 * is downloaded, previously synced skills (~/.claude/skills/synced) can no
 * longer be run … Only false is honored — the feature is enabled server-side for
 * your account", and `syncClaudeAiPlugins` says the same for
 * `~/.claude/plugins/synced`. So a session that IS synced fetches skills and
 * plugins from claude.ai and runs them, which is content arriving from outside
 * every source this fork's own capability layer governs.
 *
 * The narrowing is the last sentence of each gloss: **"Only applies when signed
 * in with your Claude account."** On the gateway and BYO cards the child is not
 * — the spawn sets `ANTHROPIC_API_KEY: 'not-needed'` beside a 127.0.0.1 base URL
 * and the loopback adapter authenticates upstream itself — so the feature is
 * inert there by construction rather than by policy. The one path where it is
 * NOT inert is the Claude Pro/Max subscription card, which is exactly a claude.ai
 * account and is flag-gated (`NESSY_FEATURE_PROVIDER_CLAUDE`, default off).
 *
 * Pinning both to `false` is therefore not free and not this module's call
 * either way: neither key is in `MANAGED_PI_POLICY_KEYS`, so `refuseUnknownKeys`
 * strips them from any managed document we accept (the same measurement
 * `config/managed-composition.ts` records for all seven
 * `#exceptions-to-managed-settings-precedence` keys, of which `syncClaudeAiSkills`
 * is one), and adding them would be a new managed control for a feature that
 * only reaches one flag-off card. **Recorded as a PRODUCT posture for the owner
 * with the default unchanged**, which is what the balance rule asks for: the
 * question is whether a corporate fork's subscription card may run skills and
 * plugins synced from a personal claude.ai account, and it is a question about
 * what the product is rather than about what the runtime does.
 *
 * `pick` was spelled `XTr` at `2.1.233` — **verified, not assumed**: 7
 * identifier occurrences against a fabricated control at 0, assigned from a
 * wrapper around lodash's `(e,t)=>e==null?{}:pickBy(e,t)`. **At the vendored
 * `2.1.247` it is spelled `Z`** (re-read 2026-09-12 by the anchor above; it
 * appears four times inside the filter body, as `Z(e.permissions,["deny","ask"])`
 * and the three sandbox picks), and the caution is now doubled rather than
 * retired:
 *
 *  - **`function XTr(` scores 0**, because the binding is a `var`, so the
 *    obvious probe reports a false absence — that was the original caution.
 *  - and the bare name is NOT COUNTABLE. `XTr` scores 18 lines / 18
 *    occurrences in the 2.1.247 binary and **not one of them is a symbol**:
 *    read at their offsets they sit inside base64 CA certificates and minified
 *    export-alias tables. A one-to-three-character minified needle has no
 *    meaningful raw count in either direction (C3.294), which is why `Z` is
 *    given here as a coordinate and the FOUR CALL SITES inside the filter are
 *    the way to find it.
 *
 * And the call site — `m = l && <predicate>(d) ? <filter>(l,f) : null`, where
 * `d` is the first present admin tier (remote → MDM → file). That IS the row's
 * "first-wins": with an admin tier present and no
 * `parentSettingsBehavior: 'merge'` in it, our slice is not filtered, it is
 * DISCARDED — the predicate is false and `parentSlice` is `null`. With no admin
 * tier, ours is the sole policy tier. Both halves of the row's citation
 * therefore hold against the SDK actually vendored here.
 *
 * Two consequences that a doc-only reading would have missed, and that
 * {@link mapManagedPolicyToClaudeSettings} reports rather than hides:
 *
 *  - `disableAllHooks`, `allowedHttpHookUrls` and `httpHookAllowedEnvVars` are
 *    real `Settings` keys with real managed meaning, and the filter does not
 *    copy ANY of them — re-confirmed on the `2.1.247` body, re-extracted by the
 *    anchors above on 2026-09-12 (C3.252) and again on the `2.1.233` body. Sending them
 *    would look like enforcement and be a no-op.
 *  - `deniedMcpServers` entries pass through verbatim, and our entry shape is
 *    already byte-identical to the SDK's (`serverName` / `serverCommand` /
 *    `serverUrl`), so that one needs no translation at all.
 *
 * ## Unsupported keys are surfaced, never dropped in silence
 *
 * Every key of {@link MANAGED_PI_POLICY_KEYS} is accounted for: either it is
 * mapped, or it appears in {@link ClaudeManagedSettingsMappingV1.unsupported}
 * with the reason it is not — and the reason matters, because the three reasons
 * are not equally alarming. `enforced-elsewhere` means the policy IS applied,
 * by our own gate, on a path the SDK tier does not reach; `widening` means we
 * deliberately withhold a grant, because a FLOOR that hands capability out is
 * not a floor; `no-sdk-tier` means the SDK's policy tier genuinely cannot carry
 * it. A test pins the partition against the key list, so a field added to the
 * schema and to nothing else fails rather than disappears.
 *
 * ## P2.133 — `no-sdk-tier` was hiding two different answers
 *
 * That third reason is a statement about the SDK, and an administrator reads it
 * as "so something of theirs does it instead". For four keys that reading was
 * wrong in three cases, and this module said nothing either way. Every
 * `no-sdk-tier` row therefore now carries a
 * {@link ClaudeManagedPolicyEnforcementV1} verdict, required by the type, and a
 * measured `not-enforced` one gets its own diagnostic sentence plus
 * {@link claudeManagedPolicyUnenforcedKeys} for the admin surface. Measured
 * 2026-08-26 against the shipped 0.3.223 CLI and our own call graph; the per-key
 * evidence is on each row.
 *
 * This sentence said "the three measured `not-enforced` ones" until P3.254. It
 * was true when written and P2.206 made it false the same week by measuring
 * `disableAllHooks` to `host-gate`; a count beside a table that moves is a
 * reading with a date, so the count is gone rather than corrected. The live set
 * is whatever {@link claudeManagedPolicyUnenforcedKeys} returns, and the test
 * pins it.
 *
 * ## P2.136 — a lock was sent without its operand, and nothing said so
 *
 * The withholding rule above ("a floor never widens") was applied to
 * `sandbox.network.allowedDomains` and `sandbox.filesystem.allowRead`
 * unconditionally. Riding with their own `allowManaged*Only` lock those lists
 * are not widenings at all — they are the value the lock enforces — so the SDK
 * received the locks alone, which is deny-every-host and re-open-nothing. The
 * administrator wrote an allowlist and got a deny-all. Fail-closed, so never a
 * security hole; an inversion of intent all the same, and the surfacing said
 * `mapped: ['sandbox']`, `unsupported: []`, "carries: sandbox".
 *
 * {@link mapSandbox} carries each list inside its lock's own branch, and
 * {@link ClaudeManagedSettingsMappingV1.withheld} reports at SUB-KEY
 * granularity so a gutted key can no longer read as a whole one.
 *
 * THE THIRD PAIR IS NOT FIXED HERE, DELIBERATELY. `managed-settings.md` names
 * "permission rules" alongside `sandbox.network.allowedDomains` as a value a
 * lock governs, and `allowManagedPermissionRulesOnly` + `claudeRules.allow` is
 * the same shape: the filter would carry our `allow` whenever no admin tier set
 * that lock. Withholding it is a product decision with its own row above, and
 * unlike the sandbox pair its fail-closed outcome is "nothing is pre-approved,
 * so Claude asks", not a hard deny — except through `WebFetch(domain:...)` allow
 * rules, which `settings-reference.md#sandbox-network-strictallowlist` counts
 * INTO the network allowlist. What changed there is only that the withholding is
 * now VISIBLE: `claudeRules.allow` gets a `withheld` entry even when
 * `claudeRules` is in `mapped` because its deny list was sent.
 *
 * ### P2.267 — the residue, measured, and the `WebFetch(domain:)` half retracted
 *
 * Re-extracted from the vendored `0.3.233` binary by the method below (anchor
 * `allowManagedHooksOnly===!0`), independently on two lanes. The `permissions`
 * branch reads, verbatim:
 *
 *   `if(e.permissions){`
 *   `  let o=XTr(e.permissions,["deny","ask"]);`
 *   `  if(e.permissions.disableBypassPermissionsMode==="disable")o.disableBypassPermissionsMode="disable";`
 *   `  if(t.allowManagedPermissionRulesOnly!==!0){`
 *   `    let{allow:i,additionalDirectories:s}=e.permissions;`
 *   `    if(i&&t.sandbox?.network?.allowManagedDomainsOnly!==!0)o.allow=i;`
 *   `    if(s)o.additionalDirectories=s`
 *   `  }`
 *
 * Three corrections to the paragraph above, and the third is the one that
 * retires the feared inversion:
 *
 * 1. The filter DOES copy `permissions.allow` from a lower tier. The
 *    `pick(permissions, ['deny','ask'])` quoted elsewhere in this file is the
 *    branch's FIRST line, not the whole of it.
 * 2. The copy is gated on TWO admin-tier conditions, not one:
 *    `allowManagedPermissionRulesOnly !== true` AND
 *    `sandbox.network.allowManagedDomainsOnly !== true`.
 * 3. **The network lock removes the ENTIRE lower-tier `allow` list, not only its
 *    `WebFetch(domain:…)` entries.** So the deny-all inversion this section
 *    feared does not reproduce through our mapper: under either lock our
 *    `claudeRules.allow` was never going to arrive, which makes the
 *    unconditional withholding inert rather than harmful. Withholding STAYS by
 *    owner decision — the reason is the product posture above, not this
 *    mechanism — and it stays VISIBLE through `withheld`.
 *
 * `additionalDirectories` rides only the FIRST gate, not the network lock, and
 * has no `withheld` probe either way.
 *
 * One further staleness in the quoted extract, recorded rather than silently
 * patched: it omits `if(e.disableCommandPluginSources===!0)r.disableCommandPluginSources=!0;`,
 * which is the second line of the filter at `0.3.233` (P3.285's key).
 *
 * ### P2.244 — REFUTED as filed, and the pin it asked for now exists
 *
 * The row states that after P2.138's fix five parseable `sandbox` sub-fields
 * "land in the policy, map to nothing, and emit **zero** diagnostics". Driven
 * through the real parser and the real mapper on 2026-09-03, that is **false**:
 * a policy carrying `excludedCommands`, `additionalWritableRoots`,
 * `network.allowedDomains`, `filesystem.disabled: true` and
 * `filesystem.allowWrite` produces `mapped: []`, `unsupported: []` and **five
 * `withheld` entries**, one per sub-key path, which
 * {@link formatClaudeManagedSettingsDiagnostics} prints as five lines naming the
 * path and the reason. The diagnostic did not disappear — it MOVED, from the
 * `unsupported` alarm to the `withheld` channel P2.136 added for exactly this,
 * and the row was filed against the state before that channel existed.
 *
 * The row's second claim — that the pin "compares key sets at KEY granularity,
 * so it does not bite" — is also no longer true of the withheld pins, which
 * assert exact sub-key PATH lists. But it named a real asymmetry, and that half
 * is now closed: the top-level partition test is DERIVED from
 * `MANAGED_PI_POLICY_KEYS`, while every sandbox sub-key assertion was a
 * hand-written list of paths that already exist, so a SIXTH sandbox sub-field
 * added to the parser and read by neither {@link mapSandbox} nor a
 * {@link CLAUDE_WITHHELD_SUB_KEYS} probe would have appeared in no list. Two
 * tests in `claude-managed-settings.test.ts` now close it at the same
 * granularity: one asserts the sub-key fixture is exhaustive against the
 * parser, the other asserts every sub-field, alone, is either carried into
 * `settings.sandbox` or named in `withheld`.
 *
 * One correction to the row's own list, worth carrying: `filesystem.disabled`
 * is not wholly unread — {@link mapSandbox} reads the `=== false` pole, which is
 * the LOCK. It is `disabled: true`, the widening pole, that is withheld.
 *
 * ## Re-extracting when the SDK moves
 *
 * The minified symbol names quoted above will not survive a version bump, so
 * what is pinned is the METHOD, not the symbols:
 *
 *  1. read the vendored version from `@anthropic-ai/claude-agent-sdk`;
 *  2. locate the filter in `…-darwin-arm64/claude` by an anchor that is a
 *     SETTINGS KEY rather than a symbol — `allowManagedHooksOnly===!0`, the
 *     filter's first line — and read the function body around it;
 *  3. the keys it copies are the whole allowlist; everything else is dropped.
 *
 * `claude-managed-settings.test.ts` runs exactly that, fails when the vendored
 * version moves off the one the extraction was measured against, and DECLARES
 * its skip when the platform binary is absent instead of passing quietly.
 */
import { existsSync, readFileSync } from 'node:fs'
import type { Options, Settings } from '@anthropic-ai/claude-agent-sdk'
import {
  MANAGED_PI_POLICY_KEYS,
  resolveManagedPiPolicyFloor,
  type ManagedPiPolicyV1,
} from './pi-harness/managed-policy.ts'
import type { ResolvedGitAttributionV1 } from '../config/preferences.ts'

/** Why a managed key does not reach the SDK's policy tier. */
export type ClaudeManagedSettingsGapKindV1 = ClaudeManagedSettingsPartialGapKindV1 // F1.832, at the file end
  /** Our own gate applies it; the SDK tier is not where it lives. */
  | 'enforced-elsewhere'
  /** It hands capability OUT, and a floor never widens. */
  | 'widening'
  /** The SDK's restrictive-only filter has no slot for it. */
  | 'no-sdk-tier'

/**
 * What actually applies a `no-sdk-tier` key on a CLAUDE session — P2.133.
 *
 * The row's sentence is the whole reason this field exists: **a policy that
 * reads as enforced and enforces nothing is worse than an absent key.** Before
 * it, `no-sdk-tier` conflated two states an administrator would never conflate:
 * "the SDK cannot carry it, but our own gate does" and "the SDK cannot carry it
 * and neither can anything else, so setting it changes nothing". Both printed
 * the same line.
 *
 * It is required only on `no-sdk-tier`, deliberately. `enforced-elsewhere`
 * already says our gate applies it and `widening` already says we refuse to
 * apply it; adding a field derivable from `kind` on those would be a second copy
 * of the same fact, which is the failure mode this plan keeps meeting.
 */
export type ClaudeManagedPolicyEnforcementV1 =
  /** MEASURED: a gate of ours applies this key on a claude-runtime session. */
  | 'host-gate'
  /** MEASURED: nothing applies this key on a claude-runtime session. */
  | 'not-enforced'
  /**
   * No claim. Nobody has measured this key on this runtime.
   *
   * The tri-state's third state, and it is NOT a synonym for `not-enforced`:
   * reporting a definite unavailability from an unmeasured input is the trap in
   * the other direction, and the same one `runtime-agent-support.ts` records for
   * its fail-open readers. A key here is a lead, not a finding.
   *
   * ## The asserting-reason class is CLOSED, and what it taught is not
   *
   * P3.60 counted THREE of the then-13 `unmeasured` entries pairing the state
   * with a reason in which a mechanism of ours is the present-tense agent of
   * applying the key — the exact pair `allowPluginHooks` below records as "the
   * combination the tri-state exists to prevent". P3.60 measured `workflow`;
   * P3.254 measured `claudeMdExcludes` and `env` and re-checked the pair it had
   * excluded as the "nearest miss". All five came back `host-gate`, and none of
   * the five verdicts was a rewording:
   *
   *  - `workflow`'s assertion was FALSE about the mechanism it named and the key
   *    was applied by two others.
   *  - `claudeMdExcludes`' assertion was TRUE and INCOMPLETE — our gate applies
   *    it, and the SDK child re-loads what it excluded through a cascade our
   *    value cannot reach. That residue lives in the reason, because it is a
   *    restricting pole and the reason is what an administrator reads.
   *  - `env`'s assertion was simply TRUE. The suspicious shape covered a false
   *    claim, a partial one and a correct one, which is why the remedy is to
   *    MEASURE and never to reword.
   *  - `requiredMinimumVersion`/`requiredMaximumVersion` were excluded on the
   *    argument that "a version gate on OUR binary" names a mechanism without
   *    claiming the key reaches it. It reaches it — a startup refusal in both
   *    hosts, the strongest enforcement in the table, filed as "no claim".
   *
   * ## The DOMAIN-assigning class is now CLOSED too, and it taught the same thing
   *
   * Three of the eight remaining `unmeasured` entries carried a reason that
   * assigned the key a DOMAIN rather than an enforcer — `disableInAppUpdates`
   * and `disableInAppBrowser` ("governs the desktop host") and
   * `forceRemoteSettingsRefresh` ("a startup gate for the host"). None asserted
   * a mechanism of ours, so none was in the class above, and none had been
   * measured. P3.257 (b) measured all three, 2026-09-03, and **all three are
   * `host-gate`** — the fourth time in a row this method has produced a value
   * neither the record nor the row proposed.
   *
   * What the class taught, which is different from what the asserting class
   * taught: **each of the three domain statements was TRUE, and each implied a
   * false verdict.** "Governs the desktop host, never an agent session" is
   * correct and is not a weakness — a key with no agent-session term is enforced
   * HOST-WIDE, which is the strongest shape in this table and the one
   * `requiredMinimumVersion` already occupies. Reading "not about a session" as
   * "not enforced" is the same inference P3.254's `requiredMinimumVersion`
   * exclusion made, and it was wrong there for the same reason.
   *
   * Each entry carries its own chain; the shortest statement of it is that
   * `forceRemoteSettingsRefresh` REFUSES THE BOOT in both hosts, and that the
   * two in-app switches are read from the same enforced delivered+file
   * composition the retention and sandbox bridges read, so a server-DELIVERED
   * value works as well as a file one.
   *
   * ## The OUR-OWN-CONCEPT class is closed too, and it split three ways (P6.74)
   *
   * The five that remained were a THIRD shape: `allowedChannelServers`,
   * `autoMode`, `channelsEnabled`, `cleanupPeriodDays` and
   * `connectSourcesOnStartup` each said the key is OUR OWN CONCEPT or that the
   * SDK filter drops it — a claim about the SDK rather than about a host reader.
   * P6.74 measured all five on 2026-09-05, and for the fifth time this method
   * produced values nobody had proposed:
   *
   *  - `cleanupPeriodDays` and `connectSourcesOnStartup` are **`host-gate`**.
   *    Both have a reader with NO provider term — the retention provider
   *    `ensureConfigDir()`'s sweep consults, and
   *    `maybeConnectSourcesAtSessionStart`, whose policy check returns before
   *    the source registry is touched. "Our own concept" says nothing about who
   *    applies it, and here we do, on every runtime.
   *  - `autoMode` is **`not-enforced`**, and it is a real alarm: every reader of
   *    the managed block is `provider === 'pi'` by its own term, while claude's
   *    classifier IS reachable — `Options.settings.autoMode`, the seam P3.95
   *    measured — and carries our rules rather than the administrator's.
   *
   * ## A FOURTH class, and the tri-state cannot express it
   *
   * `channelsEnabled` and `allowedChannelServers` were measured and NEITHER POLE
   * IS TRUE of them. Nothing reads the keys on claude (`host-gate` is false),
   * and nothing can push there either, because the only arming path is Pi-gated
   * (`not-enforced` would print "nothing applies it here" about a restriction
   * that holds — P3.60's inversion, in the dangerous direction). They therefore
   * KEEP `unmeasured` while carrying the finding in their reason, and the first
   * sentence of this docblock — "nobody has measured this key" — is not true of
   * those two. That is a defect of the vocabulary, stated rather than papered
   * over: minting a fifth value changes what an administrator is shown and is a
   * product decision for the owner, not a lane's.
   *
   * Named in this vocabulary rather than in a plan because the reader who needs
   * to know which `unmeasured` entries may really be `host-gate` is the reader of
   * this type. The remaining SET and every remaining reason are pinned by
   * `claude-managed-settings.test.ts`, so a new entry — and a new asserting
   * reason on an old one — cannot appear in silence.
   */
  | 'unmeasured'

interface ClaudeManagedSettingsGapBase {
  readonly key: string
  readonly reason: string
}

export type ClaudeManagedSettingsGapV1 = ClaudeManagedSettingsPartialGapV1 // F1.832, at the file end
  | (ClaudeManagedSettingsGapBase & { readonly kind: 'enforced-elsewhere' })
  | (ClaudeManagedSettingsGapBase & { readonly kind: 'widening' })
  | (ClaudeManagedSettingsGapBase & {
    readonly kind: 'no-sdk-tier'
    /** Required here and nowhere else — see {@link ClaudeManagedPolicyEnforcementV1}. */
    readonly enforcement: ClaudeManagedPolicyEnforcementV1
  })

/**
 * A SUB-KEY the administrator set that did not reach the SDK — P2.136.
 *
 * `mapped`/`unsupported` are keyed on whole policy keys, and that granularity
 * hid the defect this row began with: a `sandbox` block whose lock arrived and
 * whose list did not reported `mapped: ['sandbox']`, `unsupported: []`, and
 * printed "carries: sandbox". A key can be carried and gutted at the same time,
 * so the report has to be able to say which PART of it was withheld.
 *
 * Deliberately a separate field rather than a finer `mapped`: `mapped` is tied
 * to {@link CLAUDE_MAPPED_POLICY_KEYS} and to the partition test, both of which
 * are statements about whole keys, and the one production consumer
 * (`claude-agent.ts`) reads only `settings` and the formatted lines. Additive
 * here means no consumer had to change to absorb the finer shape.
 */
export interface ClaudeManagedSettingsWithheldSubKeyV1 {
  /** Dotted path as an administrator writes it in `managed-policy.json`. */
  readonly path: string
  /** The top-level policy key it belongs to, so a reader can join it to {@link ClaudeManagedSettingsMappingV1.mapped}. */
  readonly key: string
  readonly kind: ClaudeManagedSettingsGapKindV1
  readonly reason: string
}

export interface ClaudeManagedSettingsMappingV1 {
  /** What to hand the SDK, or `undefined` when the policy maps to nothing. */
  readonly settings: Settings | undefined
  /** Policy keys that reached {@link settings}, sorted. */
  readonly mapped: readonly string[]
  /** Policy keys the administrator SET that did not, with their reason. */
  readonly unsupported: readonly ClaudeManagedSettingsGapV1[]
  /**
   * Sub-keys the administrator SET that did not reach {@link settings}, sorted
   * by path. A key may be in {@link mapped} AND own an entry here — that pair is
   * exactly the "carried but gutted" state P2.136 made reportable.
   */
  readonly withheld: readonly ClaudeManagedSettingsWithheldSubKeyV1[]
}

/**
 * Why each unmappable key is unmappable, stated once.
 *
 * Keyed on {@link MANAGED_PI_POLICY_KEYS} so the partition is total: a key is
 * either mapped by {@link mapManagedPolicyToClaudeSettings} or listed here, and
 * `claude-managed-settings.test.ts` asserts exactly that against the key list.
 */
const CLAUDE_MANAGED_GAPS: Readonly<Record<string, ClaudeManagedSettingsGapV1>> = Object.freeze({ managedMcpServers: claudeManagedMcpServersGap(), // F1.593, at the file end
  schemaVersion: {
    key: 'schemaVersion',
    kind: 'enforced-elsewhere',
    reason: 'the document stamp, not a setting',
  },
  disabledPermissionModes: {
    key: 'disabledPermissionModes',
    kind: 'enforced-elsewhere',
    reason: 'our mode vocabulary; the mode a session may enter is decided host-side before the SDK spawns',
  },
  disableSideloadFlags: {
    key: 'disableSideloadFlags',
    kind: 'enforced-elsewhere',
    reason: 'the vendor key exists and projecting it would BREAK MCP on this runtime: the SDK builds the '
      + 'child argv with `--mcp-config` whenever `mcpServers` is non-empty, and the binary rejects the '
      + 'non-sdk form of that flag at startup, so the projection would refuse every claude session '
      + 'carrying a stdio or http server. Of the four flags the key names, this product ships only '
      + '`--agents`, and the CLI refuses it at startup for exactly this policy (D1.107)',
  },
  disableAgentView: {
    key: 'disableAgentView',
    kind: 'enforced-elsewhere',
    reason: 'the SDK declares the key but its managed-settings filter does not carry it, so a projection '
      + 'would be a silent drop; the background admission point is ours on all three runtimes',
  },
  unattendedApprovalFallback: {
    key: 'unattendedApprovalFallback',
    kind: 'enforced-elsewhere',
    reason: 'no vendor key names this question and the managed-settings filter carries nothing like it, so '
      + 'there is nothing to project; the unattended fallback is a host answer, and claude already refuses '
      + 'an uncovered call with no user present',
  },
  permissionDsl: {
    key: 'permissionDsl',
    kind: 'enforced-elsewhere',
    reason: 'our DSL has no Claude rule-string spelling, so the host PreToolUse gate enforces its DENY rules (F1.813) and its ASK rules (F1.830: a card in every mode that can ask, a refusal in dontAsk) on this runtime; its allow rules are not evaluated here: an allow falls to the mode',
  },
  allowedPluginKeys: {
    key: 'allowedPluginKeys',
    kind: 'enforced-elsewhere',
    reason: 'plugin admission is decided by the capability resolver before a plugin reaches the SDK',
  },
  deniedPluginKeys: {
    key: 'deniedPluginKeys',
    kind: 'enforced-elsewhere',
    reason: 'plugin admission is decided by the capability resolver before a plugin reaches the SDK',
  },
  enabledPlugins: {
    key: 'enabledPlugins',
    kind: 'widening',
    reason: 'force-enabling activates a plugin; a floor never activates',
  },
  disableCommandPluginSources: {
    key: 'disableCommandPluginSources',
    kind: 'enforced-elsewhere',
    // P3.220. Runtime-independent for the same reason `strictKnownMarketplaces`
    // is: the marketplace and its catalog are host-side and never reach the SDK.
    //
    // THE SECOND HALF OF THIS COMMENT WAS TRUE FOR ONE BUNDLE AND IS NOW FALSE.
    // It read: "The vendored bundle could not carry it in any case — the key
    // requires Claude Code v2.1.229 and `claudeCodeVersion` here is 2.1.223",
    // offered as the AGENTS.md case of a bundle lagging the page. S0-3 lifted
    // the bundle to 2.1.233 (2026-09-03) and measured the opposite: the key
    // occurred 14 times there (0 at 2.1.223) — re-measured 2026-09-12 at the
    // vendored 2.1.247, 10 lines / 19 occurrences — and is COPIED BY THE RESTRICTIVE-ONLY
    // FILTER itself — pinned as a control in `claude-managed-settings.test.ts`
    // beside the six that were already there. The bundle no longer lags.
    //
    // S0-3 named the opening and left it: we pass
    // `settingSources` with `user` (F1.768 gates only project/local), so the SDK's own plugin
    // subsystem reads a user's `extraKnownMarketplaces` — and 2.1.233 also added
    // `command` as a marketplace-entry source. That is a surface our host gate
    // cannot reach: a command-source plugin declared in the user's own settings
    // and installed by the CLI rather than through our catalog.
    //
    // P3.285 TOOK IT. `mapManagedPolicyToClaudeSettings` now emits the key at
    // its restrictive pole, so this row is reached only when an administrator
    // wrote the WIDENING pole (`false`), which the SDK filter cannot carry
    // (measured: `if(e.disableCommandPluginSources===!0)…`). At that pole the
    // key is genuinely enforced elsewhere and nowhere else — our catalog refuses
    // a `command` source outright regardless of it, and its other operand,
    // `headersHelper`, is host-side too. So `enforced-elsewhere` is now the
    // precise verdict for the state that reaches this row, rather than a verdict
    // covering for an unemitted key.
    reason: 'a `false` here only widens, and the SDK filter copies this key at `true` only; the restrictive pole is emitted to the SDK, and marketplace commands are refused host-side before any catalog or archive reaches a runtime',
  },
  model: {
    key: 'model',
    kind: 'enforced-elsewhere',
    // P6.238. The SDK filter does NOT copy `model` — the body re-extracted from
    // the shipped 2.1.247 binary on 2026-09-12 (C3.252) still has no branch for
    // it, as it had none at 2.1.233 — and it does not need
    // to: the host resolves which model the session runs on
    // (`config/managed-models.ts:applyManagedModelAllowlist`, where a managed
    // `model` outranks the connection's stored default) and passes the answer
    // as `Options.model`, which outranks every settings tier on that side. A
    // settings projection would be a second, weaker copy of a decision already
    // made.
    reason: 'the host resolves the session model before the SDK spawns and passes it as `Options.model`, which outranks the SDK\'s own settings tiers',
  },
  allowedMcpServers: {
    key: 'allowedMcpServers',
    kind: 'widening',
    reason: 'the SDK filter drops it whenever an admin tier sets its own, and an allowlist we add on top could only widen theirs',
  },
  strictKnownMarketplaces: {
    key: 'strictKnownMarketplaces',
    kind: 'no-sdk-tier',
    // P2.133, MEASURED 2026-08-26. The only one of the row's four that is
    // genuinely enforced, and it is enforced RUNTIME-INDEPENDENTLY because it
    // never runs at session time: `createStorageRuntime` hands the key to
    // `createPluginRegistrySource` at boot (`storage-runtime.ts:316-320`), and
    // `PluginRegistrySource.add()`/`.upgrade()` refuse a disallowed source
    // before the store read and before any clone (`registry-source.ts:933`,
    // `:1001`, via `isSourceAllowed` at `:488`). There is no provider argument
    // anywhere on that chain — `strictKnownMarketplaces` occurs 0 times in both
    // `SessionManager.ts` and `claude-agent.ts` — so a claude session inherits
    // the floor transitively rather than being checked against it.
    enforcement: 'host-gate',
    reason: 'not copied by the SDK restrictive filter; our marketplace gate refuses the source at registration time, on every runtime',
  },
  blockedMarketplaces: {
    key: 'blockedMarketplaces',
    kind: 'no-sdk-tier',
    // P2.481, and the verdict was NOT re-derived: P2.467 measured it, and this
    // entry only records it. `host-gate`, for the same reason and on the same
    // chain as `strictKnownMarketplaces` two entries up — `createStorageRuntime`
    // hands the key to `createPluginRegistrySource` at boot and the four gates
    // (`add`, `upgrade`, load, delivery) refuse a blocked source before the store
    // read and before any clone. No provider argument anywhere on that chain, so
    // a claude session inherits the block transitively rather than being checked
    // against it.
    //
    // NOT `not-enforced`, and the distinction is the row: that value feeds
    // `claudeManagedPolicyUnenforcedKeys` and prints a diagnostic saying nothing
    // applies the key on this runtime. Here that would be an alarm about a
    // control our own gate applies on every runtime, which is exactly the false
    // reading P3.60 measured on `workflow`.
    //
    // NATIVE-FIRST, asked and answered by measurement rather than assumed. The
    // shipped binary DOES read this key natively — eight reader-shape hits
    // against two live controls at 8 and 5, with the reader function quoted in
    // `marketplace/reserved-names.ts` — and the mechanism is UNREACHABLE: it
    // reads the OS policy tier this fork does not write, our one channel's copy
    // set was probed to carry the key ZERO times against a sibling's three, and
    // it would guard the binary's own registry rather than `PluginRegistrySource`
    // on one runtime of three. So tier 2, the host, is not a second enforcement
    // point beside a working native one — it is the only one that can fire.
    enforcement: 'host-gate',
    reason: 'not copied by the SDK restrictive filter; our marketplace gate refuses a blocked source at add, upgrade, load and delivery, on every runtime',
  },
  extraKnownMarketplaces: {
    key: 'extraKnownMarketplaces',
    kind: 'widening',
    reason: 'delivers marketplace sources; a floor never delivers',
  },
  pluginSuggestionMarketplaces: {
    key: 'pluginSuggestionMarketplaces',
    kind: 'widening',
    reason: 'hands a suggestion surface out',
  },
  allowPluginHooks: {
    key: 'allowPluginHooks',
    kind: 'no-sdk-tier',
    // P2.206's neighbour, MEASURED 2026-08-26 because the row asked for the
    // switches beside the dead one to be checked the same way — and this one was
    // `unmeasured` while its reason asserted enforcement, which is the
    // combination the tri-state exists to prevent.
    //
    // What it was: `areManagedPluginHooksAllowed` had exactly one production
    // caller, `storage-runtime.ts`'s plugin-candidate filter, and that filter
    // sits behind `isPiCapabilityTurn` — so the plugin-hook kill switch admitted
    // every plugin hook on claude, codex and nestor-cloud. The reason line
    // ("our hook loader enforces the plugin-hook kill switch") was true of Pi
    // and of nothing else.
    //
    // What it is: `buildPinnedAgentAutomationSystem` drops the whole plugin hook
    // tier when the floor forbids it, runtime-independently. Narrowing rather
    // than a whole-system refusal on purpose — this key is a plugin-only
    // posture, and the user's own hooks are not what it governs.
    enforcement: 'host-gate',
    reason: 'no Settings key; our automation builder drops the plugin hook tier when the managed policy forbids plugin hooks, on every runtime',
  },
  disableAllHooks: {
    key: 'disableAllHooks',
    kind: 'no-sdk-tier',
    // P2.133, MEASURED 2026-08-26, and this is the row's worst case: the key
    // reads as a hook kill switch and kills nothing on this runtime.
    //
    // Two things are true at once, and only the first was written down before.
    // (1) The shipped CLI DOES honour the key at its own `policySettings` tier
    //     (`if(e?.disableAllHooks===!0)return{}` in the hooks-config resolver),
    //     so it is not a key the product ignores — it is a key the SDK's
    //     restrictive filter strips before it can reach that tier. Re-extracted
    //     against 0.3.223 by the method pinned in the test: the filter's body
    //     copies `allowManagedHooksOnly`, `allowManagedMcpServersOnly`,
    //     `disableClaudeAiConnectors`, `allowManagedPermissionRulesOnly`,
    //     `strictPluginOnlyCustomization`, `deniedMcpServers`,
    //     `forceLoginOrgUUID`, `allowedMcpServers`, `availableModels`,
    //     `enforceAvailableModels`, `permissions` and `sandbox` — and nothing
    //     else.
    // (2) Our own two readers of the key both miss the claude path.
    //     `isManagedAllHooksDisabled` (`managed-policy.ts:1979`) has exactly one
    //     production caller, and it sits behind `isPiCapabilityTurn`
    //     (`storage-runtime.ts:675`, applied at `:890`), so an `anthropic` turn
    //     short-circuits it to "admit every hook candidate". The second reader,
    //     `runtime-automations.ts:125`'s `managedDisableAllHooks`, is not
    //     reached on ANY provider: the one production builder of the automation
    //     system (`SessionManager.buildAgentAutomationSystem`) never sets the
    //     option, and a test is its only caller repo-wide.
    //
    // (3) P2.206 WIRED THE SECOND READER, which is why this verdict moved from
    //     `not-enforced` to `host-gate`. `buildPinnedAgentAutomationSystem` now
    //     reads the composed policy itself through
    //     `resolveManagedPiPolicyFloor()` — the same process-scoped reader this
    //     module uses — and returns NO automation system at all when the managed
    //     level of the key is set. It runs before any tier is read, on every
    //     provider that builds an automation system, which is every provider;
    //     the caller's option survives only as an override that can tighten.
    //     The SDK still never receives the key: this is our gate, not theirs,
    //     which is exactly what `host-gate` means.
    //
    // (4) P2.496, 2026-09-03 — the key's two tiers do DIFFERENT things, and the
    //     page now says so where it did not before.
    //     `settings-reference.md#disableallhooks`: "**In managed settings**:
    //     Claude Code disables every configured hook, including managed ones,
    //     and keeps running the hooks the Agent SDK registers in process",
    //     against "**In any other settings file**: … managed hooks, Agent SDK
    //     hooks, and hooks from plugins force-enabled in managed
    //     `enabledPlugins` keep running".
    //     So a host that registers hooks through the SDK is EXEMPT from this key
    //     at both tiers by design — which is what P2.496 was sent to establish,
    //     and it is intent rather than an artefact.
    //     **THAT VERSION WINDOW HAS CLOSED, and this paragraph described it in
    //     the present tense for one bundle too long (C3.252, 2026-09-12).** It
    //     read: "One version window to carry, and it runs the direction
    //     AGENTS.md calls the bundle lagging the page: 'Keeping Agent SDK hooks
    //     running when managed settings set this key requires Claude Code
    //     v2.1.242 or later', and this bundle is 2.1.233, where the managed tier
    //     DOES stop them". The bundle self-reported 2.1.251 on 2026-09-18, PAST
    //     v2.1.242 — so page and binary are no longer one window apart, and the
    //     2.1.233 behavioural reading is superseded rather than carried.
    //     What a re-read of the hook-collection path at 2.1.247 shows, stated as
    //     exactly what it is: the collector returns policy-tier hooks only (and
    //     `[]` when the policy tier sets `disableAllHooks`) on its
    //     managed-hooks-only BRANCH, while the ordinary branch still consults
    //     the SDK-registered registry after the file tiers have been emptied —
    //     i.e. the v2.1.242+ behaviour the page describes. That is a reading of
    //     the collection code, NOT a live measurement, and it is recorded as
    //     such rather than asserted; W17-z proposes the live re-measurement as
    //     its own row. Re-measured LIVE 2026-09-12 (C5.35, R3) on the packaged
    //     build at 2.1.247: under a delivered managed policy setting this key
    //     every host-registered hook went silent across a two-tool turn while the
    //     child's own settings-tier hooks kept firing, and removing the policy
    //     restored every host counter. The key still never reaches the runtime —
    //     the restrictive filter does not copy it and the live spawn line's
    //     `--managed-settings` JSON does not carry it — so `host-gate` is confirmed
    //     by measurement rather than by a second code reading. Our verdict is
    //     unaffected either way — it is about OUR
    //     gate, which is stricter than both — but nothing here may now be read
    //     as "the bundle lags the page" on this key.
    enforcement: 'host-gate',
    reason: 'not copied by the SDK restrictive filter; our automation builder reads the managed policy floor and builds no hook system at all when it is set, on every runtime',
  },
  allowedHttpHookUrls: {
    key: 'allowedHttpHookUrls',
    kind: 'no-sdk-tier',
    // P2.133, MEASURED 2026-08-26. `matchesHttpHookUrlPattern`
    // (`plugins/http-hook-env.ts`) has exactly one production caller —
    // `SessionManager.pluginHttpHookRunner` — and that runner was handed to the
    // automation system only inside `provider === 'pi' ? {…} : {…}`. With no
    // `httpRunner`, `hooks-automation.ts` produced zero http runs, so a
    // plugin-declared http hook did not fire on claude and the allowlist
    // governed nothing.
    //
    // P6.117 CLOSED THAT, and this verdict moves with it. The runner is now
    // supplied wherever `PLUGIN_HOOK_ACTION_RUNNERS` lists `'http'`, which
    // includes `anthropic`, so a plugin-imported http hook fires on a claude
    // session and meets this key on its way out: a non-matching URL is denied
    // with `http-hook-url-not-allowed`: a receipt and a reported refusal (UB12.50), no request, no prompt.
    // The SDK still never receives the key — this is OUR gate, not theirs, which
    // is exactly what `host-gate` means.
    //
    // The residual hole is unchanged and is stated rather than scored away:
    // `claude-agent.ts` passes `settingSources` (`user`, plus `project`/`local` when trusted), so
    // an http hook declared in a SETTINGS FILE runs inside the SDK's own engine,
    // never touching our runner and never meeting this key. That is a different
    // tier of hook from a plugin's own, and no host gate can reach it.
    enforcement: 'host-gate',
    reason: 'not copied by the SDK restrictive filter; our enforcer (pluginHttpHookRunner) is supplied on every runtime whose action-runner record lists http, claude included, and denies a non-matching URL before the request — an http hook declared in a settings file still runs inside the SDK engine and is out of reach',
  },
  httpHookAllowedEnvVars: {
    key: 'httpHookAllowedEnvVars',
    kind: 'no-sdk-tier',
    // P2.133, MEASURED 2026-08-26 — same runner, same wiring as
    // `allowedHttpHookUrls`: `interpolateHttpHookHeaders` is called only from
    // `SessionManager.pluginHttpHookRunner`, which a claude session did not get.
    // P6.117 gave it that runner, so the header env-var intersection is applied
    // on claude too, and this verdict moves for the same reason and with the
    // same settings-file residue.
    enforcement: 'host-gate',
    reason: 'not copied by the SDK restrictive filter; the header env-var intersection runs inside pluginHttpHookRunner, which claude now gets — a settings-file http hook inside the SDK engine stays out of reach',
  },
  claudeMdExcludes: {
    key: 'claudeMdExcludes',
    kind: 'no-sdk-tier',
    // P3.254, MEASURED 2026-08-31. This read `unmeasured` beside a reason that
    // ASSERTED enforcement ("our instruction loader applies it") — the pair
    // P3.60 corrected on `workflow` and the one `allowPluginHooks` above records
    // as the combination the tri-state exists to prevent.
    //
    // (1) THE ASSERTION IS TRUE, and provider-independent. `createStorageRuntime`
    //     hands the composed managed value to the native inventory unguarded —
    //     "managedInstructionExcludes: deps.nativeSourcesEnv?.managedInstructionExcludes
    //     ?? managedPiPolicy.claudeMdExcludes" (`bootstrap/storage-runtime.ts`),
    //     OUTSIDE the `isRuntimeCapabilityTurn` gate the Pi-only readers of
    //     P2.133 sit behind. `buildNativeCapabilityInventory` folds it into
    //     `resolveInstructionExcludes({ managed })` and drops every non-builtin
    //     `instruction`/`memory` record the matcher hits
    //     (`capabilities/native-sources.ts`). Those records become
    //     `runtime.view.promptLayers`/`.memory`, which
    //     `BaseAgent.composePinnedCapabilityContext` composes and
    //     `BaseAgent.chat` delivers on every backend — `ClaudeAgent` inherits
    //     that `chat` and overrides only `chatImpl`, and no consumer of the
    //     inventory is keyed on `provider`.
    //
    // (2) THE RESIDUE IS A RESTRICTING POLE, which is why it is in the reason
    //     string and not only in this comment. The SDK child loads memory of its
    //     OWN and applies this key from its OWN cascade. The shipped 0.3.223 CLI
    //     carries the matcher — `function HL_(e,t){if(t!=="User"&&t!=="Project"
    //     &&t!=="Local")return!1;let r=eo().claudeMdExcludes; … isMatch(o,i,n)}`
    //     — and its own schema text scopes it: "Only applies to User, Project,
    //     and Local memory types (Managed/policy files cannot be excluded)."
    //     Our managed value cannot reach that read: re-extracted by the method
    //     this module's docblock pins, the restrictive filter's body does NOT
    //     copy `claudeMdExcludes` (positive controls `allowManagedHooksOnly`,
    //     `allowManagedMcpServersOnly`, `permissions`, `sandbox` all present in
    //     the window; negative control `nessyNotARealSdkKey` absent), while the
    //     key itself occurs 3 times in the binary — so the absence is the
    //     filter's, not the probe's. `settings-reference.md#claudemdexcludes`
    //     states what the child does with no exclusion in hand: "Default: unset,
    //     so Claude Code loads every CLAUDE.md it finds."
    //
    // So `host-gate`, and NOT `not-enforced`: a gate of ours does apply the key,
    // and {@link claudeManagedPolicyUnenforcedKeys} is the list for keys nothing
    // applies. The vocabulary has no PARTIAL pole and one is deliberately not
    // invented here — a fourth state changes the formatter and the admin
    // surface, which is a product decision rather than a measurement. The honest
    // place for a partial answer is the reason, which every reader of the
    // diagnostic already sees.
    //
    // Per runtime: Pi is fully enforced (its curated context comes from this
    // same inventory through `materializePiContextResources`); claude carries
    // the residue above; codex carries the same shape for its own project doc.
    //
    // P3.257 (a), MEASURED 2026-09-03 from the codex source at `rust-v0.148.0`
    // — and the measurement CHANGES what the codex residue is, so it is written
    // here rather than left as "we set neither".
    //
    //  - `project_doc_max_bytes` is a BYTE BUDGET, not an exclude list.
    //    `core/src/agents_md.rs::load_project_instructions` seeds `remaining`
    //    from it and `break`s the environment walk at `remaining == 0`, and
    //    `read_agents_md` returns `Ok(None)` on `max_total == 0`. So the ONE
    //    point of `claudeMdExcludes`' range it can express is "load nothing at
    //    all"; it cannot drop one file and keep another.
    //  - `project_doc_fallback_filenames` only ADDS candidate names
    //    (`agents_md_paths` pushes them after the two built-ins). It cannot
    //    remove one.
    //
    // So codex has no projection of this key, and setting either value from a
    // glob list would be INVENTING an intent — the exclude patterns say which
    // files, and the budget can only say how many bytes. The honest residue is
    // therefore a DIAGNOSTIC (a managed `claudeMdExcludes` reaches no codex
    // project doc) and not a mapping, and it lands in
    // `codex-responses-adapter/src/config-writer.ts`, which this lane does not
    // own — patch text in the W3-a report.
    enforcement: 'host-gate',
    reason: 'not copied by the SDK restrictive filter; our capability inventory drops every matching instruction and memory file on every runtime, but the SDK child re-discovers User/Project/Local CLAUDE.md through its own settings cascade, which this managed value cannot reach',
  },
  // P6.245 — the two operator-authored strings, first MEASURED 2026-09-08
  // against the vendored 2.1.233 CLI and RE-MEASURED 2026-09-12 against the
  // vendored 2.1.247, by the method this module's docblock pins.
  //
  // Both names still occur in the binary, as lines/occurrences because the two
  // instruments disagree on a minified artefact (C3.294):
  // `pluginTrustMessage` 3/3, `companyAnnouncements` 4/5, against
  // `nessyNotARealSdkKey` 0/0 and `allowManagedHooksOnly` 20/34 as the two
  // controls (the 2.1.233 reading was 3 / 4 / 0 / 25, instrument unnamed), and NEITHER is copied by the restrictive MANAGED filter — whose
  // body is quoted in full in this module's docblock and carries no branch for
  // either. That absence is the filter's, not the probe's, exactly as for
  // `claudeMdExcludes` above.
  //
  // `no-sdk-tier` is therefore the kind, and `host-gate` the enforcement, for a
  // reason that is stronger here than for most keys on this list: the SDK's own
  // rendering of both strings happens in the CLI's INTERACTIVE UI, which this
  // fork never puts in front of anyone — the host owns every chrome surface. So
  // even a filter that carried them would enforce nothing visible here, and the
  // host supplying the surface once for all three runtimes is tier 2 rather than
  // a fallback.
  pluginTrustMessage: {
    key: 'pluginTrustMessage',
    kind: 'no-sdk-tier',
    // `settings-reference.md#plugintrustmessage`: "Add your organization's own
    // text to the plugin trust warning Claude Code shows before installation".
    // Ours is rendered on the host's own pre-install confirmation, which is the
    // surface a user of this fork actually meets, and it is rendered VERBATIM —
    // the host contributes only a label saying whose text it is.
    enforcement: 'host-gate',
    reason: "not copied by the SDK restrictive filter, and the SDK's own rendering is in the CLI UI this fork never shows; the host renders the administrator's text verbatim on its own pre-install confirmation, identically on all three runtimes",
  },
  companyAnnouncements: {
    key: 'companyAnnouncements',
    kind: 'no-sdk-tier',
    // `settings-reference.md#companyannouncements`: "Show your organization's
    // announcements to users at startup." `server-managed-settings.md` names it
    // as a key of the DELIVERED document — "shows your companyAnnouncements on
    // it" — which is why the carrier is `ManagedPiPolicyV1` rather than a
    // settings file.
    enforcement: 'host-gate',
    reason: "not copied by the SDK restrictive filter, and the SDK's own startup rendering is in the CLI UI this fork never shows; the host surfaces one announcement per session on its own chrome, identically on all three runtimes",
  },
  defaultMode: {
    key: 'defaultMode',
    kind: 'widening',
    reason: 'sets a default and can name a MORE permissive mode; the spawn already passes the resolved mode',
  },
  channelsEnabled: {
    key: 'channelsEnabled',
    kind: 'no-sdk-tier',
    // P6.74, MEASURED 2026-09-05. This pair is the FOURTH class, and it is the
    // first one the tri-state cannot express: the key was measured and NEITHER
    // POLE IS HONEST, so the state stays `unmeasured` and the reason carries the
    // finding. Minting a fifth value is refused here on purpose — it changes
    // what an administrator is shown and is the owner's call, not a lane's.
    //
    // What was measured. Channel push is armed in exactly one place:
    // `SessionManager.armPluginPeripherals` calls `setChannelPolicy(
    // resolveManagedChannelPolicy(this.managedPiPolicy, …))` and
    // `ensureSessionChannelSubscription`, and that block is guarded by
    // `runtimeReceivesMcpChannelPush(provider)`. `MCP_CHANNEL_PUSH_SUPPORT`
    // (`runtime-agent-support.ts`) answers `anthropic: false`, no other caller
    // passes `channelPolicy` at pool construction, and `McpClientPool` defaults
    // to `CHANNEL_PUSH_OFF` — so on a claude-runtime session the policy is never
    // read, `isChannelPermitted` never returns true and no dispatcher is ever
    // installed.
    //
    // P6.175 gave that answer a record of its own without changing it. The
    // arming used to ride the PERIPHERAL predicate by adjacency, so widening the
    // monitors to claude would have armed channel push too and flipped this
    // verdict as a side effect of an unrelated row. Whether it should widen is
    // its own question, with this measurement as its input.
    //
    // P6.341, 2026-09-07 — that question was answered YES, and this verdict
    // moves in the SAME commit. `MCP_CHANNEL_PUSH_SUPPORT.anthropic` is now
    // true, so `armPluginPeripherals` reaches
    // `setChannelPolicy(resolveManagedChannelPolicy(this.managedPiPolicy, …))`
    // on a claude-runtime session and this key is read there. The tri-state can
    // express it now, and it is `host-gate`: OUR pool applies it, no SDK tier
    // exists for it, and deleting the key from the policy changes what a claude
    // session does — which is the operational test `host-gate` has to pass and
    // the one `unmeasured` was recording as unmet.
    enforcement: 'host-gate',
    reason: 'MCP channel push is our own concept and our own pool arms it on every local runtime since P6.341; this key is the master switch resolveManagedChannelPolicy reads before any dispatcher is installed, claude included',
  },
  allowedChannelServers: {
    key: 'allowedChannelServers',
    kind: 'no-sdk-tier',
    // P6.74, MEASURED 2026-09-05 — the same measurement as `channelsEnabled`
    // above, one step further out: this key narrows WHICH sources may push, and
    // on claude none may. `resolveManagedChannelPolicy` intersects it with the
    // user's list and subtracts `deniedMcpServers`, and that whole computation
    // is reached only where `runtimeReceivesMcpChannelPush(provider)` holds,
    // which is Pi and nothing else.
    //
    // P6.341, 2026-09-07 — that predicate now holds on claude and codex too, so
    // the intersection runs on a claude session and this key narrows a real
    // dispatcher set. `host-gate` for `channelsEnabled`'s reason, and moved with
    // it: a pair measured together must not be reported apart.
    enforcement: 'host-gate',
    reason: 'the per-source push allowlist is intersected inside the channel arming path, which since P6.341 runs on claude and codex as well as Pi; a source this list omits gets no dispatcher on any local runtime',
  },
  workflow: {
    key: 'workflow',
    kind: 'no-sdk-tier',
    // P3.60, MEASURED 2026-08-31. The row that opened this asked for
    // `not-enforced` and `not-enforced` is the WRONG verdict — see (2).
    //
    // What was here: `unmeasured` beside a reason that ASSERTED enforcement
    // ("our workflow gate enforces it"). That pair is the combination the
    // tri-state exists to prevent, and `allowPluginHooks` above carries the
    // same note for the same reason.
    //
    // (1) The key IS applied on a claude-runtime session, by two gates that
    //     carry no provider term and both predate the runtime split.
    //     `SessionManager.loadSessionCustomSlashCommands` returns the
    //     file-derived commands and never reaches `loadWorkflowRecipes` —
    //     "if (this.workflowSettings.disableWorkflows) return commands"
    //     (`SessionManager.ts`, from 94cb0f9ca) — and
    //     `materializePluginCommandEntries` drops every `workflow` capability
    //     entry the same way — "if (this.workflowSettings.disableWorkflows)
    //     continue" (same file, from b0053399e). `this.workflowSettings` is
    //     composed once per manager from the managed `workflow` block
    //     (`resolveWorkflowSettings([getUserWorkflowSettings(),
    //     capabilityServices.managedPiPolicy?.workflow ?? {},
    //     workflowDisableEnvLayer()])`) and both gates are reached from
    //     `listCustomSlashCommandSummaries` and `resolveCustomSlashCommand`,
    //     neither of which is provider-gated. `resolveWorkflowSettings` also
    //     forces the keyword trigger off whenever the switch is set
    //     ("const keywordTriggerEnabled = !disableWorkflows",
    //     `config/workflow-settings.ts`), and that value reaches
    //     `detectWorkflowKeywordTrigger` on every provider.
    //
    // (2) `not-enforced` would be a false ALARM, not a cautious verdict.
    //     {@link claudeManagedPolicyUnenforcedKeys} is the subset a UI shows as
    //     "your policy is not in effect", and
    //     {@link formatClaudeManagedSettingsDiagnostics} prints the harder
    //     sentence "claude runtime does NOT enforce workflow — nothing applies
    //     it here". Both are untrue of the gates in (1), so the row's proposed
    //     fix would have swapped one wrong admin-facing message for another.
    //
    // (3) The row's premise about `bbda4b303` is right and does not move the
    //     verdict. That commit added `WORKFLOW_DISPATCH_SUPPORT`, so off Pi the
    //     capability resolver disables a `workflow` candidate
    //     (`capabilities/resolver.ts`) and the composer withholds both workflow
    //     command id prefixes (`backend/composer-capabilities.ts`), on top of
    //     P2.212's `chat()` refusal of a `workflowInvocation`. That is a SECOND,
    //     independent reason a claude session runs no workflow; it does not make
    //     the first one vacuous.
    //
    // Residue, stated because it is the honest part of the block: the other two
    // sub-keys are Pi-only reads. `sizeGuideline` reaches only the Pi manifest
    // and prompt (`pi-agent.ts`), which is authoring advice for a recipe a
    // claude session cannot run, and the Pi tool-strip that removes `workflow`
    // from the signed manifest is fed a runtime `SessionManager` builds for
    // `provider === 'pi'` alone. Neither is a restricting pole, so nothing a
    // floor travels toward is lost off Pi.
    enforcement: 'host-gate',
    reason: 'disableWorkflows is a Settings key the SDK restrictive filter does not copy; our slash-command and plugin-command gates drop every workflow-derived command when it is set, on every runtime, and off Pi no workflow can be dispatched at all',
  },
  claudeRules: {
    key: 'claudeRules',
    kind: 'enforced-elsewhere',
    reason: 'its deny and ask entries ARE mapped, into permissions.deny/ask; only the allow list is withheld, because a floor never grants',
  },
  autoMode: {
    key: 'autoMode',
    kind: 'no-sdk-tier',
    // P6.74, MEASURED 2026-09-05. `not-enforced`, and unlike the channel pair
    // this one is a REAL alarm rather than a false one: claude HAS a classifier,
    // it is configured by a seam we already own, and the administrator's prose
    // is the one thing that seam does not carry.
    //
    // Every reader of the managed block is `provider === 'pi'` by its own
    // term — `SessionManager` composes `managedAutoMode` (`resolveAutoMode({
    // managed: this.managedPiPolicy.autoMode })`), `classifyAllShell` and
    // `autoModeUnavailable` behind that test, and the composer-`!` path repeats
    // it with `this.resolveManagedProvider(managed) === 'pi'`. So on claude none
    // of the four sub-fields is read.
    //
    // Meanwhile `ClaudeAgent` DOES reach the SDK classifier: P3.94/P3.95's
    // `buildClaudeAutoModePolicySettings` writes an `autoMode` block onto
    // `Options.settings`, which is the measured seam into the classifier's own
    // prompt.
    //
    // P6.191 took HALF of the build that verdict called for, and the half it
    // took is the one with a slot: the builder now resolves the managed policy
    // itself and projects `autoMode.classifyAllShell`, the block's one BOOLEAN
    // sub-field, which the shipped binary parses in the same schema slot. So an
    // administrator's band control is in effect on this runtime.
    //
    // P6.541 CLOSED the other half, so this moved `not-enforced` -> `host-gate`
    // on 2026-09-07. `buildClaudeAutoModePolicySettings` now appends the
    // administrator's `environment`, `hard_deny` and `soft_deny` entries after
    // ours on the SAME `Options.settings` seam P3.95 measured into the
    // classifier's own prompt. Two things ride with that and are stated because
    // neither is derivable from the verdict:
    //
    //  - the `"$defaults"` sentinel survives UNRESOLVED on this runtime, unlike
    //    the Pi path, where `resolveAutoMode` splices Guardian's built-ins into
    //    it. Here it is the vendor's own splice instruction and resolving it
    //    would replace Anthropic's built-in rules with Pi's.
    //  - `allow` is still withheld, on every runtime, because a floor never
    //    grants — and it is now refused BY NAME
    //    (`refusedClaudeManagedAutoModeKeys`) rather than dropped in silence,
    //    which is the difference between a withheld set and a lost one.
    //
    // The key keeps `no-sdk-tier`: the SDK's restrictive MANAGED filter still
    // has no `autoMode` branch (P3.95's third measurement), so this reaches the
    // child through `settings` and not through our managed slice.
    enforcement: 'host-gate',
    reason: "prose for an auto-mode judge, which the SDK's managed filter has no slot for — so our own builder carries it instead: the administrator's environment, hard_deny and soft_deny entries are appended to ours on Options.settings, the measured seam into the classifier's prompt, with the $defaults sentinel left unresolved so Anthropic's built-ins still splice; autoMode.classifyAllShell rides the same block (P6.191) and only allow is withheld, refused by name because a floor never grants",
  },
  cleanupPeriodDays: {
    key: 'cleanupPeriodDays',
    kind: 'no-sdk-tier',
    // P6.74, MEASURED 2026-09-05, and the docblock above nominated this one to
    // be re-read first because P3.233 had already corrected its verdict once and
    // the surviving `unmeasured` half was about the SDK side alone. It is
    // `host-gate`, the DOMAIN shape P3.257 (b) closed for the three in-app
    // switches: the key has no agent-session term at all, and a key with no
    // session term is enforced HOST-WIDE, which is the strongest shape here.
    //
    // The chain: `registerEnforcedManagedRetentionProvider`
    // (`server-core/src/bootstrap/managed-policy-resolution.ts`) registers a
    // provider returning `resolveEnforcedManagedPolicy(seams).policy
    // .cleanupPeriodDays` into `registerManagedRetentionDaysProvider`, which
    // `ensureConfigDir()`'s startup retention sweep reads, and both hosts call
    // it before their first `ensureConfigDir()` (headless in
    // `bootstrapConfigArtifacts`, the desktop at the top of its ready handler).
    // It is fed by the ENFORCED composition rather than the file, so a
    // server-DELIVERED value works as well as a file one. No provider appears
    // anywhere on that path, so a claude session's transcripts are swept on the
    // administrator's window exactly as a Pi session's are.
    //
    // The old reason stays true and stops being the verdict: the restrictive
    // filter does drop the key, which is why `kind` is `no-sdk-tier`. What that
    // never said is who enforces it instead.
    enforcement: 'host-gate',
    reason: 'the SDK filter names it as a non-restrictive key it drops; our own retention sweep reads the enforced managed value host-wide through registerManagedRetentionDaysProvider, so it binds on every runtime including claude',
  },
  autoCompactEnabled: {
    key: 'autoCompactEnabled',
    kind: 'no-sdk-tier',
    // P3.233, MEASURED 2026-08-29 against the vendored 0.3.223 CLI
    // (`claudeCodeVersion` 2.1.223). The old row said `unmeasured` /
    // "a product preference, not a restriction", and BOTH halves were wrong in
    // the direction that matters: an administrator who sets this key was told
    // the runtime cannot enforce it, when the runtime enforces it.
    //
    // (1) It is not a product preference. `autoCompactEnabled` is a documented
    //     Claude Code settings key — `settings-reference.md#autocompactenabled`,
    //     "Have Claude Code compact the conversation automatically when context
    //     approaches the limit" — and the SDK's own single proactive-compaction
    //     gate reads it: `function Uk(){ if(te.DISABLE_COMPACT)return!1;
    //     if(tr(process.env.DISABLE_AUTO_COMPACT))return!1;
    //     return bu("autoCompactEnabled",!0).value }`. The SDK HAS a slot.
    //     `no-sdk-tier` is still the right KIND — the restrictive filter's body
    //     copies the twelve keys listed in this module's docblock and this is
    //     not among them — but the reason for that is the MANAGED tier's
    //     restrictive-only rule, not the key being unenforceable.
    //
    // (2) Since P6.53 it is enforced here. `SessionManager` composes the one
    //     host policy (`resolveAutoCompactionSettings({ userEnabled,
    //     managedEnabled: managedPiPolicy.autoCompactEnabled })`) and hands it
    //     to EVERY backend as `BackendConfig.autoCompaction`; `ClaudeAgent`
    //     projects `enabled === false` onto the SDK's own per-session override
    //     `DISABLE_AUTO_COMPACT=1`, on the gateway-adapter path and on the
    //     direct-Anthropic path alike. That override is equivalent to the
    //     setting in the OFF direction, which is the only direction a floor
    //     travels — same page: "whichever of the two turns it off, the other
    //     can't turn it back on".
    enforcement: 'host-gate',
    reason: 'the restrictive filter drops it, though the SDK compaction gate does read the setting; our host policy projects a managed false onto the SDK per-session DISABLE_AUTO_COMPACT, so it stops auto-compaction on claude too',
  },
  connectSourcesOnStartup: {
    key: 'connectSourcesOnStartup',
    kind: 'no-sdk-tier',
    // P6.74, MEASURED 2026-09-05. `host-gate`, and the reason that carried
    // `unmeasured` — "session-start connect is our own concept" — is the
    // OUR-OWN-CONCEPT shape the docblock named as the third class. Being our own
    // concept says nothing about who applies it, and here we do.
    //
    // `SessionManager.maybeConnectSourcesAtSessionStart` is called at the end of
    // session creation with NO provider term, and its policy check comes first:
    // `resolveConnectSourcesOnStartup({ userEnabled: getUserSourceStartupSettings()
    // .connectOnStartup, managedEnabled: this.managedPiPolicy
    // .connectSourcesOnStartup })`, and a resolved `false` returns before the
    // workspace pool registry is touched at all. So a managed `false` suppresses
    // the session-start connect on a claude session exactly as on a Pi one —
    // the restricting direction, which is the only one a floor travels.
    enforcement: 'host-gate',
    reason: 'session-start connect is our own concept, and our own gate applies it: maybeConnectSourcesAtSessionStart resolves the managed value with no provider term and a managed false returns before the source registry is touched, on every runtime',
  },
  disableInAppUpdates: {
    key: 'disableInAppUpdates',
    kind: 'no-sdk-tier',
    // P3.257 (b), MEASURED 2026-09-03. One of the three the docblock flagged as
    // the OTHER open class: the reason assigned the key a DOMAIN ("governs the
    // desktop host, never an agent session") rather than asserting an enforcer,
    // so it was in nobody's closed class and nobody's verdict.
    //
    // The domain statement was TRUE and the verdict it implied was wrong — the
    // third time P3.254's method has produced a value neither the record nor the
    // row proposed. A key with no agent-session term is not thereby unenforced;
    // it is enforced HOST-WIDE, which is the strongest shape in this table and
    // the one the version pair already occupies.
    //
    // End to end: `registerEnforcedManagedInAppUpdatesProvider`
    // (`server-core/src/bootstrap/managed-policy-resolution.ts`) reads
    // `resolveEnforcedManagedPolicy(...).policy.disableInAppUpdates` — the same
    // delivered+file composition the retention and sandbox bridges read, so a
    // SERVER-delivered value works as well as a file one — and publishes it to
    // `areInAppUpdatesManagedDisabled()`, which every updater entry point asks.
    // The registration is ordered ahead of `checkForUpdatesOnLaunch()`
    // (`apps/electron/src/main/index.ts:442` against the launch check further
    // down the same handler), and that ordering is pinned against the file's own
    // source by `main/__tests__/managed-update-registration.test.ts` because
    // nothing at runtime could catch a re-ordering.
    //
    // Provider-blind, and the codex tier is not an exception to that: P3.261
    // added a SECOND tier fed by codex's own `in_app_updates` requirement, and
    // composition is tightest-wins across the two, so a codex-only fleet gets
    // the same answer rather than a weaker one.
    enforcement: 'host-gate',
    reason: 'no agent-session term, and enforced host-wide because of it: the enforced delivered+file composition feeds areInAppUpdatesManagedDisabled(), which every updater entry point asks, registered ahead of the launch check in both hosts',
  },
  disableInAppBrowser: {
    key: 'disableInAppBrowser',
    kind: 'no-sdk-tier',
    // P3.257 (b), MEASURED 2026-09-03 — the twin of the entry above in every
    // respect the verdict depends on. `registerEnforcedManagedInAppBrowserProvider`
    // reads the same enforced composition and feeds
    // `registerManagedInAppBrowserDisabledProvider`, whose consumer is the gate
    // P2.399 built in `apps/electron/src/main/browser-pane-manager.ts` — and
    // that manager's startup enforcement pass CLOSES a pane the policy forbids,
    // so the key acts on state that already exists rather than only on new
    // opens.
    //
    // The one asymmetry, stated rather than left to inference: the headless host
    // deliberately does NOT register this, because it injects
    // `NullBrowserPaneManager`, which refuses every browser method already.
    // That is a gate satisfied by construction, not a gap — the verdict is the
    // same on both hosts and the mechanism differs.
    enforcement: 'host-gate',
    reason: 'no agent-session term, and enforced host-wide because of it: the enforced composition feeds the desktop browser-pane gate, whose startup pass also closes a pane already open; the headless host needs no reader because its browser manager refuses every method',
  },
  // P6.338 — the three GRADED browser keys, all `host-gate` for one reason
  // stated once here and not repeated three times below: every one of them is a
  // real Claude Code managed setting that the vendored 2.1.247 bundle does not
  // carry (documented-only, bundle lag). The reading was first taken at 2.1.233
  // and the lift did NOT close it — re-measured 2026-09-12 (C3.252) with a
  // positive control in the same probe run, as AGENTS.md requires of an absence
  // claim: `disableBrowserExternalNavigation`, `disableBrowserCdp` and
  // `browserHostAllowlist` all 0 lines / 0 occurrences, against
  // `companyAnnouncements` 4/5 as the control that proves the probe read the
  // file. And every one of them is documented
  // with the sentence "The desktop app reads this key; the terminal CLI ignores
  // it" — the claude child we spawn IS that CLI. So there is nothing to project
  // and nothing that WOULD read a projection; the enforcer is our own pane, at
  // the one gate `browser-trust-gate.ts` already routes both browser powers
  // through, which makes the verdict identical on Pi, claude and codex.
  disableBrowserExternalNavigation: {
    key: 'disableBrowserExternalNavigation',
    kind: 'no-sdk-tier',
    enforcement: 'host-gate',
    reason: 'documented-only on the vendor side (absent from the vendored bundle) and a desktop-app key the terminal CLI ignores by its own page, so the enforcer is our navigation gate, which refuses every non-local origin on all three runtimes',
  },
  disableBrowserCdp: {
    key: 'disableBrowserCdp',
    kind: 'no-sdk-tier',
    enforcement: 'host-gate',
    reason: "ours, with no vendor spelling to project: neither settings-reference.md nor desktop.md publishes a CDP, DevTools or remote-debugging key. Our CDP attach gate (isBrowserCdpManagedDisabled) refuses the debugger on all three runtimes; the pane switch dominates by construction, because a pane disableInAppBrowser forbids never opens",
  },
  browserHostAllowlist: {
    key: 'browserHostAllowlist',
    kind: 'no-sdk-tier',
    enforcement: 'host-gate',
    reason: "ours, with no vendor spelling to project: the vendor's own browser allowlist is the Claude in Chrome admin console, not a managed-settings key. Our navigation gate matches the URL hostname against the patterns on all three runtimes",
  },
  disableNonGatewayConnections: {
    key: 'disableNonGatewayConnections',
    kind: 'no-sdk-tier',
    // P6.498, delegated decision Q-den 15 = option A. `host-gate`, and the
    // reason it is not `enforced-elsewhere` is that this is OUR key with no
    // vendor spelling at all: claude's `forceLoginMethod` is the nearest thing
    // and it cannot ride this tier (the restrictive filter copies
    // `forceLoginOrgUUID` and not it — re-measured on the vendored 2.1.247,
    // 2026-09-12: the filter's copy list still carries
    // `if(t.forceLoginOrgUUID===void 0&&e.forceLoginOrgUUID)` and no
    // `forceLoginMethod` branch, though the name itself scores 16 lines / 32
    // occurrences elsewhere in that binary), nor
    // would it help, because it governs one runtime of three.
    //
    // The enforcer is `config/llm-connections.ts`'s process registry, read by
    // `isNonGatewayConnectionRefused` at the connection cards. Nothing on
    // that path takes a runtime term, so the refusal is identical on Pi, claude
    // and codex — which is the whole point of putting the lock in the host.
    enforcement: 'host-gate',
    reason: "ours, with no vendor spelling this tier can carry: the SDK's restrictive filter copies forceLoginOrgUUID and not forceLoginMethod, and that key would govern the claude runtime alone. The enforced composition feeds config/llm-connections.ts, whose refusal runs at the connection card with no runtime term, so an operator's gateway-only requirement holds identically on Pi, claude and codex",
  },
  modelPricing: {
    key: 'modelPricing',
    kind: 'no-sdk-tier',
    // P6.537, owner decision 2026-09-05 D11 = option A. `host-gate` and NOT
    // because the SDK refuses it.
    //
    // **RE-MEASURED at the vendored `0.3.247` (P7.16, 2026-09-10), and the
    // verdict survives on a STRONGER reason than the one it was written with.**
    // The old note said the key was "simply not in the vendored bundle yet (it
    // requires 2.1.242; the vendored SDK self-reports 2.1.233)". It is in the
    // bundle now: `sdk.d.ts` declares it twice and the native binary scores 28
    // OCCURRENCES (8 by LINES; `sdk.mjs` 10 / 2 — the instrument is named because
    // the two disagree on a minified artefact, C3.294, re-measured 2026-09-12),
    // against this repo's standing control `nessyNotARealSdkKey` -> 0. The
    // clause that mattered was never the version — it is REACHABILITY, and both
    // channels this host has are closed by the vendor's own words and by
    // measurement:
    //
    //  - the doc on the declaration itself: modelPricing is *"Only honored from
    //    managed settings (server-managed, MDM / OS policy, or
    //    managed-settings.json), or — when none of those sets it — when supplied
    //    by a host application that manages the model provider; ignored in user,
    //    project, local and --settings sources"*. `Options.settings` IS the
    //    `--settings` tier, so the flag seam every other key here rides is
    //    explicitly ignored for this one;
    //  - and the MANAGED seam is closed too: the restrictive filter's copy list,
    //    re-read by the anchor method in this module's header, does not contain
    //    `modelPricing` (and it has no entry in the binary's own
    //    `{path:[…],restrictive:…}` table either), so a managed projection would
    //    be a silent drop — exactly what this module exists to prevent.
    //
    // The third channel the doc names — "supplied by a host application that
    // manages the model provider" — DOES have a measured shape, and the first
    // draft of this note said it did not (P7.16, re-measured 2026-09-11 against
    // the vendored binary, whose own bytes carry `// Version: 2.1.247`). It is an
    // ENV GATE, not a settings key: the policy context is built with
    // `hostManagedProvider: <env>.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`, and one
    // exported function of that module is, whole,
    //
    //     if (!ctx.hostManagedProvider || allTiers.some((t) => t.modelPricing !== undefined)) return;
    //     return parentManaged(ctx).settings?.modelPricing;
    //
    // where `parentManaged` is `Options.managedSettings` (`sdk.mjs`:
    // `parentManaged: e.managedSettings ?? null`) — THIS module's own tier, read
    // whole and never through the restrictive filter above. So the table WOULD
    // arrive if the host set that variable on the spawn.
    //
    // It is not set, and that is a posture rather than an oversight: the same
    // flag makes the composition strip `model`, `fallbackModel`, `modelPicker`
    // and `modelOverrides` out of the ADMIN tiers and filter their `env` block,
    // so an OS-level managed model pin would stop binding on claude the day it
    // was turned on. That trade was the owner's, and it is ANSWERED: **owner
    // answer QX1 = B, 2026-09-11** — refuse the native channel and record it,
    // because a gateway's prices are not the vendor's to publish while an
    // administrator's model pins are a shipped control this fork already
    // honours. `managed-env.ts` classifies the name `credential`, so an operator
    // cannot reach it either.
    //
    // The FLIP POINT is an owner reversal (answer A), NOT a version: the channel
    // is already reachable in the vendored bundle. Re-measured 2026-09-12 at
    // `0.3.247` / `2.1.247` with `grep -ao <name> <file> | wc -l` (occurrences,
    // not matching lines): `modelPricing` -> 10 in `sdk.mjs`, 2 in `sdk.d.ts`,
    // 28 in the native binary, against this repo's standing negative control
    // `nessyNotARealSdkKey` -> 0 in all three. So nothing about a later lift
    // re-opens this; only the owner does.
    //
    // And what was traced is the READ, not its consumer: that the returned table
    // is what prices a request is the vendor's sentence above, not a measurement
    // of ours.
    //
    // I2.4 — `modelPicker` is named in the strip list above, and the question
    // that row asks ("can a managed modelPicker contradict the host's own picker,
    // and which wins?") has a measured answer that is neither: THE TWO NEVER
    // MEET. Re-derived 2026-09-17 at the vendored `0.3.251`, where the key is
    // byte-identical to `0.3.247` in `sdk.d.ts` (2 occurrences; 15 in `sdk.mjs`,
    // 39 in the binary, control 0).
    //
    //   * It cannot arrive through OUR tier: `modelPicker` is not a key of
    //     `ManagedPiPolicyV1`, and `refuseUnknownKeys` strips anything outside
    //     `MANAGED_PI_POLICY_KEYS`, so no managed document this fork accepts can
    //     carry one (`pi-harness/managed-policy.ts` records the same measurement
    //     from the other side — every `modelPicker` occurrence under `packages`
    //     and `apps` is an i18n key `chat.modelPicker.*` or the
    //     `enableCompactModelPicker` prop, never a settings read).
    //   * It CAN arrive through an OS-level admin `managed-settings.json` or MDM
    //     value, which is a machine the operator controls and not something the
    //     host can refuse — and P6.234 already detects that condition for a
    //     different reason (an admin tier present discards our whole slice).
    //   * And it still changes nothing, because what it curates is the CHILD's
    //     interactive `/model` list, an affordance this fork does not expose:
    //     `ClaudeAgent`'s config declares `model: string` as REQUIRED and the
    //     spawn passes `Options.model` on every turn, so the child is told which
    //     model to use rather than offered a list to narrow.
    //
    // So a managed `modelPicker` cannot silently narrow what a Nessy user can
    // pick — the host's connection cards and the gateway catalogue
    // (`server-core/src/model-fetchers/nestor.ts`) are the only picker in this
    // product, and they are ours. The one thing worth carrying forward is the
    // shape of the argument rather than the verdict: a managed key that curates
    // an interactive list is invisible to a host that never uses the list, and
    // the day this fork exposes the child's own `/model`, this stops being true.
    //
    // So the key stays ours to apply for all three runtimes, which is what D11
    // chose, because no USD ceiling can bite on a gateway model otherwise.
    //
    // The enforcer is `config/managed-model-prices.ts`'s process registry, fed
    // from the enforced delivered+file composition by
    // `registerEnforcedManagedModelPricing`
    // (`server-core/src/bootstrap/managed-policy-resolution.ts`) and read by the
    // cost surface with no provider term anywhere on the path.
    enforcement: 'host-gate',
    reason: "an operator-supplied model price table the vendor declares and this host has no channel it may take: modelPricing is honored only from managed settings, whose restrictive filter does not copy it; its own documentation ignores the --settings tier we ride; and the one seam that would carry it is gated on CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, which also strips an administrator's managed model pins. So it stays ours to apply: the enforced composition feeds config/managed-model-prices.ts's registry, which the cost readout consults with no provider term, so a gateway or BYO session is priced identically on Pi, claude and codex and every figure carries its basis label",
  },
  browserExternalPageTools: {
    key: 'browserExternalPageTools',
    kind: 'no-sdk-tier',
    enforcement: 'host-gate',
    reason: "documented-only on the vendor side and a desktop-app key the terminal CLI ignores by its own page, so the enforcer is our navigation gate, which refuses an external origin only when the agent is driving the pane — the person's own browsing is untouched, which is what the key says",
  },
  env: {
    key: 'env',
    kind: 'no-sdk-tier',
    // P3.254, MEASURED 2026-08-31. `unmeasured` beside a reason that ASSERTED
    // enforcement ("the spawn already carries the block as process env") — and
    // unlike P3.60's `workflow`, the assertion turned out to be TRUE. The defect
    // was the missing verdict, not a wrong claim, which is exactly why the
    // remedy for this class is to MEASURE rather than to reword: the same
    // suspicious shape covered a false claim on one key and a true one here.
    //
    // (1) ONE host writer, no provider term.
    //     `startManagedDeliveryEnvApplication` runs at boot in BOTH hosts
    //     (`apps/electron/src/main/index.ts:1256`,
    //     `server-core/src/bootstrap/headless-start.ts:177`) and re-runs on
    //     every delivery state change; `applyManagedDeliveryEnv` composes the
    //     host-file and delivered tiers and `writeResolution`
    //     (`config/managed-env.ts`) writes each variable into `process.env`.
    // (2) The claude spawn inherits it by construction:
    //     `buildClaudeSubprocessEnv` (`agent/options.ts`) builds the child env
    //     as `{ ...process.env, ...getProxyEnvVars(), ...envOverrides, … }`, so
    //     the block reaches the SDK subprocess with no second projection to keep
    //     in step. The same spread carries it to Pi and to codex, which is what
    //     `managed-env.ts`'s own docblock already claimed.
    // (3) The SDK tier genuinely cannot carry it, and does not need to:
    //     re-extracted by the method in this module's docblock, the restrictive
    //     filter's body does not copy `env` (same positive and negative controls
    //     as `claudeMdExcludes` above). `settings-reference.md#env` describes
    //     what we are supplying directly instead: "Set environment variables for
    //     every session and for the subprocesses Claude Code starts from it."
    //
    // ONE RESIDUE, UNIFORM across the three runtimes rather than
    // claude-specific, so it does not move this verdict: a DELIVERED variable
    // outside `MANAGED_ENV_SAFE_ALLOWLIST` is withheld until a human approves it
    // (`config/managed-approval.ts`) and the withholding is reported by
    // `ManagedEnvApplicationV1`.
    //
    // A SECOND one was recorded here and is FIXED — P2.487 (`a6e34510f`) added
    // the missing `delete` to `writeResolution` in `config/managed-env.ts`.
    // Until then point (2) above was true of the host and FALSE of its children:
    // the name stayed readable by property while absent from `Object.keys` and
    // from `{...process.env}`, which is how all three spawn sites build a child
    // environment, so a Bun-hosted spawn carried no managed proxy variable at
    // all. P2.498 corrected the two premises this note carried:
    //  - NOT "the six proxy names". Those six PLUS
    //    `NODE_TLS_REJECT_UNAUTHORIZED`, which is a TLS-verification name and no
    //    kind of proxy, while `ALL_PROXY`/`all_proxy` ARE proxy names and are
    //    NOT affected — and `TZ` and `BUN_CONFIG_VERBOSE_FETCH` are affected
    //    from outside this module's classification table entirely. An admin
    //    block carries arbitrary names, so the delete is unconditional. AGENTS.md
    //    carries the one-line command that ENUMERATES the set, which is why no
    //    count is repeated here.
    //  - A second condition nobody had stated: it fires only when the name is
    //    ABSENT from the launch environment. Overwriting an inherited value was
    //    always visible; INTRODUCING one — the ordinary case for an
    //    administrator mandating a proxy — was not. That is why it presented as
    //    machine-dependent, and why a reader who tests by overwriting concludes
    //    there is no bug.
    enforcement: 'host-gate',
    reason: 'the SDK filter names env as a non-restrictive key it drops; our managed-delivery applier writes the composed block into the host process environment at boot, and every claude spawn inherits it through buildClaudeSubprocessEnv, on every runtime',
  },
  forceRemoteSettingsRefresh: {
    key: 'forceRemoteSettingsRefresh',
    kind: 'no-sdk-tier',
    // P3.257 (b), MEASURED 2026-09-03 — the third of the domain-assigning three,
    // and the one whose old reason was closest to being read as a gap: "a
    // startup gate for the host, not for a spawned query" says where it acts and
    // nothing about whether it acts.
    //
    // It acts, in BOTH hosts, and it REFUSES THE BOOT.
    // `enforceForceRemoteSettingsRefresh` (`config/managed-refresh-gate.ts`) is
    // called from `bootstrap/headless-start.ts:204`, which throws
    // `ManagedSettingsStartupError` on `blocked`, and from
    // `apps/electron/src/main/index.ts:1322`, which shows the error box and
    // `app.exit(1)` BEFORE any window is created. That puts it in the same class
    // as `requiredMinimumVersion`/`requiredMaximumVersion`: it exits the app
    // before a session of any provider exists, with no provider term on the
    // chain.
    //
    // The `needs-authentication` outcome deliberately does NOT exit, in either
    // host, and that is a stated posture rather than a hole: this app has no
    // separate `auth` binary for the vendor's own exemption to point at, so
    // exiting there is what would make an expired credential unrecoverable.
    // `server-managed-settings.md#enforce-fail-closed-startup` is the page the
    // fail-closed half is built to; the hourly refresh beside it is fail-OPEN by
    // the same page, and the two are different call sites on purpose.
    enforcement: 'host-gate',
    reason: 'a startup gate that fires: enforceForceRemoteSettingsRefresh refuses the boot in both hosts (headless throws, the desktop exits before any window), before a session of any provider exists — the needs-authentication outcome deliberately does not exit, so a stale credential stays recoverable',
  },
  requiredMinimumVersion: {
    key: 'requiredMinimumVersion',
    kind: 'no-sdk-tier',
    // P3.254, MEASURED 2026-08-31 — the "nearest miss" the previous count
    // excluded from the asserting-reason class, RE-CHECKED rather than
    // inherited, and it BELONGS. That exclusion was a judgement, not a
    // measurement: "a version gate on OUR binary" was read as naming a mechanism
    // without claiming the key reaches it. It reaches it.
    //
    // `assertManagedVersionAllowed(loadManagedPiPolicy(), <running version>)`
    // runs at startup in BOTH hosts — `apps/electron/src/main/index.ts:1219`
    // (error box, then `app.exit(1)`) and
    // `server-core/src/bootstrap/headless-start.ts:633` (throws
    // `ManagedSettingsStartupError`, which the entry point prints before exiting
    // non-zero) — before a session of any provider exists. So a claude session
    // inherits the floor transitively, exactly the way `strictKnownMarketplaces`
    // above does and for the same reason: there is no provider argument anywhere
    // on the chain. It is the strongest enforcement in this table, and it was
    // filed as "no claim".
    //
    // The OPERAND is ours, deliberately, and the reason keeps saying so:
    // `config/managed-version-gate.ts` compares against this repo's own version
    // shape (root and `apps/electron` `package.json`), while
    // `settings-reference.md#requiredminimumversion` writes the key about the
    // other binary — "Set the oldest Claude Code version your organization
    // allows to start." Fail-open in three places (invalid bound stripped by the
    // parser, unparseable running version allowed, bound with no comparable
    // segments treated as absent), so this can only refuse on a comparison an
    // administrator actually wrote.
    enforcement: 'host-gate',
    reason: 'a version gate on OUR binary rather than on the SDK CLI, which has its own; our startup gate refuses to launch either host when the running version falls below the administrator bound, before a session of any runtime exists',
  },
  requiredMaximumVersion: {
    key: 'requiredMaximumVersion',
    kind: 'no-sdk-tier',
    // P3.254 — same call, same measurement, same both-hosts startup refusal as
    // `requiredMinimumVersion` above; `enforceManagedVersionGate` reads the two
    // bounds in one decision, so they cannot be enforced apart.
    enforcement: 'host-gate',
    reason: 'a version gate on OUR binary rather than on the SDK CLI, which has its own; our startup gate refuses to launch either host when the running version rises above the administrator bound, before a session of any runtime exists',
  },
})

/**
 * Whether `permissionDsl` carries a rule the administrator wrote AS DSL, rather
 * than one the parser generated by compiling `claudeRules`.
 *
 * The parser folds every `claudeRules` entry into `permissionDsl` with the
 * generated id `claude-<action>-<index>` (`managed-policy.ts:1246`), so a policy
 * whose only permission content is `claudeRules` still has a non-empty
 * `permissionDsl`. Reporting that as an unmapped key would be false twice over:
 * those rules DID reach the SDK, as `permissions.deny`/`ask`, and the report
 * would fire for the most ordinary policy there is.
 */
const GENERATED_CLAUDE_RULE_ID = /^claude-(allow|ask|deny)-\d+$/

function carriesNativeDslRules(policy: ManagedPiPolicyV1): boolean {
  return (policy.permissionDsl?.rules ?? []).some(rule => !GENERATED_CLAUDE_RULE_ID.test(rule.id))
}

/** Read a boolean only at the pole that RESTRICTS. */
function restrictiveTrue(value: boolean | undefined): true | undefined {
  return value === true ? true : undefined
}

/**
 * Fold our two spellings of a sandbox path denial into the one the SDK filter
 * copies. `deniedReadRoots` predates `filesystem.denyRead` and both are live, so
 * a policy may carry either or both; the SDK has only `filesystem.denyRead`.
 * Order-preserving union, duplicates removed — same rule
 * `resolveSandboxSettings` uses when it merges layers.
 */
function unionPaths(...lists: readonly (readonly string[] | undefined)[]): string[] | undefined {
  const seen = new Set<string>()
  for (const list of lists) for (const entry of list ?? []) seen.add(entry)
  return seen.size > 0 ? [...seen] : undefined
}

/**
 * The `sandbox` slice of the SDK `Settings`, restricted to what the SDK's
 * restrictive-only filter copies (the function at the
 * `parentSettingsBehavior==="merge"` anchor above).
 *
 * ## P2.136 — a lock's OPERAND is not a widening
 *
 * `allowedDomains` and `allowRead` hand capability out on their own, so the
 * "a floor never widens" rule withheld them unconditionally. That rule is a
 * CATEGORY ERROR when the list rides with its own `allowManaged*Only` lock:
 * under the lock the list is not a grant on top of somebody else's policy, it
 * is the entire policy the lock enforces, and withholding it turns the
 * administrator's allowlist into a deny-all.
 *
 * The documentation states the relationship directly.
 * `managed-settings.md#managed-only-settings`: "Most of them are locks: the
 * value a lock governs, such as permission rules or
 * `sandbox.network.allowedDomains`, is an ordinary key that any level can set,
 * and the lock tells Claude Code to honor only the managed value."
 *
 * And each lock's own entry says what an EMPTY managed value then means:
 *  - `settings-reference.md#sandbox-network-allowmanageddomainsonly`: "Lock the
 *    network allowlist to what managed settings define. Claude Code then honors
 *    only `allowedDomains` and `WebFetch(domain:...)` allow rules from managed
 *    settings, ignores domains from user, project, local, and `--settings`
 *    settings, and blocks a non-allowed domain automatically instead of
 *    prompting." Lock without list ⇒ every host blocked, without a prompt.
 *  - `settings-reference.md#sandbox-filesystem-allowmanagedreadpathsonly`:
 *    "Honor only the `allowRead` entries that come from managed settings, so
 *    developers can't re-open read access to paths your organization blocked.
 *    `denyRead` entries still merge from every settings file." Lock without list
 *    ⇒ nothing is re-opened inside any `denyRead` region, from any source.
 *
 * The SDK filter agrees, re-measured against the shipped 0.3.223 CLI:
 * `if(t.sandbox?.network?.allowManagedDomainsOnly!==!0&&o.allowedDomains)l.allowedDomains=o.allowedDomains`
 * and the `allowRead` line beside it, where `t` is built from the ADMIN tiers
 * alone (`u=[remote,mdm,file]`, `t.sandbox.network.allowManagedDomainsOnly =
 * u.some(y=>y.sandbox?.network?.allowManagedDomainsOnly===!0)||void 0`) and
 * never from our slice. So the operand rides through whenever no admin tier set
 * the same lock — and when one did, the parent-behaviour predicate has already
 * discarded our whole slice, lock included. There is no path on which the list arrives without the
 * lock that governs it.
 *
 * The DIRECTION still holds, which is the half easy to lose: a list arriving
 * WITHOUT its lock is a plain widening and is still withheld, because then it
 * would merge on top of whatever a user or project file already allows.
 */
function mapSandbox(policy: ManagedPiPolicyV1): { value: Settings['sandbox']; mapped: boolean } {
  const sandbox = policy.sandbox
  if (!sandbox) return { value: undefined, mapped: false }

  const network: NonNullable<NonNullable<Settings['sandbox']>['network']> = {}
  if (sandbox.network?.deniedDomains?.length) network.deniedDomains = [...sandbox.network.deniedDomains]
  if (restrictiveTrue(sandbox.network?.allowManagedDomainsOnly)) {
    network.allowManagedDomainsOnly = true
    // The lock's operand, carried ONLY inside the lock's own branch.
    if (sandbox.network?.allowedDomains?.length) {
      network.allowedDomains = [...sandbox.network.allowedDomains]
    }
  }

  const filesystem: NonNullable<NonNullable<Settings['sandbox']>['filesystem']> = {}
  const denyRead = unionPaths(sandbox.deniedReadRoots, sandbox.filesystem?.denyRead)
  const denyWrite = unionPaths(sandbox.deniedWriteRoots, sandbox.filesystem?.denyWrite)
  if (denyRead) filesystem.denyRead = denyRead
  if (denyWrite) filesystem.denyWrite = denyWrite
  // The one filesystem key whose RESTRICTING pole is `false` — P2.268.
  //
  // `disabled: true` skips filesystem isolation entirely ("Sandboxed commands
  // get unrestricted read/write access to the host filesystem", `sdk.d.ts`), so
  // TRUE is the widening and FALSE is the lock that says no lower tier may skip
  // it. Same shape as `allowUnsandboxedCommands` below, and the SDK's own filter
  // agrees at the same pole — measured verbatim in the vendored native binary
  // (`claude-agent-sdk-darwin-arm64/claude`), inside the `if(i)` filesystem
  // branch that also carries `allowManagedReadPathsOnly` and `allowRead`:
  //
  //   `if(i.disabled===!1)l.disabled=!1;`
  //
  // Before this line the key fell through the carry AND the surfacing: an
  // administrator who locked filesystem isolation on got neither the lock nor a
  // word about it. The widening pole is withheld and now REPORTED — see
  // `CLAUDE_WITHHELD_SUB_KEYS`.
  if (sandbox.filesystem?.disabled === false) filesystem.disabled = false
  if (restrictiveTrue(sandbox.filesystem?.allowManagedReadPathsOnly)) {
    filesystem.allowManagedReadPathsOnly = true
    // Same shape, same reason — and `allowWrite`/`additionalWritableRoots` get
    // no such branch on purpose: the SDK has no `allowManagedWritePathsOnly`,
    // so a write grant has no lock to be the operand of and stays a widening.
    if (sandbox.filesystem?.allowRead?.length) {
      filesystem.allowRead = [...sandbox.filesystem.allowRead]
    }
  }

  const value: NonNullable<Settings['sandbox']> = {}
  if (restrictiveTrue(sandbox.enabled)) value.enabled = true
  // Only the LOCKING pole: `true` re-opens the escape hatch, and the SDK filter
  // copies this key at `false` for exactly that reason.
  if (sandbox.allowUnsandboxedCommands === false) value.allowUnsandboxedCommands = false
  if (Object.keys(network).length > 0) value.network = network
  if (Object.keys(filesystem).length > 0) value.filesystem = filesystem

  return Object.keys(value).length > 0 ? { value, mapped: true } : { value: undefined, mapped: false }
}

/**
 * The keys this mapper HAS a mapping for — P2.7 Low, closed by P2.138.
 *
 * A key here is one whose value decides whether it maps: the mapper reads it and
 * carries it only at the RESTRICTING pole (`restrictiveTrue`, a non-empty list,
 * a `sandbox` that narrows something). When an administrator sets one at the
 * other pole the mapper is behaving exactly as designed, and the key is not a
 * gap — `allowManagedHooksOnly: false` asks for nothing, so there is nothing to
 * report as unmappable.
 *
 * MEASURED before this constant existed (2026-08-27, through
 * `parseManagedPiPolicyTolerantV1` so the shapes are ones a real
 * `managed-policy.json` can produce): six shapes —
 * `allowManagedHooksOnly:false`, `allowManagedPermissionRulesOnly:false`,
 * `enforceAvailableModels:false`, `deniedMcpServers:[]`, `availableModels:[]`
 * and `sandbox:{}` — each reached the `no mapping recorded for this key` branch,
 * whose whole purpose is to say "a field was added to the schema and to no
 * mapping". An alarm that fires on ordinary policy is an alarm that stops being
 * read, and this one fired on the most ordinary policy there is. (A seventh
 * candidate, `strictPluginOnlyCustomization:[]`, does NOT reach it: the parser
 * drops an empty array before the mapper sees the key. Measured, not assumed.)
 *
 * `claudeRules` is in this list AND in {@link CLAUDE_MANAGED_GAPS}, and the gaps
 * table is consulted FIRST — deliberately. Its `allow` list is withheld on
 * purpose, which is a real thing to tell an administrator, so it keeps its gap.
 */
export const CLAUDE_MAPPED_POLICY_KEYS: readonly string[] = Object.freeze([
  'allowManagedHooksOnly',
  'allowManagedMcpServersOnly',
  'allowManagedPermissionRulesOnly',
  'availableModels',
  'claudeRules',
  'deniedMcpServers',
  // P3.285. Present for the reason this list exists: at its NON-ENFORCING pole
  // (`false`) the key asks the SDK for nothing, so it must not reach the
  // "nobody looked" alarm. It still owns a `CLAUDE_MANAGED_GAPS` row, and that
  // row is what a `false` now reports — the host half of the tri-state, which
  // the SDK cannot carry.
  'disableCommandPluginSources',
  'enforceAvailableModels',
  'sandbox',
  'strictPluginOnlyCustomization',
])

/**
 * One probe per sub-key this mapper can withhold from inside a key it carries.
 *
 * Two predicates, and the second one is the point: `sent` reads the BUILT
 * `Settings`, never the policy. So the report is a statement about what actually
 * reached the SDK — when the P2.136 carry fires, the entry drops out of
 * `withheld` because the value is genuinely there, not because a second copy of
 * the carry rule was kept in agreement with the first. A `sent` predicate that
 * ignored its argument would make this table a restatement of the policy, which
 * is exactly the failure it exists to detect.
 */
interface ClaudeWithheldSubKeyProbeV1 {
  readonly path: string
  readonly key: string
  readonly kind: ClaudeManagedSettingsGapKindV1
  readonly reason: string
  /** Did the administrator ASK for something with this sub-key? */
  readonly asked: (policy: ManagedPiPolicyV1) => boolean
  /** Did it reach the SDK? Read off the built settings. */
  readonly sent: (settings: Settings) => boolean
}

const nonEmpty = (list: readonly unknown[] | undefined): boolean => (list?.length ?? 0) > 0

/**
 * Every sub-key an administrator can set that this mapper deliberately does not
 * forward — P2.136.
 *
 * Scoped to sub-keys of policy keys the mapper OTHERWISE CARRIES, because that
 * is the reporting hole: a whole key it withholds already gets a row in
 * {@link CLAUDE_MANAGED_GAPS}, and a whole key it carries entire has nothing to
 * report. The two lists here (`allowedDomains`, `allowRead`) are the ones the
 * measured SDK filter WOULD have carried, which is why their absence was a
 * silent drop rather than a no-op; the other three have no slot in the filter at
 * all and are listed so an administrator is told the same way about all of them.
 */
const CLAUDE_WITHHELD_SUB_KEYS: readonly ClaudeWithheldSubKeyProbeV1[] = Object.freeze([
  {
    path: 'claudeRules.allow',
    key: 'claudeRules',
    kind: 'widening',
    reason: 'an allow rule grants, and a floor never grants; the deny and ask entries beside it were sent',
    asked: policy => nonEmpty(policy.claudeRules?.allow),
    sent: settings => nonEmpty(settings.permissions?.allow),
  },
  {
    path: 'sandbox.excludedCommands',
    key: 'sandbox',
    kind: 'widening',
    reason: 'each entry runs a command OUTSIDE the sandbox; a floor never re-opens the escape hatch',
    asked: policy => nonEmpty(policy.sandbox?.excludedCommands),
    sent: settings => nonEmpty(settings.sandbox?.excludedCommands),
  },
  {
    path: 'sandbox.additionalWritableRoots',
    key: 'sandbox',
    kind: 'widening',
    reason: 'grants write access, and the SDK has no allowManagedWritePathsOnly for it to be the operand of',
    asked: policy => nonEmpty(policy.sandbox?.additionalWritableRoots),
    sent: settings => nonEmpty(settings.sandbox?.filesystem?.allowWrite),
  },
  {
    path: 'sandbox.filesystem.allowWrite',
    key: 'sandbox',
    kind: 'widening',
    reason: 'grants write access, and the SDK has no allowManagedWritePathsOnly for it to be the operand of',
    asked: policy => nonEmpty(policy.sandbox?.filesystem?.allowWrite),
    sent: settings => nonEmpty(settings.sandbox?.filesystem?.allowWrite),
  },
  {
    path: 'sandbox.filesystem.disabled',
    key: 'sandbox',
    kind: 'widening',
    reason: 'true skips filesystem isolation for every path, and a floor never surrenders a boundary; the locking pole (false) IS sent',
    // The only BOOLEAN probe in this table, so both predicates test the pole
    // rather than a length. `asked` is deliberately not `!== false`: an
    // administrator who wrote the lock asked for something that DID reach the
    // SDK, and reporting that as withheld would be the false-alarm failure this
    // table exists to avoid.
    asked: policy => policy.sandbox?.filesystem?.disabled === true,
    sent: settings => settings.sandbox?.filesystem?.disabled === true,
  },
  {
    path: 'sandbox.filesystem.allowRead',
    key: 'sandbox',
    kind: 'widening',
    reason: 'a read re-open with no allowManagedReadPathsOnly beside it merges on top of user and project entries; set that lock and this list is sent as its operand',
    asked: policy => nonEmpty(policy.sandbox?.filesystem?.allowRead),
    sent: settings => nonEmpty(settings.sandbox?.filesystem?.allowRead),
  },
  {
    path: 'sandbox.network.allowedDomains',
    key: 'sandbox',
    kind: 'widening',
    reason: 'a domain allowlist with no allowManagedDomainsOnly beside it merges on top of user and project entries; set that lock and this list is sent as its operand',
    asked: policy => nonEmpty(policy.sandbox?.network?.allowedDomains),
    sent: settings => nonEmpty(settings.sandbox?.network?.allowedDomains),
  },
])

function collectWithheldSubKeys(
  policy: ManagedPiPolicyV1,
  settings: Settings,
): ClaudeManagedSettingsWithheldSubKeyV1[] {
  return CLAUDE_WITHHELD_SUB_KEYS
    .filter(probe => probe.asked(policy) && !probe.sent(settings))
    .map(({ path, key, kind, reason }) => ({ path, key, kind, reason }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

/**
 * Project a composed managed policy onto the SDK's policy tier.
 *
 * Pure, and total over {@link MANAGED_PI_POLICY_KEYS}: every key the policy
 * actually SETS is either in `mapped` or in `unsupported`. Keys the policy does
 * not set are in neither — an absent key is not a gap, and reporting it as one
 * would bury the real gaps in a fixed list of thirty.
 */
/**
 * P6.511 — the product's OWN floor on `command` marketplace sources, as a
 * second `managedSettings` contributor.
 *
 * ## Why this is not a branch inside the mapper
 *
 * It was written there first and sixteen tests said no, correctly. The mapper's
 * root invariant is that a policy which says nothing sends nothing — "a floor
 * never widens", "the non-enforcing pole of a lock is not sent", "a policy that
 * maps to nothing has no slice to lose, so there is no notice". An unconditional
 * emission inside it is not a stricter floor, it is the mapper answering for a
 * policy that was never written, and every one of those sixteen invariants is
 * about exactly that distinction. So the floor is a SECOND contributor, which
 * `buildClaudeManagedSettingsOptions` was built to take (its own comment: "the
 * point is that the SECOND is added here").
 *
 * ## What it says
 *
 * Delegated decision Q-den 42 = option 2: refuse a `command` marketplace source
 * uniformly and close the claude leak. Our resolver refuses the kind on every
 * runtime, unconditionally (`plugins/source-resolver.ts`,
 * `plugin.source.command_refused`), while the claude child would honour one
 * declared in the user's own `extraKnownMarketplaces` — we pass
 * `settingSources: ['user','project','local']`, and 2.1.233 added `command` as
 * a marketplace-entry source kind. A product that refuses a thing on two
 * runtimes and performs it on the third is not enforcing a rule, it is
 * describing one.
 *
 * ## The three states, and why `undefined` is the only one this answers
 *
 * - **unset** — the vendor's default delegates to `allowManagedHooksOnly`. We do
 *   not delegate: our answer does not depend on the hook lock, so the floor
 *   speaks here and this is the state that closes the leak, because the user's
 *   `extraKnownMarketplaces` needs no administrator to exist.
 * - **`true`** — the administrator already said it and the mapper already emits
 *   it. The floor stays silent so the merge reports no collision for two
 *   contributors writing the same value.
 * - **`false`** — the administrator explicitly widened. That is the single
 *   exception this product recognises, and it is the same managed-tier-only
 *   carve-out P6.479 took for `headersHelper` (owner decision 7 of 2026-09-05):
 *   the approval floor for a marketplace-declared command is taken ONCE.
 */
export function claudeCommandPluginSourceFloor(
  policy: ManagedPiPolicyV1 | undefined,
): Settings | undefined {
  if (policy?.disableCommandPluginSources !== undefined) return undefined
  return { disableCommandPluginSources: true }
}

/**
 * P6.688 — the SECOND route `tools-reference.md#enable-the-powershell-tool`
 * names, closed the only way the SDK tier can close it.
 *
 * The page: *"Set `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` in your environment or in
 * `settings.json`"*. P6.530 (`44aee805e`) closed the environment route by
 * pinning the name to the documented `0` in `buildClaudeSubprocessEnv`. The
 * settings route stayed open because we pass
 * `settingSources: ['user','project','local']`, so a repository's own
 * `.claude/settings.json` reaches the child.
 *
 * ## The obvious fix is a SILENT NO-OP, and that is the finding
 *
 * The row asked for the key to be pinned "on the settings route" through this
 * managed pair. **`env` cannot ride the SDK managed tier at all**, in either of
 * the two states the call site has — re-measured on the vendored `2.1.247`
 * binary by this module's own documented method on 2026-09-12 (C3.252), and on
 * `2.1.233` before it; `env` appears in neither filter body:
 *
 *  - **No admin tier present.** The predicate `!e` is true, so our slice goes
 *    through the restrictive filter, and the filter's body (quoted in this
 *    module's docblock) copies fourteen named keys. `env` is not one of them.
 *  - **An admin tier present without `parentSettingsBehavior: 'merge'`.** The
 *    predicate is false and our slice is DISCARDED whole.
 *
 * So an `env` entry emitted here would look like enforcement and do nothing —
 * the exact failure {@link mapManagedPolicyToClaudeSettings}'s `unsupported`
 * partition exists to make impossible. Recorded rather than shipped.
 *
 * ## Why a deny rule is the route that survives
 *
 * `permissions` IS copied by that filter, narrowed to `deny` and `ask`, so a
 * deny rule is the one thing this tier can carry to the question. And the child
 * reads the toggle from the PROCESS environment —
 * `let e=process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL; if(platform!=="windows")
 * return truthy(e)` in the vendored binary — while its settings loader writes a
 * settings `env` block INTO `process.env` with `Object.assign`, policy tier
 * LAST. The binary's own Windows error text says the same thing in words:
 * *"Remove CLAUDE_CODE_USE_POWERSHELL_TOOL from your environment or settings."*
 * A project file can therefore re-arm the toggle whatever we pass; what it
 * cannot do is out-rank a policy-tier deny.
 *
 * ## Why the whole tool, and why this is not a new posture
 *
 * `PowerShell` bare is a whole-tool rule in the shared Claude grammar
 * (`parseClaudeRuleString('PowerShell')` compiles to
 * `{kind:'tool',semanticId:'PowerShell'}`), and the whole tool is the subject:
 * Q-den 67 already decided (option 2, P6.530) that a second command executor
 * must not run outside the deny surface we advertise, because
 * `tools-reference.md#configure-tools-with-permission-rules-and-hooks` gives
 * `Bash(npm run *)` and `PowerShell(Get-ChildItem *)` two separate rows — a
 * `Bash(...)` rule does not bind to it. This applies that same decision to the
 * second route the same page names; it decides nothing new.
 *
 * Unconditional, unlike {@link claudeCommandPluginSourceFloor}: there is no
 * administrator spelling that widens it, because the policy schema has no
 * PowerShell term to widen. An administrator who wants the tool must remove
 * this floor in the product, which is the visible decision the row asks for.
 *
 * NOT a branch inside the mapper, for the reason written out above
 * `claudeCommandPluginSourceFloor`: a policy that says nothing must send
 * nothing. This is a contributor, and the merge site reports collisions.
 */
export const CLAUDE_POWERSHELL_TOOL_DENY_RULE = 'PowerShell'

export function claudePowerShellToolDenyFloor(): Settings {
  return { permissions: { deny: [CLAUDE_POWERSHELL_TOOL_DENY_RULE] } }
}

/**
 * P6.441 — the HOST's attribution answer, projected onto the claude child's
 * policy tier so a project `.claude/settings.json` cannot disagree with it.
 *
 * ## Why the claude runtime needs this and Pi and codex do not
 *
 * The row's own measurement: claude's child has all five keys in the vendored
 * bundle and honours them FROM PROJECT SETTINGS, while Pi and codex have never
 * seen one. We pass `settingSources: ['user','project','local']`, so a
 * checked-in `.claude/settings.json` really does decide the child's trailer —
 * on one runtime of three. The prompt block in `prompts/system.ts` makes the
 * three uniform; this makes the claude child agree with it.
 *
 * ## What the tier can carry, MEASURED, and it is only the OFF direction
 *
 * The SDK's restrictive managed-settings filter, re-extracted from the vendored
 * `2.1.247` by the method in this module's header (2026-09-12, C3.252; the same
 * two were there at `2.1.233`), carries exactly two
 * attribution facts:
 *
 * ```js
 * if(b9(e.attribution,e.includeCoAuthoredBy)==="disabled")r.attribution={...r.attribution,commitTrailers:!1};
 * if(e.attribution?.sessionUrl===!1)r.attribution={...r.attribution,sessionUrl:!1};
 * ```
 *
 * So CUSTOM TEXT cannot ride this tier at all — `commit` and `pr` strings are
 * not copied — and neither are `includeGitInstructions` or `prUrlTemplate`.
 * Those four reach the child the same way they reach Pi and codex: through the
 * system prompt. Emitting them here would be the P6.688/P6.237 silent no-op,
 * and this module exists to prevent exactly that.
 *
 * ## A FLOOR, and floors only remove
 *
 * `undefined` whenever the host wants attribution ON, so an unmanaged install
 * spawns byte-identically. The only thing this can do is turn the child's
 * trailer or session link OFF, which is the direction a floor travels.
 * `includeCoAuthoredBy: false` is the spelling used rather than
 * `attribution.commit: ''` because the filter's own predicate takes both and
 * the boolean is the one whose meaning cannot be mistaken for custom text.
 */
export function claudeAttributionFloor(
  attribution: ResolvedGitAttributionV1,
): Settings | undefined {
  const floor: Record<string, unknown> = {}
  if (attribution.commitTrailer === undefined) floor.includeCoAuthoredBy = false
  if (!attribution.sessionUrl) floor.attribution = { sessionUrl: false }
  return Object.keys(floor).length > 0 ? (floor as Settings) : undefined
}

export function mapManagedPolicyToClaudeSettings(
  policy: ManagedPiPolicyV1 | undefined,
): ClaudeManagedSettingsMappingV1 {
  if (!policy) return Object.freeze({ settings: undefined, mapped: [], unsupported: [], withheld: [] })

  const settings: Settings = {}
  const mapped: string[] = []
  const record = (key: string): void => { mapped.push(key) }

  // permissions.deny / permissions.ask — the load-bearing case, and the one the
  // SDK filter copies unconditionally (`pick(permissions, ['deny','ask'])`).
  // Sourced from `claudeRules` because those are the admin's own rule STRINGS,
  // already validated by the shared Claude grammar at parse time and already
  // narrowed to the entries that compiled.
  const deny = policy.claudeRules?.deny ?? []
  const ask = policy.claudeRules?.ask ?? []
  if (deny.length > 0 || ask.length > 0) {
    const permissions: NonNullable<Settings['permissions']> = {}
    if (deny.length > 0) permissions.deny = [...deny]
    if (ask.length > 0) permissions.ask = [...ask]
    settings.permissions = permissions
    record('claudeRules')
  }

  if (restrictiveTrue(policy.allowManagedHooksOnly)) {
    settings.allowManagedHooksOnly = true
    record('allowManagedHooksOnly')
  }
  if (restrictiveTrue(policy.allowManagedPermissionRulesOnly)) {
    settings.allowManagedPermissionRulesOnly = true
    record('allowManagedPermissionRulesOnly')
  }
  // P6.236 — native-first, step 1, and the one runtime where the key has a
  // subject. `settings-reference.md#allowmanagedmcpserversonly`: "Claude Code
  // then reads `allowedMcpServers` from managed settings alone and ignores
  // allowlists in user, project, and local settings".
  //
  // It matters HERE and only here because we pass
  // `settingSources: ['user','project','local']` to the SDK, so the claude
  // child really does read a user's own `.claude/settings.json` and really can
  // have its allowlist widened by it. On Pi and codex the host holds the only
  // MCP allowlist there is — this schema's — so the switch has nothing to turn
  // off, which the schema field's own docblock records.
  //
  // `restrictiveTrue` is the measurement, not a house style: the filter body
  // re-extracted from the shipped 2.1.247 binary on 2026-09-12 (C3.252) still reads
  // `if(e.allowManagedMcpServersOnly===!0)r.allowManagedMcpServersOnly=!0;`, so
  // a `false` cannot reach the SDK and does not need to — `false` is the
  // documented default on that side too.
  if (restrictiveTrue(policy.allowManagedMcpServersOnly)) {
    settings.allowManagedMcpServersOnly = true
    record('allowManagedMcpServersOnly')
  }
  // P3.285 — native-first, step 1: the SDK gained its OWN control for this key
  // at 2.1.229 and the bundle caught up at 2.1.233, so the host stops being the
  // only thing that can enforce it on this runtime.
  //
  // `restrictiveTrue` is not a house style here, it is the measurement. The
  // filter body, re-extracted from the vendored binary on 2026-09-03 by the
  // method in this module's docblock, reads:
  //
  //   if(e.disableCommandPluginSources===!0)r.disableCommandPluginSources=!0;
  //
  // — so a `false` cannot reach the SDK at all, and does not need to. The SDK's
  // own `Settings` doc for the key states the same tri-state our host reader
  // (`pi-harness/managed-policy.ts:areMarketplaceCommandSourcesAllowed`)
  // resolves: "true: command-sourced plugins are never installed, updated, or
  // re-resolved (the command never runs). false: explicitly allowed. Unset:
  // follows allowManagedHooksOnly". Since we emit `allowManagedHooksOnly` four
  // lines up, an UNSET key delegates on the SDK side to exactly the value it
  // delegates to on ours, and an explicit `false` leaves the SDK at that same
  // delegated default while our own catalog keeps the widened reading. The one
  // boolean therefore mirrors the whole tri-state without a second mapping to
  // keep in step.
  //
  // The host reader is NOT demoted to a mirror by this: our catalog refuses a
  // `command` source outright (`marketplace/external-catalog-adapters.ts`) and
  // the key's other host operand is `headersHelper`, neither of which the SDK
  // sees. What this closes is the surface the host gate cannot reach — we pass
  // `settingSources: ['user','project','local']`, so the SDK's own plugin
  // subsystem reads a user's `extraKnownMarketplaces`, and 2.1.233 added
  // `command` as a marketplace-entry source there.
  if (restrictiveTrue(policy.disableCommandPluginSources)) {
    settings.disableCommandPluginSources = true
    record('disableCommandPluginSources')
  }
  if (policy.strictPluginOnlyCustomization && policy.strictPluginOnlyCustomization.length > 0) {
    settings.strictPluginOnlyCustomization = [...policy.strictPluginOnlyCustomization]
    record('strictPluginOnlyCustomization')
  }
  if (policy.deniedMcpServers && policy.deniedMcpServers.length > 0) {
    // Byte-identical entry shape (`serverName` / `serverCommand` / `serverUrl`),
    // so this is a copy, not a translation. `serverCommand` is re-typed only
    // because the SDK spells the non-empty array in its type and ours does not.
    settings.deniedMcpServers = policy.deniedMcpServers.map(entry => (
      'serverCommand' in entry
        ? { serverCommand: [...entry.serverCommand] as [string, ...string[]] }
        : { ...entry }
    ))
    record('deniedMcpServers')
  }
  if (policy.availableModels && policy.availableModels.length > 0) {
    settings.availableModels = [...policy.availableModels]
    record('availableModels')
  }
  if (restrictiveTrue(policy.enforceAvailableModels)) {
    settings.enforceAvailableModels = true
    record('enforceAvailableModels')
  }

  const sandbox = mapSandbox(policy)
  if (sandbox.mapped) {
    settings.sandbox = sandbox.value
    record('sandbox')
  }

  const unsupported: ClaudeManagedSettingsGapV1[] = []
  const set = policy as unknown as Record<string, unknown>
  for (const key of MANAGED_PI_POLICY_KEYS) {
    if (set[key] === undefined) continue
    if (mapped.includes(key)) continue
    // The three keys a PARSED policy always carries whether or not an
    // administrator wrote anything — the same exclusions `carriesManagedSettings`
    // makes, for the same reason. Reporting them would put three permanent lines
    // in front of every reader and bury the gaps that are real.
    if (key === 'schemaVersion') continue
    if (key === 'disabledPermissionModes' && policy.disabledPermissionModes.length === 0) continue
    if (key === 'permissionDsl' && !carriesNativeDslRules(policy)) continue
    const gap = key === 'permissionDsl' ? claudePermissionDslGap(policy) : CLAUDE_MANAGED_GAPS[key] // F1.832
    if (gap) { unsupported.push(gap); continue }
    // A restricting key an administrator left at its NON-ENFORCING pole is not a
    // gap either: `allowManagedHooksOnly: false` asks for nothing, and neither
    // does an empty `deniedMcpServers` or a `sandbox` that narrows nothing. That
    // sentence was already written — it sat above the gaps lookup — but the
    // `continue` that would have made it TRUE never was, so six ordinary policy
    // shapes reached the alarm below (P2.7 Low, measured and closed by P2.138).
    if (CLAUDE_MAPPED_POLICY_KEYS.includes(key)) continue
    unsupported.push({
      key,
      kind: 'no-sdk-tier',
      // A key nobody has written a row for has, by construction, not been
      // measured on this runtime either. `unmeasured`, never `not-enforced`:
      // the alarm says "nobody looked", which is what is true.
      //
      // With the gaps table and the mapped-key skip both consulted above, this
      // branch is now reachable ONLY by a key added to `MANAGED_PI_POLICY_KEYS`
      // and to neither of them — the single case it was written for, and one
      // `claude-managed-settings.test.ts` pins from both directions (the alarm
      // stays empty over the every-key fixture, and the skip list cannot grow
      // past what the mapper actually maps).
      enforcement: 'unmeasured',
      reason: 'no mapping recorded for this key — add one, or record why it has none',
    })
  }

  return Object.freeze({
    settings: Object.keys(settings).length > 0 ? settings : undefined,
    mapped: Object.freeze([...mapped].sort()),
    unsupported: Object.freeze(unsupported),
    // Computed against the SETTINGS that were just built, so it reports the
    // SDK's view rather than a second reading of the policy — P2.136.
    withheld: Object.freeze(collectWithheldSubKeys(policy, settings)),
  })
}

/**
 * A Claude Code ADMIN settings source found on this machine — P6.234.
 *
 * `managed-settings.md#let-an-embedding-host-add-policy`, verbatim: *"By
 * default, Claude Code ignores parent settings whenever an admin source is
 * present: server-managed settings, an MDM or OS-level policy, or a managed
 * settings file."* Our whole slice is exactly such a parent setting
 * (`Options.managedSettings`), so on a machine that already carries a Claude
 * Code policy this module's output is not filtered — it is DISCARDED, and the
 * predicate transcribed at the top of this file is where that happens
 * (`parentSettingsBehavior === "merge"`, read off the shipped `2.1.247`
 * binary — the anchor scores 1 line / 1 occurrence there, re-measured
 * 2026-09-12, and is still the predicate's own body).
 *
 * The switch is not ours to set. The page: *"set `parentSettingsBehavior` to
 * `"merge"` in the highest-priority managed source; Claude Code reads the key
 * from that source only."* That source belongs to the machine's administrator.
 * So the host can only DETECT the condition and say so, which is what this is.
 */
export interface ClaudeAdminSettingsTierV1 {
  readonly mechanism: 'file' | 'mdm-managed-preferences' | 'windows-hklm'
  /** Where it was found, in the words an administrator would use. */
  readonly location: string
  /**
   * The key that would keep our slice alive, or `undefined` when this host
   * cannot read the source. The two are NOT the same answer and
   * {@link claudeManagedSliceDiscardNotice} says which it has.
   */
  readonly parentSettingsBehavior: string | undefined
  /** Whether the source's contents could be read at all. */
  readonly readable: boolean
}

export interface ClaudeAdminSettingsProbeDeps {
  platform?: NodeJS.Platform
  /** win32 only — `%ProgramFiles%`, the documented admin-ACL root. */
  programFiles?: string
  existsSync?: (path: string) => boolean
  readFileSync?: (path: string) => string
}

/**
 * The documented file location of a Claude Code managed policy, per platform.
 *
 * `managed-settings.md#where-each-mechanism-stores-the-policy`: *"`/Library/
 * Application Support/ClaudeCode/` on macOS, `/etc/claude-code/` on Linux and
 * WSL, and `C:\Program Files\ClaudeCode\` on Windows"*. These are Claude
 * Code's OWN directories and deliberately not ours — this fork's managed policy
 * lives under a Nessy-branded path (`config/managed-system-paths.ts`), and the
 * whole point of this probe is that the two can both be present.
 */
function claudeAdminSettingsFile(platform: NodeJS.Platform, programFiles: string | undefined): string | undefined {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json'
  if (platform === 'win32') {
    return programFiles ? `${programFiles}\\ClaudeCode\\managed-settings.json` : undefined
  }
  return '/etc/claude-code/managed-settings.json'
}

/**
 * The first Claude Code admin source present on this machine, or `undefined`.
 *
 * **Two of the five documented mechanisms are deliberately NOT probed, and the
 * omission is the honest half rather than a gap to hide.** Server-managed
 * settings live in a cache this fork has no path to, and the Windows `HKCU`
 * value is not an admin source for this purpose at all — the page's own table
 * says Claude Code uses it *"only when no other managed source delivers a
 * policy key and no host-supplied parent settings supply a restrictive key"*,
 * which is the opposite of discarding us. `HKLM` and the macOS managed-
 * preferences domain ARE admin sources, and both are reported as PRESENT-BUT-
 * UNREADABLE rather than parsed: reading a binary plist or the registry needs
 * tooling this module does not have, and guessing `merge` from an unreadable
 * source would turn a warning into a false all-clear.
 */
export function detectClaudeAdminSettingsTier(
  deps: ClaudeAdminSettingsProbeDeps = {},
): ClaudeAdminSettingsTierV1 | undefined {
  const platform = deps.platform ?? process.platform
  const exists = deps.existsSync ?? existsSync
  const read = deps.readFileSync ?? ((path: string) => readFileSync(path, 'utf8'))

  // MDM / OS-level policy first: the page ranks it above the file.
  if (platform === 'darwin') {
    const plist = '/Library/Managed Preferences/com.anthropic.claudecode.plist'
    if (exists(plist)) {
      return Object.freeze({
        mechanism: 'mdm-managed-preferences' as const,
        location: plist,
        parentSettingsBehavior: undefined,
        readable: false,
      })
    }
  }

  const file = claudeAdminSettingsFile(platform, deps.programFiles ?? process.env.ProgramFiles)
  if (file && exists(file)) {
    let behavior: string | undefined
    let readable = true
    try {
      const parsed: unknown = JSON.parse(read(file))
      const value = (parsed as { parentSettingsBehavior?: unknown } | null)?.parentSettingsBehavior
      behavior = typeof value === 'string' ? value : undefined
    } catch {
      // A file we cannot read or parse is still an admin source that suppresses
      // us — the SDK decides presence before it decides validity — so this
      // reports UNREADABLE rather than absent.
      readable = false
    }
    return Object.freeze({
      mechanism: 'file' as const,
      location: file,
      parentSettingsBehavior: behavior,
      readable,
    })
  }
  return undefined
}

/**
 * The one operator-visible sentence for P6.234, or `undefined` when there is
 * nothing to say.
 *
 * Nothing to say means exactly two states: no admin source on this machine, or
 * one that sets `parentSettingsBehavior: "merge"` — the row's own control.
 *
 * The sentence names the tier that was found, because "your policy is not in
 * force" without a location is an alarm an administrator cannot act on, and it
 * names the KEYS at stake from the mapping rather than a generic "everything",
 * so the size of the loss is legible.
 */
export function claudeManagedSliceDiscardNotice(
  mapping: ClaudeManagedSettingsMappingV1,
  tier: ClaudeAdminSettingsTierV1 | undefined,
): string | undefined {
  if (!tier || mapping.settings === undefined) return undefined
  if (tier.parentSettingsBehavior === 'merge') return undefined
  const carried = mapping.mapped.join(', ')
  const found = tier.readable
    ? `a Claude Code managed policy at ${tier.location}`
    : `a Claude Code admin source at ${tier.location} that this host cannot read`
  const certainty = tier.readable
    ? 'it does not set parentSettingsBehavior: "merge"'
    : 'whether it sets parentSettingsBehavior: "merge" cannot be determined from here, so the discard '
      + 'cannot be ruled out'
  return `[managed] claude policy tier DISCARDED, not filtered: ${found} is present and ${certainty}. `
    + `Claude Code ignores an embedding host's managed settings whenever an admin source is present, so `
    + `${carried} reach the claude runtime through our own gate only. The switch is the administrator's: `
    + 'set parentSettingsBehavior to "merge" in that source.'
}

/**
 * The spawn-site builder. Absent option when the policy maps to nothing, so an
 * unmanaged install spawns byte-identically to before this row.
 */
export function buildClaudeManagedSettingsOptions(
  policy: ManagedPiPolicyV1 | undefined = resolveManagedPiPolicyFloor(),
): Pick<Options, 'managedSettings'> {
  const mapping = mapManagedPolicyToClaudeSettings(policy)
  return mapping.settings === undefined ? {} : { managedSettings: mapping.settings }
}

/**
 * One line per fact, for the session's debug channel.
 *
 * Written as lines rather than an object because the consumer is
 * `ClaudeAgent`'s `debug`, the same channel the adapter port and the dropped
 * agent roles already go to — a policy that reached the runtime and a policy key
 * that did not belong in the same place.
 */
export function formatClaudeManagedSettingsDiagnostics(
  mapping: ClaudeManagedSettingsMappingV1,
  /**
   * P6.234 — the machine's own Claude Code admin source, when the caller
   * probed for one. Explicitly passed rather than probed here on purpose: this
   * function is pure and its output is compared line-for-line by tests, and a
   * default that touched the filesystem would make those comparisons depend on
   * whatever is installed on the machine running them.
   */
  adminTier?: ClaudeAdminSettingsTierV1,
): readonly string[] {
  const lines: string[] = []
  // FIRST, because every line after it describes a slice this one says is not
  // being applied at all.
  const discarded = claudeManagedSliceDiscardNotice(mapping, adminTier)
  if (discarded) lines.push(discarded)
  if (mapping.mapped.length > 0) {
    // P2.136 — a key that arrived gutted must not read as a key that arrived.
    // The marker is derived from `withheld` rather than stored, so the two
    // cannot disagree; the key names themselves are untouched, because the
    // existing readers of this line grep for `carries: <key>`.
    const partial = new Set(mapping.withheld.map(entry => entry.key))
    const carried = mapping.mapped.map(key => (partial.has(key) ? `${key} (partial)` : key))
    lines.push(`[managed] claude policy tier carries: ${carried.join(', ')}`)
  }
  for (const entry of mapping.withheld) {
    lines.push(`[managed] claude policy tier withholds ${entry.path} (${entry.kind}): ${entry.reason}`)
  }
  for (const gap of mapping.unsupported) {
    // P2.133 — the not-enforced case gets its OWN sentence rather than another
    // "cannot carry" line. "Cannot carry" is a statement about the SDK, and an
    // administrator reads it as "so something else does". For these keys nothing
    // does, and the line has to say the thing that is actually true of the
    // policy the administrator wrote.
    if (gap.kind === 'no-sdk-tier' && gap.enforcement === 'not-enforced') {
      lines.push(`[managed] claude runtime does NOT enforce ${gap.key} — nothing applies it here: ${gap.reason}`)
      continue
    }
    // F1.832 — the half that binds and the half that does not, in one line, so
    // the partial state can never be read as either pole.
    if (gap.kind === 'partially-enforced') {
      lines.push(`[managed] claude runtime enforces ${gap.key} only in part (${gap.kind}): ${gap.reason}; NOT applied here: ${gap.unenforced}`)
      continue
    }
    lines.push(`[managed] claude policy tier cannot carry ${gap.key} (${gap.kind}): ${gap.reason}`)
  }
  return lines
}

/**
 * The keys an administrator SET that are MEASURED to enforce nothing here.
 *
 * The admin-surface half of P2.133: the mapping already reports every gap, but a
 * surface that prints thirty reasons buries the three that mean "your policy is
 * not in effect". This is the subset a UI should show as a warning rather than
 * as an explanation, and it is derived from the mapping — never a second list.
 *
 * `unmeasured` keys are deliberately NOT here. They are a lead for whoever
 * measures next, not a finding to put in front of an administrator.
 */
export function claudeManagedPolicyUnenforcedKeys(
  mapping: ClaudeManagedSettingsMappingV1,
): readonly string[] {
  return Object.freeze(
    mapping.unsupported
      .filter(gap => gap.kind === 'no-sdk-tier' && gap.enforcement === 'not-enforced')
      .map(gap => gap.key)
      .sort(),
  )
}

/**
 * F1.593 — `managedMcpServers`' row, declared as a hoisted function at the file
 * end so the table above keeps its line count (this file is cited by line up to
 * its line 2004).
 *
 * `enforced-elsewhere`, and measured: driven on the vendored 2.1.267 with a
 * loopback MCP stub, `Options.managedSettings.managedMcpServers` — the parent
 * tier this mapper feeds — connected NOTHING, against `Options.mcpServers`
 * connecting the same server. The tier's restrictive-only filter (re-extracted by
 * this file's own anchor, `parentSettingsBehavior==="merge"`) copies no additive
 * key, and the vendor reads this one from a real admin tier this host cannot
 * write. So it is not projected — a projection would be a silent drop and, the
 * day a lift admitted it, a second copy of every org server beside the pool's —
 * and the host pool delivers it on all three runtimes instead
 * (`mcp/runtime-pool-servers.ts` symbol `foldManagedOrgMcpServers`).
 */
function claudeManagedMcpServersGap(): ClaudeManagedSettingsGapV1 {
  return {
    key: 'managedMcpServers',
    kind: 'enforced-elsewhere',
    reason: 'the SDK managed-settings filter copies no additive key (at 2.1.267 a server handed over it connected '
      + 'nothing), so the host pool delivers the organisation\'s servers on every runtime, claude through the '
      + 'same source proxy as any other pool server',
  }
}

/**
 * F1.832 — the PARTIAL state, declared at the file end (with the two type lines
 * above that name it) so every doc-cited line of this file keeps its number.
 *
 * `permissionDsl` is the one key whose enforcement on claude depends on what the
 * administrator wrote IN it. The host PreToolUse gate binds its DENY rules
 * (F1.813) and its ASK rules (F1.830), and an ALLOW rule is not honoured:
 * `claudeReadablePermissionDeny` (`claude-readable-permission-deny.ts`, whose
 * header names this residue) answers only those two halves, so a call
 * a managed allow grants gets the permission mode's own answer instead — a
 * stated residue of F1.813, fail-closed, since the mode can only be stricter.
 * Before this row the key was `enforced-elsewhere` whatever it held, so a policy
 * whose allow rule did nothing here read as wholly in force.
 *
 * `unenforced` is required on this kind and nowhere else, for the reason
 * `enforcement` is required on `no-sdk-tier` alone: "partially enforced" without
 * the half that is NOT applied is the same half-truth `enforced-elsewhere` told.
 *
 * Deliberately NOT in {@link claudeManagedPolicyUnenforcedKeys}: that list feeds
 * the durable "nothing on this runtime applies that" notice, which is false of a
 * key whose deny and ask halves bind. The debug line names both halves, and the
 * unhonoured allow half gets its OWN durable notice (F1.1001, owner 2026-09-26),
 * rendered from `unenforcedRuleIds` by {@link claudeManagedPolicyUnhonouredAllowNotices}.
 */
export type ClaudeManagedSettingsPartialGapKindV1 = 'partially-enforced'

export type ClaudeManagedSettingsPartialGapV1 = ClaudeManagedSettingsGapBase & {
  readonly kind: ClaudeManagedSettingsPartialGapKindV1
  /** The half of the key the administrator wrote that NOTHING applies on this runtime. */
  readonly unenforced: string
  /** F1.1001 — the administrator's rule ids in that half, in policy order; the durable notice names these. */
  readonly unenforcedRuleIds: readonly string[]
}

/**
 * `permissionDsl`'s row for THIS policy: `enforced-elsewhere` while every native
 * rule is a deny or an ask, `partially-enforced` once one is an allow.
 *
 * Counts the administrator's own rules only. The `claude-allow-<n>` copies the
 * parser compiles from `claudeRules.allow` are already reported as that
 * sub-key's `withheld` entry, and counting them here too would report one
 * withheld rule twice — the reason {@link carriesNativeDslRules} exists.
 */
function claudePermissionDslGap(policy: ManagedPiPolicyV1): ClaudeManagedSettingsGapV1 | undefined {
  const whole = CLAUDE_MANAGED_GAPS.permissionDsl
  const allowIds = (policy.permissionDsl?.rules ?? [])
    .filter(rule => rule.action === 'allow' && !GENERATED_CLAUDE_RULE_ID.test(rule.id))
    .map(rule => rule.id)
  if (!whole || allowIds.length === 0) return whole
  return {
    key: 'permissionDsl',
    kind: 'partially-enforced',
    reason: 'our DSL has no Claude rule-string spelling, so the host PreToolUse gate enforces its deny rules '
      + '(F1.813) and its ask rules (F1.830) on this runtime',
    unenforced: `its allow rules (${allowIds.join(', ')}) are not honoured: a call one of them grants gets the `
      + 'permission mode\'s own answer instead, so it may still ask',
    unenforcedRuleIds: Object.freeze(allowIds),
  }
}

/**
 * The one translation {@link claudeManagedPolicyUnhonouredAllowNotices} renders.
 * Passed in rather than imported, because this file's import block sits above
 * lines the docs cite by number; `i18n.t` satisfies it (i18next binds its members).
 */
export type ClaudeManagedPolicyAllowNoticeTranslate = (
  key: 'chat.managedPolicy.permissionDslAllowUnhonoured',
  options: { rules: string },
) => string

/**
 * F1.1001 — the managed `permissionDsl` ALLOW rules claude does not honour, as
 * zero or one sentence for the session's DURABLE chat channel.
 *
 * Owner decision 2026-09-26: the unhonoured allow half F1.832 reports on the
 * debug channel gets one lasting notice per session, on the channel the withheld
 * `autoMode.allow` already uses (`ClaudeAgent.queueDegradationNotice`). Derived
 * from the mapping's own `partially-enforced` gap, never a second read of the
 * policy, so it names exactly the ids the debug line names: the administrator's
 * native allow rules. The `claude-allow-<n>` copies compiled from
 * `claudeRules.allow` never reach it, because that sub-key is already reported
 * as withheld (see {@link claudePermissionDslGap}).
 *
 * The caller's latch keys on the rendered TEXT. A mid-session policy reload that
 * changes the ids therefore says the new set once more, which is a new fact;
 * the autoMode notice has no parameters, so it cannot differ that way.
 */
export function claudeManagedPolicyUnhonouredAllowNotices(
  mapping: ClaudeManagedSettingsMappingV1,
  t: ClaudeManagedPolicyAllowNoticeTranslate,
): readonly string[] {
  const ids = mapping.unsupported.flatMap(gap => (gap.kind === 'partially-enforced' ? gap.unenforcedRuleIds : []))
  if (ids.length === 0) return []
  return [t('chat.managedPolicy.permissionDslAllowUnhonoured', { rules: ids.join(', ') })]
}
