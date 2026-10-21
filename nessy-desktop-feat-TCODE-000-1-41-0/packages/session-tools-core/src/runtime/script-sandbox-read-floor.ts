import { credentialDenyRoots } from './credential-deny-roots.ts';

/**
 * The host's read policy for `script_sandbox`, composed in the leaf — F1.107
 * (origin `D1.432`, the F1.12 safety review's critic).
 *
 * ## What was measured
 *
 * Every isolation backend grants ambient whole-filesystem READ and scopes only
 * writes (`credential-deny-roots.ts` names the page that says so), so an
 * explicit deny is the only thing that removes a read. `script_sandbox` passed
 * exactly ONE such list — the host credential floor — and neither
 * `permissions.deniedPaths` nor
 * `permissions.blockReadsOutsideWorkingDirectories` reached it by any route:
 * the tool's input carries no `path`/`file_path`, so the per-tool gate
 * (`mode-manager.ts` symbol `getDeniedPathViolation`) has nothing to inspect,
 * and the tool is absent from `READS_OUTSIDE_WORKING_DIRECTORIES_TOOLS`, so the
 * fence never saw it either.
 *
 * Measured rather than inferred, by `handlers/script-sandbox-read-floor.test.ts`
 * driving the real handler and a real `sandbox-exec` profile: a script read a
 * file under a host-declared denied root and returned its contents in stdout,
 * with `filesystemIsolation: enforced` on the same receipt, while the
 * credential-floor control in the same run was refused. So the profile binds
 * and the policy was simply absent from it.
 *
 * ## The host SUPPLIES the policy; this package does not look it up
 *
 * `@nessy-agent/shared` depends on this package and never the other way round,
 * so a handler here cannot read `permissionsConfigCache` or the stored config.
 * That is why the credential floor is already built from two caller-supplied
 * roots, and the same rule applies to the two read policies: the owning runtime
 * fills `SessionToolContext.sandboxReadFloor`
 * (`shared/agent/pi-harness/session-tool-sandbox-read-floor.ts` supplies it for
 * the claude and pi runtimes through `createClaudeContext`, and — F1.196 — for
 * codex through the session-MCP argv, `CodexSandboxReadArgs` in
 * `session-mcp-server/src/index.ts`). The credential roots anchor on the home
 * `SessionToolContext.credentialHomeDir` names (F1.191: the host's LATCHED
 * home), bound on all three runtimes the same two ways.
 *
 * ## A context that supplies nothing behaves exactly as before, VISIBLY
 *
 * Both accessors are optional, so a context that supplies neither keeps the
 * credential floor anchored on the live `os.homedir()` and nothing more. That
 * state is REPORTED on the tool's own receipt (`readFloor:` names how many
 * roots the profile carried and whether the host declared a policy at all)
 * rather than left silent, because a per-runtime difference nobody can see is
 * the defect class this fork pays for most.
 */
export interface ScriptSandboxReadFloor {
  /** Absolute roots added to the profile's read denials, credential floor first. */
  readonly deniedReadRoots: readonly string[];
  /** The receipt line, so the caller never formats this in two places. */
  readonly receipt: string;
  /**
   * Set when the host says reads are fenced to the working directories and the
   * tool must therefore not run at all. See
   * {@link SCRIPT_SANDBOX_READS_FENCED_REFUSAL}.
   */
  readonly refusal?: string;
}

/**
 * Why a fence becomes a REFUSAL rather than a narrower profile.
 *
 * `permissions.blockReadsOutsideWorkingDirectories` names an ALLOW boundary —
 * everything outside the working directories is refused — and a tool whose
 * backends grant ambient read can only honour that by switching to a read
 * ALLOWLIST. Exactly one of the three backends can express one: `sandbox-exec`
 * has a re-allow rule, bwrap's read scope is the `--ro-bind / /` it starts from
 * and firejail's `--whitelist` is a write scope, which is why
 * `filesystem-isolation.ts` THROWS on a configured allowlist instead of
 * dropping it. Emitting a fence that binds on one platform and not the other
 * two is the failure its own docblock refuses.
 *
 * So the honest projection of "refuse reads outside the working directories" is
 * to refuse the tool, in the fail-closed idiom this handler already uses for an
 * unavailable backend. The setting ships OFF
 * (`apps/electron/resources/config-defaults.json`), so this reaches only an
 * operator who turned it on — for whom refusing is what they asked for.
 *
 * RESIDUE, stated: a darwin-only read fence (deny `$HOME`, re-allow the working
 * directory and the roots a runtime needs to start) would let the tool keep
 * working under the setting. It needs the built-in read-allow set that today
 * lives in `server-core/src/pi-harness/isolation.ts` symbol
 * `builtInReadAllowRoots`, which this package cannot import, so it is a
 * separate row rather than a hidden approximation.
 */
export const SCRIPT_SANDBOX_READS_FENCED_REFUSAL =
  'script_sandbox is unavailable while permissions.blockReadsOutsideWorkingDirectories is on: '
  + 'its sandbox grants ambient whole-filesystem read, which that setting refuses, and a read '
  + 'allowlist binds on only one of the three isolation backends. Turn the setting off, or use '
  + 'the file tools, which honour it per read.';

/**
 * Compose the credential floor and the host's declared read policy into the one
 * list the isolation call takes.
 *
 * The credential floor comes FIRST and is never filtered by anything here: it
 * is the only protection those files have, and this module's job is to ADD to
 * it. `floor` absent means the owning runtime declared no policy, which is
 * reported rather than assumed to mean "no policy exists".
 */
export function scriptSandboxReadFloor(
  homeDir: string,
  configDir: string,
  floor: {
    readonly deniedReadRoots?: readonly string[];
    readonly readsFencedToWorkingDirectory?: boolean;
  } | undefined,
  platform: NodeJS.Platform = process.platform,
): ScriptSandboxReadFloor {
  const credential = credentialDenyRoots(homeDir, configDir, platform);
  const declared = (floor?.deniedReadRoots ?? []).filter(root => !credential.includes(root));
  const deniedReadRoots = [...credential, ...declared];
  const receipt = floor
    ? `${deniedReadRoots.length} denied roots (${credential.length} credential floor, ${declared.length} host read policy)`
    : `${deniedReadRoots.length} denied roots (credential floor only; this runtime declares no read policy)`;
  return floor?.readsFencedToWorkingDirectory === true
    ? { deniedReadRoots, receipt, refusal: SCRIPT_SANDBOX_READS_FENCED_REFUSAL }
    : { deniedReadRoots, receipt };
}
