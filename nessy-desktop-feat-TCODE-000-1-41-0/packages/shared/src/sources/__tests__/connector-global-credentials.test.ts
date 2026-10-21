/**
 * T5 of the plugin-install usability plan (2026-07-31, owner § 0b-1): one
 * OAuth per server, ever — a connector credential is shared across workspaces.
 *
 * Contract proven here:
 *  - A connectorOrigin source's credential keys on the connector's stable
 *    identity in a GLOBAL scope (`{type}::@connector-global::{pluginKey}#
 *    {connectorId}#{serverName}`), so OAuth completed in workspace A makes the
 *    sibling source in workspace B usable with no second flow — and vice
 *    versa.
 *  - A plain user-created source's keying is BYTE-IDENTICAL to before.
 *  - The one-shot migration moves existing `source_oauth::{ws}::{slug}` rows
 *    for connector sources to the global slot (first-writer-wins), deletes the
 *    workspace-scoped rows, never touches a plain source's row, and is
 *    idempotent. Runs against a fixture in-memory store only.
 */

import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as credentialsIndexModule from '../../credentials/index.ts';
import * as credentialsManagerModule from '../../credentials/manager.ts';
import { credentialIdToAccount, type CredentialId, type StoredCredential } from '../../credentials/types.ts';
import { migrateConnectorSourceCredentialsToGlobal } from '../../plugins/mcp-credentials.ts';
import { createSource } from '../storage.ts';
import { SourceCredentialManager, sourceCredentialScope } from '../credential-manager.ts';
import { isSourceUsable, loadAllSources, loadSource } from '../storage.ts';
import type { LoadedSource } from '../types.ts';

let root: string;
let workspaceA: string;
let workspaceB: string;
let rows: Map<string, StoredCredential>;
const spies: Array<{ mockRestore: () => void }> = [];

function fakeCredentialManager() {
  const account = (id: CredentialId) => credentialIdToAccount(id);
  return {
    get: async (id: CredentialId) => structuredClone(rows.get(account(id)) ?? null),
    set: async (id: CredentialId, credential: StoredCredential) => {
      rows.set(account(id), structuredClone(credential));
    },
    delete: async (id: CredentialId) => rows.delete(account(id)),
    deleteSync: (id: CredentialId) => rows.delete(account(id)),
    getRuntimeCredentialStatus: (id: CredentialId) => ({
      state: rows.has(account(id)) ? 'ready' : 'missing',
      revision: 0,
    }),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'connector-global-credentials-'));
  workspaceA = join(root, 'ws_a');
  workspaceB = join(root, 'ws_b');
  mkdirSync(join(workspaceA, 'sources'), { recursive: true });
  mkdirSync(join(workspaceB, 'sources'), { recursive: true });
  rows = new Map();
  const fake = fakeCredentialManager() as never;
  // getCredentialManager is defined in credentials/manager.ts and re-exported
  // by credentials/index.ts; production code imports it from BOTH paths.
  spies.push(spyOn(credentialsManagerModule, 'getCredentialManager').mockReturnValue(fake));
  spies.push(spyOn(credentialsIndexModule, 'getCredentialManager').mockReturnValue(fake));
});

afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

/**
 * C5 deleted the materializer; these fixtures now create the connector-origin
 * source DIRECTORIES directly — the exact on-disk shape pre-C5 installs left
 * behind, which is what the surviving T5 keying/migration still serves.
 */
async function createConnectorOriginSource(
  workspaceRootPath: string,
  pluginKey: string,
  connectorId: string,
  serverName: string,
  url: string,
): Promise<void> {
  await createSource(workspaceRootPath, {
    name: serverName,
    provider: `connector:${connectorId}`,
    type: 'mcp',
    mcp: { transport: 'http', url, authType: 'oauth' },
    enabled: true,
    icon: '🔌',
    connectorOrigin: { pluginKey, connectorId, serverName, authTiming: 'ON_FIRST_USE' },
  });
}

async function materializeBoth(): Promise<{ sourceA: LoadedSource; sourceB: LoadedSource }> {
  await createConnectorOriginSource(workspaceA, 'mk.tracker', 'tracker', 'tracker-mcp', 'https://tracker.example.test/mcp');
  await createConnectorOriginSource(workspaceB, 'mk.tracker', 'tracker', 'tracker-mcp', 'https://tracker.example.test/mcp');
  const sourceA = loadAllSources(workspaceA).find(source => source.config.connectorOrigin)!;
  const sourceB = loadAllSources(workspaceB).find(source => source.config.connectorOrigin)!;
  return { sourceA, sourceB };
}

function plainSource(): LoadedSource {
  return {
    config: {
      id: 'plain-id',
      slug: 'my-tracker',
      name: 'My Tracker',
      type: 'mcp',
      enabled: true,
      mcp: { transport: 'http', url: 'https://tracker.example.test/mcp', authType: 'oauth' },
    } as LoadedSource['config'],
    guide: null,
    folderPath: join(workspaceA, 'sources', 'my-tracker'),
    workspaceRootPath: workspaceA,
    workspaceId: 'ws_a',
  };
}

describe('global connector credential keying (T5)', () => {
  test('a plain user-created source keys byte-identically to before', () => {
    const manager = new SourceCredentialManager();
    const account = credentialIdToAccount(manager.getCredentialId(plainSource()));
    expect(account).toBe('source_oauth::ws_a::my-tracker');
  });

  test('sibling connector sources in two workspaces share ONE credential slot', async () => {
    const { sourceA, sourceB } = await materializeBoth();
    const manager = new SourceCredentialManager();
    const accountA = credentialIdToAccount(manager.getCredentialId(sourceA));
    const accountB = credentialIdToAccount(manager.getCredentialId(sourceB));
    expect(accountA).toBe('source_oauth::@connector-global::mk.tracker#tracker#tracker-mcp');
    expect(accountB).toBe(accountA);
  });

  test('OAuth completed in workspace A makes the sibling source usable in workspace B — and B to A', async () => {
    const { sourceA, sourceB } = await materializeBoth();
    const manager = new SourceCredentialManager();

    // Direction A → B.
    await manager.save(sourceA, { value: 'token-from-a' });
    manager.finalizeSourceAuthentication(sourceA);
    expect(await manager.hasValidCredentials(sourceB)).toBe(true);
    const reloadedB = loadSource(workspaceB, sourceB.config.slug)!;
    // isSourceUsable is the product's own gate: enabled AND authenticated.
    expect(isSourceUsable(reloadedB)).toBe(true);

    // Direction B → A, from a clean slate.
    await manager.delete(sourceA);
    expect(await manager.hasValidCredentials(sourceA)).toBe(false);
    await manager.save(sourceB, { value: 'token-from-b' });
    manager.finalizeSourceAuthentication(sourceB);
    expect(await manager.hasValidCredentials(sourceA)).toBe(true);
    const reloadedA = loadSource(workspaceA, sourceA.config.slug)!;
    expect(isSourceUsable(reloadedA)).toBe(true);
  });

  test('sibling SERVERS of one connector still keep separate slots', async () => {
    await createConnectorOriginSource(workspaceA, 'mk.suite', 'suite', 'suite-mail', 'https://suite.example.test/mail');
    await createConnectorOriginSource(workspaceA, 'mk.suite', 'suite', 'suite-docs', 'https://suite.example.test/docs');
    const sources = loadAllSources(workspaceA).filter(source => source.config.connectorOrigin);
    const manager = new SourceCredentialManager();
    const accounts = sources.map(source => credentialIdToAccount(manager.getCredentialId(source)));
    expect(new Set(accounts).size).toBe(2);
  });
});

describe('one-shot migration to the global slot (T5)', () => {
  test('moves workspace-scoped connector rows, first-writer-wins, plain rows untouched, idempotent', async () => {
    const { sourceA, sourceB } = await materializeBoth();

    // Fixture store: legacy per-workspace rows as the pre-T5 code wrote them.
    rows.set(`source_oauth::ws_a::${sourceA.config.slug}`, { value: 'legacy-a' });
    rows.set(`source_oauth::ws_b::${sourceB.config.slug}`, { value: 'legacy-b' });
    rows.set('source_oauth::ws_a::my-tracker', { value: 'plain-row' });

    const first = await migrateConnectorSourceCredentialsToGlobal({
      workspaceRootPaths: [workspaceA, workspaceB],
    });
    expect(first.migrated).toBe(1); // first writer fills the global slot
    expect(first.deleted).toBe(2); // both workspace-scoped connector rows die

    expect(rows.get('source_oauth::@connector-global::mk.tracker#tracker#tracker-mcp'))
      .toEqual({ value: 'legacy-a' });
    expect(rows.has(`source_oauth::ws_a::${sourceA.config.slug}`)).toBe(false);
    expect(rows.has(`source_oauth::ws_b::${sourceB.config.slug}`)).toBe(false);
    // The plain user-created source's row is not a connector row: untouched.
    expect(rows.get('source_oauth::ws_a::my-tracker')).toEqual({ value: 'plain-row' });

    const second = await migrateConnectorSourceCredentialsToGlobal({
      workspaceRootPaths: [workspaceA, workspaceB],
    });
    expect(second).toEqual({ migrated: 0, deleted: 0 });
  });
});

describe('scope helper (T5)', () => {
  test('sourceCredentialScope routes connectorOrigin sources globally and plain sources per-workspace', () => {
    expect(sourceCredentialScope(plainSource())).toEqual({ workspaceId: 'ws_a', sourceId: 'my-tracker' });
    expect(sourceCredentialScope({
      workspaceId: 'ws_a',
      config: {
        slug: 'whatever',
        connectorOrigin: { pluginKey: 'mk.p', connectorId: 'c', serverName: 's' },
      },
    })).toEqual({ workspaceId: '@connector-global', sourceId: 'mk.p#c#s' });
  });
});
