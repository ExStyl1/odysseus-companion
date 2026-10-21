/**
 * P2.449 — the administrator-owned skill tier reaches the CATALOG, not just the
 * agent-side loader.
 *
 * ## The defect this closes, stated as what a user saw
 *
 * P6.8 taught `skills/storage.ts:loadAllSkills` to read the machine-wide,
 * administrator-provisioned skill roots on all three runtimes. The list the user
 * actually looks at is not built from that function — it is built from
 * `native-sources.ts` — and its skill roots did not include them. So an
 * administrator skill loaded, was invocable by the model, and OUTRANKED the
 * user's own same-slug skill, while appearing nowhere the user could find it.
 * P2.439's *Managed by your administrator* sentence was written against a row
 * that could not exist.
 *
 * ## What is asserted here, and why each one is not redundant
 *
 * - The tier reaches the inventory at `builtin` scope, with a workspace skill in
 *   the SAME run as the positive control that the rig reads records at all.
 * - `adminSkillsDirs: []` reproduces the HEAD behaviour exactly — zero. That is
 *   the negative control the absence claim needs, and it is also the seam every
 *   other test in this package uses to stay machine-independent.
 * - The record is `mutable: false`. Revealing is not granting: the row is
 *   visible and still un-deletable, which is the state the label names.
 * - The OPERATOR's off switch is the environment variable read inside
 *   `getAdminAgentSkillsDirs`, so one lever turns the tier off for BOTH loaders.
 *   Asserted through the DEFAULT path (no `adminSkillsDirs` argument), because
 *   that is the only path an operator actually has.
 * - Two roots holding the same slug produce two distinct keys, and no key
 *   carries an absolute path — keys are projected to the renderer.
 * - The administrator's own per-skill invocation controls survive into the
 *   record. This is the ground the posture decision rests on: adding the roots
 *   does not hand the user an unconditional invoke, it hands them what the
 *   administrator's frontmatter allows.
 * - End to end through the resolver, the safe summary carries the exact three
 *   fields the renderer branches on (`origin`, `scope.kind`, `readOnly`), which
 *   is the strongest available proof that P2.439's branch can now fire without
 *   reaching into a renderer file.
 *
 * ## Vocabulary
 *
 * This tier is never called *system*. codex's `SkillScope::System` is the cache
 * codex preinstalls into the user's OWN home; the machine-wide administrator one
 * is `SkillScope::Admin` (P6.8, measured at `openai/codex` `rust-v0.148.0`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildNativeCapabilityInventory } from '../native-sources.ts';
import { createCapabilityResolver, type CapabilityContext } from '../resolver.ts';
import { toUserCatalog } from '../views.ts';
import { ADMIN_SKILLS_DIR_ENV, getAdminAgentSkillsDirs } from '../../skills/storage.ts';
import type { NativeCapabilitySourceRecord, WorkspacePolicyContext } from '../types.ts';

const roots: string[] = [];
let savedAdminEnv: string | undefined;

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function writeSkill(skillsDir: string, slug: string, frontmatter: string[] = []): void {
  const dir = join(skillsDir, slug);
  mkdirSync(dir, { recursive: true });
  const lines = ['---', `name: ${slug}`, `description: ${slug} skill`, ...frontmatter, '---', 'Body'];
  writeFileSync(join(dir, 'SKILL.md'), lines.join('\n'));
}

interface Rig {
  workspaceRoot: string;
  configDir: string;
  homeSkills: string;
  adminDir: string;
  context: WorkspacePolicyContext;
}

function makeRig(): Rig {
  const workspaceRoot = tmp('admin-tier-ws-');
  const configDir = tmp('admin-tier-cfg-');
  const homeSkills = tmp('admin-tier-home-');
  const adminDir = tmp('admin-tier-managed-');
  // The positive control: an ordinary workspace skill in every run below. If the
  // rig stopped reading skills at all, this is what would notice.
  writeSkill(join(workspaceRoot, 'skills'), 'ws-control');
  return {
    workspaceRoot,
    configDir,
    homeSkills,
    adminDir,
    context: {
      workspaceId: 'ws-admin-tier',
      workspaceRootPath: workspaceRoot,
      projectTrustState: 'none',
      projectTrustRevision: '',
    },
  };
}

function inventory(rig: Rig, adminSkillsDirs?: readonly string[]): NativeCapabilitySourceRecord[] {
  return buildNativeCapabilityInventory(rig.context, {
    configDir: rig.configDir,
    homeAgentsSkillsDir: rig.homeSkills,
    instructionExcludes: [],
    nestedSkillRoots: [],
    // No argument means the DEFAULT path — the machine's own administrator
    // roots, which is the only path an OPERATOR can reach and therefore the only
    // one the off-switch case below can assert. Since P2.461 the field is
    // REQUIRED, so that default is now spelled HERE rather than inside the
    // builder: this file is the one rig in the tree that wants it, and it says
    // so. `getAdminAgentSkillsDirs` reads `NESSY_ADMIN_SKILLS_DIR` on every
    // call, so the env-driven cases below are unchanged.
    adminSkillsDirs: adminSkillsDirs ?? getAdminAgentSkillsDirs(),
  }).records;
}

const adminSkillsIn = (records: NativeCapabilitySourceRecord[]) =>
  records.filter(r => r.kind === 'skill' && r.scope.kind === 'builtin');

beforeEach(() => {
  savedAdminEnv = process.env[ADMIN_SKILLS_DIR_ENV];
});

afterEach(() => {
  // `delete` first, then assign: assigning over an existing name in Bun 1.3.14
  // can leave it readable by property and invisible to a spread, and every
  // subprocess env in this tree is built by spreading `process.env`.
  delete process.env[ADMIN_SKILLS_DIR_ENV];
  if (savedAdminEnv !== undefined) process.env[ADMIN_SKILLS_DIR_ENV] = savedAdminEnv;
  while (roots.length) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('administrator-owned skills reach the capability catalog (P2.449)', () => {
  it('emits an administrator skill at builtin scope, alongside the workspace control', () => {
    const rig = makeRig();
    writeSkill(rig.adminDir, 'org-policy');

    const records = inventory(rig, [rig.adminDir]);

    // Positive control on the same run: the rig really does read skills.
    expect(records.some(r => r.kind === 'skill' && r.logicalName === 'ws-control')).toBe(true);

    const admin = adminSkillsIn(records);
    expect(admin.map(r => r.logicalName)).toEqual(['org-policy']);
    expect(admin[0]!.sourcePath).toBe(join(rig.adminDir, 'org-policy'));
  });

  it('emits nothing for an empty root list — the pre-P2.449 behaviour, pinned', () => {
    const rig = makeRig();
    writeSkill(rig.adminDir, 'org-policy');

    const records = inventory(rig, []);

    expect(adminSkillsIn(records)).toEqual([]);
    // The control still fires, so this is an absence of the admin tier and not
    // an absence of the whole inventory.
    expect(records.some(r => r.kind === 'skill' && r.logicalName === 'ws-control')).toBe(true);
  });

  it('marks the record immutable — revealed, and still not deletable from the app', () => {
    const rig = makeRig();
    writeSkill(rig.adminDir, 'org-policy');

    const admin = adminSkillsIn(inventory(rig, [rig.adminDir]));
    expect(admin[0]!.mutable).toBe(false);

    // Negative control in the same run: an ordinary skill stays mutable, so
    // `false` above is this tier's own stamp and not a global default.
    const workspace = inventory(rig, [rig.adminDir])
      .find(r => r.kind === 'skill' && r.logicalName === 'ws-control');
    expect(workspace!.mutable).toBe(true);
  });

  it('reads the same roots the agent-side loader does, through the operator off switch', () => {
    const rig = makeRig();
    writeSkill(rig.adminDir, 'org-policy');

    // No `adminSkillsDirs` argument: this is the DEFAULT path, the only one an
    // operator can reach, and it goes through `getAdminAgentSkillsDirs` — the
    // one function `loadAllSkills` also calls.
    delete process.env[ADMIN_SKILLS_DIR_ENV];
    process.env[ADMIN_SKILLS_DIR_ENV] = rig.adminDir;
    expect(adminSkillsIn(inventory(rig)).map(r => r.logicalName)).toEqual(['org-policy']);

    // The off switch turns the tier off for the catalog exactly as it does for
    // the loader — one lever, not two.
    delete process.env[ADMIN_SKILLS_DIR_ENV];
    process.env[ADMIN_SKILLS_DIR_ENV] = '';
    expect(adminSkillsIn(inventory(rig))).toEqual([]);
  });

  it('keeps two roots addressable separately and puts no absolute path in a key', () => {
    const rig = makeRig();
    const secondRoot = tmp('admin-tier-managed2-');
    writeSkill(rig.adminDir, 'org-policy');
    writeSkill(secondRoot, 'org-policy');

    const admin = adminSkillsIn(inventory(rig, [rig.adminDir, secondRoot]));
    expect(admin).toHaveLength(2);
    expect(new Set(admin.map(r => r.key)).size).toBe(2);
    for (const record of admin) {
      expect(record.key).not.toContain(rig.adminDir);
      expect(record.key).not.toContain(secondRoot);
      // Guard the shape rather than the two fixture paths only: nothing in a
      // key may look like an absolute path.
      expect(record.key.includes('/')).toBe(false);
    }
  });

  it("carries the administrator's own invocation controls into the record", () => {
    const rig = makeRig();
    writeSkill(rig.adminDir, 'org-locked', ['user-invocable: false', 'disable-model-invocation: true']);
    writeSkill(rig.adminDir, 'org-open');

    const admin = adminSkillsIn(inventory(rig, [rig.adminDir]));
    const locked = admin.find(r => r.logicalName === 'org-locked')!;
    expect(locked.skillUserInvocable).toBe(false);
    expect(locked.skillDisableModelInvocation).toBe(true);

    // Negative control: a skill that declares neither carries neither, so the
    // two values above came from the frontmatter and not from the tier.
    const open = admin.find(r => r.logicalName === 'org-open')!;
    expect(open.skillUserInvocable).toBeUndefined();
    expect(open.skillDisableModelInvocation).toBeUndefined();
  });
});

describe('the renderer branch P2.439 wrote can now fire (P2.449)', () => {
  const CONTEXT: CapabilityContext = {
    workspaceId: 'ws-admin-tier',
    sessionId: 'sess-admin-tier',
    projectTrustState: 'trusted',
    projectTrustRevision: 'trust-r1',
  };

  it('projects the three fields the skills list branches on', async () => {
    const rig = makeRig();
    writeSkill(rig.adminDir, 'org-policy');

    const resolver = createCapabilityResolver({
      inputs: () => ({
        nativeInventory: { records: inventory(rig, [rig.adminDir]), blockedLayers: [] },
        installedPlugins: [],
        activePluginInstances: {},
        pluginCandidates: [],
        resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
        resolveTrust: () => 'trusted',
      }),
    });
    const snapshot = await resolver.resolve(CONTEXT);
    try {
      const catalog = toUserCatalog(snapshot);
      const admin = catalog.capabilities.find(
        c => c.kind === 'skill' && c.logicalName === 'org-policy',
      );
      expect(admin).toBeDefined();
      // `skillOwnerLabelKey` gates on `origin === 'plugin'` FIRST and only then
      // switches on `scope.kind`. A `builtin`-scoped record projects
      // `origin: 'builtin'` (`resolver.ts`: `scope.kind === 'builtin' ?
      // 'builtin' : 'native'`) — not `'plugin'`, so it reaches the switch and
      // lands on the administrator arm. Asserted as the two facts the branch
      // actually reads, rather than as the `'native'` a reader might assume.
      expect(admin!.origin).not.toBe('plugin');
      expect(admin!.origin).toBe('builtin');
      expect(admin!.scope.kind).toBe('builtin');
      // `canDelete = origin === 'native' && scope.kind === 'workspace' &&
      // !readOnly` — false on all three counts here, which is the point: the row
      // is visible and the Delete item stays disabled, so the label it carries
      // is the sentence the user needs.
      expect(admin!.readOnly).toBe(true);
      // The row is a real, usable catalog entry rather than a greyed placeholder
      // — `isComposerSelectableSkillRow` requires `state === 'active'`, and the
      // posture decision this row took says an administrator skill IS selectable
      // unless the administrator's own frontmatter says otherwise.
      expect(admin!.state).toBe('active');

      // The control the branch's other arms already had: a workspace skill still
      // reports the scope that makes it deletable, so `builtin` above is this
      // tier's answer and not the catalog's default.
      const control = catalog.capabilities.find(
        c => c.kind === 'skill' && c.logicalName === 'ws-control',
      );
      expect(control!.scope.kind).toBe('workspace');
      expect(control!.readOnly).toBe(false);
    } finally {
      resolver.releaseSnapshot(snapshot.leaseId);
    }
  });

  it('lets an administrator skill take the bare name from a personal one', async () => {
    const rig = makeRig();
    // Same slug in the administrator root and in the user's own personal root.
    writeSkill(rig.adminDir, 'deploy');
    writeSkill(rig.homeSkills, 'deploy');

    const resolver = createCapabilityResolver({
      inputs: () => ({
        nativeInventory: { records: inventory(rig, [rig.adminDir]), blockedLayers: [] },
        installedPlugins: [],
        activePluginInstances: {},
        pluginCandidates: [],
        resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
        resolveTrust: () => 'trusted',
      }),
    });
    const snapshot = await resolver.resolve(CONTEXT);
    try {
      const deploys = snapshot.entries.filter(
        e => e.summary.kind === 'skill' && e.summary.logicalName === 'deploy',
      );
      // Both retained — the catalog records provenance, it does not delete.
      expect(deploys).toHaveLength(2);
      const winner = deploys.find(e => e.summary.selectedAsUnqualifiedAlias);
      // `skills.md:122` — "enterprise overrides personal" — and the same order
      // `loadAllSkills` resolves, so the two loaders agree on the same tier.
      expect(winner!.summary.scope.kind).toBe('builtin');
    } finally {
      resolver.releaseSnapshot(snapshot.leaseId);
    }
  });
});
