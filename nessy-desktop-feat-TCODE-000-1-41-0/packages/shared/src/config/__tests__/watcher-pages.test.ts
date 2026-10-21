/**
 * UA6.2 — the watcher's `pages/` branch (v0.13.4 `config/watcher.ts`, Apache-2.0): `pages/{slug}/page.json` and a
 * slug folder's add/remove fire `onPagesListChange` with the reloaded list; `data/` churn (the private sqlite store,
 * the snapshot and its tmp files) never fires it. Driven through `notifyFileChange`, the same entry the host uses
 * after its own writes, so the routing is measured without depending on fs.watch timing. UA8.2 adds the host-written
 * refresh script `pages/{slug}/refresh.ts` as a trigger.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigWatcher } from '../watcher.ts';
import { createPage } from '../../pages/storage.ts';
import type { LoadedPage } from '../../pages/types.ts';

let workspaceRoot: string;
let watcher: ConfigWatcher | undefined;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'nessy-watcher-pages-'));
});
afterEach(() => {
  watcher?.stop();
  watcher = undefined;
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function runningWatcher(onPagesListChange: (pages: LoadedPage[]) => void): ConfigWatcher {
  const created = new ConfigWatcher(workspaceRoot, { onPagesListChange }, 'ws-pages');
  (created as unknown as { isRunning: boolean }).isRunning = true;
  watcher = created;
  return created;
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('ConfigWatcher pages branch', () => {
  it('page.json fires once per debounce window with the reloaded list', async () => {
    const page = createPage(workspaceRoot, { name: 'Build Health', content: '<p>x</p>' });
    const calls: LoadedPage[][] = [];
    const w = runningWatcher(pages => calls.push(pages));
    w.notifyFileChange(`pages/${page.slug}/page.json`);
    w.notifyFileChange(`pages/${page.slug}/page.json`);
    await wait(300);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.map(p => p.config.slug)).toEqual([page.slug]);
  });

  it('a slug folder added or removed fires too', async () => {
    const calls: LoadedPage[][] = [];
    const w = runningWatcher(pages => calls.push(pages));
    w.notifyFileChange('pages/new-page');
    await wait(300);
    expect(calls).toHaveLength(1);
  });

  it('data/ churn, index.html and the thumbnail do not fire the watcher', async () => {
    const page = createPage(workspaceRoot, { name: 'Quiet', content: '<p>x</p>' });
    const calls: LoadedPage[][] = [];
    const w = runningWatcher(pages => calls.push(pages));
    for (const file of ['data/store.sqlite', 'data/store.sqlite-wal', 'data/snapshot.json', 'data/.snapshot.json.tmp', 'data', 'index.html', 'thumbnail.jpg']) {
      w.notifyFileChange(`pages/${page.slug}/${file}`);
    }
    w.notifyFileChange('pages');
    await wait(300);
    expect(calls).toEqual([]);
    // Control on the same instrument: the completion marker does fire.
    w.notifyFileChange(`pages/${page.slug}/page.json`);
    await wait(300);
    expect(calls).toHaveLength(1);
  });

  it('UA8.2: the host-written refresh script fires (an edit re-reads the refresh approval); a refresh.ts deeper in the page does not', async () => {
    const page = createPage(workspaceRoot, { name: 'Refreshing', content: '<p>x</p>' });
    const calls: LoadedPage[][] = [];
    const w = runningWatcher(pages => calls.push(pages));
    w.notifyFileChange(`pages/${page.slug}/data/refresh.ts`);
    w.notifyFileChange(`pages/${page.slug}/refresh.js`);
    await wait(300);
    expect(calls).toEqual([]);
    w.notifyFileChange(`pages/${page.slug}/refresh.ts`);
    await wait(300);
    expect(calls).toHaveLength(1);
  });

  it('a changed file elsewhere in the workspace is not a pages change', async () => {
    const calls: LoadedPage[][] = [];
    const w = runningWatcher(pages => calls.push(pages));
    w.notifyFileChange('skills/x/page.json');
    w.notifyFileChange('labels/page.json');
    await wait(300);
    expect(calls).toEqual([]);
  });
});
