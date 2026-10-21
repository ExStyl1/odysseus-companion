/**
 * P3.81 — make codex's `configWarning` audible, because the thing it reports
 * silently is a security floor disappearing.
 *
 * ## The hazard, measured
 *
 * `writeCodexConfig` projects two families of execpolicy rules into
 * `CODEX_HOME/rules/nessy.rules`: P2.141b's `decision="forbidden"` floors and
 * P3.1's durable Always-Allow grants. **codex fails that file OPEN and
 * WHOLE-FILE.** One bad line drops every rule in it — the refusals and the
 * grants together — and the session then runs as if the file had never been
 * written. The only signal is a `configWarning` notification, and until this
 * module nothing in this repo read it.
 *
 * The presentation is the trap. The half a user notices is the grants: it reads
 * as "Always Allow stopped working", a nuisance. The half nobody notices is the
 * floors, and their disappearance is invisible from the UI.
 *
 * ## What was measured, and on what
 *
 * Shipped `codex-app-server` 0.148.0 (`apps/electron/resources/bin/codex/`),
 * md5 `eb2144664b1c4eb0697b69b4b242b737` (darwin-arm64), driven over stdio
 * against a `CODEX_HOME` built by `writeCodexConfig`, 2026-08-28:
 *
 * - **darwin-arm64** (Apple M1 Pro), clean home: **zero** `configWarning` in a
 *   25 s window. Positive control — one extra
 *   `prefix_rule(pattern=["ls"], decision="nonsense")` appended to the projected
 *   file — produced exactly one, at **92 ms** from spawn:
 *   `summary` = "Error parsing rules; custom rules not applied.",
 *   `details` = "failed to parse rules file <abs path>/rules/nessy.rules:
 *   starlark error: … error: invalid decision: nonsense".
 * - **darwin-x64 under Rosetta**, same two arms: clean **zero** in 25 s, control
 *   one at **260 ms**.
 * - win32 not executed (plan row P3.62).
 *
 * So the warning is on the **bootstrap** path: on both platforms it arrived in
 * the same flush as the `initialize` response, before `initialized` was sent.
 * It is observable at the moment the home is built, not only later.
 *
 * ## Why this reports and does not refuse
 *
 * `configWarning` is a GENERIC channel, not a rules channel. The same
 * notification carries a blank `developer_instructions`, an `agents.<role>.
 * config_file` that is not on disk, and (measured 2026-08-13) an agent named
 * `enabled`, which discards the entire `config.toml`. Failing the session on the
 * class would let a stray agent-role typo render codex unusable.
 *
 * Narrowing to the rules file does not rescue failing closed either. The rules
 * projection is DEFENCE IN DEPTH by its own docs (`codex-agent.ts`: it "cannot
 * carry the guarantee, because a single malformed line drops every rule in the
 * file"); the floor that carries the guarantee is `findNonNegotiableFloors` on
 * our own approval path, which a broken rules file does not touch. Refusing to
 * start would therefore trade a real outage for no real safety gain — and on the
 * grants half it would be plainly wrong, since a lost Always-Allow only costs a
 * prompt.
 *
 * What was actually broken is that the loss was SILENT. So: report it, name the
 * file, and say in words which two things are now absent — then continue.
 */

/** The notification method the app-server uses. `ServerNotification` union, rust-v0.148.0. */
export const CODEX_CONFIG_WARNING_METHOD = 'configWarning';

/**
 * `ConfigWarningNotification` — the fields measured on the wire, 2026-08-28.
 *
 * `path` and `range` were found by reading a live one: the rules warning carries
 * `path` = the absolute path of the offending file and `range` = the offending
 * line/column. `path` is therefore the strongest available detector, and it
 * costs nothing to prefer it over scraping `details`.
 *
 * This sentence used to say the two fields were NOT in this repo's snapshot of
 * the documented shape. They are, and were when it was written:
 * `packages/codex-protocol/generated/v2/ConfigWarningNotification.ts` declares
 * `path?: string` and `range?: TextRange` beside `summary` and `details`. Only
 * `range` was actually unread, which is the gap P3.118 closed below.
 *
 * Read defensively throughout: a version that renames or drops any of these must
 * degrade to a shorter line, never to a throw inside the transport's line
 * handler.
 */
interface ConfigWarningLike {
  summary?: unknown;
  details?: unknown;
  path?: unknown;
  range?: unknown;
}

/**
 * P3.118 — `range`, the half of the location this module recorded nowhere.
 *
 * `ConfigWarningNotification` (`packages/codex-protocol/generated/v2/`,
 * generated from `rust-v0.148.0`) declares `path?: string` and
 * `range?: TextRange`, where `TextRange` is `{ start: TextPosition, end:
 * TextPosition }` and `TextPosition` is `{ line, column }`, both documented
 * **1-based**. `path` was already read; `range` was not, so the notice named the
 * file and left the reader to find the offending line by eye — in a starlark
 * traceback that this module deliberately collapses to one line.
 *
 * MEASURED on the shipped `darwin-arm64/codex-app-server`, 2026-09-03, driven
 * over stdio against a `CODEX_HOME` whose `rules/nessy.rules` carried one bad
 * line (`decision="nonsense"`), with the clean-rules run as the control (zero
 * `configWarning`):
 *
 *   `range: { start: { line: 1, column: 1 }, end: { line: 1, column: 49 } }`
 *
 * Rendered as `<path>:<line>:<column>` from `start` only: the end position adds
 * nothing an operator opening the file can use, and the whole point of this
 * module is that the line it emits is short enough to be read.
 *
 * Defensive throughout, like every other read here — a version that renames or
 * drops the field must shorten the sentence, never throw inside the transport's
 * line handler.
 */
function positionSuffix(range: unknown): string {
  if (typeof range !== 'object' || range === null) return '';
  const start = (range as { start?: unknown }).start;
  if (typeof start !== 'object' || start === null) return '';
  const { line, column } = start as { line?: unknown; column?: unknown };
  if (typeof line !== 'number' || !Number.isFinite(line)) return '';
  return typeof column === 'number' && Number.isFinite(column) ? `:${line}:${column}` : `:${line}`;
}

/**
 * `path` plus `range` as one locator, or `path` alone, or `''`.
 *
 * Exported because the location is the one part of a `configWarning` a caller
 * may want without the sentence around it, and because a second hand-rolled
 * reader of the same two fields is how the two would drift apart.
 */
export function codexConfigWarningLocation(params: unknown): string {
  const warning = (params ?? {}) as ConfigWarningLike;
  const path = bounded(text(warning.path), 300);
  if (!path) return '';
  return `${path}${positionSuffix(warning.range)}`;
}

/**
 * Path fragment of the file `writeCodexConfig` projects into every CODEX_HOME.
 *
 * Deliberately NOT imported from `@nessy-agent/codex-responses-adapter/
 * config-writer`, even though `CODEX_RULES_DIR` and `CODEX_RULES_FILE` are
 * exported there and the dependency exists: this classifier must keep matching
 * warnings about homes it did not write (a user layer, a future second rules
 * file), and pulling the writer's 1.2k-line module into the stdio transport for
 * two string constants buys coupling rather than safety. The drift that matters
 * is covered instead by the live gate, which builds a real home with the real
 * writer and asserts this string appears in the control arm's warning.
 */
const RULES_PATH_FRAGMENTS = ['rules/nessy.rules', 'rules\\nessy.rules'] as const;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Trim a starlark traceback (multi-line, absolute paths) to something a log can hold. */
function bounded(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/**
 * P6.7 — THE OTHER CLASS ON THIS CHANNEL: an administrator's requirements
 * overrode the setting this session asked for, and codex started anyway.
 *
 * ## What codex does, measured in its own source at the tag we ship
 *
 * `github.com/openai/codex` at **`rust-v0.148.0`** — the tag shipped when this
 * was read; today's is `manifest.json`'s `upstream.tag` —
 * `core/src/config/mod.rs:2089`-`:2100`:
 * when a configured value is not in the set a deployed `requirements.toml`
 * allows, codex does NOT refuse. It logs, **falls back to the required value**,
 * and pushes a sentence onto `Config::startup_warnings`:
 *
 *   "Configured value for `{field}` is disallowed by requirements; falling back
 *    to required value {value}. Details: {err}"
 *
 * `core/src/config/requirements.rs:71`-`:73` and `:143`-`:148` push the exact-
 * requirement siblings ("is overridden by the required value … from {source}",
 * "Configured values under `{field}` are overridden by requirements from
 * {source}"), and `:127`-`:133` the `$CODEX_SQLITE_HOME` one.
 *
 * `app-server/src/lib.rs:641`-`:647` then turns EVERY one of those into a
 * `ConfigWarningNotification` — the same `configWarning` notification this
 * module already reads. So the observability is codex's own, it is already on
 * the wire, and this repo was throwing it away as an unlabelled echo.
 *
 * Present in the shipped artifact (`grep -a -c -F`, darwin-arm64, 2026-08-29):
 * `is disallowed by requirements` 11, `falling back to required value` 1,
 * `Configured value for` 4, `configWarning` 3. Positive control on the same
 * rig `thread/start` 3; negative control `nessyNonexistentMethod/read` 0.
 *
 * ## Why this matters more than the words suggest
 *
 * The settings codex clamps this way are the permission ones. `config.toml`'s
 * `approval_policy`, `permission_profile` and `default_permissions` are what
 * `writeCodexConfig` derives from the user's PERMISSION MODE — so an
 * organisation whose `requirements.toml` forbids the mode the user picked gets
 * a session that silently runs under a DIFFERENT approval policy or sandbox
 * than the one the picker shows. `allowed_sandbox_modes` reaches the same
 * clamp: `config/src/config_requirements.rs:1674`-`:1700` compiles it into a
 * validator on `permission_profile`, and `core/src/config/mod.rs:3883` applies
 * it through the same fallback.
 *
 * ## Why this reports and does not refuse — the same reasoning as the rules half
 *
 * The fallback is codex's, it is deliberate, and it is SAFE-ward by
 * construction: the value the session lands on is the one the administrator
 * required. Refusing the spawn would convert an administrator's policy into an
 * outage. What was broken is only that the substitution was silent.
 */
const REQUIREMENT_OVERRIDE_PHRASES = [
  // `core/src/config/mod.rs:2098` — the constrained-set fallback.
  'is disallowed by requirements',
  // `core/src/config/requirements.rs:72` / `:130` — the exact-value overrides.
  'overridden by the required',
  // `core/src/config/requirements.rs:146` — the structured (`feedback`) override.
  'overridden by requirements',
] as const;

/**
 * Does this warning mean an administrator's requirements replaced a setting we
 * asked for?
 *
 * Matched on `summary` and `details` together, because the constrained-set
 * variant puts the field name in `summary` and `ConstraintError`'s own
 * "is not in the allowed set … (set by …)" text in `details`. Phrase matching
 * rather than a schema field is the only detector available: the notification
 * carries no code, and `path`/`range` are empty for this class (they are the
 * rules class's fields). Loose on purpose — a reworded sentence that still
 * contains "requirements" and "overridden" is still this class, and the cost of
 * a false positive here is one extra honest sentence.
 */
export function isCodexRequirementOverrideWarning(params: unknown): boolean {
  const warning = (params ?? {}) as ConfigWarningLike;
  const haystack = `${text(warning.summary)}\n${text(warning.details)}`.toLowerCase();
  return REQUIREMENT_OVERRIDE_PHRASES.some(phrase => haystack.includes(phrase));
}

/**
 * The config key codex named, or `undefined` when the sentence did not carry
 * one.
 *
 * Every phrase above spells the key in backticks, and the FIRST backticked run
 * is the key in all four (`$CODEX_SQLITE_HOME` included — that one names the
 * env var first and `sqlite_home` second, and naming the env var is the more
 * useful of the two). Bounded and character-restricted so a warning whose text
 * changed shape cannot smuggle a paragraph into a log line.
 */
export function codexRequirementOverrideField(params: unknown): string | undefined {
  const warning = (params ?? {}) as ConfigWarningLike;
  const match = /`([$A-Za-z0-9_.\-]{1,64})`/.exec(text(warning.summary));
  return match?.[1];
}

/**
 * C3.354 — THE THIRD CLASS: a project folder whose `.codex` layer is switched
 * off because the project is not trusted.
 *
 * ## The sentence codex sends, verbatim
 *
 * `codex-rs/app-server/src/lib.rs` `project_config_warning` builds exactly one
 * message, and it is one `concat!` of two literals:
 *
 *   "Project-local config, hooks, and exec policies are disabled in the
 *    following folders until the project is trusted, but skills still load."
 *
 * followed by a numbered list of `<folder>` + the trust `disabled_reason`. In
 * the shipped `darwin-arm64/codex-app-server` the first literal occurs **once**
 * (instrument: `grep -aoF … | wc -l`, i.e. OCCURRENCES; the negative control
 * `zzz-no-such-needle-zzz` is 0 and the positive control `configWarning` is 3),
 * so there is exactly one emitter of this class.
 *
 * ## What it actually disables — read at `rust-v0.150.1`, not guessed
 *
 * The list is built from `ConfigLayerSource::Project` layers carrying a
 * `disabled_reason`, i.e. the layer for that `.codex` FOLDER, and the word
 * "exec policies" in it is ACCURATE at this tag: `codex-rs/core/src/exec_policy.rs`
 * `load_exec_policy` walks `config_stack.layers_low_to_high()`, which
 * `codex-rs/config/src/state.rs` `ConfigLayerStack::layers_low_to_high` defines
 * as `all_layers_low_to_high().filter(|layer| !layer.is_disabled())`, and joins
 * `RULES_DIR_NAME` onto each ENABLED layer's config folder. Its own comment says
 * so: *"Disabled project layers already represent the trust decision, so hooks
 * and exec-policy loading can reuse the normal trusted-layer view."* So while
 * the layer is disabled that folder's `rules/*.rules` are not read either.
 *
 * **This refutes the reading this row was born with** — that a project
 * `.codex/rules/*.rules` is gated only by the separate
 * `ignore_user_and_project_exec_policy_rules` override
 * (`codex-rs/config/src/state.rs`, `with_user_and_project_exec_policy_rules_ignored`).
 * That flag is an ADDITIONAL suppressor for the User and Project layers, not the
 * only one; trust switches the layer off a step earlier.
 *
 * ## So why did a rule from a named folder fire anyway?
 *
 * Because the two readings are taken at DIFFERENT MOMENTS, and only one of them
 * is ever recomputed. `project_config_warning` has a single call site — the
 * app-server's process bootstrap, beside the sqlite init — so this notice is a
 * ONE-TIME snapshot of the trust state when the codex process started, and
 * nothing re-emits or retracts it. The exec policy is resolved separately per
 * session from whatever config stack that session is built with
 * (`ExecPolicyManager::load(config_stack)`).
 *
 * WHO trusted the folder in between was misattributed here until F1.750: this
 * said the product writes `trust_level = "trusted"` whenever the project is
 * trusted, and it wrote no entry at all (the call passed no trust decision). It
 * was codex itself — `thread_start_task` AUTO-TRUSTS a cwd with no trust entry on
 * `thread/start` (`rust-v0.156.1`), after this snapshot was taken, whatever the
 * app's trust dialog said. Measured on the shipped 0.156.1 (WJ-crit-aa, arm HX):
 * this warning printed at startup, then the project's MCP server command ran and
 * its forbidden rule refused a command. Since F1.750 the entry is this app's own
 * decision, written before codex starts (`trusted` for a trusted project,
 * `untrusted` for one kept restricted or never trusted —
 * `packages/codex-responses-adapter/src/config-writer.ts` symbol
 * `buildCodexProjectTrustToml`), so the auto-trust never fires and the line
 * holds for the process that emitted it; a trust decision changed in the app
 * later is not re-read by that process.
 *
 * The staleness is why this class needs a sentence of its own: the text codex
 * sends is true of the moment it was taken and reads as a standing guarantee.
 *
 * Matched on the phrase rather than a field, for the same reason as the
 * requirement-override class above: the notification carries no code, and
 * `path`/`range` are `None` on this one (`project_config_warning` sets both).
 * Two independent fragments so a rewording of either half still classifies.
 */
const PROJECT_TRUST_PHRASES = [
  // `app-server/src/lib.rs` — the two halves of the one `concat!`.
  'are disabled in the following folders',
  'until the project is trusted',
] as const;

/**
 * Does this warning mean a project folder's `.codex` layer is off for want of
 * trust?
 */
export function isCodexProjectTrustConfigWarning(params: unknown): boolean {
  const warning = (params ?? {}) as ConfigWarningLike;
  const haystack = `${text(warning.summary)}\n${text(warning.details)}`.toLowerCase();
  return PROJECT_TRUST_PHRASES.some(phrase => haystack.includes(phrase));
}

/**
 * Does this warning mean our projected execpolicy rules are gone?
 *
 * Three detectors, strongest first. The `path` field is the measured one, and
 * `details` repeats the same absolute path, so either carries the file name. The
 * word match on `summary` is the fallback for a reworded message or a version
 * that stops sending `path`, and it is deliberately loose: a warning about
 * codex's OWN bundled rules still means some rule set failed to load, which is
 * worth the louder line rather than the quieter one.
 */
export function isCodexRulesConfigWarning(params: unknown): boolean {
  const warning = (params ?? {}) as ConfigWarningLike;
  const summary = text(warning.summary);
  const haystack = `${summary}\n${text(warning.details)}\n${text(warning.path)}`;
  if (RULES_PATH_FRAGMENTS.some(fragment => haystack.includes(fragment))) return true;
  return /\brules\b/i.test(summary);
}

/**
 * One diagnostic line for one `configWarning`.
 *
 * FOUR classes, and each of the three named ones states the CONSEQUENCE rather
 * than the symptom, because in all three the symptom is the misleading half:
 *
 *  - rules — a reader who sees only "Error parsing rules" concludes that Always
 *    Allow broke, and stops there;
 *  - requirement override (P6.7) — a reader who sees only "Configured value for
 *    `permission_profile` is disallowed by requirements" has no reason to
 *    connect it to the permission mode they picked in the composer, which is
 *    the setting that just stopped being in force;
 *  - project trust (C3.354) — a reader who sees only "…are disabled in the
 *    following folders until the project is trusted" reads a standing guarantee
 *    where codex sent a one-time snapshot, so the row stays on screen saying
 *    "off" after the folder has been trusted and is back on.
 *
 * Rules is tested first: it is the security-floor class, and a rules warning
 * that happened to contain the word "requirements" must still read as the
 * louder one. The three detectors are disjoint on the sentences codex actually
 * sends — the project-trust one contains neither "rules" nor any requirement
 * phrase — so the order beyond that is not load-bearing.
 */
export function describeCodexConfigWarning(params: unknown): string {
  const warning = (params ?? {}) as ConfigWarningLike;
  // 400, not the 200 P3.81 chose. MEASURED against the requirement-override
  // sentence, whose shape codex fixes: it embeds the field, the substituted
  // value, the `ConstraintError` text AND the requirement SOURCE — the path or
  // MDM key that set the policy, which is the one part an operator can act on,
  // and it sits LAST. At 200 the real sentence lost it. This is the narrowing-
  // knob trap in miniature: a bound picked against a short example rather than
  // against the resting length of what it has to hold.
  const summary = bounded(text(warning.summary), 400);
  // P3.118 · the path now carries `:line:column` when codex sent a `range`.
  const location = codexConfigWarningLocation(params);
  const details = bounded(text(warning.details), 500);
  const reported = [summary, location, details].filter(part => part.length > 0).join(' — ')
    || 'no summary, path or details on the notification';
  if (isCodexRulesConfigWarning(params)) {
    return '[codex configWarning] EXECPOLICY RULES DID NOT LOAD — codex fails a rules file open and '
      + 'whole-file, so one bad line drops ALL of them: this session has NO projected non-negotiable '
      + `deny rules and NO durable Always-Allow grants. ${reported}`;
  }
  if (isCodexRequirementOverrideWarning(params)) {
    const field = codexRequirementOverrideField(params);
    return '[codex configWarning] AN ADMINISTRATOR REQUIREMENT OVERRODE THIS SESSION\'S SETTING'
      + `${field ? ` (\`${field}\`)` : ''} — codex did not refuse: it replaced the value this app `
      + 'asked for with the one a deployed requirements.toml requires, and started anyway. If the '
      + 'field is a permission one (approval_policy, permission_profile, default_permissions, '
      + 'sandbox_mode) the session is NOT running under the permission mode the picker shows. '
      + `${reported}`;
  }
  if (isCodexProjectTrustConfigWarning(params)) {
    return '[codex configWarning] A PROJECT FOLDER\'S `.codex` LAYER IS OFF FOR WANT OF TRUST, AS OF '
      + 'THE MOMENT THE CODEX PROCESS STARTED — that folder\'s config.toml, its hooks AND its '
      + 'rules/*.rules exec policies are all out of the stack while the layer is disabled (codex loads '
      + 'exec policies from enabled layers only); its skills still load, which is codex\'s own sentence. '
      + 'THIS LINE IS NEVER RECOMPUTED OR RETRACTED: codex emits it once, at app-server startup. Trust '
      + 'here is this app\'s own project trust, written into the session\'s CODEX_HOME before codex starts '
      + '— `trust_level = "trusted"` for a project trusted in this app, `"untrusted"` for one kept '
      + 'restricted or never trusted — so a trust decision changed in the app later is not re-read by '
      + 'this codex process. '
      + `${reported}`;
  }
  return `[codex configWarning] ${reported}`;
}
