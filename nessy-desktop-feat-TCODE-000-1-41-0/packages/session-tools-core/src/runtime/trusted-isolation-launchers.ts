import { accessSync, constants, realpathSync, statSync } from 'node:fs';

export type TrustedIsolationLauncher =
  | 'sandbox-exec'
  | 'bwrap'
  | 'firejail'
  | 'unshare'
  | 'true';

const HOST_OWNED_LAUNCHER_CANDIDATES: Readonly<Record<TrustedIsolationLauncher, readonly string[]>> = {
  'sandbox-exec': ['/usr/bin/sandbox-exec'],
  bwrap: ['/usr/bin/bwrap', '/bin/bwrap'],
  firejail: ['/usr/bin/firejail', '/bin/firejail'],
  unshare: ['/usr/bin/unshare', '/bin/unshare'],
  true: ['/usr/bin/true', '/bin/true'],
};

/**
 * Resolve isolation launchers from a fixed host-owned allowlist. Never consult
 * PATH: a plugin may control the child environment passed to the sandboxed
 * process, and that environment must not be able to replace the sandbox itself.
 */
export function resolveTrustedIsolationLauncher(
  launcher: TrustedIsolationLauncher,
): string | undefined {
  for (const candidate of HOST_OWNED_LAUNCHER_CANDIDATES[launcher]) {
    try {
      const canonical = realpathSync(candidate);
      if (!statSync(canonical).isFile()) continue;
      accessSync(canonical, constants.X_OK);
      return canonical;
    } catch {
      // Try the next fixed system location. PATH fallback is intentionally forbidden.
    }
  }
  return undefined;
}
