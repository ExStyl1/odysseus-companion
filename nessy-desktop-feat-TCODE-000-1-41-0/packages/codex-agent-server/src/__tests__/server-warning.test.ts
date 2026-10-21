/**
 * P2.408 (classifier half) — the plain `warning` nothing used to read.
 *
 * The payloads below are VERBATIM off the wire. Captured 2026-08-29 on
 * darwin-arm64 (Apple M1 Pro) from
 * `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`
 * (`openai/codex` `rust-v0.148.0`), driven over stdio against scratch
 * `CODEX_HOME`s — only the temp paths are shortened. Four arms:
 *
 * | Arm | `config.toml` | `warning` frames |
 * | --- | --- | --- |
 * | A (negative control) | no `[features]` | 0 |
 * | B | `[features] executed_tool_call_metadata = true` | 1, one name |
 * | C | B + `code_mode = true` | 1, both names, comma-joined and sorted |
 * | D (suppression control) | B + `suppress_unstable_features_warning = true` | 0 |
 *
 * Arms A and D are why B and C mean anything: the frame appears only when an
 * under-development feature is actually live and un-suppressed.
 */
import { describe, expect, test } from 'bun:test';
import {
  CODEX_WARNING_METHOD,
  codexServerWarningNotice,
  codexUnstableFeatureNames,
  describeCodexServerWarning,
  isCodexUnstableFeaturesWarning,
} from '../server-warning.ts';

/** ARM B, verbatim; `CODEX_HOME` path shortened. */
const ONE_FEATURE = {
  threadId: '01a04ea4-95b8-7180-b5b9-cadd3924f7c8',
  message:
    'Under-development features enabled: executed_tool_call_metadata. Under-development features '
    + 'are incomplete and may behave unpredictably. To suppress this warning, set '
    + '`suppress_unstable_features_warning = true` in /tmp/p2408-home-fINkPw/config.toml.',
};

/** ARM C, verbatim; `CODEX_HOME` path shortened. Note codex sorts the names. */
const TWO_FEATURES = {
  threadId: '01a04ea4-b0b3-7ae3-8bb8-a51e2f4eded4',
  message:
    'Under-development features enabled: code_mode, executed_tool_call_metadata. '
    + 'Under-development features are incomplete and may behave unpredictably. To suppress this '
    + 'warning, set `suppress_unstable_features_warning = true` in /tmp/p2408-home-56ETe8/config.toml.',
};

/**
 * A warning of some OTHER class. Not captured — the emitter set for this channel
 * is not enumerated (see `server-warning.ts`) — so this stands for "anything we
 * cannot name", and the assertion on it is that it is RELAYED, never dropped.
 */
const UNCLASSIFIED = { threadId: 't', message: 'Something else entirely happened.' };

describe('the method name', () => {
  /** KILLS: watching for `warnings`, `server/warning`, or `configWarning`. */
  test('is the one on the wire', () => {
    expect(CODEX_WARNING_METHOD).toBe('warning');
  });
});

describe('isCodexUnstableFeaturesWarning', () => {
  /** KILLS: any marker that does not match the real sentence codex sends. */
  test('recognises both real frames', () => {
    expect(isCodexUnstableFeaturesWarning(ONE_FEATURE)).toBe(true);
    expect(isCodexUnstableFeaturesWarning(TWO_FEATURES)).toBe(true);
  });

  /** KILLS: a detector so loose that every warning becomes this class. */
  test('does not claim a warning of another class', () => {
    expect(isCodexUnstableFeaturesWarning(UNCLASSIFIED)).toBe(false);
    expect(isCodexUnstableFeaturesWarning({ message: 'features are enabled' })).toBe(false);
  });

  /** KILLS: a throw inside the transport's line handler on a malformed payload. */
  test('survives every degenerate payload', () => {
    for (const params of [undefined, null, {}, 'nope', 42, { message: 7 }, { message: null }]) {
      expect(isCodexUnstableFeaturesWarning(params)).toBe(false);
    }
  });
});

describe('codexUnstableFeatureNames', () => {
  /** KILLS: reading past the sentence end, or not splitting the list. */
  test('reads the names codex sent', () => {
    expect(codexUnstableFeatureNames(ONE_FEATURE)).toEqual(['executed_tool_call_metadata']);
    expect(codexUnstableFeatureNames(TWO_FEATURES)).toEqual(['code_mode', 'executed_tool_call_metadata']);
  });

  /** KILLS: emitting the whole trailing sentence as if it were a feature name. */
  test('never returns the prose that follows the list', () => {
    for (const name of codexUnstableFeatureNames(TWO_FEATURES)) {
      expect(name).toMatch(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/);
    }
  });

  /**
   * A DOTTED name, which `rust-v0.154.0` made real (`guardianv2.thread_context`,
   * the first of the binary's 140 names outside `[a-z0-9_]+`).
   *
   * KILLS the regression this case was born from, and it is the dangerous
   * direction: the old parser stopped at the FIRST `.` in the tail, which for a
   * dotted name is inside the name, so it returned `guardianv2` — a feature that
   * does not exist — rather than returning nothing. The negative arm is the pair
   * to it: the trailing sentence must still be cut, and the cut is now "a `.`
   * followed by whitespace or the end", which the internal dot never is.
   */
  test('keeps a dotted feature name whole, and still cuts the sentence after it', () => {
    const dotted = {
      message:
        'Under-development features enabled: guardianv2.thread_context. Under-development features '
        + 'are incomplete and may behave unpredictably. To suppress this warning, set '
        + '`suppress_unstable_features_warning = true` in /tmp/home/config.toml.',
    };
    expect(codexUnstableFeatureNames(dotted)).toEqual(['guardianv2.thread_context']);
    const mixed = {
      message: 'Under-development features enabled: code_mode, guardianv2.thread_context. Trailing prose.',
    };
    expect(codexUnstableFeatureNames(mixed)).toEqual(['code_mode', 'guardianv2.thread_context']);
  });

  /**
   * KILLS: widening the shape far enough to let the trailing prose through.
   *
   * Every rejected part here is rejected for its OWN reason, so a single
   * over-wide edit cannot pass them all: a space, a hyphen, a leading dot, a
   * doubled dot, a trailing dot. Written against codex's real template (read
   * from the shipped binary's format string), whose sentence after the list
   * begins *"Under-development features are incomplete…"* — every word of which
   * is space-separated and therefore already disqualified.
   */
  test('a dot does not buy prose a way in', () => {
    expect(codexUnstableFeatureNames({
      message:
        'Under-development features enabled: ok.one, not a name, bad-name, .leading, two..dots, trailing.. '
        + 'Under-development features are incomplete and may behave unpredictably.',
    })).toEqual(['ok.one']);
  });

  /** KILLS: dropping the character restriction, i.e. letting a payload smuggle text through. */
  test('refuses a name that is not an identifier, and bounds the count', () => {
    expect(codexUnstableFeatureNames({
      message: 'Under-development features enabled: ok_one, not a name, ok_two.',
    })).toEqual(['ok_one', 'ok_two']);
    const many = Array.from({ length: 40 }, (_, i) => `f_${i}`).join(', ');
    expect(codexUnstableFeatureNames({ message: `Under-development features enabled: ${many}.` }))
      .toHaveLength(24);
  });

  /** KILLS: returning names for a warning that is not this class. */
  test('is empty for another class and for junk', () => {
    expect(codexUnstableFeatureNames(UNCLASSIFIED)).toEqual([]);
    expect(codexUnstableFeatureNames(null)).toEqual([]);
  });
});

describe('describeCodexServerWarning — the developer channel, full fidelity', () => {
  /**
   * KILLS: a line that reports the symptom without the consequence, or that
   * loses the feature names, or that truncates away codex's own sentence.
   */
  test('names the consequence, the features, AND relays codex verbatim', () => {
    const line = describeCodexServerWarning(TWO_FEATURES);
    expect(line).toContain('[codex warning]');
    expect(line).toContain('UNDER-DEVELOPMENT FEATURES ARE LIVE');
    expect(line).toContain('code_mode, executed_tool_call_metadata');
    // The suppression clause stays HERE — the operator sentence is the one that drops it.
    expect(line).toContain('suppress_unstable_features_warning');
  });

  /** KILLS: dropping an unclassified warning, which is the defect this row exists to fix. */
  test('relays a warning it cannot classify rather than swallowing it', () => {
    expect(describeCodexServerWarning(UNCLASSIFIED))
      .toBe('[codex warning] Something else entirely happened.');
  });

  /** KILLS: a throw, or an empty line with no explanation, on a payload with no message. */
  test('degrades to a shorter line, never to a throw', () => {
    expect(describeCodexServerWarning({})).toBe('[codex warning] no message on the notification');
    expect(describeCodexServerWarning(null)).toBe('[codex warning] no message on the notification');
  });
});

describe('codexServerWarningNotice — the operator sentence', () => {
  /**
   * KILLS: relaying codex's "set `suppress_unstable_features_warning = true`"
   * advice into a transcript. That key is one of the four P2.384 pinned
   * unwritten, and all four are schema-valid, so nothing downstream would catch
   * an operator who followed the suggestion.
   */
  test('states the consequence and does NOT repeat the suppression advice', () => {
    const notice = codexServerWarningNotice(TWO_FEATURES);
    expect(notice).toContain('under development');
    expect(notice).toContain('code_mode, executed_tool_call_metadata');
    expect(notice).not.toContain('suppress_unstable_features_warning');
  });

  /** KILLS: a notice that says nothing about which features are live. */
  test('names a single feature too', () => {
    expect(codexServerWarningNotice(ONE_FEATURE)).toContain('executed_tool_call_metadata');
  });

  /** KILLS: dropping an unclassified warning from the surface a human reads. */
  test('relays an unclassified warning to the operator', () => {
    expect(codexServerWarningNotice(UNCLASSIFIED)).toBe('Codex: Something else entirely happened.');
  });

  /**
   * KILLS: surfacing an empty transcript row. Mirrors the event adapter's
   * `guardianWarning` branch, which drops an empty one.
   */
  test('is null when there is nothing to say', () => {
    expect(codexServerWarningNotice({})).toBeNull();
    expect(codexServerWarningNotice({ message: '   ' })).toBeNull();
    expect(codexServerWarningNotice(undefined)).toBeNull();
  });
});
