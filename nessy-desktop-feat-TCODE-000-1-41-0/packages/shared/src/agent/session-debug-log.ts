/**
 * C3.215 — ONE per-session diagnostic file, in one host-owned place, for the
 * runtimes that can write one.
 *
 * M17 asks for *"a readable plaintext log when a runtime or an MCP server fails
 * — per session, filterable by domain (`claude --debug=mcp`), in a directory you
 * choose and an administrator can pin"*. claude is NATIVE here and this module
 * is configuration rather than a logger: the vendored binary already writes such
 * a file, decides its own level, and rotates it. What it did not have was a path
 * this product owns and can point a user at.
 *
 * ## What the runtime does, read from the page AND from the binary
 *
 * `env-vars.md`, verbatim on the path variable: *"Override the debug log file
 * path. Despite the name, this is a file path, not a directory. Requires debug
 * mode to be enabled separately via `--debug`, `/debug`, or the `DEBUG`
 * environment variable: setting this variable alone does not enable logging. The
 * `--debug-file` flag does both at once. Defaults to
 * `~/.claude/debug/<session-id>.txt`"* — and on the level: *"Minimum log level
 * written to the debug log file. Values: `verbose`, `debug` (default), `info`,
 * `warn`, `error`"*.
 *
 * The binary agrees and adds the branch the page does not spell (read out of the
 * vendored `claude`, `claudeCodeVersion 2.1.247`):
 * `logPath(){return this.filePath ?? … ?? this.deps.env.CLAUDE_CODE_DEBUG_LOGS_DIR
 * ?? this.defaultLogPath()}` with
 * `defaultLogPath(e=this.deps.sessionId()){return _(this.deps.configHomeDir(),"debug",`${e}.txt`)}`,
 * and the enable chain
 * `debugFromLaunch = pe(env.DEBUG) || pe(env.DEBUG_SDK) || argv.includes("--debug")
 * || argv.includes("-d") || this.toStderr || <--debug=filter> !== undefined || this.filePath !== null`.
 * `minLevel` comes from `CLAUDE_CODE_DEBUG_LOG_LEVEL`, lower-cased and trimmed,
 * defaulting to `"debug"`.
 *
 * ## The two decisions this module makes, and why
 *
 * **1. `DEBUG_SDK`, never `DEBUG`.** Both enable, and the page names only
 * `DEBUG`. It is refused anyway: `buildClaudeSubprocessEnv` builds the
 * environment the child's own `Bash` tool hands to every process the model
 * launches, and `DEBUG=1` is read by a large part of the npm ecosystem — turning
 * on our diagnostic would turn on verbose output in unrelated tools the agent
 * runs. `DEBUG_SDK` is read by this binary and by nothing else we spawn. It is
 * undocumented, which is the *membership* half of AGENTS.md's rule rather than
 * the *behaviour* half: the bundle is the denominator for what the runtime can
 * already do, and the chain above is the measurement.
 *
 * **2. The file is written only while the HOST is in debug mode.** A debug log
 * is a product posture, not a free win: it is plaintext, it is per session, and
 * a runtime's verbose log can carry prompt text. `NESSY_DEBUG` is the switch the
 * user already turns on to produce a report, so the diagnostic follows it rather
 * than existing always. An operator who sets the vendor's own variables directly
 * keeps them — this never overwrites a path they chose.
 *
 * ## What is deliberately NOT done
 *
 * The domain FILTER (`--debug=mcp`) is an argv flag with no environment twin;
 * passing it would mean an `extraArgs` entry at the spawn site, and a filter
 * narrows a log the user only ever asked for whole. The level stays the
 * operator's `CLAUDE_CODE_DEBUG_LOG_LEVEL` — the binary's own default is
 * `debug`, and re-deriving it here would be a second implementation of a rule
 * this fork does not own.
 *
 * Pi takes {@link sessionRuntimeDebugLogPath} with its own runtime name, so the
 * two land in one directory with one naming rule; codex has no such file and
 * that difference is a switch verdict rather than a silence.
 *
 * That sentence was a PROMISE and not a description until C3.274 (2026-09-12):
 * the path function accepted `'pi'` and no caller anywhere passed it. It is now
 * kept by {@link openSessionRuntimeDebugLog}, whose docblock carries the
 * native-first reading behind the shape — Pi publishes no diagnostic file of its
 * own, so the host writes one from the stderr pipe it already holds, under the
 * same debug-mode-only posture as the claude arm.
 */
import { appendFileSync, createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DIR } from '../config/paths.ts';

/** The runtimes that can write a per-session plaintext diagnostic today. */
export type SessionDebugLogRuntime = 'claude' | 'pi';

/**
 * `<config dir>/logs/` is where this product's own always-on diagnostics already
 * live (`boot.log`, `auto-update.log`), so a runtime's per-session file joins
 * them rather than starting a second place to look.
 */
export function sessionRuntimeDebugLogDir(): string {
  return join(CONFIG_DIR, 'logs', 'runtime');
}

/**
 * The file one session on one runtime writes. A PATH only — {@link
 * ensureSessionRuntimeDebugLog} is the half that creates the directory, for the
 * reason `ensureSessionJobDir` gives: naming a path nothing can write to turns a
 * promise into a confusing failure.
 */
export function sessionRuntimeDebugLogPath(
  runtime: SessionDebugLogRuntime,
  sessionId: string,
): string {
  return join(sessionRuntimeDebugLogDir(), `${sessionId}-${runtime}.txt`);
}

/**
 * Create the directory, then return the file to name. `undefined` means "no
 * session identity, or a directory we could not create" — a log we cannot write
 * is one we must not point the runtime at, because the vendor's own fallback
 * (`<config home>/debug/<session id>.txt`) is a better outcome than a path that
 * fails on first write.
 */
export function ensureSessionRuntimeDebugLog(
  runtime: SessionDebugLogRuntime,
  sessionId: string | undefined,
): string | undefined {
  if (!sessionId) return undefined;
  try {
    mkdirSync(sessionRuntimeDebugLogDir(), { recursive: true });
  } catch {
    return undefined;
  }
  return sessionRuntimeDebugLogPath(runtime, sessionId);
}

/**
 * An open per-session diagnostic file, for a runtime whose diagnostics the HOST
 * has to carry because the runtime writes none of its own.
 *
 * `close()` is idempotent and `write()` after it is a no-op, because the two are
 * driven by different child-process events (`exit` and `error`) that can both
 * fire, and a sink that throws on the second one would turn a diagnostic into a
 * fault.
 */
export interface SessionRuntimeDebugLogSink {
  /** The file being written — the one thing a user has to be told. */
  readonly path: string;
  write(chunk: string): void;
  close(): void;
}

/**
 * C3.274 — the PI arm of this module, and the reason it is a sink here rather
 * than two environment variables like the claude arm.
 *
 * **Native-first, tier 1, and it comes back empty.** Pi publishes no per-session
 * diagnostic file and no path variable to point at one. Measured 2026-09-12 over
 * the vendored `@earendil-works/pi-coding-agent` 0.84.3 (`grep -rao <name>
 * dist | wc -l`, occurrences): `PI_LOG_FILE` 0, `PI_LOG_DIR` 0, `DEBUG_FILE` 0,
 * `logFile` 0. The two non-zero hits are both the TUI's and neither is a runtime
 * log: `PI_DEBUG_REDRAW` (1) gates a terminal-REDRAW trace, and `debugLogPath`
 * (16) is `interactive-mode`'s dump of the rendered screen buffer. This host
 * spawns `pi-agent-server`, not the interactive mode, so neither is reachable
 * from a Nessy session at all.
 *
 * **Tier 2, the host as the seam.** What Pi does have is a stderr pipe the host
 * already owns end to end — `PiAgent` reads every chunk of it into a ring buffer
 * and into the host debug log. So the file is written HERE, from bytes the host
 * already holds, rather than by teaching the subprocess to log: no new protocol
 * message, no new child code, and a Pi session's diagnostic lands in the same
 * directory under the same naming rule as a claude session's
 * ({@link sessionRuntimeDebugLogPath}), which is the whole point of M17's
 * *"per session, in a directory you choose"*.
 *
 * **The posture is the claude arm's, deliberately unchanged:** the file exists
 * only while the HOST is in debug mode. A plaintext per-session runtime log can
 * carry prompt text, so it follows the switch the user already turns on to
 * produce a report rather than existing always — see this module's header for
 * the whole of that decision.
 *
 * **Failure is silence, in both directions.** A directory that cannot be made,
 * a stream that cannot be opened, and a write that fails later all leave the
 * session untouched: the `error` listener is what makes the last one true, since
 * an unhandled stream `error` would take the process down over a diagnostic
 * nobody asked to be load-bearing.
 */
export function openSessionRuntimeDebugLog(
  runtime: SessionDebugLogRuntime,
  sessionId: string | undefined,
  hostDebug: boolean,
): SessionRuntimeDebugLogSink | undefined {
  if (!hostDebug) return undefined;
  const path = ensureSessionRuntimeDebugLog(runtime, sessionId);
  if (!path) return undefined;
  let stream: WriteStream | undefined;
  try {
    stream = createWriteStream(path, { flags: 'a' });
  } catch {
    return undefined;
  }
  // A diagnostic that cannot be written must not become the session's problem.
  stream.on('error', () => { stream = undefined; });
  return {
    path,
    write(chunk: string): void {
      if (!chunk) return;
      try {
        stream?.write(chunk);
      } catch {
        stream = undefined;
      }
    },
    close(): void {
      const open = stream;
      stream = undefined;
      try {
        open?.end();
      } catch {
        // Already destroyed by its own error handler; nothing to release.
      }
    },
  };
}

/**
 * The separator one subprocess run writes when it opens the session's file.
 *
 * Pi RESPAWNS its subprocess within one session — a crash, a model switch, a
 * connection change — and every run appends to the same per-session file. Without
 * a boundary the second run's first line reads as a continuation of the first
 * run's last one, which is exactly the confusion a diagnostic exists to remove.
 * The time is the one thing a reader needs that the bytes themselves never carry.
 */
export function sessionRuntimeDebugLogHeader(
  runtime: SessionDebugLogRuntime,
  sessionId: string,
  at: Date = new Date(),
): string {
  return `\n=== ${runtime} subprocess stderr · session ${sessionId} · ${at.toISOString()} ===\n`;
}

/** The vendor's own enable switch this fork writes — see the module header for why not `DEBUG`. */
export const CLAUDE_DEBUG_ENABLE_ENV = 'DEBUG_SDK';

/** The vendor's own path override. Despite its name it takes a FILE path (`env-vars.md`). */
export const CLAUDE_DEBUG_LOG_PATH_ENV = 'CLAUDE_CODE_DEBUG_LOGS_DIR';

/** The vendor's own level, left to the operator; the binary defaults it to `debug`. */
export const CLAUDE_DEBUG_LOG_LEVEL_ENV = 'CLAUDE_CODE_DEBUG_LOG_LEVEL';

/**
 * Where the claude child writes when nobody overrides it — the binary's
 * `defaultLogPath()` mirrored, so a READER can find the file in the case this
 * fork makes common and the vendor's docs do not describe: a per-workspace
 * `CLAUDE_CONFIG_DIR`.
 *
 * `buildClaudeSubprocessEnv` sets that variable so two Workspaces cannot share
 * one claude configuration directory, and `configHomeDir()` inside the binary
 * follows it. A reader that hard-codes `~/.claude/debug/<id>.txt` therefore
 * looks in the wrong directory for every workspace that has one, and finds
 * nothing rather than failing. That is what the one caller of
 * {@link claudeSessionDebugLogCandidates} did until C3.273 (2026-09-11) — a link
 * rather than a claim about another module's behaviour, so it can only fail to
 * resolve and never quietly become false.
 */
export function claudeDefaultDebugLogPath(
  env: NodeJS.ProcessEnv,
  sessionId: string,
): string {
  const configHome = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
  return join(configHome, 'debug', `${sessionId}.txt`);
}

/**
 * The file to READ for one claude session: the host-owned path when this fork
 * pointed the child at one, and the vendor's own default otherwise. One
 * function, so the writer and the reader cannot disagree about which file exists.
 */
export function claudeSessionDebugLogPath(
  env: NodeJS.ProcessEnv,
  sessionId: string,
): string {
  const configured = env[CLAUDE_DEBUG_LOG_PATH_ENV]?.trim();
  return configured || claudeDefaultDebugLogPath(env, sessionId);
}

/**
 * C3.273 — every file ONE claude session's diagnostic can be at, in the order a
 * reader should try them, because the writer's two halves are keyed by DIFFERENT
 * ids and a single path cannot name both.
 *
 * {@link claudeSessionDebugLogPath} answers for the ids the CHILD knows: the
 * operator's own `CLAUDE_CODE_DEBUG_LOGS_DIR` when they set one, else the
 * binary's default under whatever `CLAUDE_CONFIG_DIR` the child was given. What
 * it cannot answer for is the host-owned file, because `applySessionDiagnosticLog`
 * (`agent/options.ts`) names that one with `NESSY_SESSION_ID` — the HOST session
 * id — while a reader inside the backend holds the SDK's session id. Both are in
 * the child's environment, so both candidates are derivable from it, and the
 * caller picks the first that exists rather than guessing which half wrote.
 *
 * Order mirrors the writer's own precedence: an operator override wins, and the
 * host path is only ever written when there was none.
 */
export function claudeSessionDebugLogCandidates(
  env: NodeJS.ProcessEnv,
  sdkSessionId: string,
): string[] {
  const candidates = [claudeSessionDebugLogPath(env, sdkSessionId)];
  const hostSessionId = env.NESSY_SESSION_ID?.trim();
  if (hostSessionId) {
    const hostPath = sessionRuntimeDebugLogPath('claude', hostSessionId);
    if (!candidates.includes(hostPath)) candidates.push(hostPath);
  }
  return candidates;
}

/**
 * D1.362 — the HOST's own per-session notes, beside the runtime's file rather
 * than inside it.
 *
 * ## The premise this corrects
 *
 * The row was written as *"route the seam line where the per-session runtime
 * diagnostic goes"*. Measured: on claude the host CANNOT, because it does not
 * write that file. `applySessionDiagnosticLog` (`agent/options.ts`) sets
 * `DEBUG_SDK=1` and points `CLAUDE_CODE_DEBUG_LOGS_DIR` at
 * {@link sessionRuntimeDebugLogPath}`('claude', <host session id>)`, and the
 * VENDORED BINARY writes every byte of it, at its own level, with its own
 * rotation. So `<id>-claude.txt` is host-NAMED and child-WRITTEN, and a host
 * line appended into it would be a second, unsynchronised writer on one file —
 * which destroys the one property a diagnostic has, that a reader can tell who
 * said what.
 *
 * The host line is not lost today: `ClaudeAgent.debug` → `BaseAgent.onDebug` →
 * (the single wiring site, `SessionManager`) `sessionLog.info` → the platform
 * log. What it lacks is a reader who will find it: someone holding a Stop that
 * behaved oddly opens the per-session runtime directory, and nothing there ever
 * mentioned the host's half.
 *
 * So the note goes in the SAME directory under the SAME naming rule with a
 * `-host` tail, which is the smallest thing that puts the two halves of one
 * session's story side by side without giving one file two writers.
 *
 * ## Posture, unchanged from this module's header
 *
 * The file exists only while the HOST is in debug mode — the caller passes
 * `hostDebug`, exactly as {@link openSessionRuntimeDebugLog} takes it, so the
 * switch is decided once by the caller that already knows it rather than
 * re-derived here. An ordinary session writes nothing.
 *
 * ## Why `appendFileSync` and not a sink
 *
 * {@link openSessionRuntimeDebugLog} is for a STREAM — Pi's stderr, thousands of
 * chunks, and a lifetime tied to the subprocess. A host note is one line at a
 * rare event (a Stop, a handoff), so a stream would buy buffering nobody needs
 * and cost an open handle plus a close path on every agent. The write is
 * bounded, synchronous and swallowed: a diagnostic must never become the
 * session's problem, which is the same sentence the sink's own error handler is
 * there to make true.
 *
 * Returns the file written, so a caller can say which one it is, and `undefined`
 * whenever nothing was (not in debug mode, no session identity, unwritable
 * directory, failed append) — the caller can then keep its own copy in the host
 * log and claim nothing about a file that does not exist.
 */
export function appendSessionRuntimeHostNote(
  runtime: SessionDebugLogRuntime,
  sessionId: string | undefined,
  note: string,
  hostDebug: boolean,
  at: Date = new Date(),
): string | undefined {
  if (!hostDebug || !note) return undefined;
  const path = sessionRuntimeHostNotePath(runtime, sessionId);
  if (!path) return undefined;
  try {
    appendFileSync(path, `[${at.toISOString()}] ${note}\n`);
  } catch {
    return undefined;
  }
  return path;
}

/**
 * Where {@link appendSessionRuntimeHostNote} writes, and the directory made
 * ready for it — `undefined` when there is no session identity or the directory
 * cannot be created, for the reason {@link ensureSessionRuntimeDebugLog} gives:
 * naming a path nothing can write to turns a promise into a confusing failure.
 *
 * The `-host` tail is what keeps it off `<id>-<runtime>.txt`, which on claude
 * belongs to the child.
 */
export function sessionRuntimeHostNotePath(
  runtime: SessionDebugLogRuntime,
  sessionId: string | undefined,
): string | undefined {
  const trimmed = sessionId?.trim();
  if (!trimmed) return undefined;
  try {
    mkdirSync(sessionRuntimeDebugLogDir(), { recursive: true });
  } catch {
    return undefined;
  }
  return join(sessionRuntimeDebugLogDir(), `${trimmed}-${runtime}-host.txt`);
}
