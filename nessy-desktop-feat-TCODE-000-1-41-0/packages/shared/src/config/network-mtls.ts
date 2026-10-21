/**
 * mTLS client-certificate resolution (network-config.md:86-101).
 *
 * The certificate and key files are RE-READ on every call — settings
 * application calls this each time, so replacing the files at the same paths
 * rotates the credential without a restart. Do not add caching here: a
 * read-once implementation fails the documented rotation contract.
 *
 * SECURITY: never put key bytes, certificate bytes, or the passphrase into a
 * returned error, a log line, or an exception. Errors carry file PATHS and
 * errno text only.
 */
import { readFileSync } from 'node:fs';
import { expandPath } from '../utils/paths.ts';
import { isManagedOriginEnvVar } from './managed-env.ts';
import type { NetworkProxySettings } from './types.ts';

export type ClientIdentity = {
  cert: string;
  key: string;
  passphrase?: string;
};

export type ClientIdentityRuntime = {
  identity?: ClientIdentity;
  /**
   * A reported, actionable error. When set, NO identity is produced — the
   * caller must surface this loudly. A missing or unreadable cert/key must
   * never silently downgrade to an unauthenticated connection.
   */
  error?: string;
};

export function resolveClientIdentityRuntime(
  settings: NetworkProxySettings | undefined,
): ClientIdentityRuntime {
  const certPath = settings?.clientCertPath ? expandPath(settings.clientCertPath) : undefined;
  const keyPath = settings?.clientKeyPath ? expandPath(settings.clientKeyPath) : undefined;

  if (!certPath && !keyPath) return {};
  if (!certPath) {
    return { error: 'mTLS client certificate is misconfigured: clientKeyPath is set but clientCertPath is missing.' };
  }
  if (!keyPath) {
    return { error: 'mTLS client certificate is misconfigured: clientCertPath is set but clientKeyPath is missing.' };
  }

  let cert: string;
  try {
    cert = readFileSync(certPath, 'utf8');
  } catch (error) {
    return { error: `Could not read mTLS client certificate at ${certPath}: ${errnoText(error)}` };
  }

  let key: string;
  try {
    key = readFileSync(keyPath, 'utf8');
  } catch (error) {
    return { error: `Could not read mTLS client key at ${keyPath}: ${errnoText(error)}` };
  }

  const passphrase = settings?.clientKeyPassphrase;
  return {
    identity: {
      cert,
      key,
      ...(passphrase ? { passphrase } : {}),
    },
  };
}

/** Errno-level description only — never file contents. */
function errnoText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * F1.563 (P-WJax-1, DECIDED by the controller 2026-09-24) — the MANAGED tier of
 * the client identity, read by every place that decides which identity a
 * request presents: the headless host hop (`network-runtime.ts`), the desktop
 * host hop (`apps/electron/src/main/network-proxy.ts`) and the child projection
 * (`proxy-env.ts` `buildNetworkEnvVars`). One rule, the one the managed proxy
 * and the managed CA already follow (F1.498): managed, then the stored Settings
 * identity, then the environment.
 *
 * "Managed" means a managed `env` block put the name into this process's
 * environment (`managed-env.ts` keeps that registry), not merely that the name
 * is set — an operator's own shell export stays below Settings, as before.
 * Naming the certificate OR the key takes the tier; the three names are then
 * read as they stand in the environment, which is exactly what a child that
 * inherits them reads, so the host hop and the children cannot disagree. A
 * half-named or unreadable managed identity is a REPORTED error and no identity
 * is presented; it never falls back to Settings.
 */
const MANAGED_IDENTITY_TRIGGER_NAMES = ['CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY'] as const;

export function managedClientIdentityNamed(
  env: Readonly<Record<string, string | undefined>> = process.env,
  managedOrigin: (name: string) => boolean = isManagedOriginEnvVar,
): boolean {
  return MANAGED_IDENTITY_TRIGGER_NAMES.some(name => !!env[name]?.trim() && managedOrigin(name));
}

/** The managed identity, or `undefined` when no managed block names one (the tier does not answer). */
export function resolveManagedClientIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
  managedOrigin: (name: string) => boolean = isManagedOriginEnvVar,
): ClientIdentityRuntime | undefined {
  if (!managedClientIdentityNamed(env, managedOrigin)) return undefined;
  const resolved = resolveClientIdentityRuntime({
    enabled: false,
    clientCertPath: env.CLAUDE_CODE_CLIENT_CERT?.trim() || undefined,
    clientKeyPath: env.CLAUDE_CODE_CLIENT_KEY?.trim() || undefined,
    clientKeyPassphrase: env.CLAUDE_CODE_CLIENT_KEY_PASSPHRASE || undefined,
  });
  return resolved.error ? { error: `${resolved.error} (named by a managed env block)` } : resolved;
}

/**
 * What a host re-composes on: the managed identity's paths, '' when no managed
 * block names one. Paths, never file contents or the passphrase; the key is
 * compared, not logged.
 */
export function managedClientIdentityKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
  managedOrigin: (name: string) => boolean = isManagedOriginEnvVar,
): string {
  if (!managedClientIdentityNamed(env, managedOrigin)) return '';
  return `${env.CLAUDE_CODE_CLIENT_CERT ?? ''}\n${env.CLAUDE_CODE_CLIENT_KEY ?? ''}`;
}

/**
 * UA12.200 — the mTLS client identity this process's own HTTPS requests present, for a request that cannot go
 * through the process's `fetch`: the MCP OAuth pinned request (`auth/oauth.ts` `fetchOAuthUrlPinned`, `node:https`
 * to an already-validated address). The twin of `network-tls-ca.ts` `processCaTrust` (UA12.185), registered by the
 * same two hosts from the identity they already resolved: the Electron main's `HostProxyDispatcher`
 * (`configureNodeProxy` → `resolveHostClientIdentity`: managed, then Settings, then the environment) and the
 * headless fetch wrapper (`applyProcessNetworkTrustChain`: managed, then Settings). Each re-resolves through its own
 * path when a managed `env` block moved the identity, as a dispatch / wrapped fetch does. No second reader of the
 * certificate files: a provider hands out the identity the dispatcher or the wrapper holds. `undefined` means none
 * (nothing configured, a reported misconfiguration, or no provider registered).
 */
export type ProcessClientIdentityProvider = () => ClientIdentity | undefined;

let processClientIdentityProvider: ProcessClientIdentityProvider | undefined;

/** UA12.200 — register (or, with `undefined`, clear) the provider of this process's composed client identity. */
export function setProcessClientIdentityProvider(provider: ProcessClientIdentityProvider | undefined): void {
  processClientIdentityProvider = provider;
}

/** UA12.200 — this process's composed mTLS client identity, or `undefined` for none. */
export function processClientIdentity(): ClientIdentity | undefined {
  return processClientIdentityProvider?.();
}
