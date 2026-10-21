/**
 * The hook env-file channel (R85 · f141).
 *
 * hooks.md § SessionStart, "Persist environment variables": "SessionStart hooks
 * have access to the `CLAUDE_ENV_FILE` environment variable, which provides a
 * file path where you can persist environment variables for subsequent Bash
 * commands." A hook APPENDS `export` lines to that file with `>>`; every later
 * Bash command of the session then runs with those variables in effect.
 *
 * Both halves live here so they cannot drift apart:
 *
 * - WRITE — {@link ensureHookEnvFile} mints the per-session file and
 *   {@link HOOK_ENV_FILE_EVENTS} says which events may see it. The variable is
 *   emitted under BOTH spellings (`NESSY_ENV_FILE` and `CLAUDE_ENV_FILE`), the
 *   same two-name convention `plugins/data-paths.ts` already uses for
 *   `NESSY_PLUGIN_ROOT`/`CLAUDE_PLUGIN_ROOT`.
 * - READ — {@link resolveHookEnvFileShellStart} rewrites the Bash tool's
 *   `/bin/sh -lc <cmd>` invocation into `<source the file>; <cmd>` and returns
 *   the host-owned child env the preamble reads the path from.
 *
 * ## Why a shell PREAMBLE and not an env merge
 *
 * The page's own recipes are `export PATH="$PATH:./node_modules/.bin"` and an
 * `export -p` before/after diff piped through `comm -13`. Both need the shell to
 * EVALUATE the line — `$PATH` has to expand against the child's own PATH, not
 * against a snapshot the host parsed. A key/value merge would ship a channel
 * that passes a `FOO=bar` demo and silently corrupts the documented PATH recipe.
 *
 * ## Scope, stated rather than implied
 *
 * `Setup` is in the page's list and is deliberately ABSENT from
 * {@link HOOK_ENV_FILE_EVENTS}: R73 removed the event from this fork entirely
 * (see `UNEMITTED_HOOK_EVENT_REASONS` in `types.ts`), so there is no occurrence
 * to carry a variable on. Our set is the remaining three.
 *
 * The read-back is **Pi-only, and that is a recorded non-goal for the other two
 * backends** — not an oversight. The Claude runtime and Codex fix their child
 * environment once at subprocess spawn and expose Bash only as an approval
 * callback, so there is no per-command host seam to source a file at; minting
 * the variable for their SessionStart hooks would hand an author a file whose
 * exports never apply. It barely narrows the feature: `CwdChanged` and
 * `FileChanged` are emitted only by the Pi lifecycle bridge, so two of the three
 * in-scope events are Pi-exclusive already.
 *
 * POSIX-only, same reasoning. The documented artifact is a file of `export`
 * lines sourced with `.`; on win32 the Bash tool runs `cmd.exe /d /s /c`, which
 * cannot read one, and the page offers no `cmd` form. Rather than mint a
 * variable no one can consume, the whole channel is off there — see
 * {@link hookEnvFileSupported}.
 *
 * ## Security
 *
 * The file's content is executed by the shell before every later Bash command,
 * so the question that decides everything is WHO CAN WRITE IT.
 *
 * - It lives under the session storage directory, never inside the workspace.
 *   The Bash tool's write floor is the workspace root plus the scratch root, so
 *   the model cannot write here. Only the hook spawn gets it, through one narrow
 *   `additionalWritableRoots` entry — the `hook-env/` SUBDIRECTORY, not the
 *   session directory itself, so a hook still cannot rewrite `session.jsonl`.
 * - {@link resolveHookEnvFileForRead} refuses anything that is not a REGULAR
 *   file (`lstat`, so a symlink is refused rather than followed). Without that a
 *   symlink pointing back into the workspace would turn a model-written file
 *   into code that runs before every command.
 * - {@link HOOK_ENV_FILE_MAX_BYTES} caps it. `>>` appends, and hooks re-run on
 *   resume and after every compaction, so an unbounded file is the natural
 *   failure mode rather than an exotic one.
 * - The path is HOST-owned and derived from `{workspaceId, sessionId}`. It is
 *   never read out of the child's start request — `pickSupervisedChildStartFields`
 *   carries no `env`, and this must not become the field that widens it.
 * - The preamble is a compile-time CONSTANT with no path in it; the path travels
 *   as a host-set child env value the preamble dereferences, so there is no
 *   string for a path to break out of and no per-session variation in the line a
 *   user's `sandbox.excludedCommands` glob is matched against.
 * - The rewrite is refused unless the invocation is EXACTLY the shape the Pi
 *   subprocess mints for `bash`/`bash_background`. A plugin-MCP or LSP start is
 *   left byte-identical.
 *
 * Residual, stated: the file's content is arbitrary shell code, and a hook can
 * already run arbitrary commands on the user's machine — this channel does not
 * widen the hook's authority, it extends its LIFETIME to the rest of the
 * session. A line grammar ("only `export …`") was considered and rejected: the
 * page's own `export -p | comm -13` recipe emits `declare -x` under bash, so the
 * grammar would reject a documented recipe — the demos-perfectly-does-nothing
 * shape in reverse.
 */

import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { getSessionStoragePath, isPathWithin, resolveContainedPath } from '../workspaces/paths.ts';
import type { AgentEvent } from './types.ts';

/**
 * hooks.md: "`CLAUDE_ENV_FILE` is available for SessionStart, Setup, CwdChanged,
 * and FileChanged hooks. Other hook types don't have access to this variable."
 * `Setup` is omitted because this fork does not emit it at all (R73/f001); the
 * remaining three are the closed set, and the sentence above is the reason it
 * must not silently widen.
 */
export const HOOK_ENV_FILE_EVENTS: ReadonlySet<AgentEvent> = new Set<AgentEvent>([
  'SessionStart',
  'CwdChanged',
  'FileChanged',
]);

/**
 * The Bash tool's two semantic ids. hooks.md scopes the channel to "subsequent
 * Bash commands", so the read-only helper runtimes (`read`, `grep`, `find`, …)
 * that ride the same supervised-process seam are deliberately NOT included.
 */
export const HOOK_ENV_FILE_SHELL_SEMANTIC_IDS: ReadonlySet<string> = new Set([
  'bash',
  'bash_background',
]);

/** The directory granted to hook spawns — narrower than the session directory. */
const HOOK_ENV_DIR_NAME = 'hook-env';
const HOOK_ENV_FILE_NAME = 'env.sh';

/** The exact invocation `requestSupervisedProcess` mints on POSIX. */
const POSIX_SHELL_COMMAND = '/bin/sh';
const POSIX_SHELL_FLAG = '-lc';

/**
 * The host-owned variable the preamble dereferences. Deliberately NOT
 * `CLAUDE_ENV_FILE`: that name is the HOOK's contract and implies "write here",
 * and the model's shell must not read it as an invitation. Set on the child
 * environment, which the host rebuilds per start — a subprocess cannot supply
 * one, because `pickSupervisedChildStartFields` carries no `env` field.
 */
export const HOOK_ENV_FILE_CHILD_ENV_KEY = 'NESSY_HOOK_ENV_FILE';

/**
 * The preamble prepended to the model's Bash command. A COMPILE-TIME CONSTANT
 * with no path in it, and joined with `;` rather than a newline. Both choices
 * are forced by one thing the first draft got wrong:
 *
 * `ProcessSupervisor.resolveIsolationDowngrade` matches a user's
 * `sandbox.excludedCommands` globs against `[command, ...args].join(' ')`, and
 * `globMatches` compiles `*` to `.*`, which does NOT cross a newline. A
 * newline-joined preamble therefore made every `*docker*`-style exclusion stop
 * matching the moment a hook wrote an env var — silently, and only for users who
 * had configured one. Measured, not assumed. `;` keeps those globs matching.
 *
 * GRANT-GLOB-NEWLINE. Three files are involved and none of them is this one's
 * neighbour: the compiler is `config/sandbox-settings.ts` `globMatches`, the
 * matcher is `server-core/src/pi-harness/process-supervisor.ts`, and the string
 * they judge is minted at {@link withHookEnvFileShellSource} below. That is why
 * the dependency is restated AT the join rather than only here, and why
 * `hook-env-file.test.ts` pins the separator through the REAL compiler instead of
 * a copy of it. The missing `s` flag is a recorded decision, not a latent bug
 * about to be fixed out from under this workaround — see `globMatches`.
 *
 * Keeping the PATH out of the line is the other half: with the path inlined, the
 * string a user's glob is matched against would vary per session, so an
 * exclusion could start or stop firing depending on the session id. As a
 * constant the perturbation is one fixed, Nessy-branded prefix.
 *
 * Double quotes are safe for any value — a path with spaces included — which is
 * why no quoting guard is needed once the path travels as an env value.
 *
 * Residual, stated: a user glob broad enough to match this constant (`*env*`,
 * say) will match every Bash command once the channel is live.
 */
export const HOOK_ENV_FILE_SOURCE_PREAMBLE =
  `if [ -r "$${HOOK_ENV_FILE_CHILD_ENV_KEY}" ]; then . "$${HOOK_ENV_FILE_CHILD_ENV_KEY}"; fi;`;

/** Sourced before every Bash command, so an unbounded file is a per-command cost. */
export const HOOK_ENV_FILE_MAX_BYTES = 64 * 1024;

/**
 * POSIX only. The channel's artifact is a file of `export` lines sourced with
 * `.`; `cmd.exe /d /s /c` cannot consume one and the page documents no
 * alternative form, so minting the variable on win32 would be a promise nothing
 * keeps.
 */
export function hookEnvFileSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

/** The one directory a hook spawn is granted write access to. */
export function hookEnvFileDirPath(workspaceId: string, sessionId: string): string {
  return resolveContainedPath(getSessionStoragePath(workspaceId, sessionId), HOOK_ENV_DIR_NAME);
}

export function hookEnvFilePath(workspaceId: string, sessionId: string): string {
  return resolveContainedPath(hookEnvFileDirPath(workspaceId, sessionId), HOOK_ENV_FILE_NAME);
}

/**
 * Replace whatever sits at `path` with a fresh empty 0600 regular file.
 *
 * Unlinks first rather than truncating: `writeFileSync` FOLLOWS a symlink, so a
 * path that had been turned into one would have its target truncated instead.
 */
function writeEmptyRegularFile(path: string): void {
  rmSync(path, { force: true });
  writeFileSync(path, '', { mode: 0o600, flag: 'wx' });
}

/**
 * Create the per-session env file if it is absent and return its absolute path.
 * Idempotent, so no lifecycle wiring is required — the first in-scope hook of a
 * session mints it. Returns `undefined` (channel simply off) rather than
 * throwing: a hook must never fail to run because its env file could not be
 * created.
 */
export function ensureHookEnvFile(workspaceId: string, sessionId: string): string | undefined {
  if (!hookEnvFileSupported()) return undefined;
  try {
    const directory = hookEnvFileDirPath(workspaceId, sessionId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = hookEnvFilePath(workspaceId, sessionId);
    if (!existsSync(path) || !lstatSync(path).isFile()) writeEmptyRegularFile(path);
    return path;
  } catch {
    return undefined;
  }
}

/**
 * Truncate the file at the start of a Pi runtime.
 *
 * Per RUNTIME, never per event: a resumed session re-runs SessionStart with
 * `source: 'resume'`, and the documented `>>` would otherwise accumulate a
 * duplicate `export` block on every launch until the size cap turned the channel
 * off. The post-compaction SessionStart deliberately does NOT reset — the
 * variables a hook established must survive a compaction.
 */
export function resetHookEnvFile(workspaceId: string, sessionId: string): void {
  if (!hookEnvFileSupported()) return;
  try {
    mkdirSync(hookEnvFileDirPath(workspaceId, sessionId), { recursive: true, mode: 0o700 });
    writeEmptyRegularFile(hookEnvFilePath(workspaceId, sessionId));
  } catch {
    // Same fail-quiet rule as `ensureHookEnvFile`: a stale file is a wrong
    // environment, but a thrown error here would be a dead session.
  }
}

/**
 * The read-side gate. Returns the path only when it is safe to source.
 *
 * `modelWritableRoots` are the roots the model's own Bash commands may write —
 * the workspace root today. A user whose workspace happens to CONTAIN the config
 * directory would otherwise get an env file the model itself can author, which
 * is the one shape that turns this channel into a privilege escalation.
 */
export function resolveHookEnvFileForRead(
  workspaceId: string,
  sessionId: string,
  options?: { modelWritableRoots?: readonly (string | undefined)[] },
): string | undefined {
  if (!hookEnvFileSupported()) return undefined;
  let path: string;
  try {
    path = hookEnvFilePath(workspaceId, sessionId);
  } catch {
    return undefined;
  }
  for (const root of options?.modelWritableRoots ?? []) {
    if (root && isPathWithin(root, path)) return undefined;
  }
  try {
    const stat = lstatSync(path);
    // `lstat`, so a SYMLINK reports `isFile() === false` and is refused instead
    // of followed to whatever it points at.
    if (!stat.isFile()) return undefined;
    if (stat.size === 0 || stat.size > HOOK_ENV_FILE_MAX_BYTES) return undefined;
  } catch {
    return undefined;
  }
  return path;
}

/** The two host-owned pieces a rewritten Bash start needs. */
export interface HookEnvFileShellStart {
  /** Replacement `args` for the supervised-process start. */
  args: string[];
  /** Host-owned child environment carrying the path the preamble dereferences. */
  env: Record<string, string>;
}

/**
 * Rewrite a supervised-process start into one that sources the env file first.
 *
 * Returns `undefined` when the request must be left byte-identical. The shape
 * guard is the part that can silently corrupt an unrelated spawn, so it is
 * exact: only the `/bin/sh -lc <cmd>` pair the Pi subprocess mints for
 * `bash`/`bash_background`, and only with a non-empty command — an empty one
 * would inherit the preamble's exit status instead of its own.
 */
export function withHookEnvFileShellSource(
  request: { semanticId?: string; command: string; args?: readonly string[] },
  filePath: string | undefined,
): HookEnvFileShellStart | undefined {
  if (!filePath || !isAbsolute(filePath)) return undefined;
  if (!request.semanticId || !HOOK_ENV_FILE_SHELL_SEMANTIC_IDS.has(request.semanticId)) return undefined;
  if (request.command !== POSIX_SHELL_COMMAND) return undefined;
  const args = request.args;
  if (!args || args.length !== 2 || args[0] !== POSIX_SHELL_FLAG) return undefined;
  const command = args[1];
  if (typeof command !== 'string' || command.trim() === '') return undefined;
  return {
    // GRANT-GLOB-NEWLINE — this separator is load-bearing, and its reason is TWO
    // files away. `config/sandbox-settings.ts` `globMatches` compiles `*` to `.*`
    // with no `s` flag, and `ProcessSupervisor.resolveIsolationDowngrade`
    // (`server-core/src/pi-harness/process-supervisor.ts`) matches the user's
    // `sandbox.excludedCommands` globs against `[command, ...args].join(' ')`.
    // A line terminator ANYWHERE in the string below therefore makes every
    // `*docker*`-style exclusion stop matching — silently, and only for the users
    // who configured one. Do NOT "tidy" this space, or the preamble's trailing
    // `;`, into a newline: `hook-env-file.test.ts` fails if you do, and it says
    // why. The compiler is not going to be fixed out from under this — the
    // missing `s` is a recorded decision, stated at `globMatches` itself.
    args: [POSIX_SHELL_FLAG, `${HOOK_ENV_FILE_SOURCE_PREAMBLE} ${command}`],
    env: { [HOOK_ENV_FILE_CHILD_ENV_KEY]: filePath },
  };
}

/**
 * The whole read side in one call — the single seam `pi-agent.ts` uses, so the
 * host's glue is one line and every rule above is exercised by one test.
 */
export function resolveHookEnvFileShellStart(
  request: { semanticId?: string; command: string; args?: readonly string[] },
  context: {
    workspaceId: string;
    sessionId: string;
    modelWritableRoots?: readonly (string | undefined)[];
  },
): HookEnvFileShellStart | undefined {
  if (!request.semanticId || !HOOK_ENV_FILE_SHELL_SEMANTIC_IDS.has(request.semanticId)) return undefined;
  const filePath = resolveHookEnvFileForRead(context.workspaceId, context.sessionId, {
    ...(context.modelWritableRoots ? { modelWritableRoots: context.modelWritableRoots } : {}),
  });
  return withHookEnvFileShellSource(request, filePath);
}
