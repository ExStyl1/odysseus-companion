/**
 * R28 Task 5 — excludes, setting-source gating and `--add-dir` gating.
 *
 * `memory.md`:
 * - "The `claudeMdExcludes` setting lets you skip specific files by path or glob
 *   pattern... Patterns are matched against absolute file paths using glob
 *   syntax", and its own example points at a rules directory
 *   (`"/home/user/monorepo/other-team/.claude/rules/**"`).
 * - "Project rules are skipped if you exclude `project` from `--setting-sources`."
 * - `--add-dir` loads `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md` and
 *   `CLAUDE.local.md` only behind an opt-in env var; the `additionalDirectories`
 *   SETTING never loads them ("Never / Never", `large-codebases.md`).
 *
 * All three assert through `buildNativeCapabilityInventory`, the production
 * discovery entry point.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  buildNativeCapabilityInventory,
  resetInertAdditionalDirectoryRulesNotice,
} from '../native-sources.ts';
import type { NativeCapabilitySourceRecord, WorkspacePolicyContext } from '../types.ts';

const roots: string[] = [];
const ADD_DIR_ENV = 'NESSY_ADDITIONAL_DIRECTORIES_MEMORY';

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env[ADD_DIR_ENV];
  while (roots.length) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  configDir: string;
  workspaceRoot: string;
  projectRoot: string;
  env: { configDir: string; homeAgentsSkillsDir: string; adminSkillsDirs: readonly string[] };
}

function makeFixture(): Fixture {
  const configDir = tmp('ns-gate-config-');
  const homeSkills = tmp('ns-gate-home-');
  const workspaceRoot = tmp('ns-gate-ws-');
  const projectRoot = tmp('ns-gate-project-');
  // P2.455 — the administrator tier is pinned OFF for this file. Its DEFAULT
  // roots are absolute machine-wide directories, so a rig that let them default
  // would read the REAL ones on a centrally managed host — the deployment the
  // tier exists for — and a fixture everywhere else, failing only there and
  // looking like a content mismatch. The standing guard is
  // `admin-skills-dirs-pinned.test.ts`; `admin-skill-tier-catalog.test.ts` is
  // where the tier is deliberately turned ON.
  return {
    configDir,
    workspaceRoot,
    projectRoot,
    env: { configDir, homeAgentsSkillsDir: homeSkills, adminSkillsDirs: [] },
  };
}

function context(fx: Fixture, overrides: Partial<WorkspacePolicyContext> = {}): WorkspacePolicyContext {
  return {
    workspaceId: 'ws-uuid-gate',
    workspaceRootPath: fx.workspaceRoot,
    projectRoot: fx.projectRoot,
    workingDirectory: fx.projectRoot,
    projectTrustState: 'trusted',
    projectTrustRevision: 'rev-1',
    ...overrides,
  };
}

function ruleRecords(records: NativeCapabilitySourceRecord[]): NativeCapabilitySourceRecord[] {
  return records.filter(r => r.kind === 'memory' && r.memoryFormat === 'rule');
}

function writeRule(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `${body}\n`, 'utf-8');
  return path;
}

describe('the excludes matcher', () => {
  it('skips every rule and instruction file under an excluded package', () => {
    const fx = makeFixture();
    const excluded = writeRule(join(fx.projectRoot, 'other-team', '.claude', 'rules'), 'theirs.md', 'Their rule.');
    const kept = writeRule(join(fx.projectRoot, '.claude', 'rules'), 'ours.md', 'Our rule.');
    mkdirSync(join(fx.projectRoot, 'other-team'), { recursive: true });
    writeFileSync(join(fx.projectRoot, 'CLAUDE.md'), 'Project instructions.', 'utf-8');

    const { records } = buildNativeCapabilityInventory(context(fx), {
      ...fx.env,
      instructionExcludes: [
        `${fx.projectRoot}/other-team/.claude/rules/**`,
        '**/CLAUDE.md',
      ],
    });

    const paths = records.map(r => r.sourcePath);
    expect(paths).not.toContain(excluded);
    expect(paths).not.toContain(join(fx.projectRoot, 'CLAUDE.md'));
    expect(paths).toContain(kept);
  });

  /**
   * R31 · f185. The case above injects `env.instructionExcludes`, which is why
   * the defect survived: it exercises the matcher and never the SETTING
   * resolution. `large-codebases.md:137` puts the documented example at the LOCAL
   * scope — "If you only want these exclusions for yourself, put the setting in
   * `.claude/settings.local.json`" — and `:155` merges the arrays across scopes,
   * so this one goes through the files on disk.
   */
  it('reads claudeMdExcludes from .claude/settings.local.json and unions it with the managed scope', () => {
    const fx = makeFixture();
    // Both targets must be DISCOVERED without exclusions, or an assertion that
    // they are absent proves nothing — the `other-team` rule in the case above
    // is outside the rules walk entirely, which is why it is not used here.
    const dropped = writeRule(join(fx.projectRoot, '.claude', 'rules'), 'dropped.md', 'Their rule.');
    const kept = writeRule(join(fx.projectRoot, '.claude', 'rules'), 'kept.md', 'Our rule.');
    writeFileSync(join(fx.projectRoot, 'CLAUDE.md'), 'Project instructions.', 'utf-8');
    const control = buildNativeCapabilityInventory(context(fx), fx.env).records.map(r => r.sourcePath);
    expect(control).toContain(dropped);
    expect(control).toContain(join(fx.projectRoot, 'CLAUDE.md'));

    // The doc's own worked example shape, and nothing else out of the document.
    writeFileSync(
      join(fx.projectRoot, '.claude', 'settings.local.json'),
      JSON.stringify({ claudeMdExcludes: ['**/rules/dropped.md'] }),
      'utf-8',
    );

    const { records } = buildNativeCapabilityInventory(context(fx), {
      ...fx.env,
      // The managed scope PARTICIPATES rather than replacing the local one.
      managedInstructionExcludes: ['**/CLAUDE.md'],
    });

    const paths = records.map(r => r.sourcePath);
    expect(paths).not.toContain(dropped);
    expect(paths).not.toContain(join(fx.projectRoot, 'CLAUDE.md'));
    expect(paths).toContain(kept);
  });

  it('a malformed local settings file excludes nothing and breaks no discovery', () => {
    const fx = makeFixture();
    const kept = writeRule(join(fx.projectRoot, '.claude', 'rules'), 'ours.md', 'Our rule.');
    writeFileSync(join(fx.projectRoot, 'CLAUDE.md'), 'Project instructions.', 'utf-8');
    // Not JSON at all, plus one unusable entry in the file that IS readable:
    // neither may cost the inventory anything.
    writeFileSync(join(fx.projectRoot, '.claude', 'settings.local.json'), '{ this is not json', 'utf-8');
    writeFileSync(
      join(fx.projectRoot, '.claude', 'settings.json'),
      JSON.stringify({ claudeMdExcludes: [42, '   ', '**/CLAUDE.md'] }),
      'utf-8',
    );

    const { records } = buildNativeCapabilityInventory(context(fx), fx.env);
    const paths = records.map(r => r.sourcePath);
    // The usable entry still applies…
    expect(paths).not.toContain(join(fx.projectRoot, 'CLAUDE.md'));
    // …and everything else is still discovered.
    expect(paths).toContain(kept);
  });

  it('leaves everything in place when nothing is excluded', () => {
    const fx = makeFixture();
    const theirs = writeRule(join(fx.projectRoot, 'other-team', '.claude', 'rules'), 'theirs.md', 'Their rule.');
    const { records } = buildNativeCapabilityInventory(context(fx), fx.env);
    // Not discovered at all — the walk only covers the project's own rules dirs —
    // so the exclusion test above must not be passing for the wrong reason.
    expect(ruleRecords(records).map(r => r.sourcePath)).not.toContain(theirs);
    const ours = writeRule(join(fx.projectRoot, '.claude', 'rules'), 'ours.md', 'Our rule.');
    const second = buildNativeCapabilityInventory(context(fx), fx.env);
    expect(ruleRecords(second.records).map(r => r.sourcePath)).toContain(ours);
  });
});

describe('setting-source gating', () => {
  it('skips project rules when `project` is excluded, and keeps the user tier', () => {
    const fx = makeFixture();
    const userRule = writeRule(join(fx.configDir, 'rules'), 'personal.md', 'Personal rule.');
    const projectRule = writeRule(join(fx.projectRoot, '.claude', 'rules'), 'project.md', 'Project rule.');

    const withProject = buildNativeCapabilityInventory(context(fx), fx.env);
    expect(ruleRecords(withProject.records).map(r => r.sourcePath)).toContain(projectRule);

    const withoutProject = buildNativeCapabilityInventory(
      context(fx, { settingSources: ['user', 'local'] }),
      fx.env,
    );
    const paths = ruleRecords(withoutProject.records).map(r => r.sourcePath);
    expect(paths).not.toContain(projectRule);
    expect(paths).toContain(userRule);
  });
});

describe('`--add-dir` rule loading', () => {
  it('loads rules from an --add-dir root only behind the opt-in env var', () => {
    const fx = makeFixture();
    const extra = tmp('ns-gate-adddir-');
    const extraRule = writeRule(join(extra, '.claude', 'rules'), 'shared.md', 'Shared rule.');

    const off = buildNativeCapabilityInventory(
      context(fx, { additionalRuleDirectories: [extra] }),
      fx.env,
    );
    expect(ruleRecords(off.records).map(r => r.sourcePath)).not.toContain(extraRule);

    process.env[ADD_DIR_ENV] = '1';
    const on = buildNativeCapabilityInventory(
      context(fx, { additionalRuleDirectories: [extra] }),
      fx.env,
    );
    expect(ruleRecords(on.records).map(r => r.sourcePath)).toContain(extraRule);
  });

  it('never loads rules from a directory that is not an explicit --add-dir root', () => {
    // The `additionalDirectories` SETTING is documented as "Never" for memory
    // files, so nothing ambient may feed this list — only the explicit roots the
    // caller passes.
    const fx = makeFixture();
    const extra = tmp('ns-gate-setting-only-');
    const extraRule = writeRule(join(extra, '.claude', 'rules'), 'shared.md', 'Shared rule.');

    process.env[ADD_DIR_ENV] = '1';
    const { records } = buildNativeCapabilityInventory(
      context(fx, { additionalRuleDirectories: [] }),
      fx.env,
    );
    expect(ruleRecords(records).map(r => r.sourcePath)).not.toContain(extraRule);
  });

  /**
   * P3.339 — the notice, and the sentence it now carries.
   *
   * This docblock used to say the empty case was also the SHIPPED case, because
   * `storage-runtime.ts toWorkspacePolicyContext` set nothing and every real
   * session took the empty branch. It produces the roots since the owner's
   * sitting §1.4 answer (A), so an empty list now means the OPERATOR named no
   * directories — and the notice says that instead of pointing at a host field
   * the operator cannot do anything about. An inventory with no rules is still
   * indistinguishable from a root that had none, which is why the notice is
   * pinned rather than left to a reader of the log.
   */
  it('says once when the opt-in is on and no root was supplied', () => {
    const fx = makeFixture();
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    resetInertAdditionalDirectoryRulesNotice();
    try {
      process.env[ADD_DIR_ENV] = '1';
      buildNativeCapabilityInventory(context(fx, { additionalRuleDirectories: [] }), fx.env);
      buildNativeCapabilityInventory(context(fx, {}), fx.env);
      expect(warnings.filter(a => String(a[0]).includes(ADD_DIR_ENV))).toHaveLength(1);
      expect(String(warnings.find(a => String(a[0]).includes(ADD_DIR_ENV))?.[0]))
        .toContain('this session was given no additional rule directories');
      // The sentence has to name where the roots COME FROM, or an operator with
      // the env var set has nowhere to go. That is the whole content of the
      // change P3.339's producer forced on this notice.
      expect(String(warnings.find(a => String(a[0]).includes(ADD_DIR_ENV))?.[0]))
        .toContain('`additionalDirectories` setting in config.json');
    } finally {
      console.warn = original;
      resetInertAdditionalDirectoryRulesNotice();
    }
  });

  it('stays silent when the opt-in is OFF, and when a root IS supplied', () => {
    // The two negative controls. Without them the case above passes on a notice
    // that fires unconditionally, which would be its own kind of noise.
    const fx = makeFixture();
    const extra = tmp('ns-gate-adddir-quiet-');
    writeRule(join(extra, '.claude', 'rules'), 'shared.md', 'Shared rule.');
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    resetInertAdditionalDirectoryRulesNotice();
    try {
      delete process.env[ADD_DIR_ENV];
      buildNativeCapabilityInventory(context(fx, { additionalRuleDirectories: [] }), fx.env);
      process.env[ADD_DIR_ENV] = '1';
      buildNativeCapabilityInventory(context(fx, { additionalRuleDirectories: [extra] }), fx.env);
      expect(warnings.filter(a => String(a[0]).includes(ADD_DIR_ENV))).toHaveLength(0);
    } finally {
      console.warn = original;
      resetInertAdditionalDirectoryRulesNotice();
    }
  });
});
