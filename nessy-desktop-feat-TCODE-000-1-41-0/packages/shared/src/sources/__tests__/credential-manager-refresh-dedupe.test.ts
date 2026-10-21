/**
 * refresh() runs one refresh per stored credential at a time. The key is the stored
 * credential's scope (`workspaceId::sourceId`, UB1.13), like the credential itself: two
 * workspaces may each have a source with the same slug and must never share a refresh
 * (or receive each other's token). A connector-origin source's credential is global
 * (`@connector-global::pluginKey#connectorId#serverName`), so its refresh flight is
 * shared across workspaces — the second caller joins the first's refresh.
 *
 * Source: v0.15.1:packages/shared/src/sources/__tests__/credential-manager-refresh-dedupe.test.ts
 * (Apache-2.0), plus this fork's connector-origin arms (T5 scope divergence upstream
 * does not have).
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { SourceCredentialManager } from '../credential-manager.ts';
import type { LoadedSource } from '../types.ts';

function source(workspaceId: string, slug = 'gmail'): LoadedSource {
  return {
    config: {
      id: `${workspaceId}-${slug}`,
      name: slug,
      slug,
      enabled: true,
      provider: 'google',
      type: 'api',
      isAuthenticated: true,
      api: { baseUrl: 'https://gmail.googleapis.com', authType: 'oauth' },
    },
    guide: null,
    folderPath: `/mock/${workspaceId}/sources/${slug}`,
    workspaceRootPath: `/mock/${workspaceId}`,
    workspaceId,
  } as LoadedSource;
}

/** A connector-materialized source: the same server under a workspace-local slug. */
function connectorSource(workspaceId: string, slug: string, serverName = 'tracker-mcp'): LoadedSource {
  return {
    config: {
      id: `${workspaceId}-${slug}`,
      name: slug,
      slug,
      enabled: true,
      type: 'mcp',
      isAuthenticated: true,
      mcp: { transport: 'http', url: 'https://tracker.example.test/mcp', authType: 'oauth' },
      connectorOrigin: { pluginKey: 'mk.tracker', connectorId: 'tracker', serverName },
    },
    guide: null,
    folderPath: `/mock/${workspaceId}/sources/${slug}`,
    workspaceRootPath: `/mock/${workspaceId}`,
    workspaceId,
  } as LoadedSource;
}

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

/** Stub the provider round trip: each refresh resolves when its workspace's gate opens. */
function stubRefresh(credManager: SourceCredentialManager) {
  const calls: string[] = [];
  const gates = new Map<string, Array<() => void>>();
  const spy = spyOn(credManager as unknown as { doRefresh: (s: LoadedSource) => Promise<string | null> }, 'doRefresh')
    .mockImplementation((s: LoadedSource) => {
      calls.push(s.workspaceId);
      return new Promise<string | null>(resolve => {
        const queue = gates.get(s.workspaceId) ?? [];
        queue.push(() => resolve(`token-for-${s.workspaceId}`));
        gates.set(s.workspaceId, queue);
      });
    });
  restore = () => spy.mockRestore();
  return { calls, open: (workspaceId: string) => gates.get(workspaceId)!.forEach(openGate => openGate()) };
}

describe('SourceCredentialManager.refresh single flight', () => {
  test('concurrent refreshes of one workspace source share a single provider call', async () => {
    const credManager = new SourceCredentialManager();
    const { calls, open } = stubRefresh(credManager);

    const first = credManager.refresh(source('ws-1'));
    const second = credManager.refresh(source('ws-1'));
    await Promise.resolve();
    open('ws-1');

    expect(await first).toBe('token-for-ws-1');
    expect(await second).toBe('token-for-ws-1');
    expect(calls).toEqual(['ws-1']);
  });

  test('the same slug in two workspaces refreshes separately and gets its own token', async () => {
    const credManager = new SourceCredentialManager();
    const { calls, open } = stubRefresh(credManager);

    const inWs1 = credManager.refresh(source('ws-1'));
    const inWs2 = credManager.refresh(source('ws-2'));
    await Promise.resolve();
    open('ws-2');
    open('ws-1');

    expect(await inWs1).toBe('token-for-ws-1');
    expect(await inWs2).toBe('token-for-ws-2');
    expect(calls).toEqual(['ws-1', 'ws-2']);
  });

  test('a finished refresh does not absorb the next one', async () => {
    const credManager = new SourceCredentialManager();
    const { calls, open } = stubRefresh(credManager);

    const first = credManager.refresh(source('ws-1'));
    await Promise.resolve();
    open('ws-1');
    await first;

    const second = credManager.refresh(source('ws-1'));
    await Promise.resolve();
    open('ws-1');
    await second;

    expect(calls).toEqual(['ws-1', 'ws-1']);
  });

  test('a connector-origin source shares one flight across workspaces (global credential)', async () => {
    const credManager = new SourceCredentialManager();
    const { calls, open } = stubRefresh(credManager);

    // Same server, workspace-local slugs — even equal slugs must key globally, not per workspace.
    const inWs1 = credManager.refresh(connectorSource('ws-1', 'tracker-a'));
    const inWs2 = credManager.refresh(connectorSource('ws-2', 'tracker-b'));
    await Promise.resolve();
    open('ws-1');

    // The credential is ONE global slot: ws-2 joins ws-1's refresh and receives its token.
    expect(await inWs1).toBe('token-for-ws-1');
    expect(await inWs2).toBe('token-for-ws-1');
    expect(calls).toEqual(['ws-1']);
  });

  test('sibling SERVERS of one connector keep separate flights', async () => {
    const credManager = new SourceCredentialManager();
    const { calls, open } = stubRefresh(credManager);

    const mail = credManager.refresh(connectorSource('ws-1', 'suite-mail', 'suite-mail'));
    const docs = credManager.refresh(connectorSource('ws-1', 'suite-docs', 'suite-docs'));
    await Promise.resolve();
    open('ws-1');

    expect(await mail).toBe('token-for-ws-1');
    expect(await docs).toBe('token-for-ws-1');
    expect(calls).toEqual(['ws-1', 'ws-1']);
  });
});
