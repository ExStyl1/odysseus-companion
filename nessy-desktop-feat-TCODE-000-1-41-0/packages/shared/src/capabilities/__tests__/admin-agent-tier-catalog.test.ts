/**
 * P6.239 (denominator B20) — the administrator's SUBAGENTS exist, and one of
 * them takes the bare name from a same-named project subagent.
 *
 * ## The defect this closes, stated as what an administrator could not do
 *
 * `sub-agents.md` § *Choose the subagent scope* ranks "Managed settings"
 * **1 (highest)** in its scope table and says it again in prose: "**Managed
 * subagents** are deployed by organization administrators. Place markdown files
 * in `.claude/agents/` inside the managed settings directory, using the same
 * frontmatter format as project and user subagents. Managed definitions take
 * precedence over project and user subagents with the same name."
 *
 * `native-sources.ts` called `markdownAgentRecords` at global, workspace and
 * project scope and never at the managed one, so an administrator could ship no
 * subagent at all. Worse, the rank underneath it was INVERTED:
 * `aliasScopeRank` sent every non-skill kind to `scopeSpecificity`, which puts
 * `builtin` at **0**, the lowest — so a managed subagent emitted on its own
 * would have appeared in the inventory and LOST its bare name to a project one,
 * which is worse than absent. That is why the row demanded the emit and the rank
 * "together or neither", and why the two assertions below are in one file.
 *
 * ## What each case is for
 *
 * - The contest is the row's own `done_means`: an admin-root `critic.md` beats
 *   an identically-named project `critic.md` on the unqualified alias.
 * - The absence case is the negative control the emit claim needs — no managed
 *   root, nothing at `builtin` — with the project agent still present in the
 *   same run, so it is an absence of the TIER and not of the inventory.
 * - `mutable: false` with a mutable project agent beside it: revealing is not
 *   granting.
 * - The trust refusal, because the guard is the reason this tier can be read at
 *   all. It is applied per FILE: `managedFileTrustVerdict` demands `isFile()`,
 *   so a directory handed to it returns `untrusted` and would disable the tier
 *   on every machine while reading like a check that passes.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildNativeCapabilityInventory } from '../native-sources.ts';
import {
  createCapabilityResolver,
  type CapabilityContext,
  type CapabilityResolutionInputs,
  type InstalledPluginInput,
} from '../resolver.ts';
import type { PluginProjectionCandidate } from '../../plugins/projection-candidates.ts';
import { NESSY_AGENT_PROJECT_DIR } from '../../projects/nessy-agent-layout.ts';
import type { NativeCapabilitySourceRecord, WorkspacePolicyContext } from '../types.ts';

const roots: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function writeAgent(dir: string, name: string, description: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  writeFileSync(path, ['---', `name: ${name}`, `description: ${description}`, '---', 'Body'].join('\n'));
  return path;
}

interface Rig {
  workspaceRoot: string;
  configDir: string;
  systemDir: string;
  managedAgentsDir: string;
  projectAgentsDir: string;
  context: WorkspacePolicyContext;
}

function makeRig(): Rig {
  const workspaceRoot = tmp('admin-agent-ws-');
  const configDir = tmp('admin-agent-cfg-');
  const systemDir = tmp('admin-agent-system-');
  const managedAgentsDir = join(systemDir, 'agents');
  const projectAgentsDir = join(workspaceRoot, NESSY_AGENT_PROJECT_DIR, 'agents');
  // The positive control present in every run below: an ordinary PROJECT
  // subagent. If the rig stopped reading agent markdown at all, this is what
  // would notice, and it is also the loser of the contest.
  writeAgent(projectAgentsDir, 'critic', 'the project critic');
  return {
    workspaceRoot,
    configDir,
    systemDir,
    managedAgentsDir,
    projectAgentsDir,
    context: {
      workspaceId: 'ws-admin-agent-tier',
      workspaceRootPath: workspaceRoot,
      workingDirectory: workspaceRoot,
      projectRoot: workspaceRoot,
      projectKey: 'proj-admin-agent-tier' as WorkspacePolicyContext['projectKey'],
      projectTrustState: 'trusted',
      projectTrustRevision: 'trust-r1',
    },
  };
}

/** `systemDir: undefined` is the "this machine has no managed root" arm. */
function inventory(rig: Rig, withSystemDir = true): NativeCapabilitySourceRecord[] {
  return buildNativeCapabilityInventory(rig.context, {
    configDir: rig.configDir,
    homeAgentsSkillsDir: join(rig.configDir, 'home-skills'),
    instructionExcludes: [],
    nestedSkillRoots: [],
    // The neighbouring managed tier is deliberately EMPTY here: this row's tier
    // must not depend on the administrator SKILLS roots being populated.
    adminSkillsDirs: [],
    ...(withSystemDir ? { systemDir: rig.systemDir } : {}),
  }).records;
}

const agentsAt = (records: NativeCapabilitySourceRecord[], scope: string) =>
  records.filter(r => r.kind === 'agent' && r.scope.kind === scope);

const CONTEXT: CapabilityContext = {
  workspaceId: 'ws-admin-agent-tier',
  sessionId: 'sess-admin-agent-tier',
  projectTrustState: 'trusted',
  projectTrustRevision: 'trust-r1',
};

async function resolveWith(records: NativeCapabilitySourceRecord[]) {
  const resolver = createCapabilityResolver({
    inputs: () => ({
      nativeInventory: { records, blockedLayers: [] },
      installedPlugins: [],
      activePluginInstances: {},
      pluginCandidates: [],
      resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
      resolveTrust: () => 'trusted' as const,
    }),
  });
  const snapshot = await resolver.resolve(CONTEXT);
  return { snapshot, release: () => resolver.releaseSnapshot(snapshot.leaseId) };
}

afterEach(() => {
  while (roots.length) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('the administrator subagent tier reaches the inventory (P6.239 B20)', () => {
  it('emits a managed-root subagent at builtin scope, beside the project control', () => {
    const rig = makeRig();
    writeAgent(rig.managedAgentsDir, 'org-reviewer', 'the organization reviewer');

    const records = inventory(rig);

    // Positive control on the same run: the rig really does read subagents.
    expect(agentsAt(records, 'project').map(r => r.logicalName)).toEqual(['critic']);

    const managed = agentsAt(records, 'builtin');
    expect(managed.map(r => r.logicalName)).toEqual(['org-reviewer']);
    expect(managed[0]!.sourcePath).toBe(join(rig.managedAgentsDir, 'org-reviewer.md'));
  });

  it('emits nothing on a machine with no managed root — the pre-P6.239 behaviour, pinned', () => {
    const rig = makeRig();
    writeAgent(rig.managedAgentsDir, 'org-reviewer', 'the organization reviewer');

    const records = inventory(rig, false);

    expect(agentsAt(records, 'builtin')).toEqual([]);
    // The control still fires, so this is an absence of the managed TIER and
    // not an absence of the whole inventory.
    expect(agentsAt(records, 'project').map(r => r.logicalName)).toEqual(['critic']);
  });

  it('marks the record immutable — revealed, and still not deletable from the app', () => {
    const rig = makeRig();
    writeAgent(rig.managedAgentsDir, 'org-reviewer', 'the organization reviewer');

    const records = inventory(rig);
    expect(agentsAt(records, 'builtin')[0]!.mutable).toBe(false);
    // Negative control in the same run: an ordinary subagent stays mutable, so
    // `false` above is this tier's own stamp and not a global default.
    expect(agentsAt(records, 'project')[0]!.mutable).toBe(true);
  });

  it('withholds a managed subagent from a directory another account can write', () => {
    const rig = makeRig();
    writeAgent(rig.managedAgentsDir, 'org-reviewer', 'the organization reviewer');
    // Control: it loads while the directory is host-owned.
    expect(agentsAt(inventory(rig), 'builtin')).toHaveLength(1);

    chmodSync(rig.managedAgentsDir, 0o777);
    try {
      expect(agentsAt(inventory(rig), 'builtin')).toEqual([]);
      // Same run: the project tier is untouched, so the withholding is this
      // guard's and not a collapsed inventory.
      expect(agentsAt(inventory(rig), 'project')).toHaveLength(1);
    } finally {
      chmodSync(rig.managedAgentsDir, 0o700);
    }
  });
});

describe('a managed subagent outranks a same-named project one (P6.239 B20)', () => {
  it('takes the bare name from the project subagent', async () => {
    const rig = makeRig();
    // Same bare name in the administrator root and in the project's own root.
    writeAgent(rig.managedAgentsDir, 'critic', 'the organization critic');

    const { snapshot, release } = await resolveWith(inventory(rig));
    try {
      const critics = snapshot.entries.filter(
        e => e.summary.kind === 'agent' && e.summary.logicalName === 'critic',
      );
      // Both retained — the catalog records provenance, it does not delete.
      expect(critics).toHaveLength(2);
      const winner = critics.find(e => e.summary.selectedAsUnqualifiedAlias);
      // `sub-agents.md` § *Choose the subagent scope*: "Managed definitions take
      // precedence over project and user subagents with the same name."
      expect(winner!.summary.scope.kind).toBe('builtin');
    } finally {
      release();
    }
  });

  it('leaves the project subagent on the bare name when no managed one claims it', async () => {
    const rig = makeRig();
    // A managed subagent under a DIFFERENT name: the tier is populated, so this
    // is a contest the project agent wins on merit rather than on emptiness.
    writeAgent(rig.managedAgentsDir, 'org-reviewer', 'the organization reviewer');

    const { snapshot, release } = await resolveWith(inventory(rig));
    try {
      const critic = snapshot.entries.find(
        e => e.summary.kind === 'agent' && e.summary.logicalName === 'critic',
      );
      expect(critic!.summary.selectedAsUnqualifiedAlias).toBe(true);
      expect(critic!.summary.scope.kind).toBe('project');
    } finally {
      release();
    }
  });
});

/**
 * P6.631 — the OTHER end of the same chain, and the same defect one kind along.
 *
 * `features-overview.md` § *Understand how features layer*, verbatim: "**Skills
 * and subagents** override by name: when the same name exists at multiple
 * levels, one definition wins based on priority (managed > user > project for
 * skills; managed > CLI flag > project > user > plugin for subagents)." A plugin
 * subagent is LAST in that chain — below every authored level.
 *
 * P6.239 fixed the head of it. The tail was still `scopeSpecificity`: an agent
 * of `origin: 'plugin'` was ranked by its SCOPE like any other non-skill kind,
 * and `storage-runtime.ts:selectedCapabilityScope` projects a plugin capability
 * at `project` scope whenever the context has a project — so a plugin subagent
 * took rank 3 and a user subagent of the same name took 1, and the plugin won
 * the bare name the page ranks it last for. That is the exact defect P2.449
 * closed for plugin SKILLS, which is why the fix is the same shape (rank −1) and
 * this case is its contest.
 *
 * The plugin agent is UNCONTESTED in its own right — rank −1 still wins a bucket
 * with one member — so a plugin subagent nobody else names keeps its short name.
 */
describe('a plugin subagent ranks below a user subagent (P6.631)', () => {
  const PLUGIN_INSTANCE = 'plugin://m/p@1.0.0#' + 'c'.repeat(64);

  /**
   * Same fixture shapes as `plugin-builtin-collision.integration.test.ts` — the
   * source file exports no test-fixture helpers, so they are written out rather
   * than imported.
   */
  function pluginAgentInputs(
    rig: Rig,
    records: NativeCapabilitySourceRecord[],
  ): CapabilityResolutionInputs {
    const installed: InstalledPluginInput = {
      pluginInstanceId: PLUGIN_INSTANCE,
      pluginKey: 'pk-631',
      marketplaceId: 'm',
      pluginId: 'p',
      version: '1.0.0',
      bundleHash: 'c'.repeat(64),
      cacheRef: { marketplaceId: 'm', pluginId: 'p', version: '1.0.0', bundleHash: 'c'.repeat(64) },
      manifest: { schemaVersion: 1, kind: 'plugin', id: 'p', name: 'Plugin P', version: '1.0.0', capabilities: [] },
      origin: { source: 'marketplace', resolvedAt: 0 },
      installedAt: 1000,
      diagnostics: [],
    } as unknown as InstalledPluginInput;
    const candidate: PluginProjectionCandidate = {
      pluginKey: 'pk-631',
      pluginInstanceId: PLUGIN_INSTANCE,
      // What `storage-runtime.ts:selectedCapabilityScope` hands a plugin
      // capability whenever the context has a project — the projection that
      // made this contest winnable at all.
      selectedScope: {
        kind: 'project',
        workspaceId: CONTEXT.workspaceId,
        projectKey: rig.context.projectKey!,
      },
      trust: { required: false },
      key: 'plug:agent:sentry',
      capabilityId: 'sentry',
      kind: 'agent',
      logicalName: 'sentry',
      runtimeDefinition: { id: 'sentry', kind: 'agent', agent: { name: 'sentry', path: 'agents/sentry.md' } },
    } as unknown as PluginProjectionCandidate;
    return {
      nativeInventory: { records, blockedLayers: [] },
      installedPlugins: [installed],
      activePluginInstances: { 'pk-631': PLUGIN_INSTANCE },
      pluginCandidates: [candidate],
      resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
      resolveTrust: () => 'trusted' as const,
    } as unknown as CapabilityResolutionInputs;
  }

  async function resolveWithPlugin(rig: Rig, records: NativeCapabilitySourceRecord[]) {
    const resolver = createCapabilityResolver({ inputs: () => pluginAgentInputs(rig, records) });
    const snapshot = await resolver.resolve(CONTEXT);
    return { snapshot, release: () => resolver.releaseSnapshot(snapshot.leaseId) };
  }

  it('leaves the bare name with the user subagent when a plugin claims it too', async () => {
    const rig = makeRig();
    // The USER tier: `native-sources.ts` reads `<configDir>/agents` at global
    // scope, which is `features-overview.md`'s "user" level.
    writeAgent(join(rig.configDir, 'agents'), 'sentry', 'the personal sentry');

    const { snapshot, release } = await resolveWithPlugin(rig, inventory(rig));
    try {
      const sentries = snapshot.entries.filter(
        e => e.summary.kind === 'agent' && e.summary.logicalName === 'sentry',
      );
      // Both retained: this is a naming verdict, never a deletion.
      expect(sentries).toHaveLength(2);
      const winner = sentries.find(e => e.summary.selectedAsUnqualifiedAlias);
      expect(winner!.summary.origin).not.toBe('plugin');
      expect(winner!.summary.scope.kind).toBe('global');
      // The project control from `makeRig` is untouched in the same run, so the
      // verdict above is about rank and not about a collapsed inventory.
      expect(snapshot.entries.some(
        e => e.summary.kind === 'agent' && e.summary.logicalName === 'critic'
          && e.summary.selectedAsUnqualifiedAlias,
      )).toBe(true);
    } finally {
      release();
    }
  });

  it('keeps an UNCONTESTED plugin subagent on its short name', async () => {
    const rig = makeRig();
    // No user `sentry` this time: rank −1 is a tie-break, not a suppression.
    const { snapshot, release } = await resolveWithPlugin(rig, inventory(rig));
    try {
      const sentry = snapshot.entries.find(
        e => e.summary.kind === 'agent' && e.summary.logicalName === 'sentry',
      );
      expect(sentry!.summary.origin).toBe('plugin');
      expect(sentry!.summary.selectedAsUnqualifiedAlias).toBe(true);
    } finally {
      release();
    }
  });
});
