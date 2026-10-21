/**
 * C4 of the capability-path plan: the copy-only credential migration.
 *
 * T5's global connector-source rows
 * (`source_{oauth|bearer}::@connector-global::{pluginKey}#{connectorId}#{serverName}`)
 * COPY into the plugin MCP slots
 * (`plugin_mcp_{oauth|bearer}::{pluginKey}::{serverName}`).
 *
 * Iron rules proven here (§ 8): no source row is ever deleted or overwritten
 * (byte-identical before/after — the downgrade guarantee); a filled plugin
 * slot is never clobbered; a per-row failure never throws, leaves the old rows
 * authoritative, and the NEXT run picks the row up; the whole thing is
 * idempotent with no marker.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as credentialsIndexModule from '../../credentials/index.ts';
import * as credentialsManagerModule from '../../credentials/manager.ts';
import { credentialIdToAccount, type CredentialId, type StoredCredential } from '../../credentials/types.ts';
import { migrateConnectorCredentialsToPluginSlots } from '../mcp-credentials.ts';

let rows: Map<string, StoredCredential>;
let failSetAccounts: Set<string>;
const spies: Array<{ mockRestore: () => void }> = [];

function fakeCredentialManager() {
  const account = (id: CredentialId) => credentialIdToAccount(id);
  return {
    get: async (id: CredentialId) => structuredClone(rows.get(account(id)) ?? null),
    set: async (id: CredentialId, credential: StoredCredential) => {
      if (failSetAccounts.has(account(id))) throw new Error('encrypted-store-write-failed');
      rows.set(account(id), structuredClone(credential));
    },
    delete: async (id: CredentialId) => rows.delete(account(id)),
    deleteSync: (id: CredentialId) => rows.delete(account(id)),
    list: async (filter?: Partial<CredentialId>) => (
      [...rows.keys()]
        .map(key => {
          const parts = key.split('::');
          return { type: parts[0], workspaceId: parts[1], sourceId: parts[2] } as CredentialId;
        })
        .filter(id => (!filter?.type || id.type === filter.type)
          && (!filter?.workspaceId || id.workspaceId === filter.workspaceId))
    ),
    getRuntimeCredentialStatus: (id: CredentialId) => ({
      state: rows.has(account(id)) ? 'ready' : 'missing',
      revision: 0,
    }),
  };
}

beforeEach(() => {
  rows = new Map();
  failSetAccounts = new Set();
  const fake = fakeCredentialManager() as never;
  spies.push(spyOn(credentialsManagerModule, 'getCredentialManager').mockReturnValue(fake));
  spies.push(spyOn(credentialsIndexModule, 'getCredentialManager').mockReturnValue(fake));
});

afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

const ACTIVE = new Set(['mk.tracker', 'mk.suite']);

function seedFixtureStore(): Map<string, StoredCredential> {
  rows.set('source_oauth::@connector-global::mk.tracker#tracker#tracker-mcp', {
    value: 'tracker-access', refreshToken: 'tracker-refresh', expiresAt: 4102444800000, clientId: 'client-1',
  });
  rows.set('source_bearer::@connector-global::mk.suite#suite#suite-mail', { value: 'suite-bearer' });
  // Stale pluginKey (no active install): SKIPPED, never purged (iron rule).
  rows.set('source_oauth::@connector-global::mk.gone#gone#gone-mcp', { value: 'gone-token' });
  // Malformed source id: skipped.
  rows.set('source_oauth::@connector-global::not-a-connector-key', { value: 'weird' });
  // A plain per-workspace row: untouched and not a migration input.
  rows.set('source_oauth::ws_a::my-tracker', { value: 'plain-row' });
  return new Map([...rows].map(([key, value]) => [key, structuredClone(value)]));
}

describe('migrateConnectorCredentialsToPluginSlots', () => {
  test('copies active rows, skips stale/malformed, and leaves EVERY source row byte-identical', async () => {
    const before = seedFixtureStore();

    const result = await migrateConnectorCredentialsToPluginSlots({ activePluginKeys: ACTIVE });

    expect(result).toEqual({ copied: 2, skipped: 2, failed: 0 });
    expect(rows.get('plugin_mcp_oauth::mk.tracker::tracker-mcp')).toEqual({
      value: 'tracker-access', refreshToken: 'tracker-refresh', expiresAt: 4102444800000, clientId: 'client-1',
    });
    expect(rows.get('plugin_mcp_bearer::mk.suite::suite-mail')).toEqual({ value: 'suite-bearer' });
    expect(rows.has('plugin_mcp_oauth::mk.gone::gone-mcp')).toBe(false);

    // The downgrade guarantee: every pre-migration row still present, byte-identical.
    for (const [key, value] of before) {
      expect(rows.get(key)).toEqual(value);
    }

    // Idempotent with no marker: a second run copies nothing.
    expect(await migrateConnectorCredentialsToPluginSlots({ activePluginKeys: ACTIVE }))
      .toEqual({ copied: 0, skipped: 4, failed: 0 });
  });

  test('never clobbers a plugin slot a C-build refresh already updated', async () => {
    seedFixtureStore();
    rows.set('plugin_mcp_oauth::mk.tracker::tracker-mcp', { value: 'refreshed-under-c' });

    await migrateConnectorCredentialsToPluginSlots({ activePluginKeys: ACTIVE });

    expect(rows.get('plugin_mcp_oauth::mk.tracker::tracker-mcp')).toEqual({ value: 'refreshed-under-c' });
  });

  test('a per-row write failure never throws, old rows stay authoritative, and the NEXT run recovers it', async () => {
    const before = seedFixtureStore();
    failSetAccounts.add('plugin_mcp_oauth::mk.tracker::tracker-mcp');

    const failing = await migrateConnectorCredentialsToPluginSlots({ activePluginKeys: ACTIVE });
    expect(failing).toEqual({ copied: 1, skipped: 2, failed: 1 });
    expect(rows.has('plugin_mcp_oauth::mk.tracker::tracker-mcp')).toBe(false);
    // The other row still copied; every source row untouched.
    expect(rows.get('plugin_mcp_bearer::mk.suite::suite-mail')).toEqual({ value: 'suite-bearer' });
    for (const [key, value] of before) {
      expect(rows.get(key)).toEqual(value);
    }

    // Next launch, with the store healthy again: the failed row lands.
    failSetAccounts.clear();
    const retry = await migrateConnectorCredentialsToPluginSlots({ activePluginKeys: ACTIVE });
    expect(retry.copied).toBe(1);
    expect(rows.get('plugin_mcp_oauth::mk.tracker::tracker-mcp')?.value).toBe('tracker-access');
  });
});
