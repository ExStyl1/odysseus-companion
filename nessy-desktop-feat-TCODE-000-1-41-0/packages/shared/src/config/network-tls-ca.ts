import { readFileSync } from 'node:fs';
import { resolveTlsCaPathSelection } from './tls-ca-path.ts';
import type { NetworkProxySettings } from './types.ts';

type TlsCaSettings = NetworkProxySettings & {
  tlsCaPath?: string;
  useBundledCa?: boolean;
};

export type TlsCaRuntime = {
  ca?: string;
  /** `managed` is the top tier — see `resolveTlsCaPathSelection`. */
  source: 'managed' | 'custom' | 'bundled' | 'none';
  path?: string;
  warning?: string;
};

type ResolveOverrides = {
  bundledCaPath?: string;
};

export function resolveTlsCaRuntime(settings?: NetworkProxySettings): TlsCaRuntime {
  return resolveTlsCaRuntimeForTest(settings, {});
}

export function resolveTlsCaRuntimeForTest(
  settings: TlsCaSettings | undefined,
  overrides: ResolveOverrides,
): TlsCaRuntime {
  // WHICH file provides the extra CA is decided by the shared selection —
  // the same one the subprocess env projection (proxy-env.ts) forwards as
  // NODE_EXTRA_CA_CERTS, so the main process and every child verify against
  // the same trust chain.
  const selection = resolveTlsCaPathSelection(settings, overrides);
  if (!selection.path) {
    return { source: 'none' };
  }
  return readCaFile(selection.path, selection.source as 'managed' | 'custom' | 'bundled');
}

function readCaFile(path: string, source: 'managed' | 'custom' | 'bundled'): TlsCaRuntime {
  try {
    return {
      ca: readFileSync(path, 'utf8'),
      source,
      path,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      source: 'none',
      warning: `Could not read TLS CA certificate at ${path}: ${message}`,
    };
  }
}

/**
 * UA12.185 — the COMPOSED CA trust set this process's own HTTPS requests verify against (the bundled Mozilla
 * set, the OS store where configured, the managed / Custom CA setting / bundled corporate CA file), for a request
 * that cannot go through the process's `fetch`.
 *
 * Each host composes the set exactly once, where it already did: the Electron main in `configureNodeProxy`
 * (`apps/electron/src/main/network-proxy.ts`, the global undici dispatcher), the headless server in
 * `applyProcessNetworkTrustChain` (`network-runtime.ts`, the fetch wrapper). Each registers a provider here
 * that answers that composition, re-composed through its own path when a managed `env` block moved it. There is
 * no second CA store: a provider hands out the set the dispatcher or the wrapper holds.
 *
 * The one reader today is the MCP OAuth pinned request (`auth/oauth.ts` `fetchOAuthUrlPinned`): it uses
 * `node:https` to connect to an already-validated address, so neither the dispatcher nor the wrapper reaches it.
 * Its only corporate-CA path used to be a startup `NODE_EXTRA_CA_CERTS`, which the desktop binary's
 * `nodeOptions` fuse now stops (UA12.22). `undefined` means "the runtime's default trust": no provider is
 * registered (a host that never applied a trust chain), or nothing was configured beyond the default.
 */
export type ProcessCaTrustProvider = () => string[] | undefined;

let processCaTrustProvider: ProcessCaTrustProvider | undefined;

/** UA12.185 — register (or, with `undefined`, clear) the provider of this process's composed CA trust set. */
export function setProcessCaTrustProvider(provider: ProcessCaTrustProvider | undefined): void {
  processCaTrustProvider = provider;
}

/** UA12.185 — this process's composed CA trust set, or `undefined` for the runtime's default trust. */
export function processCaTrust(): string[] | undefined {
  return processCaTrustProvider?.();
}
