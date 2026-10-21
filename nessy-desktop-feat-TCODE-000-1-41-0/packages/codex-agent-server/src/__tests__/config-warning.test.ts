/**
 * P3.81 (classifier half) — the `configWarning` nothing used to read.
 *
 * The rules params below are VERBATIM from the shipped binary. Captured
 * 2026-08-28 on darwin-arm64 (Apple M1 Pro) from
 * `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`, md5
 * `eb2144664b1c4eb0697b69b4b242b737`, booted against a `CODEX_HOME` built by
 * `writeCodexConfig` with one extra
 * `prefix_rule(pattern=["ls"], decision="nonsense")` appended to the projected
 * `rules/nessy.rules` — only the temp path is shortened. The same shape was
 * observed on darwin-x64 under Rosetta; win32 not executed (P3.62).
 *
 * `path` and `range` were found by reading a live notification, not from the
 * schema snapshot, which is why the classifier prefers `path` and why this file
 * pins the real payload rather than a hand-written approximation.
 */
import { describe, expect, test } from 'bun:test';
import {
  CODEX_CONFIG_WARNING_METHOD,
  codexConfigWarningLocation,
  codexRequirementOverrideField,
  describeCodexConfigWarning,
  isCodexProjectTrustConfigWarning,
  isCodexRequirementOverrideWarning,
  isCodexRulesConfigWarning,
} from '../config-warning.ts';

/** Verbatim, path shortened. */
const RULES_WARNING = {
  summary: 'Error parsing rules; custom rules not applied.',
  details:
    'failed to parse rules file /tmp/p381-malformed-OwaYUC/rules/nessy.rules: starlark error: '
    + 'Traceback (most recent call last):\n'
    + '  * /tmp/p381-malformed-OwaYUC/rules/nessy.rules:3, in <module>\n'
    + '      prefix_rule(pattern=["ls"], decision="nonsense")\n'
    + 'error: invalid decision: nonsense\n'
    + ' --> /tmp/p381-malformed-OwaYUC/rules/nessy.rules:3:1\n',
  path: '/tmp/p381-malformed-OwaYUC/rules/nessy.rules',
  range: { start: { line: 3, column: 1 }, end: { line: 3, column: 49 } },
};

/**
 * The OTHER member of the same channel, and the reason this reports rather than
 * refuses: measured 2026-08-13, a role whose `config_file` is not on disk costs
 * that one role and nothing else.
 */
const ROLE_WARNING = {
  summary: 'Ignoring malformed agent role definition',
  details: 'agents.reviewer.config_file must point to an existing file at /tmp/x/agent-roles/reviewer.toml',
};

describe('the method name', () => {
  /** KILLS: watching for `config/warning`, `configWarnings`, or the v1 spelling. */
  test('is the one on the wire', () => {
    expect(CODEX_CONFIG_WARNING_METHOD).toBe('configWarning');
  });
});

describe('isCodexRulesConfigWarning', () => {
  /** KILLS: dropping the `path` detector, the `details` detector, or both. */
  test('recognises the real rules warning', () => {
    expect(isCodexRulesConfigWarning(RULES_WARNING)).toBe(true);
  });

  test('recognises it from `path` alone, so a reworded summary still lands', () => {
    expect(isCodexRulesConfigWarning({ path: RULES_WARNING.path })).toBe(true);
    expect(isCodexRulesConfigWarning({ summary: 'something else entirely', path: RULES_WARNING.path }))
      .toBe(true);
  });

  test('recognises it from `details` alone, so a version that stops sending `path` still lands', () => {
    expect(isCodexRulesConfigWarning({ details: RULES_WARNING.details })).toBe(true);
  });

  test('recognises the windows separator', () => {
    expect(isCodexRulesConfigWarning({ path: 'C:\\Users\\x\\AppData\\codex\\rules\\nessy.rules' })).toBe(true);
  });

  /**
   * NEGATIVE CONTROL. Without this the three cases above are satisfied by a
   * function that returns `true` for everything, and the loud line would then be
   * printed for every config warning codex has — which is how a warning stops
   * being read.
   */
  test('does NOT claim a role-file warning is a rules warning', () => {
    expect(isCodexRulesConfigWarning(ROLE_WARNING)).toBe(false);
    expect(isCodexRulesConfigWarning({ summary: 'Invalid configuration; using defaults.' })).toBe(false);
  });

  /** KILLS: reading fields off a non-object and throwing inside the line handler. */
  test('survives a notification with nothing on it', () => {
    for (const params of [undefined, null, {}, 'string', 42, { summary: 7, details: [] }]) {
      expect(isCodexRulesConfigWarning(params)).toBe(false);
    }
  });
});

describe('describeCodexConfigWarning', () => {
  /**
   * KILLS: reporting only codex's own summary. "Error parsing rules; custom
   * rules not applied." is the MISLEADING half — a reader stops at "Always Allow
   * broke" and never learns the deny floors went with it.
   */
  test('states the consequence, both halves of it, for a rules warning', () => {
    const line = describeCodexConfigWarning(RULES_WARNING);
    expect(line).toContain('EXECPOLICY RULES DID NOT LOAD');
    expect(line).toContain('whole-file');
    expect(line).toContain('NO projected non-negotiable deny rules');
    expect(line).toContain('NO durable Always-Allow grants');
    // …and still carries codex's own words, so the line is diagnosable.
    expect(line).toContain('Error parsing rules; custom rules not applied.');
    expect(line).toContain('rules/nessy.rules');
    expect(line).toContain('invalid decision: nonsense');
  });

  /** KILLS: printing the loud floors sentence for every warning in the channel. */
  test('reports a non-rules warning WITHOUT the floors sentence', () => {
    const line = describeCodexConfigWarning(ROLE_WARNING);
    expect(line).toContain('[codex configWarning]');
    expect(line).toContain('Ignoring malformed agent role definition');
    expect(line).not.toContain('EXECPOLICY RULES DID NOT LOAD');
  });

  /**
   * KILLS: pasting a multi-line starlark traceback with three absolute paths
   * into a session log unbounded. One line in, one line out.
   */
  test('collapses to a single bounded line', () => {
    const line = describeCodexConfigWarning({
      ...RULES_WARNING,
      details: `${RULES_WARNING.details}${'x'.repeat(5000)}`,
    });
    expect(line.includes('\n')).toBe(false);
    expect(line.length).toBeLessThan(1200);
    expect(line).toContain('…');
  });

  test('says so when the notification carries nothing at all', () => {
    expect(describeCodexConfigWarning({})).toBe(
      '[codex configWarning] no summary, path or details on the notification',
    );
  });
});

/**
 * P6.7 — the requirement-override class.
 *
 * The four payloads below are BUILT FROM THE FORMAT STRINGS IN CODEX'S OWN
 * SOURCE at `rust-v0.148.0` — the tag shipped when this was read; today's is
 * `manifest.json`'s `upstream.tag` — not from a live capture, because
 * producing one needs a deployed `/etc/codex/requirements.toml` on the test
 * machine. Their provenance is therefore STRONG on the sentence and untested on
 * the transport, and that distinction is deliberate rather than glossed:
 *
 *  - `core/src/config/mod.rs:2097`-`:2099` — the constrained-set fallback;
 *  - `core/src/config/requirements.rs:71`-`:73` — the exact-value override;
 *  - `core/src/config/requirements.rs:143`-`:148` — the structured override;
 *  - `core/src/config/requirements.rs:127`-`:133` — the `$CODEX_SQLITE_HOME` one.
 *
 * The transport half is already proven by the rules class: `app-server/src/
 * lib.rs:641`-`:647` pushes EVERY `startup_warnings` entry through the same
 * `ConfigWarningNotification` the live gate already observes.
 */
const CONSTRAINED_FALLBACK = {
  summary:
    'Configured value for `permission_profile` is disallowed by requirements; falling back to '
    + 'required value "read-only". Details: invalid value for `sandbox_mode`: `DangerFullAccess` is '
    + 'not in the allowed set ["ReadOnly", "WorkspaceWrite"] (set by /etc/codex/requirements.toml)',
};

const EXACT_OVERRIDE = {
  summary: 'Configured value for `check_for_update_on_startup` is overridden by the required value false from /etc/codex/requirements.toml.',
};

const STRUCTURED_OVERRIDE = {
  summary: 'Configured values under `feedback` are overridden by requirements from MDM com.openai.codex:requirements.',
};

const ENV_OVERRIDE = {
  summary: 'Environment value for `$CODEX_SQLITE_HOME` is overridden by the required `sqlite_home` value "/var/codex" from /etc/codex/requirements.toml.',
};

describe('isCodexRequirementOverrideWarning', () => {
  /** KILLS: matching only the one sentence someone happened to see first. */
  test('recognises all four sentences codex can push onto startup_warnings', () => {
    expect(isCodexRequirementOverrideWarning(CONSTRAINED_FALLBACK)).toBe(true);
    expect(isCodexRequirementOverrideWarning(EXACT_OVERRIDE)).toBe(true);
    expect(isCodexRequirementOverrideWarning(STRUCTURED_OVERRIDE)).toBe(true);
    expect(isCodexRequirementOverrideWarning(ENV_OVERRIDE)).toBe(true);
  });

  /** KILLS: reading `summary` only — the constraint text can ride in `details`. */
  test('recognises it from `details` alone', () => {
    expect(isCodexRequirementOverrideWarning({
      summary: 'Invalid configuration; using defaults.',
      details: 'Configured value for `approval_policy` is disallowed by requirements; falling back to required value OnRequest.',
    })).toBe(true);
  });

  /**
   * NEGATIVE CONTROL, one assertion per record — `not.toContain` over a list
   * passes when only ONE member is absent, and the same trap applies to a
   * single call that folds several payloads together.
   */
  test('does NOT claim the other members of this channel', () => {
    expect(isCodexRequirementOverrideWarning(RULES_WARNING)).toBe(false);
    expect(isCodexRequirementOverrideWarning(ROLE_WARNING)).toBe(false);
    expect(isCodexRequirementOverrideWarning({ summary: 'Invalid configuration; using defaults.' })).toBe(false);
  });

  test('survives a notification with nothing on it', () => {
    for (const params of [undefined, null, {}, 'string', 42, { summary: 7, details: [] }]) {
      expect(isCodexRequirementOverrideWarning(params)).toBe(false);
    }
  });
});

describe('codexRequirementOverrideField', () => {
  test('names the key codex named', () => {
    expect(codexRequirementOverrideField(CONSTRAINED_FALLBACK)).toBe('permission_profile');
    expect(codexRequirementOverrideField(EXACT_OVERRIDE)).toBe('check_for_update_on_startup');
    expect(codexRequirementOverrideField(STRUCTURED_OVERRIDE)).toBe('feedback');
    expect(codexRequirementOverrideField(ENV_OVERRIDE)).toBe('$CODEX_SQLITE_HOME');
  });

  /** KILLS: an unbounded capture pasting a paragraph into a log line. */
  test('yields nothing rather than a paragraph when the shape changed', () => {
    expect(codexRequirementOverrideField({ summary: 'no backticks here' })).toBeUndefined();
    expect(codexRequirementOverrideField({ summary: `\`${'x'.repeat(200)}\`` })).toBeUndefined();
  });
});

describe('describeCodexConfigWarning — the requirement-override class', () => {
  /**
   * KILLS: echoing codex's sentence unlabelled. The user picked a permission
   * mode; the sentence names a `config.toml` key. Nothing connects the two
   * unless this line does.
   */
  test('says an administrator requirement overrode the setting, and names the field', () => {
    const line = describeCodexConfigWarning(CONSTRAINED_FALLBACK);
    expect(line).toContain('AN ADMINISTRATOR REQUIREMENT OVERRODE THIS SESSION\'S SETTING');
    expect(line).toContain('`permission_profile`');
    expect(line).toContain('NOT running under the permission mode the picker shows');
    // …and codex's own words survive, so the line stays diagnosable.
    expect(line).toContain('is disallowed by requirements');
    expect(line).toContain('/etc/codex/requirements.toml');
  });

  test('still says it when the sentence carries no backticked field', () => {
    const line = describeCodexConfigWarning({
      summary: 'Configured values are overridden by requirements from MDM.',
    });
    expect(line).toContain('AN ADMINISTRATOR REQUIREMENT OVERRODE THIS SESSION\'S SETTING');
    expect(line).not.toContain('()');
  });

  /**
   * KILLS: reordering the two classifiers. The rules class is the security-floor
   * one and must win a payload that satisfies both.
   */
  test('a rules warning that also mentions requirements still reads as the rules class', () => {
    const line = describeCodexConfigWarning({
      ...RULES_WARNING,
      summary: `${RULES_WARNING.summary} Configured value for \`x\` is disallowed by requirements.`,
    });
    expect(line).toContain('EXECPOLICY RULES DID NOT LOAD');
    expect(line).not.toContain('AN ADMINISTRATOR REQUIREMENT OVERRODE');
  });

  /** KILLS: printing the administrator sentence for every warning in the channel. */
  test('a role-file warning gets neither loud sentence', () => {
    const line = describeCodexConfigWarning(ROLE_WARNING);
    expect(line).not.toContain('AN ADMINISTRATOR REQUIREMENT OVERRODE');
    expect(line).not.toContain('EXECPOLICY RULES DID NOT LOAD');
  });

  test('collapses to a single bounded line', () => {
    const line = describeCodexConfigWarning({
      ...CONSTRAINED_FALLBACK,
      details: 'y'.repeat(5000),
    });
    expect(line.includes('\n')).toBe(false);
    expect(line.length).toBeLessThan(1600);
  });
});

/**
 * P3.118 — `range` was on the wire and in this repo's own generated bindings,
 * and read nowhere.
 *
 * `ConfigWarningNotification` declares `path?: string` and `range?: TextRange`
 * (`packages/codex-protocol/generated/v2/`, `rust-v0.148.0`), where
 * `TextPosition` is a 1-based `{ line, column }`. The notice named the file and
 * left the reader to find the offending line by eye — inside a starlark
 * traceback this module deliberately collapses onto one line.
 *
 * The `range` below is VERBATIM from the shipped `darwin-arm64` binary,
 * 2026-09-03, driven over stdio against a `CODEX_HOME` whose
 * `rules/nessy.rules` carried `prefix_rule(pattern=["ls"], decision="nonsense")`
 * — with the clean-rules run as the control (zero `configWarning`).
 */
describe('P3.118 — the location carries `range` as well as `path`', () => {
  const LIVE_RANGE = { start: { line: 1, column: 1 }, end: { line: 1, column: 49 } };

  test('renders `<path>:<line>:<column>` from the live shape', () => {
    expect(codexConfigWarningLocation({ path: '/home/rules/nessy.rules', range: LIVE_RANGE }))
      .toBe('/home/rules/nessy.rules:1:1');
    // …and the classified notice carries it, which is the whole point: the
    // sentence a user sees is where the location has to appear.
    const line = describeCodexConfigWarning({ ...RULES_WARNING, range: LIVE_RANGE });
    expect(line).toContain('rules/nessy.rules:1:1');
  });

  test('degrades rather than throwing on every shape a version bump could send', () => {
    // No range at all — the pre-P3.118 output, unchanged.
    expect(codexConfigWarningLocation({ path: '/a/b.rules' })).toBe('/a/b.rules');
    // No path — nothing to point at, so nothing is emitted (and no bare `:1`).
    expect(codexConfigWarningLocation({ range: LIVE_RANGE })).toBe('');
    expect(codexConfigWarningLocation(null)).toBe('');
    // Partial or wrongly-typed members degrade one step at a time.
    expect(codexConfigWarningLocation({ path: '/a', range: { start: { line: 7 } } })).toBe('/a:7');
    expect(codexConfigWarningLocation({ path: '/a', range: { start: { line: '7', column: 2 } } })).toBe('/a');
    expect(codexConfigWarningLocation({ path: '/a', range: { end: LIVE_RANGE.end } })).toBe('/a');
    expect(codexConfigWarningLocation({ path: '/a', range: 'line 1' })).toBe('/a');
  });

  test('a warning with no location at all still produces the classified sentence', () => {
    // CONTROL for the two above: the location is additive, so removing it must
    // not empty the notice — `summary` and `details` still carry it.
    const line = describeCodexConfigWarning({ summary: RULES_WARNING.summary, details: 'rules broke' });
    expect(line).toContain('EXECPOLICY RULES DID NOT LOAD');
    expect(line).toContain('Error parsing rules');
  });
});

/**
 * C3.354 — the project-trust class, and the sentence that says what codex's own
 * one leaves out.
 *
 * `summary` below is the shape `codex-rs/app-server/src/lib.rs`
 * `project_config_warning` builds at `rust-v0.150.1`: one `concat!` of two
 * literals, then a numbered `<folder>` + trust-reason list. The first literal
 * occurs ONCE in the shipped `darwin-arm64/codex-app-server` (instrument:
 * `grep -aoF … | wc -l`, i.e. OCCURRENCES; negative control
 * `zzz-no-such-needle-zzz` 0, positive control `configWarning` 3, 2026-09-12),
 * so there is exactly one emitter. `details`, `path` and `range` are all `None`
 * on this class — the constructor sets them — which is why the detector is a
 * phrase match and not a field.
 */
describe('C3.354 — the project-trust warning', () => {
  /** Verbatim shape, the folder shortened. */
  const TRUST_WARNING = {
    summary:
      'Project-local config, hooks, and exec policies are disabled in the following folders '
      + 'until the project is trusted, but skills still load.\n'
      + '    1. /tmp/probe-repo/.codex\n'
      + '       This project has not been trusted.\n',
  };

  /** KILLS: dropping either phrase fragment, or keying the detector off `path`. */
  test('is recognised, and the other two classes are not it', () => {
    expect(isCodexProjectTrustConfigWarning(TRUST_WARNING)).toBe(true);
    // The three detectors are disjoint on the sentences codex actually sends —
    // this is the claim the branch order in `describeCodexConfigWarning` rests
    // on, so it is asserted rather than assumed.
    expect(isCodexRulesConfigWarning(TRUST_WARNING)).toBe(false);
    expect(isCodexRequirementOverrideWarning(TRUST_WARNING)).toBe(false);
    // …and the reverse direction, so a widened project-trust phrase list cannot
    // swallow the security-floor class.
    expect(isCodexProjectTrustConfigWarning(RULES_WARNING)).toBe(false);
    expect(isCodexProjectTrustConfigWarning(ROLE_WARNING)).toBe(false);
    expect(isCodexProjectTrustConfigWarning(null)).toBe(false);
  });

  /**
   * KILLS: the pre-C3.354 output, which was the bare
   * `[codex configWarning] <summary>` fall-through — codex's sentence and
   * nothing else, read by a user as a standing guarantee.
   */
  test('the sentence names the rules file, the staleness and the skills carve-out', () => {
    const line = describeCodexConfigWarning(TRUST_WARNING);
    // What is off, including the half codex's own wording leaves implicit: the
    // rules file goes with the layer, because `load_exec_policy` walks
    // `layers_low_to_high()`, which filters disabled layers.
    expect(line).toContain('rules/*.rules');
    // …and what is NOT off, which is codex's own clause.
    expect(line).toContain('skills still load');
    // The staleness — the reason this class needed a sentence at all.
    expect(line).toContain('NEVER RECOMPUTED');
    // F1.750 · the staleness came from codex's own auto-trust, which an explicit entry now stops;
    // the line names the app's trust as the source and that a later change is not re-read.
    expect(line).toContain('not re-read by this codex process');
    // The folder and the trust reason codex sent are still carried through, so
    // the added sentence is additive and never replaces the payload.
    expect(line).toContain('/tmp/probe-repo/.codex');
    expect(line).toContain('This project has not been trusted.');
  });

  /** CONTROL: an unclassified warning still falls through unchanged. */
  test('an unrelated warning is untouched by the new branch', () => {
    const line = describeCodexConfigWarning(ROLE_WARNING);
    expect(line).toContain('[codex configWarning] Ignoring malformed agent role definition');
    expect(line).not.toContain('WANT OF TRUST');
  });
});
