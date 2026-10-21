/**
 * P2.184 — the one field in the market skill-files loop that THREW where every
 * sibling returns a named `fail(...)`.
 *
 * `entry.path`, `entry.digest`, `entry.downloadUrl`'s presence, an unsafe path
 * and a foreign origin each return a typed refusal with `{ path }` on it.
 * `new URL(downloadUrl, listingUrl)` did not: on a malformed value it threw,
 * and the function's outer catch renamed the fault
 * `plugin.install.skill_files_fetch_failed` — "the request failed" — for a
 * listing that was never requestable, dropping the `{ path }` that says which
 * entry. The listing is market-supplied, so the operand is upstream-controlled.
 *
 * The refusal stays whole-snapshot (a partially staged skill tree is not a
 * skill); what changes is that it is NAMED like its siblings.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PluginInstallService } from '../acquisition.ts';
import type { DpSessionBroker } from '../../auth/dp/session-broker.ts';

let tempDir: string;

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'p2184-skill-files-')); });
afterEach(() => {
  if (tempDir.startsWith(tmpdir())) rmSync(tempDir, { recursive: true, force: true });
});

const HERMETIC_DP_BROKER: DpSessionBroker = {
  async probe() { return { state: 'ready', token: 'test-dp-token' } as never; },
  async ensure() { return { state: 'ready', token: 'test-dp-token' } as never; },
  async withAccessToken(operation) { return operation('test-dp-token'); },
  subscribe() { return () => {}; },
  cancel() { return false; },
  dispose() {},
};

const FILES_URL = 'https://market.example.com/api/v2/skills/skl_1/snapshots/snp_1/files';
const BYTES = Buffer.from('# Review\n');
const DIGEST = `sha256:${createHash('sha256').update(BYTES).digest('hex')}`;

/** Stage a market skill install whose listing is `listing`. */
async function stageWithListing(listing: unknown) {
  const fetchImpl = (async (url: string | URL | Request) => {
    if (url.toString().includes('/files')) {
      return new Response(JSON.stringify(listing), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(BYTES, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  }) as unknown as typeof fetch;

  const service = new PluginInstallService({
    baseTempDir: join(tempDir, 'stages'),
    fetchImpl,
    now: () => 10_000,
    dpSessionBroker: HERMETIC_DP_BROKER,
  });
  const source = {
    kind: 'marketplace-skill-files' as const,
    filesUrl: FILES_URL,
    pluginId: 'marketplace-skill-review',
    skillSlug: 'review',
    name: 'Review',
  };
  const plan = await service.createInstallPlanFromSource(source, {});
  return service.stageInstall(plan, {});
}

describe('a market skill listing entry whose downloadUrl will not parse', () => {
  it('is refused with the LISTING_INVALID name its siblings use, carrying the path', async () => {
    const staged = await stageWithListing({
      // A space inside the host. Measured against `new URL(x, base)`: this
      // is one of the shapes that actually THROWS rather than resolving as a
      // relative path — `//`, `http://%` and `https://` are others, and all of
      // them are a typo away in a hand-edited catalog row.
      files: [{ path: 'SKILL.md', digest: DIGEST, downloadUrl: 'https://exa mple.com/x' }],
    });

    const errors = staged.diagnostics.filter(diagnostic => diagnostic.severity === 'error');
    // Identity on the code, not "some error was reported" — the whole defect
    // was that an error WAS reported, under the wrong name.
    expect(errors.map(diagnostic => diagnostic.code)).toEqual(['plugin.install.skill_files_listing_invalid']);
    expect(errors[0]?.code).not.toBe('plugin.install.skill_files_fetch_failed');
    expect((errors[0]?.details as { path?: string } | undefined)?.path).toBe('SKILL.md');
  });

  it('names the bad entry even when good entries precede it', async () => {
    const staged = await stageWithListing({
      files: [
        { path: 'SKILL.md', digest: DIGEST, downloadUrl: '/v2/skills/skl_1/snapshots/snp_1/content?path=SKILL.md' },
        { path: 'docs/notes.md', digest: DIGEST, downloadUrl: '//' },
      ],
    });

    const errors = staged.diagnostics.filter(diagnostic => diagnostic.severity === 'error');
    expect(errors.map(diagnostic => diagnostic.code)).toEqual(['plugin.install.skill_files_listing_invalid']);
    expect((errors[0]?.details as { path?: string } | undefined)?.path).toBe('docs/notes.md');
  });

  it('POSITIVE CONTROL: the same listing with a parseable url is not refused here', async () => {
    // Without this the assertions above are satisfied by a path that refuses
    // every listing, and "it named the right entry" means nothing.
    const staged = await stageWithListing({
      files: [{ path: 'SKILL.md', digest: DIGEST, downloadUrl: '/v2/skills/skl_1/snapshots/snp_1/content?path=SKILL.md' }],
    });

    const codes = staged.diagnostics
      .filter(diagnostic => diagnostic.severity === 'error')
      .map(diagnostic => diagnostic.code);
    expect(codes).toEqual([]);
  });

  it('POSITIVE CONTROL: a foreign-origin url still gets its OWN name, not this one', async () => {
    // The sibling refusals must not have been collapsed into the new branch.
    const staged = await stageWithListing({
      files: [{ path: 'SKILL.md', digest: DIGEST, downloadUrl: 'https://evil.example.com/steal' }],
    });

    const codes = staged.diagnostics
      .filter(diagnostic => diagnostic.severity === 'error')
      .map(diagnostic => diagnostic.code);
    expect(codes).toEqual(['plugin.install.skill_files_foreign_origin']);
  });
});
