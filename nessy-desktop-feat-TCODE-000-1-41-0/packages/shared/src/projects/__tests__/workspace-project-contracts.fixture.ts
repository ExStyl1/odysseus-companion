/**
 * P1 frozen contract corpus for the project-local `.nessy-agent` and
 * workspace-roots plan (plan deleted at release 1.2.0; recover with
 * `git show 4d038f04^:docs/current-plans/project-local-nessy-agent-and-workspace-roots.md`).
 *
 * This module freezes the temp-layout corpus and the provider-neutral expected
 * behavior that P2-P6 implement. P1 ships fixture-hygiene checks only; each
 * behavioral RED/GREEN lives in the phase that implements its contract, so
 * this file must never import resolver/session/tool production seams.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Canonical Nessy project namespace (P2 production contract).
import { NESSY_AGENT_PROJECT_DIR } from '../nessy-agent-layout.ts';
/** Superseded project namespace: must stay behaviorally invisible after P2. */
export const INERT_LEGACY_PROJECT_DIR = '.nessy';

/** One capability name deliberately colliding across every scope. */
export const COLLIDING_SKILL_SLUG = 'demo-skill';

export interface ProjectFixture {
  /** Canonical project root (external to every managed root). */
  root: string;
  nessyAgentDir: string;
  inertNessyDir: string;
  /** Symlinks inside the project resolving OUTSIDE its root. */
  symlinkEscapes: string[];
}

export interface WorkspaceFixture {
  id: string;
  /** Managed workspace storage root under the fixture config dir. */
  rootPath: string;
}

export interface ContractCorpus {
  /** Temp root owning every path below. */
  baseDir: string;
  /** Fixture stand-in for `~/.nessy-agent` (global/user scope). */
  configDir: string;
  workspaces: { a: WorkspaceFixture; b: WorkspaceFixture };
  projects: { a1: ProjectFixture; a2: ProjectFixture };
  /** A real path outside every workspace and project root. */
  outsideRootCandidate: string;
  cleanup(): void;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function skillMd(scopeLabel: string): string {
  return `---\nname: ${COLLIDING_SKILL_SLUG}\ndescription: ${scopeLabel} copy of the colliding skill\n---\n\n${scopeLabel} body\n`;
}

/**
 * Build the frozen corpus layout:
 * - two managed Workspaces (a, b) under one fixture config dir;
 * - two external projects: a1 (full `.nessy-agent`, portable inputs, populated
 *   inert `.nessy`, symlink escapes) and a2 (plain);
 * - the same skill slug at global, workspace, project-native and portable scope;
 * - one outside-every-root candidate path.
 */
export function buildContractCorpus(): ContractCorpus {
  const baseDir = mkdtempSync(join(tmpdir(), 'nessy-project-contract-corpus-'));
  const configDir = join(baseDir, 'nessy-agent-home');
  const outsideDir = join(baseDir, 'outside');
  const outsideRootCandidate = join(outsideDir, 'notes.txt');
  write(outsideRootCandidate, 'outside every workspace and project root\n');

  // ── Global/user scope (fixture ~/.nessy-agent) ──────────────────────────
  write(join(configDir, 'skills', COLLIDING_SKILL_SLUG, 'SKILL.md'), skillMd('global'));
  write(join(configDir, 'agents', 'helper.md'), '# global helper agent\n');
  write(join(configDir, 'mcp.json'), '{"mcpServers":{}}\n');
  write(join(configDir, 'hooks.json'), '{"automations":{}}\n');
  write(join(configDir, 'MEMORY.md'), 'global memory\n');
  write(join(configDir, 'permissions', 'default.json'), '{}\n');

  // ── Managed workspaces ───────────────────────────────────────────────────
  const workspaces = {
    a: { id: 'ws-alpha', rootPath: join(configDir, 'workspaces', 'ws-alpha') },
    b: { id: 'ws-beta', rootPath: join(configDir, 'workspaces', 'ws-beta') },
  };
  for (const ws of [workspaces.a, workspaces.b]) {
    write(join(ws.rootPath, 'skills', COLLIDING_SKILL_SLUG, 'SKILL.md'), skillMd(`workspace-${ws.id}`));
    write(join(ws.rootPath, 'hooks.json'), '{"automations":{}}\n');
    write(join(ws.rootPath, 'permissions.json'), '{}\n');
  }

  // ── Project a1: full canonical + portable + inert legacy + escapes ──────
  const a1Root = join(baseDir, 'projects', 'a1');
  const a1Agent = join(a1Root, NESSY_AGENT_PROJECT_DIR);
  write(join(a1Agent, 'config.toml'), '[defaults]\nmodel = "corpus-model"\n');
  write(join(a1Agent, 'skills', COLLIDING_SKILL_SLUG, 'SKILL.md'), skillMd('project-native'));
  write(join(a1Agent, 'agents', 'helper.md'), '# project-native helper agent\n');
  write(join(a1Agent, 'commands', 'build.md'), 'project-native build command\n');
  write(join(a1Agent, 'rules', 'style.md'), 'project-native rule\n');
  write(join(a1Agent, 'mcp.json'), '{"mcpServers":{}}\n');
  write(join(a1Agent, 'hooks.json'), '{"automations":{}}\n');
  write(join(a1Agent, 'permissions.json'), '{}\n');
  write(join(a1Agent, 'MEMORY.md'), 'project-native memory\n');
  // Portable standards retained beside `.nessy-agent`.
  write(join(a1Root, 'AGENTS.md'), 'portable project instructions\n');
  write(join(a1Root, 'MEMORY.md'), 'portable project memory\n');
  write(join(a1Root, '.agents', 'skills', COLLIDING_SKILL_SLUG, 'SKILL.md'), skillMd('portable'));
  write(join(a1Root, '.agents', 'rules', 'portable.md'), 'portable rule\n');
  write(join(a1Root, '.agents', 'commands', 'portable.md'), 'portable command\n');
  write(join(a1Root, '.mcp.json'), '{"mcpServers":{}}\n');
  // Populated inert `.nessy`: must never load, never change generation.
  const a1Nessy = join(a1Root, INERT_LEGACY_PROJECT_DIR);
  write(join(a1Nessy, 'config.toml'), '[defaults]\nmodel = "must-never-load"\n');
  write(join(a1Nessy, 'hooks.json'), '{"automations":{"never":{"enabled":true}}}\n');
  write(join(a1Nessy, 'agents', 'legacy.md'), '# must never load\n');
  write(join(a1Nessy, 'commands', 'legacy.md'), 'must never load\n');
  // Symlink escapes: resolve outside the project root.
  const projectEscape = join(a1Root, 'link-outside');
  const nestedEscape = join(a1Agent, 'skills', 'escape-skill');
  symlinkSync(outsideDir, projectEscape, 'dir');
  symlinkSync(outsideDir, nestedEscape, 'dir');

  // ── Project a2: plain external project (outside-root approval target) ───
  const a2Root = join(baseDir, 'projects', 'a2');
  write(join(a2Root, 'AGENTS.md'), 'plain project instructions\n');

  return {
    baseDir,
    configDir,
    workspaces,
    projects: {
      a1: {
        root: a1Root,
        nessyAgentDir: a1Agent,
        inertNessyDir: a1Nessy,
        symlinkEscapes: [projectEscape, nestedEscape],
      },
      a2: {
        root: a2Root,
        nessyAgentDir: join(a2Root, NESSY_AGENT_PROJECT_DIR),
        inertNessyDir: join(a2Root, INERT_LEGACY_PROJECT_DIR),
        symlinkEscapes: [],
      },
    },
    outsideRootCandidate,
    cleanup: () => rmSync(baseDir, { recursive: true, force: true }),
  };
}

/**
 * Provider-neutral expected behavior frozen by P1. Each rule is implemented and
 * RED/GREEN-proven by its owning phase; no backend gets an independent variant.
 */
export const CONTRACT_EXPECTATIONS = Object.freeze([
  Object.freeze({
    id: 'project-primary-root',
    owner: 'P4',
    rule: 'The selected project canonical path is the session cwd and the one primary filesystem root; the managed Workspace root is the fallback only for no-project sessions.',
  }),
  Object.freeze({
    id: 'trust-gates-project-content',
    owner: 'P3',
    rule: 'No repository-owned content (nessy-agent or portable) loads before an explicit trusted ProjectKey revalidation.',
  }),
  Object.freeze({
    id: 'global-capabilities-preserved',
    owner: 'P3',
    rule: 'Global/user and Workspace capabilities remain available regardless of project trust state.',
  }),
  Object.freeze({
    id: 'nessy-agent-loads-after-trust',
    owner: 'P3',
    rule: 'A trusted project contributes .nessy-agent config, skills, agents, commands, rules, mcp.json, hooks, permissions and MEMORY.md with explicit source-tier precedence.',
  }),
  Object.freeze({
    id: 'legacy-nessy-inert',
    owner: 'P2',
    rule: 'A populated .nessy directory changes neither inventory, config, commands, hooks, generation nor diagnostics.',
  }),
  Object.freeze({
    id: 'outside-root-asks-once',
    owner: 'P4',
    rule: 'A path outside all session roots yields one structured approval request with read/write access and request/session lifetime; denial has no side effect.',
  }),
] as const);

/**
 * Identity independence frozen by P1: equal display paths or equal session ID
 * strings never merge policy/approval state across Workspaces. The composite
 * key (workspaceId, sessionId) and the scope tuple (workspaceId, projectKey)
 * are the only join keys.
 */
export const IDENTITY_INDEPENDENCE = Object.freeze({
  sharedSessionId: 's-shared',
  workspaceIds: Object.freeze(['ws-alpha', 'ws-beta'] as const),
});
