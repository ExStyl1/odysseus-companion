/**
 * `configRequirements/read` — the codex half of the one managed floor (P2.7).
 *
 * ## What the method is
 *
 * A codex app-server deployment can ship a `requirements.toml`; the app-server
 * exposes what it read through `configRequirements/read`, whose result is
 * `{ requirements: ConfigRequirements | null }`. The entries this product has a
 * consumer for are the TWO host-facing `[features]` keys — both a count that has
 * moved, so read {@link CODEX_HOST_FACING_FEATURE_KEYS} rather than this
 * sentence. `in_app_updates`, which
 * `learn.chatgpt.com/docs/enterprise/manage-app-updates.md#turn-off-in-app-updates`
 * makes the same policy as our own `disableInAppUpdates`, so a codex-managed
 * fleet turns off the desktop host's in-app updater without a second document;
 * and, since P2.463, `in_app_browser`, whose gate is
 * `config/managed-in-app-browser.ts` plus
 * `apps/electron/src/main/browser-pane-manager.ts`.
 *
 * ## The bindings lag the binary, so the binary was probed
 *
 * `packages/codex-protocol/generated` already carries `configRequirements/read`
 * on `ClientRequest` and the `ConfigRequirements` type — but generated bindings
 * are a snapshot and the shipped binary is the contract, so the binary was
 * measured directly (2026-08-24,
 * `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`):
 *
 * | probe | hits |
 * | --- | --- |
 * | `configRequirements/read` | 4 |
 * | `in_app_updates` | 3 |
 * | `thread/start` (positive control) | 15 |
 * | `nessyNonexistentMethod/read` (negative control) | 0 |
 *
 * The rig is valid (control non-zero, negative control zero) and the method
 * and the feature key are both in the binary this app ships.
 *
 * ## Protocol drift is the normal case, not the exception
 *
 * A probe of an optional method must degrade, never throw: the app-server is a
 * separately-versioned binary and an older or newer one may not answer.
 * {@link probeCodexConfigRequirements} therefore catches everything, writes one
 * debug line, and returns the "nothing was said" reading. It also distinguishes
 * a DEFINITIVE refusal from a transient failure using the JSON-RPC error code
 * `AppServerClient` preserves on the rejection — that distinction is the whole
 * reason the code is carried, and this is its first consumer.
 *
 * ## Degrading is not enough if the server never answers at all — P2.138
 *
 * "Catches everything" only covers a server that SAYS something. One that
 * ignores the method says nothing, and `AppServerClient.request` settles a
 * pending entry on exactly two events: a matching response, or `close()`. On
 * this path `close()` is unreachable — `CodexAgent` does not assign the client
 * to `this.client` until AFTER this probe returns (`codex-agent.ts:906`, probe
 * at `:842`) and `teardownRuntime` closes `this.client` (`:3059`) — so the
 * spawn would hang between `initialized` and `thread/start` with no status, no
 * error and no way to stop it. A hang is the WORSE failure precisely because
 * this module's contract is to degrade: a throw is visible, a hang is not.
 * {@link CODEX_CONFIG_REQUIREMENTS_TIMEOUT_MS} bounds it, and a bounded probe
 * takes the ordinary `'failed'` path — one diagnostic line naming the method
 * and the bound, and the runtime carries on to `thread/start`.
 *
 * ## Unsupported keys are surfaced, never dropped in silence
 *
 * This product applies the two `[features]` keys named above and no other wire
 * field. The rest are not ignored: every field
 * the server actually SENT is reported by
 * {@link formatCodexConfigRequirementsDiagnostics}, so an administrator who
 * deployed `allowedSandboxModes` sees what happened to it rather than believing
 * a policy is in force that is not. SENT, not SET — P6.247 measured ten whole
 * requirement families `requirements.toml` accepts and this method never
 * carries, and the same formatter now names them
 * ({@link CODEX_UNREPORTED_REQUIREMENT_FAMILIES}) so that their silence cannot
 * be read as compliance. `checkForUpdateOnStartup` is the sharpest of
 * these — it is update-adjacent but NARROWER than `in_app_updates` (no startup
 * check, manual check still allowed), and folding it into the all-or-nothing
 * gate would enforce more than the administrator asked for.
 *
 * ## P6.6 — "read and discarded" was ONE bucket, and it was wrong for most of it
 *
 * The line this module used to print — `read but NOT applied: <names>` — said
 * the same thing about a requirement codex enforces itself and a requirement
 * nobody enforces at all. Those are different facts and only one of them is a
 * gap. {@link CODEX_REQUIREMENT_ENFORCEMENT} separates them, measured against
 * codex's own source at the tag we ship rather than assumed, and the diagnostics
 * now name four buckets instead of one — P3.239 split the residue again once the
 * four fields in it were measured one at a time, and only ONE of them turned out
 * to describe something this build could have applied.
 *
 * ## P2.373 — the same defect had survived inside the `[features]` fallback
 *
 * Splitting the wire fields left the open-ended `[features]` table answering
 * `'codex'` for everything it did not recognise, and `'codex'` prints as *"the
 * administrator's policy IS in force"*. `in_app_browser` — *"Disable the desktop
 * app's built-in browser"* — took that answer while nothing in this tree gates a
 * browser at all. {@link CODEX_HOST_FACING_FEATURE_KEYS} carries the measurement
 * and the exception.
 *
 * ## P2.399/P2.463 — and then the control was BUILT, so the report moved again
 *
 * P2.373's honest sentence (*"this build has NO gate on its built-in browser …
 * treat the built-in browser as UNRESTRICTED on this deployment"*) was true for
 * exactly as long as that was true. P2.399 built the gate —
 * `config/managed-in-app-browser.ts` plus
 * `apps/electron/src/main/browser-pane-manager.ts`, which refuses to open a pane
 * and closes one already open — and left the codex INPUT tier armed and unfed
 * because `agent/codex-agent.ts` was a different file zone. P2.463 bound it.
 *
 * So `in_app_browser` is now verdicted `'nessy'`, honoured beside its twin, and
 * the diagnostic names both spellings of the one switch instead of announcing an
 * absent control. **The re-verdict had to travel with the binding**: `'client'`
 * prints as *"ENFORCED BY NOBODY"*, so a bound gate with an unmoved verdict
 * would tell an administrator their browser policy is unenforced while the pane
 * refuses to open — P2.373's defect with the sign flipped.
 */

/** The optional method this module probes. */
export const CODEX_CONFIG_REQUIREMENTS_METHOD = 'configRequirements/read'

/**
 * The `[features]` key that maps onto our `disableInAppUpdates`. Spelled here as
 * well as in `config/managed-in-app-updates.ts` would be a key spelled twice, so
 * it is imported from there instead.
 */
export { CODEX_IN_APP_UPDATES_FEATURE_KEY } from '../config/managed-in-app-updates.ts'
import { CODEX_IN_APP_UPDATES_FEATURE_KEY } from '../config/managed-in-app-updates.ts'

/**
 * `[features] in_app_browser` — *"Disable the desktop app's built-in browser"*.
 *
 * Declared HERE until P2.463, on the ground that "unlike its twin, this build has
 * no consumer to import it from" — the whole finding of P2.373. P2.399 built the
 * consumer and P2.463 bound it, so the constant moved to
 * `config/managed-in-app-browser.ts` beside `MANAGED_IN_APP_BROWSER_KEY` and is
 * re-exported from here, which is exactly the twin's arrangement one line above.
 *
 * `MANAGED_IN_APP_BROWSER_KEY` is imported rather than re-exported because it is
 * the HOST spelling: this module only ever prints it, so the diagnostic can name
 * both halves of one switch, and a reader looking for the host key should find it
 * in the module that owns the host tier.
 */
export { CODEX_IN_APP_BROWSER_FEATURE_KEY } from '../config/managed-in-app-browser.ts'
import {
  CODEX_IN_APP_BROWSER_FEATURE_KEY,
  MANAGED_IN_APP_BROWSER_KEY,
} from '../config/managed-in-app-browser.ts'
/** `[features] in_app_local_automation` — D1.205, and owned by its own module
 *  for the two keys above's reason: a key spelled twice eventually disagrees. */
export { CODEX_LOCAL_AUTOMATION_FEATURE_KEY } from '../config/managed-local-automation.ts'
import { CODEX_LOCAL_AUTOMATION_FEATURE_KEY } from '../config/managed-local-automation.ts'

/**
 * The `[features]` keys whose SUBJECT is the desktop host rather than codex —
 * P2.373.
 *
 * ## What was wrong
 *
 * `classifyCodexRequirementField` used to answer `'codex'` for every
 * `featureRequirements.*` key except `in_app_updates`, and `'codex'` is a
 * CLAIM: {@link formatCodexConfigRequirementsDiagnostics} prints it as
 * *"enforced by the codex app-server itself, so Nessy does not re-implement
 * them"*. For a key naming a codex subsystem that is true. For a key naming
 * something the desktop app owns it is a false assurance — the administrator is
 * told a security decision is in force, and no part of the system enforces it.
 * An unenforced control an operator believes is enforced is worse than an
 * absent one, because only the absent one gets noticed.
 *
 * ## Evidence — STRONG tier, read from the source at the tag we ship
 *
 * `github.com/openai/codex` at **`rust-v0.150.1`**,
 * `codex-rs/features/src/lib.rs`, the `FEATURES` registry entries
 * `Feature::InAppBrowser` (key `in_app_browser`) and `Feature::InAppUpdates`
 * (key `in_app_updates`): both are still `Stage::Stable, default_enabled: true`
 * and structurally identical, which is the whole of what this evidence needs.
 * One word of it is RETIRED rather than re-stamped — they were adjacent in the
 * registry when this was written and they are not any more, with `in_app_chat`
 * and `in_app_dictation` between them, so the argument now rests on the two
 * entries being identical in SHAPE and not on where they sit. Neither appears
 * in `codex-rs/features/src/feature_configs.rs` (`grep -c 'InApp'` → 0 over its
 * 458 lines at the new tag; the registry entries above are the positive control
 * that the names are real), so neither carries the title/description a
 * codex-owned `/experimental` feature carries. `ManagedFeatures` (`core/src/config/managed_features.rs`)
 * pins the FLAG, and pinning a flag is not enforcing the thing the flag names.
 *
 * The twin settles it. This repo already measured that a codex-managed fleet
 * disabling `in_app_updates` is asking the DESKTOP HOST to stop updating —
 * that is why it is `'nessy'` and why `managed-in-app-updates.ts` exists.
 * `in_app_browser` asks the same host to stop opening its built-in browser, and
 * that browser is `apps/electron/src/main/browser-pane-manager.ts`, which codex
 * cannot reach from inside its own process.
 *
 * ## The verdict was `'client'` while nothing enforced it, and is `'nessy'` now
 *
 * P2.373 verdicted it `'client'` — this module's word for "only the client could
 * apply it and this build does not" — and that was measured, not assumed:
 * `git grep -lI 'in_app_browser'` matched documentation and
 * `packages/codex-protocol/schema/config-schema.json` and **no TypeScript file
 * at all**, against a positive control (`approvals_reviewer`, fourteen files
 * including six under `packages/`) on the same rig, with `disableInAppBrowser`,
 * `browserDisabled` and `browserEnabled` all at zero.
 *
 * That row named what closing it would take — "a host consumer beside
 * `managed-in-app-updates.ts` plus a gate in the Electron main process". Both
 * exist: `config/managed-in-app-browser.ts` and the gate in
 * `apps/electron/src/main/browser-pane-manager.ts`, which refuses to open a pane
 * and closes one already open, with P2.463 binding the codex input tier from
 * `agent/codex-agent.ts`. The key is therefore `'nessy'`, on the twin's exact
 * terms: this product applies it, so `readCodexConfigRequirements` pushes it onto
 * `honoured` and the `[features]` loop never pushes it onto `unsupported`.
 *
 * **The re-verdict is not bookkeeping.** `'client'` prints as *"ENFORCED BY
 * NOBODY — codex publishes these for its client to apply and this build does
 * not"*. Leaving it there beside a working gate would tell an administrator their
 * browser policy is unenforced while the pane refuses to open, which is P2.373's
 * false assurance with the sign reversed and just as unactionable. Both
 * directions are pinned in `__tests__/codex-config-requirements.test.ts`.
 *
 * ## I2.24 — the family is SIX, not two, and three of them were answering
 * `'codex'` by default (read at `rust-v0.154.0`, 2026-09-17)
 *
 * The argument above rests on the two entries being identical in SHAPE to each
 * other. Read at the new tag, FIVE are: `codex-rs/features/src/lib.rs`
 * declares `InAppBrowser`, `InAppChat`, `InAppDictation`,
 * `InAppLocalAutomation` and `InAppUpdates` consecutively, every one
 * `Stage::Stable, default_enabled: true`, every one carrying the same two doc
 * lines — *"… in desktop apps"* and *"Requirements-only gate: this should be
 * set from requirements, not user config"*. The denominator is not a guess
 * either: `grep -c 'desktop app'` over that file is **6** — those five plus
 * `BrowserUse` — so codex itself names exactly which of its 149 `[features]`
 * keys have the DESKTOP HOST as their subject.
 *
 * Three of the five had no entry here, so `classifyCodexRequirementField`
 * answered them `'codex'` from its default — the exact false assurance this
 * constant exists to prevent, on keys codex's own doc says are for the host.
 * Each gets the verdict its SUBJECT earns, which is not the same verdict:
 *
 *  - **`in_app_chat` → `'client'`.** The subject is present and unmistakable:
 *    this product's composer IS an in-app chat pane. Nothing reads the key, so
 *    a fleet disabling it changes nothing here, and `'client'` is this module's
 *    word for exactly that — *"only the client can, and this build does not"*.
 *    Deliberately NOT `'nessy'`: that would claim a gate that does not exist,
 *    which is `in_app_browser`'s own history read backwards.
 *  - **`in_app_dictation` → `'inapplicable'`.** The subject is ABSENT: over
 *    `packages apps`, `dictation`, `microphone` and `speech-to-text` match no
 *    file outside this module's own prose and `managed-in-app-browser.ts`'s.
 *    There is no dictation to disable, so there is nothing for a client to
 *    apply — the stated non-application this enum's fourth member is for.
 *  - **`in_app_local_automation` → `'nessy'` since D1.205.** Both halves of
 *    `packages/shared/src/automations/` are gated — see that row's module.
 *
 * **D1.204 — `browser_use` is the SIXTH, and it is `'inapplicable'`.** I2.24 left
 * it out and recorded the inconsistency instead of resolving it: the same
 * subject answered `'inapplicable'` as a FIELD (`ConfigRequirements.browserUse`,
 * the table below) and `'codex'` as a FEATURE KEY, by default, with a test
 * pinning the default. One subject in two buckets of one report is the defect
 * `in_app_browser`'s own history is about, so it is closed here, toward
 * `'inapplicable'`, on four readings taken at `rust-v0.154.0` — the tag of the
 * binary in `apps/electron/resources/bin/codex/`:
 *
 *  1. **The doc line names the desktop app as the subject.** `BrowserUse` in
 *     `features/src/lib.rs` reads *"Allow Browser Use agent integration in
 *     desktop apps."* plus the same *"Requirements-only gate: this should be set
 *     from requirements, not user config"* the five `InApp*` entries carry. It
 *     is the sixth and last hit of `grep -c 'desktop app'` over that file.
 *  2. **The subject is absent from a codex session here**, which is what
 *     separates `'inapplicable'` from `'client'`, and it is the SAME absence the
 *     field twin already cites: P6.27 measured four missing pieces and pinned
 *     the refutation in
 *     `session-tools-core/src/browser-tool-codex-projection.test.ts`.
 *  3. **`ManagedFeatures` applying the key is not sufficient for `'codex'` in
 *     this table**, and this constant already decided that five times: every key
 *     here rides the same `from_configured_with_warnings` path and none of them
 *     is `'codex'`.
 *  4. **What the report would otherwise say.** `'codex'` prints as *"enforced by
 *     the codex app-server itself, so Nessy does not re-implement them"* about a
 *     gate whose consumer is the desktop host — P2.373's *"FALSE ASSURANCE about
 *     a control nothing enforces"*, in the same words, one key over.
 *
 * **The two siblings keep the `'codex'` default, deliberately.**
 * `BrowserUseFullCdpAccess` (*"access the full Chrome DevTools Protocol
 * surface"*) and `BrowserUseExternal` (*"integration with external browsers"*)
 * describe the integration's own scope and carry NO desktop-app line, so they
 * are outside the six-key denominator codex itself publishes — which is this
 * constant's instrument, not ours. Reclassifying them would mean overruling that
 * instrument, and the argument for it is the weaker one: they are sub-settings
 * of an absent capability, which makes their report inert rather than wrong.
 * Recorded so the next reader meets the choice instead of the asymmetry.
 */
export const CODEX_HOST_FACING_FEATURE_KEYS: Readonly<Record<string, CodexRequirementEnforcer>> =
  Object.freeze({
    [CODEX_IN_APP_UPDATES_FEATURE_KEY]: 'nessy',
    [CODEX_IN_APP_BROWSER_FEATURE_KEY]: 'nessy',
    // I2.24 · host-facing by codex's own doc. See the paragraph above for the
    // per-key reason; the three are NOT one verdict, and D1.205 moved the third.
    in_app_chat: 'client',
    in_app_dictation: 'inapplicable',
    in_app_local_automation: 'nessy',
    // D1.204 · the sixth *"in desktop apps"* entry, and the same subject as
    // `ConfigRequirements.browserUse` below — one verdict, one bucket, one
    // report. See the paragraph above for the four readings.
    browser_use: 'inapplicable',
  })

/**
 * WHO ACTUALLY ENFORCES each `ConfigRequirements` field — P6.6.
 *
 * ## The question this answers
 *
 * "All but one of the managed requirements are read, reported and discarded"
 * describes the diagnostic, not the world. Native-first asks a
 * different question first: does the runtime already have the mechanism, so
 * that our job is to REPORT rather than to implement? For most of these fields
 * it does, and building our own enforcement beside codex's would be the exact
 * duplication the owner rule forbids.
 *
 * ## Evidence — STRONG tier throughout
 *
 * Read from `github.com/openai/codex` at **`rust-v0.150.1`**, the tag shipped
 * when this was read — today's is `manifest.json`'s `upstream.tag` — and
 * cross-checked against that binary's own strings. Paths below are relative to `codex-rs/`. The
 * verdicts below the tag moved under were re-read against the new tag at the
 * 2026-09-11 lift; the five fields the lift ADDED carry their own citations on
 * {@link CODEX_REQUIREMENT_ENFORCEMENT}.
 *
 * Two enforcement machines, both inside codex:
 *
 *  - **`Constrained<T>`** (`config/src/constraint.rs`) — an allowed-set
 *    validator installed from the requirement. `core/src/config/mod.rs:3250`,
 *    `:3854`, `:3877`, `:3883`, `:3906` push the configured value through
 *    `apply_requirement_constrained_value` for `windows.sandbox`,
 *    `approval_policy`, `approvals_reviewer`, `permission_profile` and
 *    `web_search_mode`; a disallowed value is REPLACED by the required one
 *    (`:2089`-`:2100`) and the substitution is announced as a `configWarning`
 *    (`app-server/src/lib.rs:641`-`:647`). `allowed_sandbox_modes` reaches the
 *    same machine indirectly: `config/src/config_requirements.rs:1674`-`:1700`
 *    compiles it into the `permission_profile` validator.
 *  - **`apply_to_config`** (`core/src/config/requirements.rs:12`-`:48`) — exact
 *    overrides written straight over the loaded config, for `sqlite_home`,
 *    `log_dir`, `model_catalog_json`, `check_for_update_on_startup`,
 *    `allow_login_shell`, `feedback` and `windows.sandbox_private_desktop`.
 *
 * Plus three enforcement sites outside both: `allow_remote_control` in
 * `app-server/src/lib.rs:699`-`:709`, `allow_managed_hooks_only` in
 * `hooks/src/engine/discovery.rs:79`-`:113`, `auto_review` in
 * `core/src/session/session.rs:274`-`:290`, and `feature_requirements` in
 * `core/src/config/mod.rs:3220`-`:3226` (`ManagedFeatures::from_configured_with_warnings`).
 *
 * ## The `'client'` verdict, and how it was reached WITHOUT an identifier probe
 *
 * An identifier probe is biased toward false absence, so `'client'` is not
 * "grep found nothing". It is: the field is parsed
 * (`config/src/config_requirements.rs`), composed
 * (`config/src/requirements_layers/stack.rs`), PRINTED by `codex debug config`
 * (`tui/src/debug_config.rs`) and PUBLISHED to the client
 * (`app-server/src/request_processors/config_processor.rs`) — and reaches no
 * fifth file. Positive controls on the identical rig: `allow_remote_control`
 * yields a fifth file that IS enforcement (`app-server/src/lib.rs`) and
 * `allow_managed_hooks_only` yields `hooks/src/engine/discovery.rs`. So the rig
 * detects enforcement where it exists, and the four-file shape means codex hands
 * the field to whoever is driving it. **We are whoever is driving it.**
 *
 * `models` is `'client'` for a second, independent reason: the composed
 * `ConfigRequirements` struct (`config/src/config_requirements.rs:152`-`:184`)
 * has no `models` field at all — `map_requirements_toml_to_api` reads it off the
 * raw TOML — so `core` structurally cannot apply it. Its sibling `auto_review`
 * IS in that struct (`auto_review_required_models`) and IS enforced, which is
 * the control that makes the absence mean something. `browser_use` is absent
 * from that same struct for the same reason; `allow_appshots` and `computer_use`
 * ARE in it and are then explicitly DISCARDED — `core/src/config/mod.rs:3110`-`:3141`
 * opens an exhaustive destructure whose own comment says it exists "to ensure
 * ConfigRequirements additions are either applied above or handled while
 * constructing the final Config", and both arrive there as `_`. That is a
 * stronger proof than a missing file: codex's own completeness guard names them
 * and drops them.
 *
 * ## P3.239 — the four are NOT one fact, and three of them are not a gap
 *
 * P6.6 left "enforced by nobody" as one bucket. Measured field by field at the
 * same tag, only ONE of the four describes something this build could apply and
 * does not. The shapes decide it, and the two the row expected to be capability
 * gates are not gates at all:
 *
 * | field | wire shape | verdict | why |
 * | --- | --- | --- | --- |
 * | `models` | `{ newThread: { model, modelReasoningEffort, serviceTier } }` | `'client'` — **did not** | codex's OWN client implements it: `tui/src/managed_new_thread_defaults.rs` (byte-identical at `rust-v0.150.1`), fed from `tui/src/app_server_session.rs`, applied in `tui/src/app/startup.rs` and `tui/src/app/session_lifecycle.rs`. We are the same kind of client, holding the same answer. |
 * | `allowAppshots` | `boolean` | `'inapplicable'` — **cannot** | the subject exists nowhere in the codex we ship. Re-measured at `rust-v0.150.1`: `appshot` still occurs 3 times in the shipped binary, all of them this field's own plumbing, and the app-server README that documents `browserUse.disableAutoReview`, `computerUse` and `models.newThread` in one sentence (`app-server/README.md:289`) never mentions it. There is no behaviour to permit or refuse, and inventing one is what the read-don't-invent rule forbids. |
 * | `computerUse` | `{ allowLockedComputerUse, allowPersistentApproval, defaultAppAccess, macos, windows }` — it grew from one field to five at `rust-v0.150.1`, and the verdict is unchanged | `'inapplicable'` — **cannot** | still not a gate on computer use: the original field permits computer use to CONTINUE on a locked machine, and the four that joined it are per-platform and per-app settings of the same absent capability. This product has no computer-use capability at all — `computer_use`/`computerUse` occurs 0 times in `packages/shared/src/agent/` outside this table and its test, against 20+ for the positive control `browser_tool` in the same tree. |
 * | `browserUse` | `{ allowHistoryAccess, disableAutoReview, allowGlobalPersistentApproval, defaultOriginPolicy, origins }` — also one field to five at `rust-v0.150.1` | `'inapplicable'` — **cannot, on this build** | still not a gate on browser use: the original field turns auto-review OFF for browser use, and the four that joined it are per-origin settings of the same absent capability. The browser is deliberately unreachable from a codex session — P6.27 measured four missing pieces, one of them a permission gate, and pinned the refutation in `session-tools-core/src/browser-tool-codex-projection.test.ts`. Flips to **did not** the day P3.236 ships that gate, which is why the two rows are sequenced. |
 *
 * So `'client'` meant only the first row until `rust-v0.154.0`, and
 * {@link CodexRequirementEnforcer} `'inapplicable'` carries the other three with
 * their reason attached. Reporting a policy as "enforced by nobody" when the
 * capability it governs is absent is the same defect P6.6 fixed one level up: it
 * tells an administrator that unrestricted browser use is running on a deployment
 * that has no browser use.
 *
 * ## `application` — the SECOND `'client'`, arriving at `rust-v0.154.0` (C3.380 lift 2)
 *
 * It is the fourth field ts-rs drops, and its verdict was read from codex's own
 * source at the tag rather than inferred from its name — which matters here more
 * than usual, because "application requirements" sounds like it might govern the
 * agent and does not.
 *
 * | field | wire shape | verdict | why |
 * | --- | --- | --- | --- |
 * | `application` | `{ network: { enabled, domains: Record<string, NetworkDomainPermission> } \| null }` | `'client'` — **did not** | `codex-rs/config/src/application_requirements.rs` (`ApplicationRequirementsToml`) opens with codex's own two-sentence statement of what it is: *"Managed application destinations are independent of agent network permissions. Enabled policies deny unlisted domains and use normal managed TOML precedence."* So it is an administrator's egress allowlist for the APPLICATION — this desktop client — and deliberately NOT the agent's sandbox network policy, which is the separate `network` field beside it. |
 *
 * **codex enforces nothing here, and that is measured rather than assumed.** The
 * only two files in the tree that name it are the type and its own unit tests
 * (`config/src/application_requirements{,_tests}.rs`); `core/src/config/requirements.rs`
 * `apply_to_config` does not mention it, and the app-server's own suite for it is
 * headed *"Public requirements responses expose managed application policy"*
 * (`app-server/tests/suite/v2/config_requirements_application.rs`), whose cases
 * assert exposure and validation — one is literally named
 * `application_destinations_stay_separate_from_agent_network`. codex parses it,
 * normalises and validates each domain (exact ASCII names, no URLs, ports or
 * wildcards, duplicates after normalisation refused) and PUBLISHES it. Applying
 * it is the client's job.
 *
 * **So this is a real gap and it is reported as one**, which is exactly what
 * `'client'` prints. It is NOT `'inapplicable'`: unlike `computerUse` and its
 * siblings, the subject is present — this application makes network requests of
 * its own — so an administrator who sets it is asking for something this build
 * could do and does not. Closing it is a host egress decision with its own
 * surface (which destinations, and what a refusal looks like to a user), not a
 * requirements-reader change, so it is recorded here and handed on rather than
 * invented at the end of a lift.
 *
 * **D1.168 answered the two questions that row asked, and the answers are: not
 * honoured, and a refusal looks like NOTHING.** Both are now stated where the
 * administrator meets them rather than only here — see
 * {@link CodexManagedApplicationDestinationsV1} for the decision and the two
 * readings behind it, and {@link CODEX_REQUIREMENT_APPLICATION_DESTINATIONS_PREFIX}
 * for the line that carries the domains onto the operator channel. Honouring it
 * for real remains an owner's call about a new product surface; what D1.168
 * refused was the middle state, a partly-applied allowlist that reads as a
 * policy in force.
 *
 * ## Why `models` is REPORTED and not applied — a product posture, stated
 *
 * The reference implementation is right there, and it is not an enforcement.
 * `tui/src/managed_new_thread_defaults.rs:16`-`:18` says so verbatim — "Managed
 * values are defaults rather than enforcement. Preserve explicit launch choices"
 * — and fills `config.model` only when the invocation carried no `-m` and no
 * `-c model=`. That branch has no counterpart here: `BaseAgent` resolves
 * `this._model = config.model || defaultModel` (`base-agent.ts:1140`), so a
 * codex thread ALWAYS starts with a resolved model and there is no unset slot to
 * fill. Applying the requirement here would therefore be strictly stronger than
 * codex itself is — it would move a session off the model the picker shows,
 * silently, which is the exact defect P6.7 had just finished making audible.
 *
 * So the requirement is named with its VALUE instead
 * ({@link CodexConfigRequirementsReadingV1.managedNewThreadDefaults}), and an
 * operator can see the administrator's default and what the session actually
 * ran. Closing it for real is a connection-layer decision — distinguishing "the
 * user picked this model" from "the connection defaulted to it" — and belongs to
 * whoever owns that layer, not to a requirements reader.
 *
 * ## FOUR fields the generated bindings do not know about
 *
 * `allowedApprovalsReviewers`, `hooks`, `network` and — since `rust-v0.154.0` —
 * `application` are `#[experimental(…)]` on
 * `codex-rs/app-server-protocol/src/protocol/v2/config.rs` (`ConfigRequirements`),
 * so ts-rs leaves them out of `schema/typescript/v2/ConfigRequirements.ts` —
 * which is why `packages/codex-protocol/generated/v2/ConfigRequirements.ts` lists
 * twenty-seven fields and the Rust struct lists thirty-one. `CodexAgent` sends
 * `capabilities: { experimentalApi: true }`, none of the fields carry
 * `skip_serializing_if`, and all four names are in the shipped binary. Re-measured
 * 2026-09-13 on the `rust-v0.154.0` binary (171 099 968 bytes, self-reporting
 * `codex-app-server 0.154.0`), instrument `grep -aoF … | wc -l` (OCCURRENCES):
 * `configRequirements/read.` 4, each of the four gate strings 1, bare
 * `allowedApprovalsReviewers` 5; positive control `thread/start` 18, negative
 * controls `configRequirements/read.nessyNotAField` and
 * `nessyNonexistentMethod/read` both 0. So they can arrive here, and they are
 * classified rather than left to fall into the unknown bucket.
 *
 * **This section said THREE until 2026-09-13, and a lift moved it rather than a
 * reader.** The paragraph below closes by promising that a FOURTH experimental
 * field added upstream cannot be dropped silently. One arrived at
 * `rust-v0.154.0`, the probe went red on it, and that is the only reason
 * `application` is classified below instead of reaching an administrator as a
 * field this build has never heard of. The promise is now made about a fifth.
 *
 * ### P6.77 — the attribute has TWO forms and only one of them drops (source, `rust-v0.150.1`)
 *
 * The sentence above says `#[experimental(…)]`, which reads as *experimental
 * implies dropped*. Read at the tag the shipped binary is built from, that is
 * not the rule, and the counter-example is in the same struct:
 * `allowed_approval_policies` carries `#[experimental(nested)]`
 * (`app-server-protocol/src/protocol/v2/config.rs`, `struct ConfigRequirements`)
 * and IS in the generated bindings. What ts-rs drops is the **string** form —
 * the four fields of that same struct whose attribute names an experimental
 * gate verbatim, re-read there at `rust-v0.154.0`:
 *
 * - `allowed_approvals_reviewers` · `#[experimental("configRequirements/read.allowedApprovalsReviewers")]`
 * - `hooks` · `#[experimental("configRequirements/read.hooks")]`
 * - `network` · `#[experimental("configRequirements/read.network")]`
 * - `application` · `#[experimental("configRequirements/read.application")]` — NEW at `rust-v0.154.0`
 *
 * That literal is what makes the drop AUDIBLE from here, and it is the whole
 * reason {@link CODEX_EXPERIMENTAL_REQUIREMENT_GATES} exists: the gate string is
 * compiled into the shipped `codex-app-server` byte for byte, so the set of
 * `configRequirements/read.` occurrences in that binary IS the set of fields
 * ts-rs dropped. Re-measured 2026-09-13 on
 * `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`
 * (171 099 968 bytes, self-reporting `0.154.0`): the prefix occurs **exactly
 * four** times, once per gate above; negative control
 * `configRequirements/read.nessyNotAField` 0, positive control `thread/start`
 * 18. Count the OCCURRENCES (`grep -aoF … | wc -l`), not the lines a `-c` reports
 * — all four gate strings sit on one binary "line" and `grep -c` answers 1. And
 * use `-F` rather than a character class: `grep -aoE 'configRequirements/read\.[A-Za-z0-9_]+'`
 * runs the packed string table together and answers TWO on the same bytes, which
 * is how the fourth name nearly went unread while the COUNT was already right.
 *
 * **This build cannot make the four fields appear in the generated bindings** —
 * regenerating from the same upstream reproduces the same drop, because the
 * attribute is upstream's, and the `rust-v0.154.0` regeneration proved it: the
 * bindings' `ConfigRequirements.ts` came back BYTE-IDENTICAL while the struct had
 * grown a field. So the honest close is: the absence is recorded here with the
 * upstream attribute as its reason, and a **fifth** experimental field added
 * upstream cannot be dropped silently — its gate string raises the binary count
 * to five and `codex-config-requirements.test.ts`'s probe goes red.
 *
 * ## What is NOT claimed
 *
 * A `'codex'` verdict says codex enforces the requirement **against its own
 * configuration and its own subsystems**. It does not say the requirement covers
 * everything this product does. `allowManagedHooksOnly` is the honest example:
 * codex applies it to the hook handlers IT discovers, and Nessy dispatches its
 * own hooks to a codex session by a path codex's discovery never sees.
 */
export type CodexRequirementEnforcer =
  /** This product applies it. */
  | 'nessy'
  /** The codex app-server applies it to the session we drive; re-implementing it here would duplicate the runtime. */
  | 'codex'
  /** codex parses, composes, prints and PUBLISHES it, and enforces nothing — only the client can, and this build does not. THE GAP. */
  | 'client'
  /**
   * codex enforces nothing AND the subject the requirement governs is absent
   * from this build, so there is nothing for a client to apply. A stated
   * non-application, not a gap — see the table in the module docblock.
   */
  | 'inapplicable'

/**
 * P6.77 — the wire fields ts-rs drops, keyed by the experimental gate string
 * upstream writes into the attribute.
 *
 * Each value is the literal that `#[experimental("…")]` carries in
 * `app-server-protocol/src/protocol/v2/config.rs` at `rust-v0.156.1`, and that
 * the compiler therefore puts in the shipped `codex-app-server`. The map is the
 * single source both readers of this fact share:
 *
 * - {@link CODEX_REQUIREMENT_ENFORCEMENT} must carry a verdict for every key
 *   here, because these names arrive on the wire (`experimentalApi: true`) and
 *   the generated bindings do not mention them, so nothing else would give them
 *   one;
 * - `codex-config-requirements.test.ts` probes the shipped binary for exactly
 *   these gate strings, and for the COUNT of the shared prefix, so a FIFTH
 *   field added upstream with the same attribute form fails rather than being
 *   dropped in silence. That sentence said "a fourth" and was collected on:
 *   `application` arrived at `rust-v0.154.0` and the probe reddened on it.
 *
 * `#[experimental(nested)]` is NOT this: it names no gate, is not dropped, and
 * the `allowed_approval_policies` field of the same struct is its in-struct
 * control.
 *
 * ## D1.206 — the limit of BOTH tripwires, stated because neither can state it
 *
 * `codex-config-requirements.test.ts` pins totality twice — `fields.length`
 * against the generated bindings, and this map against the gate strings in the
 * shipped binary — and **a field dropped from the bindings by any OTHER
 * mechanism is invisible to both of them.** The `application` arrival was caught
 * only because upstream reached for the same `#[experimental("…")]` form; a
 * novel attribute, or a type ts-rs cannot express, would have been silent.
 *
 * The arithmetic that shows why no in-tree instrument closes it. Re-read
 * 2026-09-24 from `app-server-protocol/src/protocol/v2/config.rs` at
 * `rust-v0.156.1`, `pub struct ConfigRequirements`: **33 fields**, of which 29
 * reach the bindings and 4 carry a gate string — `33 = 29 + 4` (31 = 27 + 4 at
 * `rust-v0.154.0`). A silently-dropped ARRIVAL takes the struct to 34 and leaves
 * both 29 and 4 untouched, so every assertion here stays green. The
 * identity is therefore pinned as a *lift* obligation, in the test beside the
 * other two, and not as a detector: it reddens when either KNOWN side moves,
 * which is what sends a lift lane to this paragraph.
 *
 * **`keyof ConfigRequirements` was priced and REFUSED for this row.** The
 * package README (`packages/codex-protocol/README.md`, §*Why `shared` restates
 * the wire shape instead of importing it*) prices the tie at "one line of
 * `packages/shared/package.json`" and is right about the price — but the tie is
 * derived FROM the bindings, so it is blind to precisely the class this row is
 * about, and it would replace a runtime parse that already covers the class it
 * can see. It remains the right change for a different reason (a regeneration
 * reddening the typecheck) and that reason is the README's, not this one's.
 *
 * So the residue is honest and named: **a fifth experimental field arriving in
 * a form nobody has seen is detectable only by reading `struct
 * ConfigRequirements` at the lifted tag and checking that identity.** One curl,
 * once per lift, and it belongs to whoever lifts.
 */
export const CODEX_EXPERIMENTAL_REQUIREMENT_GATES: Readonly<Record<string, string>> = Object.freeze({
  allowedApprovalsReviewers: 'configRequirements/read.allowedApprovalsReviewers',
  application: 'configRequirements/read.application',
  hooks: 'configRequirements/read.hooks',
  network: 'configRequirements/read.network',
})

/** The prefix every {@link CODEX_EXPERIMENTAL_REQUIREMENT_GATES} value shares, spelled once. */
export const CODEX_EXPERIMENTAL_REQUIREMENT_GATE_PREFIX = 'configRequirements/read.'

/**
 * One verdict per wire field. **THIRTY-TWO entries, and the arithmetic is written
 * out because the obvious sum is wrong**: the generated type has 29 top-level
 * fields, `featureRequirements` is deliberately absent (a MAP, resolved per key by
 * {@link classifyCodexRequirementField}), and the four experimental gates above are
 * added, so 29 − 1 + 4 = 32 at `rust-v0.156.1` (2026-09-24; 27 − 1 + 4 = 30 at
 * `rust-v0.154.0`). Read the count off the object: two earlier sentences here were wrong.
 *
 * | `rust-v0.156.1` (F1.255): three arrived, one left | verdict | read from, at that tag |
 * | --- | --- | --- |
 * | `modelProvider`, `modelProviders` | `'codex'` | `core/src/config/requirements.rs` `apply_to_config`: `apply_exact!(model_provider)` REPLACES the configured selection (a conflict is a source-named startup warning, which reaches our `configWarning` reader), and `model_providers` are `extend`ed over ours — `config/src/model_provider_requirements.rs` does the same at TOML level — so a managed entry under OUR provider key replaces it. codex enforces both. F1.589 measured it on the shipped 0.156.1: every request goes to the managed provider, and under our key silently, so the start-up refuses the session before `thread/start` ({@link codexManagedModelProviderRedirect}); and every start-up thread open compares the provider codex reports with ours, which also covers a read that did not answer (F1.634, {@link codexOpenedModelProviderRefusal}). |
 * | `allowedLoginMethods` | `'codex'` | `login/src/auth/manager.rs` `load_auth` filters every stored credential through `allows_auth`. Its subject is codex's OWN login, which this fork never writes (the A3.4 reading below), so it restricts nothing we use — the `cliAuthCredentialsStore` shape. |
 * | ~~`windowsSandboxPrivateDesktop`~~ | removed | gone from the struct; `config/src/strict_config.rs` now warns that the key is ignored because "legacy Windows sandboxes always use a private desktop". |
 *
 * ## The five that arrived with `rust-v0.150.1`, each read from the source
 *
 * Recorded here rather than in the module docblock because the reason IS the
 * verdict, and a reader who disagrees with one needs the file it was read from,
 * not a summary of it. All five at `github.com/openai/codex` `rust-v0.150.1` —
 * the STRONG tier, the source the shipped binary is built from.
 *
 * | field | verdict | read from |
 * | --- | --- | --- |
 * | `cliAuthCredentialsStore` | `'codex'` | `core/src/config/requirements.rs` `apply_to_config` applies it through the `apply_exact!` macro: the managed value REPLACES the configured one and a conflict pushes a source-named startup warning. `core/src/config/mod.rs` then builds `Config.cli_auth_credentials_store_mode` from the requirement when it is present and calls `resolve_cli_auth_credentials_store_mode` only when it is not. |
 * | `chatgptBaseUrl` | `'codex'` | the same `apply_exact!` list in the same function. |
 * | `additionalDeveloperInstructions` | `'codex'` | `core/src/context/world_state/managed_developer_instructions.rs`: a requirements-owned `developer`-role message, wrapped in `<managed_developer_instructions>` markers, injected as its own message (`requires_separate_message`), capped at 10 000 tokens and validated at config load by `validate_managed_developer_instructions`, with its own replacement and removal notices. codex puts it in the model's context itself. |
 * | `allowBrowserAndComputerUse` | `'inapplicable'` | same subject as `computerUse` and `browserUse` above, and therefore the same answer: this product exposes neither browser use nor computer use from a codex session. It is a GATE rather than a sub-setting, which is why it was read separately instead of assumed — but a gate over a capability that is absent still governs nothing here. |
 * | `inAppBrowser` | `'inapplicable'` | its ONE field is `allowExternalBrowserSettingsImport` (`app-server-protocol/src/protocol/v2/config.rs`, `struct InAppBrowserRequirements`), which governs CODEX's own in-app browser importing settings from an external browser. Read twice on purpose, because the name collides: it is NOT the `[features]` `in_app_browser` boolean, which asks the DESKTOP HOST to stop opening its own pane and which this product really does enforce (`config/managed-in-app-browser.ts` plus the gate in `browser-pane-manager.ts`). That answer arrives by the `featureRequirements.` path, not by this field. |
 *
 * A note the Nestor gateway makes worth stating, because `chatgptBaseUrl` looks
 * alarming beside it and is not: a managed value there cannot silently redirect
 * a verified-gateway session. codex spends `chatgpt_base_url` on its own ChatGPT
 * backend, its plugin manager and its `McpConfig` (`core/src/config/mod.rs`,
 * `plugins_config_input` and the `McpConfig` construction); our sessions run on
 * a DECLARED `model_providers.*` entry with its own `base_url`, which this
 * requirement does not touch. Measured over this tree: the only mentions of the
 * key are two comments about codex's analytics endpoint, and nothing reads or
 * writes it. **A3.5 turned that note into a gate** —
 * `agent/__tests__/codex-managed-chatgpt-base-url.test.ts`, four cases with the
 * gateway predicate as its own control.
 *
 * ## What the verdicts do to a session THIS HOST runs — I2.20, I2.21 and A3.4,
 * re-derived at `rust-v0.154.0` on 2026-09-17
 *
 * The table above says who ENFORCES each field. Three of the rows carry a
 * second question their own row cannot answer — what a managed value would do
 * to one of our sessions — and each has a measured answer rather than a
 * plausible one:
 *
 *  - **`cliAuthCredentialsStore` (A3.4).** Its mode is
 *    `"file" | "keyring" | "auto" | "ephemeral"` and its subject is where CODEX
 *    keeps ITS OWN cli credentials. This fork writes none: `'auth.json'` occurs
 *    in **0** files over `packages apps`, `writeCodexConfig` writes only
 *    `config.toml`, the rules file and the per-role config files, and
 *    `getAuthStatus` answered `{ authMethod: null, … }` on the shipped binary
 *    (the measurement in {@link CodexAgent.describeQuota}'s docblock). So a
 *    managed store mode has nothing to store, and it cannot move, expose or
 *    discard the credential this host really maintains — the dp JWT at
 *    `~/.nessy/dp_auth_creds.json`, written only by `auth/dp/creds-store.ts`
 *    (atomic, 0600) and read in the HOST process by the adapter's
 *    `nestor-auth.ts`, never by the codex child. The two credential stores do
 *    not touch, and that is why `'codex'` is a complete answer here and not a
 *    shrug.
 *  - **`additionalDeveloperInstructions` (I2.21) cannot displace what the host
 *    composed, and the field that COULD is not a requirement.** P3.33 measured
 *    the two `ThreadStartParams` channels against the bundled app-server and
 *    they are not interchangeable: `developerInstructions` is ADDITIVE (codex's
 *    own 20 751-char prompt is unchanged and our text lands as the first
 *    `developer` item), while `baseInstructions` REPLACES the whole prompt with
 *    ours. The host's safety guidance and output style ride the additive one.
 *    codex's managed append is additive too — its own separate `developer`
 *    message inside `<managed_developer_instructions>` markers — so two
 *    additive channels coexist and neither can silently displace the other.
 *    `baseInstructions` is a thread-start parameter and is in no `ConfigRequirements` field, so a managed document has no path to it.
 *  - **The browser/computer-use family (I2.20) is `'inapplicable'`, which is a
 *    STATED posture and not a gap.** A requirement in that family lands in the
 *    `inapplicable` bucket of the reading, so an administrator whose fleet
 *    mandates one is told this build applies nothing rather than being told a
 *    control is in force. Two of the row's own premises were stale and are corrected here rather than
 *    carried: the pin it says holds `fields.length` at 22 held it at **27** (29 since `rust-v0.156.1`), and
 *    `config/managed-in-app-browser.ts` was NOT written against an unstable feature — its own docblock
 *    records `Stage::Stable, default_enabled: true` at the STRONG tier.
 */
export const CODEX_REQUIREMENT_ENFORCEMENT: Readonly<Record<string, CodexRequirementEnforcer>> =
  Object.freeze({
    cliAuthCredentialsStore: 'codex',
    chatgptBaseUrl: 'codex',
    additionalDeveloperInstructions: 'codex',
    allowedApprovalPolicies: 'codex',
    allowedApprovalsReviewers: 'codex',
    allowedSandboxModes: 'codex',
    allowedWindowsSandboxImplementations: 'codex',
    allowedPermissionProfiles: 'codex',
    defaultPermissions: 'codex',
    allowedWebSearchModes: 'codex',
    allowManagedHooksOnly: 'codex',
    allowBrowserAndComputerUse: 'inapplicable',
    allowAppshots: 'inapplicable',
    allowRemoteControl: 'codex',
    computerUse: 'inapplicable',
    browserUse: 'inapplicable',
    inAppBrowser: 'inapplicable',
    hooks: 'codex',
    enforceResidency: 'codex',
    network: 'codex',
    autoReview: 'codex',
    models: 'client',
    sqliteHome: 'codex',
    logDir: 'codex',
    modelCatalogJson: 'codex',
    checkForUpdateOnStartup: 'codex',
    allowLoginShell: 'codex',
    application: 'client',
    feedback: 'codex',
    modelProvider: 'codex',
    modelProviders: 'codex',
    allowedLoginMethods: 'codex',
  })

/** The one place `featureRequirements.` is spelled, so every reader of the table agrees on it. */
const CODEX_FEATURE_FIELD_PREFIX = 'featureRequirements.'

/**
 * The verdict for one reported field name, or `undefined` when this build has
 * none.
 *
 * `undefined` is a real answer and gets its own bucket rather than being folded
 * into either of the others: a newer app-server may deploy a field this build
 * has never heard of, and guessing on its behalf is how a report starts lying.
 *
 * `featureRequirements.<key>` is resolved here because the `[features]` table is
 * open-ended. The default is still `'codex'` — a key naming a codex feature IS
 * enforced by `ManagedFeatures::from_configured_with_warnings`
 * (`core/src/config/mod.rs:3220`-`:3226`) against codex's own feature set, and
 * flipping the whole table to the gap bucket would be the same defect pointed
 * the other way. {@link CODEX_HOST_FACING_FEATURE_KEYS} carries the exceptions:
 * the keys whose subject is the desktop host, where a `'codex'` answer would
 * tell an administrator a policy is in force that nothing applies (P2.373).
 */
export function classifyCodexRequirementField(field: string): CodexRequirementEnforcer | undefined {
  if (field.startsWith(CODEX_FEATURE_FIELD_PREFIX)) {
    const key = field.slice(CODEX_FEATURE_FIELD_PREFIX.length)
    return CODEX_HOST_FACING_FEATURE_KEYS[key] ?? 'codex'
  }
  return CODEX_REQUIREMENT_ENFORCEMENT[field]
}


/** How a probe ended. */
export type CodexConfigRequirementsStatusV1 =
  /** The server answered with a requirements document. */
  | 'read'
  /** The server answered, and reported no requirements at all. */
  | 'none'
  /**
   * THIS APP-SERVER REFUSED THE REQUEST PERMANENTLY — the method name is not in
   * its `ClientRequest` enum, or our params do not fit its struct. Decided by
   * {@link isDefinitiveAppServerRefusal}.
   *
   * P2.243 widened this doc rather than the rule: it used to read "the method
   * does not exist on this app-server", which was false for the param-shape
   * half. Both halves are permanent for a given binary and both mean the same
   * thing to the caller — do not ask again this session — but only one of them
   * is an absent method, and the diagnostic quotes the server's own message so
   * the difference is legible.
   */
  | 'unsupported'
  /** The call failed for some other reason — transport, timeout, busy. */
  | 'failed'

/**
 * `models.newThread` as it arrives on the wire — `app-server-protocol/src/`
 * `protocol/v2/config.rs` `struct NewThreadModelDefaults`, re-read at
 * `rust-v0.150.1`. Cited by symbol rather than by line because the line it used
 * to carry now holds `AutoReviewRequirements` instead.
 *
 * Every field optional and read as a string only: this is a cross-binary
 * document and a reader of one must never be the thing that throws.
 * `modelReasoningEffort` is a Rust enum on the far side and is kept as its wire
 * string here, because this build only ever REPORTS it.
 */
export interface CodexManagedNewThreadDefaultsV1 {
  readonly model?: string
  readonly modelReasoningEffort?: string
  readonly serviceTier?: string
}

/**
 * D1.168 — the VALUE of `application.network`, when an administrator deployed
 * one, so the `'client'` verdict on that field stops being a bare field name.
 *
 * ## The decision the row asked for: this build does NOT honour it, and says so
 *
 * `application.network` is an administrator's egress allowlist for the
 * APPLICATION — codex's own words at `rust-v0.154.0`, `config/src/application_requirements.rs`:
 * *"Managed application destinations are independent of agent network
 * permissions. Enabled policies deny unlisted domains and use normal managed
 * TOML precedence."* codex parses it, normalises and validates every domain, and
 * PUBLISHES it; it applies nothing (measured in the verdict table above).
 *
 * Honouring it means an application-wide egress filter over every request this
 * app makes on its own behalf — the gateway, the model catalogue, MCP servers
 * over HTTP, source APIs, the update feed — which is a new product surface with
 * its own refusal UX, and it is an owner's call rather than a lane's. **Two
 * readings say the interim must be disclosure rather than a partial filter:**
 *
 *  - A policy written for CODEX would very likely not list this fork's own
 *    gateway host, so applying it as-published would cut the app off from its
 *    own model traffic. That is `models`' lesson in a worse key: applying an
 *    administrator's value that was authored for a different client breaks the
 *    thing the user was doing, one step later and with no obvious cause.
 *  - A HALF-applied allowlist is the worst of the three states. It would refuse
 *    some destinations and silently permit the rest, so an administrator reading
 *    a refusal would conclude the policy is in force when most of it is not.
 *
 * So: not applied, and the line below names the DOMAINS rather than the field,
 * because a field name is not something an administrator can act on — the same
 * correction P3.239 made for `models`. What a refusal looks like to the user is
 * therefore *nothing*: this build refuses no destination on account of this
 * policy, and the sentence says that in those words rather than leaving the
 * absence to be inferred.
 *
 * The sentence also states the boundary codex itself draws, because the reader
 * most at risk here is one who concludes their AGENT's network policy is off:
 * the agent's permissions are the separate `network` field and this line says
 * nothing about them.
 */
export interface CodexManagedApplicationDestinationsV1 {
  /** codex's own switch: when `true`, unlisted domains are denied — by whoever applies it. */
  readonly enabled: boolean
  /** Domains the administrator listed `allow`, normalised by codex before publication. */
  readonly allowed: readonly string[]
  /** Domains the administrator listed `deny`. */
  readonly denied: readonly string[]
}

export interface CodexConfigRequirementsReadingV1 {
  readonly status: CodexConfigRequirementsStatusV1
  /**
   * `true` when `[features] in_app_updates = false` was deployed; `undefined`
   * when the server said nothing about it. Never `false`: the absence of a
   * requirement is not a requirement that updates be allowed.
   */
  readonly inAppUpdatesDisabled: boolean | undefined
  /**
   * P2.373/P2.463 — `true` when `[features] in_app_browser = false` was
   * deployed; `undefined` when the server said nothing about it. Never `false`,
   * on the same reasoning as its twin above.
   *
   * ACTED ON since P2.463. P2.373 carried this value with NOTHING reading it, so
   * the report could name the control instead of printing a bare key in a list;
   * `agent/codex-agent.ts` now passes it to `recordCodexInAppBrowserRequirement`,
   * the codex tier of the gate in
   * `apps/electron/src/main/browser-pane-manager.ts`. The key moved with it —
   * from {@link notApplied} to {@link honoured}.
   */
  readonly inAppBrowserDisabled: boolean | undefined
  /**
   * D1.205 — `[features] in_app_local_automation = false`, normalised to a
   * restriction. `true` disables BOTH halves of `packages/shared/src/automations/`
   * (the scheduler and the hook tiers); `undefined` is "this server said
   * nothing", which the caller must not confuse with `false`.
   */
  readonly localAutomationDisabled: boolean | undefined
  /** Requirement fields this product applies. */
  readonly honoured: readonly string[]
  /**
   * Requirement fields the server SET that this product does not apply — the
   * UNION of the three below, kept because "what does Nessy not do" is still one
   * question and this field has always answered it.
   */
  readonly unsupported: readonly string[]
  /**
   * P6.6 — set, not applied HERE, and applied by the codex app-server itself
   * ({@link CODEX_REQUIREMENT_ENFORCEMENT}). A stated non-application: nothing
   * is lost and nothing is owed.
   */
  readonly codexEnforced: readonly string[]
  /**
   * P6.6/P3.239 — set, and applied by NOBODY. codex publishes these for its
   * client to apply and enforces nothing itself; this build is the client. The
   * real gap, and the only bucket worth a row.
   *
   * P3.239 narrowed it from four fields to one: see the table in the module
   * docblock for what left and why.
   */
  readonly notApplied: readonly string[]
  /**
   * P3.239 — set, enforced by nobody, AND governing a capability this build does
   * not have. Nothing escapes and nothing is owed, so this is a stated
   * non-application rather than a gap.
   *
   * Its own bucket rather than a footnote on {@link notApplied}, because the two
   * sentences an administrator needs are opposite: "a policy you deployed is not
   * in force" versus "the thing you restricted is not present here at all". A
   * report that says the first about the second is the defect P6.6 fixed one
   * level up, one level down.
   */
  readonly inapplicable: readonly string[]
  /**
   * P3.239 — the VALUE of `models.newThread`, when one was deployed.
   *
   * The only requirement in {@link notApplied} carries an administrator's actual
   * choice, and a field name alone cannot be acted on. Named so
   * {@link formatCodexConfigRequirementsDiagnostics} can print what was required
   * next to what the session did. `undefined` whenever the server sent no
   * `models.newThread`, or sent one with no recognisable string in it.
   */
  readonly managedNewThreadDefaults?: CodexManagedNewThreadDefaultsV1
  /**
   * D1.168 — the VALUE of `application.network`, when one was deployed.
   *
   * The SECOND requirement in {@link notApplied} carrying an administrator's
   * actual choice, and the second to be named rather than listed as a bare
   * field. `undefined` whenever the server sent no `application.network`, or
   * sent one with nothing in it to disclose. See
   * {@link CodexManagedApplicationDestinationsV1} for the decision this
   * discloses.
   */
  readonly managedApplicationDestinations?: CodexManagedApplicationDestinationsV1
  /**
   * Set, and this build has no verdict for it — a newer app-server carrying a
   * field that did not exist when this table was written. Reported as its own
   * fact rather than guessed into one of the other two.
   */
  readonly unrecognised: readonly string[]
  /** Present only for `failed`/`unsupported`. */
  readonly detail?: string
}

const EMPTY_READING: CodexConfigRequirementsReadingV1 = Object.freeze({
  status: 'none',
  inAppUpdatesDisabled: undefined,
  inAppBrowserDisabled: undefined,
  localAutomationDisabled: undefined,
  honoured: Object.freeze([]),
  unsupported: Object.freeze([]),
  codexEnforced: Object.freeze([]),
  notApplied: Object.freeze([]),
  inapplicable: Object.freeze([]),
  unrecognised: Object.freeze([]),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a `configRequirements/read` RESULT into the reading this product acts on.
 *
 * Pure and total: a result of any shape produces a reading, because the parser
 * of an optional cross-binary method must never be the thing that throws.
 * `requirements: null` — the documented "nothing deployed" answer — and a
 * result this parser cannot recognise both read as `'none'`, and the difference
 * between them is not one an administrator can act on.
 */
export function readCodexConfigRequirements(result: unknown): CodexConfigRequirementsReadingV1 {
  if (!isRecord(result)) return EMPTY_READING
  const requirements = result.requirements
  if (!isRecord(requirements)) return EMPTY_READING

  const honoured: string[] = []
  const unsupported: string[] = []
  let inAppUpdatesDisabled: boolean | undefined
  let inAppBrowserDisabled: boolean | undefined
  let localAutomationDisabled: boolean | undefined

  const features = isRecord(requirements.featureRequirements) ? requirements.featureRequirements : undefined
  if (features && CODEX_IN_APP_UPDATES_FEATURE_KEY in features) {
    const value = features[CODEX_IN_APP_UPDATES_FEATURE_KEY]
    // Only a literal `false` is the documented disable. Anything else — `true`,
    // a string, a number — says nothing, on the same reasoning
    // `readManagedInAppUpdatesDisabled` gives: a malformed managed value must
    // not silently disable a security-update channel.
    if (value === false) inAppUpdatesDisabled = true
    honoured.push(`featureRequirements.${CODEX_IN_APP_UPDATES_FEATURE_KEY}`)
  }
  // P2.373 read this and deliberately did not honour it, because nothing gated a
  // browser. P2.399 built the gate and P2.463 bound the codex tier to it, so it
  // is honoured now — on the twin's exact terms above: PRESENCE puts the key on
  // `honoured`, and only a literal `false` sets the disable, because a malformed
  // managed value must not silently remove a shipped surface either.
  //
  // The `honoured` push is the load-bearing half, not decoration. Without it the
  // key still lands on `unsupported` below, is classified `'nessy'`, and hits the
  // switch's `default` arm — so an APPLIED requirement would be reported as one
  // this build has never heard of. Reported-as-unapplied is the reporting lie
  // P2.373 fixed in the other direction; `unrecognised` is that lie plus noise.
  if (features && CODEX_IN_APP_BROWSER_FEATURE_KEY in features) {
    if (features[CODEX_IN_APP_BROWSER_FEATURE_KEY] === false) inAppBrowserDisabled = true
    honoured.push(`featureRequirements.${CODEX_IN_APP_BROWSER_FEATURE_KEY}`)
  }
  // D1.205 — the third host-facing `[features]` switch, on the twin's exact
  // terms: PRESENCE puts the key on `honoured` (without it an APPLIED
  // requirement would land on `unsupported` and be reported as one this build
  // has never heard of), and only a literal `false` disables, because a
  // malformed managed value must not silently stop a fleet's automations.
  //
  // D1.409 — and this push is now TRUE, which it was not when it was written.
  // The hook half enforced at use time; the scheduler half read the tier once,
  // at a construction that always happened before any codex runtime could
  // write it, so `honoured` claimed a control nothing applied. `SessionManager`
  // symbol `ensureManagedLocalAutomationEnforcement` subscribes to the tier and
  // stops the schedulers built before it, and `runMissedRunSweep` asks at use
  // time; together with the construction gate the claim holds within a process.
  // The residue is the process where no codex runtime starts — no probe, so no
  // report either, which makes it a gap and not a false assurance.
  if (features && CODEX_LOCAL_AUTOMATION_FEATURE_KEY in features) {
    if (features[CODEX_LOCAL_AUTOMATION_FEATURE_KEY] === false) localAutomationDisabled = true
    honoured.push(`featureRequirements.${CODEX_LOCAL_AUTOMATION_FEATURE_KEY}`)
  }

  for (const [key, value] of Object.entries(requirements)) {
    // `null` is this schema's "not set" — every field is `T | null`.
    if (value === null || value === undefined) continue
    if (key === 'featureRequirements') {
      for (const feature of Object.keys(features ?? {})) {
        // A key this product APPLIES is already on `honoured`; pushing it here
        // too would report an applied requirement as one Nessy does not do.
        // Derived from the verdict table rather than naming the keys, so the
        // comment on the switch's `default` arm below ("`'nessy'` cannot land
        // here") is structurally true instead of a convention two edits away
        // from breaking — which is exactly what P2.463 nearly walked into when
        // it re-verdicted `in_app_browser`.
        if (CODEX_HOST_FACING_FEATURE_KEYS[feature] === 'nessy') continue
        unsupported.push(`featureRequirements.${feature}`)
      }
      continue
    }
    unsupported.push(key)
  }

  const codexEnforced: string[] = []
  const notApplied: string[] = []
  const inapplicable: string[] = []
  const unrecognised: string[] = []
  for (const field of unsupported) {
    switch (classifyCodexRequirementField(field)) {
      case 'codex': codexEnforced.push(field); break
      case 'client': notApplied.push(field); break
      case 'inapplicable': inapplicable.push(field); break
      // `'nessy'` cannot land here — a field this product applies was pushed onto
      // `honoured` above, never onto `unsupported`.
      default: unrecognised.push(field); break
    }
  }

  const managedNewThreadDefaults = readManagedNewThreadDefaults(requirements.models)
  // D1.168 · `application` is one of the four experimental fields ts-rs drops, so
  // it reaches this parser by the wire and never by the generated type. Read off
  // `requirements` directly for that reason.
  const managedApplicationDestinations = readManagedApplicationDestinations(requirements.application)

  return Object.freeze({
    status: 'read',
    inAppUpdatesDisabled,
    inAppBrowserDisabled,
    localAutomationDisabled,
    honoured: Object.freeze(honoured),
    unsupported: Object.freeze(unsupported.sort()),
    codexEnforced: Object.freeze(codexEnforced.sort()),
    notApplied: Object.freeze(notApplied.sort()),
    inapplicable: Object.freeze(inapplicable.sort()),
    unrecognised: Object.freeze(unrecognised.sort()),
    ...(managedNewThreadDefaults ? { managedNewThreadDefaults } : {}),
    ...(managedApplicationDestinations ? { managedApplicationDestinations } : {}),
  })
}

/**
 * Pull `models.newThread` out of the wire document, or `undefined`.
 *
 * Total, like everything else that reads this result: a `models` of the wrong
 * shape, a `newThread` that is a string, a `model` that is a number — every one
 * of those reads as "nothing was required", never as a throw on the spawn path.
 * A present-but-empty `newThread` also reads as nothing: reporting a requirement
 * with no content would be a line an operator cannot act on.
 */
function readManagedNewThreadDefaults(models: unknown): CodexManagedNewThreadDefaultsV1 | undefined {
  if (!isRecord(models)) return undefined
  const newThread = models.newThread
  if (!isRecord(newThread)) return undefined
  const defaults: { model?: string; modelReasoningEffort?: string; serviceTier?: string } = {}
  if (typeof newThread.model === 'string' && newThread.model.length > 0) {
    defaults.model = newThread.model
  }
  if (typeof newThread.modelReasoningEffort === 'string' && newThread.modelReasoningEffort.length > 0) {
    defaults.modelReasoningEffort = newThread.modelReasoningEffort
  }
  if (typeof newThread.serviceTier === 'string' && newThread.serviceTier.length > 0) {
    defaults.serviceTier = newThread.serviceTier
  }
  return Object.keys(defaults).length > 0 ? Object.freeze(defaults) : undefined
}

/**
 * Pull `application.network` out of the wire document, or `undefined`.
 *
 * TOTAL, like every other reader here: a `network` that is a string, a `domains`
 * that is an array, a permission that is a number — every one of those reads as
 * "nothing was deployed", never as a throw on the spawn path. Only codex's own
 * two permission spellings are recognised (`NetworkDomainPermission` is
 * `"allow" | "deny"`, `generated/v2/NetworkDomainPermission.ts`); anything else
 * is dropped rather than guessed into one of them, because a domain filed under
 * the wrong verdict is worse in the report than a domain missing from it.
 *
 * `enabled` defaults to `true` when absent, which is codex's own default
 * (`ApplicationNetworkRequirementsToml`'s `Deserialize`: `raw.enabled.unwrap_or(true)`).
 *
 * An empty policy — `enabled: false` with no domains — reads as nothing to
 * disclose: an administrator who deployed neither a switch nor a list has asked
 * this build for nothing, and a notice about it is the kind that teaches people
 * to ignore notices.
 */
function readManagedApplicationDestinations(
  application: unknown,
): CodexManagedApplicationDestinationsV1 | undefined {
  if (!isRecord(application)) return undefined
  const network = application.network
  if (!isRecord(network)) return undefined
  const domains = isRecord(network.domains) ? network.domains : undefined
  const allowed: string[] = []
  const denied: string[] = []
  for (const [domain, permission] of Object.entries(domains ?? {})) {
    if (domain.length === 0) continue
    if (permission === 'allow') allowed.push(domain)
    else if (permission === 'deny') denied.push(domain)
  }
  const enabled = typeof network.enabled === 'boolean' ? network.enabled : true
  if (!enabled && allowed.length === 0 && denied.length === 0) return undefined
  return Object.freeze({
    enabled,
    allowed: Object.freeze(allowed.sort()),
    denied: Object.freeze(denied.sort()),
  })
}

/**
 * How long the spawn path will wait for an OPTIONAL answer — P2.138.
 *
 * Chosen against the resting state rather than against zero, which is the way a
 * bound like this manufactures its own failures. MEASURED on the shipped binary
 * (`apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`, 2026-08-27):
 * ten `configRequirements/read` round-trips after `initialize` took 1-5 ms, and
 * an unknown method was refused in ~1 ms. Re-driven 2026-09-11 against the
 * binary the lift installed, which self-reports `0.150.1`: five round-trips at
 * 0-1 ms each, every one answering `{"requirements": null}`, after a warm
 * `initialize` of 114 ms. Five
 * seconds is three orders of magnitude of headroom over the slowest of those and
 * still short next to the `initialize` that precedes it on the same path (10.5 s
 * and 34.7 s on two cold spawns of that binary here) — so it can only fire on a
 * server that is not answering at all, never on one that is merely slow.
 */
export const CODEX_CONFIG_REQUIREMENTS_TIMEOUT_MS = 5_000

/**
 * The JSON-RPC codes that mean THIS METHOD IS NOT HERE, as opposed to "not right
 * now" — and, since P2.243, they are the SHORTCUT rather than the rule.
 *
 * ## The history, because both halves of it were written down and they disagreed
 *
 * P2.7 recorded the pair `-32601`/`-32602` and this module asserted it. Probed
 * against the shipped binary (2026-08-27, and re-driven 2026-09-11 on the
 * `0.150.1` binary with the same result) an unknown method actually comes back
 * as `-32600 Invalid request: unknown variant
 * \`nessyNonexistentMethod/read\`, expected one of ...`, because this server
 * rejects an unrecognised method as a serde variant error on the `ClientRequest`
 * enum before any method dispatch happens. With the pair alone the
 * `'unsupported'` branch was DEAD on the binary this product ships. So `-32600`
 * was added to the set — and that fix carried a false rule with it.
 *
 * ## P2.243 — `-32600` IS THE SERVER'S CATCH-ALL, so it decides nothing
 *
 * Measured over six conditions on the same binary: an unknown method, params on
 * a unit method, a wrong field type, a missing required field and a bad thread
 * id ALL return `-32600`. It is "Invalid request", not "method not found". A set
 * containing it therefore reports "the method does not exist on this
 * app-server" about a request whose PARAMS were wrong, and about a bad thread
 * id — a durable comment stating a false rule.
 *
 * The sibling classifier in `codex-agent.ts` had already reached the better
 * answer for the same binary and by the same route
 * ({@link isDefinitiveAppServerRefusal} is now that answer, shared): decide on
 * the SERDE TOKENS in the message, and keep `-32601`/`-32602` as a shortcut for
 * a future binary that answers with real codes. One binary needed two rules
 * because one rule was written from the specification and the other from the
 * binary; this module now carries the measured one and the pair below is what
 * survives of the specification.
 *
 * Both outcomes stay equally safe downstream — `codex-agent.ts` writes the
 * managed in-app-updates tier only for `'read'`/`'none'`, so neither
 * `'unsupported'` nor `'failed'` can clear a deployed requirement (P2.137). What
 * changes is only which sentence an administrator reads, and only one of them is
 * true.
 */
const DEFINITIVE_REFUSAL_CODES: readonly number[] = [-32601, -32602]

/**
 * Serde failures on the far side, and the ONLY textual evidence that a refusal
 * is permanent for a given binary.
 *
 * `unknown variant` means the METHOD NAME is not in the `ClientRequest` enum;
 * the other four mean our PARAMS do not fit its struct. Both are permanent —
 * re-sending the same bytes can only ever get the same answer — and neither is
 * expressible as a JSON-RPC code on this server, which answers `-32600` to all
 * of them and to several transient conditions besides.
 *
 * Deliberately NOT matching bare "unsupported" / "not supported": those phrases
 * occur in the shipped binary in the hundreds (92 and 139 respectively),
 * overwhelmingly as ordinary runtime conditions, so a transient "X is not
 * supported here" would latch a capability off for the whole session.
 */
const DEFINITIVE_REFUSAL_SERDE_TOKENS = /unknown variant|unknown field|missing field|invalid type|invalid length/i

/**
 * Is this app-server refusal DEFINITIVE — i.e. will asking again ever help?
 *
 * ONE classifier for what were two, reconciled by P2.243. The two call sites are
 * this module's `configRequirements/read` probe and `codex-agent.ts`'s
 * background-terminal listing; they had reached opposite rules about the same
 * binary, and a rule stated twice eventually disagrees with itself — which is
 * exactly what had happened.
 *
 * The order is the point: the CODE is checked first and only for the two values
 * that genuinely mean "method not found" on a server that uses them (this one
 * does not — it is kept for a future binary), and everything else is decided by
 * {@link DEFINITIVE_REFUSAL_SERDE_TOKENS}. A deadline rejection carries no code
 * and no serde token, so it lands on the transient side, which is where it
 * belongs.
 */
export function isDefinitiveAppServerRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code
  if (typeof code === 'number' && DEFINITIVE_REFUSAL_CODES.includes(code)) return true
  const message = error instanceof Error ? error.message : String(error ?? '')
  return DEFINITIVE_REFUSAL_SERDE_TOKENS.test(message)
}

/** The minimum of `AppServerClient` this probe needs, so a test needs no process. */
export interface CodexRequestChannel {
  /**
   * `options` is optional on purpose: a channel that ignores it is still a valid
   * channel, and {@link probeCodexConfigRequirements} does not trust any channel
   * to honour it — it holds its own deadline as well.
   */
  request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>
}

/**
 * Ask the channel, and give up after `timeoutMs` whatever the channel does.
 *
 * TWO mechanisms, and the second is not redundant. The `timeoutMs` handed to the
 * channel is what lets a real `AppServerClient` reclaim its pending entry and
 * its timer, which a race alone cannot do from outside. The race is what makes
 * the DEADLINE a property of this module rather than a favour from whichever
 * object was passed in: `CodexRequestChannel` is a structural type with a
 * deliberately small surface, every test double implements it, and a channel
 * that quietly ignores the option would otherwise restore the exact hang this
 * exists to prevent.
 *
 * The timer is cleared on the fast path, so a probe that answers in 2 ms does
 * not hold the event loop open for five seconds afterwards.
 */
async function requestWithDeadline(
  client: CodexRequestChannel,
  method: string,
  timeoutMs: number,
): Promise<unknown> {
  if (!(timeoutMs > 0)) return await client.request(method)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      client.request(method, undefined, { timeoutMs }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`app-server request ${method} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Ask a codex app-server what it requires, after `initialize`.
 *
 * NEVER throws, never rejects, and — since P2.138 — never HANGS: a runtime that
 * cannot answer this optional question must still start, and an app-server that
 * ignores the method is exactly as unable to answer as one that refuses it. The
 * caller gets a reading either way, within
 * {@link CODEX_CONFIG_REQUIREMENTS_TIMEOUT_MS}, and the one debug line is what
 * makes the degradation visible instead of silent.
 *
 * `timeoutMs` is overridable so a test can pick a bound it can actually wait
 * out; production takes the constant.
 */
export async function probeCodexConfigRequirements(
  client: CodexRequestChannel,
  options: {
    onDiagnostic?: (message: string) => void
    timeoutMs?: number
    /**
     * P6.484 — the session's model and whether the USER picked it.
     *
     * Optional, because the diagnostics this function prints must keep working
     * for a caller that cannot answer; without it the verdict is `none` and
     * every line is what it was before the row. With it, the two sentences that
     * were guesses become readings: which of `applied` / `preserved` happened,
     * and whether `models` still belongs in the unapplied bucket.
     */
    session?: { readonly model: string; readonly modelChosenExplicitly: boolean }
  } = {},
): Promise<CodexConfigRequirementsReadingV1> {
  let result: unknown
  try {
    result = await requestWithDeadline(
      client,
      CODEX_CONFIG_REQUIREMENTS_METHOD,
      options.timeoutMs ?? CODEX_CONFIG_REQUIREMENTS_TIMEOUT_MS,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // P2.243 · the SHARED classifier, not a second rule. This binary answers an
    // unknown method as a serde `unknown variant` on the `ClientRequest` enum
    // rather than with a "Method not found" string — and answers `-32600` to
    // that AND to a wrong param shape AND to a bad thread id, which is why the
    // code alone cannot decide. A DEADLINE rejection carries neither a code nor
    // a serde token, so it lands on the transient side.
    const definitive = isDefinitiveAppServerRefusal(error)
    const reading: CodexConfigRequirementsReadingV1 = Object.freeze({
      status: definitive ? 'unsupported' as const : 'failed' as const,
      inAppUpdatesDisabled: undefined,
      inAppBrowserDisabled: undefined,
  localAutomationDisabled: undefined,
      honoured: Object.freeze([]),
      unsupported: Object.freeze([]),
      codexEnforced: Object.freeze([]),
      notApplied: Object.freeze([]),
      inapplicable: Object.freeze([]),
      unrecognised: Object.freeze([]),
      detail: message,
    })
    options.onDiagnostic?.(
      definitive
        // P2.243 · "refused permanently", not "the method is absent": the same
        // verdict now covers a param-shape drift, and the server's own message
        // (quoted) is what separates the two for whoever reads this line.
        ? `[managed] codex ${CODEX_CONFIG_REQUIREMENTS_METHOD} was refused permanently by this app-server, `
          + `so it is not asked again this session: ${message}`
        : `[managed] codex ${CODEX_CONFIG_REQUIREMENTS_METHOD} failed, continuing unmanaged: ${message}`,
    )
    return reading
  }
  const raw = readCodexConfigRequirements(result)
  // P6.484 · the verdict is resolved HERE, from the reading this call just made,
  // so the classification and the sentence describing it can never disagree.
  // `resolveCodexManagedNewThreadModel` is pure, so a caller that resolves it
  // again for the APPLY (as `CodexAgent` does) gets the identical answer from
  // the identical inputs.
  const verdict = options.session
    ? resolveCodexManagedNewThreadModel(raw.managedNewThreadDefaults, options.session)
    : { kind: 'none' as const }
  const reading = withCodexNewThreadModelVerdict(raw, verdict)
  for (const line of formatCodexConfigRequirementsDiagnostics(reading, verdict)) options.onDiagnostic?.(line)
  return reading
}

/**
 * One line per FACT — and P6.6 is the discovery that there were three facts here
 * where the code printed one.
 *
 * `read but NOT applied: <every name>` was true of the product and false of the
 * session: for most of those names codex applies the requirement itself, so the
 * administrator's policy IS in force and the line said it was not. The line now
 * splits, and the only bucket that describes an actual gap says so in words that
 * cannot be mistaken for the others.
 *
 * P3.239 splits it once more, in the same direction and for the same reason.
 * "ENFORCED BY NOBODY: allowAppshots, browserUse, computerUse, models" reads as
 * four unrestricted capabilities; three of them are capabilities this build does
 * not have, and saying a browser-use policy is unenforced on a deployment whose
 * codex sessions cannot reach a browser is exactly as false as the sentence P6.6
 * deleted. Only `models` names something an administrator deployed and this
 * build could have honoured — so only `models` gets the gap sentence, and it
 * gets the administrator's VALUE with it.
 */
/**
 * P3.267 — the three diagnostic lines that say AN ADMINISTRATOR ASKED AND THIS
 * BUILD DID NOT DO IT, by their stable opening words.
 *
 * They are constants rather than literals inside the formatter for one reason:
 * `codex-agent.ts` lifts exactly these three off the diagnostic channel onto the
 * durable operator notice, because `onDiagnostic → this.debug` reaches NOBODY on
 * a packaged build (electron-log's transports are disabled outside debug mode —
 * the trap register's "an empty packaged `main.log` is not evidence"). P3.120's
 * sibling had to match its classifier's sentence by restating the prefix, and
 * its own docblock says exporting the constant instead "is strictly better";
 * this module is reachable from the agent, so it does the better thing.
 *
 * The other formatter lines stay on the debug channel deliberately: `honoured`,
 * `codexEnforced` and `inapplicable` all say the requirement IS satisfied or has
 * nothing to satisfy, and an operator notice for a control that is working is
 * how the eight-notice queue fills with news nobody needs.
 */
export const CODEX_REQUIREMENT_UNENFORCED_PREFIX =
  '[managed] codex requirements ENFORCED BY NOBODY'
/** @see CODEX_REQUIREMENT_UNENFORCED_PREFIX */
export const CODEX_REQUIREMENT_NEW_THREAD_DEFAULTS_PREFIX =
  '[managed] codex requires new threads to start on'
/** @see CODEX_REQUIREMENT_UNENFORCED_PREFIX */
export const CODEX_REQUIREMENT_NO_VERDICT_PREFIX =
  '[managed] codex requirements this build has no verdict for'
/**
 * D1.168 · @see CODEX_REQUIREMENT_UNENFORCED_PREFIX. It rides the operator queue
 * for the same reason the `models` line does: an administrator deployed a policy
 * and this build applies none of it, which is the one bucket that is lifted.
 */
export const CODEX_REQUIREMENT_APPLICATION_DESTINATIONS_PREFIX =
  '[managed] codex publishes managed application destinations'

/**
 * D1.168 — how many domain names the line above prints before it counts the
 * rest. The TOTAL is always named, so the cap shortens the line without
 * shortening the fact.
 */
const CODEX_APPLICATION_DESTINATION_NAME_CAP = 10

/**
 * The four together, for the agent's one-line membership test. Ordered longest
 * prefix first so a future prefix that extends another still matches the
 * specific one; today none does.
 */
export const CODEX_REQUIREMENT_UNAPPLIED_PREFIXES: readonly string[] = [
  CODEX_REQUIREMENT_UNENFORCED_PREFIX,
  CODEX_REQUIREMENT_NEW_THREAD_DEFAULTS_PREFIX,
  CODEX_REQUIREMENT_NO_VERDICT_PREFIX,
  CODEX_REQUIREMENT_APPLICATION_DESTINATIONS_PREFIX,
]

/**
 * P6.247 — the requirement families this wire CANNOT carry, so that their
 * silence stops reading as compliance.
 *
 * ## Measured from the source, which outranks the page for codex
 *
 * `requirements.toml` is parsed into `ConfigRequirementsToml`
 * (`codex-rs/config/src/config_requirements.rs`, 43 keys at `rust-v0.162.0`,
 * 43 at `rust-v0.159.3`, 42 at `rust-v0.156.1`, 39 at `rust-v0.150.1`), and only what
 * `map_requirements_to_api`
 * (`codex-rs/app-server/src/request_processors/config_processor.rs`) copies ever
 * reaches `configRequirements/read`. Ten of those keys are never read there —
 * the ones below; `allowed_login_methods` left when `rust-v0.156.1` put it on the
 * wire (F1.255), and `guardian_extra_policy` arrived at `rust-v0.159.3` (F1.1215)
 * with no wire field (the mapper names it 0 times) — and every one of them IS
 * consumed by codex elsewhere in
 * `config_requirements.rs`. So this is a REPORTING ceiling, not an unenforced
 * policy: an administrator's MCP allowlist is in force and invisible from here.
 *
 * ## Why the silence is dangerous, precisely
 *
 * `ConfigManagerService::read_requirements` answers `None` only when
 * `ConfigRequirementsToml::is_empty` is true, and that check covers all ten. A
 * document containing ONLY these families is therefore NOT empty: the server
 * answers with a `requirements` object whose every wire field is `null`,
 * {@link readCodexConfigRequirements} reads it as `status: 'read'` with every
 * bucket empty, and before this row {@link formatCodexConfigRequirementsDiagnostics}
 * printed nothing at all. An administrator who deployed an MCP allowlist saw
 * exactly what one who deployed nothing saw.
 *
 * `status: 'none'` is the opposite case and gets no such line on purpose:
 * because `is_empty` covers the ten, a null `requirements` really does mean
 * nothing was deployed — these families included.
 *
 * ## What this is NOT
 *
 * It is not a "this build did not do it" line, so it is deliberately absent from
 * {@link CODEX_REQUIREMENT_UNAPPLIED_PREFIXES} and stays on the debug channel:
 * nothing was asked of this build and nothing escaped. Whether the ceiling also
 * deserves a durable operator notice is `codex-agent.ts`'s call, not this
 * module's.
 *
 * Keys are spelled as `requirements.toml` spells them, because that is the file
 * a reader has to go and open; the value is the family's subject.
 */
export const CODEX_UNREPORTED_REQUIREMENT_FAMILIES: Readonly<Record<string, string>> =
  Object.freeze({
    allowed_chatgpt_workspaces: 'which ChatGPT workspaces may be used',
    remote_sandbox_config: 'per-host sandbox overrides',
    mcp_servers: 'the MCP server allowlist',
    plugins: 'per-plugin requirements',
    marketplaces: 'the plugin marketplace source restriction',
    apps: 'per-app requirements',
    rules: 'command exec-policy rules',
    permissions: 'the permission requirements table',
    guardian_policy_config: 'the managed guardian policy',
    guardian_extra_policy: 'extra policy text for the managed guardian',
  })

/** @see CODEX_UNREPORTED_REQUIREMENT_FAMILIES — the stable opening words of its one line. */
export const CODEX_REQUIREMENT_UNREPORTABLE_PREFIX =
  '[managed] codex cannot report'

/** @see CODEX_UNREPORTED_REQUIREMENT_FAMILIES — one sentence, no reading needed to build it. */
export function formatCodexUnreportableRequirementFamilies(): string {
  const families = Object.entries(CODEX_UNREPORTED_REQUIREMENT_FAMILIES)
    .map(([key, subject]) => `${key} (${subject})`)
    .join(', ')
  const count = Object.keys(CODEX_UNREPORTED_REQUIREMENT_FAMILIES).length
  return `${CODEX_REQUIREMENT_UNREPORTABLE_PREFIX} ${count} whole requirement families on this `
    + 'protocol version, so their ABSENCE from the lines above is NOT evidence that none was '
    + `deployed: ${families}. codex enforces every one of them itself — the limit is the payload of `
    + `${CODEX_CONFIG_REQUIREMENTS_METHOD}, read from codex's own source at rust-v0.162.0.`
}

/**
 * P6.78 — the CLOCK, which is the one thing nothing said.
 *
 * ## Two channels, two clocks, and only one of them is per session
 *
 * Codex publishes an organisation's `requirements.toml` PER SESSION: the probe
 * runs after `initialize` and before any thread exists, so a requirement an
 * administrator deployed five minutes ago is in force on the next codex session
 * this app starts. The HOST's own managed policy is on the other clock —
 * `SessionManager.refreshManagedPiPolicy` re-composes it at each turn boundary
 * (`server-core/src/bootstrap/managed-policy-resolution.ts`), but what
 * `createStorageRuntime` built from its BOOT composition (plugin and MCP-record
 * filters, models, `env`, sandbox network rules) keeps it until a restart.
 *
 * Neither half is a defect. Read TOGETHER they are a fact an administrator has
 * to know before they interpret anything else on this page: on codex, the two
 * halves of one deployment can disagree until the next turn, and for what was
 * built at boot until a RESTART rather than a new session.
 *
 * ## Why a sentence and not a mechanism
 *
 * The value-COMPARING version — read the codex requirement and check it against
 * the composed host policy — needs a registered cross-package bridge:
 * `CodexAgent` lives in `packages/shared`, which cannot import
 * `resolveHostSandboxSettings`. That is the M variant and it is the owner's
 * call. This is the S one: say the true thing on the channel that already
 * reaches a person.
 *
 * ## Emitted only when a requirement actually arrived
 *
 * `status: 'none'` is the common case and it has nothing to disagree about, so
 * it produces nothing — the same rule that keeps `honoured` and `codexEnforced`
 * off the operator queue. The names are the UNION of every bucket, because the
 * clock statement is about the CHANNEL rather than about any one verdict: a
 * field codex enforces itself is on codex's clock exactly as much as one we
 * apply.
 */
export const CODEX_REQUIREMENT_CLOCK_PREFIX =
  '[managed] codex requirements are read PER SESSION'

/** Every requirement field this reading carries, in one list, deduplicated. */
export function codexRequirementFieldsRead(
  reading: CodexConfigRequirementsReadingV1,
): readonly string[] {
  if (reading.status !== 'read') return []
  return [...new Set([
    ...reading.honoured,
    ...reading.codexEnforced,
    ...reading.notApplied,
    ...reading.inapplicable,
    ...reading.unrecognised,
  ])]
}

/** @see CODEX_REQUIREMENT_CLOCK_PREFIX — zero lines or exactly one. */
export function formatCodexRequirementClockDiagnostics(
  reading: CodexConfigRequirementsReadingV1,
): readonly string[] {
  const fields = codexRequirementFieldsRead(reading)
  if (fields.length === 0) return []
  return [
    `${CODEX_REQUIREMENT_CLOCK_PREFIX}, so this session read ${fields.length} `
    + `requirement field${fields.length === 1 ? '' : 's'} from the codex app-server at startup: `
    + `${fields.join(', ')}. The host is on a DIFFERENT clock — it re-reads its own managed policy `
    + 'at each turn boundary, but what it built at startup (the plugins and MCP servers a session '
    + 'is offered, models, env, sandbox network rules) keeps the launch policy until the app is '
    + 'restarted. The two are not compared: what a requirement means for the host is not read back '
    + 'from this channel.',
  ]
}

/**
 * P6.484 — WHAT TO DO WITH `models.newThread`, on codex's own terms.
 *
 * Owner decision 2026-09-05 Q15, option (b): apply it exactly as codex's own
 * client does. (a) leaves an administrator's control inert; (c) — applying it
 * over a model the user picked — is strictly stronger than codex itself, which
 * codex's source explicitly declines.
 *
 * The reference implementation, read at `rust-v0.150.1` (the tag shipped when
 * this was read, so STRONG tier — and the file is byte-identical to the
 * tag this was first read at): `tui/src/managed_new_thread_defaults.rs` fills
 * `config.model` ONLY when the invocation carried no `-m` and no `-c model=`,
 * under the comment *"Managed values are defaults rather than enforcement.
 * Preserve explicit launch choices"*. Fed from `tui/src/app_server_session.rs`,
 * applied in `tui/src/app/startup.rs` and `tui/src/app/session_lifecycle.rs`.
 *
 * Our equivalent of *"the invocation carried no `-m`"* is
 * `BaseAgent.modelChosenExplicitly` — the distinction `this._model =
 * config.model || defaultModel` used to collapse into one `||`. That is the
 * whole of the change: the requirement was never unapplicable here, it was
 * unanswerable, because nothing recorded whether the resolved model came from
 * the user or from the connection's default.
 *
 * ## C3.169 (QK7, owner answer A, 2026-09-11) — `serviceTier` IS carried now,
 * and this paragraph is the reversed judgement rather than a deleted one
 *
 * It used to read: *"`serviceTier` is NOT carried into the verdict, and the
 * omission is a decision: it is not a model choice, this build has no
 * service-tier control to move, and inventing an application for it is what the
 * read-don't-invent rule forbids."* Two of those three clauses still hold and
 * the conclusion flips on the middle one, which is the point:
 *
 *  - The posture is *fill only what the invocation did not choose*. For the
 *    MODEL that needs `modelChosenExplicitly`, because a user really can pick
 *    one. **This build offers no service-tier control at all** — `serviceTier`
 *    has no setting, no picker and no connection field — so there is no user
 *    choice for an administrator's tier to override, and the posture's
 *    precondition is satisfied unconditionally rather than skipped.
 *  - The field exists on the wire we already send:
 *    `packages/codex-protocol/generated/v2/ThreadStartParams.ts` declares
 *    `serviceTier?: string | null | null` with the doc *"Override the service
 *    tier for this turn and subsequent turns"*, so nothing is invented.
 *  - It rides the `applied` verdict ONLY, beside `effort`, so a `preserved`
 *    verdict — the user picked the model — carries no tier either. Standing
 *    down is whole or not at all.
 *
 * The REASONING-EFFORT clause is untouched and stays reported-not-applied: a
 * thinking level IS a choice this build offers, and it records no
 * explicit-versus-inherited bit for it, so applying it would be the stronger
 * posture through the back door. The two fields part company here because the
 * user's ability to choose parts them, which is exactly the distinction the
 * posture is made of.
 */
export type CodexNewThreadModelVerdict =
  /** No requirement, or none with a model in it. Nothing to say. */
  | { readonly kind: 'none' }
  /**
   * The connection defaulted, so the administrator's value wins — as codex's own
   * client does. `effort` is REPORTED and not applied (see above); `serviceTier`
   * is applied, because this build has no control for it to override.
   */
  | { readonly kind: 'applied'; readonly model: string; readonly effort?: string; readonly serviceTier?: string }
  /** The user picked this model, so the requirement stands down — codex's own posture. */
  | { readonly kind: 'preserved'; readonly required: string; readonly chosen: string }

export function resolveCodexManagedNewThreadModel(
  defaults: CodexManagedNewThreadDefaultsV1 | undefined,
  session: { readonly model: string; readonly modelChosenExplicitly: boolean },
): CodexNewThreadModelVerdict {
  const required = defaults?.model
  if (!required) return { kind: 'none' }
  if (session.modelChosenExplicitly) {
    // Including the case where the user picked the very model the administrator
    // requires: the VERDICT still says preserved, because what happened is that
    // no override was applied. Reporting it as applied would make the two
    // indistinguishable in an audit, and they are not the same event.
    return { kind: 'preserved', required, chosen: session.model }
  }
  return {
    kind: 'applied',
    model: required,
    ...(defaults?.modelReasoningEffort ? { effort: defaults.modelReasoningEffort } : {}),
    // C3.169 · carried the same way `effort` is carried, and APPLIED where
    // `effort` is only reported — the difference is whether the user has a
    // control the administrator would be overriding. See the verdict type's
    // docblock for the whole judgement.
    ...(defaults?.serviceTier ? { serviceTier: defaults.serviceTier } : {}),
  }
}

/**
 * P6.484 — move `models` off the "this build does not apply it" bucket once the
 * session HAS acted on it. This is the half that holds ledger cell B5-codex at
 * `partial`: `models` is the single `'client'` row of
 * `CODEX_REQUIREMENT_ENFORCEMENT`, and while it sat in `notApplied` the
 * enforcement table had one row that would never move.
 *
 * BOTH acting verdicts move it, and that is the judgement worth reading twice.
 * `applied` is obvious. `preserved` moves too, because standing down over an
 * explicit user choice IS the requirement's own posture — codex's
 * `managed_new_thread_defaults.rs` says so in its own words, *"Managed values
 * are defaults rather than enforcement. Preserve explicit launch choices"* — so
 * leaving it under a line that reads *"codex publishes these for its client to
 * apply and this build does not"* would state the opposite of what happened.
 * The `${CODEX_REQUIREMENT_NEW_THREAD_DEFAULTS_PREFIX}` line immediately below
 * says WHICH of the two it was, so nothing is lost by the move.
 *
 * `none` does NOT move it: the requirement carried no model, so what is left in
 * it (`modelReasoningEffort`, `serviceTier`) really is unapplied, and saying so
 * is the honest reading. A caller that supplies no session gets `none` and
 * therefore the pre-row behaviour, byte for byte.
 */
export function withCodexNewThreadModelVerdict(
  reading: CodexConfigRequirementsReadingV1,
  verdict: CodexNewThreadModelVerdict,
): CodexConfigRequirementsReadingV1 {
  if (reading.status !== 'read' || verdict.kind === 'none') return reading
  if (!reading.notApplied.includes(CODEX_NEW_THREAD_REQUIREMENT_FIELD)) return reading
  return Object.freeze({
    ...reading,
    honoured: Object.freeze([...reading.honoured, CODEX_NEW_THREAD_REQUIREMENT_FIELD]),
    notApplied: Object.freeze(
      reading.notApplied.filter(field => field !== CODEX_NEW_THREAD_REQUIREMENT_FIELD),
    ),
  })
}

/** The wire field `models.newThread` arrives under, and the one `'client'` row. */
const CODEX_NEW_THREAD_REQUIREMENT_FIELD = 'models'

export function formatCodexConfigRequirementsDiagnostics(
  reading: CodexConfigRequirementsReadingV1,
  /**
   * P6.484 — what the session actually did with `models.newThread`.
   *
   * OPTIONAL, so a caller that has not resolved it yet keeps the line this
   * function printed before the row: *"the requirement is NOT applied"*. That
   * sentence was true and is now true only for a caller that cannot answer, so
   * it is kept for exactly that caller rather than deleted.
   */
  newThreadVerdict: CodexNewThreadModelVerdict = { kind: 'none' },
): readonly string[] {
  const lines: string[] = []
  if (reading.status === 'none') {
    lines.push('[managed] codex reports no config requirements')
    return lines
  }
  if (reading.status !== 'read') return lines
  if (reading.inAppUpdatesDisabled) {
    lines.push(`[managed] codex requires ${CODEX_IN_APP_UPDATES_FEATURE_KEY}=false — in-app updates disabled`)
  }
  // P2.373 → P2.399 → P2.463. This is the line this formatter has got wrong in
  // BOTH directions, which is why it is worth reading twice. It first printed
  // `'codex'`'s *"enforced by the codex app-server itself"* about a control
  // nothing enforced (a false assurance); P2.373 replaced that with *"this build
  // has NO gate on its built-in browser … treat the built-in browser as
  // UNRESTRICTED on this deployment"*, which was true until the gate landed and
  // would now be the same defect inverted. It names BOTH spellings of the one
  // switch because the two tiers are two documents remediated by two people, and
  // an administrator reading this in a codex log is one `disableInAppBrowser`
  // search away from the host-side half.
  if (reading.inAppBrowserDisabled) {
    lines.push(
      `[managed] codex requires ${CODEX_IN_APP_BROWSER_FEATURE_KEY}=false — the built-in browser is `
      + 'DISABLED and every entry point refuses by name; the host spelling of the same switch is '
      + MANAGED_IN_APP_BROWSER_KEY,
    )
  }
  if (reading.honoured.length > 0) {
    lines.push(`[managed] codex requirements applied by Nessy: ${reading.honoured.join(', ')}`)
  }
  if (reading.codexEnforced.length > 0) {
    lines.push(
      '[managed] codex requirements enforced by the codex app-server itself, so Nessy does not '
      + `re-implement them: ${reading.codexEnforced.join(', ')}`,
    )
  }
  if (reading.notApplied.length > 0) {
    lines.push(
      `${CODEX_REQUIREMENT_UNENFORCED_PREFIX} — codex publishes these for its client to `
      + `apply and this build does not: ${reading.notApplied.join(', ')}`,
    )
  }
  // P3.239 — the value, not just the name. `models` is the only requirement in
  // the bucket above, and a field name alone tells an administrator nothing they
  // can compare against what the session did.
  const defaults = reading.managedNewThreadDefaults
  if (defaults) {
    const parts = [
      defaults.model ? `model ${defaults.model}` : '',
      defaults.modelReasoningEffort ? `reasoning effort ${defaults.modelReasoningEffort}` : '',
      defaults.serviceTier ? `service tier ${defaults.serviceTier}` : '',
    ].filter(part => part.length > 0)
    // P6.484 · the same line, now able to say which of the three things happened.
    // The old tail is kept verbatim for the `none` arm, which is what a caller
    // that has not resolved the verdict gets.
    // C3.169 · the applied arm now names WHICH of the three fields was applied,
    // because two of them are and one is not. It used to read
    // "starts on <model> at reasoning effort <effort>", which described the
    // effort as if it had been applied — it never was, and the apply site's own
    // comment says so. The tier joins the applied half (no control exists for it
    // to override); the effort stays reported, with the reason in the sentence
    // rather than only in a docblock an administrator will not read.
    const outcome = newThreadVerdict.kind === 'applied'
      ? ` — this connection's model was INHERITED rather than picked, so this thread starts on `
        + `${newThreadVerdict.model}`
        + (newThreadVerdict.serviceTier ? ` on service tier ${newThreadVerdict.serviceTier}` : '')
        + (newThreadVerdict.effort
          ? `; the required reasoning effort ${newThreadVerdict.effort} is REPORTED and NOT applied, `
            + 'because this build records no explicit-versus-inherited bit for the thinking level'
          : '')
      : newThreadVerdict.kind === 'preserved'
        ? ` — the user PICKED ${newThreadVerdict.chosen} for this connection, so the requirement `
          + 'stands down and is not applied, which is what codex\'s own client does with an '
          + 'explicit launch choice'
        : ' — this build resolves a model for every codex thread before the requirement is read, '
          + 'so the requirement is NOT applied and this session runs on the model the picker shows'
    lines.push(`${CODEX_REQUIREMENT_NEW_THREAD_DEFAULTS_PREFIX} ${parts.join(', ')}${outcome}`)
  }
  // D1.168 — the value, not just the name, for the SECOND field in the gap
  // bucket. `application` names an administrator's egress allowlist for this
  // APPLICATION, and the three things that sentence must carry are the domains
  // they listed, that none of them is applied here, and that this is not their
  // agent's network policy — see `CodexManagedApplicationDestinationsV1`.
  const destinations = reading.managedApplicationDestinations
  if (destinations) {
    const named = (label: string, domains: readonly string[]): string => domains.length === 0
      ? ''
      // Capped: an egress allowlist is routinely dozens of names and this line
      // rides a bounded operator-notice queue. The TOTAL is named so the cap
      // cannot read as the whole list.
      : `${label} ${domains.length}: ${domains.slice(0, CODEX_APPLICATION_DESTINATION_NAME_CAP).join(', ')}`
        + (domains.length > CODEX_APPLICATION_DESTINATION_NAME_CAP
          ? `, +${domains.length - CODEX_APPLICATION_DESTINATION_NAME_CAP} more`
          : '')
    const listed = [named('allow', destinations.allowed), named('deny', destinations.denied)]
      .filter(part => part.length > 0)
      .join('; ')
    lines.push(
      `${CODEX_REQUIREMENT_APPLICATION_DESTINATIONS_PREFIX} (deny-unlisted `
      + `${destinations.enabled ? 'ON' : 'off'}${listed.length > 0 ? ` — ${listed}` : ''}) — this `
      + 'build applies NONE of them, so its own network requests are unrestricted by this policy '
      + 'and nothing here is refused on account of it; codex publishes the policy and enforces '
      + 'nothing either. It is SEPARATE from the agent\'s own network permissions, which this line '
      + 'says nothing about.',
    )
  }
  if (reading.inapplicable.length > 0) {
    lines.push(
      '[managed] codex requirements that govern capabilities this build does not have, so there is '
      + `nothing to apply and nothing escapes: ${reading.inapplicable.join(', ')}`,
    )
  }
  if (reading.unrecognised.length > 0) {
    lines.push(
      `${CODEX_REQUIREMENT_NO_VERDICT_PREFIX} (newer app-server than its `
      + `enforcement table): ${reading.unrecognised.join(', ')}`,
    )
  }
  // P6.247 — the ceiling, LAST, so it reads as a footnote on the verdicts above
  // rather than as a finding of its own. Emitted for every document that
  // arrived, including one whose wire fields are all `null`: that is exactly the
  // case where every other line is absent and the absence means nothing.
  lines.push(formatCodexUnreportableRequirementFamilies())
  return lines
}

/**
 * F1.589 — how a managed `model_provider` / `model_providers` requirement moves
 * the provider THIS HOST configured for the session. `kind: 'selection'` — the
 * requirement selects another provider; `kind: 'definition'` — it defines its
 * own table under the key this host wrote, so our definition is replaced.
 * `destination` is the managed table's `base_url` ORIGIN when the document
 * carries one (a built-in selection carries none).
 */
export interface CodexManagedModelProviderRedirectV1 {
  readonly kind: 'selection' | 'definition'
  /** The provider key this host wrote as `model_provider`. */
  readonly configured: string
  /** The key the requirement names: the selected provider, or the replaced table. */
  readonly required: string
  readonly destination?: string
}

/**
 * F1.589 — does this `configRequirements/read` RESULT re-point the provider this
 * session was configured with?
 *
 * Measured 2026-09-24 on the shipped 0.156.1 through codex's own MDM reader
 * (`agent/__tests__/codex-managed-model-provider.test.ts` carries the four arms):
 * a managed `model_provider` naming another key moves every request there (codex
 * warns, but only once the thread exists), and a managed `[model_providers.<our
 * key>]` table does the same SILENTLY — `thread/start` still reports our key.
 * Source, `rust-v0.156.1`: `core/src/config/requirements.rs` `apply_to_config`,
 * `apply_exact!(model_provider)` then `config.model_providers.extend(…)`.
 *
 * `configured.hostDefined` is `true` when this host wrote the provider TABLE (the
 * loopback key); a declared codex provider (Bedrock, ChatGPT) has no table of
 * ours to replace, so only its selection is guarded. Pure and total, like every
 * reader of this result: any other shape is "no redirect", never a throw.
 */
export function codexManagedModelProviderRedirect(
  result: unknown,
  configured: { readonly provider: string, readonly hostDefined: boolean },
): CodexManagedModelProviderRedirectV1 | undefined {
  if (!isRecord(result) || !isRecord(result.requirements)) return undefined
  const requirements = result.requirements
  const definitions = isRecord(requirements.modelProviders) ? requirements.modelProviders : {}
  const destinationOf = (key: string): { destination?: string } => {
    const table = definitions[key]
    const baseUrl = isRecord(table) && typeof table.base_url === 'string' ? table.base_url : undefined
    if (!baseUrl) return {}
    try { return { destination: new URL(baseUrl).origin } } catch { return {} }
  }
  const selected = typeof requirements.modelProvider === 'string' ? requirements.modelProvider.trim() : ''
  if (selected && selected !== configured.provider) {
    return { kind: 'selection', configured: configured.provider, required: selected, ...destinationOf(selected) }
  }
  if (configured.hostDefined && configured.provider in definitions) {
    return { kind: 'definition', configured: configured.provider, required: configured.provider, ...destinationOf(configured.provider) }
  }
  return undefined
}

/**
 * F1.589 — the sentence a refused codex session shows. DECIDED under the
 * TRANSPARENT and SIMPLE rule (no page or source settles it): refuse rather than
 * warn, because the check runs BEFORE `thread/start`, so a refusal is the only
 * answer under which the user's first prompt never reaches a provider they did
 * not pick — a warning arrives beside a turn already sent. It is the posture of
 * A3.5 (a managed `chatgpt_base_url` cannot silently redirect a gateway session)
 * and of F1.482 (a turn codex would refuse is refused in words naming the policy).
 */
export function formatCodexManagedModelProviderRefusal(redirect: CodexManagedModelProviderRedirectV1): string {
  const where = redirect.destination ? ` (${redirect.destination})` : ''
  const what = redirect.kind === 'selection'
    ? `requires model_provider = "${redirect.required}", which replaces the model provider this app configured `
      + `for this session ("${redirect.configured}"): codex would send every request of this session to that provider${where}`
    : `defines its own model_providers.${redirect.required}, which replaces the model provider this app configured `
      + `for this session under the same name: codex would send every request of this session to that definition${where}, `
      + 'and would not say so'
  return `Codex did not start this session, and nothing was sent: your organisation's Codex policy ${what}. `
    + 'This app does not run a session on a model provider it did not configure. Ask your administrator about the '
    + 'policy; Pi and Claude sessions are not affected by it.'
}

/**
 * F1.634 (origin WJ-bt P-WJbt-1) — F1.589's second reading: the model provider codex SAYS it opened the thread
 * on. `modelProvider` is a required field of `ThreadStartResponse`, `ThreadResumeResponse` and
 * `ThreadForkResponse` (`codex-protocol/generated/v2/`), filled from the resolved config's `model_provider_id`
 * (`app-server/src/request_processors/thread_processor.rs` at `rust-v0.156.1`), which `core/src/config/mod.rs`
 * resolves as the required provider, else the merged layers' `model_provider`, else `openai` — the KEY, never
 * an alias. Measured on the shipped 0.156.1 (F1.589's rig): our key in the control arm, `wjbt_managed` in the
 * managed-selection arm.
 *
 * Compared on EVERY start-up open, answered read or not, because two things F1.589 cannot see select another
 * provider: a `configRequirements/read` that did not answer (the 5 s deadline, a refusal), and — read at
 * `rust-v0.156.1`, not measured — a legacy managed configuration (`/etc/codex/managed_config.toml` or its MDM
 * twin, `config/src/loader/mod.rs`), a config layer "on top of everything else" whose `model_provider` never
 * reaches the requirements document (only its approval and sandbox keys do). No layer of the user's reaches
 * it: `PROJECT_LOCAL_CONFIG_DENYLIST` strips `model_provider`, `model_providers` and `profile` from project
 * layers, and the user layer is the one this host writes. So in ordinary operation the reading equals the key
 * we wrote, and a difference is always a provider this app did not configure — F1.589's posture, refuse.
 *
 * RESIDUE, said aloud: a managed TABLE under our own key re-points the session while codex still reports our
 * key (F1.589's measured definition arm), so without an answered read it stays invisible. And the thread exists
 * by the time this runs, so the sentence says the user's first message was not sent, not that nothing was.
 * Pure and total: a response without the field (an older app-server) has nothing to compare and reads as no
 * refusal. Returns the refusal sentence, or `undefined`.
 */
export function codexOpenedModelProviderRefusal(
  opened: unknown,
  configured: string,
  requirements: Pick<CodexConfigRequirementsReadingV1, 'status' | 'detail'>,
): string | undefined {
  const reported = codexReportedModelProviderDifference(opened, configured) // F1.1030 — one comparison, both call sites
  if (!reported) return undefined
  const detail = requirements.detail ? `: ${requirements.detail}` : ''
  const why = requirements.status === 'read' || requirements.status === 'none'
    ? 'Your organisation\'s Codex policy does not select another model provider, so the choice came from a Codex '
      + 'configuration this app does not write, such as a managed configuration'
    : `This app could not read your organisation's Codex policy to say why (configRequirements/read `
      + `${requirements.status === 'unsupported' ? 'was refused by this codex' : 'did not answer'}${detail})`
  return `Codex did not start this session: codex opened it on the model provider "${reported}", not the one this `
    + `app configured for it ("${configured}"), so every request of this session would have gone there. ${why}. `
    + 'Your first message was not sent. This app does not run a session on a model provider it did not configure. '
    + 'Ask your administrator whether a Codex policy or managed configuration selects a model provider.'
}

/**
 * F1.634's comparison, shared with F1.1030: the `modelProvider` a thread-open response reports, when it is a
 * non-empty string different from the key this host wrote; `undefined` otherwise (the same key, or a response
 * without the field — an older app-server has nothing to compare). Pure and total.
 */
function codexReportedModelProviderDifference(opened: unknown, configured: string): string | undefined {
  const reported = isRecord(opened) && typeof opened.modelProvider === 'string' ? opened.modelProvider.trim() : ''
  return reported && reported !== configured ? reported : undefined
}

/**
 * F1.1030 (origin DN-224) — {@link codexOpenedModelProviderRefusal}'s comparison on the TURN-HEAD RE-FORK. F1.634
 * compares on every start-up open; the re-fork (`CodexAgent.applySelectedPluginSkillRuntimePolicy`: F1.928's rules
 * drift, a sandbox, plugin or effort drift) opens a NEW thread through `thread/fork` — or `thread/start` for a thread
 * with no rollout yet — and codex loads a fresh config layer for it (the reason the walk forks at all:
 * `thread/resume` ignores overrides). Both `ThreadForkResponse` and `ThreadStartResponse` carry the required
 * `modelProvider`, so a managed configuration (`/etc/codex/managed_config.toml` or its MDM twin) or a managed
 * `model_provider` requirement that appeared or changed BETWEEN turns re-points the forked thread, and this is where
 * it shows (the fork re-reading a changed managed layer is the walk's premise, read, not measured on the binary — the
 * managed-configuration arm is a sitting case). The host compares before it adopts the forked thread and fails the
 * turn on a difference: the old thread,
 * the recorded signature and the host's anchor stay, so the next turn re-forks and is checked again.
 *
 * No second `configRequirements/read` is taken here (the start-up read is the one clock the requirement readers
 * share), so the sentence does not guess which of the two moved; the start-up open reported our key (F1.634), so
 * the difference arrived after the session opened. RESIDUE, as at start-up: a managed TABLE under our own key still
 * reports our key and stays invisible here. Returns the refusal sentence, or `undefined`.
 */
export function codexReforkedModelProviderRefusal(reforked: unknown, configured: string): string | undefined {
  const reported = codexReportedModelProviderDifference(reforked, configured)
  if (!reported) return undefined
  return `Codex re-opened this session's thread to apply changed settings, and codex put it on the model provider `
    + `"${reported}", not the one this app configured for it ("${configured}"), so every request of this turn would `
    + 'have gone there; this turn was not started. The session opened on this app\'s provider, so a Codex policy or '
    + 'configuration this app does not write, such as a managed configuration, changed since. Your message was not '
    + 'sent. This app does not run a session on a model provider it did not configure. Ask your administrator whether '
    + 'a Codex policy or managed configuration selects a model provider.'
}
