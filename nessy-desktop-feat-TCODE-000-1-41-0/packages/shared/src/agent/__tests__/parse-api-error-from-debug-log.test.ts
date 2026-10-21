/**
 * C3.293 — the debug-log error reader itself, which had no test at all.
 *
 * `claudeSessionDebugLogCandidates` (C3.273) is pinned as a pure function by
 * `claude-session-debug-file.test.ts`; the METHOD built around it —
 * `ClaudeAgent`'s private `parseApiErrorFromDebugLog` — was not driven by
 * anything. Its three-attempt retry, its last-50-lines window and its
 * `[ERROR] … {json}` regex were all unexercised, and the regex's last
 * measurement was two bundles old.
 *
 * ## The measurement first, then the test
 *
 * Re-measured 2026-09-12 against the vendored bundle, both self-reports agreeing
 * at `2.1.247` (`claude --version`, and `claudeCodeVersion` in the SDK manifest;
 * SDK `0.3.247`). Every count is OCCURRENCES — `grep -ao <pattern> <file> | wc -l`
 * for a name and `grep -aoF <literal> <file> | wc -l` for a literal, never
 * `grep -c`, which counts matching LINES and is meaningless on a minified
 * artefact. Standing negative control `nessyNotARealSdkKey` → **0** on the native
 * binary and on `sdk.mjs`.
 *
 *  1. **The historical example is still gone.** `Error in non-streaming fallback`
 *     → **0** in the native binary, unchanged from the `2.1.233` reading the
 *     method's own docblock records. The shape quoted there is history.
 *  2. **`[ERROR]` is still the prefix, and it is composed, not written.** The
 *     debug logger's line is built as
 *     `` `${new Date().toISOString()} [${t.toUpperCase()}] ${n}\n` `` — the
 *     literal `` `[${t.toUpperCase()}] ` `` scores **1** in `sdk.mjs` and **1** in
 *     the binary — where `t` is the level. The message is trimmed and its
 *     newlines are FOLDED before the write, so one logged error is exactly one
 *     line, which is what makes a line-based window meaningful.
 *     Independently corroborated by the vendor's own `/debug` prompt, the only
 *     place the literal `[ERROR]` appears at all (**4** occurrences, all four
 *     inside that prompt): *"Look for [ERROR] and [WARN] entries"*.
 *  3. **Almost nothing logs a JSON OBJECT at error level.** Of **1182**
 *     `level:"error"` call sites, **4** interpolate `JSON.stringify` and all four
 *     stringify a host STRING (a rejected SOCKS/sandbox host), which yields a
 *     quoted string and not a `{…}`; **0** have a message template containing a
 *     literal `{`.
 *  4. **The producer that remains is the API error's own message, and it is
 *     real.** The vendored Anthropic SDK's `APIError` builds its message from the
 *     response body: `static makeMessage(` (**1** in `sdk.mjs`) reads
 *     `t?.message ? … : t ? JSON.stringify(t) : …` and returns
 *     `` `${status} ${body}` ``. An Anthropic error envelope is
 *     `{"type":"error","error":{"type":…,"message":…}}`, whose top level has no
 *     `message`, so the whole envelope is stringified and the error's `.message`
 *     reads `400 {"type":"error","error":{…}}`. Interpolated into any error-level
 *     log line, that is exactly the shape this reader parses — so the method's
 *     "the regex may still match lines this measurement did not enumerate" is
 *     confirmed rather than merely hedged, and the fixtures below are the
 *     vendor's two shapes composed, not invented ones.
 *
 * The minified bindings differ between artefacts for the same code (`makeMessage`
 * takes `(e,t,n)` in `sdk.mjs` and `(e,t,r)` in the binary), so the one case that
 * reads the bundle matches CONTENT and SHAPE, never an identifier (P3.309).
 *
 * ## What each case kills
 *
 *  - "returns the most recent error" dies if the backwards search is dropped, if
 *    the JSON group stops being parsed, or if `request_id` stops being carried.
 *  - "only the last fifty lines" is the window's boundary in both directions: one
 *    line inside it must be found and one line outside it must not, so a reader
 *    that silently read the whole file — or stopped reading enough of it — fails.
 *  - "only `[ERROR]`, and only a body with `error.message`" pins the three
 *    refusals that make a false positive impossible: another level, a JSON object
 *    without the field, and text that is not JSON at all.
 *  - "waits for the writer" is the retry: the file is created AFTER the first
 *    attempt, so a reader that gave up on the first miss returns null. Its
 *    negative arm is a file that never arrives.
 *  - "the vendor still writes the shape these fixtures imitate" is the alarm on
 *    the measurement above: a bump that changes the log line or the API error
 *    message turns this red instead of leaving the fixtures quietly fictional.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BackendConfig } from '../backend/types.ts';
import { ClaudeAgent } from '../claude-agent.ts';

/** The SDK-side session id the reader holds; any value, as long as it is stable. */
const SDK_SESSION_ID = 'sdk-session-c3293';

/**
 * A host session id that resolves to a path which does not exist, so the SECOND
 * candidate can never answer for a case about the first. Without it an ambient
 * `NESSY_SESSION_ID` in the runner's environment would be spread into the child
 * env the reader derives and could point at a real file.
 */
const ABSENT_HOST_SESSION_ID = 'host-session-c3293-absent';

interface ParsedApiError {
  readonly errorType: string;
  readonly message: string;
  readonly requestId?: string;
}

interface Internals {
  sessionId: string | null;
  debug: (message: string) => void;
  parseApiErrorFromDebugLog: () => Promise<ParsedApiError | null>;
}

function createConfig(logFile: string): BackendConfig {
  return {
    provider: 'anthropic',
    workspace: {
      id: 'ws-c3293',
      name: 'C3293 Workspace',
      rootPath: '/tmp/ws-c3293',
      workspaceRootPath: '/tmp/ws-c3293',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-c3293',
    } as never,
    session: {
      id: 'session-c3293',
      workspaceRootPath: '/tmp/ws-c3293',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as never,
    model: 'claude-sonnet-4-5',
    isHeadless: true,
    // `CLAUDE_CODE_DEBUG_LOGS_DIR` takes a FILE path despite its name, and it is
    // the first candidate, so this pins which file the reader opens regardless of
    // whatever `CLAUDE_CONFIG_DIR` or workspace id the runner happens to carry.
    envOverrides: {
      CLAUDE_CODE_DEBUG_LOGS_DIR: logFile,
      NESSY_SESSION_ID: ABSENT_HOST_SESSION_ID,
    },
  } as BackendConfig;
}

/** One debug-log line, composed the way the binary composes it. */
function logLine(level: 'ERROR' | 'WARN' | 'DEBUG', message: string): string {
  return `${new Date().toISOString()} [${level}] ${message}`;
}

/** The Anthropic error envelope, as `APIError.makeMessage` stringifies it. */
function apiErrorMessage(message: string, requestId?: string): string {
  const body: Record<string, unknown> = {
    type: 'error',
    error: { type: 'invalid_request_error', message },
  };
  if (requestId) body.request_id = requestId;
  return `400 ${JSON.stringify(body)}`;
}

function errorLine(message: string, requestId?: string): string {
  return logLine('ERROR', `Request failed: ${apiErrorMessage(message, requestId)}`);
}

function filler(count: number, tag: string): string[] {
  return Array.from({ length: count }, (_v, i) => logLine('DEBUG', `${tag} ${i}`));
}

function withAgent<T>(logFile: string, body: (internals: Internals) => Promise<T>): Promise<T> {
  const agent = new ClaudeAgent(createConfig(logFile));
  const internals = agent as unknown as Internals;
  internals.debug = () => {};
  internals.sessionId = SDK_SESSION_ID;
  return body(internals).finally(() => { agent.destroy(); });
}

describe('C3.293 — parseApiErrorFromDebugLog', () => {
  const root = mkdtempSync(join(tmpdir(), 'nessy-c3293-'));
  const logFile = join(root, 'claude-debug.txt');
  const write = (lines: string[]): void => { writeFileSync(logFile, lines.join('\n'), 'utf8'); };
  const clear = (): void => { if (existsSync(logFile)) rmSync(logFile); };

  test('returns the most recent error line, with its type, message and request id', async () => {
    write([
      ...filler(3, 'before'),
      errorLine('older failure', 'req_old'),
      logLine('DEBUG', 'something in between'),
      errorLine('newest failure', 'req_new'),
      ...filler(2, 'after'),
    ]);
    const parsed = await withAgent(logFile, (i) => i.parseApiErrorFromDebugLog());
    expect(parsed).not.toBeNull();
    expect(parsed?.message).toBe('newest failure');
    expect(parsed?.errorType).toBe('invalid_request_error');
    expect(parsed?.requestId).toBe('req_new');
    // The numeric status is deliberately discarded here — P3.333 takes it from
    // the fetch seam instead — so it must not reappear as a field.
    expect(Object.keys(parsed as object).sort()).toEqual(['errorType', 'message', 'requestId']);
  });

  test('reads only the last fifty lines, in both directions', async () => {
    // 50th from the end: inside the window.
    write([...filler(40, 'head'), errorLine('just inside'), ...filler(49, 'tail')]);
    const inside = await withAgent(logFile, (i) => i.parseApiErrorFromDebugLog());
    expect(inside?.message).toBe('just inside');

    // 51st from the end: one line too far back.
    write([...filler(40, 'head'), errorLine('just outside'), ...filler(50, 'tail')]);
    const outside = await withAgent(logFile, (i) => i.parseApiErrorFromDebugLog());
    expect(outside).toBeNull();
  });

  test('takes only `[ERROR]` lines, and only a body that carries `error.message`', async () => {
    // Another level, with a body that would otherwise parse.
    write([logLine('WARN', `Request failed: ${apiErrorMessage('warned, not errored')}`)]);
    expect(await withAgent(logFile, (i) => i.parseApiErrorFromDebugLog())).toBeNull();

    // An `[ERROR]` line whose JSON has no `error.message`.
    write([logLine('ERROR', 'Request failed: 400 {"type":"error","error":{"type":"overloaded"}}')]);
    expect(await withAgent(logFile, (i) => i.parseApiErrorFromDebugLog())).toBeNull();

    // An `[ERROR]` line whose braces are not JSON at all.
    write([logLine('ERROR', 'Request failed: 400 {not json at all}')]);
    expect(await withAgent(logFile, (i) => i.parseApiErrorFromDebugLog())).toBeNull();
  });

  test('waits for the writer: a file that appears after the first attempt is still read', async () => {
    clear();
    const parsed = await withAgent(logFile, async (i) => {
      // Scheduled INSIDE, so the first attempt is guaranteed to miss: the
      // reader's first `existsSync` runs in the synchronous prefix of the call
      // below, before any timer callback can run, and the file only appears
      // while it is sleeping between attempts.
      const appear = setTimeout(() => { write([errorLine('arrived late', 'req_late')]); }, 0);
      try {
        return await i.parseApiErrorFromDebugLog();
      } finally {
        clearTimeout(appear);
      }
    });
    expect(parsed?.message).toBe('arrived late');
    expect(parsed?.requestId).toBe('req_late');

    // The negative arm: a file that never arrives ends as null rather than hanging.
    clear();
    expect(await withAgent(logFile, (i) => i.parseApiErrorFromDebugLog())).toBeNull();
  });

  test('the vendor still writes the two shapes these fixtures imitate', () => {
    const entry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
    const bundlePath = `${entry.slice(0, entry.lastIndexOf('/'))}/sdk.mjs`;
    if (!existsSync(bundlePath)) throw new Error(`vendored sdk.mjs missing at ${bundlePath}`);
    const bundle = readFileSync(bundlePath, 'utf8');
    expect(bundle.length).toBeGreaterThan(1_000_000);
    // The probe reads the file: one control that must be present, one that must not.
    expect(bundle).toContain('CLAUDE_CODE_DEBUG_LOGS_DIR');
    expect(bundle).not.toContain('nessyNotARealSdkKey');

    // 1. the debug line's level prefix, composed from the level rather than written.
    expect(bundle).toContain('[${t.toUpperCase()}] ');
    // 2. the API error message that carries the response body as JSON. The
    //    parameter names are minified and differ per artefact, so this is matched
    //    as a shape.
    const makeMessage = bundle.slice(bundle.indexOf('static makeMessage('));
    expect(makeMessage.length).toBeGreaterThan(0);
    expect(makeMessage.slice(0, 260)).toMatch(/static makeMessage\([^)]*\)\{[^}]*JSON\.stringify\(/);
  });

  // The temp tree is this suite's own and nothing else writes into it.
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });
});
