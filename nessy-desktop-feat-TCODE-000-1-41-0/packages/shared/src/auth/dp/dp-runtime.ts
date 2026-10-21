/**
 * Shared dp runtime facts: where the system dp keeps its mutable state, and
 * the environment a dp subprocess needs under a non-interactive host.
 *
 * Extracted from the plugin dp MCP path (`agent/backend/internal/
 * runtime-resolver.ts`) so the Bash sandbox grant (Task 2), the built-in dp
 * MCP env (Task 3) and the plugin binding all share ONE definition.
 *
 * dp's access token lives ~1 hour and dp refreshes it by WRITING into this
 * state root — which is why the sandbox must grant it (owner decision
 * 2026-08-06: use the system dp everywhere; never bundle one).
 *
 * Token values never appear here; the creds-file writer stays creds-store.ts.
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { latchedHomeDir } from '../../config/home-latch.ts';

/**
 * dp's mutable state root: `$DP_WORKDIR` (trimmed) when set, else `~/.dp`.
 * Undefined when the directory does not exist, cannot be realpathed, or
 * resolves to the filesystem root or the home directory itself (a state root
 * becomes a sandbox WRITE grant in Task 2, so a whole-home grant is refused —
 * deliberate hardening over the pre-extraction plugin path). Never throws,
 * never creates directories, never caches.
 */
export function resolveDpStateRoot(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = latchedHomeDir(),
): string | undefined {
  const configured = env.DP_WORKDIR?.trim();
  return hardenDpStateRoot(configured ? configured : join(homeDir, '.dp'), homeDir);
}

/**
 * The HARDENING half of {@link resolveDpStateRoot}, applied to a candidate the
 * caller has already chosen — DA1.52, and it is extracted rather than copied
 * for a measured reason.
 *
 * DA1.6 made `dp-binary.ts` symbol `resolveDpRuntime` return the binary and the
 * workdir as ONE record, and DA1.52's hand-off proposed replacing
 * `resolveDpStateRoot()` with `resolveDpRuntime().workdir` at the two sites that
 * hand-pair them. That is right for the site whose value only becomes
 * `DP_WORKDIR` for dp itself, and WRONG for `agent/backend/internal/
 * runtime-resolver.ts` symbol `resolvePluginDpRuntime`, whose value ALSO becomes
 * a sandbox `writableRoots` grant: the record's workdir is `resolve()`d and
 * nothing else, while this function's four refusals exist precisely because
 * "a state root becomes a sandbox WRITE grant" — it is realpath-canonicalised
 * (a grant on `/var/...` does not match a child writing through
 * `/private/var/...` on macOS, which is what the conversion's own test failure
 * showed), it refuses a directory that does not exist, it refuses the
 * filesystem ROOT, and it refuses the HOME directory itself. An operator's
 * `DP_WORKDIR=$HOME` would otherwise become a whole-home write grant.
 *
 * So the conversion keeps the record AND the hardening: one call chooses the
 * rung, this call decides whether what it chose may be granted.
 *
 * Never throws, never creates directories, never caches.
 */
export function hardenDpStateRoot(
  candidate: string | undefined,
  homeDir: string = latchedHomeDir(),
): string | undefined {
  if (!candidate) return undefined;
  try {
    const resolved = resolve(candidate);
    if (!existsSync(resolved)) return undefined;
    const stateRoot = realpathSync(resolved);
    if (dirname(stateRoot) === stateRoot) return undefined;
    let home: string | undefined;
    try {
      home = realpathSync(homeDir);
    } catch {
      home = undefined;
    }
    if (home && stateRoot === home) return undefined;
    return stateRoot;
  } catch {
    return undefined;
  }
}

/**
 * The denied root that CONTAINS `stateRoot`, or `undefined` when none does —
 * DA1.49, the one definition of "may dp's state root become a write grant".
 *
 * ONE spelling, two grant sites, and until this row they were not the same
 * mechanism at all: `server-core`'s `bootstrap/host-sandbox-settings.ts` symbol
 * `withDpStateRootWriteGrant` asked this question inline and REFUSED with a
 * diagnostic, while `agent/backend/internal/runtime-resolver.ts` symbol
 * `resolvePluginDpRuntime` granted `writableRoots: [stateRoot]` with NO deny
 * check whatsoever. `shared` cannot import `server-core`, so the two could not
 * share code where the check lived; moving it here is what makes them one.
 *
 * CONTAINMENT IS PREFIX-ON-A-SEPARATOR, deliberately, and it is the same test
 * the inline version used: `root === deny`, or `root` starts with `deny` plus a
 * path separator. A bare `startsWith(deny)` would make `/home/user/.sshkeys`
 * look like it lives inside `/home/user/.ssh`. Both callers pass roots that
 * have already been realpath-canonicalised ({@link hardenDpStateRoot} on one
 * side, the resolver's own floor on the other), which is what lets a string
 * comparison stand in for a filesystem one.
 *
 * WHY A DENIED ROOT MUST WIN OVER THE GRANT: seatbelt emits denies after
 * allows, so a grant inside a denied root never binds. The caller that has a
 * diagnostic channel says so once instead of shipping a silent no-op; the
 * caller that has none (the plugin binding returns a value, not a report)
 * withholds the grant silently and relies on the host emitting the sentence for
 * the same root — the two see the same floor, so the operator is still told.
 */
export function dpStateRootDeniedBy(
  stateRoot: string,
  deniedRoots: readonly string[],
): string | undefined {
  return deniedRoots.find(deny => stateRoot === deny || stateRoot.startsWith(`${deny}/`));
}

/**
 * Env a dp subprocess needs under a non-interactive host: silence update
 * warnings (stdout noise breaks MCP stdio framing) and never attempt the
 * interactive browser login. The caller resolves the state root via
 * `resolveDpStateRoot()` and passes it explicitly; `undefined` means
 * "no state root", and `DP_WORKDIR` is omitted. Carries no token and never will.
 *
 * `HOME` is the session's latched home (P3.143), not a live `os.homedir()`.
 * This is the value handed to the process that MINTS the token, so a confirmed
 * managed `HOME` moving it mid-session would point dp at a different account's
 * state root and let it mint against it. The confirmed variable still reaches
 * `process.env` and still reaches every other subprocess — the latch is scoped
 * to the session's own credential source. See `config/home-latch.ts`.
 */
export function dpRuntimeEnvironment(
  stateRoot: string | undefined,
): Record<string, string> {
  return {
    HOME: latchedHomeDir(),
    DP_NO_WARNINGS: 'true',
    DP_AI_MCP_SKIP_LOGIN: 'true',
    ...(stateRoot ? { DP_WORKDIR: stateRoot } : {}),
  };
}
