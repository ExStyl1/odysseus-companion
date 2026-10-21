/**
 * C3.69 — the resolver that hands the SDK its own never-persist switch.
 *
 * Unit half. The BEHAVIOUR half — that the vendor really stops writing
 * `<projectKey>/<sdkSessionId>.jsonl` when the option is passed — cannot be
 * settled by a table of booleans and lives in `claude-persist-session-e2e.test.ts`,
 * which drives the real binary against a loopback stub.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveClaudeSessionPersistence } from '../claude-session-persistence.ts';
import {
  SKIP_PROMPT_HISTORY_COMPAT_ENV_VAR,
  SKIP_PROMPT_HISTORY_ENV_VAR,
} from '../../config/skip-prompt-history.ts';

describe('C3.69 · resolveClaudeSessionPersistence', () => {
  it('POSITIVE: the setting alone turns the SDK switch off', () => {
    expect(resolveClaudeSessionPersistence({ neverPersistSetting: true, env: {} }))
      .toEqual({ persistSession: false });
  });

  it('POSITIVE: either documented env spelling turns it off with the setting unset', () => {
    // Both names, because `isSkipPromptHistoryEnabled` is the one reader and a
    // caller could plausibly be wired to only one of them.
    for (const name of [SKIP_PROMPT_HISTORY_ENV_VAR, SKIP_PROMPT_HISTORY_COMPAT_ENV_VAR]) {
      expect({ name, resolved: resolveClaudeSessionPersistence({ neverPersistSetting: false, env: { [name]: '1' } }) })
        .toEqual({ name, resolved: { persistSession: false } });
    }
  });

  it('NEGATIVE: with neither input on, the key is ABSENT rather than `true`', () => {
    // The distinction is the whole shape of the wiring: the SDK's default is
    // `true`, so the "persist" case must contribute no key at all. Asserting
    // `persistSession: true` here would pass for a resolver that fights any
    // other contributor of the same option.
    const resolved = resolveClaudeSessionPersistence({ neverPersistSetting: false, env: {} });
    expect(resolved).toEqual({});
    expect(Object.keys(resolved)).toEqual([]);
    expect('persistSession' in resolved).toBe(false);
  });

  it('BOUNDARY: a non-truthy env value does not count as set', () => {
    // `isSkipPromptHistoryEnabled` accepts 1/true/yes/on and nothing else, and a
    // privacy switch that turned on for the string "0" would be worse than one
    // that never turned on at all.
    for (const value of ['0', 'false', 'off', '', 'maybe']) {
      expect({ value, resolved: resolveClaudeSessionPersistence({ neverPersistSetting: false, env: { [SKIP_PROMPT_HISTORY_ENV_VAR]: value } }) })
        .toEqual({ value, resolved: {} });
    }
    // …and the control on the same loop, so the probe is shown able to fire.
    expect(resolveClaudeSessionPersistence({ neverPersistSetting: false, env: { [SKIP_PROMPT_HISTORY_ENV_VAR]: 'on' } }))
      .toEqual({ persistSession: false });
  });

  it('reads the real environment when none is injected', () => {
    // The default-argument path, which is the one production uses. Written
    // through a throwaway child-free probe: the name is deleted first, because
    // assigning over a Bun-pre-created slot leaves it invisible to a spread
    // (AGENTS.md §Traps) — not one of those names here, but the habit is the
    // rule.
    const previous = process.env[SKIP_PROMPT_HISTORY_ENV_VAR];
    delete process.env[SKIP_PROMPT_HISTORY_ENV_VAR];
    try {
      process.env[SKIP_PROMPT_HISTORY_ENV_VAR] = 'yes';
      expect(resolveClaudeSessionPersistence({ neverPersistSetting: false }))
        .toEqual({ persistSession: false });
      delete process.env[SKIP_PROMPT_HISTORY_ENV_VAR];
      expect(resolveClaudeSessionPersistence({ neverPersistSetting: false })).toEqual({});
    } finally {
      delete process.env[SKIP_PROMPT_HISTORY_ENV_VAR];
      if (previous !== undefined) process.env[SKIP_PROMPT_HISTORY_ENV_VAR] = previous;
    }
  });

  it("C3.280 POSITIVE: a caller's own ephemeral turns it off with neither other input on", () => {
    // The third input C3.69 named as a residue. `SessionManager` has already
    // OR-ed the caller's `ephemeral` with the setting and the environment, so
    // what arrives here is the resolved answer for the session.
    expect(resolveClaudeSessionPersistence({ sessionEphemeral: true, neverPersistSetting: false, env: {} }))
      .toEqual({ persistSession: false });
  });

  it('C3.280 BOUNDARY: it can only turn persistence OFF, never back on', () => {
    // The direction is the whole safety property, and it matches
    // `SessionManager`'s own OR: a caller who says `false` — or says nothing —
    // cannot overrule an operator who set the setting or the environment.
    expect(resolveClaudeSessionPersistence({ sessionEphemeral: false, neverPersistSetting: true, env: {} }))
      .toEqual({ persistSession: false });
    expect(resolveClaudeSessionPersistence({ sessionEphemeral: false, neverPersistSetting: false, env: { [SKIP_PROMPT_HISTORY_ENV_VAR]: '1' } }))
      .toEqual({ persistSession: false });
    // And absent stays byte-identical to the behaviour before this input existed.
    expect(resolveClaudeSessionPersistence({ neverPersistSetting: false, env: {} })).toEqual({});
    expect(resolveClaudeSessionPersistence({ sessionEphemeral: false, neverPersistSetting: false, env: {} })).toEqual({});
  });

  it('C3.280: `ClaudeAgent` passes the field, and `BackendConfig` declares it', () => {
    // The wire, asserted where it can be: the resolver above is pure and cannot
    // see whether anybody feeds it. Source text rather than a constructed agent
    // — building a `ClaudeAgent` costs a full backend config and the field it
    // would prove is private.
    const here = dirname(fileURLToPath(import.meta.url));
    const agent = readFileSync(join(here, '..', 'claude-agent.ts'), 'utf8');
    const types = readFileSync(join(here, '..', 'backend', 'types.ts'), 'utf8');

    expect(agent).toContain('sessionEphemeral: config.sessionEphemeral');
    expect(types).toContain('sessionEphemeral?: boolean');
    // Negative control on the identical instrument.
    expect(agent).not.toContain('sessionEphemeralNotARealField');
  });

  it('the vendored SDK still declares the option this resolver returns', () => {
    // The contract half. A resolver returning a key the bundle stopped
    // declaring would typecheck against a stale `sdk.d.ts` and do nothing at
    // runtime, silently — the exact shape the never-persist promise was already
    // broken by.
    let dir = dirname(fileURLToPath(import.meta.url));
    let types: string | null = null;
    for (let depth = 0; depth < 12; depth += 1) {
      const candidate = join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.d.ts');
      if (existsSync(candidate)) { types = candidate; break; }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    expect(types, 'no vendored sdk.d.ts found walking up from this file').not.toBeNull();
    const source = readFileSync(types!, 'utf8');
    // Positive control on the same read, then the option itself.
    expect(source.includes('permissionMode?:')).toBe(true);
    expect(source.includes('persistSession?: boolean')).toBe(true);
    // Negative control: the probe must be able to answer no.
    expect(source.includes('persistSessionNotARealOption')).toBe(false);
  });
});
