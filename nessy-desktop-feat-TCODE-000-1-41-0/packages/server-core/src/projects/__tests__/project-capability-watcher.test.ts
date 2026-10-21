/**
 * P5: ref-counted external project watcher — keying, refcounts, revalidation
 * gating, inert `.nessy`, and descriptor cleanup.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectCapabilityWatcherRegistry, type ProjectWatchTarget } from '../project-capability-watcher';

const roots: string[] = [];
const registries: ProjectCapabilityWatcherRegistry[] = [];

afterEach(() => {
  for (const registry of registries.splice(0)) registry.closeAll();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeProject(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-project-watch-')));
  mkdirSync(join(dir, '.nessy-agent'), { recursive: true });
  mkdirSync(join(dir, '.nessy'), { recursive: true });
  roots.push(dir);
  return dir;
}

function target(canonicalPath: string, over: Partial<ProjectWatchTarget> = {}): ProjectWatchTarget {
  return {
    workspaceId: 'ws-a',
    projectKey: 'p_' + 'a'.repeat(32),
    canonicalPath,
    identityFingerprint: 'fp-1',
    ...over,
  };
}

function makeRegistry(options: {
  ok?: boolean;
  events: Array<{ projectKey: string; workspaceId: string; kind: string }>;
}): ProjectCapabilityWatcherRegistry {
  const registry = new ProjectCapabilityWatcherRegistry({
    revalidate: async () => ({ ok: options.ok ?? true }),
    onInvalidate: (watchTarget, kind) => {
      options.events.push({ projectKey: watchTarget.projectKey, workspaceId: watchTarget.workspaceId, kind });
    },
    debounceMs: 10,
    // Deterministic unit tests: events are driven via notifyChange; real
    // fs.watch descriptors are covered by size()/close assertions only.
    watchImpl: (() => ({ close() {}, on() {} })) as unknown as typeof import('node:fs').watch,
  });
  registries.push(registry);
  return registry;
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('project capability watcher registry', () => {
  it('ref-counts by (WorkspaceId, ProjectKey) and closes watchers on final release', () => {
    const project = makeProject();
    const registry = makeRegistry({ events: [] });

    const releaseA = registry.acquire(target(project));
    const releaseB = registry.acquire(target(project));
    expect(registry.size()).toBe(1);
    // A second Workspace referencing the same project keeps its own entry.
    const releaseOther = registry.acquire(target(project, { workspaceId: 'ws-b' }));
    expect(registry.size()).toBe(2);

    releaseA();
    releaseA(); // idempotent
    expect(registry.size()).toBe(2);
    releaseB();
    expect(registry.size()).toBe(1);
    releaseOther();
    expect(registry.size()).toBe(0);
  });

  it('emits content invalidation for supported project changes after successful revalidation', async () => {
    const project = makeProject();
    const events: Array<{ projectKey: string; workspaceId: string; kind: string }> = [];
    const registry = makeRegistry({ events });
    registry.acquire(target(project));

    writeFileSync(join(project, '.nessy-agent', 'config.toml'), '[defaults]\n');
    registry.notifyChange('ws-a', 'p_' + 'a'.repeat(32), join('.nessy-agent', 'config.toml'));
    await wait(40);

    expect(events).toEqual([{ projectKey: 'p_' + 'a'.repeat(32), workspaceId: 'ws-a', kind: 'content' }]);
  });

  it('emits identity invalidation when revalidation fails', async () => {
    const project = makeProject();
    const events: Array<{ projectKey: string; workspaceId: string; kind: string }> = [];
    const registry = makeRegistry({ ok: false, events });
    registry.acquire(target(project));

    registry.notifyChange('ws-a', 'p_' + 'a'.repeat(32), 'AGENTS.md');
    await wait(40);

    expect(events).toEqual([{ projectKey: 'p_' + 'a'.repeat(32), workspaceId: 'ws-a', kind: 'identity' }]);
  });

  it('never emits for changes under a legacy .nessy directory', async () => {
    const project = makeProject();
    const events: Array<{ projectKey: string; workspaceId: string; kind: string }> = [];
    const registry = makeRegistry({ events });
    registry.acquire(target(project));

    writeFileSync(join(project, '.nessy', 'config.toml'), '[defaults]\n');
    registry.notifyChange('ws-a', 'p_' + 'a'.repeat(32), join('.nessy', 'config.toml'));
    registry.notifyChange('ws-a', 'p_' + 'a'.repeat(32), '.nessy');
    await wait(40);

    expect(events).toEqual([]);
  });

  it('debounces bursts into one revalidated invalidation and stops after release', async () => {
    const project = makeProject();
    const events: Array<{ projectKey: string; workspaceId: string; kind: string }> = [];
    const registry = makeRegistry({ events });
    const release = registry.acquire(target(project));

    for (let i = 0; i < 5; i++) {
      registry.notifyChange('ws-a', 'p_' + 'a'.repeat(32), join('.nessy-agent', 'hooks.json'));
    }
    await wait(40);
    expect(events).toHaveLength(1);

    release();
    registry.notifyChange('ws-a', 'p_' + 'a'.repeat(32), join('.nessy-agent', 'hooks.json'));
    await wait(40);
    expect(events).toHaveLength(1);
  });
});

/**
 * P2.284 — the eighth floating emission of the class 53849b319/9a95ae0ff swept.
 *
 * `handleEvent` fires `void this.emit(entry)` from a debounce timer, so `emit`
 * has no caller: everything it throws arrives as a REJECTION nobody holds.
 * `revalidate` was already belted; the HOST callback on the last line was not,
 * and that callback is `SessionManager`'s — it walks every live session and
 * starts a plugin-runtime refresh, so it is the half most likely to throw.
 */
describe('project capability watcher registry — host callback faults', () => {
  /**
   * THE DETECTOR, and it is not the obvious one.
   *
   * `process.on('unhandledRejection')` is what the two production hosts install
   * (`packages/server/src/index.ts`, `apps/electron/src/main/index.ts`), so it
   * reads like the right seam — but under `bun test` v1.3.14 a user listener
   * NEVER FIRES: the runner intercepts the rejection first and attributes it to
   * whichever test was running. Measured on this rig, twice: a listener around a
   * deliberately floated `Promise.reject` collected `[]`, and the same rejection
   * failed the test. An `expect(escaped).toEqual([])` assertion is therefore
   * VACUOUS here — it passes with and without the behaviour under test.
   *
   * So the detector below is the runner itself: an escape fails the test that
   * caused it. POSITIVE CONTROL for that, measured before the fix at
   * `f58f66a36`: all three cases failed with `error: host invalidation exploded
   * … at emit (project-capability-watcher.ts:148)`. The `calls`/`kinds`
   * assertions are the second half of the control — they prove the emission
   * actually ran inside the wait window, so a clean run means "contained", not
   * "never reached".
   */
  it('a throwing host callback does not escape as an unhandled rejection', async () => {
    const project = makeProject();
    let calls = 0;
    const registry = new ProjectCapabilityWatcherRegistry({
      revalidate: async () => ({ ok: true }),
      onInvalidate: () => {
        calls += 1;
        throw new Error('host invalidation exploded');
      },
      debounceMs: 10,
      watchImpl: (() => ({ close() {}, on() {} })) as unknown as typeof import('node:fs').watch,
    });
    registries.push(registry);
    registry.acquire(target(project));

    registry.notifyChange('ws-a', 'p_' + 'a'.repeat(32), join('.nessy-agent', 'config.toml'));
    await wait(40);

    expect(calls).toBe(1);
  });

  it('a throwing host callback does not stop the registry watching', async () => {
    // The boundary the containment has to hold: one bad delivery must not cost
    // every later one. Without it the throw is the last statement of `emit`,
    // so nothing downstream breaks — but a future await added below it would
    // strand, and the entry itself must stay live either way.
    const project = makeProject();
    const kinds: string[] = [];
    let explode = true;
    const registry = new ProjectCapabilityWatcherRegistry({
      revalidate: async () => ({ ok: true }),
      onInvalidate: (_watchTarget, kind) => {
        if (explode) throw new Error('host invalidation exploded');
        kinds.push(kind);
      },
      debounceMs: 10,
      watchImpl: (() => ({ close() {}, on() {} })) as unknown as typeof import('node:fs').watch,
    });
    registries.push(registry);
    registry.acquire(target(project));

    registry.notifyChange('ws-a', 'p_' + 'a'.repeat(32), join('.nessy-agent', 'config.toml'));
    await wait(40);
    explode = false;
    registry.notifyChange('ws-a', 'p_' + 'a'.repeat(32), join('.nessy-agent', 'config.toml'));
    await wait(40);

    expect(kinds).toEqual(['content']);
    expect(registry.size()).toBe(1);
  });

  it('a host callback that throws on identity loss is contained the same way', async () => {
    // The other of the two kinds, because the identity branch is the one that
    // revokes root receipts — a throw there is the more expensive of the two.
    const project = makeProject();
    const kinds: string[] = [];
    const registry = new ProjectCapabilityWatcherRegistry({
      revalidate: async () => ({ ok: false }),
      onInvalidate: (_watchTarget, kind) => {
        kinds.push(kind);
        throw new Error('identity handler exploded');
      },
      debounceMs: 10,
      watchImpl: (() => ({ close() {}, on() {} })) as unknown as typeof import('node:fs').watch,
    });
    registries.push(registry);
    registry.acquire(target(project));

    registry.notifyChange('ws-a', 'p_' + 'a'.repeat(32), 'AGENTS.md');
    await wait(40);

    expect(kinds).toEqual(['identity']);
  });
});
