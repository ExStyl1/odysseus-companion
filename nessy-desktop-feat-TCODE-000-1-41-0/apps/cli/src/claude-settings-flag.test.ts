import { describe, expect, it } from 'bun:test'

import {
  CLAUDE_FLAG_SETTINGS_ENV_VAR,
  CLAUDE_SETTING_SOURCES_ENV_VAR,
} from '@nessy-agent/shared/config/claude-flag-settings'
import { CLAUDE_BARE_FLAG_NOTICE, parseArgs } from './index.ts'

function parse(...argv: string[]) {
  return parseArgs(['bun', 'nessy-general-agent', ...argv])
}

/**
 * P6.439 clause (1) — the CLI half of `--settings`.
 *
 * `cli-reference.md#cli-flags`: *"Path to a settings JSON file or an inline JSON
 * string. Values you set here override the same keys in your `settings.json`
 * files for this session."* The host does not layer that: `Options.settings` is
 * the SDK's own flag-settings tier and the claude child applies its documented
 * precedence. What this side owes is that the value the user typed survives
 * parsing intact, and that the env twin works without the flag — the shape
 * `--safe-mode` and `--fallback-model` already use, and the reason is the same:
 * the tier is applied by the claude child, which the SERVER spawns, so the value
 * has to reach that process rather than this one.
 */
describe('P6.439 · --settings reaches the server env', () => {
  it('takes a path and an inline JSON string, raw as typed', () => {
    expect(parse('--settings', '/etc/nessy/settings.json').claudeSettings)
      .toBe('/etc/nessy/settings.json')
    // Inline JSON is NOT parsed here. The resolver on the far side is the one
    // place that decides path-vs-object, and parsing in two places is how the
    // two spellings drift.
    const inline = '{"permissions":{"deny":["Bash(rm *)"]}}'
    expect(parse('--settings', inline).claudeSettings).toBe(inline)
  })

  it('is not an unknown flag, and its value is not swallowed as a positional', () => {
    // The parser errors on any unrecognized dash-leading token, so a flag added
    // without a `case` reaches the user as an error rather than silently. And
    // the VALUE must be consumed: a path left in `rest` would be concatenated
    // into a `run` prompt, which is the regression the unknown-flag gate exists
    // for.
    const args = parse('run', '--settings', '/etc/nessy/settings.json', 'hello')
    expect(args.unknownFlags).toEqual([])
    expect(args.rest).toEqual(['hello'])
  })

  it('falls back to the env twin, so an inherited value configures the tier without the flag', () => {
    const previous = process.env[CLAUDE_FLAG_SETTINGS_ENV_VAR]
    try {
      // `delete` first, then assign — Bun 1.3.14 leaves an assigned-over name
      // invisible to `Object.keys` and to a `{...process.env}` spread, which is
      // how every subprocess env in this tree is built (AGENTS.md §Traps).
      delete process.env[CLAUDE_FLAG_SETTINGS_ENV_VAR]
      process.env[CLAUDE_FLAG_SETTINGS_ENV_VAR] = '/inherited/settings.json'
      expect(parse().claudeSettings).toBe('/inherited/settings.json')
      // …and the flag WINS over the inherited value, which is the precedence
      // every other flag/env pair in this parser uses.
      expect(parse('--settings', '/explicit.json').claudeSettings).toBe('/explicit.json')
    } finally {
      delete process.env[CLAUDE_FLAG_SETTINGS_ENV_VAR]
      if (previous !== undefined) process.env[CLAUDE_FLAG_SETTINGS_ENV_VAR] = previous
    }
  })

  it('reports nothing when neither the flag nor the env var is set', () => {
    // THE BOUNDARY. An empty string is what the spawn site tests for, so an
    // unset flag must not put the key into the child env at all.
    const previous = process.env[CLAUDE_FLAG_SETTINGS_ENV_VAR]
    try {
      delete process.env[CLAUDE_FLAG_SETTINGS_ENV_VAR]
      expect(parse().claudeSettings).toBe('')
    } finally {
      if (previous !== undefined) process.env[CLAUDE_FLAG_SETTINGS_ENV_VAR] = previous
    }
  })
})

/**
 * P6.930 clauses (2) and (3) — the CLI half of the two claude postures.
 *
 * (2) `--setting-sources` narrows the SDK's own `settingSources`; the parse and
 * the sentence naming what a narrowing dropped both live in
 * `@nessy-agent/shared/config/claude-flag-settings`, so this side owes only that
 * the value survives parsing, reaches the server through the env twin, and is
 * not swallowed as a positional.
 *
 * (3) `--bare` is accepted and applied to nothing. The point of the `case` is
 * that a user following `cli-reference.md` is not met with an unknown flag, and
 * the point of the notice is that they are not left believing it took.
 */
describe('P6.930 · --setting-sources and --bare', () => {
  it('takes the list raw as typed, including the empty-list word', () => {
    expect(parse('--setting-sources', 'user,project').claudeSettingSources).toBe('user,project')
    // NOT parsed here: the resolver on the far side is the one place that reads
    // the list, and two parsers are how two spellings drift.
    expect(parse('--setting-sources', 'none').claudeSettingSources).toBe('none')
  })

  it('is not an unknown flag, and neither is --bare', () => {
    const args = parse('run', '--setting-sources', 'user', '--bare', 'hello')
    expect(args.unknownFlags).toEqual([])
    // THE CLAUSE (3) BOUNDARY: without a `case`, `--bare` is an unknown flag and
    // the run refuses to start — which is the outcome the row exists to avoid.
    expect(args.bare).toBe(true)
    expect(args.rest).toEqual(['hello'])
  })

  it('leaves both off when nothing is passed', () => {
    const previous = process.env[CLAUDE_SETTING_SOURCES_ENV_VAR]
    try {
      delete process.env[CLAUDE_SETTING_SOURCES_ENV_VAR]
      expect(parse().claudeSettingSources).toBe('')
      expect(parse().bare).toBe(false)
    } finally {
      if (previous !== undefined) process.env[CLAUDE_SETTING_SOURCES_ENV_VAR] = previous
    }
  })

  it('falls back to the env twin, and the flag wins over it', () => {
    const previous = process.env[CLAUDE_SETTING_SOURCES_ENV_VAR]
    try {
      // `delete` first, then assign — Bun 1.3.14 leaves an assigned-over name
      // invisible to a `{...process.env}` spread, which is how the server env is
      // built (AGENTS.md §Traps).
      delete process.env[CLAUDE_SETTING_SOURCES_ENV_VAR]
      process.env[CLAUDE_SETTING_SOURCES_ENV_VAR] = 'user'
      expect(parse().claudeSettingSources).toBe('user')
      expect(parse('--setting-sources', 'none').claudeSettingSources).toBe('none')
    } finally {
      delete process.env[CLAUDE_SETTING_SOURCES_ENV_VAR]
      if (previous !== undefined) process.env[CLAUDE_SETTING_SOURCES_ENV_VAR] = previous
    }
  })

  it('refuses the alias in words, quoting the page that denies the equivalence', () => {
    // THE NEGATIVE for clause (3): the owner's decision was NOT an alias, so the
    // notice has to say what `--bare` is, that it did nothing, and what the two
    // real alternatives are. Pinned on the sentence the vendor page uses to
    // separate the two flags, so softening the refusal into an alias cannot pass.
    expect(CLAUDE_BARE_FLAG_NOTICE).toContain('NOT applied')
    expect(CLAUDE_BARE_FLAG_NOTICE).toContain('which differs from --bare')
    expect(CLAUDE_BARE_FLAG_NOTICE).toContain('--safe-mode')
    expect(CLAUDE_BARE_FLAG_NOTICE).toContain('--setting-sources none')
  })
})
