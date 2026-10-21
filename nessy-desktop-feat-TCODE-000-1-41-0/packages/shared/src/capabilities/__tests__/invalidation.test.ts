/**
 * W6 Step 7 — typed native-source invalidations for W8.
 *
 * Watcher change points emit scoped, typed invalidation events keyed by
 * capability kind + scope (global | workspace(workspaceId) | project). W8's
 * unified resolver subscribes to this bus to drop its snapshot caches; W6 only
 * provides the additive emission surface and proves the watcher fires it.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigWatcher } from '../../config/watcher.ts';
import { CONFIG_DIR } from '../../config/paths.ts';
import {
  emitCapabilityCatalogInvalidation,
  emitNativeSourceInvalidation,
  onCapabilityCatalogInvalidation,
  onNativeSourceInvalidation,
  type CapabilityCatalogInvalidation,
  type NativeSourceInvalidation,
} from '../invalidation.ts';

const WORKSPACE_ID = 'ws-invalidation';

function makeRunningWatcher(
  workspaceRoot: string,
  callbacks: ConstructorParameters<typeof ConfigWatcher>[1] = {},
): ConfigWatcher {
  const watcher = new ConfigWatcher(workspaceRoot, callbacks, WORKSPACE_ID);
  (watcher as unknown as { isRunning: boolean }).isRunning = true;
  return watcher;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('native-source invalidation bus', () => {
  const unsubscribers: Array<() => void> = [];

  afterEach(() => {
    while (unsubscribers.length) unsubscribers.pop()?.();
  });

  function collect(): NativeSourceInvalidation[] {
    const seen: NativeSourceInvalidation[] = [];
    unsubscribers.push(onNativeSourceInvalidation(inv => seen.push(inv)));
    return seen;
  }

  it('delivers typed events to subscribers and stops after unsubscribe', () => {
    const seen = collect();
    emitNativeSourceInvalidation({ kind: 'skill', scope: { kind: 'global' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.kind).toBe('skill');
    expect(seen[0]!.scope).toEqual({ kind: 'global' });
    expect(seen[0]!.revision).not.toBe('');

    unsubscribers.pop()?.();
    emitNativeSourceInvalidation({ kind: 'skill', scope: { kind: 'global' } });
    expect(seen).toHaveLength(1);
  });

  it('watcher emits workspace-scoped skill/permission/automation invalidations by workspace ID', async () => {
    const wsParent = mkdtempSync(join(tmpdir(), 'nessy-inv-'));
    const workspaceRoot = join(wsParent, 'some-root');
    mkdirSync(join(workspaceRoot, 'skills'), { recursive: true });
    const seen = collect();
    const watcher = makeRunningWatcher(workspaceRoot);

    try {
      watcher.notifyFileChange('permissions.json');
      watcher.notifyFileChange('automations.json');
      watcher.notifyFileChange('skills/my-skill/SKILL.md');
      await wait(250);

      const kinds = seen.map(inv => inv.kind).sort();
      expect(kinds).toContain('permission');
      expect(kinds).toContain('automation');
      expect(kinds).toContain('skill');
      for (const inv of seen) {
        expect(inv.scope).toEqual({ kind: 'workspace', workspaceId: WORKSPACE_ID });
      }
    } finally {
      watcher.stop();
      rmSync(wsParent, { recursive: true, force: true });
    }
  });

  it('watcher emits a global hook invalidation for the user-global hooks file', async () => {
    const wsParent = mkdtempSync(join(tmpdir(), 'nessy-inv-'));
    const workspaceRoot = join(wsParent, 'some-root');
    mkdirSync(workspaceRoot, { recursive: true });
    const seen = collect();
    const watcher = makeRunningWatcher(workspaceRoot);

    try {
      watcher.notifyGlobalConfigFileChange('hooks.json');
      await wait(250);

      const hook = seen.find(inv => inv.kind === 'hook');
      expect(hook).toBeDefined();
      expect(hook!.scope).toEqual({ kind: 'global' });
    } finally {
      watcher.stop();
      rmSync(wsParent, { recursive: true, force: true });
    }
  });

  /**
   * C3.121 (QH12 = A, owner 2026-09-11) — the user scope of the agent
   * definitions had no arm in the global dispatcher, so a definition dropped
   * into `<CONFIG_DIR>/agents` mid-session was not picked up until a restart,
   * while the project scope was already served by
   * `project-capability-watcher.ts`'s `WATCHED_PROJECT_DIRS`.
   */
  it('watcher emits a GLOBAL agent invalidation for a user-scope agent file', async () => {
    const wsParent = mkdtempSync(join(tmpdir(), 'nessy-inv-'));
    const workspaceRoot = join(wsParent, 'some-root');
    mkdirSync(workspaceRoot, { recursive: true });
    const seen = collect();
    const watcher = makeRunningWatcher(workspaceRoot);

    try {
      // The two spellings one arm has to take: the directory entry itself,
      // which is ALL a non-recursive watch of CONFIG_DIR reports when the
      // directory is created (measured on macOS/bun 1.3.14), and the nested
      // path the platforms that report one would deliver.
      watcher.notifyGlobalConfigFileChange('agents');
      await wait(250);
      expect(seen.filter(inv => inv.kind === 'agent')).toHaveLength(1);
      expect(seen.find(inv => inv.kind === 'agent')!.scope).toEqual({ kind: 'global' });

      seen.length = 0;
      watcher.notifyGlobalConfigFileChange('agents/reviewer.md');
      await wait(250);
      expect(seen.filter(inv => inv.kind === 'agent')).toHaveLength(1);
    } finally {
      watcher.stop();
      rmSync(wsParent, { recursive: true, force: true });
    }
  });

  it('picks up a file written into an agents directory that EXISTED at start', async () => {
    // The control the H37 cell names. `CONFIG_DIR` is this process's private
    // temp directory under the test preload, so the real watcher may be driven.
    const agentsDir = join(CONFIG_DIR, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const wsParent = mkdtempSync(join(tmpdir(), 'nessy-inv-'));
    const workspaceRoot = join(wsParent, 'some-root');
    mkdirSync(workspaceRoot, { recursive: true });
    const seen = collect();
    const watcher = makeRunningWatcher(workspaceRoot);

    try {
      (watcher as unknown as { watchAppAgentsDir(): void }).watchAppAgentsDir();
      writeFileSync(join(agentsDir, 'c3121-reviewer.md'), '---\nname: c3121-reviewer\n---\nhi\n');
      for (let i = 0; i < 20 && !seen.some(inv => inv.kind === 'agent'); i += 1) await wait(100);
      const agent = seen.find(inv => inv.kind === 'agent');
      expect(agent).toBeDefined();
      expect(agent!.scope).toEqual({ kind: 'global' });

      // The negative control on the same watcher: a non-markdown file in the
      // same directory is not an agent definition and must not drop the
      // snapshot.
      seen.length = 0;
      writeFileSync(join(agentsDir, 'c3121-notes.txt'), 'scratch');
      await wait(400);
      expect(seen.filter(inv => inv.kind === 'agent')).toEqual([]);
    } finally {
      watcher.stop();
      rmSync(join(agentsDir, 'c3121-reviewer.md'), { force: true });
      rmSync(join(agentsDir, 'c3121-notes.txt'), { force: true });
      rmSync(wsParent, { recursive: true, force: true });
    }
  });

  it('does NOT fire for a global config file that merely starts with `agents`', async () => {
    const wsParent = mkdtempSync(join(tmpdir(), 'nessy-inv-'));
    const workspaceRoot = join(wsParent, 'some-root');
    mkdirSync(workspaceRoot, { recursive: true });
    const seen = collect();
    const watcher = makeRunningWatcher(workspaceRoot);

    try {
      watcher.notifyGlobalConfigFileChange('agents-backup.json');
      watcher.notifyGlobalConfigFileChange('preferences.json');
      await wait(250);
      expect(seen.filter(inv => inv.kind === 'agent')).toEqual([]);
    } finally {
      watcher.stop();
      rmSync(wsParent, { recursive: true, force: true });
    }
  });

  it('watcher emits source-kind invalidations for workspace source config changes', async () => {
    const wsParent = mkdtempSync(join(tmpdir(), 'nessy-inv-'));
    const workspaceRoot = join(wsParent, 'some-root');
    mkdirSync(join(workspaceRoot, 'sources', 'github'), { recursive: true });
    writeFileSync(join(workspaceRoot, 'sources', 'github', 'config.json'), JSON.stringify({ slug: 'github' }));
    const seen = collect();
    const watcher = makeRunningWatcher(workspaceRoot);

    try {
      watcher.notifyFileChange('sources/github/config.json');
      await wait(250);

      const source = seen.find(inv => inv.kind === 'source');
      expect(source).toBeDefined();
      expect(source!.scope).toEqual({ kind: 'workspace', workspaceId: WORKSPACE_ID });
    } finally {
      watcher.stop();
      rmSync(wsParent, { recursive: true, force: true });
    }
  });
});

describe('resolver-facing catalog invalidation bus (W8 Step 8)', () => {
  it('delivers scoped catalog invalidations with an explicit effect and monotonic revision', () => {
    const seen: CapabilityCatalogInvalidation[] = [];
    const off = onCapabilityCatalogInvalidation(inv => seen.push(inv));
    try {
      emitCapabilityCatalogInvalidation({
        scope: { kind: 'project-trust', projectKey: 'p_00000000000000000000000000000000' },
        reason: 'whole-project-trust-revoked',
        effect: 'revoke-active-snapshot',
      });
      emitCapabilityCatalogInvalidation({
        scope: { kind: 'workspace', workspaceId: 'ws-9' },
        reason: 'metadata-add',
        effect: 'refresh-before-next-turn',
      });
      expect(seen).toHaveLength(2);
      expect(seen[0]!.scope).toEqual({ kind: 'project-trust', projectKey: 'p_00000000000000000000000000000000' });
      expect(seen[0]!.effect).toBe('revoke-active-snapshot');
      expect(seen[1]!.effect).toBe('refresh-before-next-turn');
      expect(seen[0]!.revision).not.toBe(seen[1]!.revision);
    } finally {
      off();
    }
  });

  it('isolates a throwing listener from the others', () => {
    const seen: string[] = [];
    const offBad = onCapabilityCatalogInvalidation(() => { throw new Error('bad'); });
    const offGood = onCapabilityCatalogInvalidation(inv => seen.push(inv.reason));
    try {
      emitCapabilityCatalogInvalidation({ scope: { kind: 'global' }, reason: 'r', effect: 'refresh-before-next-turn' });
      expect(seen).toEqual(['r']);
    } finally {
      offBad();
      offGood();
    }
  });
});
