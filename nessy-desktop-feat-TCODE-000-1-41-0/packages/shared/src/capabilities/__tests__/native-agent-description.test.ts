/**
 * P6.602 — a native `agents/*.md` agent's frontmatter `description` reaches the
 * runtime binding the SDK is built from.
 *
 * `sub-agents.md` § *Supported frontmatter fields*: "Only `name` and
 * `description` are required", and the `description` row reads "When Claude
 * should delegate to this subagent". Before this row the host read nothing out
 * of the file but its hash, so the resolver handed every native agent
 * `description: ''` and `claude-runtime-agents.ts` substituted
 * `Imported <name> agent.` — the same contentless sentence for every agent in
 * the workspace, which is the one field the model matches a task against.
 *
 * Two seams, pinned together on purpose: the record (`native-sources.ts`, which
 * is the only place that opens the file) and the binding (`resolver.ts`, which
 * has no filesystem access at all). Fixing one without the other is silent.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';

import { buildNativeCapabilityInventory } from '../native-sources.ts';
import { createCapabilityResolver, type CapabilityContext } from '../resolver.ts';
import type { NativeCapabilitySourceRecord, WorkspacePolicyContext } from '../types.ts';

const roots: string[] = [];

afterEach(() => {
  while (roots.length) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const CONTEXT: CapabilityContext = {
  workspaceId: 'ws-1',
  sessionId: 'sess-1',
  projectKey: 'p_00000000000000000000000000000000',
  projectTrustState: 'trusted',
  projectTrustRevision: 'trust-r1',
};

/** Global config dir + workspace root carrying two agent definitions. */
function fixture(): { records: readonly NativeCapabilitySourceRecord[] } {
  const configDir = mkdtempSync(join(tmpdir(), 'p6602-config-'));
  const homeSkills = mkdtempSync(join(tmpdir(), 'p6602-home-'));
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'p6602-ws-'));
  roots.push(configDir, homeSkills, workspaceRoot);

  mkdirSync(join(configDir, 'agents'), { recursive: true });
  writeFileSync(
    join(configDir, 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: Reviews code for quality and best practices\n---\nBody',
  );
  // The negative control: a definition that declares no `description` at all.
  writeFileSync(join(configDir, 'agents', 'plain.md'), '---\nname: plain\n---\nBody');

  const policy: WorkspacePolicyContext = {
    workspaceId: 'ws-1',
    workspaceRootPath: workspaceRoot,
    projectTrustState: 'none',
    projectTrustRevision: '',
  };
  const { records } = buildNativeCapabilityInventory(policy, {
    configDir,
    homeAgentsSkillsDir: homeSkills,
    adminSkillsDirs: [],
  });
  return { records };
}

function agentRecord(records: readonly NativeCapabilitySourceRecord[], name: string): NativeCapabilitySourceRecord {
  const record = records.find(r => r.kind === 'agent' && r.logicalName === name);
  expect(record).toBeDefined();
  return record!;
}

describe('P6.602 — native agent frontmatter description', () => {
  it('pins a declared description onto the record and carries it into the runtime binding', async () => {
    const { records } = fixture();
    const declared = agentRecord(records, 'reviewer');
    expect(declared.description).toBe('Reviews code for quality and best practices');

    const resolver = createCapabilityResolver({
      inputs: () => ({
        nativeInventory: { records: [declared], blockedLayers: [] },
        installedPlugins: [],
        activePluginInstances: {},
        pluginCandidates: [],
        resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
        resolveTrust: () => 'trusted',
      }),
    });
    const snapshot = await resolver.resolve(CONTEXT);
    const entry = snapshot.entries.find(e => e.summary.key === declared.key)!;
    expect(entry.runtimeBinding.kind).toBe('agent');
    if (entry.runtimeBinding.kind === 'agent') {
      expect(entry.runtimeBinding.agent.description).toBe('Reviews code for quality and best practices');
    }
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('leaves a definition that declares none on the old empty-string path', async () => {
    const { records } = fixture();
    const plain = agentRecord(records, 'plain');
    expect(plain.description).toBeUndefined();

    const resolver = createCapabilityResolver({
      inputs: () => ({
        nativeInventory: { records: [plain], blockedLayers: [] },
        installedPlugins: [],
        activePluginInstances: {},
        pluginCandidates: [],
        resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
        resolveTrust: () => 'trusted',
      }),
    });
    const snapshot = await resolver.resolve(CONTEXT);
    const entry = snapshot.entries.find(e => e.summary.key === plain.key)!;
    // P6.661 — the discriminator, asserted unconditionally, exactly as the case
    // above does it. Without this line a binding that stopped being an `agent`
    // would DELETE the assertion below instead of failing it, and the case would
    // stay green while checking nothing.
    expect(entry.runtimeBinding.kind).toBe('agent');
    if (entry.runtimeBinding.kind === 'agent') {
      // `claude-runtime-agents.ts` substitutes `Imported <name> agent.` for this
      // one, which is the documented-required field simply being absent — not
      // the host dropping a declared value.
      expect(entry.runtimeBinding.agent.description).toBe('');
    }
    resolver.releaseSnapshot(snapshot.leaseId);
  });
});
