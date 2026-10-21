/**
 * Config Types (Browser-safe)
 *
 * Pure type definitions for configuration.
 * Re-exports from @nessy-agent/core for compatibility.
 */

// Re-export all config types from core (single source of truth)
export type {
  Workspace,
  McpAuthType,
  AuthType,
  OAuthCredentials,
} from '@nessy-agent/core/types';

/**
 * App-level network proxy and TLS trust configuration.
 *
 * SECURITY: these values are read ONLY from the user-level config
 * (`~/.nessy-agent/config.json` via `loadStoredConfig()`) — never from a
 * project's own settings, a plugin manifest, a workspace file, or anything
 * else a `git clone` can carry. A checked-out repository must not be able to
 * redirect the TLS or proxy path of a session whose credentials come from
 * the app (network-config.md:114). Pinned by
 * `packages/shared/src/config/__tests__/network-trust-scope.test.ts`.
 */
export interface NetworkProxySettings {
  enabled: boolean;
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
  tlsCaPath?: string;
  useBundledCa?: boolean;
  /**
   * Comma-separated CA source list: `bundled` (the Mozilla CA set shipped
   * with the runtime) and/or `system` (the OS certificate store).
   * Unset means the documented default `bundled,system`.
   */
  certStore?: string;
  /** mTLS: path to the client certificate PEM. Requires `clientKeyPath`. */
  clientCertPath?: string;
  /** mTLS: path to the client private key PEM. Requires `clientCertPath`. */
  clientKeyPath?: string;
  /**
   * mTLS: optional passphrase for an encrypted client key. SECURITY: this is
   * a secret — it must never be printed into a log or an error message.
   */
  clientKeyPassphrase?: string;
}
