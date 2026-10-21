/** UA1.16 — the per-workspace artifact registry (0600, durable, fail-closed on a corrupt file, O22 `kind`). */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SAFE_MODE_CONFIG } from '../agent/mode-types.ts';
import { getAttachmentReadFloorViolation } from '../agent/mode-manager.ts';
import { T_ARTIFACTS_ORIGIN, createTArtifactsClient, type ArtifactRecord } from './t-artifacts-client.ts';
import {
  ARTIFACT_REGISTRY_DENIED_PATH_PATTERN,
  ArtifactRegistryError,
  artifactEntryKind,
  artifactRegistryPath,
  keepArtifactPendingDelete,
  listPendingArtifactDeletes,
  listSessionArtifacts,
  markArtifactPendingDelete,
  readArtifactRegistry,
  recordArtifactPublish,
  recordArtifactUpdate,
  removeArtifactRegistryEntry,
} from './registry.ts';

const ID = 'AbCdEfGhIjKlMnOpQrStUv';
const URL_ = `${T_ARTIFACTS_ORIGIN}/a/${ID}`;
const RECORD: ArtifactRecord = { id: ID, url: URL_, title: 'Report', expiresAt: '2026-10-09T00:00:00.000Z', retentionDays: 7 };

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ua116-registry-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function publish(overrides: Partial<Parameters<typeof recordArtifactPublish>[1]> = {}) {
  return recordArtifactPublish(root, {
    record: RECORD, sourceSessionId: 's1', sourcePath: 'out/report.html', contentDigest: 'a'.repeat(64), ...overrides,
  });
}

describe('UA1.16 registry', () => {
  test('a missing registry is empty; a publish writes <root>/artifacts/registry.json with mode 0600', () => {
    expect(readArtifactRegistry(root)).toEqual([]);
    const entry = publish({ now: new Date('2026-10-02T10:00:00.000Z') });
    expect(entry).toEqual({
      ...RECORD, createdAt: '2026-10-02T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z',
      sourceSessionId: 's1', sourcePath: 'out/report.html', contentDigest: 'a'.repeat(64),
    });
    const path = artifactRegistryPath(root);
    expect(path).toBe(join(root, 'artifacts', 'registry.json'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readArtifactRegistry(root)).toEqual([entry]);
  });

  test('O22: kind is optional — absent reads as file; page and chat are stored', () => {
    const file = publish();
    expect(file).not.toHaveProperty('kind');
    expect(artifactEntryKind(file)).toBe('file');
    const chat = publish({ record: { ...RECORD, id: 'ZyXwVuTsRqPoNmLkJiHgFe', url: `${T_ARTIFACTS_ORIGIN}/a/ZyXwVuTsRqPoNmLkJiHgFe` }, kind: 'chat' });
    expect(artifactEntryKind(chat)).toBe('chat');
    expect(readArtifactRegistry(root).map(artifactEntryKind)).toEqual(['file', 'chat']);
  });

  test('list_artifacts sees only the calling session\'s entries', () => {
    publish();
    publish({ record: { ...RECORD, id: 'ZyXwVuTsRqPoNmLkJiHgFe' }, sourceSessionId: 's2' });
    expect(listSessionArtifacts(root, 's1').map(entry => entry.id)).toEqual([ID]);
    expect(listSessionArtifacts(root, 'nobody')).toEqual([]);
  });

  test('an update WITHOUT retention_days leaves expiresAt unchanged — driven through the client and a fake service', async () => {
    publish();
    // The fake service echoes an expiry it would NOT keep, to prove the host does not take it on trust
    // when no retention was sent; and a second arm where the server omits the fields altogether.
    const answers = [
      { id: ID, url: URL_, title: 'Report v2', expires_at: '2099-01-01T00:00:00Z', retention_days: 30 },
      { id: ID, url: URL_, title: 'Report v3' },
    ];
    for (const answer of answers) {
      const client = createTArtifactsClient({
        fetch: async () => new Response(JSON.stringify(answer), { status: 200 }),
        printToken: async () => ['fake', 'token', String(process.pid)].join('-'),
        resolveDpRuntime: () => ({ dpPath: '/nonexistent/dp', source: 'system' }),
        env: {},
      });
      const record = await client.updateArtifact({ id: ID }, { content: 'x', contentType: 'markdown', title: answer.title, emoji: '\u{1F4C4}' });
      const updated = recordArtifactUpdate(root, { record, retentionSent: false, contentDigest: 'b'.repeat(64) });
      expect(updated.expiresAt).toBe(RECORD.expiresAt);
      expect(updated.retentionDays).toBe(7);
      expect(updated.title).toBe(answer.title);
      expect(updated.contentDigest).toBe('b'.repeat(64));
    }
  });

  test('an update WITH retention_days takes the service\'s new expiry (control)', () => {
    publish();
    const updated = recordArtifactUpdate(root, { record: { ...RECORD, expiresAt: null, retentionDays: 0 }, retentionSent: true });
    expect(updated.expiresAt).toBeNull();
    expect(updated.retentionDays).toBe(0);
  });

  test('an update of an id not in the registry is refused', () => {
    expect(() => recordArtifactUpdate(root, { record: RECORD, retentionSent: false })).toThrow(ArtifactRegistryError);
  });

  test('a failed DELETE is kept as a pending deletion and never dropped; a successful one removes the entry', () => {
    publish();
    markArtifactPendingDelete(root, ID, 'network', new Date('2026-10-02T11:00:00.000Z'));
    const again = markArtifactPendingDelete(root, ID, 'needs-login', new Date('2026-10-03T11:00:00.000Z'));
    expect(again.pendingDelete).toEqual({ requestedAt: '2026-10-02T11:00:00.000Z', lastErrorKind: 'needs-login' });
    expect(listPendingArtifactDeletes(root).map(entry => entry.id)).toEqual([ID]);
    expect(removeArtifactRegistryEntry(root, ID)).toBe(true);
    expect(readArtifactRegistry(root)).toEqual([]);
    expect(removeArtifactRegistryEntry(root, ID)).toBe(false);
  });

  test('a corrupt registry is never overwritten (its pending deletions would be lost)', () => {
    mkdirSync(join(root, 'artifacts'), { recursive: true });
    writeFileSync(artifactRegistryPath(root), '{"version":1,"entries":[{"id":');
    expect(() => readArtifactRegistry(root)).toThrow(ArtifactRegistryError);
    expect(() => publish()).toThrow(ArtifactRegistryError);
    expect(readFileSync(artifactRegistryPath(root), 'utf-8')).toBe('{"version":1,"entries":[{"id":');
  });

  test('the registry path is on the read floor: in SAFE_MODE_CONFIG.deniedPaths and refused by the Read matcher', () => {
    expect(SAFE_MODE_CONFIG.deniedPaths).toContain(ARTIFACT_REGISTRY_DENIED_PATH_PATTERN);
    const managed = join(root, 'workspaces', 'b7e0c1a2-0000-4000-8000-000000000000', 'artifacts', 'registry.json');
    expect(getAttachmentReadFloorViolation(managed, null)?.pattern).toBe(ARTIFACT_REGISTRY_DENIED_PATH_PATTERN);
    // Control: a project's own artifacts/registry.json (not under workspaces/<id>) stays readable.
    expect(getAttachmentReadFloorViolation(join(root, 'my-project', 'artifacts', 'registry.json'), null)).toBeNull();
  });
});

describe('UA1.19 keepArtifactPendingDelete', () => {
  test('a page published outside this workspace gets a minimal entry carrying only the pending deletion', () => {
    const entry = keepArtifactPendingDelete(root, { ...RECORD, retentionDays: Number.NaN }, 'needs-login', new Date('2026-10-02T12:00:00.000Z'));
    expect(entry).toMatchObject({ id: ID, url: URL_, sourceSessionId: '', sourcePath: '', contentDigest: '', retentionDays: -1 });
    expect(entry.pendingDelete).toEqual({ requestedAt: '2026-10-02T12:00:00.000Z', lastErrorKind: 'needs-login' });
    // It survives a reread (the JSON round trip) and is listed as owed — and no session, so no model, sees it.
    expect(listPendingArtifactDeletes(root).map(item => item.id)).toEqual([ID]);
    expect(listSessionArtifacts(root, '')).toHaveLength(1);
    expect(listSessionArtifacts(root, 's1')).toEqual([]);
  });

  test('an entry the workspace holds is marked, not duplicated, and keeps its first request time', () => {
    publish();
    keepArtifactPendingDelete(root, RECORD, 'network', new Date('2026-10-02T12:00:00.000Z'));
    keepArtifactPendingDelete(root, RECORD, 'needs-login', new Date('2026-10-03T12:00:00.000Z'));
    const entries = readArtifactRegistry(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.sourceSessionId).toBe('s1');
    expect(entries[0]!.pendingDelete).toEqual({ requestedAt: '2026-10-02T12:00:00.000Z', lastErrorKind: 'needs-login' });
  });
});
