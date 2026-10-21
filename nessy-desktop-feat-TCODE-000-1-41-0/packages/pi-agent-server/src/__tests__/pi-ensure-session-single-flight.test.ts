/**
 * D1.145 — `ensureSession()` is SINGLE-FLIGHT, driven on the real subprocess.
 *
 * The defect this file exists for is invisible to any unit test of the body:
 * the stdin reader dispatches without awaiting (`rl.on('line', … )` calls
 * `processMessage(msg).catch(…)`), so two inbound messages arriving in the same
 * tick both reached `buildSession()` with `piSession` still null and built TWO
 * Pi sessions. The second overwrote `piSession`, `runtimeHandle` and the
 * `activeSpawner*` / `activeConfigUpdate` handles, leaving the first session's
 * spawner activation dangling on a session nothing could reach or dispose.
 *
 * `ensure_session_ready` is the probe rather than `prompt` because it reaches
 * `ensureSession()` with nothing else in the way — no manifest identity check,
 * no model call — and answers with the built session's own id, so "one session
 * or two" is read off the wire rather than inferred.
 *
 * The two arms:
 *   POSITIVE — two `ensure_session_ready` lines written in ONE stdin write:
 *     exactly one `session_id_update`, and both results carry the SAME id (the
 *     second caller joined the first build instead of starting its own).
 *   NEGATIVE/BOUNDARY — a build that THROWS must not poison the slot: an
 *     `ensure_session_ready` sent before `init` fails, and the one sent after
 *     `init` still builds. An implementation that caches the in-flight promise
 *     without clearing it on settle answers the second call with the first
 *     call's rejection, forever.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';

import { createRealServerExecutionManifest } from './real-server-execution-manifest.ts';
import { REAL_SERVER_BOOT_WAIT_MS, realServerTestBudget } from './support/real-server-clock.ts';

const here = dirname(fileURLToPath(import.meta.url));
const entrypoint = process.env.NESSY_PI_SERVER_ENTRYPOINT || join(here, '..', 'index.ts');
const repoRoot = join(here, '..', '..', '..', '..');
/**
 * F1.641 — the child's BOOT has its own budget. Each case's FIRST wait is the
 * child's first answer, so it covers the module-graph boot and takes
 * `REAL_SERVER_BOOT_WAIT_MS`; every later wait is an answer and keeps
 * `WIRE_TIMEOUT_MS`. The case budget is that boot plus the old 300 s.
 */
const WIRE_TIMEOUT_MS = 240_000;
const CASE_TIMEOUT_MS = realServerTestBudget(WIRE_TIMEOUT_MS);

/** No turn is ever run here — the stub exists so nothing can hang on a socket. */
async function startStub(): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stub did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

function write(child: ChildProcessWithoutNullStreams, ...messages: Record<string, unknown>[]): void {
  child.stdin.write(messages.map(message => `${JSON.stringify(message)}\n`).join(''));
}

function initMessage(
  scenario: string,
  options: { cwd: string; sessionPath: string; baseUrl: string },
): Record<string, unknown> {
  const workspaceId = `${scenario}-workspace`;
  const sessionId = `${scenario}-session`;
  return {
    type: 'init',
    apiKey: 'test',
    model: `${scenario}-model`,
    cwd: options.cwd,
    workingDirectory: options.cwd,
    workspaceRootPath: options.cwd,
    workspaceId,
    sessionId,
    sessionPath: options.sessionPath,
    plansFolderPath: join(options.sessionPath, 'plans'),
    thinkingLevel: 'off',
    baseUrl: options.baseUrl,
    customEndpoint: { api: 'openai-completions' },
    customModels: [`${scenario}-model`],
    executionManifest: createRealServerExecutionManifest({ workspaceId, sessionId }),
    piAuth: { provider: 'custom-endpoint', credential: { type: 'api_key', key: 'test' } },
  };
}

interface Rig {
  child: ChildProcessWithoutNullStreams;
  /** Every decoded stdout message, in arrival order. */
  received: any[];
  /** `timeoutMs` defaults to an answer's budget; the case's first wait passes the boot's. */
  waitFor(predicate: (message: any) => boolean, label: string, timeoutMs?: number): Promise<any>;
  stderr(): string;
  dispose(): Promise<void>;
}

async function startRig(scenario: string): Promise<Rig & { baseUrl: string; cwd: string; sessionPath: string }> {
  const stub = await startStub();
  const cwd = mkdtempSync(join(tmpdir(), `nessy-${scenario}-cwd-`));
  const sessionPath = mkdtempSync(join(tmpdir(), `nessy-${scenario}-session-`));
  const child = spawn(process.execPath, [entrypoint], {
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  const received: any[] = [];
  const waiters: { predicate: (message: any) => boolean; resolve: (message: any) => void }[] = [];
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk) });
  lines.on('line', line => {
    let message: any;
    try { message = JSON.parse(line) } catch { return }
    received.push(message);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  });

  return {
    child,
    received,
    baseUrl: stub.baseUrl,
    cwd,
    sessionPath,
    stderr: () => stderr,
    waitFor(predicate, label, timeoutMs = WIRE_TIMEOUT_MS) {
      const already = received.find(predicate);
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`timed out waiting for ${label} (${timeoutMs} ms)\nstderr:\n${stderr}`)),
          timeoutMs,
        );
        waiters.push({
          predicate,
          resolve: message => { clearTimeout(timeout); resolve(message) },
        });
      });
    },
    async dispose() {
      write(child, { type: 'shutdown' });
      child.kill();
      lines.close();
      await stub.close();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(sessionPath, { recursive: true, force: true });
    },
  };
}

describe('D1.145 — ensureSession is single-flight on the real subprocess', () => {
  it('builds ONE session for two inbound messages that arrive together', async () => {
    const rig = await startRig('single-flight');
    try {
      write(rig.child, initMessage('single-flight', rig));
      await rig.waitFor(message => message.type === 'ready', 'ready', REAL_SERVER_BOOT_WAIT_MS);

      // ONE stdin write, two lines: `rl` emits both before either handler can
      // await anything, which is exactly the race the host produces when a
      // session is opened and polled in the same frame.
      write(
        rig.child,
        { type: 'ensure_session_ready', id: 'first' },
        { type: 'ensure_session_ready', id: 'second' },
      );

      const first = await rig.waitFor(
        message => message.type === 'ensure_session_ready_result' && message.id === 'first',
        'the first ensure_session_ready_result',
      );
      const second = await rig.waitFor(
        message => message.type === 'ensure_session_ready_result' && message.id === 'second',
        'the second ensure_session_ready_result',
      );

      // The session really was built — otherwise the two ids below could agree
      // by both being null and the case would pass while measuring nothing.
      expect(typeof first.sessionId).toBe('string');
      expect(first.sessionId).not.toBe('');
      // ONE build. This is the assertion the defect fails: the second caller
      // joined the first build instead of starting its own.
      expect(second.sessionId).toBe(first.sessionId);
      const builds = rig.received.filter(message => message.type === 'session_id_update');
      expect(builds.length).toBe(1);
      expect(builds[0].sessionId).toBe(first.sessionId);
      // The second caller WAITED: the build's own announcement precedes both
      // answers on the wire.
      expect(rig.received.indexOf(builds[0])).toBeLessThan(rig.received.indexOf(first));
      expect(rig.received.indexOf(builds[0])).toBeLessThan(rig.received.indexOf(second));
    } finally {
      await rig.dispose();
    }
  }, CASE_TIMEOUT_MS);

  it('does not poison the slot when a build throws', async () => {
    const rig = await startRig('single-flight-retry');
    try {
      // Before `init` there is no config to build from, so this build throws.
      write(rig.child, { type: 'ensure_session_ready', id: 'too-early' });
      // The child's first answer, so this wait also covers its boot.
      const failure = await rig.waitFor(
        message => message.type === 'error' && String(message.message).includes('init not received'),
        'the pre-init failure',
        REAL_SERVER_BOOT_WAIT_MS,
      );
      expect(failure.message).toContain('Cannot create session: init not received');
      expect(
        rig.received.some(message => message.type === 'ensure_session_ready_result' && message.id === 'too-early'),
      ).toBe(false);

      write(rig.child, initMessage('single-flight-retry', rig));
      await rig.waitFor(message => message.type === 'ready', 'ready');
      write(rig.child, { type: 'ensure_session_ready', id: 'after-init' });

      const result = await rig.waitFor(
        message => message.type === 'ensure_session_ready_result' && message.id === 'after-init',
        'the post-init ensure_session_ready_result',
      );
      expect(typeof result.sessionId).toBe('string');
      expect(result.sessionId).not.toBe('');
      expect(rig.received.filter(message => message.type === 'session_id_update').length).toBe(1);
    } finally {
      await rig.dispose();
    }
  }, CASE_TIMEOUT_MS);
});
