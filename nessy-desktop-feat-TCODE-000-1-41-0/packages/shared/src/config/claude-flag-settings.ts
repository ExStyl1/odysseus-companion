/**
 * P6.439 clause (1) — `--settings`, the flag-settings TIER.
 *
 * `cli-reference.md#cli-flags`, the `--settings` row verbatim: *"Path to a
 * settings JSON file or an inline JSON string. Values you set here override the
 * same keys in your `settings.json` files for this session. Keys you omit keep
 * their file-based values. The file must be a regular file no larger than 2
 * MiB."*
 *
 * ## Native-first: this is CONFIGURATION, not construction
 *
 * The row's own native clause said so and the vendored SDK confirms it —
 * `Options.settings?: string | Settings`, documented as *"Additional settings to
 * apply. Accepts either a path to a settings JSON file or a settings object.
 * These are loaded into the 'flag settings' layer, which has the highest
 * priority among user-controlled settings. Equivalent to the `--settings` CLI
 * flag."* So the row's `done_means` — above user/project/local, below managed —
 * is the SDK's own tier, not something the host layers itself. Nothing here
 * merges, orders or filters: the value is handed over and the child applies its
 * documented precedence.
 *
 * ## Why an env var, and not a new transport
 *
 * The same shape `--safe-mode` and `--fallback-model` already use: the flag is
 * recorded by `apps/cli`, exported before the server is spawned, and read on the
 * far side where the option is actually built. The alternative — a new field on
 * the RPC connection payload — would be a wire change for a session-scoped flag
 * that is spent once at spawn, which is more code for the same effect.
 *
 * ## The one thing this module decides, and it is forced by the SDK's type
 *
 * `string | Settings` is ambiguous over a single env var: a JSON object handed
 * over as a string would be read as a PATH and the child would look for a file
 * named `{"model":…}`. So the discriminant is the first non-space character —
 * `{` means inline JSON and is parsed here; anything else is a path and is
 * passed through untouched. That is the same rule the documented flag states
 * ("a settings JSON file or an inline JSON string") and it is the only reading
 * that can distinguish them without asking the filesystem.
 *
 * **Malformed inline JSON is DROPPED with a diagnostic rather than thrown.**
 * An unparseable value is a typo in a flag, and failing the session start for it
 * would turn a mistyped convenience into an outage; the diagnostic is what keeps
 * it from being silent. A PATH is deliberately not validated here — existence,
 * regular-file-ness and the 2 MiB ceiling are the child's own checks, and
 * duplicating them would give two answers to one question.
 */

/** The env var carrying `--settings` from `apps/cli` to the claude backend. */
export const CLAUDE_FLAG_SETTINGS_ENV_VAR = 'NESSY_CLAUDE_SETTINGS';

/**
 * The documented Claude spelling has no env twin — `--settings` is flag-only on
 * `cli-reference.md` — so there is no compat alias to accept, unlike
 * {@link import('./safe-mode.ts').SAFE_MODE_COMPAT_ENV_VAR}. Recorded because
 * the absence looks like an omission beside its two siblings.
 */

type EnvRecord = Record<string, string | undefined>;

/** What {@link resolveClaudeFlagSettings} answers with. */
export type ClaudeFlagSettings = string | Record<string, unknown>;

export function resolveClaudeFlagSettings(
  env: EnvRecord = process.env,
  onDiagnostic?: (message: string) => void,
): ClaudeFlagSettings | undefined {
  const raw = env[CLAUDE_FLAG_SETTINGS_ENV_VAR]?.trim();
  if (!raw) return undefined;
  if (!raw.startsWith('{')) return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    // An array or a scalar parses fine and is not a settings object; handing one
    // to the SDK would be a type lie that only fails inside the child.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      onDiagnostic?.(
        `[${CLAUDE_FLAG_SETTINGS_ENV_VAR}] ignored: inline settings must be a JSON object.`,
      );
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    onDiagnostic?.(
      `[${CLAUDE_FLAG_SETTINGS_ENV_VAR}] ignored: inline settings are not valid JSON `
      + `(${error instanceof Error ? error.message : String(error)}).`,
    );
    return undefined;
  }
}

/**
 * P6.930 clause (2) — `--setting-sources`, the NARROWABLE filesystem tier.
 *
 * NATIVE-FIRST, tier 1 like its sibling above: the SDK owns the mechanism and
 * the shipped binary carries the flag.
 * `agent-sdk/claude-code-features.md#control-filesystem-settings-with-settingsources`,
 * read 2026-09-10, verbatim: *"The setting sources option … controls which
 * filesystem-based settings the SDK loads. Pass an explicit list to opt in to
 * specific sources, or pass an empty array to disable user, project, and local
 * settings."*, and *"Omitting `settingSources` is equivalent to `["user",
 * "project", "local"]`."* The host hands the list over; nothing here merges,
 * orders or re-implements a source, and the child applies its own semantics.
 *
 * ## The empty list needs a WORD, and it is the only invented token here
 *
 * `[]` is a documented value — disabling user/project/local is the option's
 * whole point — and an env var set to the empty string is indistinguishable
 * from one that was never set. So the empty list is spelled `none`. Invented
 * because the transport cannot otherwise carry a documented value, stated in the
 * CLI's own help text, and nowhere else in the resolution.
 *
 * ## Narrowing is not only a settings decision, which is why it is SAID
 *
 * `permissions.md` §"Additional directories grant file access, not
 * configuration", read 2026-09-10, verbatim: *"Skills, commands, and subagents
 * from any flag-added directory load through the `project` setting source, so
 * they don't load when you exclude that source with `--setting-sources` on the
 * CLI or `settingSources` in the SDK, and bare mode skips the commands and
 * subagents among them."* — that is P6.34's `--add-dir` roots, silently turned
 * off. The vendored `sdk.d.ts` adds the other one on the option itself: *"Must
 * include `'project'` to load CLAUDE.md files."* And dropping `user` drops the
 * user's own `allow`/`ask`/`deny` rules, which `claude-agent.ts`'s R3 callback
 * deliberately stopped pre-empting so that the SDK would apply them.
 *
 * So {@link claudeSettingSourcesNarrowingNotice} names what a narrowing dropped,
 * ONCE, where a human reads it. A narrowing that only shows up as a missing
 * skill three turns later is indistinguishable from a defect — which is the
 * reason the owner's decision (2026-09-10, balance rule) took clause (2) *with*
 * the diagnostic rather than the flag alone.
 */
export const CLAUDE_SETTING_SOURCES_ENV_VAR = 'NESSY_CLAUDE_SETTING_SOURCES';

/** The three documented sources, in the order the page lists them. */
export const CLAUDE_SETTING_SOURCES = ['user', 'project', 'local'] as const;

/** One documented filesystem settings source. Mirrors the SDK's `SettingSource`. */
export type ClaudeSettingSource = (typeof CLAUDE_SETTING_SOURCES)[number];

/** The word that carries the documented EMPTY list across an env var. */
export const CLAUDE_SETTING_SOURCES_NONE = 'none';

/**
 * The resolved list, or `undefined` to keep the documented default triple.
 *
 * FAIL-OPEN-TO-THE-DEFAULT, deliberately, and it is the opposite reflex from
 * most gates in this tree: a value with no recognisable source in it is a typo
 * in a flag, and reading a typo as `[]` would silently isolate the session from
 * every settings file the user has — a far larger change than the one they
 * mistyped. The empty list has its own explicit word, so nothing is lost by
 * refusing to infer it.
 */
export function resolveClaudeSettingSources(
  env: EnvRecord = process.env,
  onDiagnostic?: (message: string) => void,
): ClaudeSettingSource[] | undefined {
  const raw = env[CLAUDE_SETTING_SOURCES_ENV_VAR]?.trim();
  if (!raw) return undefined;
  if (raw.toLowerCase() === CLAUDE_SETTING_SOURCES_NONE) {
    const emptied = claudeSettingSourcesNarrowingNotice([]);
    if (emptied) onDiagnostic?.(emptied);
    return [];
  }

  const kept: ClaudeSettingSource[] = [];
  const unknown: string[] = [];
  for (const part of raw.split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean)) {
    const known = CLAUDE_SETTING_SOURCES.find(source => source === part);
    if (!known) unknown.push(part);
    else if (!kept.includes(known)) kept.push(known);
  }
  if (unknown.length > 0) {
    onDiagnostic?.(
      `[${CLAUDE_SETTING_SOURCES_ENV_VAR}] ignored ${unknown.join(', ')}: the documented sources are `
      + `${CLAUDE_SETTING_SOURCES.join(', ')} (or "${CLAUDE_SETTING_SOURCES_NONE}" for the empty list).`,
    );
  }
  if (kept.length === 0) {
    onDiagnostic?.(
      `[${CLAUDE_SETTING_SOURCES_ENV_VAR}] ignored: no documented source named, keeping `
      + `${CLAUDE_SETTING_SOURCES.join(', ')}.`,
    );
    return undefined;
  }
  // Sorted into the documented order rather than the order typed: the option is
  // a SET to the child, and a stable order keeps `claudeLiveSessionSignature`
  // from respawning over `project,user` versus `user,project`.
  const ordered = CLAUDE_SETTING_SOURCES.filter(source => kept.includes(source));
  const notice = claudeSettingSourcesNarrowingNotice(ordered);
  if (notice) onDiagnostic?.(notice);
  return [...ordered];
}

/**
 * ONE sentence naming what a narrowed list stopped loading, or `undefined` when
 * nothing was narrowed.
 *
 * Pure, so the CLI can say it once to a human before the run starts and the
 * backend can repeat it into `debug()` for a session that inherited the env var
 * without passing the flag.
 */
export function claudeSettingSourcesNarrowingNotice(
  sources: readonly ClaudeSettingSource[],
): string | undefined {
  const dropped = CLAUDE_SETTING_SOURCES.filter(source => !sources.includes(source));
  if (dropped.length === 0) return undefined;

  const riders: Record<ClaudeSettingSource, string> = {
    user: "user — your own ~/.claude/settings.json allow/ask/deny rules and ~/.claude/CLAUDE.md",
    project: 'project — the skills, commands and subagents from every --add-dir root load through this '
      + "source, so they stop loading; the project's own allow/ask/deny rules and CLAUDE.md go with it",
    local: 'local — CLAUDE.local.md',
  };
  const kept = sources.length === 0
    ? 'nothing (the empty list)'
    : sources.join(', ');
  return `claude settings sources narrowed to ${kept}. No longer loaded: `
    + `${dropped.map(source => riders[source]).join('; ')}.`;
}
