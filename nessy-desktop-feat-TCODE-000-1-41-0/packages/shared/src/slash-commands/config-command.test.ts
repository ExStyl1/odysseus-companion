import { describe, expect, it } from 'bun:test';

import { parseSessionCommand } from './session-command.ts';
import {
  SESSION_CONFIG_KEYS,
  formatSessionConfigListing,
  runSessionConfigCommand,
  type SessionConfigKey,
} from './config-command.ts';
import { SESSION_COMMAND_HELP_ENTRIES } from './help.ts';

describe('/config parsing (P6.410)', () => {
  it('parses the three documented forms', () => {
    expect(parseSessionCommand('/config')).toEqual({ kind: 'config' });
    expect(parseSessionCommand('/config memory')).toEqual({ kind: 'config', key: 'memory' });
    expect(parseSessionCommand('/config memory=false')).toEqual({ kind: 'config', key: 'memory', value: 'false' });
    // Whitespace around `=` is the shape a human types.
    expect(parseSessionCommand('/config memory = false')).toEqual({ kind: 'config', key: 'memory', value: 'false' });
  });

  it('leaves prose to the model', () => {
    // Same rule `/help compact` follows: a sentence that merely starts with the
    // command is a question, not an invocation.
    expect(parseSessionCommand('/config the memory setting please')).toBeNull();
    expect(parseSessionCommand('what does /config do?')).toBeNull();
  });

  it('takes a value containing spaces verbatim (an output-style id may have one)', () => {
    expect(parseSessionCommand('/config outputStyle=Explanatory Mode')).toEqual({
      kind: 'config', key: 'outputStyle', value: 'Explanatory Mode',
    });
  });
});

describe('/config answers (P6.410)', () => {
  it('lists every reachable key with its value and what it accepts', () => {
    const listing = formatSessionConfigListing();
    for (const entry of SESSION_CONFIG_KEYS) {
      expect(listing).toContain(entry.key);
      expect(listing).toContain(entry.accepts);
    }
  });

  it('names the whole allowlist when the key is not reachable, instead of failing silently', () => {
    const answer = runSessionConfigCommand('bypassPermissionsAcknowledged', 'true');
    expect(answer).toContain('not reachable from the prompt');
    for (const entry of SESSION_CONFIG_KEYS) expect(answer).toContain(entry.key);
  });

  it('refuses an invalid value by naming what the key accepts, and writes nothing', () => {
    const before = runSessionConfigCommand('thinking');
    const answer = runSessionConfigCommand('thinking', 'extremely');
    expect(answer).toContain('is not a valid value');
    expect(runSessionConfigCommand('thinking')).toBe(before);
  });

  it('writes an allowlisted key and reports what it now reads', () => {
    // Driven over a substitute table: the real one writes the user's config.json,
    // and a test that had to build a valid v2 storage tree to reach the write
    // would be measuring the storage layout instead of this command.
    let stored = true;
    const table: SessionConfigKey[] = [{
      key: 'memory',
      accepts: 'true | false',
      read: () => String(stored),
      write: raw => {
        if (raw === 'false' || raw === 'off') { stored = false; return true; }
        if (raw === 'true' || raw === 'on') { stored = true; return true; }
        return null;
      },
    }];
    expect(runSessionConfigCommand('memory', 'false', table)).toBe('memory = false');
    expect(runSessionConfigCommand('memory', 'on', table)).toBe('memory = true');
    expect(runSessionConfigCommand('memory', 'perhaps', table)).toContain('is not a valid value');
    // ...and the value is unchanged after the refusal.
    expect(runSessionConfigCommand('memory', undefined, table)).toContain('memory = true');
  });

  it('reports honestly when the settings file is not writable, instead of claiming a write', () => {
    // The setters warn-and-return false rather than throwing — that is the
    // branch a user meets on a broken install, and it must not read as success.
    const table: SessionConfigKey[] = [{
      key: 'memory', accepts: 'true | false', read: () => 'true', write: () => false,
    }];
    expect(runSessionConfigCommand('memory', 'false', table)).toContain('could not be saved');
  });

  it('keeps every permission-, credential- and egress-shaped setting out of reach', () => {
    // The allowlist is the mechanism; this pins the CLASS the header refuses, so
    // a later key cannot be added past the reasoning without reddening a test.
    const reachable = SESSION_CONFIG_KEYS.map(entry => entry.key.toLowerCase());
    for (const forbidden of ['bypass', 'permission', 'sandbox', 'proxy', 'token', 'apikey', 'credential', 'remote']) {
      expect(reachable.some(key => key.includes(forbidden))).toBe(false);
    }
  });

  it('is announced in the help listing, so it is not a command only insiders know', () => {
    const row = SESSION_COMMAND_HELP_ENTRIES.find(entry => entry.id === 'config');
    expect(row?.label).toContain('/config');
    expect(row?.availability).toBe('session');
  });
});

/**
 * P6.182 clause (i) — the page's own `/config` row, with the two constraints the
 * page attaches to it and nothing else.
 *
 * `cross-session-messaging.md#control-inbound-messages`, verbatim: *"Beyond
 * editing a settings file, you can select the value in the `/config` row
 * **Messages from your other sessions**. Claude Code writes the value you select
 * to your user settings. The row requires Claude Code v2.1.232 or later and
 * doesn't appear while managed settings or the `--settings` flag sets the key,
 * since a user-settings value wouldn't apply then. Claude Code rejects the
 * `/config crossSessionInbound=value` shorthand for this key."*
 *
 * Driven over SUBSTITUTE tables wherever the answer depends on the environment,
 * for this file's own stated reason: the real row reads the user's `config.json`
 * and the process env, and a test that mutated either would be measuring the rig.
 */
describe('/config crossSessionInbound (P6.182 clause i)', () => {
  const row: SessionConfigKey = {
    key: 'crossSessionInbound',
    accepts: 'accept | hold | refuse',
    read: () => 'unset',
    write: () => null,
    unavailable: () => undefined,
    rejectsInlineWrite: 'chosen in Settings, not from the prompt.',
  };
  const outranked: SessionConfigKey = {
    ...row,
    unavailable: () => 'NESSY_CROSS_SESSION_INBOUND sets this key, so a user-settings value would not apply.',
  };

  it('is a real row: it is in the allowlist, and it reads', () => {
    // POSITIVE: the page's key, under the page's own spelling, reachable.
    const real = SESSION_CONFIG_KEYS.find(entry => entry.key === 'crossSessionInbound');
    expect(real).toBeDefined();
    expect(real!.accepts).toBe('accept | hold | refuse');
    // The listing shows it while nothing outranks it.
    expect(formatSessionConfigListing([row])).toContain('crossSessionInbound');
    expect(runSessionConfigCommand('crossSessionInbound', undefined, [row])).toContain('unset');
  });

  it('rejects the key=value shorthand, and says where the value is chosen', () => {
    // POSITIVE for the page's third sentence, and it must not write: a value
    // typed into a chat composer cannot show the precedence it is subject to.
    const answer = runSessionConfigCommand('crossSessionInbound', 'refuse', [row]);
    expect(answer).toContain('cannot be set with crossSessionInbound=<value>');
    expect(answer).toContain('chosen in Settings');
    // NEGATIVE, the shape of the refusal: it is NOT the generic invalid-value
    // message, which would tell the user to try a different value.
    expect(answer).not.toContain('is not a valid value');
  });

  it('does not appear while something outranks it, and says so when named', () => {
    // NEGATIVE: hidden from the listing...
    expect(formatSessionConfigListing([outranked])).not.toContain('crossSessionInbound');
    // ...and a user who knows the name learns WHAT outranks it, rather than
    // meeting the "not reachable from the prompt" wall, which would be false.
    const named = runSessionConfigCommand('crossSessionInbound', undefined, [outranked]);
    expect(named).toContain('is not settable here');
    expect(named).toContain('NESSY_CROSS_SESSION_INBOUND');
    expect(named).not.toContain('unset');
    // The write form is refused for the same reason, before the shorthand rule.
    expect(runSessionConfigCommand('crossSessionInbound', 'hold', [outranked])).toContain('is not settable here');
  });

  it('changes nothing for every other key', () => {
    // NEGATIVE, the blast radius: neither field is set on any other row, so the
    // five keys that were reachable before are reachable in exactly the same way.
    for (const entry of SESSION_CONFIG_KEYS) {
      if (entry.key === 'crossSessionInbound') continue;
      expect(entry.unavailable).toBeUndefined();
      expect(entry.rejectsInlineWrite).toBeUndefined();
    }
  });
});
