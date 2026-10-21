/**
 * P1 fixture-hygiene checks for the frozen workspace/project contract corpus.
 * Behavioral RED/GREEN for each frozen rule lives in its owning phase (P2-P6);
 * these tests only prove the corpus itself is well-formed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { isValidProjectKey, resolveProjectIdentity } from '../project-identity.ts';
import {
  buildContractCorpus,
  COLLIDING_SKILL_SLUG,
  CONTRACT_EXPECTATIONS,
  IDENTITY_INDEPENDENCE,
  INERT_LEGACY_PROJECT_DIR,
  type ContractCorpus,
} from './workspace-project-contracts.fixture.ts';

let corpus: ContractCorpus;

beforeAll(() => {
  corpus = buildContractCorpus();
});

afterAll(() => {
  corpus.cleanup();
});

function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

describe('workspace project contract corpus', () => {
  it('fixture builds the two-workspace, two-project layout with canonical .nessy-agent content', () => {
    const { a1, a2 } = corpus.projects;
    for (const relative of [
      'config.toml',
      join('skills', COLLIDING_SKILL_SLUG, 'SKILL.md'),
      join('agents', 'helper.md'),
      join('commands', 'build.md'),
      join('rules', 'style.md'),
      'mcp.json',
      'hooks.json',
      'permissions.json',
      'MEMORY.md',
    ]) {
      expect(existsSync(join(a1.nessyAgentDir, relative))).toBe(true);
    }
    for (const relative of ['AGENTS.md', 'MEMORY.md', '.mcp.json', join('.agents', 'rules', 'portable.md'), join('.agents', 'commands', 'portable.md')]) {
      expect(existsSync(join(a1.root, relative))).toBe(true);
    }
    expect(existsSync(join(a2.root, 'AGENTS.md'))).toBe(true);
    expect(existsSync(a2.nessyAgentDir)).toBe(false);
    expect(existsSync(corpus.workspaces.a.rootPath)).toBe(true);
    expect(existsSync(corpus.workspaces.b.rootPath)).toBe(true);
  });

  it('fixture places the colliding skill slug at global, workspace, project-native and portable scope', () => {
    const skillFile = join('skills', COLLIDING_SKILL_SLUG, 'SKILL.md');
    expect(existsSync(join(corpus.configDir, skillFile))).toBe(true);
    expect(existsSync(join(corpus.workspaces.a.rootPath, skillFile))).toBe(true);
    expect(existsSync(join(corpus.workspaces.b.rootPath, skillFile))).toBe(true);
    expect(existsSync(join(corpus.projects.a1.nessyAgentDir, skillFile))).toBe(true);
    expect(existsSync(join(corpus.projects.a1.root, '.agents', skillFile))).toBe(true);
  });

  it('fixture keeps a populated inert .nessy directory beside the canonical namespace', () => {
    const inert = corpus.projects.a1.inertNessyDir;
    expect(inert.endsWith(sep + INERT_LEGACY_PROJECT_DIR)).toBe(true);
    for (const relative of ['config.toml', 'hooks.json', join('agents', 'legacy.md'), join('commands', 'legacy.md')]) {
      expect(existsSync(join(inert, relative))).toBe(true);
    }
    const legacyRule = CONTRACT_EXPECTATIONS.find(rule => rule.id === 'legacy-nessy-inert');
    expect(legacyRule?.owner).toBe('P2');
  });

  it('fixture symlink escapes resolve outside the project root', () => {
    const { a1 } = corpus.projects;
    const projectRealRoot = realpathSync(a1.root);
    expect(a1.symlinkEscapes.length).toBeGreaterThan(0);
    for (const link of a1.symlinkEscapes) {
      const target = realpathSync(link);
      expect(isInside(link, a1.root)).toBe(true);
      expect(isInside(target, projectRealRoot)).toBe(false);
    }
  });

  it('fixture outside-root candidate is outside every workspace and project root', () => {
    const candidate = realpathSync(corpus.outsideRootCandidate);
    const roots = [
      corpus.configDir,
      corpus.workspaces.a.rootPath,
      corpus.workspaces.b.rootPath,
      corpus.projects.a1.root,
      corpus.projects.a2.root,
    ].map(root => realpathSync(root));
    for (const root of roots) {
      expect(isInside(candidate, root)).toBe(false);
    }
  });

  it('fixture project identities are stable, path-free and workspace-independent', async () => {
    const first = await resolveProjectIdentity(corpus.projects.a1.root);
    const second = await resolveProjectIdentity(corpus.projects.a1.root);
    const other = await resolveProjectIdentity(corpus.projects.a2.root);
    expect(first.persistence).toBe('stable');
    expect(isValidProjectKey(first.projectKey)).toBe(true);
    expect(second.projectKey).toBe(first.projectKey);
    expect(second.identityFingerprint).toBe(first.identityFingerprint);
    expect(other.projectKey).not.toBe(first.projectKey);
    expect(first.projectKey.includes(sep)).toBe(false);
  });

  it('contract corpus expectations are frozen, unique and owned by implementation phases', () => {
    expect(Object.isFrozen(CONTRACT_EXPECTATIONS)).toBe(true);
    const ids = CONTRACT_EXPECTATIONS.map(rule => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of CONTRACT_EXPECTATIONS) {
      expect(Object.isFrozen(rule)).toBe(true);
      expect(rule.owner).toMatch(/^P[2-6]$/);
      expect(rule.rule.length).toBeGreaterThan(0);
    }
    expect(Object.isFrozen(IDENTITY_INDEPENDENCE)).toBe(true);
    expect(new Set(IDENTITY_INDEPENDENCE.workspaceIds).size).toBe(2);
  });
});
