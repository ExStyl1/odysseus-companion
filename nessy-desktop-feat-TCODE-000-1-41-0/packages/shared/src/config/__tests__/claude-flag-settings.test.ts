import { describe, expect, it } from 'bun:test';
import {
  CLAUDE_FLAG_SETTINGS_ENV_VAR,
  CLAUDE_SETTING_SOURCES_ENV_VAR,
  CLAUDE_SETTING_SOURCES_NONE,
  claudeSettingSourcesNarrowingNotice,
  resolveClaudeFlagSettings,
  resolveClaudeSettingSources,
} from '../claude-flag-settings.ts';

/**
 * P6.439 clause (1) — the resolver, and the one decision it makes.
 *
 * `Options.settings` is `string | Settings`, which is ambiguous over a single
 * env var: an inline JSON object handed across as a string would be read by the
 * child as a PATH, and it would go looking for a file literally named
 * `{"model":…}`. The discriminant is the first non-space character.
 */
describe('resolveClaudeFlagSettings', () => {
  it('reads a path through untouched', () => {
    expect(resolveClaudeFlagSettings({ [CLAUDE_FLAG_SETTINGS_ENV_VAR]: '  /etc/nessy/settings.json  ' }))
      .toBe('/etc/nessy/settings.json');
    // Deliberately NOT validated here: existence, regular-file-ness and the
    // documented 2 MiB ceiling are the child's own checks, and two answers to
    // one question is worse than one answer in the right place.
    expect(resolveClaudeFlagSettings({ [CLAUDE_FLAG_SETTINGS_ENV_VAR]: '/no/such/file.json' }))
      .toBe('/no/such/file.json');
  });

  it('parses an inline object, because a JSON string would be read as a path', () => {
    expect(resolveClaudeFlagSettings({
      [CLAUDE_FLAG_SETTINGS_ENV_VAR]: '{"permissions":{"deny":["Bash(rm *)"]}}',
    })).toEqual({ permissions: { deny: ['Bash(rm *)'] } });
  });

  it('answers undefined for an unset or empty value', () => {
    expect(resolveClaudeFlagSettings({})).toBeUndefined();
    expect(resolveClaudeFlagSettings({ [CLAUDE_FLAG_SETTINGS_ENV_VAR]: '   ' })).toBeUndefined();
  });

  it('DROPS malformed inline JSON with a diagnostic instead of throwing', () => {
    // THE NEGATIVE. An unparseable value is a typo in a flag; failing the
    // session start for it would turn a mistyped convenience into an outage.
    // The diagnostic is what keeps the drop from being silent, so it is
    // asserted rather than the absence alone.
    const said: string[] = [];
    expect(resolveClaudeFlagSettings(
      { [CLAUDE_FLAG_SETTINGS_ENV_VAR]: '{"permissions":' },
      message => said.push(message),
    )).toBeUndefined();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(CLAUDE_FLAG_SETTINGS_ENV_VAR);
  });

  it('DROPS a JSON array or scalar, which parses fine and is not a settings object', () => {
    // The boundary the `startsWith('{')` rule does not cover on its own: a
    // value that parses is not necessarily a `Settings`, and handing the SDK an
    // array would be a type lie that only fails inside the child.
    const said: string[] = [];
    expect(resolveClaudeFlagSettings({ [CLAUDE_FLAG_SETTINGS_ENV_VAR]: '{"a":1}' }, m => said.push(m)))
      .toEqual({ a: 1 });
    expect(said).toEqual([]);
    // `[1,2]` does not start with `{`, so it is a PATH by the rule above — odd
    // as a path, and still the honest reading, because the flag documents
    // exactly two shapes and this is not the object one.
    expect(resolveClaudeFlagSettings({ [CLAUDE_FLAG_SETTINGS_ENV_VAR]: '[1,2]' })).toBe('[1,2]');
    // `{}`-leading but null-valued: parses, is not an object, is dropped aloud.
    expect(resolveClaudeFlagSettings({ [CLAUDE_FLAG_SETTINGS_ENV_VAR]: '{}'.replace('{}', '{"x":1}') }))
      .toEqual({ x: 1 });
  });
});

/**
 * P6.930 clause (2) — the narrowable filesystem tier, and the sentence that
 * makes narrowing legible.
 *
 * `agent-sdk/claude-code-features.md#control-filesystem-settings-with-settingsources`:
 * *"Pass an explicit list to opt in to specific sources, or pass an empty array
 * to disable user, project, and local settings."* The list is the SDK's; what
 * this side owes is a faithful parse, a documented spelling for the EMPTY list
 * (an env var cannot carry it otherwise), and a diagnostic naming what a
 * narrowing stopped loading — which is the half the owner's decision took the
 * clause WITH.
 */
describe('resolveClaudeSettingSources', () => {
  const env = (value: string) => ({ [CLAUDE_SETTING_SOURCES_ENV_VAR]: value });

  it('keeps the documented default when the flag is unset', () => {
    expect(resolveClaudeSettingSources({})).toBeUndefined();
    expect(resolveClaudeSettingSources(env('   '))).toBeUndefined();
  });

  it('narrows to the sources named, in the documented order, and says what it dropped', () => {
    const said: string[] = [];
    expect(resolveClaudeSettingSources(env('project, user'), message => said.push(message)))
      .toEqual(['user', 'project']);
    // Ordered, not as typed: the option is a SET to the child, and a stable
    // order keeps `claudeLiveSessionSignature` from respawning over a reorder.
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('local');
  });

  it('names BOTH riders when `project` is the source that was dropped', () => {
    // The two the row is about: P6.34's `--add-dir` roots — `permissions.md`
    // says their skills, commands and subagents *"load through the `project`
    // setting source"* — and the rules the SDK applies from the settings files.
    const said: string[] = [];
    expect(resolveClaudeSettingSources(env('user'), message => said.push(message))).toEqual(['user']);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('--add-dir');
    expect(said[0]).toContain('allow/ask/deny');
  });

  it('carries the documented EMPTY list under its own word', () => {
    // `[]` is a documented value and an empty env var is indistinguishable from
    // an unset one, so the empty list is spelled. It is announced too: this is
    // the widest narrowing there is.
    const said: string[] = [];
    expect(resolveClaudeSettingSources(env(CLAUDE_SETTING_SOURCES_NONE), m => said.push(m))).toEqual([]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('nothing');
  });

  it('KEEPS ALL THREE on a typo, rather than reading it as isolation', () => {
    // THE NEGATIVE, and the reflex is deliberately the opposite of most gates
    // here: reading an unrecognised value as `[]` would silently cut the session
    // off from every settings file the user has — a far larger change than the
    // one they mistyped. The diagnostic is what keeps the refusal from being
    // silent.
    const said: string[] = [];
    expect(resolveClaudeSettingSources(env('porject'), message => said.push(message))).toBeUndefined();
    expect(said).toHaveLength(2);
    expect(said[0]).toContain('porject');
    expect(said[1]).toContain('user, project, local');
    // A recognised source beside the typo survives, and only the typo is dropped.
    const alsoSaid: string[] = [];
    expect(resolveClaudeSettingSources(env('user,porject'), message => alsoSaid.push(message)))
      .toEqual(['user']);
    expect(alsoSaid.some(message => message.includes('porject'))).toBe(true);
  });

  it('says nothing at all when the list was not narrowed', () => {
    const said: string[] = [];
    expect(resolveClaudeSettingSources(env('local,user,project'), message => said.push(message)))
      .toEqual(['user', 'project', 'local']);
    expect(said).toEqual([]);
    expect(claudeSettingSourcesNarrowingNotice(['user', 'project', 'local'])).toBeUndefined();
  });
});
