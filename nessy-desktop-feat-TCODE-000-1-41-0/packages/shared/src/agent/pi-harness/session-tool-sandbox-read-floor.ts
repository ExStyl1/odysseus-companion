/**
 * F1.107 (origin `D1.432`) — the host's READ policy, resolved once for the
 * session tools that spawn a sandboxed subprocess of their own.
 *
 * ## The hole this closes, as measured
 *
 * `script_sandbox` runs model-authored Python/Node/Bun under `sandbox-exec` /
 * bwrap / firejail. Every one of those backends grants ambient whole-filesystem
 * READ and scopes only writes — `credential-deny-roots.ts` says so and names
 * the page — so an explicit deny is the only thing that removes a read. The
 * handler passed exactly one such list, the host credential floor, and nothing
 * else: `permissions.deniedPaths` and
 * `permissions.blockReadsOutsideWorkingDirectories` reached it through no path
 * at all. Its input carries no `path`/`file_path`, so
 * `getDeniedPathViolation` has nothing to look at, and `script_sandbox` is not
 * in `READS_OUTSIDE_WORKING_DIRECTORIES_TOOLS`, so the fence never saw it
 * either.
 *
 * Measured, not inferred, by
 * `session-tools-core/src/handlers/script-sandbox-read-floor.test.ts`: with
 * `filesystemIsolation: enforced` and a real `sandbox-exec` profile, a script
 * read a file under a host-declared denied root and returned its contents in
 * stdout, while the credential-floor control on the same rig in the same run
 * was refused. So the profile binds and the policy was simply absent from it.
 *
 * ## Why the resolution lives HERE and the composition lives in the leaf
 *
 * `@nessy-agent/shared` depends on `@nessy-agent/session-tools-core` and never
 * the other way round (`credential-deny-roots.ts`, `sandbox-env.ts` and three
 * more docblocks state the direction). The tool handler therefore cannot read
 * `permissionsConfigCache` or the stored config at all — which is why the
 * credential floor is already passed IN by its caller rather than looked up.
 * This module is the caller-side half, and the field it fills
 * (`SessionToolContext.sandboxReadFloor`) is an ACCESSOR rather than a value
 * for the reason `memoryEnabled` and `userMemoryPath` are: the tools built
 * around a context are cached per session, so a policy captured at
 * construction would freeze for the life of the chat.
 *
 * ## It is a projection, and a deliberately partial one
 *
 * `permissionsConfigCache.getMergedConfig` is the ONE derivation of
 * `deniedPaths` in this product (`claude-agent.ts` and `codex-agent.ts` read
 * the same call), so this is not a second copy of the rule. What is partial is
 * the SHAPE: only the two exactly-convertible glob forms become subpath roots
 * — see {@link sandboxRootsFromDeniedPaths} — and the context supplies no
 * active source slugs, so per-source denies are not projected. Both residues
 * fail in the safe direction: the permission layer still enforces every entry
 * for every tool that takes a path, and the sandbox denies a subset rather than
 * a superset. Stated rather than hidden, because an undocumented partial
 * control is indistinguishable from a defect.
 */

import { getBlockReadsOutsideWorkingDirectories } from '../../config/storage.ts';
import { permissionsConfigCache } from '../permissions-config.ts';
import { sandboxRootsFromDeniedPaths } from './sandbox-permission-rules.ts';

/**
 * What a session tool that spawns its own sandboxed child needs to know about
 * the host's read policy. Mirrors `SessionToolContext.sandboxReadFloor`'s
 * return type, which is spelled inline there so the leaf package needs no
 * import of this module (the dependency direction forbids one).
 */
export interface SessionToolSandboxReadFloor {
  /** Absolute roots to add to the sandbox profile's read denials. */
  readonly deniedReadRoots: readonly string[];
  /**
   * `permissions.blockReadsOutsideWorkingDirectories`.
   *
   * A tool that grants ambient whole-filesystem read cannot honour this by
   * denying a list — the setting names an ALLOW boundary, and only one of the
   * three isolation backends can express a read allowlist at all
   * (`filesystem-isolation.ts`, which THROWS rather than dropping one). So the
   * honest projection is a refusal, and the consumer makes it; this flag is
   * only the reading.
   */
  readonly readsFencedToWorkingDirectory: boolean;
  /** One line per `deniedPaths` entry the boundary cannot restate. */
  readonly diagnostics: readonly string[];
}

/**
 * Resolve the floor for one workspace. Never throws: a permissions file that
 * fails to parse must not stop a sandboxed diagnostic from running, and the
 * credential floor — the part that protects credentials — is composed in the
 * leaf and is not this function's to lose.
 */
export function resolveSessionToolSandboxReadFloor(
  workspaceRootPath: string,
): SessionToolSandboxReadFloor {
  let deniedPaths: readonly string[] = [];
  try {
    deniedPaths = permissionsConfigCache.getMergedConfig({ workspaceRootPath }).deniedPaths ?? [];
  } catch {
    deniedPaths = [];
  }
  let readsFencedToWorkingDirectory = false;
  try {
    readsFencedToWorkingDirectory = getBlockReadsOutsideWorkingDirectories();
  } catch {
    readsFencedToWorkingDirectory = false;
  }
  const { roots, diagnostics } = sandboxRootsFromDeniedPaths(deniedPaths);
  return { deniedReadRoots: roots, readsFencedToWorkingDirectory, diagnostics };
}
