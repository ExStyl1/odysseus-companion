import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  machLookupRule,
  NETWORK_SANDBOX_MACH_SERVICES,
  SANDBOX_MACH_SERVICES,
} from '@nessy-agent/session-tools-core';

export interface BashSeatbeltSandboxContext {
  enabled: boolean;
  cwd: string;
  writablePaths?: readonly string[];
  platform?: NodeJS.Platform;
  sandboxExecAvailable?: boolean;
}

export interface BashSeatbeltSandboxResult {
  modified: boolean;
  input: Record<string, unknown>;
  reason?: string;
}

let sandboxExecAvailableCache: boolean | null = null;

export function resetMacosSeatbeltAvailabilityCache(): void {
  sandboxExecAvailableCache = null;
}

export function isMacosSeatbeltAvailable(): boolean {
  if (sandboxExecAvailableCache !== null) return sandboxExecAvailableCache;

  const probe = spawnSync('sandbox-exec', [
    '-p',
    '(version 1) (allow default)',
    '/usr/bin/true',
  ], { stdio: 'ignore' });

  sandboxExecAvailableCache = probe.status === 0;
  return sandboxExecAvailableCache;
}

function escapeSeatbeltPath(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function canonicalizeSeatbeltPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * TEMPORARY (owner decision 2026-07-21): while the app is in the testing
 * period, the seatbelt profile is a wildcard — the sandbox-exec wrapper stays
 * in place but permits everything, so an unexpectedly-enabled sandbox flag
 * cannot break testers (dig/nslookup/git/keychain etc.). Flip back to `false`
 * before GA to restore real write containment.
 *
 * REAFFIRMED 2026-07-29: the parity audit surfaced this constant and put the
 * flip to the owner, who kept it on because GA is not near. So this is a live
 * decision rather than a forgotten flag — and the note stays here, at the
 * constant, because that is where the next person to wonder about it will look.
 *
 * ## What it costs while on — RE-MEASURED 2026-09-04 (P3.330), and the previous
 * ## paragraph here was HALF WRONG in the direction that mattered
 *
 * It used to say: "writes are still contained (a write to `~` returns
 * `Operation not permitted`) and the credential floor still holds (`~/.ssh` is
 * blocked) — those come from other machinery." Driven on a real darwin rig
 * (macOS 26.6.2, `sandbox-exec` present, load average 12.9-13.8), running each
 * command through `wrapBashCommandWithMacosSeatbelt` under BOTH branches, with
 * `printf ok` as the dead control (0 in both arms, so the rig discriminates):
 *
 * | probe                          | wildcard        | strict (the flip)        |
 * | ------------------------------ | --------------- | ------------------------ |
 * | `printf ok` (dead control)     | 0               | 0                        |
 * | write inside cwd               | 0               | 0                        |
 * | write outside cwd (`/tmp` sib) | **0, created**  | 1, `Operation not permitted` |
 * | write to `~`                   | **0, created**  | 1, `Operation not permitted` |
 * | write to `~/.ssh`              | **0, created**  | 1, `Operation not permitted` |
 * | read `~/.ssh` listing + bytes  | 0               | 0 (strict allows `file-read*`) |
 * | `pbpaste`                      | 0               | 1 (the mach narrowing)   |
 * | `dscacheutil`, `dig`, git/TLS  | 0               | 0                        |
 * | keychain lookup (`security`)   | 0 (item absent) | 0 (item absent)          |
 *
 * So the `Operation not permitted` the old note attributed to "other machinery"
 * is produced BY THE STRICT BRANCH — the very branch the wildcard replaces.
 * **No write containment survives the wildcard at this layer.**
 *
 * The `~/.ssh` half of the old claim DOES reproduce, and it is worth keeping
 * straight because the two halves have different owners. Driven through
 * `shouldAllowToolInMode('Bash', …)` at HEAD with the shipped `deniedPaths`:
 * a Bash write to `~/.ssh/…` and a `cat` of `~/.ssh/id_rsa` are refused in
 * `default`, `acceptEdits` AND `bypassPermissions` (the denied-path floor is the
 * first check, ahead of the bypass blanket-allow), in both the `~` and the
 * expanded spelling. A write to `~` itself is ALLOWED there — nothing in
 * `deniedPaths` names a bare home directory. Hence: the credential floor is real
 * and is not this file's; general write containment is this file's alone, and
 * while the wildcard is on there is none.
 *
 * That includes the mach narrowing below. {@link buildMacosBashSeatbeltProfile}
 * returns `(allow default)` while this constant is `true`, so the filtered
 * `mach-lookup` rule only starts denying the pasteboard at the pre-GA flip
 * (measured above: `pbpaste` 0 wildcard, 1 strict). The same narrowing in
 * `session-tools-core/src/runtime/filesystem-isolation.ts` is NOT gated by this
 * constant: `buildDarwinSandboxProfile` has no wildcard branch, and it is the
 * profile the supervised-process isolation and the `script_sandbox` handler
 * actually compose, so there the narrowing binds now.
 *
 * ## Reachability, and why the success path now says so out loud
 *
 * This is not dead code behind a default-off flag.
 * `getMacosSeatbeltBashSandboxEnabled` (`config/storage.ts`) passes a MANAGED
 * FLOOR to {@link resolveSandboxEnabled}, and a floor wins outright — so an org
 * policy that sets `sandbox.enabled` plus the legacy
 * `macosSeatbeltBashSandboxEnabled` key reaches this wrapper in a shipped
 * build. Until P3.330 the success path emitted NOTHING (only the two failure
 * paths called `onDebug`), so an operator who turned containment on saw a
 * `sandbox-exec` prefix on every command and no way to learn it contained
 * nothing. {@link wrapBashCommandWithMacosSeatbelt} now warns once per process.
 *
 * The strict branch is exported separately as
 * {@link buildStrictMacosBashSeatbeltProfile} so the containment tests can
 * drive it TODAY, on this side of the flip, instead of early-returning until
 * someone changes the constant.
 *
 * ## The decision is the OWNER's, and these are the two options with their costs
 *
 * P3.330 does not decide it. It measured it, made the silent half loud, and
 * leaves the flip where the 2026-07-21 and 2026-07-29 rulings put it. There are
 * two options, not three: leaving it on and saying nothing is no longer one of
 * them, because the notice now exists either way.
 *
 * **(A) Keep `true`.** Cost: the opt-in contains nothing. A user or an
 * administrator who turns `macosSeatbeltBashSandboxEnabled` on gets a
 * `sandbox-exec` prefix and no containment — writes outside cwd, into `~`, and
 * into `~/.ssh` all succeed at this layer (the `~/.ssh` ones are still refused
 * upstream by `deniedPaths`, so the credential floor is not the cost here;
 * arbitrary home writes are, and nothing else stops them). This is NOT a
 * regression against a default install, where the wrapper is off and the
 * command is equally uncontained — the cost is precisely that a control which
 * was deliberately switched on does not control. Benefit: no tester breakage,
 * which is what the two rulings bought.
 *
 * **(B) Flip to `false`.** Cost, measured rather than feared, on the table
 * above: `pbpaste` stops working inside approved Bash commands (the mach
 * narrowing), and any write outside cwd and the configured session write paths
 * starts returning `Operation not permitted`. `dig`, `dscacheutil`, git over
 * TLS and a keychain lookup are UNAFFECTED — the four failures the 2026-07-21
 * note worried about do not reproduce, because `(allow network*)`,
 * `(allow system-socket)` and the filtered `mach-lookup` list were added for
 * exactly them. Benefit: the opt-in means what its name says.
 *
 * Two facts the decision needs that are easy to miss. First, the flip is
 * reachable in a shipped build via a managed floor plus the legacy key, so it
 * is not "testing only" (see above). Second, this constant governs ONE of the
 * three darwin containment surfaces: `session-tools-core`'s
 * `buildDarwinSandboxProfile` has no wildcard and binds today, and codex's own
 * sandbox emits `(deny default)`. Whichever way this goes, the three runtimes
 * are not saying the same thing about approved Bash, and that residue is the
 * host's to make uniform or honest.
 */
export const SEATBELT_TESTING_WILDCARD: boolean = true;

/** The wildcard profile, named once so tests and diagnostics cannot spell it differently. */
export const MACOS_SEATBELT_WILDCARD_PROFILE = '(version 1) (allow default)';

/**
 * The REAL profile — what the flip restores.
 *
 * Exported on its own (P3.330) because it was previously reachable only by
 * editing {@link SEATBELT_TESTING_WILDCARD}: every containment test early-returned,
 * so the branch that carries the whole security value of this module had never
 * been exercised by the suite, and the flip would have been a change with no
 * green evidence behind it. It is now exercised on every run.
 */
export function buildStrictMacosBashSeatbeltProfile(cwd: string, writablePaths: readonly string[] = []): string {
  const allowedWritePaths = Array.from(new Set([cwd, ...writablePaths]
    .filter(path => path.trim().length > 0)
    .map(path => canonicalizeSeatbeltPath(path))));

  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    // This profile contains WRITES; network policy stays with the permission
    // layer. Without these, every DNS/socket call dies with
    // "bind: Operation not permitted" (dig/nslookup/curl) even in allow-all.
    '(allow network*)',
    '(allow system-socket)',
    // TLS and name resolution reach trustd and configd over mach IPC, and
    // libSystem reaches opendirectoryd for the current user. All three used to
    // ride a bare `(allow mach-lookup)`, which has no filter and therefore also
    // handed the command `com.apple.pasteboard.1` — see `mach-services.ts` for
    // the probe and for what each name below buys. This profile is
    // network-capable, so it takes both lists.
    machLookupRule([...SANDBOX_MACH_SERVICES, ...NETWORK_SANDBOX_MACH_SERVICES]),
    '(allow ipc-posix-shm-read*)',
    '(allow file-read*)',
    '(allow file-write* (literal "/dev/null"))',
    // Shell/tool ioctls on the tty and /dev/null (stty in /etc/profile, etc.).
    '(allow file-ioctl (literal "/dev/null"))',
    ...allowedWritePaths.map(path => `(allow file-write* (subpath "${escapeSeatbeltPath(path)}"))`),
  ].join(' ');
}

/**
 * The profile actually applied: the wildcard while
 * {@link SEATBELT_TESTING_WILDCARD} is on, otherwise
 * {@link buildStrictMacosBashSeatbeltProfile}.
 */
export function buildMacosBashSeatbeltProfile(cwd: string, writablePaths: readonly string[] = []): string {
  if (SEATBELT_TESTING_WILDCARD) return MACOS_SEATBELT_WILDCARD_PROFILE;
  return buildStrictMacosBashSeatbeltProfile(cwd, writablePaths);
}

let wildcardNoticeEmitted = false;

/** Test seam: re-arm the once-per-process wildcard notice. */
export function resetMacosSeatbeltWildcardNotice(): void {
  wildcardNoticeEmitted = false;
}

/**
 * SAY WHAT THIS IS, once per process (P3.330).
 *
 * The success path used to be the only silent one in this module: both failure
 * paths call `onDebug`, while a wrap that succeeded said nothing at all — so a
 * `sandbox-exec` prefix appeared on every approved Bash command and nothing
 * anywhere told the operator that the profile inside it permits everything.
 * A containment control that does not contain, and does not say so, is
 * indistinguishable from one that works.
 *
 * `console.warn` rather than `debug()`, for the reason
 * `powershell-validator.ts` gives at the same kind of seam: `debug()` is off
 * unless `NESSY_DEBUG=1`, and the audience for this line is an operator who
 * deliberately turned containment ON. It is visible on `nessy-server` and
 * `apps/cli`; in a packaged Electron build it reaches the main-process log only
 * in debug mode, which is a known and stated limit rather than a second silence
 * — the wrapper is only reachable when someone enabled it.
 *
 * Latched: this is a build-time constant, so the condition cannot come and go
 * within a process and repetition would only be noise.
 */
function noticeWildcardOnce(onDebug?: (message: string) => void): void {
  const message =
    'Bash seatbelt sandbox is ENABLED but SEATBELT_TESTING_WILDCARD is on: the '
    + `applied profile is ${MACOS_SEATBELT_WILDCARD_PROFILE}, which denies NOTHING. `
    + 'Commands are wrapped in sandbox-exec but writes outside the working directory, '
    + 'including into the home directory, are NOT contained (measured 2026-09-04). '
    + 'The ~/.ssh credential floor is unaffected — it comes from deniedPaths, not from here.';
  onDebug?.(message);
  if (wildcardNoticeEmitted) return;
  wildcardNoticeEmitted = true;
  console.warn(`[BashSeatbelt] ${message}`);
}

/**
 * Compose `sandbox-exec` around a command under an EXPLICIT profile.
 *
 * The quoting lives here once (P3.330) so a caller that needs the strict
 * profile on this side of the flip — the containment tests, and the cost table
 * in the docblock above — drives the same composition production drives,
 * rather than re-spelling `sandbox-exec -p '…'` and measuring its own copy.
 */
export function wrapBashCommandWithSeatbeltProfile(command: string, profile: string): string {
  return [
    'sandbox-exec',
    '-p',
    quoteShellArg(profile),
    '/bin/bash',
    '-lc',
    quoteShellArg(command),
  ].join(' ');
}

export function wrapBashCommandWithMacosSeatbelt(
  command: string,
  cwd: string,
  writablePaths: readonly string[] = [],
  onDebug?: (message: string) => void,
): string {
  const profile = buildMacosBashSeatbeltProfile(cwd, writablePaths);
  if (SEATBELT_TESTING_WILDCARD) noticeWildcardOnce(onDebug);
  return wrapBashCommandWithSeatbeltProfile(command, profile);
}

export function applyBashSeatbeltSandbox(
  toolName: string,
  input: Record<string, unknown>,
  context: BashSeatbeltSandboxContext | undefined,
  onDebug?: (message: string) => void,
): BashSeatbeltSandboxResult {
  if (!context?.enabled || toolName !== 'Bash') {
    return { modified: false, input };
  }

  const command = input.command;
  if (typeof command !== 'string' || command.trim().length === 0) {
    return { modified: false, input };
  }

  if (command.trimStart().startsWith('sandbox-exec ')) {
    return { modified: false, input };
  }

  const platform = context.platform ?? process.platform;
  if (platform !== 'darwin') {
    onDebug?.(`Bash seatbelt sandbox unavailable on ${platform}; leaving command unchanged.`);
    return { modified: false, input, reason: 'unsupported_platform' };
  }

  const available = context.sandboxExecAvailable ?? isMacosSeatbeltAvailable();
  if (!available) {
    onDebug?.('Bash seatbelt sandbox requested but sandbox-exec is unavailable; leaving command unchanged.');
    return { modified: false, input, reason: 'sandbox_exec_unavailable' };
  }

  return {
    modified: true,
    input: {
      ...input,
      command: wrapBashCommandWithMacosSeatbelt(command, context.cwd, context.writablePaths, onDebug),
    },
  };
}
