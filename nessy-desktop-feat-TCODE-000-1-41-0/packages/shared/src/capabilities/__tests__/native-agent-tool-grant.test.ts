/**
 * P6.551 — a FILE-based agent whose tool grant codex drops must not read
 * `active` in the catalog.
 *
 * P6.129 closed the PLUGIN half: `buildCodexAgentRoles` denies a role that
 * declares a tool grant — codex has no per-role tool policy — and
 * `formatCodexAgentRoleDropDiagnostics` tells the user the definition "cannot be
 * spawned in this session", while the catalog said `active` about the same
 * definition. The native half was left open on a stated premise: *"the resolver
 * never opens the file"*.
 *
 * **That premise is refuted.** `pinnedAgentMetadata` (`native-sources.ts`) has
 * parsed the frontmatter with `matter()` since it was written, for
 * `description`. So the seam the row weighed — a per-session verdict carried
 * back into the capability layer, which would first have had to answer what
 * `active` means for a definition denied on one session and live on another —
 * was never needed: the grant is a property of the FILE.
 *
 * Two seams, pinned together for `native-agent-description.test.ts`'s reason:
 * the record (`native-sources.ts`, the only place that opens the file) and the
 * gate (`resolver.ts`, which has no filesystem access at all). Fixing one
 * without the other is silent.
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

/** Five agent files: four shapes of a declaration and one control with none. */
function fixture(): readonly NativeCapabilitySourceRecord[] {
  const configDir = mkdtempSync(join(tmpdir(), 'p6551-config-'));
  const homeSkills = mkdtempSync(join(tmpdir(), 'p6551-home-'));
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'p6551-ws-'));
  roots.push(configDir, homeSkills, workspaceRoot);
  mkdirSync(join(configDir, 'agents'), { recursive: true });

  const write = (name: string, frontmatter: string) =>
    writeFileSync(join(configDir, 'agents', `${name}.md`), `---\nname: ${name}\n${frontmatter}---\nBody`);

  // The comma-separated spelling `sub-agents.md` uses.
  write('listed', 'tools: Read, Grep\n');
  // The array spelling.
  write('arrayed', 'tools: [Read, Grep]\n');
  // A grant of NOTHING. The writer's condition is truthiness, and the
  // materializer turns this into `[]`, so codex refuses the role rather than
  // silently widening it to the session's whole surface.
  write('empty', 'tools: []\n');
  // The hyphenated second key, which `materializePiRuntimeAgentDefinitions`
  // accepts alongside `disallowedTools` — a reader that took only one spelling
  // would let the other read `active`.
  write('denied', 'disallowed-tools: Bash\n');
  // The control: no grant at all. It must stay `active` on every runtime.
  write('plain', '');

  const policy: WorkspacePolicyContext = {
    workspaceId: 'ws-1',
    workspaceRootPath: workspaceRoot,
    projectTrustState: 'none',
    projectTrustRevision: '',
  };
  return buildNativeCapabilityInventory(policy, {
    configDir,
    homeAgentsSkillsDir: homeSkills,
    adminSkillsDirs: [],
  }).records;
}

function agentRecord(records: readonly NativeCapabilitySourceRecord[], name: string): NativeCapabilitySourceRecord {
  const record = records.find(r => r.kind === 'agent' && r.logicalName === name);
  expect(record, `no agent record for ${name}`).toBeDefined();
  return record!;
}

async function stateOf(
  record: NativeCapabilitySourceRecord,
  provider: CapabilityContext['provider'],
): Promise<string | undefined> {
  const resolver = createCapabilityResolver({
    inputs: () => ({
      nativeInventory: { records: [record], blockedLayers: [] },
      installedPlugins: [],
      activePluginInstances: {},
      pluginCandidates: [],
      resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
      resolveTrust: () => 'trusted',
    }),
  });
  const snapshot = await resolver.resolve({ ...CONTEXT, ...(provider ? { provider } : {}) });
  const entry = snapshot.entries.find(e => e.summary.key === record.key);
  const state = entry?.summary.unavailableReason ?? (entry ? 'active' : undefined);
  resolver.releaseSnapshot(snapshot.leaseId);
  return state;
}

describe('P6.551 — a native agent declaring a tool grant on codex', () => {
  it('stamps the declaration onto the record, in every documented spelling', () => {
    const records = fixture();
    for (const name of ['listed', 'arrayed', 'empty', 'denied']) {
      expect(agentRecord(records, name).agentDeclaresToolGrant, `${name} not stamped`).toBe(true);
    }
    // Omitted rather than `false`, so the capability generation does not move
    // for every agent file the first time this is read.
    expect(agentRecord(records, 'plain').agentDeclaresToolGrant).toBeUndefined();
  });

  it('reads `unsupported-runtime` on codex, and stays active where the grant can be expressed', async () => {
    const records = fixture();
    for (const name of ['listed', 'arrayed', 'empty', 'denied']) {
      expect(await stateOf(agentRecord(records, name), 'codex-runtime'), `${name} not refused on codex`)
        .toBe('unsupported-runtime');
      // The runtime axis: the refusal is codex's, not a global narrowing of
      // every agent that declares tools.
      expect(await stateOf(agentRecord(records, name), 'pi'), `${name} refused on pi`).toBe('active');
      expect(await stateOf(agentRecord(records, name), 'anthropic'), `${name} refused on claude`).toBe('active');
    }
    // The control, on the runtime that refuses: the gate is about the GRANT.
    expect(await stateOf(agentRecord(records, 'plain'), 'codex-runtime')).toBe('active');
  });
});
