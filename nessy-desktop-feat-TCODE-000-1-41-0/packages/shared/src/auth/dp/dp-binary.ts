/**
 * dp binary resolution + version-floor check.
 *
 * `resolveDpRuntime` is the single seam that knows BOTH where dp lives and
 * which state root it must be paired with (DA1.6). It is SYNC, it never execs
 * dp and it never reads a credential file: resolution is `accessSync(X_OK)`
 * alone, so a machine without dp degrades to a named
 * diagnostic instead of a crash or a hang, and no test depends on the host
 * having the binary or on the network. `resolveDpBinary()` is a thin wrapper
 * kept for the callers that only want the path.
 *
 * It WRITES NOTHING since F1.363: the state root is dp's own default unless
 * `DP_WORKDIR` names one, so the `<CONFIG_DIR>/dp/state` it used to create is
 * gone — see `resolveManagedWorkdir`. The never-execs contract
 * (`packages/shared/src/mcp/builtin-dp-servers.ts`, its module docblock) is
 * intact.
 */

import { accessSync, constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { delimiter, join, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import { CONFIG_DIR } from '../../config/paths.ts';
// (F1.363) no home-directory import: the state root is dp's default unless DP_WORKDIR names one.
import { DpAuthError, DpAuthServiceError } from './errors.ts';
import type { DpExecOptions } from './dp-api.ts';
import { getNessyDir } from './creds-store.ts';
import { combineAbort, dpExecEnv } from './internal.ts';

const execFileAsync = promisify(execFile);

const DP_FALLBACK_PATH = '/usr/local/bin/dp';
const DP_NOT_FOUND_MESSAGE = 'dp not found — contact corp IT';

/**
 * Platform basename of the dp executable — nessy-cli's `dpBaseName()`
 * (`packages/core/src/dp/dpConfig.ts`), which is `dp.exe` on win32 and `dp`
 * everywhere else. Read from their source rather than hand-spelled, because
 * rung 4 of the ladder resolves THEIR file and a second spelling of the same
 * name is how the two halves drift apart.
 */
const DP_BASENAME = process.platform === 'win32' ? 'dp.exe' : 'dp';

/**
 * Rung 1 of the ladder: the variable that names an explicit dp.
 *
 * **The name is the surface owner's, not ours** (§READ-do-not-INVENT). The
 * plan's row was written around `NESSY_DP_PATH`; that string occurs in ZERO
 * files of nessy-cli AND in zero files of this tree, so there is nothing to
 * rename — there is only a name to take. nessy-cli publishes `NESSY_DP`: a
 * `${NESSY_DP}` placeholder resolvable in an MCP server's `command`, defaulting
 * to their `getDpFilePath()`, with a user-set `process.env.NESSY_DP` winning
 * (their `a7b7e2374`, AIDT-7054, documented in their
 * `docs/fork-patches/mcp-managed-dp-placeholder.md`). Honouring the same name
 * means a user who already exported it for the CLI gets the same dp here.
 *
 * **`NESSY_RUNTIME_DIR` is deliberately NOT mirrored**, and the row asks this
 * question explicitly. Their `NESSY_RUNTIME_DIR` relocates runtime OUTPUT
 * (conversations, logs, todos) through `Storage.getRuntimeBaseDir()`; their dp
 * paths do not go through it — `getDpFolderPath()` calls
 * `Storage.getGlobalNessyDir()`, which reads `NESSY_HOME` — so mirroring it
 * would move THEIR binary somewhere its own owner never puts it. This is the
 * same verdict `creds-store.ts` symbol `getNessyDir` already records for the
 * credential file, reached from the binary's side and agreeing with it.
 */
export const NESSY_DP_ENV = 'NESSY_DP';

/** Which rung of the ladder answered. Diagnostic only; never a switch. */
export type DpRuntimeSource = 'override' | 'system' | 'managed' | 'nessy-cli';

/**
 * One dp binary paired with the state root it must run against. Produced only
 * by {@link resolveDpRuntime}, so a caller can never pair a binary from one
 * rung with a state root derived independently — which is what
 * `builtin-dp-servers.ts` and `runtime-resolver.ts` each do today.
 *
 * `workdir` undefined means "dp uses its own `~/.dp`", which is the dominant
 * and DESIRED case (Target scheme clause 3).
 */
export interface DpRuntimeRecord {
  readonly dpPath: string;
  readonly workdir?: string;
  readonly source: DpRuntimeSource;
}

export interface ResolveDpRuntimeOptions {
  /** Environment to read `NESSY_DP` / `DP_WORKDIR` / `PATH` from. Test seam. */
  env?: NodeJS.ProcessEnv;
  pathEnv?: string;
  fallbackPath?: string;
  configDir?: string;
  homeDir?: string; // RETAINED, no longer read (F1.363) — callers still pass it
  nessyDir?: string;
  /** Executable-bit predicate. Test seam — the ladder is table-driven on it. */
  isRunnable?: (path: string) => boolean;
  /** RETAINED, no longer read (F1.363): no `~/.dp` probe. Callers still pass it. */
  dirExists?: (path: string) => boolean;
  /** RETAINED, no longer read (F1.363): nothing is created. Callers still pass it. */
  ensureStateRoot?: (dir: string) => void;
}

/** `<CONFIG_DIR>/dp/bin/dp` — rung 3, the copy this product would own. */
export function managedDpBinaryPath(configDir: string = CONFIG_DIR): string {
  return join(configDir, 'dp', 'bin', DP_BASENAME);
}

/**
 * `<CONFIG_DIR>/dp/state` — the state root the ladder handed dp when the user
 * had no `~/.dp` of their own, UNTIL F1.363: nothing selects it now (dp uses
 * its own default), and it stays exported for the one reader that may still
 * find it on disk — a user who signed in through it before. NEVER
 * `~/.nessy/dp_latest`: that is nessy-cli's private
 * tree, it is inside the permission layer's default `~/.nessy/**` deny
 * (`packages/session-tools-core/src/runtime/credential-deny-roots.ts`), and
 * writing another product's state root is what DP-1 revoked. Both
 * `<CONFIG_DIR>/dp/bin` and `<CONFIG_DIR>/dp/state` survive that floor — there
 * is no `~/.nessy-agent/**` deny entry.
 */
export function managedDpStateRoot(configDir: string = CONFIG_DIR): string {
  return join(configDir, 'dp', 'state');
}

/** `<NESSY_HOME>/dp_latest/dp` — rung 4, nessy-cli's own managed copy. */
export function nessyCliDpBinaryPath(nessyDir: string = getNessyDir()): string {
  return join(nessyDir, 'dp_latest', DP_BASENAME);
}

/**
 * Binaries a probe has found unusable, path → reason code. A demoted candidate
 * is SKIPPED while any other runnable candidate exists and is TAKEN when it is
 * the only one — so `DP_MIN_VERSION` stays warn-only for usability (00-context
 * decision 5) while still steering the ladder, which is exactly what the row
 * asks of it. Process-lifetime only; nothing is persisted.
 */
const demotedDpBinaries = new Map<string, 'below-floor' | 'unrunnable'>();

/**
 * **Three producers, in two modules, and each reason is earned differently.**
 * `'below-floor'` comes from `session-broker.ts` symbol `runProbe`, which
 * demotes on `isDpVersionSupported(version) === false` and undemotes otherwise.
 * `'unrunnable'` has TWO, both of which know the binary is dead rather than
 * guessing: `dp-provision.ts` symbol `ensureManagedDp` (DA1.48), which sets it
 * on the one binary it wrote itself and whose liveness run it just watched
 * fail — see "Whose slot it is" below; and `runProbe` (DA1.77), on ANY rung
 * whose dp refused to START.
 *
 * **The residue that reservation was also about is CLOSED (DA1.77).** A dp on
 * any rung whose X bit is set but which cannot actually exec used to pin the
 * ladder forever, because `resolveDpRuntime` tests runnability with
 * `accessSync(X_OK)` — which passes on a zero-byte file, on a script with a
 * missing interpreter and on a DIRECTORY — and therefore re-picked the same
 * candidate on every call. Measured at `61cfc4659`: three consecutive
 * resolutions all answered the dead rung-1 path, two consecutive probes both
 * answered `{state:'error', code:'ExecFailed'}`, and a perfectly good rung-4 dp
 * was never reached. DA1.6 Behavior item 2 — "unless a cached probe says
 * below-floor **or unrunnable**" — now holds on every rung.
 *
 * **What made it closeable from `runProbe`'s catch, which it was not before.**
 * That catch used to see a `DpAuthError` code and nothing else, because
 * `dp-api.ts` symbol `printToken` folded a SPAWN failure and a non-zero EXIT
 * into one `ExecFailed` — so demoting on a bare `ExecFailed` would have demoted
 * a perfectly good system dp on a transient non-zero exit, for the rest of the
 * process, which is a worse failure than the one it repairs. `printToken` now
 * throws `DpSpawnFailedError` (still `ExecFailed`, so no reader changed) with
 * the errno, and `errors.ts` symbol `UNRUNNABLE_SPAWN_ERRNOS` keeps the second
 * distinction the first one does not make: a spawn failure that is the MACHINE
 * refusing (`ETXTBSY`, `EAGAIN`, `ENOMEM`) still demotes nothing.
 *
 * **Whose slot it is.** DA1.48's negative cache for a downloaded-but-unrunnable
 * managed copy: there the producer has just written the file and a failed
 * liveness run means exactly one thing, so the reason is earned rather than
 * inferred — and because it never renames that file into place, the demotion is
 * read by the provisioner ({@link dpBinaryDemotion}) rather than by this ladder,
 * which sees no candidate at that path at all. DA1.77's producer is the other
 * shape: there the file IS a ladder candidate, so the demotion is read by the
 * ladder below and the next resolution walks past that rung.
 */
export function demoteDpBinary(
  dpPath: string,
  reason: 'below-floor' | 'unrunnable',
): void {
  demotedDpBinaries.set(dpPath, reason);
}

/**
 * Undo a demotion. The corp channel replaces dp IN PLACE, so the path that was
 * below the floor an hour ago is the path that is above it now — a demotion
 * that could only ever be added would outlive the binary it was about.
 */
export function undemoteDpBinary(dpPath: string): void {
  demotedDpBinaries.delete(dpPath);
}

/**
 * Read a path's demotion, if any.
 *
 * The registry was write-only until DA1.48: the ladder reads it through its own
 * closure and nothing outside needed it. The provisioner does — `'unrunnable'`
 * is its NEGATIVE CACHE, and the one question it asks before fetching anything
 * is whether this process has already written a dead binary at that path
 * (`dp-provision.ts` symbol `ensureManagedDp`). A predicate is what that needs;
 * exporting the map would hand out a mutable registry.
 */
export function dpBinaryDemotion(dpPath: string): 'below-floor' | 'unrunnable' | undefined {
  return demotedDpBinaries.get(dpPath);
}

/** Test seam. */
export function clearDemotedDpBinaries(): void {
  demotedDpBinaries.clear();
}
/**
 * C3.391 (2026-09-12) — the SAME hook, so the same budget.
 *
 * This row was born believing this constant was exempt, and that premise is
 * false. nessy-cli's own comment exempts only the `--version` / `--help` FLAGS
 * from dp's startup hook; our probe runs `dp version`, a SUBCOMMAND, so it pays
 * the hook exactly as `dp auth print-token` does — measured on dp 13.50.0,
 * 2026-09-12: `dp version` costs `dp --version` plus 0.30/0.31/0.31 s across
 * three arms. The whole measurement, including the arm that could NOT be
 * reproduced on this rig, is at `dp-api.ts` `PRINT_TOKEN_TIMEOUT_MS`.
 *
 * It mattered more than a second probe normally would, because
 * `session-broker.ts` `runProbe` used to await this one BEFORE `printToken`,
 * sequentially: with the host unreachable the version probe could spend the
 * whole budget first and the token attempt never started inside one probe
 * window. That ordering is now a `Promise.all`, so raising both budgets costs
 * one window rather than two.
 *
 * Raising an ADVISORY probe is deliberate rather than incidental: a version
 * probe that always times out returns null, `isDpVersionSupported(null)` is
 * true, and the "dp is outdated" warning then never fires for precisely the
 * users whose dp is broken enough to be slow.
 */
const VERSION_TIMEOUT_MS = 30_000;

/** Minimum dp version we warn below (warn-only per 00-context decision 5). */
export const DP_MIN_VERSION = '13.0.0';

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(bin: string, pathEnv: string | undefined): string | null {
  if (!pathEnv) return null;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Which state root this dp must run against — **Target scheme clause 3**.
 *
 * 1. An explicit `DP_WORKDIR` wins: it is dp's OWN variable and a user who set
 *    it means it.
 * 2. Otherwise the answer is `undefined` — dp uses its own default, `~/.dp`,
 *    on EVERY rung, including the managed one: pairing our own binary with an
 *    isolated workdir is precisely nessy-cli's `dp_latest` model, which forces
 *    a second login, and clause 3 exists to avoid it. The plugin registry and
 *    the plugin binaries live in that same tree, so an isolated workdir also
 *    cannot serve `dp ai mcp <plugin>` at all.
 *
 * **F1.363 — the third branch is gone, and why.** When the user had no `~/.dp`
 * this used to create `<CONFIG_DIR>/dp/state` at 0700 and hand it to dp, so a
 * login WE triggered was invisible to the user's terminal dp and to every
 * `dp ai mcp` server — both read dp's own `~/.dp` — and the next `dp` the user
 * ran asked them to sign in again. The row asked for the recorded reason first;
 * none was recorded — not here (the branch's own sentence called dp making its
 * own `~/.dp` "the outcome clause 3 prefers anyway"), not in the DA1.6 row, and
 * not in the 2026-08-22 research, whose reasons (the deny floor, racing
 * updaters, nessy-cli deleting its copy) are about WHERE a state root of ours
 * must not live, never about why dp's default was worse. So dp now makes its
 * own `~/.dp` on the first login, and this module writes nothing.
 *
 * Residue, named rather than hidden: a user who signed in through the old
 * `<CONFIG_DIR>/dp/state` (no `~/.dp` of their own) signs in ONCE more, into
 * `~/.dp`; the old directory is left where it is — this module never deletes a
 * user's session.
 */
function resolveManagedWorkdir(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env.DP_WORKDIR?.trim();
  return configured ? resolvePath(configured) : undefined;
}

/**
 * The dp resolution ladder — DP-1 as amended by Target scheme clauses 3 and 4.
 * First RUNNABLE candidate wins:
 *
 * 1. `NESSY_DP` — an explicit path the user or an operator set.
 * 2. system dp: `PATH`, then `/usr/local/bin/dp`. The corp channel replaces
 *    this binary IN PLACE, and `/usr/local/bin` is root-owned, so `dp update`
 *    is structurally unavailable to a non-root user — measured 2026-08-23, and
 *    that measurement is why a managed copy is contemplated at all.
 * 3. `<CONFIG_DIR>/dp/bin/dp` — the copy this product would own.
 * 4. `<NESSY_HOME>/dp_latest/dp` — nessy-cli's copy, READ-ONLY: never updated,
 *    never deleted. Their own auth-failure path deletes it, so nothing here may
 *    memoize it; every call re-runs the executable-bit check and an ENOENT or
 *    ETXTBSY mid-exec simply re-resolves on the next call.
 * 5. `DpNotFound`.
 *
 * A rung the demotion registry has marked is skipped while another runnable
 * candidate exists (see {@link demoteDpBinary}). A `NESSY_DP` that is not
 * runnable FALLS THROUGH rather than failing loudly: the ladder's rule is
 * "first runnable wins", and `source` on the returned record is what tells a
 * caller which rung actually answered.
 *
 * Never execs, never downloads — and that is still true now that rung 5 of the
 * plan's ladder exists: the provisioner is a separate async module,
 * `dp-provision.ts` symbol `ensureManagedDp`, which writes rung 3's path and
 * changes nothing here. Its pin ships EMPTY (a digest nobody computed is not a
 * pin), so on every machine today it answers before any I/O and this ladder
 * resolves exactly as it did before it existed.
 */
export function resolveDpRuntime(opts: ResolveDpRuntimeOptions = {}): DpRuntimeRecord {
  const env = opts.env ?? process.env;
  const isRunnable = opts.isRunnable ?? isExecutable;
  const configDir = opts.configDir ?? CONFIG_DIR;
  const nessyDir = opts.nessyDir ?? getNessyDir();

  const candidates: Array<{ path: string; source: DpRuntimeSource }> = [];
  const override = env[NESSY_DP_ENV]?.trim();
  if (override) candidates.push({ path: resolvePath(override), source: 'override' });
  const fromPath = findOnPath(DP_BASENAME, opts.pathEnv ?? env.PATH);
  if (fromPath) candidates.push({ path: fromPath, source: 'system' });
  candidates.push({ path: opts.fallbackPath ?? DP_FALLBACK_PATH, source: 'system' });
  candidates.push({ path: managedDpBinaryPath(configDir), source: 'managed' });
  candidates.push({ path: nessyCliDpBinaryPath(nessyDir), source: 'nessy-cli' });

  const runnable = candidates.filter((candidate) => isRunnable(candidate.path));
  const chosen =
    runnable.find((candidate) => !demotedDpBinaries.has(candidate.path)) ?? runnable[0];
  if (!chosen) {
    throw new DpAuthServiceError(DpAuthError.DpNotFound, DP_NOT_FOUND_MESSAGE);
  }

  const workdir = resolveManagedWorkdir(env);
  return workdir === undefined
    ? { dpPath: chosen.path, source: chosen.source }
    : { dpPath: chosen.path, workdir, source: chosen.source };
}

/**
 * The path half of {@link resolveDpRuntime}, for callers that genuinely only
 * want a path. A caller that goes on to SPAWN dp wants the record: pairing a
 * binary with a state root resolved independently is the drift this seam
 * exists to remove.
 *
 * `opts` is a dependency-injection seam for tests; production callers invoke
 * `resolveDpBinary()` with no arguments.
 */
export function resolveDpBinary(opts?: ResolveDpRuntimeOptions): string {
  return resolveDpRuntime(opts).dpPath;
}

/**
 * Parse `dp version` → `X.Y.Z`, or null on any failure (never throws; the
 * version check is advisory only).
 */
export async function getDpVersion(
  dpPath: string,
  opts: DpExecOptions = {},
): Promise<string | null> {
  try {
    const { signal } = combineAbort(opts.signal, opts.timeoutMs ?? VERSION_TIMEOUT_MS);
    const { stdout } = await execFileAsync(dpPath, ['version'], {
      signal,
      env: dpExecEnv(opts.workdir),
    });
    const match = stdout.match(/Spirit CLI Version: (\d+\.\d+\.\d+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Three-part numeric semver-ish compare. Unknown version (null) is treated as
 * supported so a parse failure never raises a false "outdated" warning.
 */
export function isDpVersionSupported(
  version: string | null,
  min: string = DP_MIN_VERSION,
): boolean {
  if (!version) return true;
  const parse = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(version);
  const b = parse(min);
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}
