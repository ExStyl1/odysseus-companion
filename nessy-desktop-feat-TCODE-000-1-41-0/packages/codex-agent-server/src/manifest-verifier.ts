/**
 * Runtime integrity gate: verify the bundled `codex-app-server` binary is the one
 * we shipped BEFORE spawning it — never launch an unverified/tampered binary.
 *
 * Two acceptance paths, OR'd. The first is the normal one; the second exists only
 * so that a packaging change cannot silently kill the runtime a second time:
 *
 *  1. **SHA pin** — the on-disk bytes match the digest pinned in
 *     `@nessy-agent/codex-protocol/manifest.json`, written by
 *     `scripts/fetch-codex.mjs` from the official `codex-package_SHA256SUMS`.
 *     This is the path every build takes, signed or not, because
 *     `apps/electron/electron-builder.yml` no longer re-signs the nested binary
 *     (`mac.signIgnore: ["resources/bin/codex/"]`): it keeps OpenAI's own
 *     Developer ID signature, so the shipped bytes stay byte-identical to the
 *     upstream release we pinned. `scripts/build/codex-integrity.ts` asserts
 *     exactly that on the final artifact, in all five build mirrors.
 *  2. **Signature identity (macOS)** — the binary carries a valid, Apple-anchored
 *     code signature issued to OUR Developer ID team. Signed 1.25.0 shipped a
 *     `codex-app-server` that electron-builder had deep-signed after the fetch;
 *     code signing rewrites the Mach-O, so its SHA could never match the pin and
 *     the runtime refused to spawn it in every signed build and no unsigned one.
 *     If `signIgnore` ever has to be reverted (Apple's notary is the one authority
 *     we cannot test against offline; it would fail loudly at `notarytool` naming
 *     the file), the re-signed binary is still ours by identity and still spawns.
 *     Neither untestable assumption — "notary accepts a vendor-signed nested
 *     binary" and "this Team ID is right" — is a single point of failure.
 *
 * The seatbelt stays real: a tampered/swapped binary matches neither the pin nor a
 * valid Nessy-team signature, so it is still refused. An ad-hoc or self-signed
 * binary has no Apple anchor and is refused too.
 *
 * Arm 2 is DIFFERENT from arm 1, not stronger — do not generalize it into "a
 * signature check beats a hash". A hash names one exact artifact; a Team-ID
 * signature names a whole class ("anything that team signed"), so it is WEAKER on
 * artifact identity and stronger only in that it survives legitimate re-signing.
 * That asymmetry is the entire reason arm 1 is tried first and arm 2 exists solely
 * as the fallback for a packaging change we cannot test against Apple's notary
 * offline.
 *
 * ponytail: ~8-line local sha256 (the `common.ts:verifySha256` helper lives in a
 * build script — do NOT import build scripts into runtime code). The verified
 * decision is cached per (path, platformDir) and invalidated by mtime/size/inode so
 * a binary is hashed/codesign-checked once per process, not per spawn.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import codexManifest from '@nessy-agent/codex-protocol/manifest.json' with { type: 'json' };

export interface CodexManifest {
  upstream?: { tag?: string };
  binaries?: Record<string, { binarySha256?: string; codeModeHostSha256?: string }>;
}

/**
 * The Apple Developer ID team that signs Nessy Desktop. A Developer ID Application
 * certificate carries the 10-char Team ID in its leaf subject OU, so this is what
 * the codesign designated requirement below matches.
 *
 * SOURCE: measured on the PUBLISHED signed 1.25.0 artifact —
 * `Authority=Developer ID Application: LLC MANAGEMENT GROUP (35CMT9F8X3)`.
 * It is deliberately absent from the rest of the repo: signing is brokered by
 * AppHub/match under the alias `ru.tfinance` (`fastlane/match.yml`), so grepping
 * for it finds nothing and this constant looks unsourced. It MUST match the
 * identity CI actually signs with; if the signing identity ever changes, change
 * it here too. Getting it wrong costs nothing today (path 1 carries every build)
 * and would only weaken the fallback.
 */
export const NESSY_DEVELOPER_ID_TEAM = '35CMT9F8X3';

/**
 * A refusal from this file, carrying BOTH halves of it.
 *
 * `message` is the diagnostic — which arm failed, the two digests, codesign's own
 * words — and belongs in a log or an error detail. `userMessage` is what a PERSON
 * is shown, and it exists because the refusal used to reach nobody: measured on
 * the 1.25.1 acceptance gate against a tampered nested binary, a Codex turn left
 * the user's message in the transcript and produced no assistant reply, no error
 * row and no toast, and a packaged build writes no application log
 * (`apps/electron/src/main/logger.ts` disables both transports when not in debug
 * mode), so the diagnostic was invisible too. The verdict is unchanged — this is
 * the consequence, not the decision.
 *
 * `userMessage` deliberately carries no digest and no filesystem path: those are
 * the diagnostic's job, and neither is actionable for the person reading it.
 */
export class CodexIntegrityError extends Error {
  readonly userMessage: string;

  constructor(message: string, userMessage: string) {
    super(message);
    this.name = 'CodexIntegrityError';
    this.userMessage = userMessage;
  }
}

/**
 * Duck-typed on purpose. `instanceof` alone is a single point of failure across a
 * bundler boundary: esbuild inlines this module into `dist/main.cjs`, and a second
 * copy reaching the packaged app would make `instanceof` quietly false — turning
 * the refusal mute again, which is the exact defect this class exists to fix.
 */
export function isCodexIntegrityError(error: unknown): error is CodexIntegrityError {
  if (error instanceof CodexIntegrityError) return true;
  return (
    error instanceof Error &&
    error.name === 'CodexIntegrityError' &&
    typeof (error as Partial<CodexIntegrityError>).userMessage === 'string'
  );
}

/**
 * The remedy sentence, shared by every refusal.
 *
 * A user cannot repair a bundled binary; reinstalling is the whole of what they
 * can do, and it is the honest instruction whether the cause was tampering, a
 * partial download or a packaging mistake of ours.
 */
const REINSTALL_HINT = 'Reinstall Nessy Desktop to restore it.';

/** Refused because the bytes are not the ones we shipped. */
export const CODEX_INTEGRITY_USER_MESSAGE =
  'The bundled Codex runtime failed its integrity check and was not started, ' +
  `so this message was not sent. ${REINSTALL_HINT}`;

/** Refused because the bundled runtime is not there to check at all. */
export function codexMissingRuntimeUserMessage(platformDir: string): string {
  return (
    `The bundled Codex runtime is missing for this platform (${platformDir}), ` +
    `so this message was not sent. ${REINSTALL_HINT}`
  );
}

export function loadCodexManifest(): CodexManifest {
  return codexManifest as CodexManifest;
}

/**
 * Accepted-decision cache. A performance cache, not a security boundary — an
 * attacker who can rewrite the bundled binary can also rewrite `main.cjs` that
 * checks it. Two properties keep it from widening the hole it sits in:
 *
 *  - the key includes `platformDir`, so an accept computed against one platform's
 *    pin can never satisfy another's (the same file can be verified twice, e.g.
 *    by the packaging gate, and each pin is its own question);
 *  - the entry is invalidated by inode+device as well as mtime+size, so replacing
 *    the file at that path (the plausible swap: write elsewhere, rename over)
 *    invalidates it even if the attacker forges the timestamp and pads the size.
 *
 * Only accepts are cached; a refusal is re-evaluated on every spawn.
 */
const digestCache = new Map<string, { mtimeMs: number; size: number; ino: number; dev: number }>();

/** Host platform dir, matching `resources/bin/codex/<dir>`. */
export function hostCodexPlatformDir(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
  return `${process.platform}-${arch}`;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toLowerCase();
}

/**
 * ABSOLUTE path, and it must stay absolute. `execFileSync` takes no shell, but it
 * still resolves a bare name through `PATH` — and `apps/electron/src/main/shell-env.ts`
 * REPLACES `process.env.PATH` with the user's login-shell PATH in packaged builds
 * (`process.env[key] = value` over every var `zsh -l -i` prints). A two-line
 * `#!/bin/sh\nexit 0` shim named `codesign`, first on that PATH, therefore turned
 * this whole arm into an unconditional accept: measured on this tree before the
 * fix, `hasDeveloperIdSignature('/bin/ls')` returned `true`.
 *
 * Hardcoding is safe here, verified on macOS 26: `/usr/bin/codesign` is a
 * 459 KB root:wheel Mach-O carrying the SIP `restricted` flag, and it does NOT
 * link `xcselect` — so it is base-OS, not one of the Command-Line-Tools shims
 * that die with "invalid active developer path" when Xcode is absent.
 * `/usr/bin/git` IS such a shim and links `xcselect`; that contrast is the
 * control. So this cannot create a "no Xcode installed → Codex dead" case.
 */
const CODESIGN = '/usr/bin/codesign';

/**
 * Ceiling for the codesign call. This runs SYNCHRONOUSLY on the spawn path
 * (`codex-agent.ts` → `runtime-manager.ts` → here), and codesign hashes the whole
 * Mach-O: measured 1.76 s on the real 207 MB `codex-app-server`. A hung or
 * pathologically slow codesign must not wedge a session forever, so it is bounded
 * — and a timeout is a REFUSAL with its own reason, never an accept.
 */
const CODESIGN_TIMEOUT_MS = 30_000;

/** Why the signature arm said no. A field failure has to be diagnosable from the refusal alone. */
export type SignatureRefusal =
  | 'not-darwin'
  | 'requirement-unsatisfied'
  | 'codesign-timeout'
  | 'codesign-missing'
  | 'codesign-error';

export type SignatureCheck =
  | { trusted: true }
  | { trusted: false; reason: SignatureRefusal; detail?: string };

/** The designated requirement — the entire security artifact of this arm. */
export function developerIdRequirement(teamId: string): string {
  return `anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`;
}

/**
 * Whether `binaryPath` carries a valid, Apple-anchored code signature issued to
 * `teamId`, and if not, WHY. macOS only — no other platform re-signs the nested
 * binary, and `codesign` exists only there. `anchor apple generic` rejects ad-hoc
 * and self-signed code (no Apple-issued cert chain), so a forged OU cannot pass.
 *
 * The four outcomes are kept apart on purpose. Folded into one `catch → false`,
 * "the binary is not ours", "codesign is missing", and "codesign timed out" are
 * the same event in a log, and only the first of the three is about the binary.
 *
 * `teamId` is a parameter so a test can run the SAME requirement against a team
 * that is supposed to pass — without that positive control, "codesign rejects the
 * wrong team" is indistinguishable from "the requirement string never matches
 * anything", and the fallback arm would be silently dead.
 */
export function checkDeveloperIdSignature(
  binaryPath: string,
  teamId: string = NESSY_DEVELOPER_ID_TEAM,
  timeoutMs: number = CODESIGN_TIMEOUT_MS,
): SignatureCheck {
  if (process.platform !== 'darwin') return { trusted: false, reason: 'not-darwin' };
  try {
    execFileSync(
      CODESIGN,
      ['--verify', '--strict', `-R=${developerIdRequirement(teamId)}`, binaryPath],
      // stderr piped so the refusal can quote codesign's own words; stdout ignored.
      { stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL' },
    );
    return { trusted: true };
  } catch (error) {
    const err = error as { code?: string; status?: number | null; stderr?: Buffer | string };
    // Measured error shapes (node/bun, macOS): timeout → code 'ETIMEDOUT' + SIGKILL;
    // missing binary → code 'ENOENT'; requirement not met → status 3; unsigned → status 1.
    if (err.code === 'ETIMEDOUT') {
      return { trusted: false, reason: 'codesign-timeout', detail: `exceeded ${timeoutMs} ms` };
    }
    if (err.code === 'ENOENT') {
      return { trusted: false, reason: 'codesign-missing', detail: `${CODESIGN} is not executable` };
    }
    // Only the binary's own path can appear in `detail` — codesign echoes the path
    // it was given and nothing else, so no other filesystem layout leaks into a log.
    const detail = String(err.stderr ?? '').trim().split('\n')[0] || undefined;
    if (typeof err.status === 'number') {
      return { trusted: false, reason: 'requirement-unsatisfied', detail };
    }
    return { trusted: false, reason: 'codesign-error', detail: detail ?? err.code };
  }
}

/** Boolean form, for callers that only need the verdict. */
export function hasDeveloperIdSignature(binaryPath: string, teamId: string = NESSY_DEVELOPER_ID_TEAM): boolean {
  return checkDeveloperIdSignature(binaryPath, teamId).trusted;
}

/**
 * Injection seams for TESTS only. Production omits them, and so does the
 * packaging gate (`scripts/build/codex-integrity.ts`) — the whole point of that
 * gate calling this function is that it exercises the real defaults.
 */
export interface CodexVerifyDeps {
  /** Override the pinned manifest (tests). Defaults to the bundled one. */
  manifest?: CodexManifest;
  /** Override the signature check (tests). Defaults to the real codesign check. */
  checkSignature?: (binaryPath: string) => SignatureCheck;
}

/**
 * Throw unless `binaryPath` is the codex binary we shipped for `platformDir`: its bytes match the manifest
 * SHA pin, OR (macOS) it is validly signed by the Nessy Developer ID team — and so is its code-mode host
 * beside it, when present ({@link verifyCodexCodeModeHost}, F1.1216). Synchronous, as the spawn path is.
 */
export function verifyCodexBinary(
  binaryPath: string,
  platformDir: string = hostCodexPlatformDir(),
  deps: CodexVerifyDeps = {},
): void {
  const manifest = deps.manifest ?? loadCodexManifest();
  verifyCodexCodeModeHost(binaryPath, platformDir, { ...deps, manifest });
  const expected = manifest.binaries?.[platformDir]?.binarySha256?.toLowerCase();
  if (!expected) {
    throw new CodexIntegrityError(
      `codex manifest has no binary entry for platform "${platformDir}" — refusing to spawn`,
      codexMissingRuntimeUserMessage(platformDir),
    );
  }

  // A binary that is not on disk is the same event to the user as one that fails
  // the pin — the runtime does not start and reinstalling is the remedy — and
  // left bare it is the same mute turn, so it is wrapped rather than left to
  // escape as a raw ENOENT. The refusal is unchanged; only its shape is.
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(binaryPath);
  } catch (error) {
    throw new CodexIntegrityError(
      `codex-app-server is not readable at the bundled path for ${platformDir} — refusing to spawn: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      codexMissingRuntimeUserMessage(platformDir),
    );
  }
  const cacheKey = `${platformDir}\u0000${binaryPath}`;
  const cached = digestCache.get(cacheKey);
  if (
    cached &&
    cached.mtimeMs === st.mtimeMs &&
    cached.size === st.size &&
    cached.ino === st.ino &&
    cached.dev === st.dev
  ) {
    return;
  }
  const accept = (): void => {
    digestCache.set(cacheKey, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, dev: st.dev });
  };

  // Arm 1 — the pin. Every correct build lands here, signed or not.
  const sha = sha256File(binaryPath);
  if (sha === expected) {
    accept();
    return;
  }

  // Arm 2 — identity. Only reachable if something re-signed or replaced the binary
  // after `scripts/fetch-codex.mjs` verified it.
  const check = deps.checkSignature ?? ((path: string) => checkDeveloperIdSignature(path));
  const signature = check(binaryPath);
  if (signature.trusted) {
    accept();
    return;
  }

  // Name the arm that failed. The original defect was diagnosable only by reading
  // this file; a future one should be diagnosable from the message alone. That is
  // the DIAGNOSTIC half — `userMessage` is the half a person is shown.
  throw new CodexIntegrityError(
    `codex-app-server refused for ${platformDir} — both integrity arms failed:\n` +
      `  [1] SHA pin: on-disk ${sha} ≠ manifest ${expected}. In a packaged build this means the\n` +
      `      bundled binary was rewritten after the fetch — code signing rewrites the Mach-O/PE\n` +
      `      and the pin records the unsigned upstream hash. electron-builder is configured NOT\n` +
      `      to re-sign it (mac.signIgnore: resources/bin/codex/), and\n` +
      `      scripts/build/codex-integrity.ts asserts that on the final artifact.\n` +
      `  [2] Signature identity: not validly signed by the Nessy Developer ID` +
      (process.platform === 'darwin'
        ? ` (Team ${NESSY_DEVELOPER_ID_TEAM}); an ad-hoc, self-signed or third-party signature\n      cannot satisfy it.`
        : ` — this arm is macOS-only and never runs on ${process.platform}.`) +
      // WHY arm 2 said no. "not ours", "codesign is missing" and "codesign timed
      // out" are three different incidents; without this they read identically.
      `\n      reason: ${signature.reason}${signature.detail ? ` (${signature.detail})` : ''}` +
      `\nRefusing to spawn a tampered/unverified binary.`,
    CODEX_INTEGRITY_USER_MESSAGE,
  );
}

/**
 * F1.1216 — where codex looks for its own code-mode host, and so where we ship it.
 *
 * Read in the openai/codex source at the pinned tag (`rust-v0.159.3`,
 * `codex-rs/install-context/src/lib.rs` `code_mode_host_program`): a package
 * `codex-resources/` dir first, then a package `bin/` dir — both only when a
 * `codex-package.json` sits in the package root, which our flat
 * `bin/codex/<platform>/` layout has not — and otherwise the canonicalised
 * `current_exe().parent()` joined with `codex-code-mode-host[.exe]`. No env var
 * or config key moves it, so the app-server finds this sibling by itself and the
 * spawn passes nothing.
 */
export function codexCodeModeHostPath(appServerPath: string, platformDir: string): string {
  const name = platformDir.startsWith('win32') ? 'codex-code-mode-host.exe' : 'codex-code-mode-host';
  // The sibling of the app-server file, by string: a path import here would move every line below it.
  return appServerPath.replace(/[^/\\]+$/, name);
}

/**
 * F1.1216 — verify the code-mode host that ships beside `codex-app-server`
 * BEFORE the app-server is spawned, because the app-server spawns it with no
 * gate of ours in between: every `code_mode_only` model (gpt-5.6, gpt-6, gpt-6.1,
 * `codex-auto-review`) runs its tools through it.
 *
 * Same two arms as the app-server (pin `binaries[<dir>].codeModeHostSha256`,
 * else the macOS Nessy Developer ID), same refusal, same accept cache.
 *
 * An ABSENT host is not refused, and that is a stated choice: the app-server
 * runs without it — Direct-tool models keep working — and codex names the gap
 * itself ("Code Mode is unavailable because …; Code mode will fail closed;
 * enable `features.code_mode_host` and install `codex-code-mode-host`").
 * Refusing would turn a missing feature into a dead runtime. The packaging gate
 * (`scripts/build/codex-integrity.ts`) is what makes a shipped build carry it.
 * A host that IS present but unpinned or mismatched is refused: it is code codex
 * would execute.
 */
export function verifyCodexCodeModeHost(
  appServerPath: string,
  platformDir: string = hostCodexPlatformDir(),
  deps: CodexVerifyDeps = {},
): 'verified' | 'absent' {
  const hostPath = codexCodeModeHostPath(appServerPath, platformDir);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(hostPath);
  } catch {
    return 'absent';
  }
  const manifest = deps.manifest ?? loadCodexManifest();
  const expected = manifest.binaries?.[platformDir]?.codeModeHostSha256?.toLowerCase();
  const cacheKey = `${platformDir}\u0000${hostPath}`;
  const cached = digestCache.get(cacheKey);
  if (
    expected &&
    cached &&
    cached.mtimeMs === st.mtimeMs &&
    cached.size === st.size &&
    cached.ino === st.ino &&
    cached.dev === st.dev
  ) {
    return 'verified';
  }
  const sha = sha256File(hostPath);
  const signature = expected && sha === expected
    ? ({ trusted: true } as const)
    : (deps.checkSignature ?? ((path: string) => checkDeveloperIdSignature(path)))(hostPath);
  if (signature.trusted) {
    digestCache.set(cacheKey, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, dev: st.dev });
    return 'verified';
  }
  throw new CodexIntegrityError(
    `codex-code-mode-host refused for ${platformDir} — both integrity arms failed:\n` +
      `  [1] SHA pin: on-disk ${sha} ≠ manifest ${expected ?? '(no codeModeHostSha256 pin)'}.\n` +
      `  [2] Signature identity: not validly signed by the Nessy Developer ID` +
      `\n      reason: ${signature.reason}${signature.detail ? ` (${signature.detail})` : ''}` +
      `\nRefusing to spawn codex-app-server beside a tampered/unverified code-mode host.`,
    CODEX_INTEGRITY_USER_MESSAGE,
  );
}
