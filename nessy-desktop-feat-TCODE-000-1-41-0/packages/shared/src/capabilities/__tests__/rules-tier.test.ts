/**
 * R28 — the rules instruction tier.
 *
 * Discovery half (Task 2): recursion, symlink RESOLUTION (the inverse of R4's
 * deliberate symlink refusal — `memory.md`: "The `.claude/rules/` directory
 * supports symlinks... Symlinks are resolved and loaded normally, and circular
 * symlinks are detected and handled gracefully"), and the two tiers
 * ("User-level rules are loaded before project rules, giving project rules
 * higher priority").
 *
 * Asserted through `buildNativeCapabilityInventory`, the production discovery
 * entry point — never through the walker in isolation.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';

import { buildNativeCapabilityInventory } from '../native-sources.ts';
import type { NativeCapabilitySourceRecord, WorkspacePolicyContext } from '../types.ts';

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

interface Fixture {
  configDir: string;
  homeSkills: string;
  workspaceRoot: string;
  projectRoot: string;
  env: { configDir: string; homeAgentsSkillsDir: string; adminSkillsDirs: readonly string[] };
}

// P2.455 — the administrator tier is pinned OFF for this file. Its DEFAULT
// roots are absolute machine-wide directories, so a rig that let them default
// would read the REAL ones on a centrally managed host — the deployment the
// tier exists for — and a fixture everywhere else, failing only there and
// looking like a content mismatch. The standing guard is
// `admin-skills-dirs-pinned.test.ts`; `admin-skill-tier-catalog.test.ts` is
// where the tier is deliberately turned ON.
function makeFixture(): Fixture {
  const configDir = tmp('ns-rules-config-');
  const homeSkills = tmp('ns-rules-home-');
  const workspaceRoot = tmp('ns-rules-ws-');
  const projectRoot = tmp('ns-rules-project-');
  return {
    configDir,
    homeSkills,
    workspaceRoot,
    projectRoot,
    env: { configDir, homeAgentsSkillsDir: homeSkills, adminSkillsDirs: [] },
  };
}

function context(fx: Fixture, overrides: Partial<WorkspacePolicyContext> = {}): WorkspacePolicyContext {
  return {
    workspaceId: 'ws-uuid-rules',
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

function writeRule(path: string, body: string, patterns?: string[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const frontmatter = patterns
    ? ['---', 'paths:', ...patterns.map(p => `  - "${p}"`), '---', ''].join('\n')
    : '';
  writeFileSync(path, `${frontmatter}${body}\n`, 'utf-8');
}

describe('R28 Task 2 — recursive rule discovery', () => {
  it('discovers rules in subdirectories (rules/frontend/react.md)', () => {
    const fx = makeFixture();
    const rulesDir = join(fx.projectRoot, '.agents', 'rules');
    mkdirSync(join(rulesDir, 'frontend'), { recursive: true });
    writeRule(join(rulesDir, 'frontend', 'react.md'), 'Nested react rule.');
    writeRule(join(rulesDir, 'testing.md'), 'Top-level testing rule.');

    const { records } = buildNativeCapabilityInventory(context(fx), fx.env);
    const paths = ruleRecords(records).map(r => r.sourcePath);
    expect(paths).toContain(join(rulesDir, 'frontend', 'react.md'));
    expect(paths).toContain(join(rulesDir, 'testing.md'));
  });

  it('loads an unscoped rule even though it has no `paths` frontmatter', () => {
    const fx = makeFixture();
    const rulesDir = join(fx.projectRoot, '.agents', 'rules');
    mkdirSync(rulesDir, { recursive: true });
    writeRule(join(rulesDir, 'style.md'), 'Unscoped style rule.');

    const { records } = buildNativeCapabilityInventory(context(fx), fx.env);
    expect(ruleRecords(records).map(r => r.sourcePath)).toContain(join(rulesDir, 'style.md'));
  });

  it('discovers path-scoped rules regardless of the working directory', () => {
    // The old loader compiled the rule glob against the WORKING DIRECTORY, so a
    // file glob dropped the record entirely. Discovery is now unconditional;
    // matching moved to the per-read trigger (Task 4).
    const fx = makeFixture();
    const rulesDir = join(fx.projectRoot, '.agents', 'rules');
    mkdirSync(rulesDir, { recursive: true });
    writeRule(join(rulesDir, 'api.md'), 'API rule.', ['src/api/**/*.ts']);

    const { records } = buildNativeCapabilityInventory(context(fx), fx.env);
    expect(ruleRecords(records).map(r => r.sourcePath)).toContain(join(rulesDir, 'api.md'));
  });
});

describe('R28 Task 2 — symlinks are RESOLVED, not refused', () => {
  it('loads rules through a symlinked rules directory', () => {
    const fx = makeFixture();
    const shared = tmp('ns-rules-shared-');
    writeRule(join(shared, 'security.md'), 'Shared security rule.');
    const rulesDir = join(fx.projectRoot, '.agents', 'rules');
    mkdirSync(rulesDir, { recursive: true });
    symlinkSync(shared, join(rulesDir, 'shared'), 'dir');

    const { records } = buildNativeCapabilityInventory(context(fx), fx.env);
    // Identity is the path relative to the rules directory, so a nested or
    // linked-in rule keeps a collision-free name.
    const names = ruleRecords(records).map(r => r.logicalName);
    expect(names).toContain('shared/security.md');
    expect(ruleRecords(records).map(r => r.sourcePath))
      .toContain(join(rulesDir, 'shared', 'security.md'));
  });

  it('loads a symlinked rule file', () => {
    const fx = makeFixture();
    const standards = tmp('ns-rules-standards-');
    writeRule(join(standards, 'security.md'), 'Company security rule.');
    const rulesDir = join(fx.projectRoot, '.agents', 'rules');
    mkdirSync(rulesDir, { recursive: true });
    symlinkSync(join(standards, 'security.md'), join(rulesDir, 'security.md'), 'file');

    const { records } = buildNativeCapabilityInventory(context(fx), fx.env);
    expect(ruleRecords(records).map(r => r.logicalName)).toContain('security.md');
  });

  it('terminates on a circular symlink and still loads the reachable rules', () => {
    const fx = makeFixture();
    const rulesDir = join(fx.projectRoot, '.agents', 'rules');
    mkdirSync(join(rulesDir, 'nested'), { recursive: true });
    writeRule(join(rulesDir, 'reachable.md'), 'Reachable rule.');
    writeRule(join(rulesDir, 'nested', 'deep.md'), 'Deep rule.');
    // nested/loop -> the rules root: walking it re-enters the directory forever
    // unless the walk detects the cycle.
    symlinkSync(rulesDir, join(rulesDir, 'nested', 'loop'), 'dir');

    const { records } = buildNativeCapabilityInventory(context(fx), fx.env);
    const names = ruleRecords(records).map(r => r.logicalName).sort();
    expect(names).toContain('reachable.md');
    expect(names).toContain('nested/deep.md');
    // Each reachable file exactly once, no repeated traversal through the loop.
    expect(names.filter(n => n === 'nested/deep.md')).toHaveLength(1);
  });
});

describe('R28 Task 2 — two tiers, project wins', () => {
  it('reads the user tier (CONFIG_DIR/rules) before the project tier', () => {
    const fx = makeFixture();
    const userRules = join(fx.configDir, 'rules');
    mkdirSync(userRules, { recursive: true });
    writeRule(join(userRules, 'style.md'), 'User style rule.');
    const projectRules = join(fx.projectRoot, '.agents', 'rules');
    mkdirSync(projectRules, { recursive: true });
    writeRule(join(projectRules, 'style.md'), 'Project style rule.');

    const { records } = buildNativeCapabilityInventory(context(fx), fx.env);
    const rules = ruleRecords(records);
    const userIndex = rules.findIndex(r => r.sourcePath === join(userRules, 'style.md'));
    const projectIndex = rules.findIndex(r => r.sourcePath === join(projectRules, 'style.md'));
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(projectIndex).toBeGreaterThanOrEqual(0);
    // Loaded before project rules, so the project rule wins for a model reading
    // top-to-bottom.
    expect(userIndex).toBeLessThan(projectIndex);
    expect(rules[userIndex]!.scope.kind).toBe('global');
    expect(rules[projectIndex]!.scope.kind).toBe('project');
  });

  it('reads `.claude/rules/` beside our own rule directories', () => {
    const fx = makeFixture();
    const claudeRules = join(fx.projectRoot, '.claude', 'rules');
    mkdirSync(claudeRules, { recursive: true });
    writeRule(join(claudeRules, 'imported.md'), 'Claude-shaped rule.');
    const ourRules = join(fx.projectRoot, '.agents', 'rules');
    mkdirSync(ourRules, { recursive: true });
    writeRule(join(ourRules, 'ours.md'), 'Our rule.');

    const { records } = buildNativeCapabilityInventory(context(fx), fx.env);
    const paths = ruleRecords(records).map(r => r.sourcePath);
    expect(paths).toContain(join(claudeRules, 'imported.md'));
    expect(paths).toContain(join(ourRules, 'ours.md'));
  });

  it('reads the workspace `.agents/rules` tier without a project working directory', () => {
    const fx = makeFixture();
    const rulesDir = join(fx.workspaceRoot, '.agents', 'rules');
    mkdirSync(rulesDir, { recursive: true });
    writeRule(join(rulesDir, 'workspace.md'), 'Workspace rule.');

    const { records } = buildNativeCapabilityInventory(
      context(fx, { workingDirectory: undefined, projectRoot: undefined, projectTrustState: 'none' }),
      fx.env,
    );
    expect(ruleRecords(records).map(r => r.sourcePath)).toContain(join(rulesDir, 'workspace.md'));
  });
});
