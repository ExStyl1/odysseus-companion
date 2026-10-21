/**
 * C4 (capability-path plan, ADR § 8 risk 3): the refresh re-point for plugin
 * MCP credential slots.
 *
 * Source tokens rode `TokenRefreshManager`, which discovers refreshables
 * through LoadedSources; a plugin slot has no source, so the pool consumed a
 * stale token forever and every plugin OAuth token silently expired in ~1h.
 * This module keeps the slot fresh AT THE POINT OF CONSUMPTION — the pool's
 * materialization calls `ensureFreshPluginMcpToken` for every endpoint-auth
 * server — through the C1 endpoint core.
 *
 * Process-wide by design: plugin slots are GLOBAL (one credential per server,
 * ever), so in-flight dedup and the failure cooldown are module-scoped rather
 * than per-session — two sessions materializing the same server never race two
 * refreshes.
 *
 * Never throws. On a refresh failure the slot is left untouched: a
 * near-expiry token is still returned (it may outlive the call), an expired
 * one yields null so the server surfaces as needs-login. The worst outcome is
 * a re-auth prompt, never a lost credential.
 */

import {
  endpointCredentialNeedsRefresh,
  isEndpointCredentialExpired,
  refreshEndpointOAuthToken,
} from '../auth/endpoint-oauth.ts';
import { credentialIdToAccount } from '../credentials/types.ts';
import { debug } from '../utils/debug.ts';
import {
  loadPluginMcpCredential,
  pluginMcpCredentialId,
  savePluginMcpCredential,
} from './mcp-credentials.ts';

/** Cooldown after a failed refresh (matches TokenRefreshManager's default). */
const REFRESH_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

const pendingRefreshes = new Map<string, Promise<string | null>>();
const failedAttempts = new Map<string, number>();

/** Test-only: clear the module-scoped dedup/cooldown state. */
export function resetPluginMcpTokenRefreshForTests(): void {
  pendingRefreshes.clear();
  failedAttempts.clear();
}

export interface PluginMcpEndpointAuthRef {
  authType: 'oauth' | 'bearer';
  pluginKey: string;
  serverName: string;
  oauthResource?: string;
  clientId?: string;
}

/**
 * Return a usable token for one endpoint-auth plugin server, refreshing the
 * slot through the endpoint core when it is inside the expiry window. Null
 * means "no usable token" — the caller surfaces needs-login.
 */
export async function ensureFreshPluginMcpToken(
  auth: PluginMcpEndpointAuthRef,
  url: string,
): Promise<string | null> {
  let credential: Awaited<ReturnType<typeof loadPluginMcpCredential>>;
  try {
    credential = await loadPluginMcpCredential(auth.pluginKey, auth.serverName);
  } catch {
    // No initialized credential store (focused tests, early startup): the
    // caller falls back to whatever its snapshot binding resolved.
    return null;
  }
  if (!credential?.value) return null;

  // Bearer slots and OAuth slots without refresh material never refresh.
  if (auth.authType !== 'oauth' || !credential.refreshToken || !credential.clientId) {
    return isEndpointCredentialExpired(credential) ? null : credential.value;
  }
  if (credential.expiresAt && !endpointCredentialNeedsRefresh(credential)) {
    return credential.value;
  }

  const account = credentialIdToAccount(pluginMcpCredentialId('oauth', auth.pluginKey, auth.serverName));
  const lastFailure = failedAttempts.get(account);
  if (lastFailure && Date.now() - lastFailure < REFRESH_FAILURE_COOLDOWN_MS) {
    return isEndpointCredentialExpired(credential) ? null : credential.value;
  }
  const pending = pendingRefreshes.get(account);
  if (pending) return pending;

  const refresh = (async (): Promise<string | null> => {
    try {
      const tokens = await refreshEndpointOAuthToken(
        {
          url,
          authType: 'oauth',
          ...(auth.oauthResource ? { oauthResource: auth.oauthResource } : {}),
          ...(auth.clientId ? { clientId: auth.clientId } : {}),
        },
        { refreshToken: credential.refreshToken!, clientId: credential.clientId! },
      );
      await savePluginMcpCredential('oauth', auth.pluginKey, auth.serverName, {
        ...credential,
        value: tokens.accessToken,
        refreshToken: tokens.refreshToken || credential.refreshToken,
        expiresAt: tokens.expiresAt,
      });
      failedAttempts.delete(account);
      debug(`[PluginMcpTokenRefresh] Refreshed the slot for ${auth.serverName}`);
      return tokens.accessToken;
    } catch (error) {
      failedAttempts.set(account, Date.now());
      debug(`[PluginMcpTokenRefresh] Refresh failed for ${auth.serverName}:`, error);
      // Stale-but-unexpired beats dropping the server; expired surfaces auth.
      return isEndpointCredentialExpired(credential) ? null : credential.value;
    } finally {
      pendingRefreshes.delete(account);
    }
  })();
  pendingRefreshes.set(account, refresh);
  return refresh;
}
