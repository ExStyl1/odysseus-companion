import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  CapabilityMaterializationError,
  createCapabilitySnapshotMaterializer,
} from '../materializer.ts';
import { computeNormalizedBundleHash } from '../../plugins/bundle-hash.ts';
import type {
  CapabilityResolver,
  EffectiveCapabilitySnapshot,
  NativeResourceRef,
} from '../resolver.ts';

const roots: string[] = [];

function tempFile(content: string): string {
  const root = mkdtempSync(join(tmpdir(), 'cap-materializer-'));
  roots.push(root);
  const path = join(root, 'config.json');
  writeFileSync(path, content);
  return path;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function snapshot(): EffectiveCapabilitySnapshot {
  return {
    context: {
      workspaceId: 'ws-1',
      sessionId: 's-1',
      projectTrustState: 'none',
      projectTrustRevision: '',
    },
    generation: 'generation-1',
    leaseId: 'lease-1',
    entries: [],
    installedPlugins: [],
    diagnostics: [],
  };
}

function resolver(active = true): CapabilityResolver {
  return {
    resolve: async () => snapshot(),
    releaseSnapshot() {},
    invalidate() {},
    isLeaseActive: () => active,
    referencedInstances: () => new Set(),
    leaseCount: () => active ? 1 : 0,
  };
}

function resource(path: string): NativeResourceRef {
  const content = readFileSync(path);
  return {
    source: 'workspace',
    scope: { kind: 'workspace', workspaceId: 'ws-1' },
    resourceId: 'source:workspace:github',
    absolutePath: path,
    revision: String(statSync(path).mtimeMs),
    contentHash: createHash('sha256').update(content).digest('hex'),
  };
}

describe('CapabilitySnapshotMaterializer', () => {
  it('reads only the revision/hash pinned native resource and fails stale after mutation', async () => {
    const path = tempFile('{"version":1}');
    const pinned = resource(path);
    let stale = 0;
    const materializer = createCapabilitySnapshotMaterializer(resolver(), snapshot(), {
      onStale: () => { stale += 1; },
    });

    expect(await materializer.readText(pinned)).toBe('{"version":1}');
    writeFileSync(path, '{"version":2,"changed":true}');
    await expect(materializer.readText(pinned)).rejects.toMatchObject({
      code: 'stale',
    } satisfies Partial<CapabilityMaterializationError>);
    expect(stale).toBe(1);
  });

  it('rejects a rotated or expired credential before returning secret bytes, as NOT-READY', () => {
    // The verdict is `credential-not-ready`, never `revoked`: a live lease whose
    // credential is merely unusable must not read as a dead snapshot. Sharing
    // one code is how an un-authorized plugin took down every send.

    const binding = {
      id: { type: 'source_bearer' as const, workspaceId: 'ws-1', sourceId: 'github' },
      expectedRevision: 1,
    };
    const rotated = createCapabilitySnapshotMaterializer(resolver(), snapshot(), {
      resolveCredential: () => ({ ready: true, revision: 2, value: 'new-secret' }),
    });
    expect(() => rotated.resolveCredential(binding)).toThrow('capability-snapshot-credential-not-ready');

    const expired = createCapabilitySnapshotMaterializer(resolver(), snapshot(), {
      resolveCredential: () => ({
        ready: true,
        revision: 1,
        value: 'expired-secret',
        credential: { value: 'expired-secret', expiresAt: Date.now() - 1 },
      }),
    });
    expect(() => expired.resolveCredential(binding)).toThrow('capability-snapshot-credential-not-ready');
  });

  it('names the revision the store reports now, so a consumer can tell a stale PIN from a dead record', () => {
    // The retry at the pool-materialization sites is built on this one fact:
    // `currentRevision !== expectedRevision` means a usable record exists at a
    // revision this snapshot never saw, and only then is looking again useful.
    const binding = {
      id: { type: 'source_bearer' as const, workspaceId: 'ws-1', sourceId: 'github' },
      expectedRevision: 1,
    };
    const rotated = createCapabilitySnapshotMaterializer(resolver(), snapshot(), {
      resolveCredential: () => ({ ready: false, revision: 2 }),
    });
    expect(() => rotated.resolveCredential(binding)).toThrow(
      expect.objectContaining({ code: 'credential-not-ready', currentRevision: 2 }),
    );

    // Absent: revision 0, which never matches a pinned revision, and there is
    // nothing to look again at.
    const absent = createCapabilitySnapshotMaterializer(resolver(), snapshot());
    expect(() => absent.resolveCredential(binding)).toThrow(
      expect.objectContaining({ code: 'credential-not-ready', currentRevision: 0 }),
    );
  });

  it('verifies an installed plugin from its snapshot-owned immutable root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cap-materializer-plugin-'));
    roots.push(root);
    mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
    mkdirSync(join(root, 'skills', 'demo', 'references'), { recursive: true });
    writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '# Demo');
    writeFileSync(join(root, 'skills', 'demo', 'references', 'guide.md'), 'Pinned guide');
    const bundleHash = await computeNormalizedBundleHash(root);
    const pluginInstanceId = `plugin://local/demo@1.0.0#${bundleHash}`;
    const pinned = {
      ...snapshot(),
      installedPlugins: [{
        pluginKey: 'local/demo',
        activeInstanceId: pluginInstanceId,
        origin: { marketplaceId: 'local', pluginId: 'demo' },
        name: 'Demo',
        version: '1.0.0',
        installedAt: 1,
        lifecycleState: 'ready' as const,
        capabilityKinds: ['skill' as const],
        bundleHash,
        bundleRootPath: root,
      }],
    } as EffectiveCapabilitySnapshot;

    const materializer = createCapabilitySnapshotMaterializer(resolver(), pinned);
    await expect(materializer.verifyPlugin(pluginInstanceId)).resolves.toBeUndefined();
    const supporting = await materializer.readRelativeText?.({
      pluginInstanceId,
      relativePath: 'skills/demo/SKILL.md',
      contentHash: createHash('sha256').update('# Demo').digest('hex'),
    }, 'references/guide.md');
    expect(supporting).toEqual({
      content: 'Pinned guide',
      contentHash: createHash('sha256').update('Pinned guide').digest('hex'),
    });
    await expect(materializer.readRelativeText?.({
      pluginInstanceId,
      relativePath: 'skills/demo/SKILL.md',
      contentHash: createHash('sha256').update('# Demo').digest('hex'),
    }, '../other.md')).rejects.toThrow('Path escapes managed storage root');
  });
});

/**
 * Builds a bundle on disk plus the snapshot shape the materializer reads:
 * `pluginRuntimeRoots` consults `activeInstanceId`/`bundleRootPath` and
 * `verifyPlugin` additionally reads `bundleHash`.
 */
async function pluginFixture(): Promise<{ root: string; pinned: EffectiveCapabilitySnapshot }> {
  const root = mkdtempSync(join(tmpdir(), 'materializer-memo-'));
  roots.push(root);
  mkdirSync(join(root, 'skills'), { recursive: true });
  writeFileSync(join(root, 'plugin.json'), '{"id":"toolkit"}');
  writeFileSync(join(root, 'skills', 'a.md'), '# a');
  const bundleHash = await computeNormalizedBundleHash(root);
  const pinned = {
    ...snapshot(),
    installedPlugins: [{
      pluginKey: 'local/toolkit',
      activeInstanceId: 'instance-1',
      origin: { marketplaceId: 'local', pluginId: 'toolkit' },
      name: 'Toolkit',
      version: '1.0.0',
      installedAt: 1,
      lifecycleState: 'ready' as const,
      capabilityKinds: ['skill' as const],
      bundleHash,
      bundleRootPath: root,
    }],
  } as EffectiveCapabilitySnapshot;
  return { root, pinned };
}

/** `resolver()` captures `active` at construction; these tests flip it mid-flight. */
function revocableResolver(isActive: () => boolean): CapabilityResolver {
  return { ...resolver(), isLeaseActive: isActive };
}

describe('CapabilitySnapshotMaterializer.verifyPlugin', () => {
  it('hashes a bundle once per lease however many times it is verified', async () => {
    const { pinned } = await pluginFixture();
    let hashCalls = 0;
    const materializer = createCapabilitySnapshotMaterializer(resolver(), pinned, {
      computeBundleHash: async dir => { hashCalls += 1; return computeNormalizedBundleHash(dir); },
    });

    await materializer.verifyPlugin('instance-1');
    await materializer.verifyPlugin('instance-1');
    await materializer.verifyPlugin('instance-1');

    expect(hashCalls).toBe(1);
  });

  it('still checks the lease on every call, including a memo hit', async () => {
    const { pinned } = await pluginFixture();
    let active = true;
    let hashCalls = 0;
    const materializer = createCapabilitySnapshotMaterializer(
      revocableResolver(() => active),
      pinned,
      { computeBundleHash: async dir => { hashCalls += 1; return computeNormalizedBundleHash(dir); } },
    );

    await materializer.verifyPlugin('instance-1');
    active = false;

    await expect(materializer.verifyPlugin('instance-1'))
      .rejects.toThrow('capability-snapshot-revoked');
    // The revoke must be reported from the memo path, not by re-hashing: proves
    // `assertActive()` runs BEFORE the memo short-circuit.
    expect(hashCalls).toBe(1);
  });

  it('does not share the memo between two materializers over the same bundle', async () => {
    const { pinned } = await pluginFixture();
    let hashCalls = 0;
    const count = async (dir: string) => { hashCalls += 1; return computeNormalizedBundleHash(dir); };
    const first = createCapabilitySnapshotMaterializer(resolver(), pinned, { computeBundleHash: count });
    const second = createCapabilitySnapshotMaterializer(resolver(), pinned, { computeBundleHash: count });

    await first.verifyPlugin('instance-1');
    await second.verifyPlugin('instance-1');

    // A new lease must re-verify: that is the boundary that detects tampering.
    expect(hashCalls).toBe(2);
  });

  it('rejects a bundle whose content changed, and does not memoize the failure', async () => {
    const { root, pinned } = await pluginFixture();
    let hashCalls = 0;
    let staleCalls = 0;
    const materializer = createCapabilitySnapshotMaterializer(resolver(), pinned, {
      onStale: () => { staleCalls += 1; },
      computeBundleHash: async dir => { hashCalls += 1; return computeNormalizedBundleHash(dir); },
    });
    writeFileSync(join(root, 'skills', 'a.md'), '# tampered');

    await expect(materializer.verifyPlugin('instance-1')).rejects.toThrow('capability-snapshot-stale');
    await expect(materializer.verifyPlugin('instance-1')).rejects.toThrow('capability-snapshot-stale');
    // Each rejection re-hashed and re-reported: a failure must never be recorded
    // as a decision the memo can serve.
    expect(hashCalls).toBe(2);
    expect(staleCalls).toBe(2);
  });

  it('still verifies once per lease when reached through resolvePath and readText', async () => {
    const { pinned } = await pluginFixture();
    let hashCalls = 0;
    const materializer = createCapabilitySnapshotMaterializer(resolver(), pinned, {
      computeBundleHash: async dir => { hashCalls += 1; return computeNormalizedBundleHash(dir); },
    });
    const ref = {
      pluginInstanceId: 'instance-1',
      relativePath: 'skills/a.md',
      contentHash: createHash('sha256').update('# a').digest('hex'),
    };

    await materializer.resolvePath(ref);
    await materializer.readText(ref);
    await materializer.verifyPlugin('instance-1');

    // These are the three real call sites (`runtime-pool-servers.ts:233`, `:131`,
    // `:141`) that each re-hashed the whole bundle inside one turn.
    expect(hashCalls).toBe(1);
  });
});
