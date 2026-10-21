import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  machLookupRule,
  NETWORK_SANDBOX_MACH_SERVICES,
  SANDBOX_MACH_SERVICES,
} from './mach-services.ts';
import { resolveTrustedIsolationLauncher } from './trusted-isolation-launchers.ts';

export interface FilesystemIsolationPlan {
  status: 'enforced' | 'unavailable';
  backend: 'sandbox-exec' | 'bwrap' | 'firejail' | 'none';
  command: string;
  args: string[];
}

export interface FilesystemIsolationOptions {
  includeNetworkDeny?: boolean;
  /** Additional host-owned writable roots (for example the process scratch dir). */
  additionalWritableRoots?: readonly string[];
  /** Host-owned paths that must remain unreadable even though the sandbox permits ambient reads. */
  deniedReadRoots?: readonly string[];
  /**
   * Host-owned paths that must remain UNWRITABLE while staying readable.
   *
   * `sandboxing.md:363` — `sandbox.filesystem.denyWrite` "Block[s] subprocess
   * access to specific paths"; `settings-reference.md#sandbox-filesystem-denywrite`
   * adds that "Claude Code merges entries across every settings scope the
   * session loads, and adds the paths from your `Edit(...)` deny permission
   * rules". Distinct from
   * {@link FilesystemIsolationOptions.deniedReadRoots}, which removes reads as
   * well — an `Edit` deny must not blind the agent to a file it may still read.
   * Emitted AFTER every write allow on every backend, so a root named by both
   * stays denied.
   */
  deniedWriteRoots?: readonly string[];
  /**
   * Paths re-opened for READ inside a denied region.
   *
   * `sandboxing.md:176` — "You can also deny write or read access using
   * `sandbox.filesystem.denyWrite` and `sandbox.filesystem.denyRead`, and
   * re-allow specific paths within a denied region using
   * `sandbox.filesystem.allowRead`. When read rules overlap, the more specific
   * path wins".
   *
   * On its own this grants NOTHING: reads are ambient, so a path not covered by
   * a deny is already readable. It becomes a read allowlist only in the pair the
   * doc's own example uses (`:190`-`:191`) — `"denyRead": ["~/"]` with
   * `"allowRead": ["."]`.
   *
   * Only `sandbox-exec` can express it. Every other backend REFUSES rather than
   * dropping it: see {@link applyFilesystemIsolation}.
   */
  allowedReadRoots?: readonly string[];
  /**
   * Read denies that outrank every allow, whatever their specificity.
   *
   * The host credential floor. `sandboxing.md:181` already makes "An exact deny
   * holds inside a wider allow, so a broad allow can't silently re-expose a
   * secret" true for a deny that is DEEPER than the allow, and the specificity
   * ordering below implements that. This list is the case that rule does not
   * cover: an `allowRead` naming a credential root exactly, or naming a path
   * inside one. Emitted after every read rule, so it wins regardless.
   */
  unconditionalDeniedReadRoots?: readonly string[];
  /**
   * `sandbox.filesystem.disabled` — the write boundary is not composed at all.
   *
   * `sandboxing.md:201` sells the key as "skip filesystem isolation while keeping
   * network isolation"; `:478` states its price, that the settings-file deny
   * rules go with the layer. The backend's job here is only the BASE POSTURE:
   * instead of `(deny file-write*)` plus a workspace grant, the whole filesystem
   * is writable, and on the other two backends the read-only root becomes a
   * read-write one.
   *
   * The deny lists are NOT ignored here. Deciding which of them survive the key
   * belongs to the one funnel that composes them (`resolveProcessIsolation`),
   * which passes only the host credential floor when the layer is off — a floor
   * this module must still emit, after the base allow, or it would not bind.
   */
  filesystemIsolationDisabled?: boolean;
}

/** One resolved read rule, before specificity ordering. */
interface ReadRule {
  root: string;
  kind: 'allow' | 'deny';
}

/**
 * Order read rules least- to most-specific, so the LAST match is the most
 * specific one.
 *
 * `sandboxing.md:176` — "When read rules overlap, the more specific path wins".
 * sandbox-exec is last-match-wins, so specificity has to become emission order:
 * `~/` before `~/projects` makes `~/projects` readable inside a denied home
 * (`:180`), and `~/` before `~/.env` keeps `~/.env` blocked inside a readable
 * home (`:181`). Depth first, then length, so `/a/bb` and `/a/cc` cannot swap on
 * a length tie alone; a deny sorts after an allow at equal specificity, which is
 * `:181`'s "An exact deny holds inside a wider allow" for the exactly-equal case.
 */
function compareReadRuleSpecificity(a: ReadRule, b: ReadRule): number {
  const depth = (path: string): number => path.split('/').length;
  return depth(a.root) - depth(b.root)
    || a.root.length - b.root.length
    || (a.kind === 'deny' ? 1 : 0) - (b.kind === 'deny' ? 1 : 0)
    || (a.root < b.root ? -1 : a.root > b.root ? 1 : 0);
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

function escapeSandboxPath(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function buildDarwinSandboxProfile(
  sessionDir: string,
  options?: FilesystemIsolationOptions,
): string {
  const escapedRoot = escapeSandboxPath(resolve(sessionDir));
  const additionalWritableRoots = [...new Set(options?.additionalWritableRoots ?? [])]
    .map(root => escapeSandboxPath(resolve(root)))
    .filter(root => root !== escapedRoot);
  const unconditionalDeniedReadRoots = [...new Set(options?.unconditionalDeniedReadRoots ?? [])]
    .map(root => escapeSandboxPath(resolve(root)));
  const deniedReadRoots = [...new Set(options?.deniedReadRoots ?? [])]
    .map(root => escapeSandboxPath(resolve(root)))
    .filter(root => !unconditionalDeniedReadRoots.includes(root));
  const allowedReadRoots = [...new Set(options?.allowedReadRoots ?? [])]
    .map(root => escapeSandboxPath(resolve(root)));
  const deniedWriteRoots = [...new Set(options?.deniedWriteRoots ?? [])]
    .map(root => escapeSandboxPath(resolve(root)))
    .filter(root => !deniedReadRoots.includes(root) && !unconditionalDeniedReadRoots.includes(root));
  const readRules: ReadRule[] = [
    ...deniedReadRoots.map((root): ReadRule => ({ root, kind: 'deny' })),
    ...allowedReadRoots.map((root): ReadRule => ({ root, kind: 'allow' })),
  ].sort(compareReadRuleSpecificity);
  const profileParts = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    // Filtered, never bare: a bare `(allow mach-lookup)` grants every registered
    // mach service by name, which is how a sandboxed command read the pasteboard.
    // See `mach-services.ts` for what each name buys and what is left out.
    machLookupRule(SANDBOX_MACH_SERVICES),
    '(allow file-read*)',
    // The write boundary, or its absence. With the layer off there is no floor to
    // carve exceptions out of, so the workspace/scratch/`/dev/null` grants below
    // are omitted rather than emitted into a profile that already allows every
    // write — a receipt an operator reads must not list grants that grant nothing.
    ...(options?.filesystemIsolationDisabled
      ? ['(allow file-write*)']
      : [
          '(deny file-write*)',
          '(allow file-write* (literal "/dev/null"))',
          '(allow file-ioctl (literal "/dev/null"))',
          `(allow file-write* (subpath "${escapedRoot}"))`,
          ...additionalWritableRoots.map(root => `(allow file-write* (subpath "${root}"))`),
        ]),
    ...readRules.flatMap(rule => rule.kind === 'deny'
      ? [
          `(deny file-read* (subpath "${rule.root}"))`,
          `(deny file-write* (subpath "${rule.root}"))`,
        ]
      // A re-allowed read never re-grants write. `sandboxing.md:364` scopes
      // `allowRead` to "Re-allows reading specific paths within a `denyRead`
      // region"; the write scope has its own key and its own floor.
      : [`(allow file-read* (subpath "${rule.root}"))`]),
    // The host credential floor, after every read rule an administrator can
    // write, so an `allowRead` naming a credential root cannot re-open it.
    ...unconditionalDeniedReadRoots.flatMap(root => [
      `(deny file-read* (subpath "${root}"))`,
      `(deny file-write* (subpath "${root}"))`,
    ]),
    // Write-only denials come last for the same reason the read denials do:
    // sandbox-exec is last-match-wins, so a root named by both a write allow
    // and a write deny must have the deny emitted after the allow.
    ...deniedWriteRoots.map(root => `(deny file-write* (subpath "${root}"))`),
  ];

  if (options?.includeNetworkDeny) {
    profileParts.push('(deny network*)');
  } else {
    // `(deny default)` also denies networking, so a network-capable profile has
    // to opt it back in explicitly or it is silently equivalent to the
    // network-denied profile and real MCP CLIs exit at boot.
    //
    // The service lookups ordinary CLIs need are NOT re-granted here: the
    // filtered rule above already emitted them for every profile. What is added
    // is only the resolver-config and trust-evaluation names, which nothing but
    // a network-capable profile has any use for. The old code pushed a second,
    // bare `(allow mach-lookup)` at this point and its comment claimed the
    // network profile had to opt those lookups back in — both wrong: the first
    // rule had already granted them to every profile, and being unfiltered it
    // granted every other service too.
    profileParts.push('(allow network*)', machLookupRule(NETWORK_SANDBOX_MACH_SERVICES));
  }

  return profileParts.join(' ');
}

/**
 * Wrap command execution to deny writes outside the current session directory.
 *
 * Current support:
 * - macOS: sandbox-exec profile
 * - Linux: bubblewrap (preferred) or firejail private/whitelist profile
 * - others: unavailable (fail-safe for script_sandbox)
 *
 * A configured {@link FilesystemIsolationOptions.allowedReadRoots} that this
 * backend cannot express THROWS rather than being dropped. bwrap's read scope is
 * the `--ro-bind / /` it starts from and firejail's `--whitelist` is a write
 * scope; neither has a rule that re-opens a subtree inside a masked one, and the
 * Windows profile's per-path values are `write`/`read`/`deny` with no re-allow.
 * A security control that silently does nothing on two of three platforms is
 * worse than none, because the administrator who configured it stops looking.
 */
export function applyFilesystemIsolation(
  command: string,
  args: string[],
  sessionDir: string,
  options?: FilesystemIsolationOptions,
): FilesystemIsolationPlan {
  const sessionRoot = resolve(sessionDir);
  const additionalWritableRoots = [...new Set(options?.additionalWritableRoots ?? [])]
    .map(root => resolve(root))
    .filter(root => root !== sessionRoot);
  const deniedReadRoots = [...new Set(options?.deniedReadRoots ?? [])]
    .map(root => resolve(root));
  const deniedWriteRoots = [...new Set(options?.deniedWriteRoots ?? [])]
    .map(root => resolve(root))
    .filter(root => !deniedReadRoots.includes(root));

  const sandboxExec = process.platform === 'darwin' ? usableSandboxExecPath() : undefined;
  if (!sandboxExec && (options?.allowedReadRoots?.length ?? 0) > 0) {
    throw new Error(`sandbox-read-allowlist-unsupported:${process.platform}`);
  }
  if (sandboxExec) {
    const profile = buildDarwinSandboxProfile(sessionRoot, options);

    return {
      status: 'enforced',
      backend: 'sandbox-exec',
      command: sandboxExec,
      args: ['-p', profile, command, ...args],
    };
  }

  if (process.platform === 'linux') {
    const bwrap = resolveTrustedIsolationLauncher('bwrap');
    if (bwrap) {
      // Read-only root + writable bind mount for the session subtree.
      // This limits writes to sessionRoot while preserving runtime/library access.
      //
      // With the filesystem layer off the root is bound READ-WRITE instead, and
      // the per-root grants are dropped: they carve nothing out of a root that is
      // already writable. The launcher is still needed — the credential floor the
      // funnel keeps is expressed by the masks below and by nothing else.
      const rootBind = options?.filesystemIsolationDisabled
        ? ['--bind', '/', '/']
        : ['--ro-bind', '/', '/', '--bind', sessionRoot, sessionRoot,
           ...additionalWritableRoots.flatMap(root => ['--bind', root, root])];
      return {
        status: 'enforced',
        backend: 'bwrap',
        command: bwrap,
        args: [
          '--die-with-parent',
          ...rootBind,
          ...deniedReadRoots.flatMap(root => {
            const stats = lstatSync(root, { throwIfNoEntry: false });
            // A root that does not exist is SKIPPED here, and only here. bwrap
            // has to materialise a mount point for every bind, and it cannot
            // create one underneath `--ro-bind / /`, so naming an absent path
            // fails the whole launcher rather than denying anything. A path with
            // no file has nothing to read, and every root on the credential
            // floor sits outside the write scope, so a sandboxed command cannot
            // create one mid-run and read it back. darwin and win32 keep the
            // unconditional deny: their rules cost nothing when unmatched, and
            // there the deny does still bind a path created later.
            if (!stats) return [];
            return stats.isDirectory()
              ? ['--tmpfs', root, '--remount-ro', root]
              : ['--ro-bind', '/dev/null', root];
          }),
          // `--ro-bind-try` rather than `--ro-bind`: a denyWrite path that does
          // not exist yet must not fail the whole launcher, and re-binding the
          // path read-only after the writable binds is what makes the deny hold
          // inside a wider grant.
          ...deniedWriteRoots.flatMap(root => ['--ro-bind-try', root, root]),
          '--proc', '/proc',
          '--dev', '/dev',
          '--',
          command,
          ...args,
        ],
      };
    }

    const firejail = resolveTrustedIsolationLauncher('firejail');
    if (firejail) {
      return {
        status: 'enforced',
        backend: 'firejail',
        command: firejail,
        args: [
          '--quiet',
          // Same shape as bwrap above: `--private`/`--whitelist` ARE the write
          // scope, so the layer being off means not passing them. The blacklists
          // and read-only binds stay — they carry the credential floor.
          ...(options?.filesystemIsolationDisabled
            ? []
            : [`--private=${sessionRoot}`, `--whitelist=${sessionRoot}`,
               ...additionalWritableRoots.map(root => `--whitelist=${root}`)]),
          ...deniedReadRoots.map(root => `--blacklist=${root}`),
          ...deniedWriteRoots.map(root => `--read-only=${root}`),
          '--', command, ...args,
        ],
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
