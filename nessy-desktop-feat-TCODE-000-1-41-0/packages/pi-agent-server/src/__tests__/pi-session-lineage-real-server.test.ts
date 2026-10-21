/**
 * W5d Step-8 lineage fixtures — Pi resume/fork against the global v2 session
 * directories the wire now provides.
 *
 * These drive the REAL pi-agent-server subprocess (via a stubbed OpenAI-compatible
 * endpoint, no network) so the Pi SDK writes FRESH `.pi-sessions` sidecars. They
 * prove the stage-d cutover end-to-end:
 *   - own sidecars land under the wire `sessionPath` (a v2 `getSessionDirPath` dir),
 *     never a recomputed `workspaceRootPath + sessionId` path;
 *   - a child fork locates the parent's sidecars under the wire `branchFromSessionPath`
 *     (also a v2 dir) — i.e. both ends agree on the v2 layout;
 *   - parent -> child -> branch-of-branch preserves distinct native Pi session IDs,
 *     the process cwd, and honors strict fork anchors (branchFromSdkTurnId);
 *   - the Pi runtime never writes the Nessy `session.jsonl` (SessionManager owns it),
 *     so the transient `branchFromSessionPath` cannot leak into it;
 *   - two Workspaces holding the SAME session ID map to distinct v2 dirs and keep
 *     their sidecars isolated.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { getSessionDirPath } from '../../../shared/src/sessions/storage.ts';
import { createRealServerExecutionManifest } from './real-server-execution-manifest.ts';
import { realServerTestBudget, startRealServerClock } from './support/real-server-clock.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = realpathSync(join(here, '..', '..', '..', '..'));
const sourceEntrypoint = realpathSync(join(here, '..', 'index.ts'));
const piCodingAgentEntrypoint = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
const piCodingAgentPackageJson = join(dirname(dirname(piCodingAgentEntrypoint)), 'package.json');
const explicitEntrypoint = process.env.NESSY_PI_SERVER_ENTRYPOINT;
let entrypoint = explicitEntrypoint || sourceEntrypoint;
/**
 * F1.587 — one turn's budget, timed from its child's first `ready`; the child's boot has its own
 * (`support/real-server-clock.ts`, F1.546). A test that spawns N children therefore budgets N whole
 * two-phase clocks (`lineageTestBudget`), where it used to share 600 s among all of them from spawn.
 */
const TURN_ANSWER_WAIT_MS = 240_000;
const lineageTestBudget = (turns: number) => turns * realServerTestBudget(TURN_ANSWER_WAIT_MS);
const SHUTDOWN_DIAGNOSTIC_GRACE_MS = 10_000;
const SHUTDOWN_KILL_GRACE_MS = 5_000;
/**
 * F1.639 — the prebuild `beforeAll`'s own budget, a NAMED literal (the budgets module's escape hatch,
 * `packages/shared/src/testing/module-graph-budgets.ts`: a caller declares its own constant WITH its reading).
 * Readings since F1.59 CI (CI-j, 2026-09-26, macOS arm64, load average 9.3–10.9, other lanes running): the
 * SAME `bun build` command of this entry (3473 modules, 26.7 MB) took 0.39–0.50 s of wall (four runs, 01:05),
 * then 142.9 s, 201.8 s and 271.6 s (01:09–01:21) — always about 1 s user, so the wall is I/O wait on the
 * machine, not the process that runs it. The old in-process `Bun.build` read 204 s (WJ-lift, 2026-09-24) and
 * 590 s (CI-h, 2026-09-26) the same way. 900 000 ms is 1.5x the largest reading (590 s) and 3.3x the largest
 * child reading; the hook kills the child `LINEAGE_PREBUILD_KILL_MARGIN_MS` before it, so a hang fails with
 * the child's stderr, not bun's bare hook timeout.
 * Not the shared hook budget: `check-module-graph-hooks` matches a hook by its dynamic `import(`, so
 * importing that name made its completeness check refuse (exit 2) — and it greps the NAME, so this file must
 * not spell it, even in a comment.
 */
const LINEAGE_PREBUILD_BUDGET_MS = 900_000;
const LINEAGE_PREBUILD_KILL_MARGIN_MS = 10_000;
const spawnedEntrypoints: string[] = [];
const scenarioCleanupPaths = new Set<string>();
let fallbackBuildRoot: string | null = null;
let prebuildCount = 0;

function isWithin(root: string, candidate: string): boolean {
  const delta = relative(root, candidate);
  return delta === '' || (!delta.startsWith(`..${sep}`) && delta !== '..' && !isAbsolute(delta));
}

function ownScenarioPath(path: string): string {
  scenarioCleanupPaths.add(path);
  return path;
}

/**
 * F1.59 CI — the prebuild runs in a FRESH `bun build` process, never an in-process `Bun.build`.
 * Symptom (MR !49, Linux runner, five pipelines from d5ec9426 to ce468be1): inside the ONE `bun test` process
 * of the 25-file chunk 47 (`packages/pi-agent-server/src/__tests__`, this file 19th), the in-process build
 * printed `error: Unexpected reading file` for three workspace imports whose importer is in `packages/shared`
 * (`session-tools-core/src/index.ts`, `codex-responses-adapter/src/nestor-client.ts` and `…/home-latch.ts`),
 * so the hook threw and the case failed as `(unnamed)` before any child server was spawned.
 * The cause is a HYPOTHESIS awaiting the next CI run (lane CI-h, 2026-09-26, not reproduced on macOS):
 * `bun test` runs its resolver with `store_fd = true`, and a process that already resolved those symlinked
 * workspace modules near its fd limit can hand the bundler a stale cached fd. A child `bun build` has its own
 * resolver cache and fd table. If the same three lines come back from the child, the hypothesis is refuted and
 * the runner's fd limit is the next reading. Spawned ASYNC: `spawnSync` beside a loopback server deadlocks
 * (docs/agents/traps.md). Returns the one `.js` file the build wrote — the old `outputs.length === 1` check.
 */
async function prebuildInFreshProcess(buildRoot: string): Promise<string> {
  const args = ['build', sourceEntrypoint, '--outdir', buildRoot, '--target', 'bun', '--format', 'esm'];
  const command = `${process.execPath} ${args.join(' ')}`;
  const started = Date.now();
  const child = spawn(process.execPath, args, { cwd: repoRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  let killedAtDeadline = false;
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(settle => {
    const deadline = setTimeout(() => {
      killedAtDeadline = true;
      child.kill('SIGKILL');
    }, LINEAGE_PREBUILD_BUDGET_MS - LINEAGE_PREBUILD_KILL_MARGIN_MS);
    child.once('error', error => { clearTimeout(deadline); settle({ code: null, signal: null, error }); });
    child.once('close', (code, signal) => { clearTimeout(deadline); settle({ code, signal }); });
  });
  const elapsedMs = Date.now() - started;
  const streams = `--- stderr ---\n${stderr}\n--- stdout ---\n${stdout}`;
  if (outcome.error || killedAtDeadline || outcome.code !== 0) {
    const how = outcome.error
      ? `could not start (${outcome.error.message})`
      : killedAtDeadline
        ? `was killed at its ${LINEAGE_PREBUILD_BUDGET_MS - LINEAGE_PREBUILD_KILL_MARGIN_MS} ms deadline`
        : `exited ${outcome.code ?? `on ${outcome.signal}`}`;
    throw new Error(`lineage prebuild \`${command}\` ${how} after ${elapsedMs} ms\n${streams}`);
  }
  const written = readdirSync(buildRoot);
  const scripts = written.filter(name => name.endsWith('.js'));
  if (written.length !== 1 || scripts.length !== 1) {
    throw new Error(
      `lineage prebuild \`${command}\` wrote ${written.length} files (want exactly one .js): ${written.join(', ')}\n${streams}`,
    );
  }
  return join(buildRoot, scripts[0]!);
}

beforeAll(async () => {
  if (explicitEntrypoint) {
    entrypoint = realpathSync(explicitEntrypoint);
  } else {
    const runnerTemp = process.env.NESSY_TEMP_DIR;
    const parent = runnerTemp
      ? realpathSync(runnerTemp)
      : (fallbackBuildRoot = mkdtempSync(join(tmpdir(), 'nessy-lineage-prebuilt-')));
    const buildRoot = runnerTemp
      ? mkdtempSync(join(parent, 'lineage-prebuilt-'))
      : fallbackBuildRoot;
    if (!buildRoot) throw new Error('lineage prebuild root was not created');
    prebuildCount += 1;
    const builtEntrypoint = await prebuildInFreshProcess(buildRoot);
    copyFileSync(piCodingAgentPackageJson, join(buildRoot, 'package.json'));
    entrypoint = realpathSync(builtEntrypoint);
  }

  if (isWithin(repoRoot, entrypoint)) {
    throw new Error(`lineage entrypoint must be outside checkout: ${entrypoint}`);
  }
  if (!lstatSync(entrypoint).isFile()) {
    throw new Error(`lineage entrypoint must be a regular file: ${entrypoint}`);
  }
  const runnerTemp = process.env.NESSY_TEMP_DIR;
  if (runnerTemp && !isWithin(realpathSync(runnerTemp), entrypoint)) {
    throw new Error(`lineage entrypoint must be inside NESSY_TEMP_DIR: ${entrypoint}`);
  }
  // F1.587 — the prebuild IS the module-graph cost, so it takes its own named budget rather than a
  // turn's (F1.639); since F1.59 CI it is a fresh `bun build` child, sized in LINEAGE_PREBUILD_BUDGET_MS.
}, LINEAGE_PREBUILD_BUDGET_MS);

afterEach(() => {
  for (const path of scenarioCleanupPaths) rmSync(path, { recursive: true, force: true });
  scenarioCleanupPaths.clear();
});

afterAll(() => {
  if (fallbackBuildRoot) rmSync(fallbackBuildRoot, { recursive: true, force: true });
});

function writeSse(res: http.ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

interface TurnTimings {
  spawn?: number;
  serverStart?: number;
  ready?: number;
  providerRequest?: number;
  providerBody?: number;
  agentEnd?: number;
  shutdownWrite?: number;
  childExit?: number;
  childClose?: number;
  readlineClose?: number;
  stubClose?: number;
}

interface TextStub {
  baseUrl: string;
  close: () => Promise<void>;
}

interface ChildExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ShutdownChild {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdin: {
    destroyed: boolean;
    once(event: 'error', listener: (error: Error) => void): unknown;
    removeListener(event: 'error', listener: (error: Error) => void): unknown;
    end(chunk: string): unknown;
  };
  kill(signal: NodeJS.Signals): unknown;
}

interface ShutdownResult {
  exit: ChildExitResult;
  fallbackSignal: 'SIGTERM' | 'SIGKILL' | null;
  shutdownAttempted: boolean;
  stdinError?: Error;
  signalError?: Error;
}

type ShutdownAndReapChild = (options: {
  child: ShutdownChild;
  childClose: Promise<void>;
  childExit: Promise<ChildExitResult>;
  timings: TurnTimings;
  elapsed: () => number;
  wait?: typeof waitWithin;
}) => Promise<ShutdownResult>;

/** Minimal OpenAI-completions SSE stub that returns one text turn per request. */
async function startTextStub(timings: TurnTimings, elapsed: () => number, recordBodies?: string[]): Promise<TextStub> {
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    timings.providerRequest ??= elapsed();
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      recordBodies?.push(body);
      timings.providerBody ??= elapsed();
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'close',
      });
      const base = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'lineage-model',
      };
      writeSse(res, { ...base, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] });
      writeSse(res, {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });
      res.end('data: [DONE]\n\n');
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stub server did not bind to a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: async () => {
      const closed = new Promise<void>(resolveClose => server.close(() => resolveClose()));
      for (const socket of sockets) socket.destroy();
      const outcome = await waitWithin(closed, SHUTDOWN_KILL_GRACE_MS);
      if (!outcome.done) {
        throw new Error(
          `lineage stub close timed out with ${sockets.size} sockets; timings=${JSON.stringify(timings)}`,
        );
      }
      timings.stubClose = elapsed();
    },
  };
}

async function waitWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(value => ({ done: true as const, value })),
      new Promise<{ done: false }>(resolveTimeout => {
        timer = setTimeout(() => resolveTimeout({ done: false }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const shutdownAndReapChild: ShutdownAndReapChild = async ({
  child,
  childClose,
  childExit,
  timings,
  elapsed,
  wait = waitWithin,
}) => {
  let stdinError: Error | undefined;
  let signalError: Error | undefined;
  let shutdownAttempted = false;
  const recordStdinError = (error: Error) => { stdinError ??= error; };
  child.stdin.once('error', recordStdinError);
  if (child.exitCode === null && child.signalCode === null && !child.stdin.destroyed) {
    shutdownAttempted = true;
    timings.shutdownWrite = elapsed();
    try {
      child.stdin.end(`${JSON.stringify({ type: 'shutdown' })}\n`);
    } catch (error) {
      recordStdinError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  let fallbackSignal: ShutdownResult['fallbackSignal'] = null;
  let closed = await wait(childClose, SHUTDOWN_DIAGNOSTIC_GRACE_MS);
  if (!closed.done) {
    fallbackSignal = 'SIGTERM';
    try { child.kill('SIGTERM'); } catch (error) { signalError ??= error instanceof Error ? error : new Error(String(error)); }
    closed = await wait(childClose, SHUTDOWN_KILL_GRACE_MS);
  }
  if (!closed.done) {
    fallbackSignal = 'SIGKILL';
    try { child.kill('SIGKILL'); } catch (error) { signalError ??= error instanceof Error ? error : new Error(String(error)); }
    closed = await wait(childClose, SHUTDOWN_KILL_GRACE_MS);
  }
  if (!closed.done) {
    child.stdin.removeListener('error', recordStdinError);
    throw new Error('lineage child did not close after SIGKILL');
  }
  const exited = await wait(childExit, SHUTDOWN_KILL_GRACE_MS);
  child.stdin.removeListener('error', recordStdinError);
  if (!exited.done) throw new Error('lineage child exit status unavailable after close');
  return {
    exit: exited.value,
    fallbackSignal,
    shutdownAttempted,
    ...(stdinError ? { stdinError } : {}),
    ...(signalError ? { signalError } : {}),
  };
};

function assertShutdownAttempted(shutdown: ShutdownResult, stderr: string): void {
  if (!shutdown.shutdownAttempted) {
    throw new Error(`lineage child exited before explicit shutdown request\nstderr:\n${stderr}`);
  }
}

function assertTimingOrder(timings: TurnTimings, stderr: string, exit: ChildExitResult): void {
  const required: (keyof TurnTimings)[] = [
    'spawn',
    'serverStart',
    'ready',
    'providerRequest',
    'providerBody',
    'agentEnd',
    'shutdownWrite',
    'childExit',
    'childClose',
    'readlineClose',
    'stubClose',
  ];
  const missing = required.filter(key => timings[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`lineage timing markers missing: ${missing.join(', ')}\n${stderr}`);
  }
  const causalSequences: (keyof TurnTimings)[][] = [
    ['spawn', 'serverStart'],
    ['ready', 'providerRequest', 'providerBody', 'agentEnd', 'shutdownWrite'],
    ['childExit', 'childClose', 'stubClose'],
  ];
  for (const ordered of causalSequences) {
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = timings[ordered[index - 1]!]!;
      const current = timings[ordered[index]!]!;
      if (current < previous) {
        throw new Error(`lineage timing order invalid: ${ordered[index - 1]}=${previous}, ${ordered[index]}=${current}`);
      }
    }
  }
  if (timings.readlineClose! < timings.shutdownWrite!) {
    throw new Error(`lineage readline closed before shutdown: ${JSON.stringify(timings)}`);
  }
  if (exit.code !== 0 || exit.signal !== null) {
    throw new Error(
      `lineage child exited ${exit.code}/${exit.signal}; timings=${JSON.stringify(timings)}\nstderr:\n${stderr}`,
    );
  }
}

function validTimings(): Required<TurnTimings> {
  return {
    spawn: 0,
    serverStart: 1,
    ready: 2,
    providerRequest: 3,
    providerBody: 4,
    agentEnd: 5,
    shutdownWrite: 6,
    childExit: 7,
    childClose: 8,
    readlineClose: 8,
    stubClose: 9,
  };
}

interface TurnInit {
  sessionId: string;
  sessionPath: string;
  workspaceRootPath: string;
  cwd: string;
  workspaceId: string;
  branchFromSessionPath?: string;
  branchFromSdkTurnId?: string;
  // UA12.217 — the host's one-shot spawn posture, carried on the init the same
  // way PiAgent sends it: `startFresh` after a /clear (clearHistory nulls the
  // anchor and kills the subprocess; the next prompt spawns with this set),
  // `resumeSessionFile` after `/resume <id>` (the host resolved the id to the
  // file it set aside). Both default undefined — the plain respawn shape.
  startFresh?: boolean;
  resumeSessionFile?: string;
  // UA12.217 — a distinctive prompt word; the stub records each request body
  // so a scenario can read what the MODEL was actually sent.
  prompt?: string;
  recordBodies?: string[];
}

interface TurnResult {
  nativeSessionId: string;
  error: string | null;
}

/** Spawn the subprocess, run exactly one prompt turn, return the native Pi session id. */
async function runTurn(init: TurnInit): Promise<TurnResult> {
  const executionManifest = createRealServerExecutionManifest({
    workspaceId: init.workspaceId,
    sessionId: init.sessionId,
  });
  const startedAt = performance.now();
  const elapsed = () => Math.round(performance.now() - startedAt);
  const timings: TurnTimings = {};
  const stub = await startTextStub(timings, elapsed, init.recordBodies);
  spawnedEntrypoints.push(entrypoint);
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [entrypoint], {
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  timings.spawn = elapsed();
  const stdout = createInterface({ input: child.stdout });
  let stderr = '';
  let stdinError: Error | undefined;
  const recordStdinError = (error: Error) => { stdinError ??= error; };
  child.stdin.on('error', recordStdinError);
  let promptSent = false;
  const result: TurnResult = { nativeSessionId: '', error: null };
  let turnSettled = false;

  child.stderr.on('data', chunk => {
    stderr += String(chunk);
    if (timings.serverStart === undefined && stderr.includes('[pi-server] Pi agent server starting')) {
      timings.serverStart = elapsed();
    }
  });

  const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
    child.once('exit', (code, signal) => {
      timings.childExit = elapsed();
      resolveExit({ code, signal });
    });
  });
  const childClose = new Promise<void>(resolveClose => {
    child.once('close', () => {
      timings.childClose = elapsed();
      resolveClose();
    });
  });
  const readlineClose = new Promise<void>(resolveClose => {
    stdout.once('close', () => {
      timings.readlineClose = elapsed();
      resolveClose();
    });
  });

  const done = new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      if (turnSettled) return;
      turnSettled = true;
      clock.clear();
      if (error) reject(error);
      else resolve();
    };
    const clock = startRealServerClock({
      answerWaitMs: TURN_ANSWER_WAIT_MS,
      onExpire: (_phase, message) => finish(new Error(`lineage turn: ${message}\nstderr:\n${stderr}`)),
    });
    child.on('error', error => finish(error));
    child.once('exit', (code, signal) => {
      if (!turnSettled) finish(new Error(`lineage child exited before agent_end: ${code}/${signal}\nstderr:\n${stderr}`));
    });

    stdout.on('line', line => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }

      if (message.type === 'ready') clock.ready();
      if (message.type === 'ready' && !promptSent) {
        timings.ready = elapsed();
        promptSent = true;
        child.stdin.write(`${JSON.stringify({
          type: 'prompt',
          id: 'prompt-1',
          message: init.prompt ?? `turn for ${init.sessionId}`,
          systemPrompt: 'Reply with exactly one short line.',
          manifestGeneration: executionManifest.snapshotGeneration,
          manifestHash: executionManifest.manifestHash,
        })}\n`);
        return;
      }
      if (message.type === 'pre_tool_use_request') {
        child.stdin.write(`${JSON.stringify({ type: 'pre_tool_use_response', requestId: message.requestId, action: 'allow' })}\n`);
        return;
      }
      if (message.type === 'session_id_update') {
        result.nativeSessionId = message.sessionId;
      }
      if (message.type === 'event' && message.event?.type === 'agent_end' && promptSent) {
        timings.agentEnd = elapsed();
        finish();
      }
      if (message.type === 'error') {
        result.error = `${message.code}: ${message.message}`;
        finish(new Error(`${result.error}\nstderr:\n${stderr}`));
      }
      if (message.type === 'startup_error') {
        result.error = `${message.code}: ${message.message}`;
        finish(new Error(`${result.error}\nstderr:\n${stderr}`));
      }
    });
  });

  child.stdin.write(`${JSON.stringify({
    type: 'init',
    apiKey: 'test',
    model: 'lineage-model',
    cwd: init.cwd,
    workingDirectory: init.cwd,
    workspaceRootPath: init.workspaceRootPath,
    workspaceId: init.workspaceId,
    sessionId: init.sessionId,
    sessionPath: init.sessionPath,
    plansFolderPath: join(init.sessionPath, 'plans'),
    thinkingLevel: 'off',
    baseUrl: stub.baseUrl,
    customEndpoint: { api: 'openai-completions' },
    customModels: ['lineage-model'],
    executionManifest,
    piAuth: { provider: 'custom-endpoint', credential: { type: 'api_key', key: 'test' } },
    ...(init.branchFromSessionPath ? { branchFromSessionPath: init.branchFromSessionPath } : {}),
    ...(init.branchFromSdkTurnId ? { branchFromSdkTurnId: init.branchFromSdkTurnId } : {}),
    ...(init.startFresh !== undefined ? { startFresh: init.startFresh } : {}),
    ...(init.resumeSessionFile ? { resumeSessionFile: init.resumeSessionFile } : {}),
  })}\n`);

  let turnError: unknown;
  try {
    await done;
  } catch (error) {
    turnError = error;
  }

  let cleanupError: unknown;
  let fallbackSignal: 'SIGTERM' | 'SIGKILL' | null = null;
  let exitResult: ChildExitResult | undefined;
  try {
    const shutdown = await shutdownAndReapChild({ child, childClose, childExit, timings, elapsed });
    fallbackSignal = shutdown.fallbackSignal;
    exitResult = shutdown.exit;
    stdinError ??= shutdown.stdinError;
    try {
      assertShutdownAttempted(shutdown, stderr);
    } catch (error) {
      cleanupError ??= error;
    }
    if (shutdown.signalError) cleanupError ??= shutdown.signalError;
  } catch (error) {
    cleanupError = error;
  }
  try {
    const readlineClosed = await waitWithin(readlineClose, SHUTDOWN_KILL_GRACE_MS);
    if (!readlineClosed.done) {
      stdout.close();
      const forcedReadlineClose = await waitWithin(readlineClose, SHUTDOWN_KILL_GRACE_MS);
      if (!forcedReadlineClose.done) throw new Error(`lineage readline did not close\nstderr:\n${stderr}`);
      cleanupError ??= new Error(`lineage readline required forced close\nstderr:\n${stderr}`);
    }
  } catch (error) {
    cleanupError ??= error;
  } finally {
    child.stdin.removeListener('error', recordStdinError);
    try {
      await stub.close();
    } catch (error) {
      cleanupError ??= error;
    }
  }

  console.error(`[A0_LINEAGE_TIMING] ${JSON.stringify({ sessionId: init.sessionId, ...timings })}`);
  if (exitResult) {
    try {
      assertTimingOrder(timings, stderr, exitResult);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (stdinError) cleanupError ??= new Error(`lineage shutdown stdin failed: ${stdinError.message}\nstderr:\n${stderr}`);
  if (fallbackSignal) {
    cleanupError ??= new Error(
      `lineage child required ${fallbackSignal} after graceful shutdown; timings=${JSON.stringify(timings)}\nstderr:\n${stderr}`,
    );
  }
  if (turnError && cleanupError) {
    throw new AggregateError([turnError, cleanupError], `lineage turn and cleanup failed for ${init.sessionId}`);
  }
  if (turnError) throw turnError;
  if (cleanupError) throw cleanupError;
  return result;
}

interface Sidecar {
  file: string;
  cwd: string;
  headerId: string;
  entryIds: string[];
}

/** Read every Pi sidecar under `<sessionPath>/.pi-sessions`, oldest mtime first. */
function readSidecars(sessionPath: string): Sidecar[] {
  const dir = join(sessionPath, '.pi-sessions');
  expect(existsSync(dir)).toBe(true);
  const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
    .map(f => join(dir, f))
    .sort((a, b) => lstatSync(a).mtimeMs - lstatSync(b).mtimeMs);
  return files.map(file => {
    const lines = readFileSync(file, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const header = lines.find(l => l.type === 'session');
    expect(header).toBeDefined();
    const entryIds = lines.filter(l => l.type === 'message' && typeof l.id === 'string').map(l => l.id as string);
    return { file, cwd: header.cwd, headerId: header.id, entryIds };
  });
}

/** Read the single fresh Pi sidecar written under `<sessionPath>/.pi-sessions`. */
function readSidecar(sessionPath: string): Sidecar {
  const sidecars = readSidecars(sessionPath);
  expect(sidecars.length).toBe(1);
  return sidecars[0]!;
}

describe('A0 lineage lifecycle semantics', () => {
  it('accepts cross-pipe marker variance and rejects only causal timing inversion', () => {
    const crossPipeVariance = { ...validTimings(), serverStart: 3, ready: 2 };
    expect(() => assertTimingOrder(crossPipeVariance, '', { code: 0, signal: null })).not.toThrow();
    expect(() => assertTimingOrder(
      { ...validTimings(), providerRequest: 5, providerBody: 4 },
      '',
      { code: 0, signal: null },
    )).toThrow(
      'lineage timing order invalid',
    );
  });

  it('rejects nonzero and signaled child exits after an otherwise natural close', () => {
    expect(() => assertTimingOrder(validTimings(), 'captured stderr', { code: 1, signal: null })).toThrow(
      'lineage child exited 1/null',
    );
    expect(() => assertTimingOrder(validTimings(), 'captured stderr', { code: null, signal: 'SIGTERM' })).toThrow(
      'lineage child exited null/SIGTERM',
    );
  });

  it('captures stdin failure, continues reaping, and bounds SIGKILL close observation', async () => {
    expect(typeof shutdownAndReapChild).toBe('function');

    let stdinErrorListener: ((error: Error) => void) | undefined;
    let waits = 0;
    const stdin = {
      destroyed: false,
      once(_event: 'error', listener: (error: Error) => void) {
        stdinErrorListener = listener;
      },
      removeListener() {
        stdinErrorListener = undefined;
      },
      end() {
        stdinErrorListener?.(Object.assign(new Error('shutdown EPIPE'), { code: 'EPIPE' }));
      },
    };
    const natural = await shutdownAndReapChild({
      child: {
        exitCode: null,
        signalCode: null,
        stdin,
        kill: () => undefined,
      },
      childClose: Promise.resolve(),
      childExit: Promise.resolve({ code: 0, signal: null }),
      timings: validTimings(),
      elapsed: () => 10,
      wait: async <T>(promise: Promise<T>) => {
        waits += 1;
        return { done: true as const, value: await promise };
      },
    });
    expect(natural.stdinError?.message).toBe('shutdown EPIPE');
    expect(waits).toBeGreaterThan(0);

    const kills: NodeJS.Signals[] = [];
    let boundedWaits = 0;
    await expect(shutdownAndReapChild({
      child: {
        exitCode: null,
        signalCode: null,
        stdin: { ...stdin, destroyed: true },
        kill: signal => kills.push(signal),
      },
      childClose: new Promise(() => undefined),
      childExit: new Promise(() => undefined),
      timings: validTimings(),
      elapsed: () => 11,
      wait: async () => {
        boundedWaits += 1;
        return { done: false as const };
      },
    })).rejects.toThrow('lineage child did not close after SIGKILL');
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(boundedWaits).toBe(3);
  });

  it('requires an explicit shutdown attempt even when the child already exited cleanly', async () => {
    let shutdownEnds = 0;
    const timings: TurnTimings = {};
    const result = await shutdownAndReapChild({
      child: {
        exitCode: 0,
        signalCode: null,
        stdin: {
          destroyed: false,
          once: () => undefined,
          removeListener: () => undefined,
          end: () => { shutdownEnds += 1; },
        },
        kill: () => undefined,
      },
      childClose: Promise.resolve(),
      childExit: Promise.resolve({ code: 0, signal: null }),
      timings,
      elapsed: () => 12,
      wait: async <T>(promise: Promise<T>) => ({ done: true as const, value: await promise }),
    });

    expect(shutdownEnds).toBe(0);
    expect(result.shutdownAttempted).toBe(false);
    expect(timings.shutdownWrite).toBeUndefined();
    expect(() => assertShutdownAttempted(result, 'pre-exit stderr')).toThrow(
      'lineage child exited before explicit shutdown request',
    );
    expect(runTurn.toString()).toContain('assertShutdownAttempted');
  });
});

describe('Pi session lineage against v2 dirs (real server)', () => {
  it('uses one external prebuilt entrypoint for every fresh lineage process', () => {
    expect(entrypoint).not.toBe(sourceEntrypoint);
    expect(entrypoint.startsWith(repoRoot)).toBe(false);
    expect(existsSync(entrypoint)).toBe(true);
    expect(lstatSync(entrypoint).isFile()).toBe(true);
    expect(prebuildCount).toBe(explicitEntrypoint ? 0 : 1);
    if (process.env.NESSY_TEMP_DIR) {
      expect(isWithin(realpathSync(process.env.NESSY_TEMP_DIR), entrypoint)).toBe(true);
    }
  });

  it('forks parent -> child -> branch-of-branch, preserving native ids, cwd, and strict anchors', async () => {
    const spawnOffset = spawnedEntrypoints.length;
    const workspaceId = 'ws-lineage-main';
    const workspaceRootPath = ownScenarioPath(mkdtempSync(join(tmpdir(), 'lineage-wsroot-')));
    const cwd = ownScenarioPath(mkdtempSync(join(tmpdir(), 'lineage-cwd-')));

    // Wire session paths are the GLOBAL v2 dirs (SESSIONS_DIR/<workspaceId>/<sessionId>).
    const parentPath = ownScenarioPath(getSessionDirPath(workspaceId, 'lineage-parent'));
    const childPath = ownScenarioPath(getSessionDirPath(workspaceId, 'lineage-child'));
    const grandchildPath = ownScenarioPath(getSessionDirPath(workspaceId, 'lineage-grandchild'));

    // --- Parent: fresh session, sidecars under its v2 dir ---
    const parent = await runTurn({ sessionId: 'lineage-parent', sessionPath: parentPath, workspaceRootPath, workspaceId, cwd });
    expect(parent.error).toBeNull();
    const parentSidecar = readSidecar(parentPath);
    // Own sidecar lives under the wire sessionPath (v2), NOT under workspaceRootPath.
    expect(parentSidecar.file.startsWith(parentPath)).toBe(true);
    expect(parentSidecar.file.startsWith(workspaceRootPath)).toBe(false);
    expect(parentSidecar.cwd).toBe(cwd);
    expect(parentSidecar.entryIds.length).toBeGreaterThan(0);
    const parentAnchor = parentSidecar.entryIds[parentSidecar.entryIds.length - 1]!;

    // The Pi runtime must not persist the Nessy session.jsonl (SessionManager owns it),
    // so the transient wire branchFromSessionPath cannot leak into it.
    expect(existsSync(join(parentPath, 'session.jsonl'))).toBe(false);

    // --- Child: strict-anchor fork from the parent's v2 dir ---
    const child = await runTurn({
      sessionId: 'lineage-child',
      sessionPath: childPath,
      workspaceRootPath,
      workspaceId,
      cwd,
      branchFromSessionPath: parentPath,
      branchFromSdkTurnId: parentAnchor,
    });
    expect(child.error).toBeNull();
    const childSidecar = readSidecar(childPath);
    expect(childSidecar.file.startsWith(childPath)).toBe(true);
    expect(childSidecar.cwd).toBe(cwd);
    // Native Pi session IDs stay distinct across the lineage.
    expect(child.nativeSessionId).not.toBe(parent.nativeSessionId);
    expect(existsSync(join(childPath, 'session.jsonl'))).toBe(false);
    const childAnchor = childSidecar.entryIds[childSidecar.entryIds.length - 1]!;

    // --- Branch-of-branch: fork the grandchild from the child's v2 dir ---
    const grandchild = await runTurn({
      sessionId: 'lineage-grandchild',
      sessionPath: grandchildPath,
      workspaceRootPath,
      workspaceId,
      cwd,
      branchFromSessionPath: childPath,
      branchFromSdkTurnId: childAnchor,
    });
    expect(grandchild.error).toBeNull();
    const grandchildSidecar = readSidecar(grandchildPath);
    expect(grandchildSidecar.file.startsWith(grandchildPath)).toBe(true);
    expect(grandchild.nativeSessionId).not.toBe(child.nativeSessionId);
    expect(grandchild.nativeSessionId).not.toBe(parent.nativeSessionId);
    const scenarioEntrypoints = spawnedEntrypoints.slice(spawnOffset);
    expect(scenarioEntrypoints).toHaveLength(3);
    expect(new Set(scenarioEntrypoints)).toEqual(new Set([entrypoint]));
  }, lineageTestBudget(3));

  // F1.1291 (measured 2026-10-09 on this bundle with a stub that records the model's requests: a branched chat's
  // respawn sent the PARENT's turn and not the branch's own earlier one, and left a second fork file) — every Pi
  // subprocess spawn of a branched chat carries `branchFromSessionPath` (PiAgent derives it from the lineage, which
  // the host keeps), so the subprocess must fork ONCE: once the branch's own `.pi-sessions` holds a session, a
  // respawn resumes it like any other session instead of forking the parent again.
  it('a respawned branch resumes its own fork instead of forking the parent again', async () => {
    const spawnOffset = spawnedEntrypoints.length;
    const workspaceId = 'ws-lineage-respawn';
    const workspaceRootPath = ownScenarioPath(mkdtempSync(join(tmpdir(), 'lineage-respawn-wsroot-')));
    const cwd = ownScenarioPath(mkdtempSync(join(tmpdir(), 'lineage-respawn-cwd-')));
    const parentPath = ownScenarioPath(getSessionDirPath(workspaceId, 'respawn-parent'));
    const childPath = ownScenarioPath(getSessionDirPath(workspaceId, 'respawn-child'));

    const parent = await runTurn({ sessionId: 'respawn-parent', sessionPath: parentPath, workspaceRootPath, workspaceId, cwd });
    expect(parent.error).toBeNull();
    const parentAnchor = readSidecar(parentPath).entryIds.at(-1)!;
    const branch = { sessionPath: childPath, workspaceRootPath, workspaceId, cwd, branchFromSessionPath: parentPath, branchFromSdkTurnId: parentAnchor };

    const first = await runTurn({ sessionId: 'respawn-child', ...branch });
    expect(first.error).toBeNull();
    const forked = readSidecar(childPath);

    // The respawn: the SAME init, as PiAgent sends it for every spawn of this chat.
    const again = await runTurn({ sessionId: 'respawn-child', ...branch });
    expect(again.error).toBeNull();
    const resumed = readSidecar(childPath); // exactly one session file: no second fork (RED before F1.1291: two)
    expect(resumed.file).toBe(forked.file);
    expect(again.nativeSessionId).toBe(first.nativeSessionId);
    expect(resumed.entryIds.slice(0, forked.entryIds.length)).toEqual(forked.entryIds);
    expect(resumed.entryIds.length).toBeGreaterThan(forked.entryIds.length);
    expect(spawnedEntrypoints.slice(spawnOffset)).toHaveLength(3);
  }, lineageTestBudget(3));

  // UA12.217 (measured 2026-10-09, BK-6, work/bk-6/measure-f1291.ts, re-measured 2026-10-10 at HEAD on this
  // bundle: plainRespawnSeesPreClearTurn=true) — /clear nulls the Pi anchor and kills the subprocess, and the
  // next spawn's `continue` strategy resumed the pre-clear session by directory, so the model saw the whole
  // pre-clear conversation the user had just cleared. The host's post-/clear init carries one-shot
  // `startFresh`; the subprocess must build a NEW session (Pi's own `SessionManager.create`) while the
  // pre-clear file stays on disk, and `/resume <id>` — the host resolving the id to its file — must reopen
  // that NAMED file, not the newest in the directory.
  it('a post-/clear spawn starts fresh, keeps the pre-clear file, and /resume reopens the named one', async () => {
    const spawnOffset = spawnedEntrypoints.length;
    const workspaceId = 'ws-lineage-clear';
    const workspaceRootPath = ownScenarioPath(mkdtempSync(join(tmpdir(), 'lineage-clear-wsroot-')));
    const cwd = ownScenarioPath(mkdtempSync(join(tmpdir(), 'lineage-clear-cwd-')));
    const chatPath = ownScenarioPath(getSessionDirPath(workspaceId, 'clear-chat'));
    const WORD = 'U217CLEARWORD-pre-clear';

    // Turn 1 — the pre-clear conversation.
    const bodies1: string[] = [];
    const first = await runTurn({ sessionId: 'clear-chat', sessionPath: chatPath, workspaceRootPath, workspaceId, cwd, prompt: WORD, recordBodies: bodies1 });
    expect(first.error).toBeNull();
    const preClear = readSidecar(chatPath); // exactly one file: the pre-clear session
    expect(bodies1.some(b => b.includes(WORD))).toBe(true); // the instrument sees the word it sent

    // Turn 2 — the post-/clear spawn: SAME init (PiAgent forwards no session id) + startFresh.
    // The model must NOT be sent the pre-clear turn, and the pre-clear file must stay on disk for /resume.
    const bodies2: string[] = [];
    const afterClear = await runTurn({ sessionId: 'clear-chat', sessionPath: chatPath, workspaceRootPath, workspaceId, cwd, prompt: 'post-clear turn', startFresh: true, recordBodies: bodies2 });
    expect(afterClear.error).toBeNull();
    expect(bodies2.some(b => b.includes(WORD))).toBe(false); // RED before UA12.217: the pre-clear turn rode along
    const sidecars = readSidecars(chatPath);
    expect(sidecars).toHaveLength(2); // the pre-clear file survives AND a fresh file was created
    expect(sidecars.some(s => s.file === preClear.file)).toBe(true);
    expect(afterClear.nativeSessionId).not.toBe(first.nativeSessionId);

    // Turn 3 — `/resume <set-aside id>`: the host resolved the id to its file; the subprocess must reopen
    // THAT file, not the newest (the post-clear one).
    const bodies3: string[] = [];
    const resumed = await runTurn({ sessionId: 'clear-chat', sessionPath: chatPath, workspaceRootPath, workspaceId, cwd, prompt: 'resumed turn', resumeSessionFile: preClear.file, recordBodies: bodies3 });
    expect(resumed.error).toBeNull();
    expect(resumed.nativeSessionId).toBe(first.nativeSessionId);
    expect(bodies3.some(b => b.includes(WORD))).toBe(true); // RED before UA12.217: continueRecent opened the post-clear file
    expect(readSidecars(chatPath)).toHaveLength(2); // no third file: the named file was reopened, not forked
    expect(spawnedEntrypoints.slice(spawnOffset)).toHaveLength(3);
  }, lineageTestBudget(3));

  // UA12.217 guard — the flag is ONE-SHOT and only the /clear posture sends it: a plain respawn (a crash, a
  // model switch, a capability refresh) with no flags must keep resuming the conversation by directory.
  it('a respawn with no posture flags still resumes the conversation', async () => {
    const spawnOffset = spawnedEntrypoints.length;
    const workspaceId = 'ws-lineage-plain-respawn';
    const workspaceRootPath = ownScenarioPath(mkdtempSync(join(tmpdir(), 'lineage-plainresp-wsroot-')));
    const cwd = ownScenarioPath(mkdtempSync(join(tmpdir(), 'lineage-plainresp-cwd-')));
    const chatPath = ownScenarioPath(getSessionDirPath(workspaceId, 'plain-respawn-chat'));
    const WORD = 'U217PLAINWORD-kept';

    const bodies1: string[] = [];
    const first = await runTurn({ sessionId: 'plain-respawn-chat', sessionPath: chatPath, workspaceRootPath, workspaceId, cwd, prompt: WORD, recordBodies: bodies1 });
    expect(first.error).toBeNull();

    const bodies2: string[] = [];
    const again = await runTurn({ sessionId: 'plain-respawn-chat', sessionPath: chatPath, workspaceRootPath, workspaceId, cwd, prompt: 'second turn', recordBodies: bodies2 });
    expect(again.error).toBeNull();
    expect(again.nativeSessionId).toBe(first.nativeSessionId);
    expect(bodies2.some(b => b.includes(WORD))).toBe(true); // the conversation is NOT forgotten by a plain respawn
    expect(readSidecars(chatPath)).toHaveLength(1);
    expect(spawnedEntrypoints.slice(spawnOffset)).toHaveLength(2);
  }, lineageTestBudget(2));

  it('isolates equal session IDs across two workspaces', async () => {
    const spawnOffset = spawnedEntrypoints.length;
    const sessionId = 'dup-session';
    const workspaceRootPath = ownScenarioPath(mkdtempSync(join(tmpdir(), 'lineage-dup-wsroot-')));
    const cwd = ownScenarioPath(mkdtempSync(join(tmpdir(), 'lineage-dup-cwd-')));

    const pathA = ownScenarioPath(getSessionDirPath('ws-lineage-alpha', sessionId));
    const pathB = ownScenarioPath(getSessionDirPath('ws-lineage-beta', sessionId));
    // Same session id, different Workspaces -> distinct v2 partitions.
    expect(pathA).not.toBe(pathB);
    expect(pathA.includes('ws-lineage-alpha')).toBe(true);
    expect(pathB.includes('ws-lineage-beta')).toBe(true);

    const a = await runTurn({ sessionId, sessionPath: pathA, workspaceRootPath, workspaceId: 'ws-lineage-alpha', cwd });
    const b = await runTurn({ sessionId, sessionPath: pathB, workspaceRootPath, workspaceId: 'ws-lineage-beta', cwd });
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();

    const sidecarA = readSidecar(pathA);
    const sidecarB = readSidecar(pathB);
    // Each Workspace's sidecar stays under its own partition — no cross-contamination.
    expect(sidecarA.file.startsWith(pathA)).toBe(true);
    expect(sidecarB.file.startsWith(pathB)).toBe(true);
    expect(a.nativeSessionId).not.toBe(b.nativeSessionId);
    const scenarioEntrypoints = spawnedEntrypoints.slice(spawnOffset);
    expect(scenarioEntrypoints).toHaveLength(2);
    expect(new Set(scenarioEntrypoints)).toEqual(new Set([entrypoint]));
  }, lineageTestBudget(2));
});
