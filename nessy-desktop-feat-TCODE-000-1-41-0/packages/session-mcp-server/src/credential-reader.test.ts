import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecureStorageBackendV2 } from '@nessy-agent/shared/credentials';
import type { LoadedSource } from '@nessy-agent/session-tools-core';
import { createSessionCredentialManager } from './credential-reader.ts';

const roots: string[] = [];

function fixture(type: 'mcp' | 'api', authType: 'oauth' | 'bearer' | 'none'): LoadedSource {
  const root = roots.at(-1)!;
  return {
    workspaceId: 'workspace-1',
    workspaceRootPath: join(root, 'workspace'),
    folderPath: join(root, 'workspace', 'sources', 'example'),
    config: {
      id: 'source-1',
      name: 'Example',
      slug: 'example',
      enabled: true,
      provider: type === 'api' && authType === 'oauth' ? 'google' : 'custom',
      type,
      ...(type === 'mcp'
        ? { mcp: { transport: 'http', url: 'https://example.test/mcp', authType } }
        : { api: { baseUrl: 'https://example.test', authType } }),
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('session MCP credential reader', () => {
  test('reads the encrypted store directly and observes rotation and revoke without restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-session-credential-reader-'));
    roots.push(root);
    const configRoot = join(root, 'config');
    mkdirSync(configRoot, { recursive: true });
    const filePath = join(configRoot, 'credentials.enc');
    const writer = new SecureStorageBackendV2({ filePath });
    const source = fixture('mcp', 'oauth');
    const id = { type: 'source_oauth' as const, workspaceId: source.workspaceId, sourceId: source.config.slug };
    const reader = createSessionCredentialManager(configRoot);

    await writer.set(id, { value: 'first-token' });
    expect(await reader.getToken(source)).toBe('first-token');

    await writer.set(id, { value: 'rotated-token' });
    expect(await reader.getToken(source)).toBe('rotated-token');

    await writer.delete(id);
    expect(await reader.getToken(source)).toBeNull();
    expect(await reader.hasValidCredentials(source)).toBe(false);
  });

  test('supports MCP OAuth-to-bearer fallback and rejects expired or public credentials', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-session-credential-reader-'));
    roots.push(root);
    const configRoot = join(root, 'config');
    mkdirSync(configRoot, { recursive: true });
    const writer = new SecureStorageBackendV2({ filePath: join(configRoot, 'credentials.enc') });
    const oauthSource = fixture('mcp', 'oauth');
    const bearerId = { type: 'source_bearer' as const, workspaceId: oauthSource.workspaceId, sourceId: oauthSource.config.slug };
    const reader = createSessionCredentialManager(configRoot);

    await writer.set(bearerId, { value: 'bearer-fallback' });
    expect(await reader.getToken(oauthSource)).toBe('bearer-fallback');

    await writer.set(bearerId, { value: 'expired', expiresAt: Date.now() - 1 });
    expect(await reader.getToken(oauthSource)).toBeNull();
    expect(await reader.getToken(fixture('api', 'none'))).toBeNull();
  });
});
