/**
 * The `/doctor`-class configuration diagnosis report.
 *
 * `managed-settings.md#invalid-entries-in-managed-settings` — "[`claude
 * doctor`](/docs/en/debug-your-config) lists each invalid entry with its source
 * and field." (That anchor is the explicit span a rename left behind; the
 * heading above it reads *Find entries Claude Code dropped* today.)
 *
 * `server-managed-settings.md#invalid-entries-in-delivered-settings` —
 * "Validate a payload change with `claude doctor` on a test machine before
 * rolling it out to the organization." That is the pre-deployment fleet check
 * this report's exit code is read by, and it is named again at every site
 * below that decides whether a line moves the exit code.
 *
 * `settings.md#fix-a-broken-settings-file` — "After you continue, run `/status`
 * to see the affected files and `claude doctor` for the details of each error."
 *
 * `server-managed-settings.md#settings-precedence` — "If you clear your
 * server-managed configuration in the admin console with the intent of falling
 * back to an endpoint-managed plist or registry policy, be aware that cached
 * settings persist on client machines until the next successful fetch, and the
 * keys that apply only at the next launch, such as `model`, stay in effect
 * until each client relaunches. Run `/status` to see which managed source is
 * active."
 *
 * `managed-settings.md#read-the-source-in-/status` — "When a managed source is
 * in effect, the line lists `Enterprise managed settings` with the source
 * Claude Code selected in parentheses", `(remote)` and `(file)` among them. The
 * slash inside that anchor is part of it: a heading's slash survives the slug.
 *
 * ## Scope, and what is deliberately outside it
 *
 * `debug-your-config.md:26` scopes `/doctor` to a "Setup checkup: installation
 * health, invalid settings files, unused extensions, duplicate subagent names
 * in the same directory, and checked-in `CLAUDE.md` content". Hook matcher
 * diagnostics belong to `/hooks` (`:23`, `:62`-`:72`), context accounting to
 * `/context` (`:15`), and MCP connection status to `/mcp` (`:52`). Those are
 * per-session and this report is session-free, which is the property
 * `debug-your-config.md:46` names for the terminal form: "prints read-only
 * installation and settings diagnostics **without starting a session**".
 *
 * So this module carries exactly the settings half, and each section is here
 * because a documented sentence requires it. A diagnostics surface that shows
 * everything shows nothing.
 *
 * Pure by construction: every input is passed in. The caller that owns the
 * process — today the CLI — is the one that can read the managed policy file,
 * the delivery cache and the user config, and it is the only place those reads
 * belong.
 */

import type { DpRuntimeSource } from '../auth/dp/dp-binary.ts'
import type { ManagedPolicyDropV1, RejectedSettingsLayerV1 } from './managed-drops.ts'
import {
  REJECTED_LAYER_REASON_MAX,
  formatManagedPolicyDrop,
  sanitizeSettingsDiagnostic,
} from './managed-drops.ts'
import type { ManagedPolicyWinnerV1 } from './managed-composition.ts'
import {
  formatManagedPolicyCaveat,
  type ManagedPolicyCaveatV1,
} from '../agent/pi-harness/managed-policy.ts'
import {
  describeRefusedUserAutoModeKeys,
  type UserScopeAutoModeReadV1,
} from '../agent/pi-harness/user-auto-mode-policy.ts'
import type {
  ResolvedSandboxNetworkSettings,
  SandboxNetworkEnforcementV1,
} from './sandbox-settings.ts'
import {
  hasUnfulfilledPluginMandate,
  type MandatedPluginFindingV1,
} from '../plugins/mandated-plugins.ts'

/**
 * Re-exported from the diagnostics primitive so a reader imports one module.
 * The type lives beside {@link sanitizeSettingsDiagnostic} because the tier that
 * produces it — the strict user/project/local parse — must not import this
 * rendering module to record one.
 */
export type { RejectedSettingsLayerV1 } from './managed-drops.ts'

/** P6.246(c) — the delivered-policy outcome, as the doctor needs to state it. */
export interface ManagedDeliveryDoctorInputV1 {
  /** Whether this process opted into server-delivered settings at all. */
  readonly enabled: boolean
  /** Which payload the live state is holding. */
  readonly source: 'none' | 'cache' | 'server'
  /** True only after a fetch SUCCEEDED in this session. */
  readonly confirmed: boolean
  /** Why the last fetch failed, when one did. */
  readonly fetchError?: { readonly cause: string; readonly at: number } | undefined
}

export interface ConfigDoctorInputV1 {
  /** Every managed entry the tolerant parse refused, with its source and field. */
  readonly drops: readonly ManagedPolicyDropV1[]
  /** Which managed source supplied the enforced policy. */
  readonly winner: ManagedPolicyWinnerV1
  /**
   * Whether the host-owned FILE policy carries any setting at all.
   *
   * Load-bearing rather than cosmetic: `winner === 'delivered'` while this is
   * `true` is precisely the state the cleared-console paragraph of
   * `server-managed-settings.md#settings-precedence` warns about, and it is
   * invisible to an administrator today.
   */
  readonly fileCarriesSettings: boolean
  /** Where the host-owned policy file is read from, when the platform has one. */
  readonly filePath?: string | undefined
  /** Where the delivered payload is cached. */
  readonly deliveryCachePath?: string | undefined
  /**
   * P6.246(c) — the DELIVERY OUTCOME, which is a different question from
   * {@link winner}.
   *
   * `winner` answers *what is enforced*. This answers *was the organisation's
   * remote policy asked for, and did it arrive* — the question an administrator
   * actually opens this report with, and the one no surface could answer:
   * a failed fetch threw out of `refreshManagedDelivery` and published nothing,
   * so the cause reached the caller's control flow and no further.
   *
   * `undefined` when the host could not resolve a delivery state at all, which
   * is a different thing from `enabled: false` — that one is a real answer
   * ("nothing configured").
   */
  readonly delivery?: ManagedDeliveryDoctorInputV1 | undefined
  /** Strict-tier layers rejected at load. */
  readonly rejectedLayers?: readonly RejectedSettingsLayerV1[] | undefined
  /**
   * The enforced model allowlist (`settings-reference.md#availablemodels`), and
   * whether it reaches the Default
   * (`settings-reference.md#enforceavailablemodels`).
   *
   * Here because the allowlist is the one enforced policy an administrator
   * cannot read back from any other surface. It is not a "finding" — a valid
   * allowlist is a working policy, not a problem — so it never sets
   * `hasFindings`. It is the report's answer to the two questions a restricted
   * user's ticket raises: is a policy in effect, and what does it permit.
   *
   * `undefined` means no allowlist; `[]` means one is deployed and admits no
   * named model, which is `managed-settings.md#keys-that-fail-closed`'s reading
   * of an invalid value — "Enforced as an empty allowlist until fixed, so only
   * the Default model is available" — and looks identical to a working policy
   * from the outside. Telling those two
   * apart is most of why this section exists.
   */
  readonly availableModels?: readonly string[] | undefined
  readonly enforceAvailableModels?: boolean | undefined
  /**
   * T1 (2026-08-12) — the resolved `sandbox.enabled` master switch, from the
   * SAME composition the process supervisor is built from
   * (`resolveHostSandboxSettings`). `undefined` only when the host could not
   * resolve one at all (mirrors `sandboxNetwork`/`sandboxFilesystem`); a
   * fresh, unconfigured install still reports `false` here, which is the
   * point of this field — an operator must be able to read back that nothing
   * is being wrapped without already suspecting it.
   *
   * `false` is a deliberate default (owner decision 2026-08-12), never a
   * finding — the same rule the retention `disabled` state and
   * `sandbox.filesystem.disabled` already follow in this report.
   */
  readonly sandboxEnabled?: boolean | undefined
  /**
   * The effective `sandbox.network` policy and what the host can actually do
   * about it.
   *
   * Here for the same reason the model allowlist is: it is enforced state an
   * administrator cannot read back anywhere else. It differs in one way that
   * makes it more urgent — part of it CANNOT be enforced, because no OS
   * isolation primitive filters by domain, and a rule that does not bind is
   * exactly the thing a packet capture is otherwise needed to discover.
   */
  readonly sandboxNetwork?: SandboxNetworkDoctorInputV1 | undefined
  /**
   * What `sandbox.filesystem.disabled` surrendered, from
   * `resolveSandboxFilesystemConsequences`. Absent or empty when the filesystem
   * layer is on, which is every default install.
   *
   * Here because the key's cost is not visible from its name: `sandboxing.md:201`
   * describes it as skipping filesystem isolation, and `:478` is where the price
   * is stated. A user who set it deserves to read what it cost in the one place
   * that reports what their configuration actually does.
   */
  readonly sandboxFilesystem?: readonly string[] | undefined
  /**
   * The documented-but-uncarried `sandbox.*` keys this machine's own settings
   * carry, dotted and sorted — P6.710, the second reader of P6.233's list.
   *
   * Supply it from `documentedUncarriedSandboxKeys(<the raw user sandbox
   * layer>)`, the SAME function `resolveHostSandboxSettings` calls, so the two
   * surfaces cannot name different keys. Passed in rather than read here for
   * this module's own reason: the process owner does the reads.
   *
   * Here because `debug-your-config.md` scopes the terminal form to
   * "installation and settings diagnostics **without starting a session**", and
   * P6.233 put the naming on the SESSION composition path only — so a key an
   * operator wrote, accepted and carried nowhere, could be read back only by
   * starting a session and watching a diagnostic channel. That is precisely the
   * state this report exists to make readable.
   *
   * NOT a finding, on the same rule `sandbox.filesystem.disabled` follows: the
   * key is accepted, not invalid, and a fleet check that failed on a documented
   * key an operator legitimately wrote would be telling them to un-write it.
   */
  readonly sandboxUncarriedKeys?: readonly string[] | undefined
  /**
   * What the age-based retention sweep would do on this machine right now.
   *
   * Here because the pause has to be TOLD, not only taken. The key itself is
   * `settings-reference.md#cleanupperioddays`; the pause is stated a page away,
   * at `claude-directory.md#cleaned-up-automatically`: "When the cause is a
   * settings file that can't be read or parsed, or settings errors with
   * `cleanupPeriodDays` or `desktopSessionCleanupPeriodDays` explicitly set,
   * Claude Code also shows a warning in `/status` until you fix the settings
   * errors." A paused destructive sweep is the definition of a finding — data the
   * user believes is being cleaned up is not — so unlike the allowlist section
   * this one DOES set `hasFindings`, which is what lets a fleet check catch it.
   *
   * The DECISION, not the sweep's status record: a `doctor` process never runs a
   * sweep, so a status record would always read "not-run" here.
   */
  readonly retention?: RetentionDoctorInputV1 | undefined
  /**
   * What each plugin the policy force-enables can actually do on this machine.
   *
   * Here because a managed `enabledPlugins` entry naming a plugin that is not
   * installed is a SILENT no-op: nothing installs it, the activation overlay
   * matches nothing, and the administrator's mandate does nothing at all with no
   * signal anywhere. That is the same defect class as a policy key with no
   * reader, and `server-managed-settings.md#invalid-entries-in-delivered-settings`
   * puts the pre-deployment check for exactly that on this command: "Validate a
   * payload change with `claude doctor` on a test machine before rolling it out
   * to the organization."
   *
   * Absent when the caller cannot read the plugin registry — the section is then
   * omitted rather than reported as "none", because "no mandate is unfulfilled"
   * and "I could not look" are different answers.
   */
  readonly mandatedPlugins?: readonly MandatedPluginFindingV1[] | undefined
  /**
   * Every malformed agent definition file the strict validator refused.
   *
   * Here because the RUNTIME no longer fails on one: a malformed definition in
   * `~/.nessy-agent/agents/` is skipped at send time so it cannot kill the
   * session (it used to kill every send in every session), which makes this
   * report the surface where the skip gets NAMED. The subagent checkup is
   * doctor's documented territory — `debug-your-config.md:26` scopes `/doctor`
   * to a "Setup checkup: installation health, invalid settings files, unused
   * extensions, duplicate subagent names in the same directory, and checked-in
   * `CLAUDE.md` content".
   *
   * Absent when the caller could not read the agents directory — omitted
   * rather than reported as "none", because "every definition is valid" and
   * "I could not look" are different answers.
   */
  readonly agentDefinitions?: readonly AgentDefinitionFindingV1[] | undefined
  /**
   * The checked-in project instruction files in the working directory, each
   * with its size and its section breakdown — P6.398.
   *
   * The LAST clause of the same `debug-your-config.md:26` sentence the agent
   * checkup above cites: "…and checked-in `CLAUDE.md` content". It is the only
   * item in that documented scope this report did not carry.
   *
   * Absent when the caller could not read the directory — omitted rather than
   * reported as "none", on the same rule as the field above: "no instruction
   * file" and "I could not look" are different answers.
   */
  readonly instructionFiles?: readonly InstructionFileFindingV1[] | undefined
  /**
   * Managed MCP entries that ARE enforced, and not the way they read — P2.409,
   * closing the surface P2.398 could not reach.
   *
   * The third state beside "enforced" and "refused", and {@link drops} cannot
   * carry it: every disposition of a drop means *not applied*, while a caveat is
   * applied — on the denylist, over a wider span than the text describes.
   *
   * **This is the surface that matters most for them.** The two other readers
   * (`createStorageRuntime`'s load-time summary on stderr / the main log) print
   * once, at boot, into a stream nobody is watching when they need it. An
   * administrator whose policy is misbehaving runs `doctor` —
   * `server-managed-settings.md#invalid-entries-in-delivered-settings` puts the
   * pre-deployment check here in terms: "Validate a payload change with `claude
   * doctor` on a test machine before rolling it out to the organization." The
   * older wording this comment quoted (about deploying fleet-wide) is on no
   * Claude page today, so it is dropped rather than re-anchored, per the
   * disposition document's §5.2.
   * A caveat is exactly what that check is for: the policy is
   * syntactically fine, deploys cleanly, and enforces a different scope from the
   * one written.
   *
   * Absent when the caller could not resolve a policy at all — the section is
   * then omitted rather than reported as "none", because "no entry is enforced
   * differently" and "I could not look" are different answers.
   */
  readonly caveats?: readonly ManagedPolicyCaveatV1[] | undefined
  /**
   * P6.359 — which ripgrep the HOST's search actually runs, and whether it is
   * the vendored one or one found on `PATH`.
   *
   * `troubleshooting.md#search-and-discovery-issues` tells a user to flip
   * `USE_BUILTIN_RIPGREP` to `0` and then confirm it took, verbatim: *"run
   * `claude doctor` in your terminal and check that the Search line shows the
   * path of your system ripgrep instead of `OK (bundled)`."* We had no such
   * line on any runtime, so the resolved binary was unobservable everywhere.
   *
   * **Scope, stated because the page's sentence is about a different binary.**
   * This names the binary `packages/server-core/src/services/search.ts` runs —
   * one host service serving Pi, Claude Code and Codex sessions alike, which is
   * why the entry is identical on all three. It says NOTHING about the ripgrep
   * compiled into the vendored claude executable, which the child resolves for
   * itself; making `USE_BUILTIN_RIPGREP` reach that child is the other half of
   * the row and lands elsewhere.
   *
   * Absent when the caller did not look, which is a different answer from
   * "looked and found none" — the same distinction `caveats` above draws.
   */
  readonly searchBackend?: SearchBackendDoctorInputV1 | undefined

  /**
   * P6.255 (c) — the network trust chain this host actually resolved.
   *
   * The row's third deliverable, and the reason it exists: an operator whose
   * requests go through a corporate proxy, verify against a private CA and
   * present a client certificate had NO surface naming any of the three. The
   * host resolved all of it and said nothing, so a wrong answer looked like a
   * network outage.
   *
   * Absent when the caller did not look, like `searchBackend` above.
   */
  readonly networkTrust?: NetworkTrustDoctorInputV1 | undefined
  /** DA1.34 — the shared gateway credential's state, and the code a re-mint would report. */
  readonly gatewayAuth?: GatewayAuthDoctorInputV1 | undefined

  /**
   * P6.493's last clause — the safety judge's USER scope, as this machine reads
   * it, so the asymmetry is STATED at the settings surface instead of being
   * inferred from a key that quietly did nothing.
   *
   * The block is one direction only: `hard_deny`/`soft_deny` travel from the
   * user's own settings file, `allow`/`environment` do not, and until a surface
   * says so a developer writing `allow` there meets silence and concludes the
   * file is not read at all.
   *
   * Absent when the caller did not look, like `searchBackend` above.
   */
  readonly userAutoMode?: UserScopeAutoModeReadV1 | undefined

  /**
   * P6.878 — the values `config.json` carries that never took effect.
   *
   * `validateConfig()` is the only reader that names them. Six keys in
   * `validators.ts` say so in their own comments — `crossSessionInbound`,
   * `neverPersistSessions`, `unattendedApprovalFallback`,
   * `claudeSwitchModelsOnFlag` among them — each typed there for one reason:
   * the production load path stays unknown-tolerant, so a wrong value resolves
   * to the default SILENTLY, and *"`validateConfig()` is then the only place a
   * user learns their value never took effect"*. That place was the
   * `config_validate` session tool, which nobody is prompted to run, and the
   * watcher's own route to a user was a callback with no writer at all — so the
   * report existed and reached nobody. P6.884 has since DELETED that callback
   * (`47eafa2ea`), on the finding this collector is the one voice; the watcher's
   * chain now ends at a `debug()` line, deliberately.
   *
   * Absent when the caller did not look, like `searchBackend` above.
   */
  readonly storedConfigValidation?: StoredConfigValidationDoctorInputV1 | undefined

  /**
   * P6.824 — the six settings that have readers, envelopes and tests and no way
   * for a user to reach them.
   *
   * `claudeExplorePlanAgentsEnabled`, `systemPromptAppend`,
   * `claudeSwitchModelsOnFlag`, `fileCheckpointingEnabled`,
   * `sessionAllowedTools`, `sessionDisallowedTools`. Each was built with its own
   * row, its own envelope entry and its own tests, and each is settable only by
   * editing a file — so the value in force is discoverable nowhere at all.
   *
   * Here rather than on the AI settings page, by the controller's P6.810
   * recommendation applied once to the family: an operator-shaped key belongs in
   * the doctor and the settings reference, not in a control beside the model
   * picker. Their defaults are unchanged by this row.
   *
   * Absent when the caller did not look, like `searchBackend` above.
   */
  readonly configOnlySettings?: ConfigOnlySettingsDoctorInputV1 | undefined

  /**
   * P6.733 — identity export is ON: this session's id reaches the operator's
   * telemetry collector. A3.2 narrowed both halves of that sentence — see the
   * `telemetry-identity-exported` arm of `clauseEnglish` for why the account is
   * not named and why the streams are not enumerated.
   *
   * D13's accepted cost, and until now it had no surface at all. It is not a
   * settings TIER, and it rides the session line for the reason a second notice
   * would be worse: same moment, same audience, one sentence.
   *
   * Absent means the caller did not resolve it, which is a different answer from
   * `false` and keeps every existing caller's output byte-identical.
   */
  readonly telemetryIdentityExported?: boolean | undefined

  /**
   * C3.199 — which event vocabulary this session exports, when it exports.
   *
   * Absent means the caller did not resolve it — a machine with no exporter, or
   * a reader that has no runtime to speak for — which is a different answer from
   * any of the three dialects and keeps every existing caller byte-identical.
   */
  readonly telemetryEventDialect?: TelemetryEventDialectV1 | undefined
  /**
   * A3.3 — what the runtime says it authorized with, and what this connection
   * implies it should have. Resolved by the caller; see the clause of the same
   * name. Both are vendor enum members, never a credential.
   */
  readonly childCredentialSource?: { readonly source: string; readonly expected: string } | undefined
  /**
   * D1.139 / D1.250 — the claude auto-memory disposition, but ONLY when it is
   * one of the two abnormal states. Resolved by the caller, because the answer
   * depends on this session's memory scope and on the per-workspace claude
   * config dir the spawn would use, neither of which this module can see.
   *
   * Absent means "ordinary, or not a claude session", which is what keeps every
   * existing caller's output byte-identical — and the ordinary state is absent
   * BY CONSTRUCTION rather than by the caller's discretion: it is true of every
   * claude session, so a clause for it is a line on all of them.
   */
  readonly claudeAutoMemoryState?: 'forced-on' | 'off-by-host' | undefined
}

/**
 * The three legs of the chain, as the host resolved them for THIS process.
 *
 * Deliberately three flat records rather than the resolver types themselves:
 * `TlsCaRuntime` and `ClientIdentityRuntime` carry the certificate and key
 * BYTES, and this module's output is rendered into a report, copied into
 * tickets and serialised into `--json`. A doctor input that cannot hold key
 * material cannot leak it. `network-mtls.ts`'s own header states the same rule
 * for its errors: paths and errno text only.
 */
export interface NetworkTrustDoctorInputV1 {
  /**
   * Every proxy variable set in this process's environment, in the order the
   * reader consults them, WINNER FIRST. Values are redacted here rather than by
   * the caller: a proxy URL routinely carries credentials, and a redaction the
   * renderer performs cannot be forgotten by a second caller.
   */
  readonly proxyEnv: readonly { readonly name: string; readonly value: string }[]
  /** `NO_PROXY`/`no_proxy` as this process sees it, when either is set. */
  readonly noProxy?: string | undefined
  /** Which tier supplied the extra CA, and the file it came from. */
  readonly caSource: 'managed' | 'custom' | 'bundled' | 'none'
  readonly caPath?: string | undefined
  /** Set when the configured CA file could not be read. A finding. */
  readonly caWarning?: string | undefined
  /** Whether a client identity is configured at all (both paths present). */
  readonly clientCertificate: boolean
  /**
   * Set when a client identity is configured and did not resolve — a key
   * without a certificate, an unreadable file. A finding: the connection then
   * presents no identity, and `network-mtls.ts` requires that to be loud.
   */
  readonly clientCertificateError?: string | undefined
  /**
   * Whether `CLAUDE_CODE_DISABLE_MTLS_RELOAD_ON_STALE_CONNECTION` is set here.
   * Reported rather than judged: it is a real switch in the vendored binary
   * (P6.259 classifies it as `transport`, so a managed block cannot apply it
   * before confirmation), and an operator who set it deliberately is not
   * misconfigured — but an operator whose rotation stopped working needs to see
   * it in the same place as the certificate it silences.
   */
  readonly mtlsReloadDisabled: boolean
}

/**
 * P6.168 — settings provenance, and the shape is the finding.
 *
 * No surface on any runtime named which file supplied an effective setting.
 * `settings.md` says so of the runtime we vendor too, verbatim: *"The line
 * confirms which files Claude Code read; it doesn't show which file supplied
 * each key."* Its two narrow exceptions do not answer it either — `claude
 * doctor` lists REJECTED entries only, and the startup header names a file only
 * for a model set by project or managed settings — and `SDKSystemMessage`
 * carries no such field (P6.32, four spellings scoring 0 against 2 controls).
 * So the host builds it once, for all three runtimes.
 *
 * **Per FAMILY, not per key, and that correction is load-bearing.** There is no
 * whole-settings merge in this host to hang per-key provenance on. Four
 * independent readers each take their own narrow slice of `.claude/settings.json`
 * with their own scope order, and they do not meet: permission rules
 * (`capabilities/native-sources.ts`), instruction excludes
 * (`agent/memory/instruction-excludes.ts`), skill overrides
 * (`config/skill-overrides.ts`) and managed settings (this module). Inventing a
 * merged object to attribute keys to would be a second, fictional resolver — the
 * exact failure mode the read-don't-invent rule names.
 */
export type SettingsProvenanceScopeV1 = 'managed' | 'user' | 'project' | 'local'

/** How a family's scopes combine — three different answers, none assumable. */
export type SettingsProvenanceCombineV1 = 'last-wins' | 'union' | 'winner-takes-all'

export type SettingsProvenanceFamilyIdV1 =
  | 'permissions'
  | 'instructionExcludes'
  | 'skillOverrides'
  | 'managedSettings'

export interface SettingsProvenanceEntryV1 {
  readonly scope: SettingsProvenanceScopeV1
  /** Absolute, as the user would open it. */
  readonly file: string
  /**
   * `supplies` is the only state that answers the question this view exists for.
   * `present-no-keys` is separated from `missing` deliberately: a file that
   * exists and sets nothing for this family is the state a user misreads as
   * "my setting is being ignored", and it is invisible in a listing that only
   * says which files were READ.
   */
  readonly state: 'supplies' | 'present-no-keys' | 'missing'
}

export interface SettingsProvenanceFamilyV1 {
  readonly id: SettingsProvenanceFamilyIdV1
  readonly combine: SettingsProvenanceCombineV1
  /** In the order the host applies them; later entries win under `last-wins`. */
  readonly entries: readonly SettingsProvenanceEntryV1[]
}

export interface SettingsProvenanceReportV1 {
  readonly families: readonly SettingsProvenanceFamilyV1[]
  /**
   * The stack a Claude Code CHILD loads for itself, from the `settingSources` this host
   * passes it (`claude-agent.ts`; `project`/`local` only for a trusted project, F1.768/F1.790).
   *
   * A second stack, listed as one: we name the files we told the runtime to
   * read, and we cannot read back what it made of them — the page says so of
   * its own startup line. Showing one stack would be the silent divergence this
   * view removes, so the honest surface shows two. Empty when no project is
   * open, since two of the three sources are project-scoped.
   */
  readonly claudeChildSettingSources: readonly SettingsProvenanceEntryV1[]
  /** Absent when no project directory is open; two scopes then cannot contribute. */
  readonly projectDirectory?: string | undefined
  /**
   * P6.169 — the codex runtime's OWN per-key answer, when a codex session has
   * run in this host process and reported one.
   *
   * Its own section rather than merged into `families`: the host families are
   * per-family attributions of `.claude/settings.json`, and this is per key from
   * a different runtime's own config stack. Folding them together would claim a
   * merge nobody performs — the same reason `claudeChildSettingSources` is a
   * second stack rather than a fifth family.
   *
   * Absent means "no codex session has answered here", not "codex has no
   * layers": the read rides a live app-server connection, and a settings page
   * has no session of its own.
   */
  readonly codex?: CodexConfigProvenanceV1 | undefined
}

/**
 * P6.169 — the codex arm, and it is a THIRD shape again: per KEY, from the
 * runtime, rather than per family from the host.
 *
 * ## Native mechanism, step 1 — the runtime publishes this and we never asked
 *
 * `config/read` with `includeLayers: true` over the app-server connection a
 * codex session already holds. `origins` is literally key → layer
 * (`generated/v2/ConfigReadResponse.ts`), `ConfigLayerSource` names an absolute
 * file per layer (`packagedDefaults`, `system`, `user{file,profile}`,
 * `project{dotCodexFolder}`, `legacyManagedConfigTomlFromFile`) plus
 * `mdm{domain,key}` and `enterpriseManaged{id,name}`. Nothing is built beside
 * it and nothing is inferred from the `config.toml` we author.
 *
 * ## Three things the row assumed that the shipped binary refutes
 *
 * Measured 2026-09-08 against `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`
 * with a scratch `CODEX_HOME`, one key written by us (`model`) and one project
 * layer:
 *
 * 1. **`origins` names only the keys some LAYER SET, not every effective key.**
 *    97 top-level keys came back in `config`; `origins` carried 2. So the row's
 *    stated control — *"a key we did NOT write comes back with a user / system /
 *    packagedDefaults origin"* — cannot run as written: a key nobody set has no
 *    origin at all, because its value is the runtime's own default rather than
 *    any file's. {@link CodexConfigProvenanceV1.effectiveKeyCount} is carried
 *    for exactly that reason — the surface says how many keys are in force and
 *    how few of them any file explains.
 * 2. **`layers` is the whole stack including layers that do not exist.**
 *    `/etc/codex/config.toml` came back as a `system` layer with `config: {}`,
 *    which is P6.168's `present-no-keys` state arriving from the other side —
 *    the state a user misreads as "my setting is being ignored".
 * 3. **A layer can be READ, carry keys, and still not apply.** The project layer
 *    came back with `config: { model: … }` AND a `disabledReason` naming the
 *    untrusted project, while `origins.model` pointed at the USER file. That is
 *    a FOURTH state the host families have no equivalent of, and it is the
 *    sharpest thing this view can tell a codex user, so it is carried verbatim
 *    rather than flattened into "present".
 *
 * `layers` arrives only when `includeLayers: true` is sent (`undefined`
 * otherwise), which is why the caller always sends it.
 */
export type CodexConfigLayerStateV1 = 'supplies' | 'present-no-keys' | 'not-applied'

export interface CodexConfigLayerEntryV1 {
  /** The `ConfigLayerSource` discriminator, unmapped — codex's own vocabulary. */
  readonly kind: string
  /**
   * What the user would look at: the absolute file for a file-backed layer, the
   * `.codex` folder for a project layer, `domain/key` for MDM, the admin-facing
   * name for an enterprise-delivered one. Absent for `sessionFlags`, which is
   * not a file at all.
   */
  readonly label?: string | undefined
  readonly state: CodexConfigLayerStateV1
  /** The top-level keys this layer sets, in the order the runtime reported them. */
  readonly keys: readonly string[]
  /**
   * The runtime's own sentence for a layer it read and did not apply — carried
   * verbatim because it names the remedy (trusting the project) and we would be
   * guessing at it.
   */
  readonly disabledReason?: string | undefined
}

export interface CodexConfigOriginV1 {
  readonly key: string
  readonly kind: string
  readonly label?: string | undefined
}

export interface CodexConfigProvenanceV1 {
  /** In the order the runtime returned them — nearest layer first. */
  readonly layers: readonly CodexConfigLayerEntryV1[]
  /** The effective winner for every key ANY layer set, sorted by key. */
  readonly origins: readonly CodexConfigOriginV1[]
  /**
   * How many keys are in force in total. The gap between this and
   * `origins.length` is the runtime's own defaults, and naming it is what stops
   * the list reading as "these are all my settings".
   */
  readonly effectiveKeyCount: number
}

/**
 * Turn one `config/read` result into the shape above — pure, so the wire shape
 * is tested against the bytes the shipped binary actually returned rather than
 * against a live child.
 *
 * Tolerant of every field: this parses a SEPARATELY VERSIONED binary's answer,
 * and a generated binding is a snapshot. A malformed layer is dropped rather
 * than throwing, for `probeCodexConfigRequirements`'s reason — a provenance
 * view that cannot render must not take the settings page down.
 */
export function describeCodexConfigProvenance(result: unknown): CodexConfigProvenanceV1 | undefined {
  if (result === null || typeof result !== 'object') return undefined
  const raw = result as { config?: unknown; origins?: unknown; layers?: unknown }
  const config = raw.config !== null && typeof raw.config === 'object' && !Array.isArray(raw.config)
    ? raw.config as Record<string, unknown>
    : undefined
  if (!config) return undefined

  const layers: CodexConfigLayerEntryV1[] = []
  if (Array.isArray(raw.layers)) {
    for (const entry of raw.layers) {
      if (entry === null || typeof entry !== 'object') continue
      const layer = entry as { name?: unknown; config?: unknown; disabledReason?: unknown }
      const described = describeCodexLayerSource(layer.name)
      if (!described) continue
      const keys = layer.config !== null && typeof layer.config === 'object' && !Array.isArray(layer.config)
        ? Object.keys(layer.config as Record<string, unknown>)
        : []
      const disabledReason = typeof layer.disabledReason === 'string' && layer.disabledReason.length > 0
        ? layer.disabledReason
        : undefined
      layers.push({
        ...described,
        // The order matters: a layer that was READ and NOT APPLIED is reported
        // as such even though it carries keys, because "supplies" would be
        // false — it is the one state the user has to act on.
        state: disabledReason !== undefined ? 'not-applied' : keys.length > 0 ? 'supplies' : 'present-no-keys',
        keys,
        ...(disabledReason === undefined ? {} : { disabledReason }),
      })
    }
  }

  const origins: CodexConfigOriginV1[] = []
  if (raw.origins !== null && typeof raw.origins === 'object' && !Array.isArray(raw.origins)) {
    for (const [key, value] of Object.entries(raw.origins as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object') continue
      const described = describeCodexLayerSource((value as { name?: unknown }).name)
      if (!described) continue
      origins.push({ key, ...described })
    }
    origins.sort((a, b) => a.key.localeCompare(b.key))
  }

  return { layers, origins, effectiveKeyCount: Object.keys(config).length }
}

/** One `ConfigLayerSource`, reduced to the discriminator and the thing to open. */
function describeCodexLayerSource(name: unknown): { kind: string; label?: string } | undefined {
  if (name === null || typeof name !== 'object') return undefined
  const source = name as Record<string, unknown>
  const kind = typeof source.type === 'string' ? source.type : undefined
  if (!kind) return undefined
  const text = (field: string): string | undefined =>
    typeof source[field] === 'string' && (source[field] as string).length > 0
      ? source[field] as string
      : undefined
  // Every file-backed variant spells its path `file`; `project` spells it
  // `dotCodexFolder`; MDM has no file at all and is identified by domain+key;
  // `enterpriseManaged` publishes an admin-facing `name`. `sessionFlags` has
  // nothing to open, and an absent label is how the surface says so.
  const label = text('file')
    ?? text('dotCodexFolder')
    ?? (text('domain') !== undefined ? `${text('domain')}/${text('key') ?? ''}` : undefined)
    ?? text('name')
  return label === undefined ? { kind } : { kind, label }
}

/**
 * The top-level keys that make a document SUPPLY each family.
 *
 * Read from each family's own reader rather than composed here: `permissions`
 * is what `fileRecord('permission', …)` treats `.claude/settings.json` as a rule
 * source for; the two exclude spellings are `INSTRUCTION_EXCLUDE_SETTING_KEYS`
 * verbatim ("Both are read and, per the docs, the arrays MERGE"); `skills` is
 * what `parseSkillOverrides` reads.
 */
export const SETTINGS_PROVENANCE_FAMILY_KEYS: Readonly<
  Record<SettingsProvenanceFamilyIdV1, readonly string[]>
> = Object.freeze({
  permissions: Object.freeze(['permissions']),
  instructionExcludes: Object.freeze(['instructionExcludes', 'claudeMdExcludes']),
  skillOverrides: Object.freeze(['skills']),
  // Managed settings are not attributed by key: the family is winner-takes-all
  // at the SOURCE level, which the report above already answers in full.
  managedSettings: Object.freeze([]),
})

export const SETTINGS_PROVENANCE_COMBINE: Readonly<
  Record<SettingsProvenanceFamilyIdV1, SettingsProvenanceCombineV1>
> = Object.freeze({
  // `settings.md`'s scope table orders Local above Project; `native-sources.ts`
  // pushes them in that order and later layers win ties at equal action weight.
  permissions: 'last-wins',
  // `instruction-excludes.ts`: "for a restrict-direction key the more
  // restrictive value wins … There is deliberately NO way to subtract an
  // inherited exclusion."
  instructionExcludes: 'union',
  // `mergeSkillOverrideLayers(user, project, local)` — the later layer replaces.
  skillOverrides: 'last-wins',
  // `server-managed-settings.md#settings-precedence` — "Within the managed
  // tier, Claude Code by default uses the first source that delivers at least
  // one policy key, checking server-managed settings first and then
  // endpoint-managed settings, apart from the exception keys covered next."
  managedSettings: 'winner-takes-all',
})

/**
 * Classify one candidate file for one family — the whole rule, pure.
 *
 * `document` is `undefined` for a file that does not exist OR could not be
 * parsed, and those two collapse ON PURPOSE: an unreadable settings file
 * supplies nothing to any of these readers, every one of which fails open leg by
 * leg, so reporting it as present-and-contributing would be the opposite of
 * what the host does with it.
 */
export function classifySettingsProvenanceEntry(
  scope: SettingsProvenanceScopeV1,
  file: string,
  familyId: SettingsProvenanceFamilyIdV1,
  document: Record<string, unknown> | undefined,
): SettingsProvenanceEntryV1 {
  if (document === undefined) return { scope, file, state: 'missing' }
  const keys = SETTINGS_PROVENANCE_FAMILY_KEYS[familyId]
  const supplies = keys.some(key => document[key] !== undefined)
  return { scope, file, state: supplies ? 'supplies' : 'present-no-keys' }
}

/** The host search backend as the resolver left it. */
export interface SearchBackendDoctorInputV1 {
  /** The resolved ripgrep binary; `undefined` when the resolver found none. */
  readonly ripgrepPath?: string | undefined
  /**
   * Whether this host is a packaged build.
   *
   * Load-bearing rather than cosmetic: `resolveRipgrepPath` refuses `PATH`
   * entirely when packaged (`runtime-resolver.ts`, verbatim *"Packaged apps
   * must use vendored binary only — never resolve from PATH to avoid picking
   * up an incompatible system install"*), so on a packaged host "not resolved"
   * and "system" mean different things from what they mean headless, and the
   * report would be misread without it.
   */
  readonly isPackaged: boolean
}

/** One agent definition file the strict validator refused, and why. */
export interface AgentDefinitionFindingV1 {
  /** The definition file, as the user would open it. */
  readonly file: string
  readonly agentName: string
  /** The strict validator's message — the same reason the runtime skip logs. */
  readonly reason: string
}

/**
 * The line count above which `memory.md` says a project instruction file starts
 * costing more than it earns.
 *
 * `memory.md#my-claude-md-is-too-large`, verbatim: "Files over 200 lines consume
 * more context and may reduce adherence."
 *
 * Its own constant on purpose. Two other 200-ish limits exist in this tree and
 * neither is this one: `MEMORY_LOAD_LINE_LIMIT` caps the AUTO-MEMORY index
 * (`MEMORY.md`, a different file and a different sentence, numerically equal
 * today), and `INSTRUCTION_FILE_MAX_BYTES` is the 4 MiB hard SKIP. Sharing a
 * constant between guidance and a skip would make one edit move both.
 */
export const INSTRUCTION_FILE_TRIM_LINE_LIMIT = 200

/** One markdown section of an instruction file, and what it costs. */
export interface InstructionFileSectionV1 {
  /** The heading line as written, hashes included; the preamble has a stand-in. */
  readonly heading: string
  /** Lines from this heading up to the next one, the heading itself included. */
  readonly lineCount: number
}

/** One checked-in project instruction file, measured. */
export interface InstructionFileFindingV1 {
  /** The file, as the user would open it. */
  readonly path: string
  readonly lineCount: number
  /**
   * Every section, in file order. Present whatever the size: the renderer, not
   * the collector, decides that a file under the limit gets no proposal — so
   * the threshold is applied in exactly one place.
   */
  readonly sections: readonly InstructionFileSectionV1[]
}

/**
 * One value `config.json` carries that the schema refused — P6.878.
 *
 * `key` and `message` are `ValidationIssue`'s own `path` and `message`, carried
 * with no rewording on purpose: the `config_validate` session tool renders the
 * same pair as `  - <path>: <message>` and P6.874's record says the two voices
 * should become ONE. Keeping the pair and its shape identical is what makes
 * that a deletion later rather than a re-derivation.
 *
 * `severity` distinguishes the validator's own two lists. Flattened to one
 * array because the report renders them in one section and the marker is per
 * line — a second array would be a second loop for the same output.
 */
export interface StoredConfigValidationIssueV1 {
  /** The JSON path the validator refused, or the file name when it has none. */
  readonly key: string
  /** The validator's message, verbatim. */
  readonly message: string
  readonly severity: 'error' | 'warning'
}

/**
 * The user rung's own file, as `validateConfig()` reads it — P6.878.
 *
 * `file` is carried rather than assumed by the renderer because the location is
 * genuinely ambiguous: `NESSY_CONFIG_DIR` moves it, and a report that named a
 * path the process did not read would be worse than one that named none.
 *
 * An EMPTY `issues` array is a real answer — "the validator ran and refused
 * nothing" — and the section prints it, for the same reason the safety-judge
 * section prints on a machine with no `autoMode` block: silence and "there is
 * nothing to report" are indistinguishable to the reader, and that is the exact
 * failure this section exists to remove.
 */
export interface StoredConfigValidationDoctorInputV1 {
  /** Absolute path of the file that was validated. */
  readonly file: string
  /** Every refused value, errors first. Empty means the file validated clean. */
  readonly issues: readonly StoredConfigValidationIssueV1[]
}

/**
 * One setting a user can only reach by editing a file — P6.824.
 *
 * `value` is ALREADY RENDERED by the collector, because the six have four
 * different shapes (a three-state boolean, a defaulted boolean, free text and
 * two string arrays) and a report line needs one. The renderer clamps it; it
 * does not interpret it.
 *
 * `source` is the honest half. `user` means the file carries a value, `default`
 * means nothing is stored and the documented default is what runs. There is
 * deliberately no `managed` and no `env` member: measured at HEAD, none of the
 * six has a managed layer or an environment override — `CLAUDE_CODE_DISABLE_
 * EXPLORE_PLAN_AGENTS` is a projection OUT of the setting, not a layer into it —
 * and a member the collector could never produce would invite a reader to
 * believe a precedence chain exists here. If one is ever added, that is the
 * commit that adds the member.
 *
 * `settableIn` is the path a user would edit, or `undefined` for the case this
 * row measured and did not expect: a key that no file can carry durably.
 */
export interface ConfigOnlySettingV1 {
  /** The key as its reader spells it. */
  readonly key: string
  /** The value in force, rendered. */
  readonly value: string
  readonly source: 'user' | 'default'
  /**
   * Absolute path of the file that carries it, or absent when NO file does —
   * `syncConfigDefaults` overwrites the user copy of `config-defaults.json` from
   * the bundled asset on every launch, so a value hand-written there does not
   * survive a restart. The renderer says so rather than naming a path that lies.
   */
  readonly settableIn?: string | undefined
  /**
   * F1.661 — why part of the value will not bind as written, one sentence each (today only `sessionAllowedTools`
   * entries claude ignores). Absent when there is nothing to say. Printed as `!` lines; not a finding.
   */
  readonly warnings?: readonly string[] | undefined
}

/**
 * The whole family in one section — P6.824.
 *
 * A list rather than six fields: the answer the reader wants is "what is in
 * force and where do I change it", and six sections would ask them to assemble
 * it. An EMPTY list is not a state this collector can produce; `undefined` is
 * *"I could not look"*, as everywhere in this module.
 */
export interface ConfigOnlySettingsDoctorInputV1 {
  readonly settings: readonly ConfigOnlySettingV1[]
}

/**
 * The retention decision, flattened to what a report line needs.
 *
 * Deliberately not `RetentionDecision` itself: this module must stay free of
 * `config/storage.ts`, which reads the filesystem at import time. The caller that
 * owns the process resolves the decision and passes the answer in, exactly like
 * every other input here.
 */
export interface RetentionDoctorInputV1 {
  /** Whether the sweep would delete anything at all. */
  readonly sweeps: boolean
  /** `active`, `disabled` (the user's off switch) or `paused` (a fail-safe stop). */
  readonly state: 'active' | 'disabled' | 'paused'
  /** The window in days; present only when the sweep would run. */
  readonly retentionDays?: number | undefined
  /** Which tier supplied the window. */
  readonly source?: 'managed' | 'user' | 'default' | undefined
  /** The sentence explaining a pause or an unexpected disable. */
  readonly warning?: string | undefined
}

export interface SandboxNetworkDoctorInputV1 {
  /** What every sandboxed command on this host runs under. */
  readonly enforcement: SandboxNetworkEnforcementV1
  /** The composed lists, so the report can show what was configured. */
  readonly settings: ResolvedSandboxNetworkSettings
  /**
   * Whether the ENFORCED managed policy is what named `sandbox.network`.
   *
   * `settings-reference.md#sandbox-network-allowmanageddomainsonly` gives
   * `allowManagedDomainsOnly` a "**Scope**: `Managed`" bullet; we compose it
   * from any layer because it only ever restricts. Saying which
   * tier it came from is what stops an administrator debugging a lock they did
   * not deploy.
   */
  readonly fromManagedSettings: boolean
}

export interface ConfigDoctorReportV1 {
  /** The rendered report, ready for a terminal. */
  readonly text: string
  /**
   * True when the report contains something an administrator has to act on: a
   * refused managed entry, a rejected settings layer, or a shadowed file policy.
   * A clean configuration is not a finding.
   */
  readonly hasFindings: boolean
}

/**
 * `managed-settings.md#read-the-source-in-/status`'s channel names, in our two
 * channels' terms.
 *
 * `(remote)` there is "server-managed settings from claude.ai or a gateway",
 * which is our delivered payload; `(file)` is one of "`managed-settings.json`,
 * the drop-in directory, or both", which is the host-owned policy file and its
 * drop-in fragments.
 */
const WINNER_LABEL: Readonly<Record<ManagedPolicyWinnerV1, string>> = Object.freeze({
  delivered: 'Managed settings (remote)',
  file: 'Managed settings (file)',
  none: 'No managed settings source is in effect',
})

function section(heading: string, lines: readonly string[]): string {
  return [heading, ...lines].join('\n')
}

/**
 * The one-line warning for a policy file that is deployed and enforces nothing.
 *
 * Exported so the startup path and the full report render the same sentence
 * from the same predicate. Returns `undefined` whenever there is nothing to
 * warn about, which is every configuration except the single ambiguous one.
 *
 * `server-managed-settings.md#settings-precedence` makes winner-takes-all
 * correct — "Claude Code by default uses the first source that delivers at
 * least one policy key" — so this is not a defect to fix in the composition. It
 * is a state an administrator has no other way to observe, and the
 * cleared-console paragraph of that same section is what sends them to a
 * diagnosis surface to find out.
 */
export function shadowedManagedFileWarning(
  winner: ManagedPolicyWinnerV1,
  fileCarriesSettings: boolean,
  filePath?: string | undefined,
): string | undefined {
  if (winner !== 'delivered' || !fileCarriesSettings) return undefined
  const where = filePath ? ` at ${sanitizeSettingsDiagnostic(filePath, 200)}` : ''
  return `The managed policy file${where} carries settings and none of them apply:`
    + ' a delivered payload is in effect and managed sources do not merge'
    + ' (server-managed-settings.md#settings-precedence). Cached settings'
    + ' persist until the next successful fetch.'
}

/**
 * Render the enforced model allowlist.
 *
 * Entries are sanitized like every other value here: an allowlist entry is an
 * arbitrary document string on a path that ends at a terminal.
 *
 * The Default line is stated in both directions rather than only when enforced,
 * because "my Default still works" and "my Default moved" are the two support
 * questions this policy generates, and `settings-reference.md#availablemodels`
 * with `settings-reference.md#enforceavailablemodels` are the pair that
 * separates them.
 */
function modelAllowlistLines(
  availableModels: readonly string[] | undefined,
  enforceAvailableModels: boolean | undefined,
): readonly string[] {
  if (availableModels === undefined) {
    return ['  no managed allowlist — every model in a connection is selectable']
  }
  if (availableModels.length === 0) {
    return [
      '  empty allowlist — no named model is selectable; only each connection\'s',
      '  Default remains usable (managed-settings.md#keys-that-fail-closed,'
      + ' model-config.md:207).',
      '  An invalid availableModels value is enforced this way, so check the',
      '  invalid-entry list above before assuming this was deployed on purpose.',
    ]
  }
  return [
    `  ${availableModels.length} entr${availableModels.length === 1 ? 'y' : 'ies'} enforced:`,
    ...availableModels.map(entry => `  - ${sanitizeSettingsDiagnostic(entry, 256)}`),
    enforceAvailableModels === true
      ? '  Default model: constrained to this list (enforceAvailableModels).'
      : '  Default model: unconstrained (settings-reference.md#availablemodels —'
        + ' set enforceAvailableModels to cover it).',
  ]
}

/**
 * Render the effective sandbox network policy.
 *
 * Three questions, in the order they get asked: can a sandboxed command reach
 * the network at all, which setting decided that, and which of the rules I wrote
 * are actually in force. The third is the one this section exists for — the
 * lists compose perfectly and the shell obeys only the egress bit, so an
 * administrator reading back `allowedDomains` from a settings file learns
 * nothing about whether those hosts are reachable.
 *
 * Entries are sanitized like every other value here: a domain entry is an
 * arbitrary document string on a path that ends at a terminal.
 */
function sandboxNetworkLines(input: SandboxNetworkDoctorInputV1): readonly string[] {
  const { enforcement, settings } = input
  const list = (entries: readonly string[]): string =>
    entries.length === 0 ? 'none' : entries.map(entry => sanitizeSettingsDiagnostic(entry, 256)).join(', ')
  const tier = input.fromManagedSettings ? 'managed settings' : 'user settings'
  const lines = [
    enforcement.egress === 'denied'
      ? '  sandboxed-command egress: DENIED — no sandboxed command can open an outbound connection'
      : '  sandboxed-command egress: open — the profile\'s own network dimension applies',
    enforcement.source === 'allowManagedDomainsOnly'
      ? `  source: sandbox.network.allowManagedDomainsOnly, from ${tier}`
      : '  source: no sandbox.network policy is in effect',
    `  allowedDomains: ${list(settings.allowedDomains)}`,
    `  deniedDomains:  ${list(settings.deniedDomains)}`,
  ]
  if (enforcement.unenforceable.length === 0) return lines
  return [
    ...lines,
    '',
    `  ! ${enforcement.unenforceable.length} configured domain rule`
    + `${enforcement.unenforceable.length === 1 ? '' : 's'} do not bind a sandboxed command:`,
    ...enforcement.unenforceable.map(line => `  - ${sanitizeSettingsDiagnostic(line, 512)}`),
  ]
}

/**
 * Render what the retention sweep would do.
 *
 * A paused sweep is stated first and marked, because it is the one state in this
 * section where the user's data is accumulating while they believe it is being
 * cleaned up. A user-chosen `disabled` is reported plainly — it is a setting, not
 * a fault — and only carries the `!` marker when it came with a warning, which
 * is how the migrated `retentionDays: 0` reads.
 */
function retentionLines(input: RetentionDoctorInputV1): readonly string[] {
  const lines: string[] = []
  if (input.state === 'paused') {
    lines.push('  PAUSED — nothing is being cleaned up')
  } else if (!input.sweeps) {
    lines.push('  off — nothing is deleted automatically')
  } else {
    lines.push(
      `  active — data older than ${input.retentionDays} day${input.retentionDays === 1 ? '' : 's'}`
      + ` is deleted at startup (from ${input.source ?? 'unknown'} settings)`,
    )
  }
  if (input.warning) lines.push(`  ! ${sanitizeSettingsDiagnostic(input.warning, 512)}`)
  return lines
}

/**
 * Render what each plugin mandate is doing.
 *
 * The unfulfilled ones come first and carry the `!` marker, because they are the
 * rows that need an action; the fulfilled ones are counted rather than listed,
 * since a working mandate is a working policy and listing it buries the one that
 * is not.
 *
 * Keys are sanitized like every other value here: a `PluginKey` comes from a
 * marketplace id and a plugin id, both author-supplied.
 */
function mandatedPluginLines(findings: readonly MandatedPluginFindingV1[]): readonly string[] {
  if (findings.length === 0) return ['  no plugin is force-enabled by managed settings']
  const unfulfilled = findings.filter(finding => finding.state === 'not-installed')
  const installed = findings.length - unfulfilled.length
  if (unfulfilled.length === 0) {
    return [`  ${installed} force-enabled plugin${installed === 1 ? ' is' : 's are'} installed`]
  }
  return [
    `  ! ${unfulfilled.length} force-enabled plugin${unfulfilled.length === 1 ? '' : 's'}`
    + ` ${unfulfilled.length === 1 ? 'is' : 'are'} not installed, so the mandate does nothing:`,
    ...unfulfilled.map(finding => `  - ${sanitizeSettingsDiagnostic(finding.pluginKey, 256)}`),
    (unfulfilled[0]?.marketplacesRegistered ?? 0) === 0
      ? '  No marketplace is registered on this machine. Deliver one through the'
      + ' managed extraKnownMarketplaces key'
      + ' (settings-reference.md#extraknownmarketplaces) so the mandated'
      + ' plugin can resolve without a manual add on every workstation.'
      : '  A marketplace is registered but the plugin is not installed from it.',
    ...(installed > 0 ? [`  ${installed} other force-enabled plugin${installed === 1 ? ' is' : 's are'} installed.`] : []),
  ]
}

/**
 * Render what the agent-definition checkup found.
 *
 * The skip already happened (or will, on the next send) — the runtime loads
 * the valid definitions and excludes these — so the section's job is naming
 * the file and the field, which the runtime's own channel only whispers into
 * the session log. A malformed definition is a finding: the user wrote an
 * agent that silently does not exist until the file is fixed.
 */
/**
 * Split an instruction file into its markdown sections and cost each one.
 *
 * A section runs from its ATX heading to the NEXT heading of any level, so the
 * numbers add up to the file and no line is counted twice. Content before the
 * first heading is its own entry, because in a file that has grown past the
 * limit the unstructured preamble is often the largest single block and a
 * listing that omitted it would send the reader looking in the wrong place.
 *
 * Fenced code blocks are tracked, so a shell comment or a `#!` line inside a
 * fence is not read as a heading — a real cost, since the blocks this check
 * exists to find (directory layouts, dependency lists) are usually fenced.
 *
 * Deliberately NOT a judgement about which sections to cut. That judgement is
 * "content Claude can derive from the codebase", which cannot be computed from
 * the file alone; guessing it from heading names would be an invented rule
 * printed in the voice of a documented one.
 */
export function instructionFileSections(content: string): readonly InstructionFileSectionV1[] {
  const sections: InstructionFileSectionV1[] = []
  let heading = '(before the first heading)'
  let lineCount = 0
  let inFence = false
  const push = () => {
    if (lineCount > 0) sections.push(Object.freeze({ heading, lineCount }))
  }
  for (const line of content.split(/\r?\n/)) {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) inFence = !inFence
    const match = inFence ? null : /^(#{1,6})\s+(.*\S)\s*$/.exec(line)
    if (match) {
      push()
      heading = `${match[1]!} ${match[2]!}`
      lineCount = 1
      continue
    }
    lineCount += 1
  }
  push()
  return Object.freeze(sections)
}

/**
 * Render the checked-in instruction files and, for one that has grown past the
 * documented limit, the trim PROPOSAL.
 *
 * `memory.md#my-claude-md-is-too-large` — "Files over 200 lines consume more
 * context and may reduce adherence." and, on the same page, what a trim should
 * take and leave: "it cuts content Claude can derive from the codebase, such as
 * directory layouts, dependency lists, and architecture overviews, and keeps
 * pitfalls, rationale, and conventions that differ from tool defaults."
 *
 * ## Why the proposal is a listing and not a set of edits
 *
 * Owner decision D12: the configuration checkup stays **read-only, and says
 * so** — "a checkup that edits the user's files is a different product". So
 * this names the sections and what each costs, quotes the rule for deciding,
 * and stops. The reader does the cutting. `apps/cli/src/doctor.ts`'s own
 * docblock states the same posture for the module as a whole, which is why the
 * row this implements could be satisfied without weakening it.
 *
 * ## Why 200 is not `MEMORY_LOAD_LINE_LIMIT`
 *
 * That constant is the AUTO-MEMORY index cap on `MEMORY.md` — a numerically
 * equal limit on a different file from a different sentence. Wiring this to it
 * would make one edit silently move two unrelated rules. The 4 MiB skip
 * (`INSTRUCTION_FILE_MAX_BYTES`) is a third, and it is a hard skip rather than
 * guidance.
 */
function instructionFileLines(files: readonly InstructionFileFindingV1[]): readonly string[] {
  if (files.length === 0) {
    return ['  no checked-in project instruction file in the working directory']
  }
  const lines: string[] = []
  for (const file of files) {
    const over = file.lineCount > INSTRUCTION_FILE_TRIM_LINE_LIMIT
    lines.push(`  ${over ? '! ' : ''}${sanitizeSettingsDiagnostic(file.path, 256)}`
      + ` — ${file.lineCount} line${file.lineCount === 1 ? '' : 's'}`
      + (over
        ? `, ${file.lineCount - INSTRUCTION_FILE_TRIM_LINE_LIMIT} over the`
          + ` ${INSTRUCTION_FILE_TRIM_LINE_LIMIT}-line guidance`
        : ''))
    // The control the row asks for: a file under the limit proposes NOTHING.
    // Its line count still prints, because "under the limit" is only meaningful
    // beside the number it is under.
    if (!over) continue
    lines.push('    Files over 200 lines consume more context and may reduce'
      + ' adherence (memory.md). Cut content that can be derived from the'
      + ' codebase — directory layouts, dependency lists, architecture'
      + ' overviews — and keep pitfalls, rationale, and conventions that differ'
      + ' from tool defaults. This checkup changes nothing.')
    lines.push('    Sections, largest first:')
    // Largest first, because the reader is looking for lines to remove and the
    // order the file happens to be written in does not help with that.
    const ranked = [...file.sections].sort((left, right) => right.lineCount - left.lineCount)
    for (const entry of ranked) {
      lines.push(`    - ${entry.lineCount} line${entry.lineCount === 1 ? '' : 's'}`
        + `: ${sanitizeSettingsDiagnostic(entry.heading, 160)}`)
    }
  }
  return lines
}

function agentDefinitionLines(findings: readonly AgentDefinitionFindingV1[]): readonly string[] {
  if (findings.length === 0) return ['  every agent definition parses cleanly']
  return [
    `  ! ${findings.length} agent definition${findings.length === 1 ? ' is' : 's are'} malformed`
    + ' and will be skipped at send time:',
    ...findings.map(finding =>
      `  - ${sanitizeSettingsDiagnostic(finding.file, 256)} — ${sanitizeSettingsDiagnostic(finding.reason, 512)}`),
  ]
}

/**
 * Render the managed entries that are enforced differently from how they read.
 *
 * The line itself comes from {@link formatManagedPolicyCaveat}, the SAME
 * renderer the load-time stderr summary uses, so the two surfaces cannot
 * describe one entry two ways — the property `formatManagedPolicyDrop` already
 * gives the section above it.
 *
 * The remedy is the page's own, and it is repeated here rather than left to the
 * reader because a diagnostic an administrator cannot act on is only half a
 * diagnostic: `managed-mcp.md#how-policy-entries-expand` — "Because a policy
 * entry still depends on the launching shell's value for any variable it
 * references, use literal URLs and commands for entries you rely on for
 * enforcement."
 *
 * ## Why this section does NOT also exist in the renderer's MCP list
 *
 * Recorded here rather than left as an open question, because "add a badge"
 * looks obviously right and is wrong three ways.
 *
 * 1. **Structurally, there is no row to attach it to.** Both dispositions
 *    manifest as a server that ISN'T listed: an allow entry that admits nothing
 *    still displaces the `serverName` fallback, so servers the allowlist reads
 *    as granting are absent; a widened deny blocks servers the text does not
 *    name, which are absent for that reason. A per-row field cannot render the
 *    absence of a row.
 * 2. **The audience is the administrator, not the user.**
 *    `managed-mcp.md#how-restrictions-appear-to-users` is explicit about who
 *    reports what: for a server policy removed, "The server silently disappears
 *    from `/mcp` and `claude mcp list` with no warning", and the remedy the page
 *    prescribes is out-of-band and human — "the user gets no signal that policy
 *    is the reason their server disappeared, so tell affected users which
 *    servers are blocked when you roll out a new restriction." The desktop MCP
 *    list is our `/mcp`; a user cannot edit managed settings, so a caveat there
 *    is a fault they can see and not fix.
 * 3. **The content is the administrator's policy text**, verbatim and
 *    pre-expansion — internal hostnames, tool paths, the shape of a fleet's
 *    infrastructure. `doctor` is run by whoever owns the machine's policy; the
 *    MCP list is shown to whoever opens the app.
 *
 * If a user-facing signal is ever wanted, it is a LIST-level notice about the
 * policy, not a ROW-level badge about a server — a different surface with a
 * different sentence, and not this data threaded one layer further.
 */
function caveatLines(caveats: readonly ManagedPolicyCaveatV1[]): readonly string[] {
  if (caveats.length === 0) return ['  none']
  return [
    ...caveats.map(caveat => `  ! ${formatManagedPolicyCaveat(caveat)}`),
    '  Use literal URLs and commands for entries you rely on for enforcement',
    '  (managed-mcp.md#how-policy-entries-expand).',
  ]
}

/**
 * Build the report.
 *
 * The order is the order an administrator debugs in: which source is being read
 * first, then what that source lost, then what the strict tiers lost. Naming the
 * source first is what stops the second section being read against the wrong
 * file.
 */
/**
 * The vendored ripgrep's own path segment.
 *
 * Bundled-vs-system is derived from the PATH rather than reported by the
 * resolver, and that is a deliberate, stated choice: `resolveRipgrepPath`
 * returns a bare string through `ResolvedBackendHostTooling`, and widening that
 * return type would touch a file three other callers share for one diagnostic
 * line. The derivation is exact for every branch that resolver has — its three
 * vendored branches all end in this segment and its `which rg` fallback cannot,
 * Backslashes are normalised rather than importing `node:path`, so the match
 * holds on Windows without pulling a node builtin into a module the renderer
 * can reach.
 * unless the system binary IS a copy of this package, in which case "bundled"
 * is the truthful answer anyway.
 */
const VENDORED_RIPGREP_SEGMENT = 'node_modules/@vscode/ripgrep'

function searchBackendLines(input: SearchBackendDoctorInputV1): readonly string[] {
  if (!input.ripgrepPath) {
    // A `!` line that does NOT move `hasFindings`, on the rule the sandbox
    // filesystem section already follows. The exit code gates a policy push
    // (`server-managed-settings.md#invalid-entries-in-delivered-settings`); a
    // machine with no ripgrep has a local tooling fault,
    // not a policy an administrator deployed wrongly, and failing a fleet
    // policy check on it would report the wrong problem to the wrong person.
    return [
      '  ! not resolved — session search is unavailable on this host',
      input.isPackaged
        ? '    packaged build: the vendored binary is missing and PATH is deliberately not consulted'
        : '    headless/dev: neither the vendored binary nor a system rg on PATH was found',
    ]
  }
  const path = sanitizeSettingsDiagnostic(input.ripgrepPath, 200)
  return input.ripgrepPath.replace(/\\/g, '/').includes(VENDORED_RIPGREP_SEGMENT)
    ? [`  OK (bundled) — ${path}`]
    : [`  system — ${path}`]
}

/**
 * Strip credentials from a proxy URL, keeping scheme, host and port.
 *
 * A value that does not parse is reported as unparseable rather than printed —
 * an unparseable proxy string is exactly the case where the credential-stripping
 * did not happen.
 *
 * **EXPORTED, and named for the rule rather than for this file (P6.780).** The
 * same six lines were written a second time as `redactProxyUrl` inside
 * `agent/diagnostics.ts`, whose own docblock recorded the duplication and left
 * it for a row; both surfaces print a proxy URL a user pastes into a ticket, so
 * one drifting from the other is a credential leak with a passing test beside
 * it. `diagnostics.ts` imports this now and the direction is deliberate: a
 * report renderer is cheap for the agent layer to import, and `diagnostics.ts`
 * reaches the credential manager, which the terminal checkup must not.
 *
 * A THIRD copy stays where it is, in `unified-network-interceptor.ts`, for the
 * reason that module's header gives — it is preloaded into the Pi subprocess and
 * bundled standalone, and P6.789 MEASURED that cost: importing this module there
 * takes that bundle from 8 modules / 76 154 bytes to 116 / 665 967, zod v4 and
 * forty locale files among them. Its fallback is IDENTICAL since P6.789. The
 * clause that used to sit here — that changing it is "changing a debug-log
 * string" — was wrong: the interceptor's second call site puts that string in
 * the HTML-error-page message a USER reads.
 */
export function redactProxyUrl(value: string): string {
  try {
    const parsed = new URL(value)
    parsed.username = ''
    parsed.password = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return '(unparseable proxy URL)'
  }
}

/**
 * DA1.34 — the shared Nessy Gateway credential, as the doctor can honestly read
 * it, and the CODE a re-mint would report for that state.
 *
 * A3.12's extra clause is "every re-mint failure has a distinct, user-facing
 * reason, and the doctor can print it". DA1.4 built the CARD half: a forced
 * re-mint that fails records a `DpAuthError` and the full-screen card shows it.
 * The doctor half could not simply read that code, and the reason is worth
 * writing down rather than working around: `gatewayReMintFailureCode` is per
 * SESSION and lives in the server process, while `nessy-general-agent doctor`
 * is its own process with no session at all. So what this section reports is
 * the state a re-mint would MEET, derived from the one artefact both surfaces
 * share — the creds file — in the same vocabulary the card uses.
 *
 * CODES, LENGTHS AND BOOLEANS ONLY. The JWT's LENGTH is reported and its value
 * never is; that is deliberate and it is the one number here that can tell an
 * operator "the file holds something, and it is not the shape you think".
 */
export interface GatewayAuthDoctorInputV1 {
  /** Whether the shared creds file is there, and whether it could be parsed. */
  readonly credentialsFile: 'absent' | 'unreadable' | 'present'
  /** The JWT's length in characters. NEVER its value. */
  readonly jwtLength?: number
  /** Three non-empty dot-separated segments. */
  readonly jwtShaped?: boolean
  /** The payload decodes to claims (DA1.26's predicate), not merely three dots. */
  readonly jwtDecodes?: boolean
  /** Minutes until the STORED expiry; negative when it has passed. */
  readonly expiresInMinutes?: number
  /**
   * The code a re-mint would report for this state — the same vocabulary the
   * card shows, so an operator reading a support ticket and a user reading the
   * card are naming one thing.
   */
  readonly reMintReason:
    | 'ok'
    | 'no_credentials'
    | 'credentials_unreadable'
    | 'credentials_unparseable'
    | 'credentials_expired'
  /** Whether the env bypass is set here — a boolean, never the token. */
  readonly envTokenPresent: boolean
  /** nessy-cli's env name is set and ours is not: the dp flow answers, we do not. */
  readonly cliEnvTokenOnly: boolean
  /**
   * DA1.56 — WHICH `dp` this process would actually run, and which rung of the
   * four-rung ladder answered.
   *
   * `DpRuntimeRecord.source` is written on both return paths of
   * `auth/dp/dp-binary.ts` symbol `resolveDpRuntime` and its own comment calls
   * it "Diagnostic only; never a switch" — and until this field nothing outside
   * `__tests__` read it. The consequence was that DA1.6's deliberate,
   * documented decision to FALL THROUGH an unrunnable `NESSY_DP` was
   * unobservable: a typo in that variable and never having set it looked
   * identical from every surface the user or an operator can reach.
   *
   * The type is IMPORTED rather than restated, so a fifth rung appears here the
   * day it is added to the ladder. `not-found` is this field's own member and
   * not the ladder's: it is what `resolveDpRuntime` THROWING (`DpNotFound`)
   * means, rendered rather than swallowed, because "no dp at all" is the one
   * answer an operator most needs from this section.
   *
   * Optional, deliberately: a caller that did not look must be able to say so,
   * and the CLI's JSON surface emits this object whole.
   */
  readonly dpBinary?: {
    readonly source: DpRuntimeSource | 'not-found'
    /** The resolved absolute path. Absent when no rung was runnable. */
    readonly path?: string
  }
}

function gatewayAuthLines(input: GatewayAuthDoctorInputV1): readonly string[] {
  const lines: string[] = []
  lines.push(`  re-mint reason: ${input.reMintReason}`)
  lines.push(`  credentials file: ${input.credentialsFile}`)
  if (input.jwtLength !== undefined) {
    lines.push(`  token: ${input.jwtLength} characters,`
      + ` ${input.jwtShaped ? 'jwt-shaped' : 'NOT jwt-shaped'},`
      + ` ${input.jwtDecodes ? 'claims decode' : 'claims do NOT decode'}`)
  }
  if (input.expiresInMinutes !== undefined) {
    lines.push(input.expiresInMinutes < 0
      ? `  stored expiry: passed ${Math.abs(Math.round(input.expiresInMinutes))} minute(s) ago`
      : `  stored expiry: in ${Math.round(input.expiresInMinutes)} minute(s)`)
  }
  if (input.envTokenPresent) {
    lines.push('  env bypass: set here — the dp flow is skipped and this token is used')
  }
  if (input.cliEnvTokenOnly) {
    lines.push('  ! only nessy-cli\'s env token name is set; ours is not,'
      + ' so the dp flow answers and this process does not see a token')
  }
  if (input.dpBinary) {
    // DA1.56 · the rung that answered, so a fall-through is legible. The path
    // is sanitized like every other path this file prints; it is a filesystem
    // location, never a credential.
    lines.push(input.dpBinary.path === undefined
      ? '  dp binary: NOT FOUND — no rung of the ladder was runnable'
        + ' (NESSY_DP, system, managed copy, nessy-cli copy)'
      : `  dp binary: ${input.dpBinary.source} —`
        + ` ${sanitizeSettingsDiagnostic(input.dpBinary.path, 200)}`)
  }
  return lines
}

function networkTrustLines(input: NetworkTrustDoctorInputV1): readonly string[] {
  const lines: string[] = []

  if (input.proxyEnv.length === 0) {
    lines.push('  proxy: none set — requests go direct')
  } else {
    // WINNER FIRST, and the word is in the output, because the whole defect this
    // section closes is that two spellings of one setting resolved differently
    // on different runtimes and no surface said which one won.
    const [winner, ...rest] = input.proxyEnv
    lines.push(`  proxy: ${winner?.name} = ${redactProxyUrl(winner?.value ?? '')} (wins)`)
    for (const entry of rest) {
      lines.push(`    also set, not used: ${entry.name} = ${redactProxyUrl(entry.value)}`)
    }
  }
  if (input.noProxy) {
    lines.push(`  no-proxy: ${sanitizeSettingsDiagnostic(input.noProxy, 300)}`)
  }

  lines.push(input.caSource === 'none'
    ? '  extra CA: none — the system trust store alone'
    : `  extra CA: ${input.caSource}${input.caPath ? ` — ${sanitizeSettingsDiagnostic(input.caPath, 200)}` : ''}`)
  if (input.caWarning) {
    lines.push(`  ! ${sanitizeSettingsDiagnostic(input.caWarning, 300)}`)
  }

  if (input.clientCertificateError) {
    // Loud, per `network-mtls.ts`: "A missing or unreadable cert/key must never
    // silently downgrade to an unauthenticated connection."
    lines.push('  client certificate: configured and NOT resolved — connections present no identity')
    lines.push(`  ! ${sanitizeSettingsDiagnostic(input.clientCertificateError, 300)}`)
  } else {
    lines.push(input.clientCertificate
      ? '  client certificate: configured and resolved'
      : '  client certificate: none')
  }
  if (input.mtlsReloadDisabled) {
    lines.push('  ! CLAUDE_CODE_DISABLE_MTLS_RELOAD_ON_STALE_CONNECTION is set here:'
      + ' a rotated client certificate is not picked up on a stale claude connection')
  }

  return lines
}

/**
 * P6.493's settings surface — the safety judge's USER scope, and the one
 * sentence that makes its asymmetry legible.
 *
 * The defect this closes is silence in the direction that looks like absence: a
 * developer writes `autoMode.allow` in their own settings file, nothing
 * happens, and the two available conclusions — *"the file is not read"* and
 * *"the key was refused"* — are indistinguishable. So the section prints even
 * when the block is absent: the sentence is what tells a developer which keys
 * they MAY write, and it costs one line on a machine that has none.
 *
 * The refusal text is {@link describeRefusedUserAutoModeKeys}'s, not a second
 * copy: the session announces the same sentence from the same builder, so the
 * two surfaces cannot come to disagree about the same file.
 */
function userAutoModeLines(read: UserScopeAutoModeReadV1): readonly string[] {
  const applied = read.policy ? Object.keys(read.policy) : []
  const lines: string[] = [
    `  file:    ${sanitizeSettingsDiagnostic(read.path, 200)}`,
    applied.length > 0
      ? `  applied: ${applied.map(key => `autoMode.${key}`).join(', ')}`
      : '  applied: nothing',
    '  a user scope may only NARROW the safety judge: hard_deny and soft_deny'
    + ' travel from this file, allow and environment are managed-only.',
  ]
  const refused = describeRefusedUserAutoModeKeys(read)
  // `!`, not a finding. This module's own rule for the exit code is "something
  // an ADMINISTRATOR has to act on", and a refused key is a fault in a file the
  // developer wrote on this machine — the same desk that is reading this report.
  // Failing the pre-deployment fleet check of
  // `server-managed-settings.md#invalid-entries-in-delivered-settings` for it
  // would put the wrong signal on the wrong desk, exactly as the
  // instruction-file limit does.
  if (refused) lines.push('', `  ! ${sanitizeSettingsDiagnostic(refused, 400)}`)
  if (read.invalidReason) {
    lines.push('', `  ! autoMode was not applied: ${sanitizeSettingsDiagnostic(read.invalidReason, 200)}`)
  }
  return lines
}

/**
 * P6.878 — every `config.json` value the schema refused, in the one surface a
 * user already opens.
 *
 * The defect: the values are named by `validateConfig()` alone, and its two
 * routes to a person are a session tool nobody is prompted to run and a
 * `BaseAgent` callback with no writer. So a key that resolved to its default
 * because it was misspelled looked exactly like a key that was honoured.
 *
 * The lines are `formatValidationResult`'s own shape — `  - <key>: <message>` —
 * deliberately, so the two voices about one file can be merged by deleting one
 * of them rather than by reconciling two renderings (P6.874's record).
 *
 * The clean case prints too. A section that appeared only on a broken machine
 * would leave the ordinary reader unable to tell "validated clean" from "not
 * checked", which is the same silence the section is here to end.
 */
function storedConfigValidationLines(
  input: StoredConfigValidationDoctorInputV1,
): readonly string[] {
  const lines: string[] = [`  file:    ${sanitizeSettingsDiagnostic(input.file, 200)}`]
  if (input.issues.length === 0) {
    lines.push('  every value in this file was accepted by the schema.')
    return lines
  }
  lines.push('')
  for (const issue of input.issues) {
    lines.push(
      `  - ${sanitizeSettingsDiagnostic(issue.key, 120)}:`
      + ` ${sanitizeSettingsDiagnostic(issue.message, 400)}`
      + (issue.severity === 'warning' ? ' [warning]' : ''),
    )
  }
  lines.push(
    '',
    '  A value listed here never took effect: the load path is unknown-tolerant'
    + ' by design, so it resolved to the default silently. Every other key in'
    + ' the file still applies.',
  )
  return lines
}

/**
 * P6.824 — the settings with no in-app control, one line each.
 *
 * The heading and the closing sentence carry the fact a value cannot: these are
 * file-only ON PURPOSE (the controller's P6.810 recommendation, taken once for
 * the family).
 *
 * They used to carry a second fact, and it is gone because the defect is: two of
 * the six were file-only in a way that did not work — they lived in
 * `config-defaults.json`, which is rewritten from the bundled asset at every
 * launch — and this section was what made that visible. P6.912 moved them into
 * `config.json`, so every row now names a path. The no-file branch below is KEPT
 * with no producer, deliberately: `settableIn` is optional on the type, so a
 * future key that cannot name a file must render as something rather than as
 * `undefined`, and this is the honest something.
 *
 * Every row prints, including the untouched ones. A section that appeared only
 * where a value had been set would answer "is anything configured?" and not the
 * question that is actually asked, which is "what is in force?".
 */
function configOnlySettingsLines(
  input: ConfigOnlySettingsDoctorInputV1,
): readonly string[] {
  const lines: string[] = []
  for (const setting of input.settings) {
    lines.push(
      `  - ${sanitizeSettingsDiagnostic(setting.key, 80)}:`
      + ` ${sanitizeSettingsDiagnostic(setting.value, 200)}`
      + ` [${setting.source === 'user' ? 'user config' : 'default'}]`,
    )
    lines.push(setting.settableIn === undefined
      // No producer since P6.912 — see this function's own docblock for why the
      // branch stays and why it no longer names a file.
      ? '      set in: nowhere durably — no file carries this key across a launch'
      : `      set in: ${sanitizeSettingsDiagnostic(setting.settableIn, 200)}`)
    for (const warning of setting.warnings ?? []) lines.push(`      ! ${sanitizeSettingsDiagnostic(warning, 300)}`)
  }
  lines.push(
    '',
    '  These have no control in the app, deliberately: they are operator-shaped,'
    + ' so they surface here and in the settings reference rather than beside the'
    + ' model picker. None of them has a managed layer or an environment'
    + ' override — the value above is the whole answer.',
  )
  return lines
}

/**
 * P6.576 — the two settings-file tiers, in ONE line, for session start.
 *
 * The defect: `buildConfigDoctorReport` already names the winning managed
 * source, the shadowed sources and the dropped entries, and its ONLY production
 * consumer is `apps/cli/src/doctor.ts`. So the host holds the fact and a desktop
 * user never meets it — theme 2 of the denominator sweep. A managed policy that
 * enforces nothing, a settings layer that was rejected whole, a `config.json`
 * key that was dropped: all of it is discoverable exclusively by running a CLI
 * the app does not ship a route to.
 *
 * ## Why a LINE and not a second report
 *
 * The full report is the doctor's, and duplicating it at session start would put
 * a screen of text in front of every user on every session for a state almost
 * all of them do not have. This returns one sentence, built from the SAME input
 * the report is, so the two cannot disagree — and it returns `undefined` when
 * there is nothing to say, which is the default install. Silence is the correct
 * output for a machine with no managed source, no drops and no rejected layer.
 *
 * ## What counts as "something to say"
 *
 * Exactly `buildConfigDoctorReport`'s own `hasFindings` inputs for the settings
 * tiers, plus the presence of a managed source (which is not a finding — an
 * administrator's policy being IN EFFECT is a fact the user is entitled to,
 * and it is the fact that explains every other surprise in the session), plus
 * the instruction-file count W7-w attached: `/trim`'s proposal (P6.398) has no
 * session-facing surface either, and it is derived from the same input record.
 *
 * ## English, like every other string in this module
 *
 * Nothing in `config-doctor.ts` is localised — the report is one voice for the
 * CLI, the ticket it is pasted into and the fleet check that greps it. The
 * localisation the row asks for belongs to the surface that RENDERS this, not to
 * the function that derives it; the emitting call site owns that choice.
 */
/**
 * P6.684 — the line's CLAUSES, separately from its frame.
 *
 * The emitter in `SessionManager` (`937f159a5`) records the residue this
 * closes in its own words: it kept the English sentence because *"localising
 * the middle of the sentence would mean re-deriving its six optional clauses in
 * a second place, which is exactly how the notice and the report would come to
 * disagree about the same input"*. Returning them as DATA removes that choice —
 * one derivation, two renderings, and a renderer that cannot invent a clause the
 * report does not have.
 *
 * Each clause carries only what its sentence needs to be written in any
 * language: an id and its counts. No prose, because prose is what cannot be
 * translated, and no source paths, because this crosses to a renderer.
 */
export type SettingsTiersClauseV1 =
  /** A managed source is IN EFFECT — a fact the user is entitled to, not a finding. */
  | { readonly id: 'managed-source'; readonly winner: ManagedPolicyWinnerV1 }
  | { readonly id: 'invalid-managed-entries'; readonly count: number }
  | { readonly id: 'rejected-layers'; readonly count: number }
  /** A managed policy file is on disk, looks deployed, and enforces nothing. */
  | { readonly id: 'shadowed-managed-file' }
  | { readonly id: 'unfulfilled-mandates'; readonly count: number }
  | { readonly id: 'instruction-files-over-limit'; readonly count: number; readonly limit: number }
  /**
   * P6.733 — D13's accepted cost, said out loud. Identity export is ON, so the
   * session id and the account reach the operator's collector. Present only when
   * the caller resolved it, which is what keeps a default install silent.
   */
  | { readonly id: 'telemetry-identity-exported' }
  /**
   * C3.199 (QM3 = A, owner 2026-09-11) — WHICH event vocabulary this session
   * exports, when it exports at all.
   *
   * Three runtimes emit three vocabularies and nothing told an operator which
   * one a session produces, a silence created by closing the gap in one column:
   * `packages/shared/src/agent/telemetry-coverage.ts` records the three streams
   * and that **no name appears in two of them**, so a dashboard written against
   * one returns silence for the other two — and a silence that cannot explain
   * itself reads as "nothing happened".
   *
   * It rides THIS line rather than a notice of its own, on the
   * `telemetry-identity-exported` precedent directly above: the same moment, the
   * same audience, and a second channel for one sentence would be more code for
   * the same fact. Present only when the caller resolved it, which is what keeps
   * a machine with no exporter silent.
   */
  | { readonly id: 'telemetry-event-dialect'; readonly dialect: TelemetryEventDialectV1 }
  /**
   * D1.277 — the claude child's OWN telemetry verdict, said out loud only when
   * it DISAGREES with what this machine was configured to want.
   *
   * The binary publishes `analytics_disabled` on its `system`/`init` object
   * (D1.208 — in neither `sdk.d.ts` nor this repo until that row, AGENTS.md's
   * membership rule). The value itself is worth nothing on a line: the
   * reassuring direction is not actionable, and the alarming direction with no
   * operator request is the runtime's documented default, which this host
   * neither configured nor can undo. A DISAGREEMENT is worth everything, and
   * there are two of them:
   *
   *  - `still-enabled`: the operator set `DISABLE_TELEMETRY` or `DO_NOT_TRACK`
   *    in the environment this host spreads into the child, and the child
   *    answers that analytics is still on. `requested` names what THEY set,
   *    because that is the thing they can change.
   *  - `off-while-exporting`: this machine opted IN and has an exporter
   *    configured, and the claude child reports its own analytics off — so a
   *    dashboard written against the runtime's own stream returns silence for
   *    these sessions, which reads as "nothing happened".
   */
  | { readonly id: 'child-telemetry-disagreement'; readonly state: 'still-enabled'; readonly requested: string }
  | { readonly id: 'child-telemetry-disagreement'; readonly state: 'off-while-exporting' }
  /**
   * A3.3 — the RUNTIME's own answer about which credential source it authorized
   * with, reported ONLY when it contradicts the connection the user picked.
   *
   * `ClaudeAgent.childApiKeySource()` captures the child's `apiKeySource` at
   * `system/init`. The enum has nine members at 0.3.251 and on this fork the
   * live four collapse to TWO, because the host decides the child's credential:
   * `ANTHROPIC_API_KEY` is the loopback-adapter path (gateway or BYO — the spawn
   * sets a placeholder beside a 127.0.0.1 base URL and the adapter authenticates
   * upstream itself) and `none` is the subscription card's bearer token.
   *
   * Because it is nearly constant, the VALUE is worth nothing and a
   * DISAGREEMENT is worth everything: a gateway session reporting `none`, a
   * subscription session reporting `ANTHROPIC_API_KEY`, or any of the other
   * seven members at all, each mean the child authorized with something the host
   * did not intend — `apiKeyHelper` and `/login managed key` would each mean it
   * reached a credential source on the machine this fork never configures. So
   * the clause carries both halves and is emitted on nothing else.
   *
   * Both fields are SOURCE NAMES from the vendor's enum, never a credential and
   * never a length. Present only when the caller resolved a live session's
   * answer, which is what keeps every ordinary session silent — and, unlike its
   * neighbours, the caller can only resolve it once a query has run, so it is
   * announced when it is detected rather than at session start.
   */
  | {
      readonly id: 'child-credential-source-unexpected'
      readonly source: string
      readonly expected: string
    }
  /**
   * D1.139 / D1.250 — claude's own auto memory is in a state this app did not
   * choose for an ordinary session: FORCED ON by an environment this app never
   * writes, or OFF because this chat's memory is closed.
   *
   * The ordinary `runtime-default` state is deliberately NOT here. It is true of
   * every claude session, so a clause that fired on it would add a line to all
   * of them — the per-session nag this notice's own latch exists to prevent. It
   * has a PULL surface instead (`protocol/session-runtime-notices.ts`, D1.215),
   * which is where a user who wants the ordinary state can read it.
   */
  | { readonly id: 'claude-auto-memory-abnormal'; readonly state: 'forced-on' | 'off-by-host' }
  /**
   * D1.343 — a command hook declared in a settings file ran WITHOUT a permission
   * card, and the user is told the first time it happens.
   *
   * `hooks.md#workspace-trust` makes running it the documented behaviour —
   * *"Claude Code checks workspace trust before it runs any hook from a settings
   * file"*, and past that check a hook simply executes — so this is not a
   * warning and not a finding. It is the fork stating where it stopped asking,
   * because an unasked spawn nobody was told about is indistinguishable from a
   * defect, which is the whole reason the clause exists rather than a silent
   * widening.
   *
   * `tier` is the one thing a reader can act on: `user` means their own
   * settings, `project` means the repository they trusted. A plugin's hook is
   * never this clause — it still raises a card — so there is no third member,
   * and adding one would mean the posture changed.
   *
   * Announced at the moment the first such hook runs rather than at session
   * start, on {@link SettingsTiersClauseV1}'s `child-credential-source-unexpected`
   * precedent: the answer does not exist until then, so a clause on the
   * once-per-session line would be permanently absent.
   */
  | { readonly id: 'command-hook-preauthorized'; readonly tier: 'user' | 'project' };

/**
 * The three vocabularies, named as the streams themselves name them.
 *
 * `host-nessy` — the Pi harness's four `nessy.*` event names
 * (`packages/server-core/src/pi-harness/otlp-telemetry.ts`). `codex` — codex's
 * own fourteen `codex.*` names, the list `CODEX_TELEMETRY_COVERAGE` documents.
 * `claude-sdk` — the claude child's twenty-five `claude_code.*` names.
 */
export type TelemetryEventDialectV1 = 'host-nessy' | 'codex' | 'claude-sdk';

/**
 * P6.576 — the two settings-file tiers, for session start, as clauses.
 *
 * The defect: `buildConfigDoctorReport` already names the winning managed
 * source, the shadowed sources and the dropped entries, and its ONLY production
 * consumer is `apps/cli/src/doctor.ts`. So the host holds the fact and a desktop
 * user never meets it — theme 2 of the denominator sweep. A managed policy that
 * enforces nothing, a settings layer that was rejected whole, a `config.json`
 * key that was dropped: all of it is discoverable exclusively by running a CLI
 * the app does not ship a route to.
 *
 * ## Why a LINE and not a second report
 *
 * The full report is the doctor's, and duplicating it at session start would put
 * a screen of text in front of every user on every session for a state almost
 * all of them do not have. This returns one sentence's worth of clauses, built
 * from the SAME input the report is, so the two cannot disagree — and it returns
 * an empty list when there is nothing to say, which is the default install.
 * Silence is the correct output for a machine with no managed source, no drops
 * and no rejected layer.
 *
 * ## What counts as "something to say"
 *
 * Exactly `buildConfigDoctorReport`'s own `hasFindings` inputs for the settings
 * tiers, plus the presence of a managed source (which is not a finding — an
 * administrator's policy being IN EFFECT is a fact the user is entitled to,
 * and it is the fact that explains every other surprise in the session), plus
 * the instruction-file count W7-w attached: `/trim`'s proposal (P6.398) has no
 * session-facing surface either, and it is derived from the same input record.
 */
/** A3.3 — the longest member of the vendor's enum is 20 characters; this is slack. */
const CREDENTIAL_SOURCE_NAME_LIMIT = 120

export function buildSettingsTiersSessionClauses(
  input: ConfigDoctorInputV1,
): readonly SettingsTiersClauseV1[] {
  const clauses: SettingsTiersClauseV1[] = []

  if (input.winner !== 'none') {
    clauses.push({ id: 'managed-source', winner: input.winner })
  }
  if (input.drops.length > 0) {
    clauses.push({ id: 'invalid-managed-entries', count: input.drops.length })
  }
  // F1.1043 — a credential in use is disclosed in the report, not a rejected layer.
  const rejected = (input.rejectedLayers ?? []).filter(layer => !layer.inUse)
  if (rejected.length > 0) {
    clauses.push({ id: 'rejected-layers', count: rejected.length })
  }
  // The shadowed-file warning is the one an administrator cannot see any other
  // way: the file is on disk, it looks deployed, and it enforces nothing.
  if (shadowedManagedFileWarning(input.winner, input.fileCarriesSettings, input.filePath)) {
    clauses.push({ id: 'shadowed-managed-file' })
  }

  // P6.497's S RESIDUE, folded into this line rather than given a surface of
  // its own — and that is the whole of the row, deliberately.
  //
  // The delegated decision (Q-den 12) is option (a): the mandate stays
  // REPORT-ONLY. (b), acquire-at-boot, was refused because it is unattended
  // execution from policy — the host fetching and installing code at boot
  // because a file said so. So the residue is exactly "the report reaches the
  // app", and the app already has this line. A second channel for one sentence
  // would be more code for the same fact, against the owner's smallest-
  // integration rule.
  const unfulfilledMandates = (input.mandatedPlugins ?? [])
    .filter(finding => finding.state === 'not-installed')
  if (unfulfilledMandates.length > 0) {
    clauses.push({ id: 'unfulfilled-mandates', count: unfulfilledMandates.length })
  }

  // W7-w's attachment: same record, same line. An over-long instruction file is
  // guidance and never a finding (`buildConfigDoctorReport` says why), so it is
  // reported only when there is one — a repository within the limit adds
  // nothing here, exactly as it proposes nothing to `/trim`.
  const over = (input.instructionFiles ?? [])
    .filter(file => file.lineCount > INSTRUCTION_FILE_TRIM_LINE_LIMIT)
  if (over.length > 0) {
    clauses.push({
      id: 'instruction-files-over-limit',
      count: over.length,
      limit: INSTRUCTION_FILE_TRIM_LINE_LIMIT,
    })
  }

  // P6.733 — LAST, and only when the caller looked. It is not a settings TIER
  // at all; it rides this line because it is the same moment and the same
  // audience, and a second notice for one sentence would be more code for the
  // same fact.
  if (input.telemetryIdentityExported) {
    clauses.push({ id: 'telemetry-identity-exported' })
  }

  // C3.199 — after the identity clause and for the same reason it is last: it is
  // not a settings TIER either. Resolved by the caller, because only the caller
  // knows which runtime this session runs on and whether an exporter is
  // configured at all.
  if (input.telemetryEventDialect) {
    clauses.push({ id: 'telemetry-event-dialect', dialect: input.telemetryEventDialect })
  }

  // A3.3 — LAST, and emitted on a DISAGREEMENT only. Equal values are the
  // ordinary session and say nothing; the caller resolves both halves because
  // only it knows which connection the session runs on and what the runtime
  // answered.
  // D1.250 — resolved by the caller, for the dialect clause's reason: only the
  // caller knows which runtime this session runs on, what memory scope it
  // resolved and which per-workspace claude config dir it would spawn with.
  if (input.claudeAutoMemoryState) {
    clauses.push({ id: 'claude-auto-memory-abnormal', state: input.claudeAutoMemoryState })
  }

  const credential = input.childCredentialSource
  if (credential && credential.source !== credential.expected) {
    // BOUNDED here rather than at the caller: both values are vendor enum
    // members, and a runtime that answered with something long has already
    // answered with something unexpected — the clause must stay one line.
    clauses.push({
      id: 'child-credential-source-unexpected',
      source: credential.source.slice(0, CREDENTIAL_SOURCE_NAME_LIMIT),
      expected: credential.expected.slice(0, CREDENTIAL_SOURCE_NAME_LIMIT),
    })
  }

  return clauses
}

/**
 * The same clauses, in the doctor's own English voice.
 *
 * Nothing in `config-doctor.ts` is localised — the report is one voice for the
 * CLI, the ticket it is pasted into and the fleet check that greps it. A caller
 * that has a locale renders {@link buildSettingsTiersSessionClauses} instead;
 * this is what the CLI and any grep-shaped reader keep.
 */
export function renderSettingsTiersClause(clause: SettingsTiersClauseV1): string {
  switch (clause.id) {
    case 'managed-source':
      return `${WINNER_LABEL[clause.winner]} in effect`
    case 'invalid-managed-entries':
      return `${clause.count} invalid managed`
        + ` ${clause.count === 1 ? 'entry was' : 'entries were'} dropped`
    case 'rejected-layers':
      return `${clause.count} settings`
        + ` ${clause.count === 1 ? 'layer was' : 'layers were'} rejected whole`
    case 'shadowed-managed-file':
      return 'a managed policy file on disk is shadowed and enforces nothing'
    case 'unfulfilled-mandates':
      // The wording states what the mandate DOES, because "not installed" alone
      // reads as a transient state an administrator can wait out: it enables a
      // plugin that is already present and never acquires one.
      return `${clause.count} force-enabled`
        + ` ${clause.count === 1 ? 'plugin is' : 'plugins are'} not installed here,`
        + ' and a mandate never acquires one — it only enables a plugin already present'
    case 'instruction-files-over-limit':
      return `${clause.count} project instruction`
        + ` ${clause.count === 1 ? 'file is' : 'files are'} over the`
        + ` ${clause.limit}-line guidance`
    case 'telemetry-identity-exported':
      // A3.2 — the SECOND copy of this sentence, and it must stay word-for-word
      // the locale pair's. Two things were wrong with the old one and both were
      // in the harmful direction for a disclosure. It named the ACCOUNT, which
      // is a separate boolean off the same resolver that nothing consults — so
      // with the id switch on and the account switch unset it claimed an export
      // that was not happening, on every runtime, and on codex can never happen
      // (`withCodexTelemetryIdentity` declines `user.account_uuid` with its
      // reason written down). And it named ONE stream where the identity rides
      // more than one: codex's rides `OTEL_RESOURCE_ATTRIBUTES` into the OTLP
      // resource, which its own provider builds for logs AND traces, so with a
      // trace exporter configured the id leaves on traces too. (The retired
      // wording is described rather than quoted, so a census of it cannot
      // mistake this comment for live copy.)
      //
      // Naming the individual streams was weighed and DECLINED under the
      // balance rule: it needs the endpoint at the notice site, and a user can
      // act on "my session id leaves this machine" but not on "traces vs logs".
      return 'this session\'s id is exported to your operator\'s telemetry collector'
    case 'child-credential-source-unexpected':
      // The doctor's own voice: no frame, no advice, and both names verbatim —
      // this sentence is read by a support thread and by a fleet grep, and the
      // thing worth reading is which two names disagreed.
      return `the runtime authorized this session with ${clause.source},`
        + ` where this connection implies ${clause.expected}`
    case 'claude-auto-memory-abnormal':
      // The doctor's own English voice, and it names the VARIABLE for the same
      // reason the credential clause names both sources: the reader is a
      // support thread or a fleet grep, and the actionable half is which
      // environment value produced the state.
      return clause.state === 'forced-on'
        ? 'the Claude runtime\'s own memory is forced on for this session by'
          + ' CLAUDE_CODE_DISABLE_AUTO_MEMORY in its environment, which this app never sets'
        : 'the Claude runtime\'s own memory is off for this chat,'
          + ' so it neither writes nor reads notes of its own'
    case 'child-telemetry-disagreement':
      // The doctor's own English voice, naming the VARIABLES for the reason
      // every sibling in this family names its inputs: the reader is a support
      // thread or a fleet grep, and the actionable half is which name was set.
      return clause.state === 'still-enabled'
        ? `you set ${clause.requested}, and the Claude runtime reports analytics`
          + ' still enabled for this session'
        : 'the Claude runtime reports its own analytics off for this session,'
          + ' so its events do not reach the collector this machine exports to'
    case 'telemetry-event-dialect':
      return clause.dialect === 'codex'
        ? 'telemetry events from this session carry codex\'s own `codex.*` names,'
          + ' and host metrics carry `nessy.*` rather than `claude_code.*`'
        : clause.dialect === 'claude-sdk'
          ? 'telemetry events from this session carry the Claude runtime\'s own `claude_code.*`'
            + ' names, and host metrics carry `nessy.*` rather than `claude_code.*`'
          : 'telemetry events from this session carry this product\'s own `nessy.*` names,'
            + ' never `claude_code.*`'
    case 'command-hook-preauthorized':
      // The doctor's own English voice, naming the TIER for the reason every
      // sibling names its input: the reader is a support thread or a fleet
      // grep, and the actionable half is which settings file may spawn without
      // asking. It says what still asks in the same breath, because a sentence
      // that only says what stopped asking reads as "nothing asks any more".
      return clause.tier === 'user'
        ? 'command hooks in your own settings run without asking,'
          + ' the way hooks are documented to; a plugin\'s still asks'
        : 'command hooks in this trusted project\'s settings run without asking,'
          + ' the way hooks are documented to; a plugin\'s still asks'
  }
}

/**
 * P6.576 — the two settings-file tiers, in ONE line, for session start.
 *
 * The derivation is {@link buildSettingsTiersSessionClauses}'; this is the
 * English frame around it, kept for the CLI and for any reader that greps the
 * sentence. `undefined` when there is nothing to say.
 */
export function buildSettingsTiersSessionLine(input: ConfigDoctorInputV1): string | undefined {
  const parts = buildSettingsTiersSessionClauses(input).map(renderSettingsTiersClause)
  if (parts.length === 0) return undefined
  return `Settings: ${parts.join('; ')}. Run \`nessy-general-agent doctor\` for the detail.`
}

/**
 * P6.246(c) — one sentence, four outcomes, and the cause is never printed alone.
 *
 * *loaded* / *fetch failed, with the cause AND what still applies* / *nothing
 * configured* / *skipped*. The failure arm carries both halves deliberately: an
 * administrator who reads only the cause cannot tell a fleet running yesterday's
 * approved policy from a fleet running none, and
 * `server-managed-settings.md#fetch-and-caching-behavior` — *"Cached settings
 * apply immediately at startup"* — makes the first of those the normal case.
 *
 * Exported so the CLI doctor and this report say it once.
 */
export function describeManagedDeliveryOutcome(
  delivery: ManagedDeliveryDoctorInputV1 | undefined,
): string {
  if (!delivery) return 'not determined on this host'
  if (!delivery.enabled) return 'nothing configured — this install did not opt into server-delivered settings'
  if (delivery.fetchError) {
    const stillApplies = delivery.source === 'none'
      ? 'and NO managed settings are in effect'
      : `and the ${delivery.source === 'cache' ? 'cached' : 'last fetched'} settings still apply`
    return `fetch FAILED (${sanitizeSettingsDiagnostic(delivery.fetchError.cause, 200)}) ${stillApplies}`
  }
  if (delivery.confirmed) return 'loaded — the server confirmed the payload in this session'
  if (delivery.source === 'cache') return 'cached settings applied; no confirming fetch yet in this session'
  return 'skipped — no fetch has run in this session'
}

export function buildConfigDoctorReport(input: ConfigDoctorInputV1): ConfigDoctorReportV1 {
  // F1.1043 — a settings-file credential the runtime USES rides the same record, flagged `inUse`: listed in its own
  // section below, never under the rejected layers and never a finding (the user's trusted project chose it).
  const rejectedLayers = (input.rejectedLayers ?? []).filter(layer => !layer.inUse)
  const credentialsInUse = (input.rejectedLayers ?? []).filter(layer => layer.inUse)
  const parts: string[] = []

  const sourceLines: string[] = [`  ${WINNER_LABEL[input.winner]}`]
  if (input.winner === 'delivered' && input.deliveryCachePath) {
    sourceLines.push(`  cache: ${sanitizeSettingsDiagnostic(input.deliveryCachePath, 200)}`)
  }
  if (input.winner === 'file' && input.filePath) {
    sourceLines.push(`  file:  ${sanitizeSettingsDiagnostic(input.filePath, 200)}`)
  }
  // `server-managed-settings.md#settings-precedence` — "Within the managed
  // tier, Claude Code by default uses the first source that delivers at least
  // one policy key". Winner-takes-all is correct and R25c made us match it; the
  // cost is that a policy file an administrator can see on disk enforces
  // nothing, with no signal. The cleared-console paragraph of that same section
  // sends them to this surface for exactly that.
  const shadowWarning = shadowedManagedFileWarning(
    input.winner,
    input.fileCarriesSettings,
    input.filePath,
  )
  if (shadowWarning) sourceLines.push('', `  ! ${shadowWarning}`)
  // P6.246(c) — the four answers, on the line under the source, because "which
  // source won" and "did the remote policy arrive" are the two halves of one
  // question and reading either alone gives a false picture.
  sourceLines.push(`  delivery: ${describeManagedDeliveryOutcome(input.delivery)}`)
  parts.push(section('Managed settings source:', sourceLines))

  parts.push(input.drops.length === 0
    ? section('Invalid managed entries:', ['  none'])
    : section(
      `Invalid managed entries (${input.drops.length}):`,
      input.drops.map(drop => `  - ${formatManagedPolicyDrop(drop)}`),
    ))

  // Immediately after the drops, because the two are the same question asked in
  // the two directions an administrator has to separate: what the managed source
  // REFUSED, then what it kept and enforces differently. Reading either one
  // without the other gives a false picture of the deployed policy.
  if (input.caveats) {
    parts.push(input.caveats.length === 0
      ? section('Managed entries enforced differently:', ['  none'])
      : section(
        `Managed entries enforced differently (${input.caveats.length}):`,
        caveatLines(input.caveats),
      ))
  }

  parts.push(rejectedLayers.length === 0
    ? section('Rejected settings layers:', ['  none'])
    : section(
      `Rejected settings layers (${rejectedLayers.length}):`,
      rejectedLayers.map(layer =>
        `  - ${sanitizeSettingsDiagnostic(layer.source, 200)}: ${sanitizeSettingsDiagnostic(layer.key, 120)}`
        // The cap is the type's own, not a literal: this is the READER half of
        // a field whose writer lives in `config/storage.ts`, and two literals
        // are how the two halves of one field come to disagree (P6.639). Why
        // the number is 400 and not the managed-drop 200 is at the constant.
        + ` — ${sanitizeSettingsDiagnostic(layer.reason, REJECTED_LAYER_REASON_MAX)}`
        + ' [layer rejected whole]'),
    ))
  if (credentialsInUse.length > 0) {
    parts.push(section(
      `Settings-file credentials in use (${credentialsInUse.length}):`,
      credentialsInUse.map(layer =>
        `  - ${sanitizeSettingsDiagnostic(layer.source, 200)}: ${sanitizeSettingsDiagnostic(layer.key, 120)}`
        + ` — ${sanitizeSettingsDiagnostic(layer.reason, REJECTED_LAYER_REASON_MAX)}`),
    ))
  }

  // P6.493 — beside the managed sections rather than under them, because it is
  // the same question asked of the OTHER scope: what did this machine's own
  // settings file contribute to the judge, and what did it try to.
  if (input.userAutoMode) {
    parts.push(section('Safety judge, user scope:', userAutoModeLines(input.userAutoMode)))
  }

  // P6.878 — beside the safety judge's user scope, and for the same reason it
  // sits there: both are the USER rung, read from this machine's own files,
  // after the managed sections that can override them. `config.json` is a
  // different file from `settings.json` and the section names it.
  if (input.storedConfigValidation) {
    // The heading names the FILE rather than the outcome ("values refused"),
    // because this section prints on a clean machine too and a heading that
    // asserted a fault would be wrong there more often than right.
    parts.push(section(
      'User config (config.json):',
      storedConfigValidationLines(input.storedConfigValidation),
    ))
  }

  // P6.824 — after the file that carries four of the six, because the reader who
  // has just been told which values were REFUSED is the reader who then asks
  // which values are in force and where they are set.
  if (input.configOnlySettings) {
    parts.push(section(
      'Settings with no in-app control:',
      configOnlySettingsLines(input.configOnlySettings),
    ))
  }

  parts.push(section('Model allowlist:', modelAllowlistLines(
    input.availableModels,
    input.enforceAvailableModels,
  )))

  if (input.sandboxEnabled !== undefined) {
    // One field, one line (T1 contour f) — enough for an operator reading the
    // report to learn whether the OS-level wrap layer is even in play before
    // reading the network/filesystem sections below, which describe policy
    // that binds nothing at all while this is false.
    parts.push(section('Sandbox:', [
      input.sandboxEnabled
        ? '  enabled — supervised commands run under seatbelt/bwrap/firejail/the Windows profile'
        : '  disabled (config default) — supervised commands run WITHOUT OS-level isolation;'
        + ' set sandbox.enabled to restore it',
    ]))
  }

  if (input.sandboxUncarriedKeys && input.sandboxUncarriedKeys.length > 0) {
    // One sentence for the block, then the keys — the host composition path
    // repeats the whole explanation per key on a debug channel, which reads
    // fine once and badly six times in a report. Same content, said once.
    parts.push(section('Sandbox keys accepted without effect:', [
      ...input.sandboxUncarriedKeys.map(key => `  ${sanitizeSettingsDiagnostic(key, 128)}`),
      '  These are documented by Claude Code and reach no layer here: this product\'s OS'
      + ' isolation is off by owner decision and its wrapper is its own.',
      '  Every other key in the same block still applies.',
    ]))
  }

  if (input.sandboxNetwork) {
    parts.push(section('Sandbox network policy:', sandboxNetworkLines(input.sandboxNetwork)))
  }

  if (input.sandboxFilesystem && input.sandboxFilesystem.length > 0) {
    // No synthetic cause line. `resolveSandboxFilesystemConsequences` now reports
    // two different configurations — the layer being off, and a configured
    // `allowRead` — and its own first line names whichever one applies. A header
    // that asserted `sandbox.filesystem.disabled` would mislabel the other.
    parts.push(section('Sandbox filesystem layer:',
      input.sandboxFilesystem.map(line => `  ! ${sanitizeSettingsDiagnostic(line, 512)}`)))
  }

  if (input.retention) {
    parts.push(section('Retention cleanup:', retentionLines(input.retention)))
  }

  if (input.mandatedPlugins) {
    parts.push(section('Force-enabled plugins:', mandatedPluginLines(input.mandatedPlugins)))
  }

  if (input.agentDefinitions) {
    parts.push(section('Agent definitions:', agentDefinitionLines(input.agentDefinitions)))
  }

  if (input.instructionFiles) {
    parts.push(section('Project instruction files:', instructionFileLines(input.instructionFiles)))
  }

  if (input.searchBackend) {
    parts.push(section('Search backend:', searchBackendLines(input.searchBackend)))
  }

  if (input.networkTrust) {
    parts.push(section('Network trust chain:', networkTrustLines(input.networkTrust)))
  }

  if (input.gatewayAuth) {
    parts.push(section('Nessy Gateway sign-in:', gatewayAuthLines(input.gatewayAuth)))
  }

  return Object.freeze({
    text: parts.join('\n\n'),
    hasFindings: input.drops.length > 0
      || rejectedLayers.length > 0
      || shadowWarning !== undefined
      // A malformed agent definition is skipped by the runtime rather than
      // fixed by it; fixing the file is an action, so the skip is a finding.
      || (input.agentDefinitions?.length ?? 0) > 0
      // A caveat is a finding on the same rule the unenforceable-network-rule
      // line below already states: a configured rule that does not bind as
      // written is something to act on. It is stronger here than there — one
      // disposition makes an allowlist grant LESS than it reads and the other
      // makes a denylist block MORE — and the non-zero exit is what lets
      // the pre-deployment check on a test machine of
      // `server-managed-settings.md#invalid-entries-in-delivered-settings` catch
      // it before the fleet does. It is NOT the deliberate-off-switch case that
      // keeps `sandbox.filesystem.disabled` and a disabled retention sweep out
      // of this list: nobody chooses a scope they did not write.
      || (input.caveats?.length ?? 0) > 0
      // `claude-directory.md#cleaned-up-automatically` — a settings file that
      // can't be read or parsed pauses the sweep, with a warning in `/status`
      // "until you fix the settings errors". Fixing the file is an action, so
      // the pause is a finding. A deliberate off switch is not.
      || input.retention?.state === 'paused'
      // A configured rule that binds nothing is something to act on, and the
      // non-zero exit is what lets the pre-deployment check on a test machine of
      // `server-managed-settings.md#invalid-entries-in-delivered-settings` catch
      // it before the fleet does.
      || (input.sandboxNetwork?.enforcement.unenforceable.length ?? 0) > 0
      // A mandate that does nothing is something to act on, and it is invisible
      // everywhere else — the whole reason this section exists.
      || hasUnfulfilledPluginMandate(input.mandatedPlugins ?? [])
      // P6.255 (c). Two of the three legs move the exit code and one does not,
      // and the split is the same one the sections above already draw. A CA file
      // that cannot be read and a client identity that does not resolve are
      // settings the operator WROTE which do not bind as written — the caveat
      // rule exactly — and the second one silently downgrades to an
      // unauthenticated connection, which is the failure this build is required
      // to make loud. The proxy leg never moves it: a proxy is a fact about the
      // network, not a fault, and neither is the reload off-switch, which an
      // operator may have set deliberately. Both still print with their own
      // markers so nobody has to already know the name to see the cost.
      || input.networkTrust?.caWarning !== undefined
      || input.networkTrust?.clientCertificateError !== undefined,
    // DA1.34 — the gateway sign-in section is a PRINTED READING and deliberately
    // moves NOTHING above, the same posture the CLI's skill-listing budget
    // states for itself ("a stated posture, never a finding").
    //
    // The first draft did move it, on the reasoning that anything but `ok` is
    // actionable by the user. True of the SENTENCE, wrong for the FLAG, and the
    // reason was measured while writing it: this section cannot see whether the
    // profile has a gateway card at all — knowing that would put a SECOND gateway
    // predicate in this module, the drift DA1.31 spent a row removing — so a host
    // with no gateway connection and no creds reports `no_credentials` and would
    // have moved an exit code over a credential nothing on that machine wants. It
    // also made `apps/cli/src/doctor.test.ts`'s clean-configuration case depend on
    // whether whoever runs it happens to be signed in, which is a knob set below
    // the system's resting state. The row asks the doctor to PRINT the reason.
    // `sandbox.filesystem.disabled` is deliberately NOT a finding, on the same
    // rule the retention section states: a deliberate off switch a user chose
    // is a setting, not a fault. It is printed with a `!` marker so nobody has
    // to already know the key to see what it cost.
    //
    // A refused `config.json` value is NOT a finding either (P6.878), on the
    // same rule and for a second reason of its own. The rule: this flag means
    // "something an ADMINISTRATOR has to act on", and a bad value in the user's
    // own `config.json` is a fault on the desk that is reading this report —
    // the identical call the safety judge's refused-key line already makes.
    // The second reason is measured rather than argued: `validateConfig()`
    // answers `valid: false` with "Config file does not exist" on a machine
    // that has not run setup, so making this move the exit code would fail
    // the pre-deployment fleet check on every fresh install — the check
    // `server-managed-settings.md#invalid-entries-in-delivered-settings`
    // prescribes: "Validate a payload change with `claude doctor` on a test
    // machine before rolling it out to the organization."
    // It still prints, with its own lines, so nobody has to know the key.
    //
    // An over-long instruction file is NOT a finding either, and the reason is
    // the one this flag is defined by: "something an ADMINISTRATOR has to act
    // on". `memory.md` frames the 200-line limit as guidance — a long file
    // "may reduce adherence", it does not break a deployment — and this exit
    // code is what the pre-deployment fleet check of
    // `server-managed-settings.md#invalid-entries-in-delivered-settings` reads. A
    // repository whose CLAUDE.md grew would start failing that check for a
    // reason no administrator can fix from the fleet, which is the wrong
    // signal on the wrong desk. It still prints with a `!` marker.
  })
}
