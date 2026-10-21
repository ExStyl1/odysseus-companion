import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityTrustStore, type CapabilityTrustKey } from '../trust-store.ts';

let dir: string;

function newStore(): CapabilityTrustStore {
  return new CapabilityTrustStore({ path: join(dir, 'capability-trust.json'), now: () => new Date('2026-01-01T00:00:00.000Z') });
}

function key(overrides: Partial<CapabilityTrustKey> = {}): CapabilityTrustKey {
  return {
    pluginInstanceId: 'plugin://internal/toolkit@1.0.0#' + 'a'.repeat(64),
    capabilityId: 'pretool',
    executableHash: 'sha256-a',
    scope: { kind: 'workspace', workspaceId: 'ws_a' },
    ...overrides,
  };
}

function projectHookKey(overrides: Partial<CapabilityTrustKey> = {}): CapabilityTrustKey {
  return {
    capabilityId: `hook::project::ws_a::p_${'a'.repeat(32)}::.nessy-agent/hooks.json`,
    executableHash: 'sha256-project-a',
    scope: { kind: 'project', workspaceId: 'ws_a', projectKey: `p_${'a'.repeat(32)}` },
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'capability-trust-'));
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('CapabilityTrustStore', () => {
  it('binds trust to instance, capability, executable hash and scope', () => {
    const store = newStore();
    store.grant(key());

    expect(store.isTrusted(key())).toBe(true);
    expect(store.resolve(key())).toBe('trusted');
    // A changed executable hash is review-required (Codex hook gate).
    expect(store.isTrusted(key({ executableHash: 'sha256-b' }))).toBe(false);
    // A different instance (e.g. after update) is review-required.
    expect(store.isTrusted(key({ pluginInstanceId: 'plugin://internal/toolkit@2.0.0#' + 'b'.repeat(64) }))).toBe(false);
    // A different scope is review-required.
    expect(store.resolve(key({ scope: { kind: 'global' } }))).toBe('review-required');
  });

  it('binds native project-hook trust to the exact definition hash and scope without persisting a path', () => {
    const store = newStore();
    store.grant(projectHookKey());

    expect(store.resolve(projectHookKey())).toBe('trusted');
    expect(store.resolve(projectHookKey({ executableHash: 'sha256-project-b' }))).toBe('review-required');
    expect(store.resolve(projectHookKey({
      scope: { kind: 'project', workspaceId: 'ws_b', projectKey: `p_${'a'.repeat(32)}` },
    }))).toBe('review-required');

    const persisted = readFileSync(join(dir, 'capability-trust.json'), 'utf8');
    expect(persisted).not.toContain('pluginInstanceId');
    expect(persisted).not.toContain('/project');
  });

  it('revokes a grant', () => {
    const store = newStore();
    store.grant(key());
    expect(store.revoke(key())?.revokedAt).toBeDefined();
    expect(store.isTrusted(key())).toBe(false);
    expect(store.revoke(key({ capabilityId: 'missing' }))).toBeNull();
  });

  it('starts empty (never imports legacy plugin trust)', () => {
    const store = newStore();
    expect(store.resolve(key())).toBe('review-required');
  });

  it('purges all trust history for uninstalled plugin instances only', () => {
    const store = newStore();
    const removedInstance = key().pluginInstanceId!;
    const keptInstance = `plugin://kept@1.0.0#${'b'.repeat(64)}`;
    store.grant(key());
    store.grant(key({ capabilityId: 'second' }));
    store.revoke(key({ capabilityId: 'second' }));
    store.grant(key({ pluginInstanceId: keptInstance }));
    store.grant(projectHookKey());

    expect(store.purgePluginInstances([removedInstance])).toBe(2);
    expect(store.resolve(key())).toBe('review-required');
    expect(store.resolve(key({ capabilityId: 'second' }))).toBe('review-required');
    expect(store.resolve(key({ pluginInstanceId: keptInstance }))).toBe('trusted');
    expect(store.resolve(projectHookKey())).toBe('trusted');
  });

  it('drops workspace-scoped grants on workspace cleanup but keeps global grants', async () => {
    const store = newStore();
    store.grant(key({ scope: { kind: 'workspace', workspaceId: 'ws_a' } }));
    store.grant(key({ scope: { kind: 'project', workspaceId: 'ws_a', projectKey: `p_${'a'.repeat(32)}` } }));
    store.grant(key({ scope: { kind: 'global' } }));

    const participant = store.cleanupParticipant();
    expect(participant.id).toBe('capability-trust');
    await participant.stage('ws_a', 'tx1');
    await participant.commit('tx1');

    expect(store.isTrusted(key({ scope: { kind: 'workspace', workspaceId: 'ws_a' } }))).toBe(false);
    expect(store.isTrusted(key({ scope: { kind: 'project', workspaceId: 'ws_a', projectKey: `p_${'a'.repeat(32)}` } }))).toBe(false);
    expect(store.isTrusted(key({ scope: { kind: 'global' } }))).toBe(true);
  });

  it('serializes workspace cleanup after an in-flight trust mutation', async () => {
    const store = newStore();
    const participant = store.cleanupParticipant();
    await participant.stage('ws_a', 'tx-race');

    let releaseMutation!: () => void;
    let markMutationStarted!: () => void;
    const mutationStarted = new Promise<void>(resolve => { markMutationStarted = resolve; });
    const mutation = store.runExclusive(async () => {
      markMutationStarted();
      await new Promise<void>(resolve => { releaseMutation = resolve; });
      store.grant(key({ capabilityId: 'late-workspace-grant' }));
    });
    await mutationStarted;

    const cleanup = participant.commit('tx-race');
    releaseMutation();
    await Promise.all([mutation, cleanup]);

    expect(store.resolve(key({ capabilityId: 'late-workspace-grant' }))).toBe('review-required');
  });
});
