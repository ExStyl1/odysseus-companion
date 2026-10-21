/**
 * D3 — `source_manage`.
 *
 * The point of the tool is that both actions go through the SAME writers the
 * UI uses: the validated `saveSourceConfig` for `disable`, and the shared
 * `removeSourceEverywhere` (via the host seam) for `remove`. These assert the
 * writers are CALLED, never that a copy of their behaviour happened.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleSourceManage } from './source-manage.ts';
import type { SessionToolContext } from '../context.ts';
import type { SourceConfig } from '../types.ts';

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nessy-source-manage-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeSource(slug: string, config: Record<string, unknown>): void {
  const path = join(dir, 'sources', slug);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'config.json'), JSON.stringify({ slug, name: slug, type: 'mcp', enabled: true, ...config }));
}

function makeCtx(options: { saved?: SourceConfig[]; removed?: string[]; withRemove?: boolean } = {}): SessionToolContext {
  return {
    workspacePath: dir,
    loadSourceConfig: (slug: string) => {
      try {
        return JSON.parse(
          require('node:fs').readFileSync(join(dir, 'sources', slug, 'config.json'), 'utf-8'),
        ) as SourceConfig;
      } catch {
        return null;
      }
    },
    saveSourceConfig: (source: SourceConfig) => { options.saved?.push(source); },
    ...(options.withRemove === false ? {} : {
      removeSource: async (slug: string) => { options.removed?.push(slug); },
    }),
  } as unknown as SessionToolContext;
}

function text(result: { content: Array<{ text: string }> }): string {
  return result.content[0]!.text;
}

describe('source_manage', () => {
  it('disables through the validated writer, keeping config and credentials', async () => {
    writeSource('jira', {});
    const saved: SourceConfig[] = [];

    const result = await handleSourceManage(makeCtx({ saved }), { sourceSlug: 'jira', action: 'disable' });

    expect(result.isError).not.toBe(true);
    // The validated writer got the whole config with only `enabled` flipped —
    // no raw file write, nothing else rewritten.
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ slug: 'jira', enabled: false, type: 'mcp' });
    expect(text(result)).toContain('disabled');
  });

  it('removes through the host seam — the same three-op cleanup as the UI channel', async () => {
    writeSource('jira', {});
    const removed: string[] = [];
    const saved: SourceConfig[] = [];

    const result = await handleSourceManage(makeCtx({ saved, removed }), { sourceSlug: 'jira', action: 'remove' });

    expect(result.isError).not.toBe(true);
    expect(removed).toEqual(['jira']);
    // Remove is not disable-plus-delete: it must not write a config on its way out.
    expect(saved).toEqual([]);
  });

  it('refuses honestly when the host wired no removal seam', async () => {
    writeSource('jira', {});

    const result = await handleSourceManage(
      makeCtx({ withRemove: false }),
      { sourceSlug: 'jira', action: 'remove' },
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('not available');
  });

  it('reports a failed removal instead of throwing into the turn', async () => {
    writeSource('jira', {});
    const ctx = {
      ...makeCtx(),
      removeSource: async () => { throw new Error('workspace is read-only'); },
    } as unknown as SessionToolContext;

    const result = await handleSourceManage(ctx, { sourceSlug: 'jira', action: 'remove' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('workspace is read-only');
  });

  it('refuses an unknown source and an unknown action', async () => {
    writeSource('jira', {});

    const missing = await handleSourceManage(makeCtx(), { sourceSlug: 'nope', action: 'remove' });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain('does not exist');

    const bogus = await handleSourceManage(
      makeCtx(),
      { sourceSlug: 'jira', action: 'delete' as unknown as 'remove' },
    );
    expect(bogus.isError).toBe(true);
    expect(text(bogus)).toContain('disable');
  });
});
