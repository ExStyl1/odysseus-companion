/**
 * F1.1085 (origin DN-038, 2026-09-26) — the host's copy of a trusted project's `.claude/agents` (F1.730, the one Pi
 * and codex read; Claude loads the folder itself, F1.1178) read only `<cwd>/.claude/agents`, one level. Claude Code
 * walks further — `sub-agents.md#choose-the-subagent-scope`: "Project subagents are discovered by walking up from
 * the current working directory, so every `.claude/agents/` between there and the repository root is scanned. When
 * more than one of these nested directories defines the same `name`, Claude Code uses the definition closest to the
 * working directory." and "Claude Code scans `.claude/agents/` and `~/.claude/agents/` recursively". The copy now
 * walks the same way, bounded by the trusted project root (the root every other project layer of the inventory
 * stays inside).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { buildNativeCapabilityInventory, isClaudeProjectAgentCopyKey } from '../native-sources.ts';
import type { WorkspacePolicyContext } from '../types.ts';

const roots: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function agentFile(dir: string, name: string, body = 'x'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: d\n---\n${body}`);
}

function inventory(workingDirectory: string, projectRoot: string) {
  const configDir = tmp('cpa-config-');
  const workspaceRoot = tmp('cpa-ws-');
  const ctx: WorkspacePolicyContext = {
    workspaceId: 'ws-uuid-1',
    workspaceRootPath: workspaceRoot,
    projectTrustState: 'trusted',
    projectTrustRevision: '',
    workingDirectory,
    projectRoot,
    projectKey: 'p_' + '8'.repeat(32),
  } as WorkspacePolicyContext;
  const env = { configDir, homeAgentsSkillsDir: tmp('cpa-home-skills-'), adminSkillsDirs: [] as string[] };
  return buildNativeCapabilityInventory(ctx, env).records
    .filter(r => r.kind === 'agent' && r.scope.kind === 'project');
}

describe('F1.1085 · the host copy of .claude/agents walks the folders Claude Code walks', () => {
  it('reads every .claude/agents from the working directory up to the project root, nearest first', () => {
    const project = tmp('cpa-proj-');
    const cwd = join(project, 'packages', 'app');
    agentFile(join(project, '.claude', 'agents'), 'root-only');
    agentFile(join(project, '.claude', 'agents'), 'both', 'root');
    agentFile(join(project, 'packages', '.claude', 'agents'), 'middle-only');
    agentFile(join(cwd, '.claude', 'agents'), 'both', 'near');
    const agents = inventory(cwd, project);
    expect(agents.map(r => r.logicalName).sort()).toEqual(['both', 'both', 'middle-only', 'root-only']);
    expect(agents.every(r => isClaudeProjectAgentCopyKey(r.key))).toBe(true);
    // The resolver breaks a same-scope, same-tier tie on the lexical key (`resolver.ts`, `sortByPreferenceDesc`),
    // so the nearest file's key must sort first — Claude Code's "closest to the working directory" rule.
    const both = agents.filter(r => r.logicalName === 'both').sort((a, b) => (a.key < b.key ? -1 : 1));
    expect(both[0]!.sourcePath).toBe(join(cwd, '.claude', 'agents', 'both.md'));
  });

  it('reads subfolders of .claude/agents, as Claude Code does', () => {
    const project = tmp('cpa-sub-');
    agentFile(join(project, '.claude', 'agents', 'review'), 'security');
    agentFile(join(project, '.claude', 'agents'), 'top');
    expect(inventory(project, project).map(r => r.logicalName).sort()).toEqual(['security', 'top']);
  });

  it('CONTROL: a folder above the project root is never read', () => {
    const outer = tmp('cpa-outer-');
    const project = join(outer, 'proj');
    agentFile(join(outer, '.claude', 'agents'), 'outside');
    agentFile(join(project, '.claude', 'agents'), 'inside');
    expect(inventory(project, project).map(r => r.logicalName)).toEqual(['inside']);
  });
});
