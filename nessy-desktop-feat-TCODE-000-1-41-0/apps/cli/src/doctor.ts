/**
 * `nessy-general-agent doctor` — the read-only configuration checkup.
 *
 * `debug-your-config.md:46` — "From the terminal, `claude doctor` prints
 * read-only installation and settings diagnostics without starting a session."
 * `managed-settings.md#invalid-entries-in-managed-settings` — "[`claude
 * doctor`](/docs/en/debug-your-config) lists each invalid entry with its source
 * and field." `server-managed-settings.md#invalid-entries-in-delivered-settings`
 * — "Validate a payload change with `claude doctor` on a test machine before
 * rolling it out to the organization."
 *
 * ## Why the CLI and not a session tool
 *
 * Three of the four sentences that define this listing name the terminal form,
 * and `settings-reference.md#requiredminimumversion` and
 * `#requiredmaximumversion` require it to keep working when the app refuses
 * to start: "`claude update`, `claude install`, and `claude doctor` keep working
 * above the ceiling so users can recover" — deviation Unit 4 shipped exactly
 * that version gate, so a doctor that only exists inside a session is unusable
 * in the one state an administrator most needs it. It also needs no session, no
 * model turn, no translated string and no new command tier.
 *
 * Read-only by construction: this module reads files and writes to stdout. It
 * never repairs anything, which is the difference `debug-your-config.md:44`
 * draws between the interactive `/doctor` ("proposes fixes it applies only after
 * you confirm") and the terminal form.
 *
 * That still holds now that the report PROPOSES a trim for an over-long project
 * instruction file (P6.398), and the reason is an owner decision rather than an
 * accident of this file: D12 — the configuration checkup stays read-only, and
 * says so, because "a checkup that edits the user's files is a different
 * product". So a proposal here is a REPORT: it names the sections and what each
 * costs, quotes the rule for deciding, and changes nothing. The half of
 * `debug-your-config.md:44` this module does not implement is the APPLYING, and
 * that half lives in the interactive `/doctor` inside the vendor's own TUI,
 * which we do not embed — we embed the SDK.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  buildConfigDoctorReport,
  describeManagedDeliveryOutcome,
  instructionFileSections,
  type AgentDefinitionFindingV1,
  type ConfigDoctorInputV1,
  type ConfigOnlySettingsDoctorInputV1,
  type ConfigOnlySettingV1,
  type InstructionFileFindingV1,
  type GatewayAuthDoctorInputV1,
  type NetworkTrustDoctorInputV1,
  type SearchBackendDoctorInputV1,
  type StoredConfigValidationDoctorInputV1,
} from '@nessy-agent/shared/config/config-doctor'
import { getNetworkProxySettings, loadStoredConfig } from '@nessy-agent/shared/config/storage'
import { documentedUncarriedSandboxKeys } from '@nessy-agent/shared/config/sandbox-settings'
import { resolveTlsCaRuntime } from '@nessy-agent/shared/config/network-tls-ca'
import { resolveClientIdentityRuntime } from '@nessy-agent/shared/config/network-mtls'
import {
  instructionFileExistsAt,
  projectInstructionFilesIn,
} from '@nessy-agent/shared/capabilities/instruction-files'
import { resolveBackendHostTooling } from '@nessy-agent/shared/agent/backend'
import { validatePiRuntimeAgentDefinitionContent } from '@nessy-agent/shared/agent/pi-harness/runtime-agent-definition'
import type { UserScopeAutoModeReadV1 } from '@nessy-agent/shared/agent/pi-harness/user-auto-mode-policy'
import { validateMarkdownAgentDefinitionContent } from '@nessy-agent/shared/agents'
import type { MandatedPluginFindingV1 } from '@nessy-agent/shared/plugins'
import {
  collectAgentDefinitionFindings,
  collectConfigOnlySettings,
  collectInstructionFileFindings,
  collectGatewayAuthInput,
  collectNetworkTrustInput,
  collectSearchBackendInput,
  collectStoredConfigValidationInput,
  collectUncarriedSandboxKeys,
  collectUserAutoModeInput,
} from '@nessy-agent/shared/config/doctor-collectors'
import { CONFIG_DIR, PLUGINS_DIR } from '@nessy-agent/shared/workspaces'
import {
  collectConfigDoctorInput,
  collectMandatedPluginFindingsFromEnforcedPolicy,
} from '@nessy-agent/server-core/bootstrap/managed-policy-resolution'

/**
 * P6.684 — the collectors are `@nessy-agent/shared/config/doctor-collectors` now,
 * so the desktop's D12 surface and the session-start settings line report the
 * SAME record this command does. Four of the six used to be module-private
 * here, which is why each of those surfaces reported a narrower one and
 * disclosed the gap in its own words. **P6.760 moved the seventh**,
 * `collectUserAutoModeInput`, which P6.684 had left behind on purpose so its own
 * five-collector done-means stayed checkable; no collector is private to this
 * command any more.
 *
 * Re-exported by name because `doctor.test.ts` imports two of them from this
 * module, and moving code is not a reason to move a test.
 */
export {
  collectAgentDefinitionFindings,
  collectInstructionFileFindings,
} from '@nessy-agent/shared/config/doctor-collectors'

/**
 * The one collector that cannot be parameter-free: resolving the ENFORCED
 * managed policy is `server-core`'s, one layer above the shared module, so the
 * process owner reads it and hands the map over. An unresolvable policy is
 * "I could not look", which omits the section.
 *
 * **P6.788 — that wiring is `server-core`'s single
 * {@link collectMandatedPluginFindingsFromEnforcedPolicy} now.** It was written
 * out here, in `SessionManager` and in the `GET_CONFIG_DOCTOR` handler, each with
 * its own `catch`, and the handler's comment said it was this function "verbatim
 * in intent" — three copies of the decision about what an unresolvable policy is
 * allowed to look like. This name stays because the call site below and
 * `doctor.test.ts` both use it, and moving code is not a reason to move a test.
 */
function collectMandatedPluginFindingsHere(): readonly MandatedPluginFindingV1[] | undefined {
  return collectMandatedPluginFindingsFromEnforcedPolicy()
}

export interface DoctorOptions {
  /** Raw JSON for scripting, matching the CLI's global `--json`. */
  readonly json?: boolean
  /** Injected for tests; production passes nothing. */
  readonly collect?: typeof collectConfigDoctorInput
  /** Injected for tests; production passes nothing. */
  readonly collectMandatedPlugins?: () => readonly MandatedPluginFindingV1[] | undefined
  /** Injected for tests; production passes nothing. */
  readonly collectAgentDefinitions?: () => readonly AgentDefinitionFindingV1[] | undefined
  /** Injected for tests; production passes nothing. */
  readonly collectSearchBackend?: () => SearchBackendDoctorInputV1 | undefined
  /** Injected for tests; production passes nothing. */
  readonly collectInstructionFiles?: () => readonly InstructionFileFindingV1[] | undefined
  /** Injected for tests; production reads the real settings and environment. */
  readonly collectNetworkTrust?: () => NetworkTrustDoctorInputV1 | undefined
  /** DA1.34 — injected for tests; production reads the shared creds file. */
  readonly collectGatewayAuth?: () => GatewayAuthDoctorInputV1 | undefined
  /** Injected for tests; production reads the user's own `sandbox` block. */
  readonly collectUncarriedSandboxKeys?: () => readonly string[] | undefined
  /** Injected for tests; production reads the user's own `autoMode` block. */
  readonly collectUserAutoMode?: () => UserScopeAutoModeReadV1 | undefined
  /** Injected for tests; production runs the real `validateConfig()`. */
  readonly collectStoredConfigValidation?: () => StoredConfigValidationDoctorInputV1 | undefined
  /** Injected for tests; production reads the two real config files. */
  readonly collectConfigOnlySettings?: () => ConfigOnlySettingsDoctorInputV1 | undefined
}

/**
 * P2.381 — the codex remote-control posture, stated to the operator.
 *
 * OWNER RULING 2026-09-01: explicitly disable. The app spawns
 * `codex-app-server` with `CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED=1`
 * (`packages/codex-agent-server/src/runtime-manager.ts`, whose docblock carries
 * the source reading at tag `rust-v0.148.0` and the binary probe). Before that
 * the transport was unowned residue — we neither enabled nor disabled it, so
 * what shipped was whatever the binary defaulted to, and nobody had measured
 * what that was.
 *
 * WHY IT IS PRINTED HERE AND NOT ONLY APPLIED. The row's own condition: *"the
 * diagnostic we show an operator must say what we set and what it was, or it is
 * a claim rather than a control."* A disable an operator cannot verify is
 * indistinguishable from an undocumented default — the exact shape of this
 * fork's largest defect class. `doctor` is the read-only, session-free checkup
 * an administrator already runs (`debug-your-config.md:46`), so the statement
 * lives where it will be read.
 *
 * NOT A FINDING. It never sets a non-zero exit code: this is a stated posture,
 * not a defect on this machine. A fleet check keys on
 * `codexRemoteControl.disabledBy` in the `--json` form instead.
 *
 * THE TWO HALVES ARE PINNED TOGETHER. This file is a second spelling of the env
 * name and value the spawner writes, and a second spelling drifts silently —
 * `packages/codex-agent-server/src/__tests__/runtime-manager.test.ts`
 * reads BOTH and fails when they disagree. It is spelled twice rather than
 * imported because `apps/cli` does not depend on `@nessy-agent/codex-agent-server`
 * and adding a workspace dependency to print one sentence would rewrite the
 * lockfile for a diagnostic.
 */
export const CODEX_REMOTE_CONTROL_DOCTOR = {
  env: 'CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED',
  value: '1',
  /** What the shipped binary does when the marker is absent. */
  defaultWithoutIt: 'ResolvePersisted (policy Allowed; a pairing persisted earlier can re-enable it)',
} as const

function codexRemoteControlSection(): string {
  return [
    'Codex remote control:',
    `  disabled — this app spawns codex-app-server with ${CODEX_REMOTE_CONTROL_DOCTOR.env}=${CODEX_REMOTE_CONTROL_DOCTOR.value}`,
    `  without it, the binary starts in ${CODEX_REMOTE_CONTROL_DOCTOR.defaultWithoutIt}`,
    '  a managed requirements.toml with allow_remote_control = false is the administrator-side lock',
  ].join('\n')
}

/**
 * P6.404 — codex ships skills the host never lists, and until now never said so.
 *
 * The measurement, not a guess: a cold managed `CODEX_HOME` comes back holding
 * codex's own re-extracted bundled `skills/` tree — 87 entries on the shipped
 * `darwin-arm64` binary — and `$skill-installer` is one of them (10 hits in that
 * artifact, 0 anywhere under `packages/` or `apps/electron/resources/skills`).
 * So on a codex session the model can already reach an installer this product
 * neither ships nor shows, and the user meets a skill they cannot find in
 * Sources, cannot remove, and cannot explain.
 *
 * ## Why the host roster CANNOT list it, which is a premise correction
 *
 * The row assumed the fix was a new root in the capability roster
 * (`shared/capabilities/native-sources.ts`). It cannot be, for two reasons
 * measured at HEAD: the roster is runtime-agnostic — `WorkspacePolicyContext`
 * carries no provider, by design, because one inventory serves all three
 * runtimes — and the tree does not exist at inventory time, since codex
 * re-extracts it into a PER-SESSION managed `CODEX_HOME`. A roster entry would
 * have to name a directory that is created later and thrown away after.
 *
 * So the honest half is the one the `either … or` in the row already allows:
 * withhold it, and state the reason where a read-only checkup can be read
 * without starting a session. A stated posture, like the codex remote-control
 * section above — never a finding, so it never moves the exit code, because
 * this is a property of the runtime we ship rather than of this machine.
 *
 * ## Vocabulary, the trap P6.8 measured
 *
 * codex's `SkillScope::System` is the cache codex preinstalls into the user's
 * OWN home; the machine-wide administrator-owned tier is `SkillScope::Admin`
 * (`openai/codex` `rust-v0.150.1`, `ext/skills/src/host_roots.rs`, the
 * `ConfigLayerSource::System` arm). This
 * section says *bundled* and names the scope rather than borrowing the word
 * "system", which means the opposite thing to a codex reader.
 */
export const CODEX_BUNDLED_SKILLS_DOCTOR = {
  /** Where codex puts them, relative to the session's managed home. */
  path: 'CODEX_HOME/skills',
  /** Measured on the shipped darwin-arm64 codex-app-server, 2026-09-03. */
  entryCount: 87,
  /** The one with a capability of its own, and the reason this section exists. */
  notableSkill: '$skill-installer',
  /**
   * Why the host neither lists nor gates them. Kept as one sentence because it
   * is the whole answer a user gets to a skill they did not install.
   */
  reason: 'codex re-extracts them into a per-session CODEX_HOME, so no host roster pass can see them',
} as const

function codexBundledSkillsSection(): string {
  return [
    'Codex bundled skills:',
    `  not listed and not gated — codex extracts ${CODEX_BUNDLED_SKILLS_DOCTOR.entryCount} of its own skills into `
    + `${CODEX_BUNDLED_SKILLS_DOCTOR.path} every session, including ${CODEX_BUNDLED_SKILLS_DOCTOR.notableSkill}`,
    `  reason: ${CODEX_BUNDLED_SKILLS_DOCTOR.reason}`,
    '  they are codex-only: a Pi or claude session offers none of them',
  ].join('\n')
}

/**
 * P6.477 — the documented skill-listing budget key is silently inert, and the
 * flat character cap it loses to was stated nowhere an operator looks.
 *
 * `settings-reference.md#skilllistingbudgetfraction`, verbatim: *"a fraction
 * greater than `0` and at most `1`. Default: `0.01`, which reserves 1% of the
 * context window."* This build's listing does not read it. What it reads is a
 * flat character count — `SKILL_LISTING_MAX_CHARS` in
 * `packages/shared/src/agent/core/prompt-builder.ts`, raisable only by
 * `SLASH_COMMAND_TOOL_CHAR_BUDGET`, which the page names in the same sentence.
 *
 * OWNER DECISION Q5, 2026-09-05: option A — keep the flat character budget and
 * make the unread key HONEST. Option B, a window-derived share, was declined
 * because the listing sits inside Pi's CACHED system prefix (#862): a budget
 * that is a function of the selected model re-stamps that prefix on every
 * mid-session model switch and invalidates the history behind it. A per-runtime
 * budget shape was never an option — one answer on all three runtimes is the
 * property a runtime switch depends on.
 *
 * NOT A FINDING, for the same reason as the two sections above: it never moves
 * the exit code. This describes the product's posture, not a defect on this
 * machine — with ONE exception that is about this machine and is still not a
 * finding, because a settings key we chose not to read is not a
 * misconfiguration: when the operator has actually set one of the unread keys,
 * the section names it and its value, so the answer to *"why did nothing
 * change?"* is in the same place as the posture.
 *
 * NATIVE-FIRST, asked and answered: nothing to enable anywhere. codex's own
 * skills module has no budget at all — re-probed at `rust-v0.150.1`,
 * `codex-rs/core/src/skills.rs` and `codex-rs/skills/src/lib.rs` still score zero
 * for budget/truncat/max_chars/limit, against 85 and 79 for `skill` as the
 * control (the controls moved with the files, which is what makes them
 * controls);
 * Pi has none; on claude both keys are real in the vendored SDK and the child
 * does load them, which is exactly why the divergence has to be SAID rather
 * than left for an operator to discover from a listing that did not move.
 *
 * THE TWO HALVES ARE PINNED TOGETHER, the same way `CODEX_REMOTE_CONTROL_DOCTOR`
 * above is. These values are a second spelling of `SKILL_LISTING_MAX_CHARS` and
 * `SKILL_LISTING_BUDGET_ENV`, and a second spelling drifts silently —
 * `doctor.test.ts` reads BOTH spellings out of `prompt-builder.ts`'s own source
 * and fails when they disagree. Spelled twice rather than imported because
 * `packages/shared` publishes no export path for `agent/core`, and adding one to
 * print a diagnostic would widen a package surface for a sentence.
 *
 * WHAT THIS SECTION DELIBERATELY DOES NOT DO, and why (owner rule 13, smallest
 * honest integration). It does not report that the operator SET one of the
 * unread keys, because there is nowhere here to read it from: neither key is a
 * key of ours — `git grep` finds both in prose only, never in a validator, a
 * type or a stored-config reader — so the only file that could carry one is the
 * vendor's own `settings.json`, read by the claude child and by nothing on Pi or
 * codex. A per-runtime read would be exactly the divergence this section exists
 * to announce. The posture is therefore stated unconditionally, which is also
 * the form that is identical on all three runtimes.
 */
export const SKILL_LISTING_BUDGET_DOCTOR = {
  /** `SKILL_LISTING_MAX_CHARS`, the flat budget the listing's descriptions share. */
  maxChars: 4_000,
  /** `SKILL_LISTING_BUDGET_ENV`, the ONE channel that raises it here. */
  envVar: 'SLASH_COMMAND_TOOL_CHAR_BUDGET',
  /**
   * The documented settings keys this build's listing does not read, in the
   * page's own spelling. `skillListingMaxDescChars` rides along because it is
   * the same silence about the same block — our per-entry cap is its own
   * constant with its own recorded reason.
   */
  unreadSettingKeys: ['skillListingBudgetFraction', 'skillListingMaxDescChars'],
  /** Why B was declined. One sentence, because it is the whole answer. */
  reason: 'a window-derived budget makes the listing a function of the selected model, '
    + "re-stamping Pi's cached system prefix on every mid-session model switch",
} as const

export function skillListingBudgetSection(
  env: Record<string, string | undefined> = process.env,
): string {
  const envValue = env[SKILL_LISTING_BUDGET_DOCTOR.envVar]
  return [
    'Skill listing budget:',
    `  flat ${SKILL_LISTING_BUDGET_DOCTOR.maxChars.toLocaleString('en-US')} characters, identical on Pi, claude and codex `
    + '— a fixed character count, not a share of the context window',
    `  raise it with ${SKILL_LISTING_BUDGET_DOCTOR.envVar}=<characters>`
    + (envValue === undefined
      ? ' (not set here)'
      : ` (set here to "${envValue}"; a non-digit value keeps the default)`),
    `  ${SKILL_LISTING_BUDGET_DOCTOR.unreadSettingKeys.join(' and ')} are not read by this listing`,
    `  reason: ${SKILL_LISTING_BUDGET_DOCTOR.reason}`,
  ].join('\n')
}

/**
 * The exact shape `doctor --json` emits (P6.640).
 *
 * It exists because the `--json` form is a fleet-check CONTRACT with nine
 * distinct null-vs-absent conventions, and until this type they were readable
 * only by opening the emitter: a fleet check could not tell "could not look"
 * from "looked and found nothing" without reading `runDoctor`. The conventions
 * are field docs here, the emitter is typed against it, and
 * `doctor.test.ts` asserts the emitted key set is exactly this type's keys, so
 * the three cannot drift apart.
 *
 * ONE convention, stated once for all of it: **this shape has no optional
 * fields.** Every key is always present, and the absence of an answer is
 * carried by `null` — never by a missing key — because a fleet check reading
 * `x.y === undefined` cannot distinguish "this build does not emit it" from
 * "this host had nothing to say". Each `| null` below says which of the two
 * meanings the null carries for that field; they are not the same meaning
 * twice.
 */
export interface DoctorJsonReportV1 {
  /** Which managed source is in effect: `delivered`, `file`, or `none`. */
  readonly managedSource: ConfigDoctorInputV1['winner']
  /** The managed policy file path; `null` when this host has no such path. */
  readonly managedPolicyFile: string | null
  /** The managed delivery cache path; `null` when nothing is delivered here. */
  readonly managedDeliveryCache: string | null
  /**
   * P6.246(c) — whether the organisation's remote policy arrived, in one
   * sentence: loaded / fetch failed with the cause AND what still applies /
   * nothing configured / skipped. `null` only when this host could not resolve
   * a delivery state at all — "nothing configured" is a real answer and is
   * carried as text, not as a null.
   */
  readonly managedDeliveryOutcome: string | null
  /**
   * The raw cause of the last failed delivery fetch; `null` when the last fetch
   * succeeded, when none has run, or when delivery is not configured. Emitted
   * beside the sentence above because a fleet check greps a cause and a person
   * reads a sentence, and deriving one from the other is how they drift.
   */
  readonly managedDeliveryFetchError: string | null
  /** A policy file on disk that the delivered policy shadows — it enforces nothing. */
  readonly managedPolicyFileShadowed: boolean
  /**
   * `managed-settings.md#invalid-entries-in-managed-settings` — every invalid
   * managed entry with its source and field.
   */
  readonly invalidManagedEntries: ConfigDoctorInputV1['drops']
  /** Strict-tier user/project/local layers rejected whole. Empty is "none rejected". */
  readonly rejectedSettingsLayers: NonNullable<ConfigDoctorInputV1['rejectedLayers']>
  /**
   * `settings-reference.md#availablemodels` and `#enforceavailablemodels`.
   * `null` distinguishes "no allowlist" from a
   * deployed `[]`, which admits no named model — the two states a restricted
   * user's ticket cannot tell apart.
   */
  readonly availableModels: NonNullable<ConfigDoctorInputV1['availableModels']> | null
  /** Whether the allowlist above is enforced. */
  readonly enforceAvailableModels: boolean
  /**
   * The sandbox egress decision every sandboxed command runs under. `null`
   * across these four fields means no sandbox network policy could be resolved
   * on this host — not that egress is unrestricted.
   */
  readonly sandboxEgress:
    NonNullable<ConfigDoctorInputV1['sandboxNetwork']>['enforcement']['egress'] | null
  /** Which setting produced {@link sandboxEgress}; `null` as above. */
  readonly sandboxEgressSource:
    NonNullable<ConfigDoctorInputV1['sandboxNetwork']>['enforcement']['source'] | null
  /** The composed allow list; `null` as above. */
  readonly sandboxAllowedDomains:
    NonNullable<ConfigDoctorInputV1['sandboxNetwork']>['settings']['allowedDomains'] | null
  /** The composed deny list; `null` as above. */
  readonly sandboxDeniedDomains:
    NonNullable<ConfigDoctorInputV1['sandboxNetwork']>['settings']['deniedDomains'] | null
  /**
   * The scriptable half of the same question the text section answers:
   * non-empty means an administrator's `sandbox.network` entries do not bind a
   * sandboxed command, which is the state a fleet check should fail on. Empty,
   * never `null`: an unresolvable policy has no unenforceable rules to report.
   */
  readonly unenforceableDomainRules:
    NonNullable<ConfigDoctorInputV1['sandboxNetwork']>['enforcement']['unenforceable']
  /**
   * `settings-reference.md#cleanupperioddays`, and the pause it can cause,
   * `claude-directory.md#cleaned-up-automatically`. The scriptable form of the
   * pause: a fleet check that
   * sees `paused` knows transcripts are piling up on that machine because a
   * settings file cannot be read. `null` across these four fields means
   * retention could not be resolved at all.
   */
  readonly retentionState: NonNullable<ConfigDoctorInputV1['retention']>['state'] | null
  /** The window in days; `null` when unresolved OR when the sweep would not run. */
  readonly retentionDays: number | null
  /** Which tier supplied the window; `null` as above. */
  readonly retentionSource: NonNullable<ConfigDoctorInputV1['retention']>['source'] | null
  /** The sentence explaining a pause or an unexpected disable; `null` when there is none. */
  readonly retentionWarning: string | null
  /**
   * The scriptable half of the accepted-without-effect section (P6.710): the
   * documented `sandbox.*` keys this machine's settings carry and this product
   * carries nowhere, dotted and sorted. Empty means the block names none of
   * them; `null` means the config could not be read at all, which is a
   * different answer and must not be reported as "none".
   */
  readonly acceptedUncarriedSandboxKeys: readonly string[] | null
  /**
   * The scriptable half of the force-enabled section: a non-empty list means an
   * administrator's mandate is doing nothing on that machine. `null` means the
   * registry could not be read, which is a different answer from "every mandate
   * is fulfilled".
   */
  readonly unfulfilledPluginMandates: readonly string[] | null
  /**
   * Each entry is a definition the runtime will SKIP at send time. `null` means
   * the agents directory could not be read, which is a different answer from
   * "every definition is valid".
   */
  readonly invalidAgentDefinitions: readonly AgentDefinitionFindingV1[] | null
  /**
   * `null` means the resolver could not be consulted; a null `ripgrepPath`
   * INSIDE a present object means it was consulted and found nothing, which is
   * the state that leaves session search unavailable on this host. Not a
   * finding: the exit code gates a policy push, and this is machine-local
   * tooling.
   */
  readonly searchBackend: {
    readonly ripgrepPath: string | null
    readonly isPackaged: SearchBackendDoctorInputV1['isPackaged']
  } | null
  /**
   * P2.381. A stated posture, not a finding — it never moves the exit code.
   * `disabledBy` is what a fleet check asserts on: an empty or changed value
   * means the build stopped disabling codex's phone-relay transport, which is a
   * fleet-level question rather than a machine one. Never `null`: it describes
   * the build, which is always known.
   */
  readonly codexRemoteControl: {
    readonly disabledBy: string
    readonly defaultWithoutIt: string
  }
  /**
   * P6.404. A stated posture too, and for the same reason: it describes the
   * codex binary this build ships, not this machine. A fleet check asserts on
   * `listed` staying false — the day it flips, the host has gained a roster
   * that can see them. Never `null`, as above.
   */
  readonly codexBundledSkills: {
    readonly listed: boolean
    readonly gated: boolean
    readonly path: string
    readonly entryCount: number
    readonly notableSkill: string
    readonly reason: string
  }
  /**
   * P6.398. The scriptable half of the trim proposal, and NOT a finding:
   * `memory.md` frames 200 lines as guidance, while this exit code gates a
   * policy push. `null` means the working directory could not be read. A fleet
   * check that wants the rule can apply it itself — the line counts are here —
   * rather than having it applied to its exit code.
   */
  readonly projectInstructionFiles: readonly InstructionFileFindingV1[] | null
  /**
   * P6.255 (c). `null` means the chain could not be resolved on this host,
   * which is a different answer from a resolved chain with nothing configured.
   * A fleet check reads `caWarning` and `clientCertificateError`: those two are
   * the legs that move the exit code, because they are settings the operator
   * wrote which do not bind as written.
   */
  readonly networkTrust: NetworkTrustDoctorInputV1 | null
  /**
   * DA1.34. The shared Nessy Gateway credential's state and the CODE a re-mint
   * would report for it — never the token, only its length. `null` means the
   * collector declined to look, which on this field cannot happen today: the
   * collector always answers, and an absent file is the value `absent` rather
   * than a null. A fleet check reads `reMintReason`, which is the leg that moves
   * the exit code for anything but `ok`.
   */
  readonly gatewayAuth: GatewayAuthDoctorInputV1 | null
  /**
   * P6.477. A stated posture, never a finding. A fleet check that wants every
   * host to answer the same way reads `maxChars` and `unreadSettingKeys`;
   * `envValue` is the one per-host value, and it is `null` when the variable is
   * unset — the only null in this object that means "not set" rather than
   * "could not look".
   */
  readonly skillListingBudget: {
    readonly maxChars: number
    readonly envVar: string
    readonly envValue: string | null
    readonly unreadSettingKeys: readonly string[]
    readonly reason: string
  }
  /**
   * P6.493's user scope — the safety judge as this machine's own settings file
   * writes it. A PROJECTION of {@link UserScopeAutoModeReadV1}, not the read
   * itself, for two reasons: that record's `policy` is optional, and a key
   * `JSON.stringify` drops would break this shape's no-optional-fields rule;
   * and the deny patterns a developer wrote are file CONTENT, which the text
   * section does not print either — `applied` names the keys, not their values.
   *
   * `refusedKeys` is what a fleet check asserts on: non-empty means that file
   * carries a managed-only key (`allow`/`environment`) which did nothing. Not a
   * finding, and deliberately — the exit code gates a policy push, and this is
   * a fault on the desk reading the report, the same call the text section
   * makes.
   *
   * `null` means the file could not be consulted at all. A file that simply
   * carries no `autoMode` block is the OTHER answer: a present object with an
   * empty `applied`.
   */
  readonly userAutoMode: {
    readonly file: string
    readonly applied: readonly string[]
    readonly refusedKeys: readonly string[]
    /** Why the block was refused wholesale; `null` when it was not. */
    readonly invalidReason: string | null
  } | null
  /**
   * P6.878 — every value `config.json` carries that the schema refused, and so
   * never took effect. `null` means the validator could not be consulted; a
   * present object with an empty `issues` is the other answer, "it ran and
   * refused nothing".
   *
   * Not a finding, for the reason above and for one more that is measured:
   * `validateConfig()` answers "Config file does not exist" on a machine that
   * has not run setup, so moving the exit code here would fail the
   * pre-deployment fleet check {@link runDoctor} quotes on every fresh install.
   */
  readonly storedConfigValidation: StoredConfigValidationDoctorInputV1 | null
  /**
   * P6.824 — the six settings with no in-app control, each with the value in
   * force, whether a file supplied it, and where it is set. `null` means the
   * collector could not look; there is no empty-array answer, because the list
   * is a fixed family rather than a search result.
   *
   * Not a finding: every row is a legitimate configuration, including the
   * defaults. A machine on which nothing has been set is the ordinary one.
   */
  readonly configOnlySettings: readonly ConfigOnlySettingV1[] | null
  /** The scriptable form of the exit code: true when the exit code is 1. */
  readonly hasFindings: boolean
}

export interface DoctorResult {
  readonly text: string
  /** Non-zero when the checkup found something to act on. */
  readonly exitCode: number
}

/**
 * Run the checkup and render it. Pure with respect to process state — the
 * caller decides what to print and what to exit with.
 *
 * The exit code is the scriptable half of
 * `server-managed-settings.md#invalid-entries-in-delivered-settings`'s "on a test
 * machine before rolling it out to the organization": a policy push can be gated in CI on this
 * command returning 0, which is not something a human-readable report affords.
 */
export function runDoctor(options: DoctorOptions = {}): DoctorResult {
  const collected = (options.collect ?? collectConfigDoctorInput)()
  const mandatedPlugins = (options.collectMandatedPlugins ?? collectMandatedPluginFindingsHere)()
  const agentDefinitions = (options.collectAgentDefinitions ?? collectAgentDefinitionFindings)()
  const searchBackend = (options.collectSearchBackend ?? collectSearchBackendInput)()
  const instructionFiles = (options.collectInstructionFiles ?? collectInstructionFileFindings)()
  const networkTrust = (options.collectNetworkTrust ?? collectNetworkTrustInput)()
  const gatewayAuth = (options.collectGatewayAuth ?? collectGatewayAuthInput)()
  const sandboxUncarriedKeys =
    (options.collectUncarriedSandboxKeys ?? collectUncarriedSandboxKeys)()
  const userAutoMode = (options.collectUserAutoMode ?? collectUserAutoModeInput)()
  const storedConfigValidation =
    (options.collectStoredConfigValidation ?? collectStoredConfigValidationInput)()
  const configOnlySettings =
    (options.collectConfigOnlySettings ?? collectConfigOnlySettings)()
  const input = {
    ...collected,
    ...(mandatedPlugins === undefined ? {} : { mandatedPlugins }),
    ...(agentDefinitions === undefined ? {} : { agentDefinitions }),
    ...(searchBackend === undefined ? {} : { searchBackend }),
    ...(instructionFiles === undefined ? {} : { instructionFiles }),
    ...(networkTrust === undefined ? {} : { networkTrust }),
    ...(gatewayAuth === undefined ? {} : { gatewayAuth }),
    ...(sandboxUncarriedKeys === undefined ? {} : { sandboxUncarriedKeys }),
    ...(userAutoMode === undefined ? {} : { userAutoMode }),
    ...(storedConfigValidation === undefined ? {} : { storedConfigValidation }),
    ...(configOnlySettings === undefined ? {} : { configOnlySettings }),
  }
  const report = buildConfigDoctorReport(input)
  if (options.json) {
    // Every field's null-vs-absent convention lives on `DoctorJsonReportV1`,
    // once, and this object is typed against it — so a field added here without
    // its convention does not compile, and `doctor.test.ts` fails the day the
    // emitted key set and the type disagree (P6.640). What follows is wiring.
    const json: DoctorJsonReportV1 = {
      managedSource: input.winner,
      managedPolicyFile: input.filePath ?? null,
      managedDeliveryCache: input.deliveryCachePath ?? null,
      managedDeliveryOutcome: input.delivery === undefined
        ? null
        : describeManagedDeliveryOutcome(input.delivery),
      managedDeliveryFetchError: input.delivery?.fetchError?.cause ?? null,
      managedPolicyFileShadowed: input.winner === 'delivered' && input.fileCarriesSettings,
      invalidManagedEntries: input.drops,
      rejectedSettingsLayers: input.rejectedLayers ?? [],
      availableModels: input.availableModels ?? null,
      enforceAvailableModels: input.enforceAvailableModels ?? false,
      sandboxEgress: input.sandboxNetwork?.enforcement.egress ?? null,
      sandboxEgressSource: input.sandboxNetwork?.enforcement.source ?? null,
      sandboxAllowedDomains: input.sandboxNetwork?.settings.allowedDomains ?? null,
      sandboxDeniedDomains: input.sandboxNetwork?.settings.deniedDomains ?? null,
      unenforceableDomainRules: input.sandboxNetwork?.enforcement.unenforceable ?? [],
      retentionState: input.retention?.state ?? null,
      retentionDays: input.retention?.retentionDays ?? null,
      retentionSource: input.retention?.source ?? null,
      retentionWarning: input.retention?.warning ?? null,
      unfulfilledPluginMandates: mandatedPlugins === undefined
        ? null
        : mandatedPlugins.filter(finding => finding.state === 'not-installed').map(finding => finding.pluginKey),
      invalidAgentDefinitions: agentDefinitions === undefined ? null : agentDefinitions,
      searchBackend: searchBackend === undefined
        ? null
        : { ripgrepPath: searchBackend.ripgrepPath ?? null, isPackaged: searchBackend.isPackaged },
      codexRemoteControl: {
        disabledBy: `${CODEX_REMOTE_CONTROL_DOCTOR.env}=${CODEX_REMOTE_CONTROL_DOCTOR.value}`,
        defaultWithoutIt: CODEX_REMOTE_CONTROL_DOCTOR.defaultWithoutIt,
      },
      codexBundledSkills: {
        listed: false,
        gated: false,
        path: CODEX_BUNDLED_SKILLS_DOCTOR.path,
        entryCount: CODEX_BUNDLED_SKILLS_DOCTOR.entryCount,
        notableSkill: CODEX_BUNDLED_SKILLS_DOCTOR.notableSkill,
        reason: CODEX_BUNDLED_SKILLS_DOCTOR.reason,
      },
      acceptedUncarriedSandboxKeys: sandboxUncarriedKeys === undefined ? null : sandboxUncarriedKeys,
      projectInstructionFiles: instructionFiles === undefined ? null : instructionFiles,
      networkTrust: networkTrust ?? null,
      gatewayAuth: gatewayAuth ?? null,
      skillListingBudget: {
        maxChars: SKILL_LISTING_BUDGET_DOCTOR.maxChars,
        envVar: SKILL_LISTING_BUDGET_DOCTOR.envVar,
        envValue: process.env[SKILL_LISTING_BUDGET_DOCTOR.envVar] ?? null,
        unreadSettingKeys: SKILL_LISTING_BUDGET_DOCTOR.unreadSettingKeys,
        reason: SKILL_LISTING_BUDGET_DOCTOR.reason,
      },
      userAutoMode: userAutoMode === undefined
        ? null
        : {
          file: userAutoMode.path,
          applied: userAutoMode.policy === undefined ? [] : Object.keys(userAutoMode.policy),
          refusedKeys: userAutoMode.refusedKeys,
          invalidReason: userAutoMode.invalidReason ?? null,
        },
      storedConfigValidation: storedConfigValidation ?? null,
      // P6.824 — carried whole. Every field is already a string or a two-member
      // union the renderer only clamps, so the JSON form and the text form
      // cannot disagree about what is in force.
      configOnlySettings: configOnlySettings?.settings ?? null,
      hasFindings: report.hasFindings,
    }
    return {
      text: JSON.stringify(json, null, 2),
      exitCode: report.hasFindings ? 1 : 0,
    }
  }
  return {
    text: `${report.text.replace(/\s*$/, '')}\n\n${codexRemoteControlSection()}\n\n${codexBundledSkillsSection()}`
      + `\n\n${skillListingBudgetSection()}\n`,
    exitCode: report.hasFindings ? 1 : 0,
  }
}
