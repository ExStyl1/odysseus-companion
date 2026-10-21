/**
 * Tests for the Bun-only SQLite page data store (bun:sqlite — these tests
 * run under `bun test`, which always has the module).
 *
 * UA6.1 — copied from craft-agents-oss `v0.13.4:packages/shared/src/pages/data-store.test.ts` (Apache-2.0); the
 * upstream suite is unchanged, the `pages-index-no-bun-sqlite` describe at the end (and its imports) is ours.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { openPageDataStore, PageDataStore, PAGE_DATA_MAX_KV_KEYS, PAGE_DATA_MAX_SERIES } from './data-store.ts';
import { getPageSnapshotPath, getPageStorePath } from './storage.ts';

describe('pages/data-store', () => {
  let workspaceDir: string;
  let store: PageDataStore;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'page-data-store-test-'));
    store = openPageDataStore(workspaceDir, 'dash');
  });

  afterEach(() => {
    store.close();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  describe('key-value', () => {
    it('round-trips JSON values', () => {
      store.kvSet('summary', { total: 42, items: ['a', 'b'] });
      store.kvSet('label', 'hello');
      store.kvSet('nullish', null);

      expect(store.kvGet<{ total: number; items: string[] }>('summary')).toEqual({ total: 42, items: ['a', 'b'] });
      expect(store.kvGet<string>('label')).toBe('hello');
      expect(store.kvGet('nullish')).toBeNull();
      expect(store.kvGet('missing')).toBeUndefined();
    });

    it('overwrites, deletes, and lists entries', () => {
      store.kvSet('k', 1);
      store.kvSet('k', 2);
      store.kvSet('other', true);

      expect(store.kvGet<number>('k')).toBe(2);
      expect(store.kvEntries()).toEqual({ k: 2, other: true });
      expect(store.kvDelete('k')).toBe(true);
      expect(store.kvDelete('k')).toBe(false);
      expect(store.kvEntries()).toEqual({ other: true });
    });
  });

  describe('timeseries', () => {
    it('appends, ranges, and reports latest in ascending order', () => {
      store.seriesAppendMany('revenue', [
        { t: 300, v: 3 },
        { t: 100, v: 1 },
        { t: 200, v: 2 },
      ]);

      expect(store.seriesRange('revenue')).toEqual([
        { t: 100, v: 1 },
        { t: 200, v: 2 },
        { t: 300, v: 3 },
      ]);
      expect(store.seriesRange('revenue', { from: 150, to: 250 })).toEqual([{ t: 200, v: 2 }]);
      expect(store.seriesRange('revenue', { limit: 2 })).toEqual([
        { t: 200, v: 2 },
        { t: 300, v: 3 },
      ]);
      expect(store.seriesLatest('revenue')).toEqual({ t: 300, v: 3 });
      expect(store.seriesLatest('missing')).toBeUndefined();
      expect(store.seriesNames()).toEqual(['revenue']);
    });

    it('is idempotent on (series, t) and prunes old points', () => {
      store.seriesAppend('cpu', { t: 100, v: 1 });
      store.seriesAppend('cpu', { t: 100, v: 9 });
      expect(store.seriesRange('cpu')).toEqual([{ t: 100, v: 9 }]);

      store.seriesAppend('cpu', { t: 200, v: 2 });
      expect(store.seriesPrune('cpu', 150)).toBe(1);
      expect(store.seriesRange('cpu')).toEqual([{ t: 200, v: 2 }]);
    });

    it('defaults t to now', () => {
      const before = Date.now();
      store.seriesAppend('ticks', { v: 5 });
      const latest = store.seriesLatest('ticks')!;
      expect(latest.v).toBe(5);
      expect(latest.t).toBeGreaterThanOrEqual(before);
    });
  });

  describe('growth caps', () => {
    it('rejects the kv write that would exceed the key cap and rolls it back', () => {
      for (let i = 0; i < PAGE_DATA_MAX_KV_KEYS; i++) {
        store.kvSet(`k${i}`, i);
      }
      expect(() => store.kvSet('one-too-many', 1)).toThrow(/kv keys > max/);
      // Rolled back: the offending key is gone and the count did not grow.
      expect(store.kvGet('one-too-many')).toBeUndefined();
      expect(Object.keys(store.kvEntries()).length).toBe(PAGE_DATA_MAX_KV_KEYS);
      // Updating an EXISTING key at the cap is fine — no growth.
      store.kvSet('k0', 'updated');
      expect(store.kvGet<string>('k0')).toBe('updated');
    });

    it('rejects the series write that would exceed the series cap and rolls it back', () => {
      for (let i = 0; i < PAGE_DATA_MAX_SERIES; i++) {
        store.seriesAppend(`s${i}`, { t: 1, v: i });
      }
      expect(() => store.seriesAppend('one-too-many', { t: 1, v: 1 })).toThrow(/series > max/);
      expect(() => store.seriesAppendMany('one-too-many', [{ t: 1, v: 1 }, { t: 2, v: 2 }])).toThrow(/series > max/);
      expect(store.seriesNames().length).toBe(PAGE_DATA_MAX_SERIES);
      expect(store.seriesLatest('one-too-many')).toBeUndefined();
      // Appending to an EXISTING series at the cap is fine — no growth.
      store.seriesAppend('s0', { t: 2, v: 99 });
      expect(store.seriesLatest('s0')).toEqual({ t: 2, v: 99 });
    });
  });

  describe('snapshot export', () => {
    it('writes snapshot.json atomically with kv + capped series', () => {
      store.kvSet('total', 42);
      for (let i = 0; i < 10; i++) {
        store.seriesAppend('s', { t: i, v: i });
      }

      const snapshot = store.exportSnapshot({ maxPointsPerSeries: 3 });
      expect(snapshot.version).toBe(1);
      expect(snapshot.kv.total).toBe(42);
      // Newest 3 points, ascending
      expect(snapshot.series.s).toEqual([
        { t: 7, v: 7 },
        { t: 8, v: 8 },
        { t: 9, v: 9 },
      ]);

      const snapshotPath = getPageSnapshotPath(workspaceDir, 'dash');
      expect(existsSync(snapshotPath)).toBe(true);
      expect(existsSync(snapshotPath + '.tmp')).toBe(false);
      const onDisk = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
      expect(onDisk).toEqual(JSON.parse(JSON.stringify(snapshot)));
    });

    it('persists across store reopen (sqlite file is the working store)', () => {
      store.kvSet('persist', 'yes');
      store.close();

      store = openPageDataStore(workspaceDir, 'dash');
      expect(store.kvGet<string>('persist')).toBe('yes');
      expect(existsSync(getPageStorePath(workspaceDir, 'dash'))).toBe(true);
    });
  });
});

/**
 * UA6.1 negative arm (spec §17 S15, `bun:sqlite` in Node bundles): `pages/index.ts` — the barrel the Electron
 * main process (Node) and the renderer import — must never reach `bun:sqlite`, statically or transitively.
 * Only `@nessy-agent/shared/pages/data-store` may (a Bun-only subpath, never re-exported from the barrel).
 *
 * The instrument is Bun's own import scanner (`Bun.Transpiler.scanImports`): it reports runtime imports only —
 * type-only imports are erased under `verbatimModuleSyntax`, so they are not edges — and it does not read
 * string contents, so data-write.ts's generated one-shot script (which spells `from 'bun:sqlite'` inside a
 * template literal) is correctly not an edge. Relative and `@nessy-agent/*` specifiers are followed through
 * `Bun.resolveSync`; every other bare specifier is recorded, not followed.
 */
describe('pages-index-no-bun-sqlite', () => {
  const transpiler = new Bun.Transpiler({ loader: 'ts' });

  function walk(entry: string): { files: Set<string>; specifiers: Set<string> } {
    const files = new Set<string>();
    const specifiers = new Set<string>();
    const queue = [realpathSync(entry)];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (files.has(file)) continue;
      files.add(file);
      for (const { path } of transpiler.scanImports(readFileSync(file, 'utf-8'))) {
        specifiers.add(path);
        if (!path.startsWith('.') && !path.startsWith('@nessy-agent/')) continue;
        const resolved = realpathSync(Bun.resolveSync(path, dirname(file)));
        if (!resolved.includes(`${sep}node_modules${sep}`) && /\.(ts|tsx|mts|js|mjs)$/.test(resolved)) {
          queue.push(resolved);
        }
      }
    }
    return { files, specifiers };
  }

  const pagesDir = import.meta.dir;

  it('pages/index.ts reaches no bun:sqlite import (and the walk really covers the barrel graph)', () => {
    const { files, specifiers } = walk(join(pagesDir, 'index.ts'));
    expect(specifiers.has('bun:sqlite')).toBe(false);
    // The walk is not vacuous: it went through every pages module the barrel re-exports and across the
    // package edge into session-tools-core (data-write.ts imports resolveScriptRuntime from its root).
    for (const leaf of ['storage.ts', 'validation.ts', 'data-write.ts', 'data-store-constants.ts', 'types.ts']) {
      expect(files.has(realpathSync(join(pagesDir, leaf)))).toBe(true);
    }
    expect([...files].some((f) => f.endsWith(join('session-tools-core', 'src', 'index.ts')))).toBe(true);
    expect(files.has(realpathSync(join(pagesDir, 'data-store.ts')))).toBe(false);
  });

  it('positive control: the same walk from data-store.ts does report bun:sqlite', () => {
    expect(walk(join(pagesDir, 'data-store.ts')).specifiers.has('bun:sqlite')).toBe(true);
  });

  it('boundary: the bun:sqlite import spelled inside data-write.ts\'s generated script is not an edge', () => {
    const source = readFileSync(join(pagesDir, 'data-write.ts'), 'utf-8');
    expect(source).toContain("from 'bun:sqlite'");
    expect(walk(join(pagesDir, 'data-write.ts')).specifiers.has('bun:sqlite')).toBe(false);
  });
});
