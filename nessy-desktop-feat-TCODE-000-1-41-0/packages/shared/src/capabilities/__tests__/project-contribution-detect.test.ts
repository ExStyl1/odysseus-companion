import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { detectClaudeParentLayers, detectProjectContributions, detectRepositoryAncestorLayers } from '../project-contribution-detect.ts';
import { projectWouldContribute } from '../../protocol/capabilities.ts';
import { createOwnedRigBase } from '../../testing/owned-temp-rig.ts';
import { MODULE_GRAPH_CASE_BUDGET_MS } from '../../testing/module-graph-budgets.ts';
import type { ProjectContributionItem, ProjectContributionItemType } from '../../protocol/capabilities.ts';

/**
 * F1.850 — every rig lives under ONE folder this file owns, and
 * `createOwnedRigBase` refuses, by name, when a directory above it carries what
 * the detector reads there: since F1.844 and F1.847 it walks from each rig to the
 * nearest `.git` and on up to the filesystem root. No home is passed: the
 * home-seam cases below walk past the real home directory too.
 */
let rigBase = '';
beforeAll(() => {
  rigBase = createOwnedRigBase('pcd-rigs-');
});
afterAll(() => {
  if (rigBase) rmSync(rigBase, { recursive: true, force: true });
});

const roots: string[] = [];

function tmp(prefix = 'pcd-'): string {
  if (!rigBase) throw new Error('F1.850: tmp() ran before beforeAll made the owned rig base');
  const dir = mkdtempSync(join(rigBase, prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function write(root: string, rel: string, content = ''): void {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function writeSkill(root: string, slug: string): void {
  write(root, join('.nessy-agent', 'skills', slug, 'SKILL.md'), `---\nname: ${slug}\n---\nBody`);
}

function itemFor(root: string, type: ProjectContributionItemType): ProjectContributionItem | undefined {
  return detectProjectContributions(root).items.find(item => item.itemType === type);
}

const MCP_DOC = JSON.stringify({
  mcpServers: {
    files: { type: 'stdio', command: 'files-server', env: { SECRET: 'shhh' } },
    remote: { type: 'http', url: 'https://example.test/mcp' },
  },
});

describe('detectProjectContributions — per-source shapes', () => {
  it('empty project → empty report', () => {
    expect(detectProjectContributions(tmp()).items).toEqual([]);
  });

  it('non-existent / unreadable root → empty report (fail-soft)', () => {
    expect(detectProjectContributions(join(rigBase, 'pcd-does-not-exist-xyz')).items).toEqual([]);
  });

  it('instructions: AGENTS.md/CLAUDE.md/CLAUDE.local.md are reported by name', () => {
    const root = tmp();
    write(root, 'AGENTS.md', '# guide');
    write(root, 'CLAUDE.local.md', '# local');
    const item = itemFor(root, 'AGENTS_MD');
    expect(item?.count).toBe(2);
    expect(item?.names).toEqual(['AGENTS.md', 'CLAUDE.local.md']);
    expect(item?.sourceLabel).toBe('project instructions');
  });

  /**
   * R65 · f068. A trusted project loads `./.claude/CLAUDE.md` too
   * (`memory.md:69`), so the pre-trust dialog must name it. Its own row rather
   * than a fourth entry in the root list, because `boundNames` drops any name
   * containing `/` through `isSafeName` — the naive add is silently discarded
   * and looks like it worked.
   */
  it('instructions: .claude/CLAUDE.md is its own labeled row, name-safe', () => {
    const root = tmp();
    write(root, join('.claude', 'CLAUDE.md'), '# dot-claude');
    const rows = detectProjectContributions(root).items.filter(item => item.itemType === 'AGENTS_MD');
    expect(rows).toEqual([{
      itemType: 'AGENTS_MD',
      sourceLabel: '.claude/CLAUDE.md',
      count: 1,
      names: ['CLAUDE.md'],
    }]);
  });

  it('instructions: both locations appear as two rows, root first', () => {
    const root = tmp();
    write(root, 'CLAUDE.md', '# root');
    write(root, join('.claude', 'CLAUDE.md'), '# dot-claude');
    const rows = detectProjectContributions(root).items.filter(item => item.itemType === 'AGENTS_MD');
    expect(rows.map(row => row.sourceLabel)).toEqual(['project instructions', '.claude/CLAUDE.md']);
  });

  it('mcp: surfaces server slugs only (never url/command/env values)', () => {
    const root = tmp();
    write(root, '.mcp.json', MCP_DOC);
    const item = itemFor(root, 'MCP_SERVER_CONFIG');
    expect(item?.count).toBe(2);
    expect(item?.names).toEqual(['files', 'remote']);
    expect(item?.sourceLabel).toBe('project .mcp.json');
    // No secret / command / url string leaks into the report anywhere.
    const serialized = JSON.stringify(detectProjectContributions(root));
    expect(serialized).not.toContain('shhh');
    expect(serialized).not.toContain('files-server');
    expect(serialized).not.toContain('example.test');
  });

  it('mcp: .cursor and .vscode configs are separate labeled items', () => {
    const root = tmp();
    write(root, join('.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { cur: { command: 'x' } } }));
    write(root, join('.vscode', 'mcp.json'), JSON.stringify({ mcpServers: { vs: { command: 'y' } } }));
    const labels = detectProjectContributions(root).items
      .filter(i => i.itemType === 'MCP_SERVER_CONFIG')
      .map(i => i.sourceLabel);
    expect(labels).toEqual(['Cursor .cursor/mcp.json', 'VS Code .vscode/mcp.json']);
  });

  it('mcp: malformed json → not reported', () => {
    const root = tmp();
    write(root, '.mcp.json', '{ not valid');
    expect(itemFor(root, 'MCP_SERVER_CONFIG')).toBeUndefined();
  });

  it('skills: only .nessy-agent/skills dirs with SKILL.md, by dir name', () => {
    const root = tmp();
    writeSkill(root, 'writer');
    writeSkill(root, 'editor');
    mkdirSync(join(root, '.nessy-agent', 'skills', 'empty-no-md'), { recursive: true });
    const item = itemFor(root, 'SKILLS');
    expect(item?.count).toBe(2);
    expect(item?.names).toEqual(['editor', 'writer']);
  });

  it('subagents + commands: .claude markdown basenames (sans .md)', () => {
    const root = tmp();
    write(root, join('.claude', 'agents', 'reviewer.md'), 'x');
    write(root, join('.claude', 'agents', 'notes.txt'), 'ignored');
    write(root, join('.claude', 'commands', 'deploy.md'), 'x');
    expect(itemFor(root, 'SUBAGENTS')?.names).toEqual(['reviewer']);
    expect(itemFor(root, 'COMMANDS')?.names).toEqual(['deploy']);
  });

  it('hooks: hooks.json presence + .claude/hooks/* files', () => {
    const root = tmp();
    write(root, join('.claude', 'hooks.json'), '{}');
    write(root, join('.claude', 'hooks', 'pre.sh'), '#');
    const item = itemFor(root, 'HOOKS');
    expect(item?.names).toEqual(['hooks.json', 'pre.sh']);
  });

  it('settings: .claude/settings*.json presence only', () => {
    const root = tmp();
    write(root, join('.claude', 'settings.json'), '{}');
    write(root, join('.claude', 'settings.local.json'), '{}');
    const item = itemFor(root, 'CONFIG');
    expect(item?.names).toEqual(['settings.json', 'settings.local.json']);
  });

  it('report never contains an absolute path segment', () => {
    const root = tmp();
    write(root, 'AGENTS.md', 'x');
    write(root, '.mcp.json', MCP_DOC);
    writeSkill(root, 'writer');
    expect(JSON.stringify(detectProjectContributions(root))).not.toContain(root);
  });

  it('items are in a stable display order', () => {
    const root = tmp();
    write(root, join('.claude', 'settings.json'), '{}');
    write(root, join('.claude', 'commands', 'deploy.md'), 'x');
    write(root, 'AGENTS.md', 'x');
    write(root, '.mcp.json', MCP_DOC);
    writeSkill(root, 'writer');
    expect(detectProjectContributions(root).items.map(i => i.itemType)).toEqual([
      'AGENTS_MD', 'MCP_SERVER_CONFIG', 'SKILLS', 'COMMANDS', 'CONFIG',
    ]);
  });
});

describe('detectProjectContributions — bounds + hostile input', () => {
  it('bounds names to 20 and flags truncation, while count stays exact', () => {
    const root = tmp();
    for (let i = 0; i < 25; i++) writeSkill(root, `skill-${String(i).padStart(2, '0')}`);
    const item = itemFor(root, 'SKILLS');
    expect(item?.count).toBe(25);
    expect(item?.names.length).toBe(20);
    expect(item?.truncated).toBe(true);
  });

  it('rejects a symlinked entry that escapes the project root (traversal)', () => {
    const root = tmp();
    const outside = tmp('pcd-outside-');
    writeSkill(outside, 'evil');
    // A symlinked `.claude` whose contents live outside the realpathed root.
    const outsideClaude = join(outside, '.claude');
    mkdirSync(join(outsideClaude, 'agents'), { recursive: true });
    writeFileSync(join(outsideClaude, 'agents', 'escaped.md'), 'x');
    symlinkSync(outsideClaude, join(root, '.claude'));
    // The escaped agent md is outside the realpathed root → excluded.
    expect(itemFor(root, 'SUBAGENTS')).toBeUndefined();
  });

  it('a symlinked root is realpathed, and its own real contents are reported', () => {
    const real = tmp();
    write(real, 'AGENTS.md', 'x');
    const link = join(rigBase, `pcd-link-${Date.now()}`);
    symlinkSync(real, link);
    roots.push(link);
    expect(itemFor(link, 'AGENTS_MD')?.names).toEqual(['AGENTS.md']);
  });

it('never reads a non-regular or oversized MCP config (pre-trust DoS hardening)', () => {
  const root = mkdtempSync(join(rigBase, 'contrib-hard-'));
  try {
    // Oversized .mcp.json (over the 1 MiB cap) is skipped without reading.
    writeFileSync(join(root, '.mcp.json'), '{"mcpServers":{"big":{"command":"x"}}}'.padEnd(1024 * 1024 + 10, ' '));
    let report = detectProjectContributions(root);
    expect(report.items.find(item => item.itemType === 'MCP_SERVER_CONFIG')).toBeUndefined();

    // FIFO at the config path is skipped (would block a sync read forever).
    rmSync(join(root, '.mcp.json'));
    try {
      execSync(`mkfifo ${JSON.stringify(join(root, '.mcp.json'))}`);
    } catch {
      return; // platform without mkfifo — the size-cap half still ran
    }
    report = detectProjectContributions(root);
    expect(report.items.find(item => item.itemType === 'MCP_SERVER_CONFIG')).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
});

/**
 * D1.223 — the seven Nessy-native sources a trusted project loads and this
 * report did not name.
 *
 * Each case is written as "this source ALONE makes the folder contribute",
 * because that is exactly the shape the trust prompt now asks about: a project
 * carrying only one of them previewed as empty, and after D1.223 an empty
 * preview SUPPRESSES the question. So a miss here is no longer an under-stated
 * dialog, it is a question never asked.
 */
describe('detectProjectContributions — the .nessy-agent tier (D1.223)', () => {
  const only: Array<[string, (root: string) => void, ProjectContributionItemType]> = [
    ['.nessy-agent/mcp.json', root => write(root, join('.nessy-agent', 'mcp.json'), MCP_DOC), 'MCP_SERVER_CONFIG'],
    ['.nessy-agent/agents', root => write(root, join('.nessy-agent', 'agents', 'reviewer.md'), 'x'), 'SUBAGENTS'],
    ['.nessy-agent/hooks.json', root => write(root, join('.nessy-agent', 'hooks.json'), '{}'), 'HOOKS'],
    ['.nessy-agent/permissions.json', root => write(root, join('.nessy-agent', 'permissions.json'), '{}'), 'CONFIG'],
    ['.nessy-agent/MEMORY.md', root => write(root, join('.nessy-agent', 'MEMORY.md'), 'x'), 'AGENTS_MD'],
    ['.nessy-agent/rules', root => write(root, join('.nessy-agent', 'rules', 'style.md'), 'x'), 'AGENTS_MD'],
    ['.agents/skills', root => write(root, join('.agents', 'skills', 'writer', 'SKILL.md'), 'x'), 'SKILLS'],
  ];

  it.each(only)('%s alone is a contribution', (_label, seed, itemType) => {
    const root = tmp();
    seed(root);
    const report = detectProjectContributions(root);
    expect(report.items.map(i => i.itemType)).toContain(itemType);
    expect(projectWouldContribute(report)).toBe(true);
    // Still path-free: the label carries the convention, never the location.
    expect(JSON.stringify(report)).not.toContain(root);
  });

  /**
   * The NEGATIVE that makes the seven mean something — and it is the case the
   * suppression rests on. A folder with ordinary contents and none of the
   * well-known entry points contributes nothing, so the prompt is suppressed.
   */
  it('a folder with ordinary files contributes nothing, and the prompt is suppressed', () => {
    const root = tmp();
    write(root, 'README.md', 'not an instruction file');
    write(root, join('src', 'index.ts'), 'export {}');
    write(root, join('.nessy-agent', 'notes.txt'), 'not a source');
    const report = detectProjectContributions(root);
    expect(report.items).toEqual([]);
    expect(projectWouldContribute(report)).toBe(false);
  });

  /** A detection that FAILED is never read as "nothing here". */
  it('a null or undefined report still asks', () => {
    expect(projectWouldContribute(null)).toBe(true);
    expect(projectWouldContribute(undefined)).toBe(true);
    expect(projectWouldContribute(detectProjectContributions(join(tmp(), 'no-such-dir')))).toBe(false);
  });
});

/**
 * F1.839 — the layers codex and claude now load ONLY for a trusted project, and
 * this report did not name.
 *
 * Since F1.750 the host writes codex's own trust entry, `untrusted` for any
 * project the user did not trust (a never-asked one included), so codex keeps
 * the project's `.codex/` layer out: its source (`rust-v0.156.1`,
 * `config/src/loader/mod.rs`) disables every non-trusted project layer, and the
 * gated features it names are "project-local config, hooks, and exec policies";
 * `.codex/agents` role files are read from the same enabled layers only
 * (`agent-roles/src/loader.rs`). Since F1.768 the claude child gets
 * `settingSources: ['user']` unless the project is trusted, and the SDK's
 * `project` source is, verbatim, "Project `settings.json` and hooks; project
 * CLAUDE.md and `.claude/rules/*.md`; project skills, commands, and subagents"
 * (agent-sdk/claude-code-features.md, the settingSources table).
 *
 * Before this plan both runtimes loaded those layers whatever the host decided.
 * Now they come only with trust — and `projectWouldContribute` suppresses the
 * question while this report is empty. So a folder carrying one of these alone
 * was never asked about on the re-prompt path (a restored session, a relaunch, a
 * session opened on the workspace's default project), and its layer silently
 * stopped loading. Each case is "this layer ALONE is a contribution", under the
 * label the trust dialog shows (`ProjectContributionsList` renders `sourceLabel`
 * and the item type's existing plural label, so no new locale key).
 */
describe('detectProjectContributions — the layers codex and claude load only under trust (F1.839)', () => {
  const only: Array<[string, (root: string) => void, ProjectContributionItemType, string, string[]]> = [
    ['.codex/config.toml', root => write(root, join('.codex', 'config.toml'), '[mcp_servers.docs]\ncommand = "docs-server"\n'), 'CONFIG', '.codex/config.toml', ['config.toml']],
    ['.codex/hooks.json', root => write(root, join('.codex', 'hooks.json'), '{"hooks":{}}'), 'HOOKS', '.codex/hooks.json', ['hooks.json']],
    ['.codex/rules', root => write(root, join('.codex', 'rules', 'team.rules'), 'prefix_rule(pattern=["touch"], decision="allow")'), 'CONFIG', '.codex/rules', ['team']],
    ['.codex/agents', root => write(root, join('.codex', 'agents', 'reviewer.toml'), 'name = "reviewer"'), 'SUBAGENTS', '.codex/agents', ['reviewer']],
    ['.claude/skills', root => write(root, join('.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\nBody'), 'SKILLS', '.claude/skills', ['deploy']],
    ['.claude/rules', root => write(root, join('.claude', 'rules', 'testing.md'), '# rule'), 'AGENTS_MD', '.claude/rules', ['testing']],
    // memory.md, 'Set up rules': "All `.md` files are discovered recursively, so
    // you can organize rules into subdirectories like `frontend/` or `backend/`".
    ['.claude/rules, nested only', root => write(root, join('.claude', 'rules', 'frontend', 'react.md'), '# rule'), 'AGENTS_MD', '.claude/rules', ['react']],
  ];

  it.each(only)('%s alone is a contribution, under the label the dialog shows', (_label, seed, itemType, sourceLabel, names) => {
    const root = tmp();
    seed(root);
    const report = detectProjectContributions(root);
    // F1.846 — a `.codex/config.toml` also names the MCP servers it declares, on a row of its own.
    expect(report.items.filter(item => item.itemType !== 'MCP_SERVER_CONFIG')).toEqual([{ itemType, sourceLabel, count: names.length, names }]);
    expect(projectWouldContribute(report)).toBe(true);
    // Path-free and content-free, like every other row.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain('docs-server');
  });

  /**
   * The NEGATIVE: the 1.40.0 rule still holds inside these directories. Files
   * the runtimes do not read contribute nothing, so the prompt stays suppressed.
   * `.codex/skills` is here on purpose: codex reads it from EVERY project layer,
   * disabled ones included (`ext/skills/src/host_roots.rs` walks
   * `all_layers_high_to_low()`), so trust does not decide it and listing it would
   * overstate what approval buys.
   */
  it('files those runtimes do not read contribute nothing, and the prompt stays suppressed', () => {
    const root = tmp();
    write(root, join('.codex', 'notes.txt'), 'x');
    write(root, join('.codex', 'rules', 'README.md'), 'not a .rules file');
    write(root, join('.codex', 'agents', 'notes.md'), 'not a .toml file');
    write(root, join('.codex', 'skills', 'writer', 'SKILL.md'), 'read by codex whatever the trust');
    mkdirSync(join(root, '.claude', 'skills', 'no-skill-md'), { recursive: true });
    write(root, join('.claude', 'rules', 'notes.txt'), 'not markdown');
    const report = detectProjectContributions(root);
    expect(report.items).toEqual([]);
    expect(projectWouldContribute(report)).toBe(false);
  });

  it('a rules entry reached through a symlink that leaves the project is not reported (containment)', () => {
    const root = tmp();
    const outside = tmp('pcd-outside-');
    write(outside, join('shared', 'style.md'), '# shared rule');
    mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
    symlinkSync(join(outside, 'shared'), join(root, '.claude', 'rules', 'shared'));
    expect(detectProjectContributions(root).items).toEqual([]);
  });

  /**
   * The CONTROL: every kind the report already carried reads exactly as before —
   * the new rows are additions, and the display order is by type as it was.
   */
  it('the existing kinds are unchanged, and the new rows sort in by type', () => {
    const root = tmp();
    write(root, 'AGENTS.md', 'x');
    write(root, '.mcp.json', MCP_DOC);
    writeSkill(root, 'writer');
    write(root, join('.claude', 'agents', 'reviewer.md'), 'x');
    write(root, join('.claude', 'commands', 'deploy.md'), 'x');
    write(root, join('.nessy-agent', 'hooks.json'), '{}');
    write(root, join('.claude', 'settings.json'), '{}');
    const before = detectProjectContributions(root).items;
    expect(before.map(item => `${item.itemType} ${item.sourceLabel} ${item.names.join(',')}`)).toEqual([
      'AGENTS_MD project instructions AGENTS.md',
      'MCP_SERVER_CONFIG project .mcp.json files,remote',
      'SKILLS .nessy-agent/skills writer',
      'SUBAGENTS .claude/agents reviewer',
      'COMMANDS .claude/commands deploy',
      'HOOKS .nessy-agent/hooks.json hooks.json',
      'CONFIG .claude/settings.json settings.json',
    ]);
    write(root, join('.codex', 'config.toml'), '');
    write(root, join('.claude', 'skills', 'ship', 'SKILL.md'), 'x');
    write(root, join('.claude', 'rules', 'testing.md'), 'x');
    const after = detectProjectContributions(root).items;
    expect(after.filter(item => before.some(old => old.sourceLabel === item.sourceLabel))).toEqual(before);
    expect(after.map(item => item.sourceLabel)).toEqual([
      'project instructions', '.claude/rules',
      'project .mcp.json',
      '.nessy-agent/skills', '.claude/skills',
      '.claude/agents',
      '.claude/commands',
      '.nessy-agent/hooks.json',
      '.claude/settings.json', '.codex/config.toml',
    ]);
  });
});

/**
 * F1.844 — the F1.839 regression through a PARENT folder. The selected project is
 * `packages/app`, a subfolder of a git repository whose ROOT carries the layer;
 * `packages/app` carries nothing of its own.
 *
 * Both runtimes read above the selected folder, and only under trust since this
 * plan (measured on the shipped binaries, `work/wjcritpp/`): codex reads every
 * `.codex/` and the AGENTS.md chain from the working directory up to its project
 * root, the nearest `.git` (`config/src/loader/mod.rs` `discover_project_layers`,
 * `rust-v0.156.1`; the host pins `project_root_markers = [".git"]`); claude reads
 * `.claude/skills`, `.claude/agents` and `.claude/commands` up to the repository
 * root (skills.md, 'Load skills in monorepos and subdirectories': "in every
 * parent directory up to the repository root"; sub-agents.md: "every
 * `.claude/agents/` between there and the repository root is scanned"), the
 * CLAUDE.md chain, `.claude/rules` and `.mcp.json` from every parent, and the
 * repository root's `.claude/settings.local.json` (settings.md, 'Where Claude
 * Code keeps the local file in a git repository'). The report named none of them,
 * so the subfolder previewed empty, was never asked about, and the root's layers
 * silently stopped loading. Each case: this ancestor layer ALONE is a
 * contribution of the subfolder, under a label relative to it.
 */
describe('detectProjectContributions — the layers the runtimes read above a subfolder, up to its repository root (F1.844)', () => {
  /**
   * A git repository (a `.git` holding HEAD, codex's own marker test) and its
   * empty `packages/app`, inside an `outer` folder the test owns, so a layer
   * written ABOVE the repository never lands in the shared temp directory.
   */
  function repo(): { outer: string; root: string; app: string } {
    const outer = tmp('pcd-repo-');
    const root = join(outer, 'repo');
    write(root, join('.git', 'HEAD'), 'ref: refs/heads/main\n');
    const app = join(root, 'packages', 'app');
    write(app, 'index.ts', 'export {}\n');
    return { outer, root, app };
  }

  const above: Array<[string, (root: string) => void, ProjectContributionItemType, string, string[]]> = [
    ['.codex/config.toml', root => write(root, join('.codex', 'config.toml'), '[mcp_servers.docs]\ncommand = "docs-server"\n'), 'CONFIG', '../../.codex/config.toml', ['config.toml']],
    ['.codex/rules', root => write(root, join('.codex', 'rules', 'team.rules'), 'prefix_rule(pattern=["touch"], decision="allow")'), 'CONFIG', '../../.codex/rules', ['team']],
    ['.codex/hooks.json', root => write(root, join('.codex', 'hooks.json'), '{"hooks":{}}'), 'HOOKS', '../../.codex/hooks.json', ['hooks.json']],
    ['.codex/agents', root => write(root, join('.codex', 'agents', 'reviewer.toml'), 'name = "reviewer"'), 'SUBAGENTS', '../../.codex/agents', ['reviewer']],
    ['AGENTS.md', root => write(root, 'AGENTS.md', '# root'), 'AGENTS_MD', '../..', ['AGENTS.md']],
    ['CLAUDE.md', root => write(root, 'CLAUDE.md', '# root'), 'AGENTS_MD', '../..', ['CLAUDE.md']],
    ['.claude/CLAUDE.md', root => write(root, join('.claude', 'CLAUDE.md'), '# root'), 'AGENTS_MD', '../../.claude/CLAUDE.md', ['CLAUDE.md']],
    ['.claude/rules', root => write(root, join('.claude', 'rules', 'frontend', 'react.md'), '# rule'), 'AGENTS_MD', '../../.claude/rules', ['react']],
    ['.mcp.json', root => write(root, '.mcp.json', MCP_DOC), 'MCP_SERVER_CONFIG', '../../.mcp.json', ['files', 'remote']],
    ['.claude/skills', root => write(root, join('.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\nBody'), 'SKILLS', '../../.claude/skills', ['deploy']],
    ['.claude/agents', root => write(root, join('.claude', 'agents', 'reviewer.md'), 'x'), 'SUBAGENTS', '../../.claude/agents', ['reviewer']],
    ['.claude/commands', root => write(root, join('.claude', 'commands', 'ship.md'), 'x'), 'COMMANDS', '../../.claude/commands', ['ship']],
    ['.claude/settings.local.json', root => write(root, join('.claude', 'settings.local.json'), '{}'), 'CONFIG', '../../.claude/settings.local.json', ['settings.local.json']],
  ];

  it.each(above)('the repository root\'s %s alone makes the subfolder a contribution', (_label, seed, itemType, sourceLabel, names) => {
    const { root, app } = repo();
    seed(root);
    const report = detectProjectContributions(app);
    expect(report.items).toEqual([{ itemType, sourceLabel, count: names.length, names }]);
    expect(projectWouldContribute(report)).toBe(true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain('docs-server');
    expect(serialized).not.toContain('shhh');
  });

  it('an intermediate folder is read at its own depth, and the walk stops AT the repository root', () => {
    const { outer, root, app } = repo();
    write(join(root, 'packages'), join('.codex', 'config.toml'), 'model = "x"\n');
    write(join(root, 'packages'), join('.claude', 'skills', 'pkg', 'SKILL.md'), '---\nname: pkg\n---\n');
    // Above the repository root: codex's walk ends at its project root, and so does this one.
    write(outer, join('.codex', 'config.toml'), 'model = "x"\n');
    write(outer, join('.claude', 'skills', 'above', 'SKILL.md'), '---\nname: above\n---\n');
    expect(detectProjectContributions(app).items.map(item => `${item.itemType} ${item.sourceLabel} ${item.names.join(',')}`)).toEqual([
      'SKILLS ../.claude/skills pkg',
      'CONFIG ../.codex/config.toml config.toml',
    ]);
  });

  /**
   * The NEGATIVE: what the runtimes do NOT read from above, or read whatever the
   * trust, contributes nothing. `.claude/settings.json` is read from the working
   * directory only (settings.md: "Claude Code reads the shared
   * `.claude/settings.json` from the session's primary working directory";
   * measured: the root's SessionStart hook did not run from `packages/app` and did
   * from the root); `.codex/skills` and `.agents/skills` are read whatever the
   * trust (F1.839's note, P-WJcritoo-1); Pi reads nothing above the selected
   * folder (`native-sources.ts` bounds every walk at the project root, which is
   * the selected folder); `settings.local.json` counts at the repository root only.
   */
  it('what the runtimes do not read from above contributes nothing, and the prompt stays suppressed', () => {
    const { root, app } = repo();
    write(root, join('.claude', 'settings.json'), '{}');
    write(root, join('.codex', 'skills', 'writer', 'SKILL.md'), 'x');
    write(root, join('.agents', 'skills', 'writer', 'SKILL.md'), 'x');
    write(root, join('.nessy-agent', 'hooks.json'), '{}');
    writeSkill(root, 'nessy-only');
    write(root, join('.claude', 'hooks.json'), '{}');
    write(join(root, 'packages'), join('.claude', 'settings.local.json'), '{}');
    write(root, 'README.md', '# repo');
    const report = detectProjectContributions(app);
    expect(report.items).toEqual([]);
    expect(projectWouldContribute(report)).toBe(false);
  });

  /**
   * CONTROLS. Outside any repository codex reads no parent `.codex` (measured:
   * its project root is then the working directory) and the report is unchanged;
   * a repository with nothing at the root still previews empty; the repository
   * root itself selected reads exactly as before, with no relative rows.
   */
  it('outside any repository, and for a repository with nothing above, the report is unchanged', () => {
    const parent = tmp('pcd-nogit-');
    write(parent, join('.codex', 'config.toml'), 'model = "x"\n');
    write(parent, 'AGENTS.md', '# parent');
    const app = join(parent, 'packages', 'app');
    write(app, 'index.ts', 'export {}\n');
    expect(detectProjectContributions(app).items).toEqual([]);

    const { app: bare } = repo();
    expect(detectProjectContributions(bare).items).toEqual([]);
  });

  it('the repository root itself selected reads exactly as before', () => {
    const { root } = repo();
    write(root, 'AGENTS.md', 'x');
    write(root, join('.codex', 'config.toml'), '');
    write(root, join('.claude', 'skills', 'ship', 'SKILL.md'), 'x');
    expect(detectProjectContributions(root).items.map(item => item.sourceLabel)).toEqual([
      'project instructions', '.claude/skills', '.codex/config.toml',
    ]);
  });

  it('a subfolder with its own layers keeps its rows, and the ancestors\' rows follow them within each type', () => {
    const { root, app } = repo();
    write(app, 'AGENTS.md', 'x');
    write(app, join('.claude', 'skills', 'local', 'SKILL.md'), 'x');
    write(root, 'AGENTS.md', 'x');
    write(root, join('.claude', 'skills', 'shared', 'SKILL.md'), 'x');
    expect(detectProjectContributions(app).items.map(item => `${item.sourceLabel} ${item.names.join(',')}`)).toEqual([
      'project instructions AGENTS.md', '../.. AGENTS.md',
      '.claude/skills local', '../../.claude/skills shared',
    ]);
  });

  it('an ancestor entry reached through a symlink that leaves the repository is not reported (containment)', () => {
    const { root, app } = repo();
    const outside = tmp('pcd-outside-');
    write(outside, join('evil', 'SKILL.md'), '---\nname: evil\n---\n');
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    symlinkSync(join(outside, 'evil'), join(root, '.claude', 'skills', 'evil'));
    expect(detectProjectContributions(app).items).toEqual([]);
  });

  /**
   * claude's own walk for skills, agents and commands stops BEFORE the home
   * directory (the vendored 2.1.267 binary: the directory walk returns at
   * `homedir()` before it pushes that directory's `.claude/<kind>`), and at a
   * repository root that IS the home directory the local settings file stays in
   * the working directory (settings.md: "when the repository root is your home
   * directory"). A home-directory repository therefore reports neither.
   */
  it('at a home-directory repository root, claude\'s skills, agents, commands and local settings are not reported', () => {
    const { root, app } = repo();
    write(root, join('.claude', 'skills', 'mine', 'SKILL.md'), 'x');
    write(root, join('.claude', 'agents', 'mine.md'), 'x');
    write(root, join('.claude', 'commands', 'mine.md'), 'x');
    write(root, join('.claude', 'settings.local.json'), '{}');
    expect(detectRepositoryAncestorLayers(realpathSync(app), realpathSync(root))).toEqual([]);
    write(root, join('.claude', 'CLAUDE.md'), 'x');
    expect(detectRepositoryAncestorLayers(realpathSync(app), realpathSync(root)).map(item => item.sourceLabel)).toEqual(['../../.claude/CLAUDE.md']);
  });
});

/**
 * F1.847 — claude reads further up than F1.844's walk, and only under trust since
 * F1.768. Measured on the vendored 2.1.267 (`work/wjcritqq/f1847-claude-probe.ts`,
 * the F1.844 rig): from `P/proj`, with `P` in no repository, the child before this
 * plan loaded `P`'s CLAUDE.md, CLAUDE.local.md, `.claude/CLAUDE.md`, `.claude/rules`
 * (nested too), skills, agents and commands and started its `.mcp.json` server; from
 * `Q/R/packages/app`, with `Q/R` a repository, it loaded `Q`'s CLAUDE.md,
 * CLAUDE.local.md, `.claude/CLAUDE.md` and `.claude/rules` and started `Q/.mcp.json`,
 * and NOT `Q`'s skills, agents or commands (that walk ends at the repository root).
 * A folder nobody decided about gets `['user']`, so none of it loads — and the report
 * named none of it, so the folder previewed empty and was never asked about. Each
 * case: that parent layer ALONE is a contribution, under a label relative to the folder.
 */
describe('detectProjectContributions — claude\'s layers in a non-repository parent and above a repository root (F1.847)', () => {
  /** A folder `P` in no repository, inside a temp root the test owns, and its empty `P/proj`. */
  function parent(): { base: string; p: string; proj: string } {
    const base = tmp('pcd-parent-');
    const p = join(base, 'P');
    const proj = join(p, 'proj');
    write(proj, 'index.ts', 'export {}\n');
    return { base, p, proj };
  }

  /** A repository `Q/R` inside an owned `Q` that is no repository, and its empty `Q/R/packages/app`. */
  function nested(): { q: string; r: string; app: string } {
    const q = join(tmp('pcd-above-'), 'Q');
    const r = join(q, 'R');
    write(r, join('.git', 'HEAD'), 'ref: refs/heads/main\n');
    const app = join(r, 'packages', 'app');
    write(app, 'index.ts', 'export {}\n');
    return { q, r, app };
  }

  const memory: Array<[string, (dir: string) => void, ProjectContributionItemType, string, string[]]> = [
    ['CLAUDE.md', dir => write(dir, 'CLAUDE.md', '# parent'), 'AGENTS_MD', '', ['CLAUDE.md']],
    ['CLAUDE.local.md', dir => write(dir, 'CLAUDE.local.md', '# parent'), 'AGENTS_MD', '', ['CLAUDE.local.md']],
    ['.claude/CLAUDE.md', dir => write(dir, join('.claude', 'CLAUDE.md'), '# parent'), 'AGENTS_MD', '.claude/CLAUDE.md', ['CLAUDE.md']],
    ['.claude/rules', dir => write(dir, join('.claude', 'rules', 'frontend', 'react.md'), '# rule'), 'AGENTS_MD', '.claude/rules', ['react']],
    ['.mcp.json', dir => write(dir, '.mcp.json', MCP_DOC), 'MCP_SERVER_CONFIG', '.mcp.json', ['files', 'remote']],
  ];
  const walkOutsideRepository: typeof memory = [
    ['.claude/skills', dir => write(dir, join('.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\nBody'), 'SKILLS', '.claude/skills', ['deploy']],
    ['.claude/agents', dir => write(dir, join('.claude', 'agents', 'reviewer.md'), 'x'), 'SUBAGENTS', '.claude/agents', ['reviewer']],
    ['.claude/commands', dir => write(dir, join('.claude', 'commands', 'ship.md'), 'x'), 'COMMANDS', '.claude/commands', ['ship']],
  ];
  /** `..` + `/` + the layer's own path, or `..` alone for the directory's own files. */
  const under = (prefix: string, label: string) => (label ? `${prefix}/${label}` : prefix);

  it.each([...memory, ...walkOutsideRepository])('a non-repository parent\'s %s alone makes the folder a contribution', (_label, seed, itemType, sourceLabel, names) => {
    const { p, proj } = parent();
    seed(p);
    const report = detectProjectContributions(proj);
    expect(report.items).toEqual([{ itemType, sourceLabel: under('..', sourceLabel), count: names.length, names }]);
    expect(projectWouldContribute(report)).toBe(true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(p);
    expect(serialized).not.toContain('files-server');
    expect(serialized).not.toContain('shhh');
  });

  it.each(memory)('the %s of the folder above a repository root alone makes a subfolder a contribution', (_label, seed, itemType, sourceLabel, names) => {
    const { q, app } = nested();
    seed(q);
    const report = detectProjectContributions(app);
    expect(report.items).toEqual([{ itemType, sourceLabel: under('../../..', sourceLabel), count: names.length, names }]);
    expect(projectWouldContribute(report)).toBe(true);
    expect(JSON.stringify(report)).not.toContain(q);
  });

  it('the repository root itself selected is asked about for the folder above it too', () => {
    const { q, r } = nested();
    write(q, 'CLAUDE.md', '# parent');
    write(q, join('.claude', 'rules', 'style.md'), '# rule');
    expect(detectProjectContributions(r).items.map(item => `${item.itemType} ${item.sourceLabel} ${item.names.join(',')}`)).toEqual([
      'AGENTS_MD .. CLAUDE.md',
      'AGENTS_MD ../.claude/rules style',
    ]);
  });

  /**
   * The NEGATIVE: what claude does not read from those folders contributes nothing.
   * AGENTS.md is not claude 2.1.267's (measured: a non-repository parent's AGENTS.md
   * alone never reached the model) and codex reads no parent outside a repository or
   * above its root (F1.844's measurement); both settings files are read from the
   * working directory outside a repository (measured: the parent's local hook did not
   * run), and above a repository root the local one only at that root; Pi reads
   * nothing above the selected folder; above a repository root claude's skills,
   * agents and commands walk has already ended (measured: none of them loaded).
   */
  it('what claude does not read from a parent or from above a repository root contributes nothing, and the prompt stays suppressed', () => {
    const { p, proj } = parent();
    write(p, 'AGENTS.md', '# parent');
    write(p, 'AGENTS.override.md', '# parent');
    write(p, join('.codex', 'config.toml'), '[mcp_servers.docs]\ncommand = "docs-server"\n');
    write(p, join('.claude', 'settings.json'), '{}');
    write(p, join('.claude', 'settings.local.json'), '{}');
    write(p, join('.claude', 'hooks.json'), '{}');
    write(p, join('.nessy-agent', 'hooks.json'), '{}');
    writeSkill(p, 'nessy-only');
    write(p, join('.agents', 'skills', 'writer', 'SKILL.md'), 'x');
    write(p, 'README.md', '# parent');
    expect(detectProjectContributions(proj).items).toEqual([]);
    expect(projectWouldContribute(detectProjectContributions(proj))).toBe(false);

    const { q, app } = nested();
    for (const [, seed] of walkOutsideRepository) seed(q);
    write(q, 'AGENTS.md', '# parent');
    write(q, join('.codex', 'config.toml'), 'model = "x"\n');
    write(q, join('.claude', 'settings.local.json'), '{}');
    expect(detectProjectContributions(app).items).toEqual([]);
  });

  it('every parent is read at its own depth, nearest first within each type', () => {
    const { p } = parent();
    const deep = join(p, 'mid', 'proj');
    write(deep, 'index.ts', 'export {}\n');
    write(p, 'CLAUDE.md', '# p');
    write(join(p, 'mid'), 'CLAUDE.md', '# mid');
    write(join(p, 'mid'), join('.claude', 'skills', 'mid', 'SKILL.md'), 'x');
    write(p, join('.claude', 'skills', 'top', 'SKILL.md'), 'x');
    expect(detectProjectContributions(deep).items.map(item => `${item.itemType} ${item.sourceLabel} ${item.names.join(',')}`)).toEqual([
      'AGENTS_MD .. CLAUDE.md',
      'AGENTS_MD ../.. CLAUDE.md',
      'SKILLS ../.claude/skills mid',
      'SKILLS ../../.claude/skills top',
    ]);
  });

  it('F1.844\'s rows up to the repository root come first, then the folder above it', () => {
    const { q, r, app } = nested();
    write(r, 'CLAUDE.md', '# root');
    write(q, 'CLAUDE.md', '# above');
    expect(detectProjectContributions(app).items.map(item => `${item.sourceLabel} ${item.names.join(',')}`)).toEqual([
      '../.. CLAUDE.md',
      '../../.. CLAUDE.md',
    ]);
  });

  it('a parent entry reached through a symlink that leaves that parent is not reported (containment)', () => {
    const { p, proj } = parent();
    const outside = tmp('pcd-outside-');
    write(outside, join('evil', 'SKILL.md'), '---\nname: evil\n---\n');
    mkdirSync(join(p, '.claude', 'skills'), { recursive: true });
    symlinkSync(join(outside, 'evil'), join(p, '.claude', 'skills', 'evil'));
    expect(detectProjectContributions(proj).items).toEqual([]);
  });

  /**
   * The controller's posture call (F1.847): the HOME directory's own level and
   * everything above it are not reported, although claude reads them (measured
   * with HOME set to the parent: its CLAUDE.md chain, `.claude/CLAUDE.md`,
   * `.claude/rules` and `.mcp.json` loaded before this plan) — it is the user's
   * personal Claude Code setup, and naming it would ask about every project. The
   * walk stops just below the home directory; a folder AT it walks nothing.
   */
  it('the home directory\'s own level and everything above it are not reported (the carve-out)', () => {
    const home = realpathSync(tmp('pcd-home-'));
    write(home, 'CLAUDE.md', '# mine');
    write(home, join('.claude', 'CLAUDE.md'), '# mine');
    write(home, join('.claude', 'rules', 'mine.md'), '# mine');
    write(home, join('.claude', 'skills', 'mine', 'SKILL.md'), 'x');
    write(home, '.mcp.json', MCP_DOC);
    const proj = join(home, 'proj');
    write(proj, 'index.ts', 'export {}\n');
    expect(detectClaudeParentLayers(proj, home)).toEqual([]);
    expect(detectClaudeParentLayers(home, home)).toEqual([]);

    const work = join(home, 'work');
    write(work, 'CLAUDE.md', '# work');
    const inWork = join(work, 'proj');
    write(inWork, 'index.ts', 'export {}\n');
    expect(detectClaudeParentLayers(inWork, home).map(item => `${item.sourceLabel} ${item.names.join(',')}`)).toEqual(['.. CLAUDE.md']);

    const repoApp = join(home, 'R', 'packages', 'app');
    write(join(home, 'R'), join('.git', 'HEAD'), 'ref: refs/heads/main\n');
    write(repoApp, 'index.ts', 'export {}\n');
    expect(detectClaudeParentLayers(repoApp, home)).toEqual([]);
  });

  it('a folder outside the home directory is walked up to the filesystem root, one under it stops below the home directory', () => {
    const base = realpathSync(tmp('pcd-outside-home-'));
    write(base, 'CLAUDE.md', '# base');
    write(join(base, 'P'), 'CLAUDE.md', '# p');
    const proj = join(base, 'P', 'proj');
    write(proj, 'index.ts', 'export {}\n');
    const elsewhere = realpathSync(tmp('pcd-elsewhere-'));
    expect(detectClaudeParentLayers(proj, elsewhere).map(item => item.sourceLabel)).toEqual(['..', '../..']);
    expect(detectClaudeParentLayers(proj, base).map(item => item.sourceLabel)).toEqual(['..']);
  });
});

/**
 * F1.849 — a LINKED git worktree. Claude reads part of the MAIN checkout from a
 * worktree session, and only under trust since F1.768 (measured on the vendored
 * 2.1.274, `work/bk-2/f1849-worktree-probe.ts`): with the main checkout's
 * `.claude/` gitignored and populated, the session in the worktree ran the main
 * checkout's `settings.local.json` hook and loaded its agents and commands before
 * this plan, loads none of them for a worktree nobody decided about, and loads
 * them again when trusted — while this report named none of them, so the worktree
 * previewed empty and was never asked about. worktrees.md#what-worktrees-share-with-the-main-checkout:
 * the approvals file is the main checkout's, and "when the worktree checkout has
 * no `.claude/skills` directory at its root ... Claude Code loads the main
 * checkout's project skills ... The same read-through covers `.claude/agents` and
 * `.claude/commands`. For skills, the read-through requires Claude Code v2.1.277
 * or later" — measured per directory: a worktree with its own `.claude/agents`
 * kept the main checkout's commands.
 */
describe('detectProjectContributions — the main checkout\'s layers claude reads from a linked worktree (F1.849)', () => {
  function git(cwd: string, args: string): void {
    execSync(`git -c user.name=t -c user.email=t@example.invalid -c init.defaultBranch=main ${args}`, { cwd, stdio: 'ignore' });
  }

  /** A main checkout with `.claude/` gitignored, one commit, and a linked worktree `wt` beside it. */
  function worktree(populate: (main: string) => void): { main: string; wt: string } {
    const base = realpathSync(tmp('pcd-wt-'));
    const main = join(base, 'main');
    write(main, 'index.ts', 'export {}\n');
    write(main, '.gitignore', '.claude/\n');
    git(main, 'init -q');
    git(main, 'add -A');
    git(main, 'commit -q -m init');
    populate(main);
    const wt = join(base, 'wt');
    git(main, `worktree add -q -b probe ${JSON.stringify(wt)}`);
    return { main, wt };
  }

  const labels = (root: string) => detectProjectContributions(root).items.map(item => `${item.itemType} ${item.sourceLabel} ${item.names.join(',')}`);

  it('names the main checkout\'s local settings, agents and commands for a worktree that carries nothing itself', () => {
    const { wt } = worktree(main => {
      write(main, join('.claude', 'settings.local.json'), '{"hooks":{}}');
      write(main, join('.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nBody');
      write(main, join('.claude', 'commands', 'ship.md'), '---\ndescription: ship\n---\nBody');
    });
    const items = labels(wt);
    expect(items).toContain('SUBAGENTS ../main/.claude/agents reviewer');
    expect(items).toContain('COMMANDS ../main/.claude/commands ship');
    expect(items).toContain('CONFIG ../main/.claude/settings.local.json settings.local.json');
    expect(projectWouldContribute(detectProjectContributions(wt))).toBe(true);
  });

  it('labels stay relative from a subfolder of the worktree', () => {
    const { wt } = worktree(main => write(main, join('.claude', 'commands', 'ship.md'), 'x'));
    const app = join(wt, 'packages', 'app');
    write(app, 'index.ts', 'export {}\n');
    expect(labels(app)).toContain('COMMANDS ../../../main/.claude/commands ship');
  });

  it('a worktree with its own .claude/agents keeps that copy alone; the main checkout\'s commands still count', () => {
    const { wt } = worktree(main => {
      write(main, join('.claude', 'agents', 'reviewer.md'), 'x');
      write(main, join('.claude', 'commands', 'ship.md'), 'x');
    });
    write(wt, join('.claude', 'agents', 'own.md'), 'x');
    const items = labels(wt);
    expect(items.some(item => item.includes('../main/.claude/agents'))).toBe(false);
    expect(items).toContain('COMMANDS ../main/.claude/commands ship');
  });

  it('CONTROLS: the main checkout\'s skills are not named (v2.1.277+, vendored 2.1.274), and neither the main checkout itself nor a plain repository reads anything through', () => {
    const { main, wt } = worktree(m => write(m, join('.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\nBody'));
    expect(labels(wt)).toEqual([]);
    expect(labels(main).some(item => item.includes('../'))).toBe(false);
  });
});

/**
 * F1.846 (origin WJ-crit-oo P-3…P-7) — the detector's completeness residues after F1.839. The
 * pre-trust report names what a trusted project would load, and `projectWouldContribute`
 * suppresses the prompt while it is empty, so a layer the report misses is a layer that silently
 * never loads on the re-prompt path.
 */
describe('detectProjectContributions — the residues F1.839 left (F1.846)', () => {
  const only: Array<[string, (root: string) => void, ProjectContributionItem[]]> = [
    // P-3: Pi's trusted project scope reads the root `MEMORY.md` and `.agents/rules` (`native-sources.ts`).
    ['a root MEMORY.md', root => write(root, 'MEMORY.md', '# memory'),
      [{ itemType: 'AGENTS_MD', sourceLabel: 'MEMORY.md', count: 1, names: ['MEMORY.md'] }]],
    ['.agents/rules, nested only', root => write(root, join('.agents', 'rules', 'backend', 'api.md'), '# rule'),
      [{ itemType: 'AGENTS_MD', sourceLabel: '.agents/rules', count: 1, names: ['api'] }]],
    // P-4: `.nessy-agent/rules` is read recursively by Pi (`discoverRuleFiles`).
    ['.nessy-agent/rules, nested only', root => write(root, join('.nessy-agent', 'rules', 'frontend', 'react.md'), '# rule'),
      [{ itemType: 'AGENTS_MD', sourceLabel: '.nessy-agent/rules', count: 1, names: ['react'] }]],
    // P-7: claude project output styles come only with the `project` source (F1.768), as ours do.
    ['.claude/output-styles', root => write(root, join('.claude', 'output-styles', 'terse.md'), '---\nname: Terse\n---\nBe brief.'),
      [{ itemType: 'AGENTS_MD', sourceLabel: '.claude/output-styles', count: 1, names: ['terse'] }]],
  ];

  it.each(only)('%s alone is a contribution', (_label, seed, items) => {
    const root = tmp();
    seed(root);
    const report = detectProjectContributions(root);
    expect(report.items).toEqual(items);
    expect(projectWouldContribute(report)).toBe(true);
  });

  it('P-5: a .codex/config.toml names the MCP servers it declares (names only), beside its presence row', () => {
    const root = tmp();
    write(root, join('.codex', 'config.toml'), [
      'model = "x"',
      '[mcp_servers.docs]',
      'command = "docs-server"',
      '[mcp_servers.docs.env]',
      'TOKEN = "never-shown"',
      '[mcp_servers."remote-api"]',
      'url = "https://example.invalid/mcp"',
      '[profiles.fast]',
      'model = "y"',
    ].join('\n'));
    const report = detectProjectContributions(root);
    expect(report.items).toEqual([
      { itemType: 'MCP_SERVER_CONFIG', sourceLabel: '.codex/config.toml', count: 2, names: ['docs', 'remote-api'] },
      { itemType: 'CONFIG', sourceLabel: '.codex/config.toml', count: 1, names: ['config.toml'] },
    ]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('docs-server');
    expect(serialized).not.toContain('never-shown');
  });

  it('NEGATIVE — a config.toml with no MCP server keeps its presence row alone; an empty folder is still empty', () => {
    const root = tmp();
    write(root, join('.codex', 'config.toml'), 'model = "x"\n[profiles.fast]\nmodel = "y"\n');
    expect(detectProjectContributions(root).items).toEqual([
      { itemType: 'CONFIG', sourceLabel: '.codex/config.toml', count: 1, names: ['config.toml'] },
    ]);
    expect(detectProjectContributions(tmp()).items).toEqual([]);
  });

  it('P-6: the detector imports as an entry point outside `bun test` (no memory-store/cleanup cycle)', () => {
    const detector = join(import.meta.dir, '..', 'project-contribution-detect.ts');
    // `process.exit` because the module graph leaves a timer open (measured: loaded in under 1 s of CPU,
    // then idle ~60 s before a bare entry point exits) — the subject here is the import, not that timer.
    const result = spawnSync(process.execPath, ['-e', `const m = await import(${JSON.stringify(detector)}); console.log(typeof m.detectProjectContributions); process.exit(0)`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' },
    });
    expect(result.stderr).not.toContain('before initialization');
    expect(result.stdout.trim()).toBe('function');
    expect(result.status).toBe(0);
  }, MODULE_GRAPH_CASE_BUDGET_MS);
});

describe('detectProjectContributions — claude project workflows (F1.866)', () => {
  // workflows.md#save-the-workflow-for-reuse: a saved workflow is a `.js` file in `.claude/workflows/` that "runs as
  // `/<name>` in future sessions", and "Project workflows also load from every `.claude/workflows/` along that path"
  // (the working directory up to the repository root). Claude reads it with the `project` source, which this host
  // passes only for a trusted project, so a folder carrying only a workflow must still be asked about.
  it('a root .claude/workflows/*.js alone is a contribution, named without its extension', () => {
    const root = tmp();
    write(root, join('.claude', 'workflows', 'audit-routes.js'), "export const meta = { name: 'audit-routes' }\n");
    const report = detectProjectContributions(root);
    expect(report.items).toEqual([{ itemType: 'COMMANDS', sourceLabel: '.claude/workflows', count: 1, names: ['audit-routes'] }]);
    expect(projectWouldContribute(report)).toBe(true);
  });

  it('the repository root\'s .claude/workflows makes a subfolder a contribution', () => {
    const outer = tmp('pcd-wf-');
    const root = join(outer, 'repo');
    write(root, join('.git', 'HEAD'), 'ref: refs/heads/main\n');
    write(root, join('.claude', 'workflows', 'ship.js'), 'export const meta = {}\n');
    const app = join(root, 'packages', 'app');
    write(app, 'index.ts', 'export {}\n');
    expect(detectProjectContributions(app).items).toEqual([
      { itemType: 'COMMANDS', sourceLabel: '../../.claude/workflows', count: 1, names: ['ship'] },
    ]);
  });

  it('NEGATIVE — a non-script file in .claude/workflows, and .claude/routines, contribute nothing', () => {
    const root = tmp();
    write(root, join('.claude', 'workflows', 'notes.txt'), 'x');
    write(root, join('.claude', 'routines', 'nightly.md'), '# nightly');
    expect(detectProjectContributions(root).items).toEqual([]);
  });
});
