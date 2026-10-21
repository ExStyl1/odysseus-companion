/**
 * P3.373 — the runnable pin on the user-scope `env` REFUSAL.
 *
 * **The park is closed.** Owner sitting §1.2, 2026-09-05, option (A): refuse
 * user-scope `env` permanently and DISCLOSE the divergence from `env-vars.md`,
 * rather than leave a schema key that reads as supported. Option (B), a name
 * allowlist, was declined — the standing 2026-08-12/13 decision that OS
 * isolation is off forecloses the containment route, so an allowlist would have
 * been the only containment against a threat model whose worst item is `PATH`.
 *
 * So `env` is declared only so a `config.json` that follows `env-vars.md` still
 * loads, its value is refused, and the refusal is reported as a rejected layer
 * that SAYS SO. This file exists so that nobody "finishes" it by wiring the
 * block into `process.env`.
 *
 * The pin that was supposed to catch exactly that — live case `MS-3` — greps to
 * **0** in `docs/testing/cdp-live-checklist.md` at HEAD; it survives only in the
 * archived run narratives. So the guard against a silent finish was itself
 * silently lost, and nothing runnable would have noticed the park being closed.
 *
 * This suite is the replacement, and it is deliberately stronger than the live
 * case it restores: it runs on every `bun test` rather than on a packaged-build
 * day, and it asserts THREE halves — the block does not reach the environment,
 * the user is told, and the told-thing discloses the divergence rather than
 * merely reporting an omission. If anyone reverses the decision, this file is
 * the one that goes red on purpose.
 *
 * `CONFIG_DIR` is frozen at import time and already points at a private temp
 * directory (`tests/setup/isolate-shared-config-dir.ts`, bunfig `[test].preload`),
 * so the fixture writes into the isolated config dir rather than re-pointing an
 * env var, which no longer takes effect. No real credential appears here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../paths.ts';
import { collectRejectedUserSettingsLayers, loadStoredConfig } from '../storage.ts';
import { parseProjectNessyAgentConfig } from '../../plugins/project-config.ts';

const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

/** Absent from the ambient environment, or the assertion resolves for an unrelated reason. */
const PROBE_NAME = 'P3373_USER_ENV_PARK_PROBE';
const PROBE_VALUE = 'stub-value-never-applied';

let previousConfig: string | null = null;

beforeAll(() => {
  expect(process.env[PROBE_NAME]).toBeUndefined();
  previousConfig = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf-8') : null;
  const base = previousConfig
    ? JSON.parse(previousConfig) as Record<string, unknown>
    : { storageLayoutVersion: 2, workspaceRefs: [], activeWorkspaceId: null, activeSessionId: null };
  writeFileSync(CONFIG_FILE, JSON.stringify({
    ...base,
    env: { [PROBE_NAME]: PROBE_VALUE, PATH: '/attacker/bin' },
  }), 'utf-8');
});

afterAll(() => {
  if (previousConfig === null) rmSync(CONFIG_FILE, { force: true });
  else writeFileSync(CONFIG_FILE, previousConfig, 'utf-8');
});

describe('user-scope `env` — declared, reported, never applied (the f163b park)', () => {
  it('loads the file instead of rejecting it whole', () => {
    // f163a's actual value: `StoredConfigTopLevelSchema` is `.strict()` and
    // `loadStoredConfig()` throws on a failed parse, so before the key was
    // declared, following the documented page cost the user EVERY setting in
    // the file — not just this one.
    const config = loadStoredConfig();
    expect(config).not.toBeNull();
    expect(config?.env?.[PROBE_NAME]).toBe(PROBE_VALUE);
  });

  it('does NOT write the block into the process environment', () => {
    // THE PARK. `PATH` is in the block on purpose: it is the `execution`
    // category — "which binary a shell-out resolves to" — and every child in
    // this repo is built by spreading `process.env`, so this is the shape the
    // whole threat model turns on.
    loadStoredConfig();
    collectRejectedUserSettingsLayers();
    expect(process.env[PROBE_NAME]).toBeUndefined();
    expect(process.env.PATH).not.toBe('/attacker/bin');
  });

  it('reports the rejection by NAME and never carries a value', () => {
    const layers = collectRejectedUserSettingsLayers();
    const serialized = JSON.stringify(layers);
    expect(serialized).toContain(PROBE_NAME);
    expect(serialized).toContain('PATH');
    // A diagnostic that echoed the value would turn a report into a leak.
    expect(serialized).not.toContain(PROBE_VALUE);
    expect(serialized).not.toContain('/attacker/bin');
  });

  it('DISCLOSES the divergence rather than only reporting the omission', () => {
    // Option (A)'s actual deliverable. "read but never applied" told a user
    // their setting did nothing; it did not tell them the page documents it,
    // that the refusal is permanent, or where the supported route is — so the
    // reasonable next move was to file a bug or try again in another scope.
    const [layer] = collectRejectedUserSettingsLayers()
      .filter(entry => entry.key === 'env');
    expect(layer).toBeDefined();
    expect(layer?.reason).toContain('PERMANENTLY REFUSED');
    expect(layer?.reason).toContain('env-vars.md');
    expect(layer?.reason).toContain('managed settings');
    // And the names still survive the 400-character cap the doctor renders it
    // at: a disclosure that truncated the variable list would trade one half of
    // the report for the other.
    expect(layer?.reason).toContain(PROBE_NAME);
    expect(layer?.reason).toContain('PATH');
  });

  /**
   * The THIRD scope, which had no answer at all.
   *
   * PROJECT scope refuses `env` on the record and USER scope is the suite above;
   * LOCAL scope has no Nessy file and had no recorded refusal, and one scope
   * erroring, one reporting and one silent is exactly how a park gets
   * "finished" by accident. Under (A) that silence is a defect.
   *
   * The record is that the refusal is a property of the PARSER, not of a file
   * name — so a local-scope file added later is covered the day it is routed
   * through the same parser, which is the only way to pin a scope whose file
   * does not exist yet.
   */
  it('refuses an `env` section whatever scope file name the parser is handed', () => {
    const content = '[env]\nPATH = "/attacker/bin"\n';
    for (const sourceName of [
      '.nessy-agent/config.toml',
      '.nessy-agent/config.local.toml',
      'a-file-name-no-scope-has-yet',
    ]) {
      const diagnostics: { severity: string; message: string }[] = [];
      const parsed = parseProjectNessyAgentConfig(content, sourceName, diagnostics as never);
      expect(parsed.plugins).toEqual([]);
      const errors = diagnostics.filter(entry => entry.severity === 'error');
      expect(errors.length).toBeGreaterThan(0);
      expect(JSON.stringify(errors)).toContain('env');
      // The value never travels, at any scope.
      expect(JSON.stringify(diagnostics)).not.toContain('/attacker/bin');

      // The control, on the same parser and the same source name: a file that
      // carries no forbidden section produces no error. Without it, a parser
      // that errored on EVERYTHING would read as a passing refusal.
      const benign: { severity: string; message: string }[] = [];
      parseProjectNessyAgentConfig('[defaults]\nmodel = "x"\n', sourceName, benign as never);
      expect(benign.filter(entry => entry.severity === 'error')).toEqual([]);
    }
  });
});
