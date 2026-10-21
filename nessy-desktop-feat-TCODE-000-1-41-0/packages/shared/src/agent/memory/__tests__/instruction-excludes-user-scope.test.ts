/**
 * P6.32 — the USER scope of the settings stack, which this resolver named in its
 * own docblock and did not read.
 *
 * ## What was measured, and what it narrows the row to
 *
 * The row says the claude runtime loads a second settings stack no surface
 * reports. Two corrections, both from probes at HEAD:
 *
 *  - The PROJECT and LOCAL tiers are NOT unreported: `native-sources.ts` emits
 *    `.claude/settings.json` and `.claude/settings.local.json` as `permission`
 *    records, so they appear in the Sources surface.
 *  - `~/.claude/settings.json` — the USER tier, which we explicitly ask the SDK
 *    to load by passing `settingSources: ['user', 'project', 'local']` — is read
 *    by nothing of ours on the live path. `join(home, '.claude')` occurs in
 *    exactly two production files (`pi-harness/isolation/self-config-deny.ts`, a
 *    deny root, and `capabilities/claude-setup-import.ts`, a one-time import
 *    flow), against the control of 5 hits for the project `.claude` directory in
 *    `native-sources.ts` alone.
 *
 * And the vendor's own answer to the row's question does not reach an embedding
 * host: the CLI knows it — the shipped 2.1.223 binary carries the `/status`
 * renderer that returns `{label:"Setting sources", …}` — but it is a TUI dialog,
 * and `SDKSystemMessage` (`sdk.d.ts`, subtype `'init'`) has no settings-source
 * field at all: `settings_sources`, `settingsSources`, `loadedSettings` and
 * `settingsFiles` each score 0 against the control `settingSources` 2, which is
 * the INPUT option and not a report. `settings.md#check-what-loaded` says what
 * even the native answer is worth: "The line confirms which files Claude Code
 * read; it doesn't show which file supplied each key."
 *
 * ## The defect that narrowing isolated, which is what these tests pin
 *
 * `claudeMdExcludes` is documented at all four scopes:
 * `settings-reference.md#claudemdexcludes` gives **Scope** as `Any file`, and the
 * legend at `settings-reference.md#scopes` spells that out — "`User` is
 * `~/.claude/settings.json`, `Project` is `.claude/settings.json`, `Local` is
 * `.claude/settings.local.json`, and `Managed` is what your organization
 * deploys. `Any file` means all four". This resolver implemented managed,
 * project and local, and for USER read only Nessy's own `config.json`. So a
 * pattern written in the file the page names was honoured by the SDK's memory
 * loader inside the claude subprocess and ignored by our collector — a control
 * that silently did not control, and one that meant three different things on
 * the three runtimes.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';

import { resolveInstructionExcludes } from '../instruction-excludes.ts';

const roots: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** A `CLAUDE_CONFIG_DIR` holding one `settings.json` with the given body. */
function claudeConfigDir(body: string): string {
  const dir = tmp('excl-claude-cfg-');
  writeFileSync(join(dir, 'settings.json'), body, 'utf-8');
  return dir;
}

/** A project directory with `.claude/<name>` written. */
function projectWith(name: string, body: unknown): string {
  const dir = tmp('excl-proj-');
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', name), JSON.stringify(body), 'utf-8');
  return dir;
}

describe('the USER scope reads the file the page names', () => {
  it('honours claudeMdExcludes written in ~/.claude/settings.json', () => {
    const patterns = resolveInstructionExcludes({
      claudeConfigDirectory: claudeConfigDir(JSON.stringify({
        claudeMdExcludes: ['**/vendor/**/CLAUDE.md'],
        // Never read out of this file — it is co-owned with real Claude Code.
        permissions: { deny: ['Read(//etc/**)'] },
      })),
    });
    expect(patterns).toContain('**/vendor/**/CLAUDE.md');
    expect(patterns.join(' ')).not.toContain('Read(//etc/**)');
  });

  it('reads our own spelling out of the same file', () => {
    expect(resolveInstructionExcludes({
      claudeConfigDirectory: claudeConfigDir(JSON.stringify({
        instructionExcludes: ['**/legacy/**'],
      })),
    })).toContain('**/legacy/**');
  });

  it('unions with the project and local tiers, de-duplicated', () => {
    const project = projectWith('settings.json', { claudeMdExcludes: ['**/other-team/**', '**/shared/**'] });
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ claudeMdExcludes: ['**/shared/**'] }),
      'utf-8',
    );
    const patterns = resolveInstructionExcludes({
      claudeConfigDirectory: claudeConfigDir(JSON.stringify({ claudeMdExcludes: ['**/user-tier/**'] })),
      workingDirectory: project,
      projectTrustState: 'trusted',
    });
    expect(patterns).toContain('**/user-tier/**');
    expect(patterns).toContain('**/other-team/**');
    expect(patterns.filter(entry => entry === '**/shared/**')).toHaveLength(1);
  });
});

describe('the leg is gated and fails open, like every other leg here', () => {
  it('a settingSources list without `user` drops it', () => {
    const directory = claudeConfigDir(JSON.stringify({ claudeMdExcludes: ['**/user-tier/**'] }));
    expect(resolveInstructionExcludes({ claudeConfigDirectory: directory }))
      .toContain('**/user-tier/**');
    expect(resolveInstructionExcludes({
      claudeConfigDirectory: directory,
      settingSources: ['project', 'local'],
    })).not.toContain('**/user-tier/**');
  });

  it('an unparseable or missing user settings file contributes nothing and never throws', () => {
    expect(resolveInstructionExcludes({
      claudeConfigDirectory: claudeConfigDir('{ this is not json'),
    })).toEqual([]);
    expect(resolveInstructionExcludes({
      claudeConfigDirectory: join(tmpdir(), 'excl-claude-cfg-does-not-exist-xyz'),
    })).toEqual([]);
  });

  it('is NOT gated on project trust — the file is the user\'s, not the repository\'s', () => {
    // An untrusted checkout contributes nothing of its own, and must not be able
    // to suppress the user's own exclusions either.
    const patterns = resolveInstructionExcludes({
      claudeConfigDirectory: claudeConfigDir(JSON.stringify({ claudeMdExcludes: ['**/user-tier/**'] })),
      workingDirectory: projectWith('settings.json', { claudeMdExcludes: ['**/untrusted/**'] }),
      projectTrustState: 'none',
    });
    expect(patterns).toEqual(['**/user-tier/**']);
  });
});
