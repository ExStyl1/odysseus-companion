import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, setDefaultTimeout, spyOn } from 'bun:test';

import {
  buildNativeCapabilityInventory,
  collapseToUnqualifiedNames,
  isClaudeProjectAgentCopyKey,
  noticeUnverifiableManagedTier,
  resetUnverifiableManagedTierNotice,
} from '../native-sources.ts';
import type { WorkspacePolicyContext } from '../types.ts';

// P6.630 (W7-ab's half): this file's resting cost sits ABOVE bun's 5 s default,
// so the default manufactures its own red under load. Measured 2026-09-06 on
// this rig: batched with two sibling files at load 7.84 it gave 59 pass / 1 fail
// / 3 files, the single fail a "timed out after 5000ms" with ZERO assertion
// failures; the same file ALONE at 60 s, load 9.66, gave 46 pass / 0 fail / 1
// file in 23.32 s. So the floor is real filesystem work — every case builds a
// temp tree — and 60 s is ~2.6x that cold floor, the same value and reasoning as
// the sibling entry in `docs/superpowers/specs/2026-07-29-known-failing-tests.md`.
// Set against the MEASURED floor, never zero, and never by raising the global
// default, which would hide the whole class.
setDefaultTimeout(60_000);

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

function writeSkill(skillsDir: string, slug: string, name = slug): void {
  const dir = join(skillsDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\nBody`);
}

interface Fixture {
  configDir: string;
  homeSkills: string;
  workspaceRoot: string;
  env: { configDir: string; homeAgentsSkillsDir: string; adminSkillsDirs: readonly string[] };
}

function makeFixture(): Fixture {
  const configDir = tmp('ns-config-');
  const homeSkills = tmp('ns-home-skills-');
  const workspaceRoot = tmp('ns-ws-');
  // Global managed skills + agent + mcp.
  writeSkill(join(configDir, 'skills'), 'shared');
  mkdirSync(join(configDir, 'agents'), { recursive: true });
  writeFileSync(join(configDir, 'agents', 'globalbot.md'), `---\nname: globalbot\nsystemPrompt: hi\n---\nx`);
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({
    mcpServers: { globalFiles: { type: 'stdio', command: 'files-server' } },
  }));
  // Home personal skills.
  writeSkill(homeSkills, 'homer');
  // Workspace skills (duplicate slug 'shared').
  writeSkill(join(workspaceRoot, 'skills'), 'shared');
  writeFileSync(join(workspaceRoot, 'permissions.json'), '{}');
  // The administrator tier is pinned OFF for this file (P2.449). Its roots are
  // absolute machine-wide directories, so a fixture that let them default would
  // count a different number of records on a centrally managed machine than on
  // an unmanaged one. `admin-skill-tier-catalog.test.ts` is where it is turned on.
  return {
    configDir,
    homeSkills,
    workspaceRoot,
    env: { configDir, homeAgentsSkillsDir: homeSkills, adminSkillsDirs: [] },
  };
}

function baseContext(fx: Fixture, overrides: Partial<WorkspacePolicyContext> = {}): WorkspacePolicyContext {
  return {
    workspaceId: 'ws-uuid-1',
    workspaceRootPath: fx.workspaceRoot,
    projectTrustState: 'none',
    projectTrustRevision: '',
    ...overrides,
  };
}

describe('buildNativeCapabilityInventory — global + workspace always resolve', () => {
  it('discovers global and workspace records without any project trust', () => {
    const fx = makeFixture();
    const { records } = buildNativeCapabilityInventory(baseContext(fx), fx.env);

    const globalSkills = records.filter(r => r.kind === 'skill' && r.scope.kind === 'global');
    const workspaceSkills = records.filter(r => r.kind === 'skill' && r.scope.kind === 'workspace');
    expect(globalSkills.map(r => r.logicalName).sort()).toEqual(['homer', 'shared']);
    expect(workspaceSkills.map(r => r.logicalName)).toEqual(['shared']);
    expect(records.some(r => r.kind === 'agent' && r.logicalName === 'globalbot')).toBe(true);
    expect(records.some(r => r.kind === 'mcp' && r.scope.kind === 'global')).toBe(true);
    expect(records.some(r => r.kind === 'permission' && r.scope.kind === 'workspace')).toBe(true);
    // server-only source paths are present on records.
    const managedShared = globalSkills.find(r => r.logicalName === 'shared');
    expect(managedShared!.sourcePath).toContain(fx.configDir);
  });

  it('keeps duplicate slugs separately addressable (no silent deletion)', () => {
    const fx = makeFixture();
    const trusted = tmp('ns-proj-');
    writeSkill(join(trusted, '.agents', 'skills'), 'shared'); // 3rd 'shared'
    const ctx = baseContext(fx, {
      workingDirectory: trusted,
      projectRoot: trusted,
      projectKey: 'p_' + 'a'.repeat(32),
      projectTrustState: 'trusted',
    });
    const { records } = buildNativeCapabilityInventory(ctx, fx.env);
    const shared = records.filter(r => r.kind === 'skill' && r.logicalName === 'shared');
    expect(shared).toHaveLength(3);
    expect(new Set(shared.map(r => r.key)).size).toBe(3);
    // Compatibility collapse still yields a single winner (project).
    const collapsed = collapseToUnqualifiedNames(records, 'skill');
    expect(collapsed.get('shared')!.scope.kind).toBe('project');
  });

  it('captures safe Skill frontmatter and Source display metadata', () => {
    const fx = makeFixture();
    writeSkill(join(fx.workspaceRoot, 'skills'), 'review', 'Review Changes');
    const sourceDir = join(fx.workspaceRoot, 'sources', 'issues');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({
      slug: 'issues',
      name: 'Issue Tracker',
      tagline: 'Issues, pull requests, and release work',
      provider: 'gitlab',
      type: 'api',
    }));

    const { records } = buildNativeCapabilityInventory(baseContext(fx), fx.env);
    expect(records.find(record => record.kind === 'skill' && record.logicalName === 'review')).toMatchObject({
      displayName: 'Review Changes',
      description: 'Review Changes skill',
    });
    expect(records.find(record => record.kind === 'source' && record.logicalName === 'issues')).toMatchObject({
      displayName: 'Issue Tracker',
      description: 'Issues, pull requests, and release work',
      sourceType: 'api',
    });
  });
});

describe('buildNativeCapabilityInventory — workspace sources/automations, memory, instructions', () => {
  it('pins conventional Source and Skill icons from the same captured bytes', () => {
    const fx = makeFixture();
    const skillDir = join(fx.workspaceRoot, 'skills', 'pinned-skill');
    writeSkill(join(fx.workspaceRoot, 'skills'), 'pinned-skill');
    const skillIcon = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>';
    writeFileSync(join(skillDir, 'icon.svg'), skillIcon);

    const sourceDir = join(fx.workspaceRoot, 'sources', 'pinned-source');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({
      slug: 'pinned-source',
      name: 'Pinned Source',
      type: 'api',
    }));
    const sourceIcon = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    writeFileSync(join(sourceDir, 'icon.png'), sourceIcon);

    const { records } = buildNativeCapabilityInventory(baseContext(fx), fx.env);
    const skill = records.find(record => record.kind === 'skill' && record.logicalName === 'pinned-skill');
    const source = records.find(record => record.kind === 'source' && record.logicalName === 'pinned-source');

    expect(skill?.iconResource).toEqual({
      revision: expect.any(String),
      contentHash: createHash('sha256').update(Buffer.from(skillIcon)).digest('hex'),
      dataUrl: `data:image/svg+xml;base64,${Buffer.from(skillIcon).toString('base64')}`,
    });
    expect(source?.iconResource).toEqual({
      revision: expect.any(String),
      contentHash: createHash('sha256').update(sourceIcon).digest('hex'),
      dataUrl: `data:image/png;base64,${sourceIcon.toString('base64')}`,
    });
    expect(JSON.stringify(skill?.iconResource)).not.toContain(skillDir);
    expect(JSON.stringify(source?.iconResource)).not.toContain(sourceDir);
  });

  it('emits workspace source records without any project trust', () => {
    const fx = makeFixture();
    const sourceDir = join(fx.workspaceRoot, 'sources', 'github');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({ slug: 'github', type: 'mcp' }));
    writeFileSync(join(sourceDir, 'guide.md'), '# GitHub\n\n## Scope\nIssues and pull requests.');
    writeFileSync(join(sourceDir, 'permissions.json'), JSON.stringify({ allowedMcpPatterns: ['^mcp__github__'] }));

    const { records } = buildNativeCapabilityInventory(baseContext(fx), fx.env);
    const source = records.find(r => r.kind === 'source' && r.logicalName === 'github');
    expect(source).toBeDefined();
    expect(source!.scope).toEqual({ kind: 'workspace', workspaceId: 'ws-uuid-1' });
    expect(source!.sourcePath).toBe(sourceDir);
    expect(source).toMatchObject({ sourceType: 'mcp', sourceEnabled: true });
    expect(source!.guideResource).toMatchObject({
      sourcePath: join(sourceDir, 'guide.md'),
      revision: expect.any(String),
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(records.find(record =>
      record.kind === 'permission'
      && record.logicalName === 'sources/github/permissions.json'
    )).toMatchObject({
      scope: { kind: 'workspace', workspaceId: 'ws-uuid-1' },
      sourcePath: join(sourceDir, 'permissions.json'),
      permissionSourceSlug: 'github',
    });
  });

  it('pins skill alwaysAllow and projects source permissions (U2), excluding filesystem paths', () => {
    const fx = makeFixture();
    // Skill with alwaysAllow frontmatter.
    const skillDir = join(fx.workspaceRoot, 'skills', 'always');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: always\ndescription: d\nalwaysAllow:\n  - Bash(git status)\n  - mcp__gh__list\n---\nBody`,
    );
    // Source whose permissions.json carries tool/bash/mcp/api AND path rules.
    const sourceDir = join(fx.workspaceRoot, 'sources', 'perms');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({ slug: 'perms', type: 'api' }));
    writeFileSync(join(sourceDir, 'permissions.json'), JSON.stringify({
      allowedBashPatterns: [{ pattern: 'git status' }],
      allowedMcpPatterns: ['list'],
      allowedApiEndpoints: [{ method: 'GET', path: '/issues' }],
      disallowedTools: ['dangerous_tool'],
      // Path-based rules MUST NOT reach the projection (Safe model).
      allowedWritePaths: ['/Users/secret/out'],
      deniedPaths: ['/etc/passwd'],
    }));

    const { records } = buildNativeCapabilityInventory(baseContext(fx), fx.env);

    const skill = records.find(r => r.kind === 'skill' && r.logicalName === 'always');
    expect(skill!.skillAlwaysAllow).toEqual(['Bash(git status)', 'mcp__gh__list']);

    const source = records.find(r => r.kind === 'source' && r.logicalName === 'perms');
    // F1.1153 — `git status` (an allowedBashPatterns entry) is no longer listed: since DN-231 a source file's bash
    // patterns are ignored (`sourceConfigOwnToolsOnly`), so "allowed" would be untrue.
    expect(source!.sourcePermissions).toEqual([
      { pattern: 'list', access: 'allowed' },
      { pattern: 'GET /issues', access: 'allowed' },
      { pattern: 'dangerous_tool', access: 'blocked' },
    ]);
    // No absolute path from allowedWritePaths/deniedPaths leaks into the projection.
    expect(JSON.stringify(source!.sourcePermissions)).not.toContain('/Users');
    expect(JSON.stringify(source!.sourcePermissions)).not.toContain('/etc/passwd');
  });

  // F1.1153 (origin DN-231) — the Sources page listed a source file's allowedBashPatterns and its allow rules for
  // OTHER tools as "allowed", while DN-231 (8cc5128c6) made the runtime ignore exactly those entries. The page now
  // reads the file through the same `sourceConfigOwnToolsOnly` the enforcement path uses, so it lists what applies.
  it('F1.1153: a source file\'s ignored grants are not listed as allowed; its own-tool grants and every block are', () => {
    const fx = makeFixture();
    const sourceDir = join(fx.workspaceRoot, 'sources', 'linear');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({ slug: 'linear', type: 'mcp' }));
    writeFileSync(join(sourceDir, 'permissions.json'), JSON.stringify({
      allowedBashPatterns: [{ pattern: '^touch\\b' }],
      allowedMcpPatterns: ['list'],
      toolRules: [
        { pattern: 'Write', action: 'allow' },
        { pattern: 'mcp__other__*', action: 'allow' },
        { pattern: 'mcp__linear__delete_*', action: 'allow' },
        { pattern: 'Bash', action: 'deny' },
      ],
    }));

    const { records } = buildNativeCapabilityInventory(baseContext(fx), fx.env);
    const rows = records.find(r => r.kind === 'source' && r.logicalName === 'linear')!.sourcePermissions;
    expect(rows).toEqual([
      { pattern: 'list', access: 'allowed' },
      { pattern: 'mcp__linear__delete_*', access: 'allowed' },
      { pattern: 'Bash', access: 'blocked' },
    ]);
  });

  it('projects the documented skill invocation controls onto the inventory record', () => {
    const fx = makeFixture();
    const skillDir = join(fx.workspaceRoot, 'skills', 'controlled');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: controlled\ndescription: d\ndisable-model-invocation: true\nuser-invocable: false\nallowed-tools: Read Grep\n---\nBody',
    );

    const { records } = buildNativeCapabilityInventory(baseContext(fx), fx.env);

    const skill = records.find(r => r.kind === 'skill' && r.logicalName === 'controlled');
    expect(skill!.skillDisableModelInvocation).toBe(true);
    expect(skill!.skillUserInvocable).toBe(false);
    expect(skill!.skillAllowedTools).toEqual(['Read', 'Grep']);
  });

  it('omits the skill invocation controls when the skill does not state them', () => {
    const fx = makeFixture();
    writeSkill(join(fx.workspaceRoot, 'skills'), 'uncontrolled');

    const { records } = buildNativeCapabilityInventory(baseContext(fx), fx.env);

    const skill = records.find(r => r.kind === 'skill' && r.logicalName === 'uncontrolled')!;
    expect('skillDisableModelInvocation' in skill).toBe(false);
    expect('skillUserInvocable' in skill).toBe(false);
    expect('skillAllowedTools' in skill).toBe(false);
  });

  it('omits U2 fields when a skill has no alwaysAllow and a source has no rules', () => {
    const fx = makeFixture();
    const skillDir = join(fx.workspaceRoot, 'skills', 'plain');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: plain\ndescription: d\n---\nBody`);
    const sourceDir = join(fx.workspaceRoot, 'sources', 'bare');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({ slug: 'bare', type: 'api' }));

    const { records } = buildNativeCapabilityInventory(baseContext(fx), fx.env);
    expect(records.find(r => r.kind === 'skill' && r.logicalName === 'plain')!.skillAlwaysAllow).toBeUndefined();
    expect(records.find(r => r.kind === 'source' && r.logicalName === 'bare')!.sourcePermissions).toBeUndefined();
  });

  it('emits the workspace automations.json record', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.workspaceRoot, 'automations.json'), JSON.stringify({ automations: {} }));

    const { records } = buildNativeCapabilityInventory(baseContext(fx), fx.env);
    const automation = records.find(r => r.kind === 'automation');
    expect(automation).toBeDefined();
    expect(automation!.scope.kind).toBe('workspace');
    expect(automation!.logicalName).toBe('automations.json');
  });

  it('emits user/global MEMORY.md and workspace .agents/rules memory records', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.configDir, 'MEMORY.md'), '# Memory\n@import ./user-notes.md\n');
    writeFileSync(join(fx.configDir, 'user-notes.md'), '- user memory line\n');
    const rulesDir = join(fx.workspaceRoot, '.agents', 'rules');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, 'app.md'), '---\npaths: packages/app/**\n---\n@import ./app-note.md\nApp rule.');
    writeFileSync(join(rulesDir, 'app-note.md'), 'App imported note.');
    writeFileSync(join(rulesDir, 'docs.md'), '---\npaths: packages/docs/**\n---\n@import ./docs-note.md\nDocs rule.');
    writeFileSync(join(rulesDir, 'docs-note.md'), 'Docs imported note.');

    const { records } = buildNativeCapabilityInventory(baseContext(fx, {
      workingDirectory: join(fx.workspaceRoot, 'packages', 'app'),
    }), fx.env);
    expect(records.some(r => r.kind === 'memory' && r.scope.kind === 'global' && r.logicalName === 'MEMORY.md')).toBe(true);
    expect(records.some(r =>
      r.kind === 'memory'
      && r.scope.kind === 'global'
      && r.sourcePath === join(fx.configDir, 'user-notes.md')
    )).toBe(true);
    const workspaceMemoryPaths = records
      .filter(r => r.kind === 'memory' && r.scope.kind === 'workspace')
      .map(r => r.sourcePath);
    // R28: discovery is unconditional. A `paths:` glob describes the FILE the
    // rule fires on, so it can no longer be evaluated against the working
    // directory at inventory time — every rule file is inventoried and the
    // per-read trigger decides which ones reach the model.
    expect(workspaceMemoryPaths).toContain(join(rulesDir, 'app.md'));
    expect(workspaceMemoryPaths).toContain(join(rulesDir, 'app-note.md'));
    expect(workspaceMemoryPaths).toContain(join(rulesDir, 'docs.md'));
    expect(workspaceMemoryPaths).toContain(join(rulesDir, 'docs-note.md'));
    expect(records.find(r => r.sourcePath === join(rulesDir, 'app.md'))).toMatchObject({
      memoryFormat: 'rule',
    });
  });

  it('pins session memory imports and rejects imports outside the session data directory', () => {
    const fx = makeFixture();
    const sessionData = tmp('ns-session-data-');
    const outside = join(tmp('ns-memory-outside-'), 'outside.md');
    writeFileSync(outside, 'must stay outside');
    writeFileSync(join(sessionData, 'notes.md'), 'contained session note');
    const sessionMemory = join(sessionData, 'MEMORY.md');
    writeFileSync(sessionMemory, `# Memory\n@import ./notes.md\n@import ${outside}\n`);

    const { records } = buildNativeCapabilityInventory(baseContext(fx, {
      sessionMemoryFilePath: sessionMemory,
    }), fx.env);
    const sessionMemories = records.filter(record =>
      record.kind === 'memory'
      && record.scope.kind === 'workspace'
      && [sessionMemory, join(sessionData, 'notes.md'), outside].includes(record.sourcePath)
    );
    expect(sessionMemories.map(record => record.sourcePath).sort()).toEqual([
      sessionMemory,
      join(sessionData, 'notes.md'),
    ].sort());
  });

  it('follows imports mid-line and without an extension, and never inside code (R55)', () => {
    // `memory.md:101` — imports are recognised "anywhere in your CLAUDE.md", and
    // the example at `:104` carries two mid-sentence. `:99` — "Import parsing
    // skips Markdown code spans and fenced code blocks."  DISCOVERY is where
    // expansion is decided: a token that is not recognised here never becomes a
    // capability record, so the file never loads on either live delivery.
    const fx = makeFixture();
    writeFileSync(join(fx.configDir, 'MEMORY.md'), [
      '# Memory',
      'See @README for project overview and @package.json for available npm commands for this project.',
      '- git workflow @docs/git-instructions.md',
      'Mention it without importing by writing `@backticked.md` in backticks.',
      '```text',
      '@fenced.md',
      '```',
      '<!-- @commented.md -->',
      'Mail igor@notanimport.md is not a token either.',
    ].join('\n'));
    for (const name of ['README', 'package.json', 'backticked.md', 'fenced.md', 'commented.md', 'notanimport.md']) {
      writeFileSync(join(fx.configDir, name), `body of ${name}`);
    }
    mkdirSync(join(fx.configDir, 'docs'), { recursive: true });
    writeFileSync(join(fx.configDir, 'docs', 'git-instructions.md'), 'git body');

    const { records } = buildNativeCapabilityInventory(baseContext(fx), fx.env);
    const imported = records
      .filter(r => r.kind === 'memory' && r.scope.kind === 'global' && r.memoryImportParentPath)
      .map(r => r.sourcePath)
      .sort();
    expect(imported).toEqual([
      join(fx.configDir, 'README'),
      join(fx.configDir, 'docs', 'git-instructions.md'),
      join(fx.configDir, 'package.json'),
    ].sort());
    for (const path of imported) {
      expect(records.find(r => r.sourcePath === path)!.memoryImportParentPath).toBe(join(fx.configDir, 'MEMORY.md'));
    }
  });

  it('stops an import chain at the documented four hops (R55)', () => {
    // `memory.md:97` — "Imported files can recursively import other files, with a
    // maximum depth of four hops." `MEMORY_IMPORT_DEPTH_LIMIT` was 5, so a fifth
    // hop loaded.
    const fx = makeFixture();
    writeFileSync(join(fx.configDir, 'MEMORY.md'), '# Memory\n@hop1.md\n');
    for (const hop of [1, 2, 3, 4]) {
      writeFileSync(join(fx.configDir, `hop${hop}.md`), `hop ${hop} body\n@hop${hop + 1}.md\n`);
    }
    writeFileSync(join(fx.configDir, 'hop5.md'), 'hop 5 body\n');

    const { records } = buildNativeCapabilityInventory(baseContext(fx), fx.env);
    const paths = records.filter(r => r.kind === 'memory' && r.scope.kind === 'global').map(r => r.sourcePath);
    for (const hop of [1, 2, 3, 4]) expect(paths).toContain(join(fx.configDir, `hop${hop}.md`));
    expect(paths).not.toContain(join(fx.configDir, 'hop5.md'));
  });

  it('resolves a relative import against the importing FILE, not the root or the cwd (R55)', () => {
    // `memory.md:97` — "Relative paths resolve relative to the file containing
    // the import, not the working directory." The decoy beside the ROOT file has
    // the same name as the one beside the importer.
    const fx = makeFixture();
    mkdirSync(join(fx.configDir, 'sub'), { recursive: true });
    writeFileSync(join(fx.configDir, 'MEMORY.md'), '# Memory\n@sub/topic.md\n');
    writeFileSync(join(fx.configDir, 'sub', 'topic.md'), 'topic body\n@sibling.md\n');
    writeFileSync(join(fx.configDir, 'sub', 'sibling.md'), 'correct sibling');
    writeFileSync(join(fx.configDir, 'sibling.md'), 'decoy beside the root');

    const { records } = buildNativeCapabilityInventory(baseContext(fx), fx.env);
    const paths = records.filter(r => r.kind === 'memory' && r.scope.kind === 'global').map(r => r.sourcePath);
    expect(paths).toContain(join(fx.configDir, 'sub', 'sibling.md'));
    expect(paths).not.toContain(join(fx.configDir, 'sibling.md'));
    expect(records.find(r => r.sourcePath === join(fx.configDir, 'sub', 'sibling.md'))!.memoryImportParentPath)
      .toBe(join(fx.configDir, 'sub', 'topic.md'));
  });

  it('emits workspace AGENTS.md as an instruction record, never an agent', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.workspaceRoot, 'AGENTS.md'), '# workspace rules');

    const { records } = buildNativeCapabilityInventory(baseContext(fx), fx.env);
    expect(records.some(r => r.kind === 'instruction' && r.scope.kind === 'workspace' && r.logicalName === 'AGENTS.md')).toBe(true);
    expect(records.some(r => r.kind === 'agent' && r.logicalName.toUpperCase() === 'AGENTS')).toBe(false);
  });

  it('never treats CLAUDE.md / CLAUDE.local.md as workspace agents (W6 minor, matches definitions.ts)', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.workspaceRoot, 'CLAUDE.md'), '# claude workspace rules');
    writeFileSync(join(fx.workspaceRoot, 'CLAUDE.local.md'), '# claude local rules');

    const { records } = buildNativeCapabilityInventory(baseContext(fx), fx.env);
    // Instruction records are still emitted for CLAUDE* files.
    expect(records.some(r => r.kind === 'instruction' && r.logicalName === 'CLAUDE.md')).toBe(true);
    expect(records.some(r => r.kind === 'instruction' && r.logicalName === 'CLAUDE.local.md')).toBe(true);
    // But they are NEVER agent definitions.
    expect(records.some(r => r.kind === 'agent' && r.logicalName.toUpperCase().startsWith('CLAUDE'))).toBe(false);
  });
});

describe('buildNativeCapabilityInventory — instruction files up to the project root', () => {
  /** Instruction sourcePaths in record order, project scope only. */
  function projectInstructionPaths(ctx: WorkspacePolicyContext, env: Fixture['env']): string[] {
    return buildNativeCapabilityInventory(ctx, env).records
      .filter(r => r.kind === 'instruction' && r.scope.kind === 'project')
      .map(r => r.sourcePath!);
  }

  function trustedProject(fx: Fixture, project: string, workingDirectory: string): WorkspacePolicyContext {
    return baseContext(fx, {
      workingDirectory,
      projectRoot: project,
      projectKey: 'p_' + 'f'.repeat(32),
      projectTrustState: 'trusted',
    });
  }

  it('finds an instruction file in an ancestor directory up to the project root', () => {
    const fx = makeFixture();
    const project = tmp('ns-proj-walk-');
    // Monorepo shape: the contract lives at the root, the session runs two
    // levels down. Today nothing above the working directory is read.
    writeFileSync(join(project, 'AGENTS.md'), 'root rules');
    const cwd = join(project, 'packages', 'web');
    mkdirSync(cwd, { recursive: true });

    expect(projectInstructionPaths(trustedProject(fx, project, cwd), fx.env))
      .toEqual([join(project, 'AGENTS.md')]);
  });

  it('reads the nearest file last so it wins for a model reading top-to-bottom', () => {
    const fx = makeFixture();
    const project = tmp('ns-proj-walk-order-');
    writeFileSync(join(project, 'AGENTS.md'), 'root');
    const cwd = join(project, 'packages', 'web');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'AGENTS.md'), 'package');

    expect(projectInstructionPaths(trustedProject(fx, project, cwd), fx.env)).toEqual([
      join(project, 'AGENTS.md'),
      join(cwd, 'AGENTS.md'),
    ]);
  });

  it('never walks above the project root', () => {
    const fx = makeFixture();
    const outside = tmp('ns-proj-outside-');
    writeFileSync(join(outside, 'AGENTS.md'), 'must not load');
    const project = join(outside, 'repo');
    const cwd = join(project, 'packages', 'web');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(project, 'AGENTS.md'), 'repo rules');

    expect(projectInstructionPaths(trustedProject(fx, project, cwd), fx.env))
      .toEqual([join(project, 'AGENTS.md')]);
  });

  it('bounds the ancestor layers so a deep tree cannot multiply the context', () => {
    const fx = makeFixture();
    const project = tmp('ns-proj-walk-cap-');
    // 10 strict-ancestor levels each carrying one instruction file; the cap is
    // counted root-first, so the levels NEAREST the working directory are the
    // ones dropped and the repo-wide root contract always survives.
    let dir = project;
    const ancestors: string[] = [];
    writeFileSync(join(project, 'AGENTS.md'), 'level 0');
    ancestors.push(project);
    for (let level = 1; level < 10; level += 1) {
      dir = join(dir, `l${level}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'AGENTS.md'), `level ${level}`);
      ancestors.push(dir);
    }
    const cwd = join(dir, 'cwd');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'AGENTS.md'), 'cwd');

    const paths = projectInstructionPaths(trustedProject(fx, project, cwd), fx.env);
    // 8 ancestor layers, root-first, plus the working directory's own file,
    // which is never subject to the walk's cap.
    expect(paths).toEqual([
      ...ancestors.slice(0, 8).map(level => join(level, 'AGENTS.md')),
      join(cwd, 'AGENTS.md'),
    ]);

    // P6.388 — and it SAYS which ones it dropped. Until this existed the cap
    // was a bare `break`: the two layers nearest the working directory vanished
    // from the model's context and nothing anywhere recorded it.
    const { droppedInstructionLayers } = buildNativeCapabilityInventory(
      trustedProject(fx, project, cwd), fx.env,
    );
    expect(droppedInstructionLayers).toEqual(
      ancestors.slice(8).map(level => ({
        path: join(level, 'AGENTS.md'),
        reason: 'ancestor-layer-cap',
        limit: 8,
      })),
    );
    // The whole cost, not the first file the cap reached: `continue`, not
    // `break`. Ten ancestor levels, eight kept, so exactly two are named.
    expect(droppedInstructionLayers).toHaveLength(2);
  });

  it('a dropped layer is PROBED, not consumed — a later import of the same file still loads', () => {
    // The hazard the P6.388 change introduced and must not ship: the cap now
    // reads a file to decide whether it was a real layer, and
    // `importedFileRecords` marks every file it visits as seen. Marked seen, a
    // dropped ancestor would be silently unavailable to a working-directory
    // file that imports it — a file the user CAN still reach losing its only
    // remaining route. The probe uses a throwaway seen-set for exactly this.
    const fx = makeFixture();
    const project = tmp('ns-proj-walk-probe-');
    let dir = project;
    writeFileSync(join(project, 'AGENTS.md'), 'level 0');
    for (let level = 1; level < 10; level += 1) {
      dir = join(dir, `l${level}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'AGENTS.md'), `level ${level}`);
    }
    // `dir` is l9, the deepest ancestor and therefore one of the two the cap
    // drops. The working directory imports it explicitly.
    const cwd = join(dir, 'cwd');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'AGENTS.md'), 'cwd rules\n@../AGENTS.md\n');

    const paths = projectInstructionPaths(trustedProject(fx, project, cwd), fx.env);
    expect(paths).toContain(join(dir, 'AGENTS.md'));
    // Still reported as dropped BY THE WALK, which is the honest reading: the
    // walk did not take it, an import did.
    const { droppedInstructionLayers } = buildNativeCapabilityInventory(
      trustedProject(fx, project, cwd), fx.env,
    );
    expect(droppedInstructionLayers?.map(layer => layer.path)).toContain(join(dir, 'AGENTS.md'));
  });

  it('drops nothing, and says nothing, when the tree is shallower than the cap', () => {
    // The negative control for the record above: a cap that reports on a tree
    // it did not truncate would be worse than one that reports nothing.
    const fx = makeFixture();
    const project = tmp('ns-proj-walk-uncapped-');
    let dir = project;
    writeFileSync(join(project, 'AGENTS.md'), 'level 0');
    for (let level = 1; level < 4; level += 1) {
      dir = join(dir, `l${level}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'AGENTS.md'), `level ${level}`);
    }
    const cwd = join(dir, 'cwd');
    mkdirSync(cwd, { recursive: true });

    const { droppedInstructionLayers } = buildNativeCapabilityInventory(
      trustedProject(fx, project, cwd), fx.env,
    );
    expect(droppedInstructionLayers).toEqual([]);
  });

  it('P6.387 — an @path import leaving the project is REFUSED and RECORDED, not silently dropped', () => {
    // Until this existed the refusal was a bare `return`: the author wrote
    // `@../outside.md`, nothing loaded it, and nothing anywhere said why —
    // indistinguishable from a broken import scanner.
    const fx = makeFixture();
    const outer = tmp('ns-proj-import-outer-');
    writeFileSync(join(outer, 'outside.md'), 'instructions from outside the project');
    const project = join(outer, 'inner');
    mkdirSync(project, { recursive: true });
    const cwd = project;
    writeFileSync(join(cwd, 'AGENTS.md'), 'project rules\n@../outside.md\n@./inside.md\n');
    writeFileSync(join(cwd, 'inside.md'), 'a sibling that IS in the project');

    const context = trustedProject(fx, project, cwd);
    const paths = projectInstructionPaths(context, fx.env);
    // The refusal STANDS — the outside file is not a record.
    expect(paths).not.toContain(join(outer, 'outside.md'));
    // Positive control on the same walk: an in-project import still loads, so
    // the assertion above is about containment and not about a dead scanner.
    expect(paths).toContain(join(cwd, 'inside.md'));

    const { refusedProjectImports } = buildNativeCapabilityInventory(context, fx.env);
    expect(refusedProjectImports).toEqual([{
      path: join(outer, 'outside.md'),
      importerPath: join(cwd, 'AGENTS.md'),
      reason: 'outside-containment-root',
    }]);
  });

  it('records nothing when every import stays inside the project', () => {
    // The negative control. A report about a walk that refused nothing would be
    // worse than no report.
    const fx = makeFixture();
    const project = tmp('ns-proj-import-clean-');
    writeFileSync(join(project, 'AGENTS.md'), 'project rules\n@./inside.md\n');
    writeFileSync(join(project, 'inside.md'), 'in-project');

    const { refusedProjectImports } = buildNativeCapabilityInventory(
      trustedProject(fx, project, project), fx.env,
    );
    expect(refusedProjectImports).toEqual([]);
  });

  it('stops at the project root — the documented divergence, refused by name', () => {
    // `memory.md#how-claude-md-files-load`: "Claude Code loads `CLAUDE.md` and
    // `CLAUDE.local.md` from your current working directory and every directory
    // above it." We stop at the project root instead, deliberately: walking
    // past it would read a PARENT checkout's contract into a nested one. This
    // pins the refusal so it is a decision rather than an accident, and so the
    // day someone changes it they change a test that says why.
    const fx = makeFixture();
    const outer = tmp('ns-proj-outer-');
    writeFileSync(join(outer, 'AGENTS.md'), 'the parent repository contract');
    const project = join(outer, 'inner');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'AGENTS.md'), 'the project contract');
    const cwd = join(project, 'cwd');
    mkdirSync(cwd, { recursive: true });

    const paths = projectInstructionPaths(trustedProject(fx, project, cwd), fx.env);
    expect(paths).toEqual([join(project, 'AGENTS.md')]);
    // Refused, not "capped": nothing above the project root is reported as a
    // dropped layer either, because the walk never looked there.
    const { droppedInstructionLayers } = buildNativeCapabilityInventory(
      trustedProject(fx, project, cwd), fx.env,
    );
    expect(droppedInstructionLayers).toEqual([]);
  });

  /**
   * R77 · f099 part B — `memory.md:95`'s "CLAUDE.md files can import additional
   * files using `@path/to/import` syntax" is about THIS file family, and R55
   * wired the scanner to MEMORY.md and rules only. Discovery is where expansion
   * is decided: a file that becomes no record can never load.
   */
  it('turns a project CLAUDE.md `@README` into an instruction record naming its importer (R77)', () => {
    const fx = makeFixture();
    const project = tmp('ns-proj-instr-import-');
    const cwd = project;
    // The page's own example line, mid-sentence and without an extension.
    writeFileSync(join(project, 'CLAUDE.md'), 'See @README for project overview.\n');
    writeFileSync(join(project, 'README'), 'readme body');

    const { records } = buildNativeCapabilityInventory(trustedProject(fx, project, cwd), fx.env);
    const imported = records.find(r => r.kind === 'instruction' && r.sourcePath === join(project, 'README'));
    expect(imported).toBeDefined();
    expect(imported!.memoryImportParentPath).toBe(join(project, 'CLAUDE.md'));
    // A distinct key, so the import cannot silently shadow another record.
    expect(imported!.key).not.toBe(records.find(r => r.sourcePath === join(project, 'CLAUDE.md'))!.key);
  });

  it('gives an `@AGENTS.md` sibling NO second record — one file, one record (R77)', () => {
    const fx = makeFixture();
    const project = tmp('ns-proj-instr-sibling-');
    // The flagship shape, and this repo's own `packages/shared/CLAUDE.md`.
    // AGENTS.md is registered as its own root BEFORE CLAUDE.md is walked, so the
    // shared `seen` set must not mint a duplicate under a second key — the
    // token is resolved at COMPOSE time instead (see memory-layers.ts).
    writeFileSync(join(project, 'AGENTS.md'), 'package guide');
    writeFileSync(join(project, 'CLAUDE.md'), '@AGENTS.md\n');

    const { records } = buildNativeCapabilityInventory(trustedProject(fx, project, project), fx.env);
    const agents = records.filter(r => r.sourcePath === join(project, 'AGENTS.md'));
    expect(agents).toHaveLength(1);
    expect(agents[0]!.kind).toBe('instruction');
    expect(agents[0]!.memoryImportParentPath).toBeUndefined();
    // And it keeps its own position: AGENTS.md is still emitted before CLAUDE.md.
    expect(projectInstructionPaths(trustedProject(fx, project, project), fx.env)).toEqual([
      join(project, 'AGENTS.md'),
      join(project, 'CLAUDE.md'),
    ]);
  });

  it('never lets an instruction import claim MEMORY.md or a rules file (R77)', () => {
    const fx = makeFixture();
    const project = tmp('ns-proj-instr-owned-');
    mkdirSync(join(project, '.agents', 'rules'), { recursive: true });
    writeFileSync(join(project, 'MEMORY.md'), '# Memory\nindex body');
    writeFileSync(join(project, '.agents', 'rules', 'api.md'), '---\npaths:\n  - "src/**"\n---\nrule body');
    writeFileSync(join(project, 'CLAUDE.md'), '@MEMORY.md\n@.agents/rules/api.md\n');

    const { records } = buildNativeCapabilityInventory(trustedProject(fx, project, project), fx.env);
    // The index keeps its `memory` record — that is what carries the 200-line /
    // 25 KB load cap, which an `instruction` record does not.
    const memoryIndex = records.filter(r => r.sourcePath === join(project, 'MEMORY.md'));
    expect(memoryIndex).toHaveLength(1);
    expect(memoryIndex[0]!.kind).toBe('memory');
    expect(memoryIndex[0]!.memoryImportParentPath).toBeUndefined();
    // The rule keeps `format: 'rule'` — claiming it as an instruction import
    // would drop the `paths:` gate and promote it to an unconditional rule.
    const rule = records.filter(r => r.sourcePath === join(project, '.agents', 'rules', 'api.md'));
    expect(rule).toHaveLength(1);
    expect(rule[0]!.kind).toBe('memory');
    expect(rule[0]!.memoryFormat).toBe('rule');
  });
});

/**
 * R65 · f068. `memory.md:60` gives **Project instructions** as "`./CLAUDE.md` or
 * `./.claude/CLAUDE.md`" and `:69` repeats it. Only the first was ever a
 * candidate, and the second reached context only incidentally, through the lazy
 * nested channel, if the session happened to read some other file under
 * `<cwd>/.claude/`.
 */
describe('buildNativeCapabilityInventory — the .claude/ project instruction location', () => {
  function projectInstructions(
    ctx: WorkspacePolicyContext,
    env: Fixture['env'],
  ): Array<{ key: string; logicalName: string; sourcePath: string }> {
    return buildNativeCapabilityInventory(ctx, env).records
      .filter(r => r.kind === 'instruction' && r.scope.kind === 'project')
      .map(r => ({ key: r.key, logicalName: r.logicalName, sourcePath: r.sourcePath! }));
  }

  function trustedProject(fx: Fixture, project: string, workingDirectory = project): WorkspacePolicyContext {
    return baseContext(fx, {
      workingDirectory,
      projectRoot: project,
      projectKey: 'p_' + 'c'.repeat(32),
      projectTrustState: 'trusted',
    });
  }

  it('loads <cwd>/.claude/CLAUDE.md as an eager project instruction record', () => {
    const fx = makeFixture();
    const project = tmp('ns-claude-dir-');
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(join(project, '.claude', 'CLAUDE.md'), 'dot-claude instructions');

    expect(projectInstructions(trustedProject(fx, project), fx.env)).toEqual([{
      key: `instruction::project::ws-uuid-1::p_${'c'.repeat(32)}::::.claude/CLAUDE.md`,
      logicalName: '.claude/CLAUDE.md',
      sourcePath: join(project, '.claude', 'CLAUDE.md'),
    }]);
  });

  /**
   * THE COLLISION CASE. Keying the `.claude` file by its own file name —
   * `CLAUDE.md`, which is what it is called — yields a `qualifiedKey` identical
   * to `<cwd>/CLAUDE.md`'s, and nothing anywhere fails: the inventory is an
   * array, so both records survive discovery and every key-addressed consumer
   * downstream collapses them into one. Both locations are registered here at
   * once, which is the only arrangement that can see it.
   */
  it('keeps ./CLAUDE.md and ./.claude/CLAUDE.md as two records under two distinct keys', () => {
    const fx = makeFixture();
    const project = tmp('ns-claude-dir-both-');
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(join(project, 'CLAUDE.md'), 'root instructions');
    writeFileSync(join(project, '.claude', 'CLAUDE.md'), 'dot-claude instructions');
    writeFileSync(join(project, 'CLAUDE.local.md'), 'local instructions');

    const found = projectInstructions(trustedProject(fx, project), fx.env);

    expect(new Set(found.map(r => r.key)).size).toBe(found.length);
    expect(found.map(r => r.sourcePath)).toEqual([
      join(project, 'CLAUDE.md'),
      join(project, '.claude', 'CLAUDE.md'),
      join(project, 'CLAUDE.local.md'),
    ]);
  });

  it('never reads an ANCESTOR .claude/CLAUDE.md — memory.md:153 walks bare names', () => {
    const fx = makeFixture();
    const project = tmp('ns-claude-dir-ancestor-');
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(join(project, '.claude', 'CLAUDE.md'), 'must not load');
    // Positive control on the same rig: the bare name at the same ancestor IS
    // read, so the absence above is about the location and not about the walk.
    writeFileSync(join(project, 'CLAUDE.md'), 'ancestor bare name');
    const cwd = join(project, 'packages', 'web');
    mkdirSync(cwd, { recursive: true });

    expect(projectInstructions(trustedProject(fx, project, cwd), fx.env).map(r => r.sourcePath))
      .toEqual([join(project, 'CLAUDE.md')]);
  });
});

/**
 * R65 · f207. `third-party-integrations.md:329` deploys `CLAUDE.md` to a system
 * directory "for company-wide standards", and `memory.md:58` makes it the
 * broadest scope in the load-order table. Nothing read it.
 */
describe('buildNativeCapabilityInventory — the managed system-directory tier', () => {
  function managedFixture(): { fx: Fixture; systemDir: string; env: Fixture['env'] & { systemDir: string } } {
    const fx = makeFixture();
    const systemDir = tmp('ns-system-');
    return { fx, systemDir, env: { ...fx.env, systemDir } };
  }

  it('emits one builtin-scope instruction record, ahead of every other tier', () => {
    const { fx, systemDir, env } = managedFixture();
    writeFileSync(join(systemDir, 'CLAUDE.md'), 'company-wide standards');
    writeFileSync(join(fx.workspaceRoot, 'CLAUDE.md'), 'workspace instructions');

    const instructions = buildNativeCapabilityInventory(baseContext(fx), env).records
      .filter(r => r.kind === 'instruction');

    expect(instructions.map(r => ({ scope: r.scope.kind, path: r.sourcePath }))).toEqual([
      { scope: 'builtin', path: join(systemDir, 'CLAUDE.md') },
      { scope: 'workspace', path: join(fx.workspaceRoot, 'CLAUDE.md') },
    ]);
    expect(instructions[0]!.key).toBe('instruction::builtin::-::-::managed::CLAUDE.md');
    // Nothing about a machine-wide policy file is editable from the app.
    expect(instructions[0]!.mutable).toBe(false);
  });

  /**
   * `memory.md:336` — "Managed policy CLAUDE.md files cannot be excluded. This
   * ensures organization-wide instructions always apply regardless of individual
   * settings." One pattern, two tiers, so the assertion cannot pass by the
   * matcher simply never firing.
   */
  it('survives a claudeMdExcludes pattern that drops the workspace CLAUDE.md', () => {
    const { fx, systemDir, env } = managedFixture();
    writeFileSync(join(systemDir, 'CLAUDE.md'), 'company-wide standards');
    writeFileSync(join(fx.workspaceRoot, 'CLAUDE.md'), 'workspace instructions');

    const paths = buildNativeCapabilityInventory(baseContext(fx), {
      ...env,
      instructionExcludes: ['**/CLAUDE.md'],
    }).records.filter(r => r.kind === 'instruction').map(r => r.sourcePath);

    expect(paths).toEqual([join(systemDir, 'CLAUDE.md')]);
  });

  it('refuses a system directory another account can write to', () => {
    const { fx, systemDir, env } = managedFixture();
    writeFileSync(join(systemDir, 'CLAUDE.md'), 'company-wide standards');
    // Control: it loads while the directory is host-owned.
    expect(buildNativeCapabilityInventory(baseContext(fx), env).records
      .some(r => r.kind === 'instruction' && r.scope.kind === 'builtin')).toBe(true);

    chmodSync(systemDir, 0o777);
    expect(buildNativeCapabilityInventory(baseContext(fx), env).records
      .some(r => r.scope.kind === 'builtin')).toBe(false);
    chmodSync(systemDir, 0o700);

    // A symlink in that directory must not redirect the read either.
    rmSync(join(systemDir, 'CLAUDE.md'));
    const elsewhere = tmp('ns-system-target-');
    writeFileSync(join(elsewhere, 'planted.md'), 'planted');
    symlinkSync(join(elsewhere, 'planted.md'), join(systemDir, 'CLAUDE.md'));
    expect(buildNativeCapabilityInventory(baseContext(fx), env).records
      .some(r => r.scope.kind === 'builtin')).toBe(false);
  });

  it('contributes nothing on a platform with no system directory', () => {
    const fx = makeFixture();
    const records = buildNativeCapabilityInventory(baseContext(fx), fx.env).records;
    expect(records.some(r => r.scope.kind === 'builtin')).toBe(false);
  });

  /**
   * The standing guard behind the two cases above: with the managed tier and
   * both project locations registered in ONE inventory, every qualified key is
   * still unique. A duplicate would be invisible — the inventory is an array and
   * nothing downstream asserts uniqueness.
   */
  it('gives every record in a fully-populated inventory a distinct qualified key', () => {
    const { fx, systemDir, env } = managedFixture();
    writeFileSync(join(systemDir, 'CLAUDE.md'), 'managed');
    writeFileSync(join(fx.workspaceRoot, 'CLAUDE.md'), 'workspace');
    writeFileSync(join(fx.configDir, 'MEMORY.md'), 'user memory');
    const project = tmp('ns-keys-');
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(join(project, 'AGENTS.md'), 'agents');
    writeFileSync(join(project, 'CLAUDE.md'), 'root');
    writeFileSync(join(project, '.claude', 'CLAUDE.md'), 'dot-claude');
    writeFileSync(join(project, 'CLAUDE.local.md'), 'local');
    writeFileSync(join(project, 'MEMORY.md'), 'project memory');

    const { records } = buildNativeCapabilityInventory(baseContext(fx, {
      workingDirectory: project,
      projectRoot: project,
      projectKey: 'p_' + 'a'.repeat(32),
      projectTrustState: 'trusted',
    }), env);

    expect(records.length).toBeGreaterThan(10);
    const duplicates = records
      .map(r => r.key)
      .filter((key, index, all) => all.indexOf(key) !== index);
    expect(duplicates).toEqual([]);
  });
});

describe('buildNativeCapabilityInventory — project trust gate', () => {
  it('withholds all repository-owned layers and emits one diagnostic when untrusted', () => {
    const fx = makeFixture();
    const project = tmp('ns-proj-');
    writeSkill(join(project, '.agents', 'skills'), 'projonly');
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({
      mcpServers: { projectFiles: { type: 'stdio', command: 'project-files-server' } },
    }));
    writeFileSync(join(project, 'AGENTS.md'), '# rules');
    writeFileSync(join(project, 'MEMORY.md'), '# Memory\n@import ./project-notes.md\n');
    writeFileSync(join(project, 'project-notes.md'), 'trusted project note');

    const ctx = baseContext(fx, {
      workingDirectory: project,
      projectRoot: project,
      projectKey: 'p_' + 'b'.repeat(32),
      projectTrustState: 'none',
    });
    const { records, blockedLayers } = buildNativeCapabilityInventory(ctx, fx.env);

    expect(records.some(r => r.scope.kind === 'project')).toBe(false);
    expect(blockedLayers).toHaveLength(1);
    expect(blockedLayers[0]).toMatchObject({ scope: 'project', reason: 'untrusted-project', projectKey: ctx.projectKey });
    expect(blockedLayers[0]!.withheldKinds).toContain('skill');
    expect(blockedLayers[0]!.withheldKinds).toContain('instruction');
    // W6 minor: project hooks (.nessy-agent/hooks.json) are repository-owned too.
    expect(blockedLayers[0]!.withheldKinds).toContain('hook');
  });

  it('includes project layers only after trust; AGENTS.md is an instruction, never an agent', () => {
    const fx = makeFixture();
    const project = tmp('ns-proj-');
    writeSkill(join(project, '.agents', 'skills'), 'projonly');
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({
      mcpServers: { projectFiles: { type: 'stdio', command: 'project-files-server' } },
    }));
    writeFileSync(join(project, 'AGENTS.md'), '# rules');
    writeFileSync(join(project, 'MEMORY.md'), '# Memory\n@import ./project-notes.md\n');
    writeFileSync(join(project, 'project-notes.md'), 'trusted project note');
    mkdirSync(join(project, '.nessy-agent', 'agents'), { recursive: true });
    writeFileSync(join(project, '.nessy-agent', 'agents', 'proj.md'), `---\nname: proj\nsystemPrompt: p\n---\nx`);
    writeFileSync(join(project, '.nessy-agent', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [] } }));
    mkdirSync(join(project, '.agents', 'rules'), { recursive: true });
    writeFileSync(
      join(project, '.agents', 'rules', 'project.md'),
      '---\npaths: **\n---\n@import ./project-rule-note.md\nProject rule body.',
    );
    writeFileSync(join(project, '.agents', 'rules', 'project-rule-note.md'), 'Project imported rule note.');
    writeFileSync(
      join(project, '.agents', 'rules', 'nonmatching.md'),
      '---\npaths: packages/docs/**\n---\n@import ./nonmatching-note.md\nNonmatching rule.',
    );
    writeFileSync(join(project, '.agents', 'rules', 'nonmatching-note.md'), 'Nonmatching imported note.');

    const ctx = baseContext(fx, {
      workingDirectory: project,
      projectRoot: project,
      projectKey: 'p_' + 'c'.repeat(32),
      projectTrustState: 'trusted',
    });
    const { records, blockedLayers } = buildNativeCapabilityInventory(ctx, fx.env);

    expect(blockedLayers).toHaveLength(0);
    expect(records.some(r => r.kind === 'skill' && r.scope.kind === 'project' && r.logicalName === 'projonly')).toBe(true);
    expect(records.some(r => r.kind === 'mcp' && r.scope.kind === 'project')).toBe(true);
    expect(records.some(r => r.kind === 'agent' && r.logicalName === 'proj')).toBe(true);
    expect(records.some(r => r.kind === 'memory' && r.sourcePath === join(project, 'MEMORY.md'))).toBe(true);
    expect(records.some(r => r.kind === 'memory' && r.sourcePath === join(project, 'project-notes.md'))).toBe(true);
    expect(records.some(r => r.kind === 'hook' && r.logicalName === '.nessy-agent/hooks.json')).toBe(true);
    expect(records.find(r => r.kind === 'memory' && r.logicalName === 'project.md')).toMatchObject({
      memoryFormat: 'rule',
    });
    expect(records.some(r => r.sourcePath === join(project, '.agents', 'rules', 'project-rule-note.md'))).toBe(true);
    // R28: a rule whose glob does not describe the working directory is still
    // inventoried — the glob describes the file it fires on, not the cwd.
    expect(records.some(r => r.sourcePath === join(project, '.agents', 'rules', 'nonmatching.md'))).toBe(true);
    expect(records.some(r => r.sourcePath === join(project, '.agents', 'rules', 'nonmatching-note.md'))).toBe(true);
    // AGENTS.md appears as an instruction, and NEVER as an agent.
    expect(records.some(r => r.kind === 'instruction' && r.logicalName === 'AGENTS.md')).toBe(true);
    expect(records.some(r => r.kind === 'agent' && r.logicalName.toUpperCase() === 'AGENTS')).toBe(false);
  });

  it('discovers the full trusted .nessy-agent resource set with the nessy source tier', () => {
    const fx = makeFixture();
    const project = tmp('ns-proj-na-');
    const agentDir = join(project, '.nessy-agent');
    writeSkill(join(agentDir, 'skills'), 'projskill');
    writeSkill(join(project, '.agents', 'skills'), 'projskill'); // portable duplicate
    mkdirSync(join(agentDir, 'agents'), { recursive: true });
    writeFileSync(join(agentDir, 'agents', 'nabot.md'), `---\nname: nabot\nsystemPrompt: p\n---\nx`);
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({
      mcpServers: { naServer: { type: 'stdio', command: 'na-server' } },
    }));
    writeFileSync(join(agentDir, 'permissions.json'), '{}');
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(curl:*)'] } }));
    writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(npm run *)'] } }));
    writeFileSync(join(agentDir, 'MEMORY.md'), 'native project memory');
    mkdirSync(join(agentDir, 'rules'), { recursive: true });
    writeFileSync(join(agentDir, 'rules', 'na-rule.md'), '---\npaths: **\n---\nNative rule.');

    const ctx = baseContext(fx, {
      workingDirectory: project,
      projectRoot: project,
      projectKey: 'p_' + 'e'.repeat(32),
      projectTrustState: 'trusted',
    });
    const { records } = buildNativeCapabilityInventory(ctx, fx.env);
    const project_ = (kind: string, name: string) =>
      records.filter(r => r.kind === kind && r.scope.kind === 'project' && r.logicalName === name);

    // Nessy-native records carry tier 'nessy'; portable duplicate stays addressable.
    const skills = project_('skill', 'projskill');
    expect(skills.map(r => r.sourceTier).sort()).toEqual(['nessy', 'portable']);
    expect(new Set(skills.map(r => r.key)).size).toBe(2);
    expect(project_('agent', 'nabot')[0]?.sourceTier).toBe('nessy');
    expect(project_('mcp', 'naServer')[0]?.sourceTier).toBe('nessy');
    expect(project_('permission', '.nessy-agent/permissions.json')[0]?.sourceTier).toBe('nessy');
    // Claude's own permission files, read BESIDE ours (permissions.md § Project
    // allow rules and workspace trust; settings.md § Settings files).
    expect(project_('permission', '.claude/settings.json')[0]?.sourceTier).toBe('portable');
    expect(project_('permission', '.claude/settings.local.json')[0]?.sourceTier).toBe('portable');
    expect(records.some(r => r.kind === 'memory' && r.sourcePath === join(agentDir, 'MEMORY.md') && r.sourceTier === 'nessy')).toBe(true);
    expect(records.some(r => r.kind === 'memory' && r.logicalName === 'na-rule.md' && r.memoryFormat === 'rule' && r.sourceTier === 'nessy')).toBe(true);
  });

  // F1.730 — the trust dialog lists `.claude/agents` (sub-agents.md, the scope
  // table's "Current project" row), so a trusted project must supply them to
  // every runtime the host dispatches definitions to; Pi used to answer
  // `Unknown agent` for one. Portable tier, so `.nessy-agent/agents` keeps a
  // same-named file.
  it('reads a trusted project .claude/agents beside .nessy-agent/agents, portable tier and its own key', () => {
    const fx = makeFixture();
    const project = tmp('ns-proj-claude-agents-');
    mkdirSync(join(project, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(project, '.claude', 'agents', 'one-turn.md'), `---\nname: one-turn\ndescription: d\n---\nx`);
    writeFileSync(join(project, '.claude', 'agents', 'both.md'), `---\nname: both\ndescription: d\n---\nclaude`);
    writeFileSync(join(project, '.claude', 'agents', 'CLAUDE.md'), '# never an agent');
    mkdirSync(join(project, '.nessy-agent', 'agents'), { recursive: true });
    writeFileSync(join(project, '.nessy-agent', 'agents', 'both.md'), `---\nname: both\ndescription: d\n---\nnessy`);
    const ctx = (projectTrustState: 'trusted' | 'none') => baseContext(fx, {
      workingDirectory: project,
      projectRoot: project,
      projectKey: 'p_' + '7'.repeat(32),
      projectTrustState,
    });

    const { records } = buildNativeCapabilityInventory(ctx('trusted'), fx.env);
    const agents = (name: string) => records.filter(r => r.kind === 'agent' && r.scope.kind === 'project' && r.logicalName === name);
    expect(agents('one-turn').map(r => [r.sourceTier, r.sourcePath])).toEqual([
      ['portable', join(project, '.claude', 'agents', 'one-turn.md')],
    ]);
    const both = agents('both');
    expect(both.map(r => r.sourceTier).sort()).toEqual(['nessy', 'portable']);
    expect(new Set(both.map(r => r.key)).size).toBe(2);
    expect(records.some(r => r.kind === 'agent' && r.logicalName.toUpperCase() === 'CLAUDE')).toBe(false);

    // F1.1178 — the test the Claude translation applies to these keys (it does
    // not register the copy; the SDK loads the file itself). Read off the keys
    // THIS inventory minted, so the predicate cannot drift from `qualifiedKey`.
    expect(agents('one-turn').map(r => isClaudeProjectAgentCopyKey(r.key))).toEqual([true]);
    expect(both.map(r => [r.sourceTier, isClaudeProjectAgentCopyKey(r.key)]).sort())
      .toEqual([['nessy', false], ['portable', true]]);

    // Untrusted: the same folder contributes no agent at all.
    const untrusted = buildNativeCapabilityInventory(ctx('none'), fx.env);
    expect(untrusted.records.some(r => r.kind === 'agent' && r.scope.kind === 'project')).toBe(false);
  });

  it('rejects symlink escapes from the project root before hashing', () => {
    const fx = makeFixture();
    const project = tmp('ns-proj-sym-');
    const outside = tmp('ns-outside-');
    mkdirSync(join(outside, 'evil-skill'), { recursive: true });
    writeFileSync(join(outside, 'evil-skill', 'SKILL.md'), '---\nname: evil\ndescription: escape\n---\nx');
    writeFileSync(join(outside, 'evil.md'), `---\nname: evilbot\nsystemPrompt: p\n---\nx`);
    const skillsDir = join(project, '.nessy-agent', 'skills');
    const agentsDir = join(project, '.nessy-agent', 'agents');
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
    symlinkSync(join(outside, 'evil-skill'), join(skillsDir, 'evil'), 'dir');
    symlinkSync(join(outside, 'evil.md'), join(agentsDir, 'evilbot.md'), 'file');

    const ctx = baseContext(fx, {
      workingDirectory: project,
      projectRoot: project,
      projectKey: 'p_' + 'f'.repeat(32),
      projectTrustState: 'trusted',
    });
    const { records } = buildNativeCapabilityInventory(ctx, fx.env);

    expect(records.some(r => r.scope.kind === 'project' && r.logicalName === 'evil')).toBe(false);
    expect(records.some(r => r.scope.kind === 'project' && r.logicalName === 'evilbot')).toBe(false);
  });

  it('ignores a populated legacy .nessy directory: inventory is identical with and without it', () => {
    const fx = makeFixture();
    const project = tmp('ns-proj-inert-');
    mkdirSync(join(project, '.nessy-agent', 'agents'), { recursive: true });
    writeFileSync(join(project, '.nessy-agent', 'agents', 'proj.md'), `---\nname: proj\nsystemPrompt: p\n---\nx`);
    writeFileSync(join(project, '.nessy-agent', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [] } }));

    const ctx = baseContext(fx, {
      workingDirectory: project,
      projectRoot: project,
      projectKey: 'p_' + 'd'.repeat(32),
      projectTrustState: 'trusted',
    });
    const before = buildNativeCapabilityInventory(ctx, fx.env);

    mkdirSync(join(project, '.nessy', 'agents'), { recursive: true });
    writeFileSync(join(project, '.nessy', 'agents', 'legacy.md'), `---\nname: legacy\nsystemPrompt: p\n---\nx`);
    writeFileSync(join(project, '.nessy', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [] } }));
    writeFileSync(join(project, '.nessy', 'config.toml'), '[plugins]\n');
    const after = buildNativeCapabilityInventory(ctx, fx.env);

    expect(after).toEqual(before);
    expect(after.records.some(r => r.sourcePath.includes(`${sep}.nessy${sep}`))).toBe(false);
  });
});

describe('buildNativeCapabilityInventory — multi-project workspace', () => {
  it('keeps workspace records stable while project records differ by cwd', () => {
    const fx = makeFixture();
    const projA = tmp('ns-projA-');
    const projB = tmp('ns-projB-');
    writeSkill(join(projA, '.agents', 'skills'), 'alpha');
    writeSkill(join(projB, '.agents', 'skills'), 'beta');

    const invA = buildNativeCapabilityInventory(baseContext(fx, {
      workingDirectory: projA, projectRoot: projA, projectKey: 'p_' + '1'.repeat(32), projectTrustState: 'trusted',
    }), fx.env);
    const invB = buildNativeCapabilityInventory(baseContext(fx, {
      workingDirectory: projB, projectRoot: projB, projectKey: 'p_' + '2'.repeat(32), projectTrustState: 'trusted',
    }), fx.env);

    const wsA = invA.records.filter(r => r.scope.kind === 'workspace').map(r => r.key).sort();
    const wsB = invB.records.filter(r => r.scope.kind === 'workspace').map(r => r.key).sort();
    expect(wsA).toEqual(wsB);

    expect(invA.records.some(r => r.scope.kind === 'project' && r.logicalName === 'alpha')).toBe(true);
    expect(invB.records.some(r => r.scope.kind === 'project' && r.logicalName === 'beta')).toBe(true);
    expect(invA.records.some(r => r.logicalName === 'beta')).toBe(false);
  });
});

describe('buildNativeCapabilityInventory — MCP config-validation skips (R59)', () => {
  // `headless.md:215` — "Claude Code validates each `--mcp-config` entry at
  // startup and skips entries that fail validation, for example a `url` entry
  // with no `type`. The run continues and exits cleanly, so check these fields
  // to catch a server that never loaded." Before this, every one of these was a
  // silent `return` and the reason existed nowhere a headless consumer could
  // read it.
  it('reports a Source whose config.json does not parse, and one with no recognised type', () => {
    const fx = makeFixture();
    const sources = join(fx.workspaceRoot, 'sources');
    mkdirSync(join(sources, 'broken-json'), { recursive: true });
    writeFileSync(join(sources, 'broken-json', 'config.json'), '{not json');
    mkdirSync(join(sources, 'no-type'), { recursive: true });
    writeFileSync(join(sources, 'no-type', 'config.json'), JSON.stringify({ name: 'No Type' }));
    mkdirSync(join(sources, 'weird-type'), { recursive: true });
    writeFileSync(join(sources, 'weird-type', 'config.json'), JSON.stringify({ type: 'quantum' }));
    mkdirSync(join(sources, 'healthy'), { recursive: true });
    writeFileSync(join(sources, 'healthy', 'config.json'), JSON.stringify({
      type: 'mcp', name: 'Healthy', mcp: { type: 'stdio', command: 'x' },
    }));

    const { mcpConfigSkips } = buildNativeCapabilityInventory(baseContext(fx), fx.env);

    expect(mcpConfigSkips?.map(skip => [skip.name, skip.type]).sort()).toEqual([
      ['broken-json', 'invalid_config'],
      ['no-type', 'unknown_type'],
      ['weird-type', 'unknown_type'],
    ]);
    // The healthy Source is absent from the skip list AND still an inventory
    // record — the positive control for the three absences above.
    expect(mcpConfigSkips?.some(skip => skip.name === 'healthy')).toBe(false);
    expect(mcpConfigSkips?.some(skip => skip.message.includes('quantum'))).toBe(false);
  });

  it('reports an mcp.json that does not parse, and stays silent on a valid one', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.configDir, 'mcp.json'), '{"mcpServers": ');

    const broken = buildNativeCapabilityInventory(baseContext(fx), fx.env);
    expect(broken.mcpConfigSkips).toEqual([{
      name: 'mcp.json',
      type: 'invalid_config',
      message: 'MCP config mcp.json is not valid JSON; every server it declares was skipped.',
    }]);

    // Positive control on the same rig: an identical fixture whose mcp.json was
    // left valid produces no skip at all.
    const control = makeFixture();
    const healthy = buildNativeCapabilityInventory(baseContext(control), control.env);
    expect(healthy.mcpConfigSkips?.some(skip => skip.name === 'mcp.json')).toBe(false);
  });

  it('does not report a file that simply declares no mcpServers', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.configDir, 'mcp.json'), JSON.stringify({ other: true }));

    const { mcpConfigSkips } = buildNativeCapabilityInventory(baseContext(fx), fx.env);
    expect(mcpConfigSkips).toEqual([]);
  });
});

// ── P6.632: the withholding notice is keyed by TIER ────────────────────────────
//
// `noticeUnverifiableManagedTier` is exported for exactly this: its two call
// sites inside `buildNativeCapabilityInventory` are gated on
// `managedFileTrustVerdict` answering `unverifiable-platform`, which reads the
// real `process.platform` and today means win32 — so no darwin run reaches them
// through the inventory. Driving the function directly exercises the latch and
// the wording, which is the whole of what P6.632 changed.
describe('noticeUnverifiableManagedTier', () => {
  afterEach(() => {
    resetUnverifiableManagedTierNotice();
  });

  it('warns once for EACH withheld tier, naming the tier', () => {
    resetUnverifiableManagedTierNotice();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      noticeUnverifiableManagedTier('instruction', '/etc/nessy/CLAUDE.md');
      noticeUnverifiableManagedTier('subagent', '/etc/nessy/agents/reviewer.md');

      expect(warn.mock.calls.length).toBe(2);
      const [first] = warn.mock.calls[0] as [string];
      const [second] = warn.mock.calls[1] as [string];
      expect(first).toContain('managed instruction file at /etc/nessy/CLAUDE.md');
      expect(second).toContain('managed subagent at /etc/nessy/agents/reviewer.md');
      // Both still carry the reason, so neither line is a shortened twin.
      expect(first).toContain('no implemented ownership check');
      expect(second).toContain('no implemented ownership check');
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent on a repeat of a tier it has already reported', () => {
    resetUnverifiableManagedTierNotice();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      noticeUnverifiableManagedTier('subagent', '/etc/nessy/agents/first.md');
      noticeUnverifiableManagedTier('subagent', '/etc/nessy/agents/second.md');

      expect(warn.mock.calls.length).toBe(1);
      expect((warn.mock.calls[0] as [string])[0]).toContain('/etc/nessy/agents/first.md');
    } finally {
      warn.mockRestore();
    }
  });
});
