import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyClaudeSetupImportPlan,
  computeClaudeSetupImportPlan,
  type ClaudeImportChange,
  type ClaudeImportKind,
} from '../claude-setup-import.ts';
import { readUserAgentDefinitions } from '../../agents/definitions.ts';
import { listCustomSlashCommands } from '../../slash-commands/custom-commands.ts';
import { CONFIG_DIR } from '../../config/paths.ts';
import { getProjectMemoryFilePath } from '../../agent/memory/memory-store.ts';
import { getSpellCheck } from '../../config/storage.ts';

// P6.625 — an explicit budget, set against a MEASURED floor and never zero.
//
// This suite is class (c) STARVED: at bun's 5 000 ms default it has been read
// 40 pass / 5 fail with all five timeouts carrying ZERO assertion failures, in
// pre-existing cases, and 45 pass / 0 fail at `--timeout 60000` — the whole file
// completing in 19.33 s (load 13.29). Re-measured 2026-09-06 at load 14.13 it is
// 45 pass / 0 fail on the DEFAULT budget in 22.67 s cold, and the same four-file
// batch runs in 2.09 s warm: the cost is the cold module graph, not any one
// case, so whether a run goes red is decided by where the transpiler yields.
// That is why this is a budget and not a register row saying "expect a red".
//
// 60 s is the budget the file was actually measured green under, and ~2.6x the
// 22.67 s cold whole-file floor. Readings, controls and the family are in
// `docs/superpowers/specs/2026-07-29-known-failing-tests.md`.
setDefaultTimeout(60_000);

/**
 * A fixture `~/.claude` (plus a `~/.claude.json` for user MCP) with one artifact
 * of every kind, and an empty workspace to import into.
 */
function makeFixture(): { home: string; claudeDir: string; claudeJsonPath: string; ws: string } {
  const home = mkdtempSync(join(tmpdir(), 'claude-import-home-'));
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });

  // instruction
  writeFileSync(join(claudeDir, 'CLAUDE.md'), '# My Claude memory\n\nAlways be concise.\n', 'utf-8');

  // permissions + hooks (both live in settings.json)
  writeFileSync(
    join(claudeDir, 'settings.json'),
    JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm:*)'] },
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] },
        ],
      },
    }),
    'utf-8',
  );

  // skill
  const skillDir = join(claudeDir, 'skills', 'my-skill');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: my-skill\ndescription: Does a thing\n---\n\nStep one.\n',
    'utf-8',
  );

  // MCP (user scope, ~/.claude.json)
  const claudeJsonPath = join(home, '.claude.json');
  writeFileSync(
    claudeJsonPath,
    JSON.stringify({
      mcpServers: {
        filesystem: { type: 'stdio', command: 'node', args: ['server.js'] },
        remote: { type: 'http', url: 'https://example.com/mcp' },
      },
    }),
    'utf-8',
  );

  // agent + command (P6.442) — the two kinds where a switching user's own
  // customisation lives.
  mkdirSync(join(claudeDir, 'agents'), { recursive: true });
  writeFileSync(
    join(claudeDir, 'agents', 'critic.md'),
    '---\ndescription: Review a narrow change.\ntoolset: full\ntier: big\n---\n\nReview only the requested change.\n',
    'utf-8',
  );
  mkdirSync(join(claudeDir, 'commands'), { recursive: true });
  writeFileSync(
    join(claudeDir, 'commands', 'deploy.md'),
    '---\ndescription: Ship it\n---\n\nDeploy $ARGUMENTS.\n',
    'utf-8',
  );

  const ws = mkdtempSync(join(tmpdir(), 'claude-import-ws-'));
  return { home, claudeDir, claudeJsonPath, ws };
}

let fx: ReturnType<typeof makeFixture>;

beforeEach(() => {
  fx = makeFixture();
});

afterEach(() => {
  rmSync(fx.home, { recursive: true, force: true });
  rmSync(fx.ws, { recursive: true, force: true });
});

function kinds(changes: { kind: ClaudeImportKind }[]): Set<ClaudeImportKind> {
  return new Set(changes.map(c => c.kind));
}

describe('computeClaudeSetupImportPlan (dry-run)', () => {
  it('produces one change per artifact kind', async () => {
    const plan = await computeClaudeSetupImportPlan({
      workspaceRootPath: fx.ws,
      homeDir: fx.home,
    });
    expect(plan.empty).toBe(false);
    expect(kinds(plan.changes))
      .toEqual(new Set(['instruction', 'permission', 'skill', 'mcp', 'hook', 'agent', 'command']));
    // Both MCP servers surface.
    expect(plan.changes.filter(c => c.kind === 'mcp').map(c => c.name).sort()).toEqual(['filesystem', 'remote']);
  });

  it('writes NOTHING to the workspace (dry-run is read-only)', async () => {
    await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(existsSync(join(fx.ws, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(fx.ws, 'permissions.json'))).toBe(false);
    expect(existsSync(join(fx.ws, 'hooks.json'))).toBe(false);
    expect(existsSync(join(fx.ws, 'skills'))).toBe(false);
    expect(existsSync(join(fx.ws, 'sources'))).toBe(false);
  });

  it('reports the empty state when there is nothing to import', async () => {
    const emptyHome = mkdtempSync(join(tmpdir(), 'claude-import-empty-'));
    try {
      const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: emptyHome });
      expect(plan.empty).toBe(true);
      expect(plan.changes).toEqual([]);
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});

describe('cancel writes nothing', () => {
  it('computing then not applying leaves the workspace untouched', async () => {
    await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    // No apply call == cancel: not one target from any kind exists.
    for (const target of ['AGENTS.md', 'permissions.json', 'hooks.json', 'skills', 'sources']) {
      expect(existsSync(join(fx.ws, target))).toBe(false);
    }
  });
});

describe('applyClaudeSetupImportPlan — per kind', () => {
  it('instruction → merges into AGENTS.md as a managed block', async () => {
    const result = await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(result.errors).toEqual([]);
    const agents = readFileSync(join(fx.ws, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('nessy:claude-import:begin');
    expect(agents).toContain('Always be concise.');
    expect(agents).toContain('nessy:claude-import:end');
  });

  it('permission → writes rules into permissions.json permissionDsl', async () => {
    await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    const perms = JSON.parse(readFileSync(join(fx.ws, 'permissions.json'), 'utf-8'));
    const rules = perms.permissionDsl.rules as Array<{ action: string }>;
    expect(rules.length).toBe(2);
    expect(rules.map(r => r.action).sort()).toEqual(['allow', 'deny']);
  });

  it('skill → copies the skill directory under skills/', async () => {
    await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    const skillFile = join(fx.ws, 'skills', 'my-skill', 'SKILL.md');
    expect(existsSync(skillFile)).toBe(true);
    expect(readFileSync(skillFile, 'utf-8')).toContain('Does a thing');
  });

  it('mcp → writes each server as a workspace source config', async () => {
    await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    const stdio = JSON.parse(readFileSync(join(fx.ws, 'sources', 'filesystem', 'config.json'), 'utf-8'));
    expect(stdio.type).toBe('mcp');
    expect(stdio.mcp.transport).toBe('stdio');
    expect(stdio.mcp.command).toBe('node');
    expect(stdio.mcp.args).toEqual(['server.js']);
    const http = JSON.parse(readFileSync(join(fx.ws, 'sources', 'remote', 'config.json'), 'utf-8'));
    expect(http.mcp.transport).toBe('http');
    expect(http.mcp.url).toBe('https://example.com/mcp');
  });

  it('hook → writes the event map into hooks.json', async () => {
    await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    const hooks = JSON.parse(readFileSync(join(fx.ws, 'hooks.json'), 'utf-8'));
    expect(Object.keys(hooks.hooks)).toContain('PreToolUse');
    const matcher = hooks.hooks.PreToolUse[0];
    expect(matcher.actions[0].command).toBe('echo pre');
  });
});

describe('conflict handling', () => {
  it('marks a pre-existing skill as conflict and does not overwrite it', async () => {
    const dest = join(fx.ws, 'skills', 'my-skill');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'SKILL.md'), 'PRE-EXISTING', 'utf-8');

    const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    const skillChange = plan.changes.find(c => c.kind === 'skill' && c.name === 'my-skill');
    expect(skillChange?.action).toBe('conflict');

    const result = await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(result.skipped.some(c => c.kind === 'skill')).toBe(true);
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf-8')).toBe('PRE-EXISTING');
  });

  it('marks a pre-existing MCP source as conflict', async () => {
    const srcDir = join(fx.ws, 'sources', 'filesystem');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'config.json'), JSON.stringify({ type: 'mcp', slug: 'filesystem' }), 'utf-8');
    const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(plan.changes.find(c => c.kind === 'mcp' && c.name === 'filesystem')?.action).toBe('conflict');
  });
});

/**
 * P3.242 — owner ruling 2026-09-01: REFUSE, NAMING THE OVERRIDE.
 *
 * `AGENTS.override.md` supersedes `AGENTS.md` in the same directory for every
 * reader of project instructions (`agentsMdSupersededIn`, codex's own
 * per-directory rule, applied host-wide). Before this the import wrote its block
 * into `AGENTS.md`, reported success, and the guidance reached no model on any
 * runtime — an import that is told to succeed and is silently inert.
 *
 * Both arms are asserted, and the NEGATIVE one is what keeps this from being a
 * refusal of everything: with no override present the same fixture still merges.
 */
describe('an import that would land in a superseded file is refused, not written', () => {
  const overrideAt = (dir: string) =>
    writeFileSync(join(dir, 'AGENTS.override.md'), '# local override\n', 'utf-8');

  it('names the override in the plan and refuses the instruction change', async () => {
    overrideAt(fx.ws);
    const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    const instruction = plan.changes.find(c => c.kind === 'instruction');
    expect(instruction?.action).toBe('conflict');
    // The user must learn WHICH file is superseding, or the refusal is unactionable.
    expect(instruction?.detail).toContain('AGENTS.override.md');
    expect(instruction?.target).toBe('AGENTS.md');
    // Every other kind is unaffected — this refuses one target, not the import.
    expect(plan.changes.filter(c => c.action === 'conflict')).toHaveLength(1);
  });

  it('writes no AGENTS.md and reports it skipped', async () => {
    overrideAt(fx.ws);
    const result = await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(result.skipped.map(c => c.kind)).toEqual(['instruction']);
    expect(result.applied.some(c => c.kind === 'instruction')).toBe(false);
    expect(existsSync(join(fx.ws, 'AGENTS.md'))).toBe(false);
    // The override itself is never touched: refusing is not editing.
    expect(readFileSync(join(fx.ws, 'AGENTS.override.md'), 'utf-8')).toBe('# local override\n');
    // Positive control on the same run: the other kinds still landed.
    expect(existsSync(join(fx.ws, 'permissions.json'))).toBe(true);
  });

  it('NEGATIVE CONTROL: with no override the same fixture still merges into AGENTS.md', async () => {
    const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(plan.changes.find(c => c.kind === 'instruction')?.action).toBe('create');
    await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(readFileSync(join(fx.ws, 'AGENTS.md'), 'utf-8')).toContain('Always be concise.');
  });

  it('a DIRECTORY named AGENTS.override.md is not an override (metadata.is_file)', async () => {
    // codex selects a candidate on `metadata.is_file`, and so does our mirror.
    // A directory of that name must not be able to refuse an import.
    mkdirSync(join(fx.ws, 'AGENTS.override.md'), { recursive: true });
    const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(plan.changes.find(c => c.kind === 'instruction')?.action).toBe('create');
  });
});

describe('idempotency', () => {
  it('applying twice does not duplicate permission rules or AGENTS.md blocks', async () => {
    await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    const perms = JSON.parse(readFileSync(join(fx.ws, 'permissions.json'), 'utf-8'));
    expect((perms.permissionDsl.rules as unknown[]).length).toBe(2);
    const agents = readFileSync(join(fx.ws, 'AGENTS.md'), 'utf-8');
    expect(agents.split('nessy:claude-import:begin').length - 1).toBe(1);
  });
});

// ===========================================================================
// Fix wave (P2.9 review) — an imported permission rule cannot brick the policy
// ===========================================================================

/**
 * The CRITICAL these cover, stated so a later reader does not have to re-derive
 * it: `parsePermissionsJson` only KEEPS an `anchor:'source'` rule when given a
 * `sourceRoot`, and the anchor is a compile-time LAYER property rather than part
 * of the matcher. Our destination is a Nessy-format `permissions.json`, whose
 * read path never returns a `sourceRoot`. So a verbatim `anchor:'source'`
 * matcher written there throws `invalid pathGlob source root` at compile, the
 * compiler catches per LAYER, and ONE such rule turns the whole workspace policy
 * into deny-everything — persisted, taking every co-resident allow with it.
 *
 * These assertions therefore go through the REAL read-back
 * (`permissionsConfigCache.getMergedConfig`) rather than inspecting the written
 * JSON: the defect was invisible on the written file, which looked perfectly
 * well-formed. Asserting the compiled program is the only way to see it.
 */
import {
  parsePermissionsJson,
  permissionsConfigCache,
  type PermissionsContext,
} from '../../agent/permissions-config.ts';
import { compilePermissionDslV1, evaluatePermissionDslV1 } from '../../agent/pi-harness/permission-dsl.ts';

/** A fixture whose `~/.claude/settings.json` carries exactly `permissions`. */
function makePermissionsFixture(permissions: unknown): { home: string; claudeDir: string; ws: string } {
  const home = mkdtempSync(join(tmpdir(), 'claude-perm-home-'));
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ permissions }), 'utf-8');
  const ws = mkdtempSync(join(tmpdir(), 'claude-perm-ws-'));
  return { home, claudeDir, ws };
}

/** The compiled workspace policy, read back the way the runtime reads it. */
function compiledPolicy(ws: string) {
  permissionsConfigCache.invalidateWorkspace(ws);
  return permissionsConfigCache.getMergedConfig({ workspaceRootPath: ws } as PermissionsContext).permissionDsl;
}

function bashLsVerdict(ws: string): string | undefined {
  const dsl = compiledPolicy(ws);
  if (!dsl) return undefined;
  return evaluatePermissionDslV1(dsl, {
    generation: dsl.generation,
    toolName: 'Bash',
    semanticId: 'bash',
    input: { command: 'ls' },
    cwd: ws,
  } as never).action;
}

describe('imported permission rules cannot brick the workspace policy', () => {
  it('compiles a /-anchored deny AND its co-resident allow, with no invalidSource', async () => {
    const fx = makePermissionsFixture({ deny: ['Read(/secrets/**)'], allow: ['Bash(ls:*)'] });
    try {
      await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
      const dsl = compiledPolicy(fx.ws);
      expect(dsl?.rules.length).toBe(2);
      expect(dsl?.invalidSource).toBeUndefined();
      // The whole point: the co-resident allow is NOT destroyed.
      expect(bashLsVerdict(fx.ws)).toBe('allow');
    } finally {
      rmSync(fx.home, { recursive: true, force: true });
      rmSync(fx.ws, { recursive: true, force: true });
    }
  });

  it('compiles a /-anchored Cd rule (cdPath carries the same anchor)', async () => {
    const fx = makePermissionsFixture({ allow: ['Cd(/work)'] });
    try {
      await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
      const dsl = compiledPolicy(fx.ws);
      expect(dsl?.rules.length).toBe(1);
      expect(dsl?.invalidSource).toBeUndefined();
    } finally {
      rmSync(fx.home, { recursive: true, force: true });
      rmSync(fx.ws, { recursive: true, force: true });
    }
  });

  it('writes no source-anchored matcher to disk (the anchor is resolved at import)', async () => {
    const fx = makePermissionsFixture({ deny: ['Read(/secrets/**)'] });
    try {
      await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
      const raw = readFileSync(join(fx.ws, 'permissions.json'), 'utf-8');
      expect(raw).not.toContain('"anchor": "source"');
      expect(raw).toContain('"anchor": "absolute"');
    } finally {
      rmSync(fx.home, { recursive: true, force: true });
      rmSync(fx.ws, { recursive: true, force: true });
    }
  });

  it('preserves the rule MEANING: the converted deny still covers the Claude dir and nothing else', async () => {
    const fx = makePermissionsFixture({ deny: ['Read(/secrets/**)'], allow: ['Bash(ls:*)'] });
    try {
      await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
      const dsl = compiledPolicy(fx.ws)!;
      const readAt = (p: string) => evaluatePermissionDslV1(dsl, {
        generation: dsl.generation,
        toolName: 'Read',
        semanticId: 'read',
        input: { file_path: p },
        cwd: fx.ws,
      } as never).action;
      // Still denied where the rule pointed...
      expect(readAt(join(fx.claudeDir, 'secrets', 'a.txt'))).toBe('deny');
      // ...and NOT widened to a same-named path anywhere else.
      expect(readAt(join(fx.ws, 'secrets', 'a.txt'))).toBeUndefined();
      expect(readAt('/etc/passwd')).toBeUndefined();
    } finally {
      rmSync(fx.home, { recursive: true, force: true });
      rmSync(fx.ws, { recursive: true, force: true });
    }
  });

  // The two negative controls that must stay clean — they are what prove the
  // fix is scoped to the source anchor rather than papering over the compile.
  it('NEGATIVE CONTROL: bash-only rules are unaffected', async () => {
    const fx = makePermissionsFixture({ deny: ['Bash(rm:*)'], allow: ['Bash(ls:*)'] });
    try {
      await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
      const dsl = compiledPolicy(fx.ws);
      expect(dsl?.rules.length).toBe(2);
      expect(dsl?.invalidSource).toBeUndefined();
      expect(bashLsVerdict(fx.ws)).toBe('allow');
    } finally {
      rmSync(fx.home, { recursive: true, force: true });
      rmSync(fx.ws, { recursive: true, force: true });
    }
  });

  it('NEGATIVE CONTROL: // and ~/ anchors are untouched', async () => {
    const fx = makePermissionsFixture({
      deny: ['Read(//etc/**)'],
      allow: ['Read(~/notes/**)', 'Bash(ls:*)'],
    });
    try {
      await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
      const dsl = compiledPolicy(fx.ws);
      expect(dsl?.rules.length).toBe(3);
      expect(dsl?.invalidSource).toBeUndefined();
      expect(bashLsVerdict(fx.ws)).toBe('allow');
      const raw = readFileSync(join(fx.ws, 'permissions.json'), 'utf-8');
      // `//etc/**` already imports as an absolute anchor; it must not be
      // re-rooted under the Claude directory by the new conversion.
      expect(raw).toContain('"pattern": "etc/**"');
    } finally {
      rmSync(fx.home, { recursive: true, force: true });
      rmSync(fx.ws, { recursive: true, force: true });
    }
  });
});

describe('a dropped permission entry is never silent', () => {
  it('names every entry the reader could not turn into a rule', async () => {
    const fx = makePermissionsFixture({
      deny: ['Read(/secrets/**)', 'NoSuchTool(x)'],
      allow: ['Bash(ls:*)', 'AlsoBogus(y)'],
    });
    try {
      const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
      // The two importable rules are counted...
      expect(plan.changes.find(c => c.kind === 'permission')?.detail).toBe('2 rule(s)');
      // ...and the two that vanished are NAMED, not merely missing from a count
      // the user cannot cross-check.
      const joined = plan.warnings.join('\n');
      expect(joined).toContain('NoSuchTool(x)');
      expect(joined).toContain('AlsoBogus(y)');
    } finally {
      rmSync(fx.home, { recursive: true, force: true });
      rmSync(fx.ws, { recursive: true, force: true });
    }
  });

  it('stays quiet when every entry imported', async () => {
    const fx = makePermissionsFixture({ allow: ['Bash(ls:*)'] });
    try {
      const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
      expect(plan.warnings).toEqual([]);
    } finally {
      rmSync(fx.home, { recursive: true, force: true });
      rmSync(fx.ws, { recursive: true, force: true });
    }
  });
});

describe('an MCP server whose env/headers we cannot carry is imported disabled', () => {
  function mcpFixture(servers: Record<string, unknown>): { home: string; ws: string } {
    const home = mkdtempSync(join(tmpdir(), 'claude-mcp-home-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: servers }), 'utf-8');
    const ws = mkdtempSync(join(tmpdir(), 'claude-mcp-ws-'));
    return { home, ws };
  }

  it('disables and warns for declared env/headers, and leaves a clean server enabled', async () => {
    const fx = mcpFixture({
      needsenv: { type: 'stdio', command: 'node', args: ['s.js'], env: { TOKEN: 'x' } },
      needshdr: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
      clean: { type: 'stdio', command: 'node', args: ['ok.js'] },
    });
    try {
      const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
      const joined = plan.warnings.join('\n');
      expect(joined).toContain('needsenv');
      expect(joined).toContain('needshdr');
      expect(joined).not.toContain('"clean"');

      await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
      const enabledOf = (slug: string) =>
        JSON.parse(readFileSync(join(fx.ws, 'sources', slug, 'config.json'), 'utf-8')).enabled;
      // Dead-but-enabled reads as a product defect; disabled states the case.
      expect(enabledOf('needsenv')).toBe(false);
      expect(enabledOf('needshdr')).toBe(false);
      expect(enabledOf('clean')).toBe(true);
    } finally {
      rmSync(fx.home, { recursive: true, force: true });
      rmSync(fx.ws, { recursive: true, force: true });
    }
  });
});

describe('apply is pinned to the plan the user confirmed', () => {
  it('does not import a skill that appeared after the preview', async () => {
    const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    // `~/.claude` changes between preview and confirm.
    const late = join(fx.claudeDir, 'skills', 'late-arrival');
    mkdirSync(late, { recursive: true });
    writeFileSync(join(late, 'SKILL.md'), '---\nname: late-arrival\n---\n\nNew.\n', 'utf-8');

    const result = await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home }, plan);
    expect(result.applied.some(c => c.name === 'late-arrival')).toBe(false);
    expect(existsSync(join(fx.ws, 'skills', 'late-arrival'))).toBe(false);
    // The confirmed skill still landed.
    expect(existsSync(join(fx.ws, 'skills', 'my-skill'))).toBe(true);
  });

  it('reports a confirmed change that vanished before the confirm', async () => {
    const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    rmSync(join(fx.claudeDir, 'skills', 'my-skill'), { recursive: true, force: true });
    const result = await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home }, plan);
    expect(result.errors.join('\n')).toContain('my-skill');
    expect(result.applied.some(c => c.name === 'my-skill')).toBe(false);
  });

  it('without a confirmed plan, apply still imports its own fresh scan', async () => {
    const result = await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(result.applied.some(c => c.name === 'my-skill')).toBe(true);
  });
});

describe('a copied CLAUDE.md names its dangling @path imports', () => {
  it('warns for a real import token and ignores one inside a code span', async () => {
    const home = mkdtempSync(join(tmpdir(), 'claude-instr-home-'));
    const claudeDir = join(home, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'CLAUDE.md'),
      'Rules\n\n@shared/style.md\n\n`@not-an-import.md`\n',
      'utf-8',
    );
    const ws = mkdtempSync(join(tmpdir(), 'claude-instr-ws-'));
    try {
      const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: ws, homeDir: home });
      const joined = plan.warnings.join('\n');
      expect(joined).toContain('@shared/style.md');
      // The runtime's own scanner is reused, so a token in a code span is not an
      // import here either.
      expect(joined).not.toContain('not-an-import.md');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Fix wave 2 — a resolved rule keeps its gitignore float and its escape guard
// ===========================================================================

/**
 * A DIFFERENTIAL rig. The earlier `preserves the rule MEANING` test probed only
 * paths in the no-drift class, which is why two meaning changes survived it: a
 * bare literal lost its any-depth float (NARROWING a deny), and a `..` segment
 * was normalized away (WIDENING an allow, up to a filesystem-wide read grant).
 *
 * So instead of asserting verdicts we believe are right, each case asserts that
 * the IMPORTED layer answers a probe path EXACTLY as the CLAUDE-side layer does.
 * The two sides differ only in the one property under test: the claude side is
 * compiled WITH `sourceRoot` (so `anchor:'source'` resolves), the import side is
 * compiled without it, from the bytes actually written to `permissions.json`.
 *
 * POSITIVE CONTROL, and it is not optional: a layer that compiles zero rules
 * answers every probe identically (with nothing) and so reports "no drift" for
 * any input at all. `expectDifferential` therefore refuses to pass unless the
 * claude side actually compiled rules. (A `scope:'project'` layer without
 * `projectTrusted: true` is silently skipped for exactly this reason — hence
 * `scope: 'workspace'` plus the explicit rule-count assertion.)
 */
async function expectDifferential(
  permissions: unknown,
  probesOf: (claudeDir: string) => string[],
  options: { expectImportedRules: number },
): Promise<{ warnings: string[] }> {
  const home = mkdtempSync(join(tmpdir(), 'claude-diff-home-'));
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const settings = JSON.stringify({ permissions });
  writeFileSync(join(claudeDir, 'settings.json'), settings, 'utf-8');
  const ws = mkdtempSync(join(tmpdir(), 'claude-diff-ws-'));
  try {
    const compile = (document: unknown, sourceRoot?: string) => compilePermissionDslV1({
      generation: 'differential',
      projectTrusted: true,
      layers: [{ scope: 'workspace', sourceDigest: 'digest', document, ...(sourceRoot ? { sourceRoot } : {}) }],
    });

    // The Claude side: the reader's own rules, anchored the way Claude anchors them.
    const claudeSide = compile(parsePermissionsJson(settings, claudeDir).permissionDsl?.document, claudeDir);
    expect(claudeSide.rules.length).toBeGreaterThan(0); // positive control
    expect(claudeSide.invalidSource).toBeUndefined();

    const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: ws, homeDir: home });
    await applyClaudeSetupImportPlan({ workspaceRootPath: ws, homeDir: home }, plan);
    const permissionsPath = join(ws, 'permissions.json');
    const written = existsSync(permissionsPath)
      ? (JSON.parse(readFileSync(permissionsPath, 'utf-8')).permissionDsl as unknown)
      : { version: 1, rules: [] };
    const importSide = compile(written);
    expect((written as { rules: unknown[] }).rules.length).toBe(options.expectImportedRules);
    expect(importSide.invalidSource).toBeUndefined();

    const verdict = (program: typeof claudeSide, path: string) => evaluatePermissionDslV1(program, {
      generation: program.generation,
      toolName: 'Read',
      semanticId: 'read',
      input: { file_path: path },
      cwd: '/nowhere',
    } as never).action;

    for (const probe of probesOf(claudeDir)) {
      // The whole assertion: same question, same answer, on both sides.
      expect(`${probe.replace(claudeDir, '<claudeDir>')} => ${verdict(importSide, probe) ?? 'none'}`)
        .toBe(`${probe.replace(claudeDir, '<claudeDir>')} => ${verdict(claudeSide, probe) ?? 'none'}`);
    }
    return { warnings: plan.warnings };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
}

describe('a resolved rule keeps the gitignore any-depth float', () => {
  // `matchGitignoreGlob`: "Bare filenames follow gitignore semantics and match
  // at any depth, so `Read(.env)` and `Read(**​/.env)` are equivalent."
  // Resolving introduces slashes, which killed that float.
  const anyDepthProbes = (cd: string) => [
    join(cd, '.env'),
    join(cd, 'sub', '.env'),
    join(cd, 'a', 'b', '.env'),
    join(cd, 'a', 'b', 'c', '.env'),
  ];

  it('a bare-literal DENY still matches at any depth (protection is not narrowed)', async () => {
    await expectDifferential({ deny: ['Read(/.env)'] }, anyDepthProbes, { expectImportedRules: 1 });
  });

  it('a bare-literal ALLOW still matches at any depth', async () => {
    await expectDifferential({ allow: ['Read(/.env)'] }, anyDepthProbes, { expectImportedRules: 1 });
  });

  it('CONTROL: a pattern WITH a slash keeps its fixed depth', async () => {
    await expectDifferential(
      { deny: ['Read(/sub/.env)'] },
      cd => [join(cd, 'sub', '.env'), join(cd, '.env'), join(cd, 'a', 'sub', '.env')],
      { expectImportedRules: 1 },
    );
  });

  it('CONTROL: a wildcard pattern is not a bare literal and does not float', async () => {
    await expectDifferential(
      { deny: ['Read(/*.pem)'] },
      cd => [join(cd, 'k.pem'), join(cd, 'sub', 'k.pem')],
      { expectImportedRules: 1 },
    );
  });

  it('CONTROL: a bare-literal Cd rule does NOT gain a float (Cd is path-anchored)', async () => {
    // `Cd` passes `bareLiteralFloat: false`, so floating it would ADD reach
    // Claude does not give it. Asserted on the written matcher because the Cd
    // evaluator takes a different request shape than Read.
    const home = mkdtempSync(join(tmpdir(), 'claude-cd-home-'));
    const claudeDir = join(home, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Cd(/work)'] } }),
      'utf-8',
    );
    const ws = mkdtempSync(join(tmpdir(), 'claude-cd-ws-'));
    try {
      await applyClaudeSetupImportPlan({ workspaceRootPath: ws, homeDir: home });
      const raw = readFileSync(join(ws, 'permissions.json'), 'utf-8');
      expect(raw).toContain('"kind": "cdPath"');
      expect(raw).toContain('"anchor": "absolute"');
      // No `**` was inserted for this bare literal.
      expect(raw).not.toContain('/**/');
      expect(raw).toContain('/.claude/work"');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('a resolved rule keeps Claude’s parent-escape guard', () => {
  // The matcher rejects any value whose `relative()` from the base starts with
  // `..`, so a `..` segment matches NOTHING on the Claude side. `posix.join`
  // normalizes it away, which would invent matches the rule never had — in the
  // allow direction, a grant.
  it('an escaping ALLOW is dropped, not turned into a broader grant', async () => {
    const { warnings } = await expectDifferential(
      { allow: ['Read(/../evil/**)'] },
      cd => [join(cd, '..', 'evil', 'x'), join(cd, 'evil', 'x')],
      { expectImportedRules: 0 },
    );
    expect(warnings.join('\n')).toContain('../evil/**');
  });

  it('a deep escaping ALLOW cannot become a filesystem-wide read grant', async () => {
    const { warnings } = await expectDifferential(
      { allow: ['Read(/../../../../../../**)'] },
      cd => ['/etc/passwd', '/', '/Users', '/tmp/x', join(cd, 'ok')],
      { expectImportedRules: 0 },
    );
    expect(warnings.join('\n')).toContain('..');
  });

  it('an escaping DENY is dropped too (it protected nothing in Claude either)', async () => {
    await expectDifferential(
      { deny: ['Read(/../evil/**)'] },
      cd => [join(cd, '..', 'evil', 'x'), join(cd, 'evil', 'x')],
      { expectImportedRules: 0 },
    );
  });

  it('a NON-escaping ".." is dropped as well — an escape-only guard would miss it', async () => {
    // `a/../b` never leaves the directory, so a guard that only asked "does the
    // join escape claudeDir?" would resolve it to `<claudeDir>/b` and widen the
    // grant. On the Claude side it matches neither `b` nor `a/b`.
    const { warnings } = await expectDifferential(
      { allow: ['Read(/a/../b)'] },
      cd => [join(cd, 'b'), join(cd, 'a', 'b')],
      { expectImportedRules: 0 },
    );
    expect(warnings.join('\n')).toContain('a/../b');
  });

  it('CONTROL: a "." segment is a no-op on both sides and is NOT dropped', async () => {
    const { warnings } = await expectDifferential(
      { allow: ['Read(/./b)'] },
      cd => [join(cd, 'b')],
      { expectImportedRules: 1 },
    );
    expect(warnings).toEqual([]);
  });
});

/**
 * P6.442 — the two kinds the importer used to leave behind, and the docblock
 * sentence that said so.
 */
describe('subagents and slash commands are imported', () => {
  it('lists each file with its badge and its ABSOLUTE destination', async () => {
    const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    const agent = plan.changes.find(c => c.kind === 'agent');
    const command = plan.changes.find(c => c.kind === 'command');
    expect(agent).toMatchObject({
      action: 'create',
      name: 'critic.md',
      target: 'critic.md',
      detail: join(fx.ws, 'critic.md'),
    });
    expect(command).toMatchObject({
      action: 'create',
      name: 'deploy.md',
      target: join('.nessy-agent', 'commands', 'deploy.md'),
      detail: join(fx.ws, '.nessy-agent', 'commands', 'deploy.md'),
    });
    // Still read-only.
    expect(existsSync(join(fx.ws, 'critic.md'))).toBe(false);
    expect(existsSync(join(fx.ws, '.nessy-agent'))).toBe(false);
  });

  it('lands each one where OUR OWN loader reads it, and makes the subagent resolvable', async () => {
    await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(readFileSync(join(fx.ws, 'critic.md'), 'utf-8')).toContain('Review only the requested change.');
    expect(readFileSync(join(fx.ws, '.nessy-agent', 'commands', 'deploy.md'), 'utf-8'))
      .toContain('Deploy $ARGUMENTS.');
    // The destination is not asserted by path alone: the reader that will load
    // it is asked, so a future move of the convention fails HERE.
    expect(readUserAgentDefinitions(fx.ws).map(d => d.name)).toContain('critic');
    expect(listCustomSlashCommands({ workspaceRootPath: fx.ws }).map(c => c.name)).toContain('deploy');
  });

  // The row's own control.
  it('reports merge, not create, on a second dry run after applying', async () => {
    await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    const second = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(second.changes.find(c => c.kind === 'agent')?.action).toBe('merge');
    expect(second.changes.find(c => c.kind === 'command')?.action).toBe('merge');
  });

  it('refuses to overwrite a destination whose bytes differ', async () => {
    writeFileSync(join(fx.ws, 'critic.md'), 'mine, not the imported one\n', 'utf-8');
    const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(plan.changes.find(c => c.kind === 'agent')?.action).toBe('conflict');
    const result = await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(result.skipped.some(c => c.kind === 'agent')).toBe(true);
    expect(readFileSync(join(fx.ws, 'critic.md'), 'utf-8')).toBe('mine, not the imported one\n');
  });

  it('skips an unparseable agent definition by NAME instead of copying it', async () => {
    writeFileSync(join(fx.claudeDir, 'agents', 'broken.md'), '---\ntier: enormous\n---\nnope\n', 'utf-8');
    const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(plan.changes.filter(c => c.kind === 'agent').map(c => c.name)).toEqual(['critic.md']);
    expect(plan.warnings.some(w => w.includes('broken.md'))).toBe(true);
  });

  it('does not import an instruction file that happens to sit in either directory', async () => {
    writeFileSync(join(fx.claudeDir, 'agents', 'CLAUDE.md'), '# not an agent\n', 'utf-8');
    writeFileSync(join(fx.claudeDir, 'commands', 'AGENTS.md'), '# not a command\n', 'utf-8');
    const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(plan.changes.filter(c => c.kind === 'agent').map(c => c.name)).toEqual(['critic.md']);
    expect(plan.changes.filter(c => c.kind === 'command').map(c => c.name)).toEqual(['deploy.md']);
  });
});

// ---------------------------------------------------------------------------
// P6.520 — the interactive-mode keys
// ---------------------------------------------------------------------------

describe('a settings file’s interactive keys land in a family or are named', () => {
  const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
  let fx: ReturnType<typeof makeFixture>;
  let savedConfig: string | null;

  /** Write `~/.claude/settings.json` keeping the fixture's permissions + hooks. */
  function writeClaudeSettings(extra: Record<string, unknown>): void {
    const path = join(fx.claudeDir, 'settings.json');
    const existing = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...existing, ...extra }), 'utf-8');
  }

  /** The stored preference, written raw so `undefined` (never chosen) is reachable. */
  function setStoredSpellCheck(value: boolean | undefined): void {
    const base = savedConfig
      ? JSON.parse(savedConfig) as Record<string, unknown>
      : { storageLayoutVersion: 2, workspaceRefs: [], activeWorkspaceId: null, activeSessionId: null };
    const next = { ...base };
    if (value === undefined) delete next.spellCheck;
    else next.spellCheck = value;
    writeFileSync(CONFIG_FILE, JSON.stringify(next), 'utf-8');
  }

  beforeEach(() => {
    fx = makeFixture();
    savedConfig = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf-8') : null;
    setStoredSpellCheck(undefined);
  });

  afterEach(() => {
    if (savedConfig === null) rmSync(CONFIG_FILE, { force: true });
    else writeFileSync(CONFIG_FILE, savedConfig, 'utf-8');
    rmSync(fx.home, { recursive: true, force: true });
    rmSync(fx.ws, { recursive: true, force: true });
  });

  it('carries `spellcheck` onto the built spell-check surface', async () => {
    writeClaudeSettings({ spellcheck: { enabled: true } });
    const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    const change = plan.changes.find(c => c.kind === 'setting');
    expect(change?.name).toBe('spellcheck');
    expect(change?.action).toBe('create');

    await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    // Asked of the reader the toggle and the composer use, not of the file.
    expect(getSpellCheck()).toBe(true);
  });

  it('names each unimplemented key once, and stays silent about keys the file does not set', async () => {
    // The negative control runs FIRST, on the same rig: the base fixture sets
    // none of the six, so a warnings list full of them would be noise.
    const control = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(control.warnings.filter(w => w.includes('settings.json "'))).toEqual([]);
    expect(control.changes.some(c => c.kind === 'setting')).toBe(false);

    writeClaudeSettings({
      autoContinueAtUsageLimit: false,
      emojiCompletionEnabled: false,
      keybindingFlavor: 'readline',
      promptSuggestionEnabled: false,
      vimInsertModeRemaps: { jj: '<Esc>' },
    });
    const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    for (const key of [
      'autoContinueAtUsageLimit', 'emojiCompletionEnabled', 'keybindingFlavor',
      'promptSuggestionEnabled', 'vimInsertModeRemaps',
    ]) {
      expect(plan.warnings.filter(w => w.includes(`"${key}"`))).toHaveLength(1);
    }
    // Named, never accepted: no inert change reaches the preview.
    expect(plan.changes.some(c => c.kind === 'setting')).toBe(false);
    // `keybindingFlavor` is the one that is dead UPSTREAM, not merely missing here.
    expect(plan.warnings.find(w => w.includes('"keybindingFlavor"'))).toContain('deprecated upstream');
  });

  it('refuses to flip a preference the user already chose here, and is idempotent when it matches', async () => {
    writeClaudeSettings({ spellcheck: { enabled: true } });

    setStoredSpellCheck(false);
    const conflict = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(conflict.changes.find(c => c.kind === 'setting')?.action).toBe('conflict');
    const result = await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(result.skipped.some(c => c.kind === 'setting')).toBe(true);
    expect(getSpellCheck()).toBe(false);

    setStoredSpellCheck(true);
    const merge = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(merge.changes.find(c => c.kind === 'setting')?.action).toBe('merge');
  });

  it('names the `spellcheck` sub-keys it cannot carry while still carrying `enabled`', async () => {
    writeClaudeSettings({ spellcheck: { enabled: true, checker: 'hunspell', language: 'en_GB' } });
    const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    const warning = plan.warnings.find(w => w.includes('"spellcheck"'));
    expect(warning).toContain('checker');
    expect(warning).toContain('language');
    expect(plan.changes.find(c => c.kind === 'setting')?.action).toBe('create');
  });
});

// ---------------------------------------------------------------------------
// P6.521 — project memories move; chats deliberately do not
// ---------------------------------------------------------------------------

describe('project memories are imported per file, and chats are named as left behind', () => {
  let fx: ReturnType<typeof makeFixture>;

  /** The documented derivation: the working directory path, non-alphanumerics -> `-`. */
  function claudeProjectDir(home: string, ws: string): string {
    return join(home, '.claude', 'projects', ws.replace(/[^a-zA-Z0-9]/g, '-'));
  }

  function seedMemories(files: Record<string, string>): string {
    const dir = join(claudeProjectDir(fx.home, fx.ws), 'memory');
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf-8');
    return dir;
  }

  beforeEach(() => { fx = makeFixture(); });
  afterEach(() => {
    rmSync(fx.home, { recursive: true, force: true });
    rmSync(fx.ws, { recursive: true, force: true });
  });

  it('lists every memory file separately and lands them where our own reader looks', async () => {
    seedMemories({
      'MEMORY.md': '# Memory Index\n\n- [Role](user_role.md) — prefers Bun\n',
      'user_role.md': '---\ntype: user\n---\n\nPrefers Bun over npm.\n',
    });
    const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    const memories = plan.changes.filter(c => c.kind === 'memory');
    // PER FILE, not one badge — the row's own reason: the user has to see which.
    expect(memories.map(c => c.name)).toEqual(['MEMORY.md', 'user_role.md']);
    expect(memories.every(c => c.action === 'create')).toBe(true);
    // The index is separated from a topic file, because only one is loaded at start.
    expect(memories[0]?.detail).toContain('index');
    expect(memories[1]?.detail).toContain('on demand');

    await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    // Asked of the reader, not of a path literal.
    expect(readFileSync(getProjectMemoryFilePath(fx.ws), 'utf-8')).toContain('Memory Index');
    // Flat, so the index's own relative link still resolves.
    expect(readFileSync(join(fx.ws, 'user_role.md'), 'utf-8')).toContain('Prefers Bun');
  });

  it('names the chats it deliberately left behind, and stays silent when there are none', async () => {
    // Negative control first, on the same rig: memories with no transcripts beside them.
    seedMemories({ 'MEMORY.md': '# Memory Index\n' });
    const quiet = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(quiet.warnings.some(w => w.includes('transcript'))).toBe(false);

    writeFileSync(join(claudeProjectDir(fx.home, fx.ws), 'a1b2.jsonl'), '{"type":"user"}\n', 'utf-8');
    const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    const warning = plan.warnings.find(w => w.includes('transcript'));
    expect(warning).toContain('NOT imported');
    // A deliberate omission carries its reason, or it reads as a defect.
    expect(warning).toContain('session store');
    // And it stays an omission: no chat ever becomes a change.
    expect(plan.changes.some(c => c.name.endsWith('.jsonl'))).toBe(false);
  });

  it('never overwrites a memory file the workspace already has, and is idempotent', async () => {
    seedMemories({ 'MEMORY.md': '# Memory Index\n', 'user_role.md': 'imported\n' });
    await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    const second = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(second.changes.filter(c => c.kind === 'memory').every(c => c.action === 'merge')).toBe(true);

    writeFileSync(join(fx.ws, 'user_role.md'), 'mine, not the imported one\n', 'utf-8');
    const third = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(third.changes.find(c => c.kind === 'memory' && c.name === 'user_role.md')?.action).toBe('conflict');
    const result = await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(result.skipped.some(c => c.kind === 'memory')).toBe(true);
    expect(readFileSync(join(fx.ws, 'user_role.md'), 'utf-8')).toBe('mine, not the imported one\n');
  });

  it('imports nothing when the project directory belongs to a different workspace', async () => {
    // The derivation is per working directory, so another project's memories
    // must not leak into this workspace.
    const other = join(fx.home, '.claude', 'projects', 'somewhere-else', 'memory');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'MEMORY.md'), '# Not this workspace\n', 'utf-8');
    const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(plan.changes.some(c => c.kind === 'memory')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P6.522 — a re-run names WHICH side moved, and the local copy always wins
// ---------------------------------------------------------------------------

describe('a second scan says which side drifted since the import', () => {
  let fx: ReturnType<typeof makeFixture>;

  const agentSource = () => join(fx.claudeDir, 'agents', 'critic.md');
  const agentLocal = () => join(fx.ws, 'critic.md');
  const agentChange = (plan: { changes: ClaudeImportChange[] }) =>
    plan.changes.find(c => c.kind === 'agent' && c.name === 'critic.md');

  beforeEach(() => { fx = makeFixture(); });
  afterEach(() => {
    rmSync(fx.home, { recursive: true, force: true });
    rmSync(fx.ws, { recursive: true, force: true });
  });

  it('says nothing about drift before an import, and nothing when neither side moved', async () => {
    // The negative control, on the same rig: with no receipt there is no
    // question to answer, and a drift line then would be an invention.
    const first = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(agentChange(first)?.detail ?? '').not.toContain('since you imported');

    await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    const second = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(agentChange(second)?.action).toBe('merge');
    expect(agentChange(second)?.detail ?? '').not.toContain('since you imported');
  });

  it('separates an upstream change, a local edit, and both — one badge could not', async () => {
    await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });

    // Only Claude Code moved.
    writeFileSync(agentSource(), '---\ndescription: Review a narrow change.\ntoolset: full\ntier: big\n---\n\nUpstream edit.\n', 'utf-8');
    const upstream = agentChange(await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home }));
    expect(upstream?.action).toBe('conflict');
    expect(upstream?.detail).toContain('Changed in Claude Code');
    // The policy is stated where the user reads it, not implied by a badge.
    expect(upstream?.detail).toContain('your copy here is kept');

    // Only this workspace moved.
    writeFileSync(agentSource(), readFileSync(agentLocal(), 'utf-8'), 'utf-8');
    writeFileSync(agentLocal(), '---\ndescription: Review a narrow change.\ntoolset: full\ntier: big\n---\n\nMy edit.\n', 'utf-8');
    const local = agentChange(await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home }));
    expect(local?.detail).toContain('You changed this copy here');

    // Both moved.
    writeFileSync(agentSource(), '---\ndescription: Review a narrow change.\ntoolset: full\ntier: big\n---\n\nUpstream again.\n', 'utf-8');
    const both = agentChange(await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home }));
    expect(both?.detail).toContain('BOTH sides');
  });

  it('keeps the local copy in every drift case — the policy, exercised not just printed', async () => {
    await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    writeFileSync(agentSource(), '---\ndescription: Review a narrow change.\ntoolset: full\ntier: big\n---\n\nUpstream edit.\n', 'utf-8');
    const result = await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    expect(result.skipped.some(c => c.kind === 'agent')).toBe(true);
    expect(readFileSync(agentLocal(), 'utf-8')).toContain('Review only the requested change.');
  });

  it('records the instruction file upstream-only, because its destination is a block not a file', async () => {
    await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    writeFileSync(join(fx.claudeDir, 'CLAUDE.md'), '# My Claude memory\n\nBe brief.\n', 'utf-8');
    const plan = await computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    const instruction = plan.changes.find(c => c.kind === 'instruction');
    expect(instruction?.detail).toContain('Changed in Claude Code');
    // The half it cannot know is not claimed: no local-side verdict appears.
    expect(instruction?.detail).not.toContain('your copy here is kept');
  });

  it('names an MCP server that still needs authorisation on the change itself', async () => {
    const claudeJson = JSON.parse(readFileSync(fx.claudeJsonPath, 'utf-8')) as Record<string, unknown>;
    const servers = claudeJson.mcpServers as Record<string, Record<string, unknown>>;
    servers.filesystem = { ...servers.filesystem, env: { TOKEN: 'secret' } };
    writeFileSync(fx.claudeJsonPath, JSON.stringify(claudeJson), 'utf-8');

    const result = await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home });
    const applied = result.applied.find(c => c.kind === 'mcp' && c.name === 'filesystem');
    // On the CHANGE, so it survives into the done list rather than living only
    // in the preview screen's warnings block.
    expect(applied?.detail).toContain('imported disabled');
    expect(applied?.detail).toContain('environment variables');

    // P6.654 — and MACHINE-READABLY, so the done screen's review card finds the
    // servers by a flag rather than by matching the prose above. Set from the
    // same predicate, so the two can never disagree.
    expect(applied?.needsAuth).toBe(true);
    // The negative on the same run: a server with nothing to carry is silent,
    // and the field is absent rather than `false`.
    const clean = result.applied.find(c => c.kind === 'mcp' && c.name !== 'filesystem');
    expect(clean).toBeDefined();
    expect(clean?.needsAuth).toBeUndefined();
    expect('needsAuth' in (clean as object)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P6.523 — the second foreign format: ~/.codex
// ---------------------------------------------------------------------------

describe('a codex setup is imported by the same scan, with the same badges', () => {
  let fx: ReturnType<typeof makeFixture>;
  let codexDir: string;

  function seedCodex(files: Record<string, string>): void {
    mkdirSync(codexDir, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(codexDir, name), body, 'utf-8');
  }

  beforeEach(() => {
    fx = makeFixture();
    codexDir = join(fx.home, '.codex');
  });
  afterEach(() => {
    rmSync(fx.home, { recursive: true, force: true });
    rmSync(fx.ws, { recursive: true, force: true });
  });

  const plan = () => computeClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home, codexDir });

  it('brings a codex user’s MCP servers across through the existing writer', async () => {
    // Shapes read from `codex-rs/config/src/mcp_types.rs` at rust-v0.150.1:
    // an untagged transport union of Stdio { command, args, ... } and
    // StreamableHttp { url, ... }.
    seedCodex({
      'config.toml': [
        '# a codex setup',
        '[mcp_servers.ripgrep]',
        'command = "rg-mcp"',
        'args = ["--stdio"]',
        '',
        '[mcp_servers.docs]',
        'url = "https://example.invalid/mcp"',
        '',
      ].join('\n'),
    });
    const scanned = await plan();
    const names = scanned.changes.filter(c => c.kind === 'mcp').map(c => c.name);
    expect(names).toContain('ripgrep');
    expect(names).toContain('docs');
    // The badge vocabulary is the existing one, not a codex-specific dialect.
    expect(scanned.changes.find(c => c.name === 'ripgrep')?.action).toBe('create');

    await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home, codexDir });
    expect(existsSync(join(fx.ws, 'sources', 'ripgrep'))).toBe(true);
  });

  it('imports a codex-only user’s instructions, and refuses to let two files fight over one block', async () => {
    // AGENTS.override.md first, then AGENTS.md, first NON-EMPTY winning:
    // `codex-rs/codex-home/src/instructions/mod.rs` at rust-v0.150.1.
    rmSync(join(fx.claudeDir, 'CLAUDE.md'), { force: true });
    seedCodex({ 'AGENTS.override.md': '   \n', 'AGENTS.md': '# Codex memory\n\nUse tabs.\n' });
    const codexOnly = await plan();
    const instruction = codexOnly.changes.find(c => c.kind === 'instruction');
    // The empty override falls through, exactly as the binary's loop does.
    expect(instruction?.name).toBe('AGENTS.md');

    await applyClaudeSetupImportPlan({ workspaceRootPath: fx.ws, homeDir: fx.home, codexDir });
    expect(readFileSync(join(fx.ws, 'AGENTS.md'), 'utf-8')).toContain('Use tabs.');
  });

  it('gives the Claude setup the name when both homes declare one, and says so', async () => {
    // The collision rule, both halves, on one rig. The instruction block first:
    seedCodex({
      'AGENTS.md': '# Codex memory\n\nUse tabs.\n',
      'config.toml': '[mcp_servers.filesystem]\ncommand = "other-fs"\n',
    });
    const scanned = await plan();
    expect(scanned.changes.find(c => c.kind === 'instruction')?.name).toBe('CLAUDE.md');
    expect(scanned.warnings.some(w => w.includes('AGENTS.md') && w.includes('NOT imported'))).toBe(true);
    // ...then the MCP name, which the Claude fixture already declares.
    expect(scanned.changes.filter(c => c.kind === 'mcp' && c.name === 'filesystem')).toHaveLength(1);
    expect(scanned.warnings.some(w => w.includes('codex MCP server "filesystem"'))).toBe(true);
  });

  it('imports a server whose secrets live in the shell DISABLED, and never drops a line it cannot read', async () => {
    seedCodex({
      'config.toml': [
        '[mcp_servers.secret]',
        'command = "s"',
        'env = { TOKEN = "x" }',
        '',
        '[mcp_servers.futureshape]',
        'command = "f"',
        'startup_timeout_sec = 1979-05-27T07:32:00Z',
        '',
      ].join('\n'),
    });
    const scanned = await plan();
    expect(scanned.warnings.some(w => w.includes('"secret"') && w.includes('imported disabled'))).toBe(true);
    // A shape pinned to rust-v0.148.0 cannot read must be NAMED, never dropped:
    // that is what lets this reader meet a file written by a newer codex.
    expect(scanned.warnings.some(w => w.includes('startup_timeout_sec'))).toBe(true);
    // And the server it sat on is still imported — one unreadable key is not fatal.
    expect(scanned.changes.some(c => c.kind === 'mcp' && c.name === 'futureshape')).toBe(true);
  });

  it('changes nothing for a user with no codex setup at all', async () => {
    // The negative control on the same rig: the whole codex reader must be
    // invisible when `~/.codex` is absent.
    const withoutCodex = await plan();
    expect(withoutCodex.warnings.some(w => w.toLowerCase().includes('codex'))).toBe(false);
    expect(withoutCodex.changes.filter(c => c.kind === 'mcp').map(c => c.name)).toEqual(['filesystem', 'remote']);
    expect(withoutCodex.changes.find(c => c.kind === 'instruction')?.name).toBe('CLAUDE.md');
  });
});


// ---------------------------------------------------------------------------
// P6.1051 — `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_PROJECT_DIR_NAME`, together
// ---------------------------------------------------------------------------

/**
 * The pairing, from both sides.
 *
 * `sessions.md#name-the-project-directory-yourself` makes the two one rule:
 * *"Claude Code ignores `CLAUDE_CODE_PROJECT_DIR_NAME` when `CLAUDE_CONFIG_DIR`
 * is unset"*. So the positive case needs BOTH variables, and the boundaries are
 * the ways a name can be set and still ignored — unpaired, outranked, or a value
 * the page's own shape rule refuses.
 *
 * ## Where the environment may be read, and where it may not
 *
 * `resolveDirs` reads `CLAUDE_CONFIG_DIR` only when NO `claudeDir` and NO
 * `homeDir` were passed — an explicit answer outranks an ambient one, the same
 * precedence and the same reason as `resolveCodexDir`. The env-driven cases below
 * therefore pass neither, and pass `claudeJsonPath` and `codexDir` instead so the
 * run cannot reach the developer's real `~/.claude.json` or `~/.codex`. The
 * unpaired cases pass `homeDir` at a temp directory, which is both a safe root
 * and a contract of its own.
 *
 * **The one arm that is NOT covered, and why it is a residue rather than an
 * omission:** `CLAUDE_CONFIG_DIR` unset AND no `homeDir` resolves to
 * `join(homedir(), '.claude')`, i.e. the developer's own setup, and it cannot be
 * redirected from inside the process — on Bun 1.3.14 `os.homedir()` ignores a
 * mid-process `process.env.HOME = x` and keeps the launch value (measured here
 * 2026-09-11, with both controls: the same assignment moves it under node, and
 * `HOME=… bun` moves it under bun; the same latch `config/__tests__/home-latch.test.ts`
 * records for P3.143). A test written that way passes vacuously against the real
 * home. The uncovered code is one default; covering it needs a child process with
 * `HOME` in its launch env, which is more rig than the line is worth.
 */
describe('P6.1051 · the project directory name is honoured only alongside the config dir', () => {
  let env: { home: string; configDir: string; ws: string; codexDir: string; claudeJsonPath: string };
  let previousConfigDir: string | undefined;
  let previousProjectDirName: string | undefined;

  const setEnv = (name: 'CLAUDE_CONFIG_DIR' | 'CLAUDE_CODE_PROJECT_DIR_NAME', value: string | undefined): void => {
    // `delete` before every assignment and on the restore path: in Bun 1.3.14 a
    // plain assignment can leave the name invisible to a spread (AGENTS.md §Traps).
    delete process.env[name];
    if (value !== undefined) process.env[name] = value;
  };

  /** Seed `<root>/projects/<name>/memory/MEMORY.md` with an identifying body. */
  const seedProject = (root: string, name: string, body: string): void => {
    const dir = join(root, 'projects', name, 'memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), body, 'utf-8');
  };

  /** The documented derivation: the working directory path, non-alphanumerics -> `-`. */
  const derivedName = (): string => env.ws.replace(/[^a-zA-Z0-9]/g, '-');

  /** The env-driven read: no `claudeDir`, no `homeDir`, both other seams closed. */
  const fromEnv = () => computeClaudeSetupImportPlan({
    workspaceRootPath: env.ws,
    claudeJsonPath: env.claudeJsonPath,
    codexDir: env.codexDir,
  });

  /** The explicit read: a named home, which outranks whatever the env says. */
  const fromHome = () => computeClaudeSetupImportPlan({
    workspaceRootPath: env.ws,
    homeDir: env.home,
    claudeJsonPath: env.claudeJsonPath,
    codexDir: env.codexDir,
  });

  const memoryNames = (plan: { changes: ClaudeImportChange[] }): string[] =>
    plan.changes.filter(c => c.kind === 'memory').map(c => c.name);

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'claude-import-pair-home-'));
    const configDir = join(home, 'tenant-a');
    mkdirSync(configDir, { recursive: true });
    // The instruction file proves the ROOT moved: it is read straight off the
    // config dir, so an importer still looking at `<home>/.claude` finds none.
    writeFileSync(join(configDir, 'CLAUDE.md'), '# Tenant A\n\nBe brief.\n', 'utf-8');
    mkdirSync(join(home, '.claude'), { recursive: true });
    env = {
      home,
      configDir,
      ws: mkdtempSync(join(tmpdir(), 'claude-import-pair-ws-')),
      codexDir: join(home, '.codex'),
      claudeJsonPath: join(home, '.claude.json'),
    };
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    previousProjectDirName = process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
  });

  afterEach(() => {
    setEnv('CLAUDE_CONFIG_DIR', previousConfigDir);
    setEnv('CLAUDE_CODE_PROJECT_DIR_NAME', previousProjectDirName);
    rmSync(env.home, { recursive: true, force: true });
    rmSync(env.ws, { recursive: true, force: true });
  });

  it('reads the moved config dir, and the pinned project directory under it', async () => {
    setEnv('CLAUDE_CONFIG_DIR', env.configDir);
    setEnv('CLAUDE_CODE_PROJECT_DIR_NAME', 'work');
    // Both directories exist, which is the page's own case: a launch WITHOUT the
    // name writes the derived one, and "the sessions stored under your name stay
    // on disk". The pinned name decides, and there is no fall-back to the other.
    seedProject(env.configDir, 'work', '# Memory Index\n\npinned\n');
    seedProject(env.configDir, derivedName(), '# Memory Index\n\nderived\n');

    const scanned = await fromEnv();
    // The root moved: the instruction block comes from the config dir. Without
    // this the memory assertion alone could not tell a moved root from a lucky
    // directory name.
    expect(scanned.changes.find(c => c.kind === 'instruction')?.name).toBe('CLAUDE.md');
    expect(memoryNames(scanned)).toEqual(['MEMORY.md']);

    await applyClaudeSetupImportPlan({
      workspaceRootPath: env.ws,
      claudeJsonPath: env.claudeJsonPath,
      codexDir: env.codexDir,
    });
    const imported = readFileSync(getProjectMemoryFilePath(env.ws), 'utf-8');
    expect(imported).toContain('pinned');
    expect(imported).not.toContain('derived');
  });

  it('falls back to the derived name when the pair is broken or the value is refused', async () => {
    // Every arm seeds BOTH directories under the root it reads, so "the derived
    // one was chosen" is a choice and not the only thing present.
    seedProject(join(env.home, '.claude'), 'work', '# Memory Index\n\npinned-home\n');
    seedProject(join(env.home, '.claude'), derivedName(), '# Memory Index\n\nderived-home\n');
    seedProject(env.configDir, 'work', '# Memory Index\n\npinned\n');
    seedProject(env.configDir, derivedName(), '# Memory Index\n\nderived\n');

    // UNPAIRED — the name alone. `CLAUDE_CONFIG_DIR` is unset, so the page says
    // the name is ignored, and the derived directory is what is read.
    setEnv('CLAUDE_CONFIG_DIR', undefined);
    setEnv('CLAUDE_CODE_PROJECT_DIR_NAME', 'work');
    expect(memoryNames(await fromHome())).toEqual(['MEMORY.md']);
    await applyClaudeSetupImportPlan({
      workspaceRootPath: env.ws,
      homeDir: env.home,
      claudeJsonPath: env.claudeJsonPath,
      codexDir: env.codexDir,
    });
    expect(readFileSync(getProjectMemoryFilePath(env.ws), 'utf-8')).toContain('derived-home');

    // OUTRANKED — both variables set, but the caller named a home. An explicit
    // answer wins over the ambient pair, or the same call would read a different
    // directory on different machines.
    setEnv('CLAUDE_CONFIG_DIR', env.configDir);
    const outranked = await fromHome();
    expect(memoryNames(outranked)).toEqual(['MEMORY.md']);
    expect(outranked.changes.some(c => c.kind === 'instruction')).toBe(false);

    // REFUSED — paired through the environment, but the value is one the page
    // says is ignored. A Windows device name…
    setEnv('CLAUDE_CODE_PROJECT_DIR_NAME', 'con');
    expect(memoryNames(await fromEnv())).toEqual(['MEMORY.md']);
    // …a character outside "letters, digits, hyphens, or underscores"…
    setEnv('CLAUDE_CODE_PROJECT_DIR_NAME', 'has/slash');
    expect(memoryNames(await fromEnv())).toEqual(['MEMORY.md']);
    // …and one character over the documented 64.
    setEnv('CLAUDE_CODE_PROJECT_DIR_NAME', 'x'.repeat(65));
    const tooLong = await fromEnv();
    expect(memoryNames(tooLong)).toEqual(['MEMORY.md']);
    // The root still moved on every refused arm — the NAME is ignored, not the
    // pair, which is the distinction the fall-back has to get right.
    expect(tooLong.changes.find(c => c.kind === 'instruction')?.name).toBe('CLAUDE.md');

    // POSITIVE CONTROL on the identical instrument: 64 characters is inside the
    // rule, so the validator that refused three values honours this one. Without
    // it, a validator that refused everything would pass every line above.
    const longest = 'x'.repeat(64);
    setEnv('CLAUDE_CODE_PROJECT_DIR_NAME', longest);
    seedProject(env.configDir, longest, '# Memory Index\n\nlongest\n');
    expect(memoryNames(await fromEnv())).toEqual(['MEMORY.md']);
    rmSync(join(env.ws, 'MEMORY.md'), { force: true });
    await applyClaudeSetupImportPlan({
      workspaceRootPath: env.ws,
      claudeJsonPath: env.claudeJsonPath,
      codexDir: env.codexDir,
    });
    expect(readFileSync(getProjectMemoryFilePath(env.ws), 'utf-8')).toContain('longest');
  });
});
