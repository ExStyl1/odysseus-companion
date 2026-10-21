/**
 * R79 — skills discovered BELOW the working directory, and their qualified name.
 *
 * `skills.md:124` whole: "Skills also load from nested `.claude/skills/`
 * directories below your working directory. When Claude reads or edits a file in
 * a subdirectory, skills from that subdirectory's `.claude/skills/` become
 * available. This lets a monorepo package provide its own skills that apply when
 * working on that package, even if the session started at the repo root."
 * `:154`: those skills "aren't loaded at startup. They load the first time Claude
 * reads or edits a file inside that subdirectory, and stay available for the rest
 * of the session."
 *
 * `:126`: "If a nested skill shares a name with another skill, both stay
 * available." `:128`: "The nested one appears under a directory-qualified name,
 * `apps/web:deploy`." `:132`: "Typing `/deploy` runs the project-root skill. Type
 * the qualified name `/apps/web:deploy` to run the nested variant explicitly."
 *
 * The directory names are this fork's (`.agents/skills`, `.nessy-agent/skills`);
 * `.claude/skills` is read at no level, which is a separate rebrand gap.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  MAX_NESTED_SKILL_ROOTS,
  MAX_NESTED_SKILL_ROOT_KEYS,
  MAX_NESTED_SKILL_SCAN_DEPTH,
  buildNativeCapabilityInventory,
  clearNestedSkillRoots,
  discoverNestedSkillRoots,
  nestedSkillRootRegistryKey,
  nestedSkillRootsFor,
  registerNestedSkillRoots,
} from '../native-sources.ts';
import {
  createCapabilityResolver,
  type CapabilityContext,
  type CapabilityResolutionInputs,
} from '../resolver.ts';
import { toAgentRuntime } from '../views.ts';
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

function writeSkill(dir: string, slug: string, body: string): void {
  mkdirSync(join(dir, slug), { recursive: true });
  writeFileSync(join(dir, slug, 'SKILL.md'), `---\nname: ${slug}\ndescription: ${body}\n---\n\n${body}\n`);
}

/**
 * A monorepo: `deploy` at the project root, `deploy` again inside `apps/web`,
 * and a file under `apps/web` to touch. Exactly `skills.md:126`'s example.
 */
function monorepo(): { project: string; trigger: string } {
  const project = tmp('nested-skill-proj-');
  writeSkill(join(project, '.agents', 'skills'), 'deploy', 'root deploy');
  mkdirSync(join(project, 'apps', 'web', 'src'), { recursive: true });
  writeSkill(join(project, 'apps', 'web', '.agents', 'skills'), 'deploy', 'web deploy');
  writeFileSync(join(project, 'apps', 'web', 'src', 'x.ts'), 'export const x = 1;');
  return { project, trigger: join(project, 'apps', 'web', 'src', 'x.ts') };
}

function context(project: string): WorkspacePolicyContext {
  return {
    workspaceId: 'ws',
    workspaceRootPath: tmp('nested-skill-ws-'),
    projectTrustState: 'trusted',
    projectTrustRevision: '1',
    projectRoot: project,
    workingDirectory: project,
    projectKey: 'pk' as WorkspacePolicyContext['projectKey'],
  };
}

function inventory(
  project: string,
  over: Partial<Parameters<typeof buildNativeCapabilityInventory>[1]> = {},
  ctx: WorkspacePolicyContext = context(project),
): NativeCapabilitySourceRecord[] {
  return buildNativeCapabilityInventory(ctx, {
    configDir: tmp('nested-skill-cfg-'),
    homeAgentsSkillsDir: tmp('nested-skill-home-'),
    instructionExcludes: [],
    // P2.455 — pinned OFF: the administrator tier's DEFAULT roots are absolute
    // machine-wide directories, so an unpinned rig reads the REAL ones on a
    // centrally managed host and a fixture everywhere else. `[]` means "no
    // administrator tier"; the standing guard is `admin-skills-dirs-pinned.test.ts`.
    adminSkillsDirs: [],
    ...over,
  }).records.filter(record => record.kind === 'skill');
}

describe('the eager inventory never reaches below the working directory', () => {
  it('records the root skill and not the package one', () => {
    const { project } = monorepo();
    const skills = inventory(project);
    expect(skills.map(record => record.sourcePath))
      .toContain(join(project, '.agents', 'skills', 'deploy'));
    // `skills.md:154` — a nested skill is not loaded at startup.
    expect(skills.map(record => record.sourcePath))
      .not.toContain(join(project, 'apps', 'web', '.agents', 'skills', 'deploy'));
  });
});

describe('discoverNestedSkillRoots', () => {
  it('returns the package directory once a file under it is touched', () => {
    const { project, trigger } = monorepo();
    expect(discoverNestedSkillRoots(trigger, project)).toEqual([
      { directory: join(project, 'apps', 'web'), qualifier: 'apps/web' },
    ]);
  });

  it('finds the nessy-native layer too', () => {
    const project = tmp('nested-skill-na-');
    mkdirSync(join(project, 'apps', 'api'), { recursive: true });
    writeSkill(join(project, 'apps', 'api', '.nessy-agent', 'skills'), 'seed', 'api seed');
    expect(discoverNestedSkillRoots(join(project, 'apps', 'api', 'main.ts'), project)
      .map(root => root.qualifier)).toEqual(['apps/api']);
  });

  it('returns every owning directory between the file and the cwd, outermost first', () => {
    const { project, trigger } = monorepo();
    writeSkill(join(project, 'apps', '.agents', 'skills'), 'apps-wide', 'apps layer');
    writeSkill(join(project, 'apps', 'web', 'src', '.agents', 'skills'), 'srcish', 'src layer');
    expect(discoverNestedSkillRoots(trigger, project).map(root => root.qualifier))
      .toEqual(['apps', 'apps/web', 'apps/web/src']);
  });

  it('ignores a directory that owns no skills directory at all', () => {
    const project = tmp('nested-skill-empty-');
    mkdirSync(join(project, 'apps', 'web'), { recursive: true });
    writeFileSync(join(project, 'apps', 'web', 'x.ts'), 'x');
    expect(discoverNestedSkillRoots(join(project, 'apps', 'web', 'x.ts'), project)).toEqual([]);
  });

  it('never returns the working directory\'s own skills, which load eagerly', () => {
    const { project } = monorepo();
    writeFileSync(join(project, 'top.ts'), 'x');
    expect(discoverNestedSkillRoots(join(project, 'top.ts'), project)).toEqual([]);
  });

  it('returns nothing for a file outside the working directory', () => {
    const { project } = monorepo();
    const outside = tmp('nested-skill-outside-');
    writeSkill(join(outside, '.agents', 'skills'), 'stranger', 'not ours');
    expect(discoverNestedSkillRoots(join(outside, 'x.ts'), project)).toEqual([]);
  });

  it('refuses vendored trees, and everything under them', () => {
    const project = tmp('nested-skill-vendor-');
    for (const vendored of ['node_modules', 'dist', '.git']) {
      mkdirSync(join(project, vendored, 'pkg'), { recursive: true });
      writeSkill(join(project, vendored, 'pkg', '.agents', 'skills'), 'evil', 'vendored');
      expect(discoverNestedSkillRoots(join(project, vendored, 'pkg', 'x.ts'), project)).toEqual([]);
    }
  });

  it('refuses a directory whose name would make the qualified form ambiguous', () => {
    const project = tmp('nested-skill-colon-');
    // `:` is the separator in `apps/web:deploy` AND inside the capability key.
    mkdirSync(join(project, 'a:b'), { recursive: true });
    writeSkill(join(project, 'a:b', '.agents', 'skills'), 'deploy', 'colon dir');
    expect(discoverNestedSkillRoots(join(project, 'a:b', 'x.ts'), project)).toEqual([]);
  });

  it('honours the accumulation cap, the caller\'s budget and the already-known set', () => {
    const project = tmp('nested-skill-deep-');
    let dir = project;
    for (let level = 0; level < MAX_NESTED_SKILL_ROOTS + 4; level += 1) {
      dir = join(dir, `level${level}`);
      writeSkill(join(dir, '.agents', 'skills'), `s${level}`, `level ${level}`);
    }
    const trigger = join(dir, 'x.ts');
    expect(discoverNestedSkillRoots(trigger, project)).toHaveLength(MAX_NESTED_SKILL_ROOTS);
    expect(discoverNestedSkillRoots(trigger, project, { limit: 2 })).toHaveLength(2);
    expect(discoverNestedSkillRoots(trigger, project, { limit: 0 })).toEqual([]);
    expect(discoverNestedSkillRoots(trigger, project, { alreadyKnown: new Set(['level0']) })
      .map(root => root.qualifier)).not.toContain('level0');
  });

  it('stops walking at the depth ceiling', () => {
    const project = tmp('nested-skill-depth-');
    let dir = project;
    for (let level = 0; level < MAX_NESTED_SKILL_SCAN_DEPTH + 3; level += 1) dir = join(dir, `d${level}`);
    mkdirSync(dir, { recursive: true });
    // The ONLY skills directory sits above the ceiling, counted from the file up.
    writeSkill(join(project, 'd0', '.agents', 'skills'), 'top', 'outermost');
    expect(discoverNestedSkillRoots(join(dir, 'x.ts'), project)).toEqual([]);
    // Positive control on the same rig: within the ceiling it IS found.
    expect(discoverNestedSkillRoots(join(project, 'd0', 'd1', 'x.ts'), project)
      .map(root => root.qualifier)).toEqual(['d0']);
  });
});

describe('the nested-root registry', () => {
  const key = nestedSkillRootRegistryKey({ workspaceId: 'ws', projectKey: 'pk', workingDirectory: '/w' });

  afterEach(() => clearNestedSkillRoots());

  it('reports only what was genuinely new, and caps a bucket', () => {
    expect(registerNestedSkillRoots(key, ['apps/web'])).toEqual(['apps/web']);
    expect(registerNestedSkillRoots(key, ['apps/web'])).toEqual([]);
    expect(registerNestedSkillRoots(key, ['apps/api', 'apps/web'])).toEqual(['apps/api']);
    expect(nestedSkillRootsFor(key)).toEqual(['apps/api', 'apps/web']);

    const overflow = Array.from({ length: MAX_NESTED_SKILL_ROOTS + 5 }, (_, i) => `pkg/p${i}`);
    registerNestedSkillRoots(key, overflow);
    expect(nestedSkillRootsFor(key)).toHaveLength(MAX_NESTED_SKILL_ROOTS);
  });

  it('evicts the oldest bucket rather than growing without bound', () => {
    for (let i = 0; i < MAX_NESTED_SKILL_ROOT_KEYS + 2; i += 1) {
      registerNestedSkillRoots(
        nestedSkillRootRegistryKey({ workspaceId: 'ws', workingDirectory: `/w${i}` }),
        ['apps/web'],
      );
    }
    expect(nestedSkillRootsFor(nestedSkillRootRegistryKey({ workspaceId: 'ws', workingDirectory: '/w0' })))
      .toEqual([]);
    expect(nestedSkillRootsFor(nestedSkillRootRegistryKey({
      workspaceId: 'ws',
      workingDirectory: `/w${MAX_NESTED_SKILL_ROOT_KEYS + 1}`,
    }))).toEqual(['apps/web']);
  });

  it('keys a different working directory into a different bucket', () => {
    registerNestedSkillRoots(key, ['apps/web']);
    expect(nestedSkillRootsFor(
      nestedSkillRootRegistryKey({ workspaceId: 'ws', projectKey: 'pk', workingDirectory: '/other' }),
    )).toEqual([]);
  });
});

describe('the inventory reads an activated nested root', () => {
  afterEach(() => clearNestedSkillRoots());

  it('emits the package skill with its owning directory and a distinct key', () => {
    const { project } = monorepo();
    const skills = inventory(project, { nestedSkillRoots: ['apps/web'] });
    const nested = skills.find(record => record.skillDirectoryQualifier === 'apps/web');
    expect(nested).toBeDefined();
    expect(nested!.logicalName).toBe('deploy');
    expect(nested!.sourcePath).toBe(join(project, 'apps', 'web', '.agents', 'skills', 'deploy'));
    // `:126` — "both stay available", under distinct qualified keys.
    expect(skills.filter(record => record.logicalName === 'deploy')).toHaveLength(2);
    expect(nested!.key).toContain('nested:apps/web');
    expect(nested!.key).not.toBe(skills.find(record => !record.skillDirectoryQualifier)!.key);
  });

  it('reads the process-local registry when no seam value is supplied', () => {
    // The producer/consumer key agreement, which is the one thing that cannot be
    // checked from either side alone: `BaseAgent` spells the key from its own
    // config, the inventory from the policy context.
    const { project } = monorepo();
    const ctx = context(project);
    expect(inventory(project, {}, ctx).some(record => record.skillDirectoryQualifier)).toBe(false);
    registerNestedSkillRoots(
      nestedSkillRootRegistryKey({
        workspaceId: ctx.workspaceId,
        projectKey: ctx.projectKey,
        workingDirectory: ctx.workingDirectory!,
      }),
      ['apps/web'],
    );
    expect(inventory(project, {}, ctx).map(record => record.skillDirectoryQualifier))
      .toContain('apps/web');
  });

  it('reads the nessy-native nested layer beside the portable one', () => {
    const { project } = monorepo();
    writeSkill(join(project, 'apps', 'web', '.nessy-agent', 'skills'), 'seed', 'native seed');
    const skills = inventory(project, { nestedSkillRoots: ['apps/web'] });
    expect(skills.find(record => record.logicalName === 'seed')).toMatchObject({
      skillDirectoryQualifier: 'apps/web',
      sourceTier: 'nessy',
    });
  });

  it('refuses a qualifier that escapes the working directory, and a symlinked escape', () => {
    const { project } = monorepo();
    const elsewhere = tmp('nested-skill-elsewhere-');
    writeSkill(join(elsewhere, '.agents', 'skills'), 'sneaky', 'outside the project');
    symlinkSync(elsewhere, join(project, 'apps', 'link'));

    const escaped = inventory(project, { nestedSkillRoots: ['../outside', 'apps/link'] });
    expect(escaped.map(record => record.logicalName)).not.toContain('sneaky');
    expect(escaped.some(record => record.skillDirectoryQualifier)).toBe(false);
  });

  it('contributes nothing when the project is not trusted', () => {
    const { project } = monorepo();
    const skills = inventory(project, { nestedSkillRoots: ['apps/web'] }, {
      ...context(project),
      projectTrustState: 'none',
    });
    expect(skills.some(record => record.skillDirectoryQualifier)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Alias policy — `skills.md:132`
// ---------------------------------------------------------------------------

const RESOLVER_CONTEXT: CapabilityContext = {
  workspaceId: 'ws-1',
  sessionId: 'sess-1',
  projectKey: 'p_00000000000000000000000000000000',
  projectTrustState: 'trusted',
  projectTrustRevision: 'trust-r1',
};

function skillRecord(
  over: Partial<NativeCapabilitySourceRecord> & Pick<NativeCapabilitySourceRecord, 'key' | 'logicalName'>,
): NativeCapabilitySourceRecord {
  return {
    kind: 'skill',
    scope: { kind: 'project', workspaceId: 'ws-1', projectKey: RESOLVER_CONTEXT.projectKey! },
    sourceTier: 'portable',
    sourcePath: `/abs/${over.key}`,
    revision: 'r1',
    contentHash: 'a'.repeat(64),
    mutable: true,
    ...over,
  };
}

function resolverInputs(records: NativeCapabilitySourceRecord[]): CapabilityResolutionInputs {
  return {
    nativeInventory: { records, blockedLayers: [] },
    installedPlugins: [],
    activePluginInstances: {},
    pluginCandidates: [],
    resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
    resolveTrust: () => 'trusted',
  };
}

describe('a nested skill never takes the bare name from the one that owns it', () => {
  it('leaves /deploy with the project-root variant and keeps both', async () => {
    // The DECISIVE pair, and it is decisive on purpose: a nested skill in
    // `apps/web/.nessy-agent/skills` carries the `nessy` tier, a root skill in
    // `<project>/.agents/skills` carries `portable`, and `tierRank` prefers
    // nessy. Without the nested term above it, the package's skill would take
    // `/deploy` from the repository root's — which is what `:132` forbids. The
    // same-tier pair below is the doc's literal example and cannot show this.
    const inputs = resolverInputs([
      skillRecord({ key: 'skill::project::d0::deploy', logicalName: 'deploy', sourceTier: 'portable' }),
      skillRecord({
        key: 'skill::project::nested-na:apps/web::deploy',
        logicalName: 'deploy',
        sourceTier: 'nessy',
        skillDirectoryQualifier: 'apps/web',
      }),
    ]);
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(RESOLVER_CONTEXT);
    const deploys = snapshot.entries.filter(e => e.summary.logicalName === 'deploy');
    // `:126` — "If a nested skill shares a name with another skill, both stay
    // available."
    expect(deploys).toHaveLength(2);
    const root = deploys.find(e => !e.summary.skillDirectoryQualifier)!;
    const nested = deploys.find(e => e.summary.skillDirectoryQualifier === 'apps/web')!;
    // `:132` — "Typing `/deploy` runs the project-root skill."
    expect(root.summary.selectedAsUnqualifiedAlias).toBe(true);
    expect(nested.summary.selectedAsUnqualifiedAlias).toBe(false);
    expect(nested.summary.enabled).toBe(true);
    // The handle the `/` menu, the listing and the invocation path all read.
    expect(toAgentRuntime(snapshot).skills.find(skill => skill.key === nested.summary.key))
      .toMatchObject({ directoryQualifier: 'apps/web' });
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('keeps /deploy with the root variant at the same tier too', async () => {
    // `:132`'s literal example, both variants in `.agents/skills`.
    const inputs = resolverInputs([
      skillRecord({ key: 'skill::project::d0::deploy', logicalName: 'deploy' }),
      skillRecord({
        key: 'skill::project::nested:apps/web::deploy',
        logicalName: 'deploy',
        skillDirectoryQualifier: 'apps/web',
      }),
    ]);
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(RESOLVER_CONTEXT);
    expect(snapshot.entries
      .filter(e => e.summary.logicalName === 'deploy')
      .find(e => e.summary.selectedAsUnqualifiedAlias)!.summary.key)
      .toBe('skill::project::d0::deploy');
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('loses the bare name to a GLOBAL skill of the same slug, as any project skill does', async () => {
    // The collision that has to keep working after the new rank term: the
    // personal-over-project inversion (`:122`) still decides first.
    const inputs = resolverInputs([
      skillRecord({ key: 'skill::global::deploy', logicalName: 'deploy', scope: { kind: 'global' } }),
      skillRecord({
        key: 'skill::project::nested:apps/web::deploy',
        logicalName: 'deploy',
        skillDirectoryQualifier: 'apps/web',
      }),
    ]);
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(RESOLVER_CONTEXT);
    const winner = snapshot.entries
      .filter(e => e.summary.logicalName === 'deploy')
      .find(e => e.summary.selectedAsUnqualifiedAlias)!;
    expect(winner.summary.key).toBe('skill::global::deploy');
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('still gives an UNCONTESTED nested skill its own short name', async () => {
    // `:126`/`:128` describe a CLASH. A lone nested skill is the only member of
    // its bucket, exactly like an uncontested bundled or plugin skill.
    const inputs = resolverInputs([
      skillRecord({
        key: 'skill::project::nested:apps/web::lonely',
        logicalName: 'lonely',
        skillDirectoryQualifier: 'apps/web',
      }),
    ]);
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(RESOLVER_CONTEXT);
    expect(snapshot.entries.find(e => e.summary.logicalName === 'lonely')!
      .summary.selectedAsUnqualifiedAlias).toBe(true);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('does not reorder a non-skill kind', async () => {
    // The rank term sits on a tuple `applyCollisionPolicy` uses for EVERY kind;
    // nothing but a skill can carry the qualifier, so nothing else may move.
    const inputs = resolverInputs([
      skillRecord({ key: 'agent::project::d0::helper', kind: 'agent', logicalName: 'helper' }),
      skillRecord({ key: 'agent::global::helper', kind: 'agent', logicalName: 'helper', scope: { kind: 'global' } }),
    ]);
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(RESOLVER_CONTEXT);
    // Subagents keep nearest-scope precedence (`features-overview.md:193`).
    expect(snapshot.entries.filter(e => e.summary.kind === 'agent')
      .find(e => e.summary.selectedAsUnqualifiedAlias)!.summary.key)
      .toBe('agent::project::d0::helper');
    resolver.releaseSnapshot(snapshot.leaseId);
  });
});
