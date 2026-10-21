/**
 * Selection of the app-level EXTRA CA file (network-config.md:78-83).
 *
 * This decides WHICH file provides the extra CA: the user-configured
 * `tlsCaPath`, else the corporate CA bundle shipped as an app resource
 * (unless opted out). It is the single source of truth shared by the
 * Electron main process (which reads the file's contents into the undici
 * dispatcher) and the subprocess env projection (which forwards the PATH as
 * `NODE_EXTRA_CA_CERTS` so every Node/Bun child verifies against the same
 * trust chain as the main process).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expandPath, getBundledAssetsRoot } from '../utils/paths.ts';
import { isManagedOriginEnvVar } from './managed-env.ts';
import type { NetworkProxySettings } from './types.ts';

export type TlsCaPathSelection = {
  path?: string;
  /**
   * `managed` is the top tier and cannot be overridden by anything below it
   * (`server-managed-settings.md#settings-precedence`). The other three are the
   * pre-existing user/app-default ladder.
   */
  source: 'managed' | 'custom' | 'bundled' | 'none';
};

/** The variable a managed `env` block uses to name an extra CA. */
const MANAGED_CA_ENV_VAR = 'NODE_EXTRA_CA_CERTS';

export function isBundledCaDisabled(): boolean {
  const value = (process.env.NESSY_DISABLE_BUNDLED_CA ?? '').toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function resolveBundledCaPath(): string | undefined {
  // THREAT (network-config.md:114): the bundled CA is TRUST MATERIAL, so it
  // may only come from the app-owned assets root registered at startup —
  // never from the cwd-based dev fallbacks in getBundledAssetsDir. A process
  // launched with its cwd inside a checked-out repository (CLI, headless
  // server, a dev shell) must not pick up `<repo>/resources/certs/…` as a
  // trusted CA: that would let a git clone redirect the TLS path. Processes
  // without a registered root simply have no bundled CA; the OS store
  // (certStore source 'system') and an explicit tlsCaPath remain available.
  const assetsRoot = getBundledAssetsRoot();
  if (!assetsRoot) return undefined;

  const candidate = join(assetsRoot, 'resources', 'certs', 'tinkoff-bundle.crt');
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Select the extra CA file for the given settings.
 *
 * Four tiers, highest first:
 *
 * 1. **Managed.** A `NODE_EXTRA_CA_CERTS` this process's environment carries
 *    BECAUSE a managed `env` block put it there.
 *    `server-managed-settings.md#settings-precedence` — "No other settings level
 *    can override them, including command line arguments, apart from the
 *    exceptions to managed settings precedence." Without this tier the ladder
 *    inverted at the top: an admin's org CA lost to a user's `tlsCaPath`, which
 *    is the one direction the hierarchy forbids. The origin is asked of
 *    `managed-env.ts` rather than inferred from the variable's presence, because
 *    an operator's own shell export is indistinguishable from a managed one
 *    otherwise — and an operator export must keep LOSING to a user `tlsCaPath`,
 *    which is the pre-existing behaviour and the reason the check cannot simply
 *    be "is the variable set".
 * 2. **Custom.** The user-configured `tlsCaPath`.
 * 3. **Bundled.** The corporate CA resource, unless `useBundledCa: false` or
 *    `NESSY_DISABLE_BUNDLED_CA` opts out.
 * 4. **None.**
 */
export function resolveTlsCaPathSelection(
  settings: NetworkProxySettings | undefined,
  overrides: {
    bundledCaPath?: string;
    /** Ambient environment. Defaults to `process.env`. */
    processEnv?: Record<string, string | undefined>;
    /** Managed-origin oracle. Defaults to the real registry. */
    managedOrigin?: (name: string) => boolean;
  } = {},
): TlsCaPathSelection {
  const processEnv = overrides.processEnv ?? process.env;
  const managedOrigin = overrides.managedOrigin ?? isManagedOriginEnvVar;
  const managedPath = processEnv[MANAGED_CA_ENV_VAR];
  if (managedPath && managedOrigin(MANAGED_CA_ENV_VAR)) {
    return { path: managedPath, source: 'managed' };
  }

  const customPath = settings?.tlsCaPath ? expandPath(settings.tlsCaPath) : undefined;
  if (customPath) {
    return { path: customPath, source: 'custom' };
  }

  if (settings?.useBundledCa === false || isBundledCaDisabled()) {
    return { source: 'none' };
  }

  const bundledPath = 'bundledCaPath' in overrides ? overrides.bundledCaPath : resolveBundledCaPath();
  if (!bundledPath) {
    return { source: 'none' };
  }

  return { path: bundledPath, source: 'bundled' };
}
