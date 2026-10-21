import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityPolicyStore } from '../policy-store.ts';

let dir: string;
const PROJECT_KEY = `p_${'b'.repeat(32)}` as const;

function newStore(): CapabilityPolicyStore {
  return new CapabilityPolicyStore({
    globalPath: join(dir, 'capabilities.json'),
    workspacePolicyPath: (workspaceId: string) => join(dir, 'ws', workspaceId, 'capabilities.json'),
    workspaceIds: () => ['ws_a', 'ws_b'],
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'capability-policy-'));
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('CapabilityPolicyStore', () => {
  it('activates one install differently across two workspaces and two projects', () => {
    const store = newStore();
    store.recordGlobal({ pluginKey: 'pk', enabled: true });
    store.recordWorkspace('ws_a', { pluginKey: 'pk', enabled: true });
    store.recordWorkspace('ws_b', { pluginKey: 'pk', enabled: false });
    store.recordProjectOverride('ws_a', PROJECT_KEY, { pluginKey: 'pk', enabled: false });

    expect(store.resolve({ pluginKey: 'pk' }, { workspaceId: 'ws_a' }).enabled).toBe(true);
    // Workspace explicit false suppresses.
    expect(store.resolve({ pluginKey: 'pk' }, { workspaceId: 'ws_b' }).suppressed).toBe(true);
    // Private (ws_a, project) override suppresses only for that pair.
    expect(store.resolve({ pluginKey: 'pk' }, { workspaceId: 'ws_a', projectKey: PROJECT_KEY }).enabled).toBe(false);
    // A different project under ws_a stays enabled.
    const otherProject = `p_${'c'.repeat(32)}` as const;
    expect(store.resolve({ pluginKey: 'pk' }, { workspaceId: 'ws_a', projectKey: otherProject }).enabled).toBe(true);
  });

  it('applies a private project override even when the repository is untrusted', () => {
    const store = newStore();
    store.recordGlobal({ pluginKey: 'pk', enabled: true });
    store.recordProjectOverride('ws_a', PROJECT_KEY, { pluginKey: 'pk', enabled: false });
    // No trustedProjectOverlay supplied => repo untrusted; user override still applies.
    const resolved = store.resolve({ pluginKey: 'pk' }, { workspaceId: 'ws_a', projectKey: PROJECT_KEY });
    expect(resolved.enabled).toBe(false);
    expect(resolved.suppressed).toBe(true);
  });

  it('applies the trusted repository overlay only when supplied', () => {
    const overlay = { records: [{ scope: { kind: 'project' as const, workspaceId: 'ws_a', projectKey: PROJECT_KEY }, pluginKey: 'pk', enabled: true, updatedAt: '' }] };

    const suppressing = new CapabilityPolicyStore({
      globalPath: join(dir, 'suppress.json'),
      workspacePolicyPath: (w: string) => join(dir, 'ws', w, 'capabilities.json'),
    });
    suppressing.recordGlobal({ pluginKey: 'pk', enabled: false });
    // Untrusted: overlay withheld, global suppression stands.
    expect(suppressing.resolve({ pluginKey: 'pk' }, { workspaceId: 'ws_a', projectKey: PROJECT_KEY }).enabled).toBe(false);

    // Fresh store with no global policy: the trusted overlay enables the target.
    const clean = new CapabilityPolicyStore({
      globalPath: join(dir, 'clean.json'),
      workspacePolicyPath: (w: string) => join(dir, 'ws2', w, 'capabilities.json'),
    });
    expect(
      clean.resolve({ pluginKey: 'pk' }, { workspaceId: 'ws_a', projectKey: PROJECT_KEY, trustedProjectOverlay: overlay }).enabled,
    ).toBe(true);
    // Without the overlay (untrusted), the same store yields no activation.
    expect(clean.resolve({ pluginKey: 'pk' }, { workspaceId: 'ws_a', projectKey: PROJECT_KEY }).enabled).toBe(false);
  });

  it('merges per-capability overrides and validates ids', () => {
    const store = newStore();
    store.recordGlobal({ pluginKey: 'pk', enabled: true, capabilities: { review: false } });
    store.recordWorkspace('ws_a', { pluginKey: 'pk', enabled: true, capabilities: { format: true } });
    const resolved = store.resolve({ pluginKey: 'pk' }, { workspaceId: 'ws_a' });
    expect(resolved.capabilities).toEqual({ review: false, format: true });

    expect(() => store.recordWorkspace('../escape', { pluginKey: 'pk', enabled: true })).toThrow();
    expect(() => store.recordProjectOverride('ws_a', 'not-a-key' as never, { pluginKey: 'pk', enabled: true })).toThrow();
  });

  it('treats a capabilityId-scoped record as a pure per-capability toggle', () => {
    const store = newStore();
    // A capability toggle alone never activates the plugin.
    store.recordWorkspace('ws_a', { pluginKey: 'pk', capabilityId: 'mcp-one', enabled: false });
    let resolved = store.resolve({ pluginKey: 'pk' }, { workspaceId: 'ws_a' });
    expect(resolved.enabled).toBe(false);
    expect(resolved.suppressed).toBe(false);

    // With the plugin enabled, the toggle lands in the capabilities map only.
    store.recordGlobal({ pluginKey: 'pk', enabled: true });
    resolved = store.resolve({ pluginKey: 'pk' }, { workspaceId: 'ws_a' });
    expect(resolved.enabled).toBe(true);
    expect(resolved.suppressed).toBe(false);
    expect(resolved.capabilities).toEqual({ 'mcp-one': false });

    // A narrower layer's toggle overrides the wider one.
    store.recordProjectOverride('ws_a', PROJECT_KEY, { pluginKey: 'pk', capabilityId: 'mcp-one', enabled: true });
    resolved = store.resolve({ pluginKey: 'pk' }, { workspaceId: 'ws_a', projectKey: PROJECT_KEY });
    expect(resolved.capabilities).toEqual({ 'mcp-one': true });

    // resolveScopes still ignores capabilityId records for whole-plugin state.
    const scopes = store.resolveScopes({ pluginKey: 'pk' }, { workspaceId: 'ws_a', projectKey: PROJECT_KEY });
    expect(scopes.workspace).toBe('unset');
  });

  it('applies capability values in global, workspace, repository, private-project order', () => {
    const store = newStore();
    store.recordGlobal({ pluginKey: 'pk', enabled: true, capabilities: { review: false } });
    store.recordWorkspace('ws_a', { pluginKey: 'pk', enabled: true, capabilities: { review: true } });
    store.recordProjectOverride('ws_a', PROJECT_KEY, {
      pluginKey: 'pk',
      enabled: true,
      capabilities: { review: false },
    });

    const resolved = store.resolve(
      { pluginKey: 'pk' },
      {
        workspaceId: 'ws_a',
        projectKey: PROJECT_KEY,
        trustedProjectOverlay: {
          records: [{
            scope: { kind: 'project', workspaceId: 'ws_a', projectKey: PROJECT_KEY },
            pluginKey: 'pk',
            enabled: true,
            capabilities: { review: true },
            updatedAt: '',
          }],
        },
      },
    );

    expect(resolved.capabilities.review).toBe(false);
  });

  it('never writes a project file and drops the private override on workspace cleanup', async () => {
    const store = newStore();
    store.recordProjectOverride('ws_a', PROJECT_KEY, { pluginKey: 'pk', enabled: false });
    // Only the global file is written; no per-project repository file exists.
    expect(existsSync(join(dir, 'capabilities.json'))).toBe(true);
    expect(readdirSync(dir).filter(name => name.endsWith('.toml'))).toHaveLength(0);
    expect(store.readGlobal().projectOverrides.ws_a).toHaveLength(1);

    const participant = store.cleanupParticipant();
    expect(participant.id).toBe('capability-policy');
    await participant.stage('ws_a', 'tx1');
    await participant.commit('tx1');
    expect(store.readGlobal().projectOverrides.ws_a).toBeUndefined();
  });

  it('purges every managed scope for an uninstalled plugin while preserving other plugins', () => {
    const store = newStore();
    store.recordGlobal({ pluginKey: 'removed.plugin', enabled: true });
    store.recordGlobal({ pluginInstanceId: 'plugin://removed-instance', enabled: true });
    store.recordGlobal({ pluginKey: 'kept.plugin', enabled: true });
    store.recordWorkspace('ws_a', { pluginKey: 'removed.plugin', enabled: true });
    store.recordWorkspace('ws_b', { pluginKey: 'kept.plugin', enabled: false });
    store.recordProjectOverride('ws_a', PROJECT_KEY, { pluginKey: 'removed.plugin', enabled: false });

    expect(store.purgePlugin('removed.plugin', ['plugin://removed-instance'])).toBe(4);
    expect(store.resolve({ pluginKey: 'removed.plugin' }, { workspaceId: 'ws_a', projectKey: PROJECT_KEY })).toEqual({
      enabled: false,
      suppressed: false,
      capabilities: {},
    });
    expect(store.resolve({ pluginInstanceId: 'plugin://removed-instance' }).enabled).toBe(false);
    expect(store.resolve({ pluginKey: 'kept.plugin' }).enabled).toBe(true);
    expect(store.resolve({ pluginKey: 'kept.plugin' }, { workspaceId: 'ws_b' }).suppressed).toBe(true);
    expect(store.readGlobal().projectOverrides.ws_a).toBeUndefined();
  });

  describe('resolveScopes (U4 per-scope menu labels)', () => {
    it('reports each scope independently as enabled/disabled/unset', () => {
      const store = newStore();
      store.recordGlobal({ pluginKey: 'pk', enabled: true });
      store.recordWorkspace('ws_a', { pluginKey: 'pk', enabled: false });
      store.recordProjectOverride('ws_a', PROJECT_KEY, { pluginKey: 'pk', enabled: true });

      const scopes = store.resolveScopes(
        { pluginKey: 'pk' },
        { workspaceId: 'ws_a', projectKey: PROJECT_KEY },
      );
      // Direct per-scope verdicts — NOT the merged precedence verdict of resolve().
      expect(scopes.global).toBe('enabled');
      expect(scopes.workspace).toBe('disabled');
      expect(scopes.project).toBe('enabled');
    });

    it('unset scopes stay unset; project is ineligible without a projectKey', () => {
      const store = newStore();
      store.recordWorkspace('ws_a', { pluginKey: 'pk', enabled: true });

      const scopes = store.resolveScopes({ pluginKey: 'pk' }, { workspaceId: 'ws_a' });
      expect(scopes.global).toBe('unset');
      expect(scopes.workspace).toBe('enabled');
      expect(scopes.project).toBe('ineligible');
      expect(scopes.managed).toBeUndefined();
    });
  });

  /**
   * `settings-reference.md#enabledplugins` — "Plugins force-enabled by managed
   * settings can't be disabled this way, since managed settings override local
   * settings." The same section states the other direction, where a managed
   * entry blocks the plugin: "A plugin set to `false` here is blocked from
   * installation at every scope and hidden from the marketplace".
   */
  describe('the managed tier (settings-reference.md#enabledplugins, managed scope)', () => {
    it('enables a plugin no layer ever recorded', () => {
      const store = newStore();
      // No global, workspace or project record exists for `pk` at all.
      expect(store.resolve({ pluginKey: 'pk' }, { workspaceId: 'ws_a' }).enabled).toBe(false);

      const managed = store.resolve(
        { pluginKey: 'pk' },
        { workspaceId: 'ws_a', managedActivation: 'force-enabled' },
      );
      expect(managed.enabled).toBe(true);
      expect(managed.suppressed).toBe(false);
    });

    it('outranks a user disable at every scope, including the narrowest', () => {
      const store = newStore();
      store.recordGlobal({ pluginKey: 'pk', enabled: false });
      store.recordWorkspace('ws_a', { pluginKey: 'pk', enabled: false });
      store.recordProjectOverride('ws_a', PROJECT_KEY, { pluginKey: 'pk', enabled: false });

      const context = { workspaceId: 'ws_a', projectKey: PROJECT_KEY } as const;
      // Without the managed entry, the user's own suppression stands.
      expect(store.resolve({ pluginKey: 'pk' }, context).suppressed).toBe(true);

      const managed = store.resolve({ pluginKey: 'pk' }, { ...context, managedActivation: 'force-enabled' });
      expect(managed.enabled).toBe(true);
      expect(managed.suppressed).toBe(false);
    });

    it('a managed block cannot be re-enabled by any layer', () => {
      const store = newStore();
      store.recordGlobal({ pluginKey: 'pk', enabled: true });
      store.recordWorkspace('ws_a', { pluginKey: 'pk', enabled: true });

      const blocked = store.resolve(
        { pluginKey: 'pk' },
        { workspaceId: 'ws_a', managedActivation: 'blocked' },
      );
      expect(blocked.enabled).toBe(false);
      expect(blocked.suppressed).toBe(true);
    });

    it('keeps the user per-capability map inside a force-enabled activation', () => {
      // The administrator activated the PLUGIN. A per-capability toggle is the
      // user's narrowing inside that activation, not a way to undo it, so it
      // survives — the resolver still applies it with its own reason.
      const store = newStore();
      store.recordGlobal({ pluginKey: 'pk', enabled: false, capabilities: { 'skill:a': false } });

      const managed = store.resolve(
        { pluginKey: 'pk' },
        { workspaceId: 'ws_a', managedActivation: 'force-enabled' },
      );
      expect(managed.enabled).toBe(true);
      expect(managed.capabilities).toEqual({ 'skill:a': false });
    });

    it('resolveScopes reports the managed row so a menu can say why Disable is gone', () => {
      const store = newStore();
      store.recordWorkspace('ws_a', { pluginKey: 'pk', enabled: false });

      expect(store.resolveScopes({ pluginKey: 'pk' }, { workspaceId: 'ws_a', managedActivation: 'force-enabled' }))
        .toEqual({ global: 'unset', workspace: 'disabled', project: 'ineligible', managed: 'enabled' });
      expect(store.resolveScopes({ pluginKey: 'pk' }, { workspaceId: 'ws_a', managedActivation: 'blocked' }).managed)
        .toBe('disabled');
    });
  });
});
