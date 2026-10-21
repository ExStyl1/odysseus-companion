import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import {
  SecureStorageBackendV2,
  type CredentialId,
  type StoredCredential,
} from '@nessy-agent/shared/credentials';
import { isApiOAuthProvider } from '@nessy-agent/shared/sources';
import type {
  CredentialManagerInterface,
  LoadedSource,
} from '@nessy-agent/session-tools-core';

function credentialStorePath(configRoot: string): string {
  if (!isAbsolute(configRoot)) throw new Error('session-credential-root-not-absolute');
  const resolvedRoot = resolve(configRoot);
  if (resolvedRoot === parse(resolvedRoot).root) throw new Error('session-credential-root-too-broad');
  const rootStat = lstatSync(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('session-credential-root-unsafe');
  }
  return join(realpathSync(resolvedRoot), 'credentials.enc');
}

function credentialIds(source: LoadedSource): CredentialId[] {
  const base = {
    workspaceId: source.workspaceId,
    sourceId: source.config.slug,
  };

  if (source.config.type === 'mcp') {
    const mcp = source.config.mcp;
    if (!mcp || mcp.transport === 'stdio' || !mcp.authType || mcp.authType === 'none') return [];
    // Keep SourceCredentialManager's compatibility order: an MCP source may
    // have been authenticated through OAuth before being switched to bearer.
    return [
      { type: 'source_oauth', ...base },
      { type: 'source_bearer', ...base },
    ];
  }

  if (source.config.type !== 'api') return [];
  const api = source.config.api;
  if (!api || !api.authType || api.authType === 'none') return [];
  if (api.authType === 'oauth' || isApiOAuthProvider(source.config.provider)) {
    return [{ type: 'source_oauth', ...base }];
  }
  if (api.authType === 'bearer') return [{ type: 'source_bearer', ...base }];
  if (api.authType === 'basic') return [{ type: 'source_basic', ...base }];
  return [{ type: 'source_apikey', ...base }];
}

function usableValue(credential: StoredCredential | null): string | null {
  if (!credential?.value) return null;
  if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) return null;
  return credential.value;
}

/**
 * Read-only credential facade for the trusted bundled session MCP process.
 * A fresh backend is created for every lookup so atomic host-side rotation and
 * revoke are visible immediately; no decrypted snapshot is written to disk.
 */
export function createSessionCredentialManager(configRoot: string): CredentialManagerInterface {
  const filePath = credentialStorePath(configRoot);

  const readToken = async (source: LoadedSource): Promise<string | null> => {
    try {
      const fileStat = lstatSync(filePath);
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) return null;
      const backend = new SecureStorageBackendV2({ filePath });
      for (const id of credentialIds(source)) {
        const value = usableValue(await backend.get(id));
        if (value !== null) return value;
      }
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Corruption, unsafe path state, or an unreadable store all fail closed.
      return null;
    }
  };

  return {
    hasValidCredentials: async source => (await readToken(source)) !== null,
    getToken: readToken,
    // A refresh performed by the host becomes visible through the same fresh
    // read. The subprocess never writes or rotates the credential store itself.
    refresh: readToken,
  };
}
