/**
 * P6.182 clause (i) — the USER-settings rung of `crossSessionInbound`.
 *
 * `settings-reference.md#crosssessioninbound`, verbatim: *"Claude Code reads
 * managed settings first, then the `--settings` flag, then user settings, and
 * applies the first value found."* This host had the operator rung (the env) and
 * the project/local exception and NO user rung, so the value the page says the
 * `/config` row writes had nowhere to go.
 *
 * Two things are pinned here and nothing else: that the key survives the strict
 * envelope (an undeclared key our own setter writes refuses the WHOLE
 * `config.json`), and that it ships ABSENT, which is the page's own default
 * rather than an omission — *"**Default**: unset, so Claude Code decides per
 * message"*.
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CROSS_SESSION_INBOUND_ENV_NAME,
  CROSS_SESSION_INBOUND_SETTINGS,
  CROSS_SESSION_INBOUND_VALUE_MAX,
  FALLBACK_CONFIG_DEFAULTS,
  clearCrossSessionInbound,
  describeUnrecognizedCrossSessionInbound,
  getCrossSessionInbound,
  getCrossSessionInboundSettings,
  setCrossSessionInbound,
} from '../storage.ts';
import { StoredConfigSchema, StoredConfigTopLevelSchema } from '../validators.ts';
import { STORAGE_LAYOUT_VERSION } from '../paths.ts';

function storedConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    storageLayoutVersion: STORAGE_LAYOUT_VERSION,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    ...over,
  };
}

/**
 * The one case here that spawns a CHILD pays that child's cold `storage.ts`
 * module graph against bun's 5 s default timer, and the graph is I/O-bound:
 * measured 15 227 ms in a three-file batch and 15 616 ms alone, both at load
 * ~9.5 with 1.15 s user / 0.59 s sys against 36.89 s wall — under 5 % cpu, so
 * this is blocked time, not contention (AGENTS.md §Traps). Its sibling
 * `storage-session-agent.test.ts`, which spawns the same child for the same
 * reason, has carried this budget since it was written; this file did not, and
 * the case passed only while the page cache happened to be warm.
 */
const SUBPROCESS_TEST_TIMEOUT_MS = 120_000;

describe('the crossSessionInbound user setting (P6.182 clause i)', () => {
  it('the vendor spelling, and every value it accepts, survives the strict envelope', () => {
    // POSITIVE. `claude-agent-sdk` 0.3.233 `sdk.d.ts`:
    // `crossSessionInbound?: 'accept' | 'hold' | 'refuse'`.
    expect([...CROSS_SESSION_INBOUND_SETTINGS]).toEqual(['accept', 'hold', 'refuse']);
    for (const mode of CROSS_SESSION_INBOUND_SETTINGS) {
      expect(StoredConfigTopLevelSchema.safeParse(storedConfig({ crossSessionInbound: mode })).success).toBe(true);
      expect(StoredConfigSchema.safeParse(storedConfig({ crossSessionInbound: mode })).success).toBe(true);
    }
  });

  it('ships ABSENT, because "unset" is the documented default', () => {
    // POSITIVE, and the one recent key with no fourth site: a value in
    // config-defaults.json would destroy "Claude Code decides per message" for
    // every install.
    expect('crossSessionInbound' in FALLBACK_CONFIG_DEFAULTS.defaults).toBe(false);
    const bundled = JSON.parse(readFileSync(
      join(import.meta.dir, '..', '..', '..', '..', '..', 'apps', 'electron', 'resources', 'config-defaults.json'),
      'utf8',
    )) as { defaults: Record<string, unknown> };
    expect('crossSessionInbound' in bundled.defaults).toBe(false);
    // With nothing stored, the reader says "no value", not a guess.
    expect(getCrossSessionInbound()).toBeUndefined();
  });

  it('an unrecognized value is refused on the way in and dropped on the way out', () => {
    // NEGATIVE, the writer: a value that persists and does nothing is the
    // stated-but-not-enforced shape this key's own module exists to avoid.
    expect(setCrossSessionInbound('REFUSE' as never)).toBe(false);
    expect(setCrossSessionInbound('' as never)).toBe(false);
    // NEGATIVE, the reader: the typed schema names a typo — the page warns about
    // one — while the load path stays unknown-tolerant so it cannot refuse the file.
    expect(StoredConfigSchema.safeParse(storedConfig({ crossSessionInbound: 'REFUSE' })).success).toBe(false);
    expect(StoredConfigTopLevelSchema.safeParse(storedConfig({ crossSessionInbound: 'REFUSE' })).success).toBe(true);
  });

  it('the validator names the key AND says the page sentence (P6.939)', () => {
    // P6.874 measured which of the two things that speak about this typo reaches
    // a user, and kept two voices because the validator reached nobody unasked
    // and said less. P6.878 gave the doctor a collector that calls
    // `validateConfig()`, so it now speaks proactively — and P6.939 moved the
    // sentence into `shared` so it says the same thing the resolver does.
    //
    // The PATH still names the key: `validateConfig()` runs exactly this schema
    // and `config_validate` renders `- <path>: <message>`.
    const parsed = StoredConfigSchema.safeParse(storedConfig({ crossSessionInbound: 'reject' }));
    expect(parsed.success).toBe(false);
    // Read the issue into a local before asserting on its parts: an asymmetric
    // matcher handed to `toMatchObject` overwrites the field it matched
    // (AGENTS.md §Traps).
    const issues = parsed.success ? [] : parsed.error.issues;
    const paths = issues.map(issue => issue.path.join('.'));
    expect(paths).toContain('crossSessionInbound');
    // POSITIVE, and it is the inversion of what this case asserted until P6.939:
    // all three clauses `settings-reference.md#crosssessioninbound` requires are
    // now in the validator's own message, because both voices call
    // `crossSessionInboundUnrecognizedSentence`.
    const message = issues.find(issue => issue.path.join('.') === 'crossSessionInbound')?.message ?? '';
    expect(message).toContain('was ignored');
    expect(message).toContain('held for your approval');
    expect(message).toContain('Set it to one of the values above');
    // And it quotes the received value through the ONE renderer (P6.868), so the
    // two surfaces spell it identically.
    expect(message).toContain('received "reject".');
  });

  it('the settings view reports all FOUR states, and unset is one of them', () => {
    // P6.868. POSITIVE: with nothing stored and no operator value, the view is
    // the page's documented default — "unset, so Claude Code decides per
    // message" — reported as an ABSENT mode rather than as `accept`.
    const view = getCrossSessionInboundSettings();
    expect(view.mode).toBeUndefined();
    expect(view.unrecognized).toBeUndefined();
    expect(view.operatorLocked).toBe(false);
    expect(view.operatorMode).toBeUndefined();
  });

  it('the operator env LOCKS the control, and only an exact value does', () => {
    // The page hides its own row "while the `--settings` flag or managed settings
    // set the key", because "a user-settings value wouldn't apply then". This
    // host's env stands in for both.
    const before = process.env[CROSS_SESSION_INBOUND_ENV_NAME];
    const set = (value: string | undefined): void => {
      // `delete` before assigning, always: assigning to a name Bun pre-creates a
      // slot for leaves it invisible to a spread (AGENTS.md §Traps). Cheap, and
      // the rule is unconditional because the name list cannot be complete.
      delete process.env[CROSS_SESSION_INBOUND_ENV_NAME];
      if (value !== undefined) process.env[CROSS_SESSION_INBOUND_ENV_NAME] = value;
    };
    try {
      // POSITIVE, all three, case-folded and trimmed the way the ENV reader in
      // the enforcement module folds them (and the settings-FILE reader does not).
      for (const mode of CROSS_SESSION_INBOUND_SETTINGS) {
        set(` ${mode.toUpperCase()} `);
        expect(getCrossSessionInboundSettings()).toMatchObject({ operatorLocked: true, operatorMode: mode });
      }
      // NEGATIVE, and since P6.872 it is a NARROWING this view chooses rather
      // than a report of the enforcement module: that module now reads the
      // variable as the page's managed half, so an unreadable value there
      // resolves to `refuse` with `explicit: true`. The lock stays false for it
      // because the sentence this flag renders quotes the variable's VALUE back
      // to the user, and a typo has no readable value to quote. Naming the
      // refusal on that surface was a row of its own, and P6.1015 built it —
      // `operatorUnreadable`, asserted in the case below. This flag is unchanged.
      for (const junk of ['reject', '', '   ']) {
        set(junk);
        const view = getCrossSessionInboundSettings();
        expect(view.operatorLocked).toBe(false);
        expect(view.operatorMode).toBeUndefined();
      }
      // And absent is absent.
      set(undefined);
      expect(getCrossSessionInboundSettings().operatorLocked).toBe(false);
    } finally {
      set(before);
    }
  });

  /**
   * P6.1015 — the refusal the lock deliberately does not name.
   *
   * The flag above stays narrow, so this state needs a field and a sentence of
   * its own. Its condition is the enforcement module's own opening
   * (`resolveCrossSessionInboundMode`: `raw?.trim().toLowerCase()`, then
   * `if (!value)`, then the three) rather than a second reading of it, because
   * two host surfaces disagreeing about one key is the defect the row was born
   * from — `/config`'s `unavailable` gate has fired on any non-empty value all
   * along while the settings card said nothing.
   */
  it('an operator value this host cannot READ is reported as its own state (P6.1015)', () => {
    const before = process.env[CROSS_SESSION_INBOUND_ENV_NAME];
    const set = (value: string | undefined): void => {
      // `delete` first, always — see the case above.
      delete process.env[CROSS_SESSION_INBOUND_ENV_NAME];
      if (value !== undefined) process.env[CROSS_SESSION_INBOUND_ENV_NAME] = value;
    };
    try {
      // POSITIVE: present, non-empty, none of the three. Read into a local
      // FIRST — never assert a shape with a matcher and then read the same
      // object back (AGENTS.md §Traps, `toMatchObject` mutates).
      set('reject');
      const typo = getCrossSessionInboundSettings();
      expect(typo.operatorUnreadable).toBe('"reject"');
      // The lock is untouched by it, which is the whole point of the split: the
      // card renders a DIFFERENT sentence, not this one with an empty `{{mode}}`.
      expect(typo.operatorLocked).toBe(false);
      expect(typo.operatorMode).toBeUndefined();
      // Trimmed before it is quoted, matching what the enforcement module
      // compares — otherwise the sentence would show padding the module ignores.
      set('  Reject  ');
      expect(getCrossSessionInboundSettings().operatorUnreadable).toBe('"Reject"');
      // And clamped by the one renderer, so an oversized variable cannot become
      // an oversized line on the card.
      set('x'.repeat(CROSS_SESSION_INBOUND_VALUE_MAX + 20));
      const huge = getCrossSessionInboundSettings().operatorUnreadable!;
      expect(huge.length).toBeLessThanOrEqual(CROSS_SESSION_INBOUND_VALUE_MAX + 3);
      expect(huge.endsWith('…"')).toBe(true);

      // NEGATIVE / BOUNDARY: a readable value is not this state, and neither is
      // an absent or whitespace-only one — the module applies nothing for those
      // (`if (!value)`), so a card sentence would name a refusal that is not
      // happening. Each read into a local before it is asserted.
      for (const mode of CROSS_SESSION_INBOUND_SETTINGS) {
        set(mode);
        const good = getCrossSessionInboundSettings();
        expect(good.operatorUnreadable, `${mode} is readable`).toBeUndefined();
        expect(good.operatorLocked).toBe(true);
      }
      for (const quiet of ['', '   ', undefined]) {
        set(quiet);
        const view = getCrossSessionInboundSettings();
        expect(view.operatorUnreadable, `"${String(quiet)}" applies nothing`).toBeUndefined();
        expect(view.operatorLocked).toBe(false);
      }
    } finally {
      set(before);
    }
  });

  it('the quoted value one renderer prints is bounded and escaped', () => {
    // ONE renderer for both halves of the P6.866 warning family: this module reads
    // the user rung, server-core's resolver reads the two settings files, and both
    // must spell a value the same way.
    expect(describeUnrecognizedCrossSessionInbound('reject')).toBe('"reject"');
    expect(describeUnrecognizedCrossSessionInbound(3)).toBe('3');
    // A settings file can hold any string; a warning line cannot.
    const long = describeUnrecognizedCrossSessionInbound('x'.repeat(500));
    expect(long.length).toBeLessThanOrEqual(CROSS_SESSION_INBOUND_VALUE_MAX + 3);
    expect(long.endsWith('…"')).toBe(true);
    // A newline in a settings value must not become a newline in a log line.
    expect(describeUnrecognizedCrossSessionInbound('a\nb')).toBe('"a\\nb"');
  });

  it('the operator env name is a literal, so it is stated once here', () => {
    // The enforcement module in server-core exports the same literal and cannot
    // be imported from this package; `cross-session-inbound.test.ts` asserts the
    // two equal from the other side.
    expect(CROSS_SESSION_INBOUND_ENV_NAME).toBe('NESSY_CROSS_SESSION_INBOUND');
  });

  // LAST in the file on purpose, and in a SUBPROCESS: it is the only case here
  // that writes. `loadConfigForMutation` refuses when `config.json` is absent —
  // the documented setter rule, pinned by `setter-absent-config-rule.test.ts` —
  // and `CONFIG_DIR` freezes at the first import of `config/paths.ts`, so the
  // only way to exercise a real write is a child with `NESSY_CONFIG_DIR`
  // exported BEFORE bun starts (AGENTS.md §Traps: the isolate preload does not
  // cover every invocation form, but the env var does).
  it('the fourth state is reachable as a WRITE, and only by deleting the key', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'nessy-xsession-clear-'));
    const configFile = join(configDir, 'config.json');
    writeFileSync(configFile, JSON.stringify({
      storageLayoutVersion: STORAGE_LAYOUT_VERSION,
      workspaceRefs: [],
      activeWorkspaceId: null,
    }));
    const storage = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href;
    const run = Bun.spawnSync([process.execPath, '--eval', `
      import * as S from '${storage}';
      const afterSet = [S.setCrossSessionInbound('refuse'), S.getCrossSessionInbound()];
      const afterClear = [S.clearCrossSessionInbound(), S.getCrossSessionInbound()];
      const again = S.clearCrossSessionInbound();
      process.stdout.write(JSON.stringify({ afterSet, afterClear, again }));
    `], { env: { ...process.env, NESSY_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const result = JSON.parse(run.stdout.toString().trim()) as {
      afterSet: [boolean, string | null]; afterClear: [boolean, string | null]; again: boolean;
    };
    // POSITIVE, the round trip a selector performs: choose a value, then choose
    // "unset" and get back the documented per-message default.
    expect(result.afterSet).toEqual([true, 'refuse']);
    expect(result.afterClear[0]).toBe(true);
    expect(result.afterClear[1] ?? undefined).toBeUndefined();
    // NEGATIVE, and the reason a sentinel was refused: after the clear the key is
    // GONE from the file, so the app's "unset" and a hand-edited file's "unset"
    // are one state rather than two that behave alike until something reads them.
    const persisted = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
    expect('crossSessionInbound' in persisted).toBe(false);
    // Idempotent: clearing an absent key is not an error.
    expect(result.again).toBe(true);
    rmSync(configDir, { recursive: true, force: true });
  }, SUBPROCESS_TEST_TIMEOUT_MS);
});

/**
 * P7.17 — the native surface this key's own subsystem grew at `0.3.247`, pinned
 * against the vendored typings rather than re-read from prose.
 *
 * The module that resolves this setting
 * (`server-core/src/sessions/cross-session-inbound.ts`) carries the measurement
 * and the reason the host rung stays the seam. What has to be MECHANICAL is the
 * vocabulary: our own class words are one letter from the vendor's
 * (`bypassing` here, `bypass` there), and the day someone stamps
 * `SDKMessageOrigin` a silently wrong word would fail closed at the child's
 * strict trust gates with nothing naming the cause.
 */
describe('P7.17 · the vendored cross-session vocabulary', () => {
  /**
   * Read ONCE and cached. The first read of `sdk.d.ts` through `createRequire`
   * measured **15 007 ms** against bun's 5 s default and timed out, at load ~11
   * with 1.29 s user / 0.59 s sys over 40 s wall — under 5 % cpu, so it is
   * blocked time and not contention (AGENTS.md §Traps), and the second case
   * passed only because the first had warmed the page cache. Both cases carry
   * the file's own subprocess budget for the same reason.
   */
  let cached: string | undefined;
  function sdkTypings(): string {
    if (cached === undefined) {
      const require_ = createRequire(import.meta.url);
      const entry = require_.resolve('@anthropic-ai/claude-agent-sdk');
      cached = readFileSync(entry.replace(/sdk\.mjs$/, 'sdk.d.ts'), 'utf8');
    }
    return cached;
  }

  it('declares fromMode as bypass|prompting, and the third task-notification subkind', () => {
    const types = sdkTypings();
    // Positive control first: a dead read would pass every membership check
    // below vacuously.
    expect(types).toContain('export declare type SDKMessageOrigin');
    expect(types).toContain("fromMode?: 'bypass' | 'prompting';");
    expect(types).toContain("subkind?: 'scheduled-trigger' | 'peer-send-message' | 'projects-relay';");
    // NEGATIVE, and the whole point of the row: the vendor does NOT spell the
    // bypassing class the way this fork does.
    expect(types).not.toContain("fromMode?: 'bypassing' | 'prompting';");
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it('still spells the three inbound values the way this fork stores them', () => {
    const types = sdkTypings();
    const anchor = types.indexOf('crossSessionInbound?:');
    expect(anchor).toBeGreaterThan(-1);
    const declared = types.slice(anchor, types.indexOf(';', anchor));
    for (const value of CROSS_SESSION_INBOUND_SETTINGS) expect(declared).toContain(`'${value}'`);
    expect(declared).not.toContain("'reject'");
  }, SUBPROCESS_TEST_TIMEOUT_MS);
});
