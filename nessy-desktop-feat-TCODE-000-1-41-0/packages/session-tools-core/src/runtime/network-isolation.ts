import { spawnSync } from 'node:child_process';
import { resolveTrustedIsolationLauncher } from './trusted-isolation-launchers.ts';

export interface NetworkIsolationPlan {
  status: 'enforced' | 'unavailable';
  backend: 'sandbox-exec' | 'unshare' | 'firejail' | 'none';
  command: string;
  args: string[];
}

let sandboxExecPathCache: string | null | undefined;

function usableSandboxExecPath(): string | undefined {
  if (sandboxExecPathCache !== undefined) return sandboxExecPathCache ?? undefined;
  const sandboxExec = resolveTrustedIsolationLauncher('sandbox-exec');
  const trueCommand = resolveTrustedIsolationLauncher('true');
  if (!sandboxExec || !trueCommand) {
    sandboxExecPathCache = null;
    return undefined;
  }
  const probe = spawnSync(sandboxExec, ['-p', '(version 1) (allow default)', trueCommand], { stdio: 'ignore' });
  sandboxExecPathCache = probe.status === 0 ? sandboxExec : null;
  return sandboxExecPathCache ?? undefined;
}

function usableUnsharePath(): string | undefined {
  const unshare = resolveTrustedIsolationLauncher('unshare');
  const trueCommand = resolveTrustedIsolationLauncher('true');
  if (!unshare || !trueCommand) return undefined;
  const probe = spawnSync(unshare, ['-n', trueCommand], { stdio: 'ignore' });
  return probe.status === 0 ? unshare : undefined;
}

/**
 * Wrap command execution to deny outbound network where supported.
 *
 * Current support:
 * - macOS: sandbox-exec with deny network profile
 * - Linux: unshare -n (preferred) or firejail --net=none
 * - others: unavailable (fail-safe for script_sandbox)
 */
export function applyNetworkIsolation(command: string, args: string[]): NetworkIsolationPlan {
  const sandboxExec = process.platform === 'darwin' ? usableSandboxExecPath() : undefined;
  if (sandboxExec) {
    const profile = '(version 1) (deny network*)';
    return {
      status: 'enforced',
      backend: 'sandbox-exec',
      command: sandboxExec,
      args: ['-p', profile, command, ...args],
    };
  }

  if (process.platform === 'linux') {
    const unshare = usableUnsharePath();
    if (unshare) {
      return {
        status: 'enforced',
        backend: 'unshare',
        command: unshare,
        args: ['-n', '--', command, ...args],
      };
    }

    const firejail = resolveTrustedIsolationLauncher('firejail');
    if (firejail) {
      return {
        status: 'enforced',
        backend: 'firejail',
        command: firejail,
        args: ['--quiet', '--net=none', '--', command, ...args],
      };
    }
  }

  return {
    status: 'unavailable',
    backend: 'none',
    command,
    args,
  };
}
