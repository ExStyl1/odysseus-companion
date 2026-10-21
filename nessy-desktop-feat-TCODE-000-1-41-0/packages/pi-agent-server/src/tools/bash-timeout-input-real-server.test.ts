import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { realServerTestBudget, startRealServerClock } from '../__tests__/support/real-server-clock.ts';

import { ProcessStore } from '../../../server-core/src/pi-harness/process-store.ts';
import { ProcessSupervisor } from '../../../server-core/src/pi-harness/process-supervisor.ts';
import {
  pickSupervisedChildStartFields,
  type SupervisedProcessChildStartRequest,
} from '../../../shared/src/agent/pi-harness/process-supervisor-port.ts';
import {
  createRealServerAllowPermissionReceipt,
  createRealServerExecutionManifest,
} from '../__tests__/real-server-execution-manifest.ts';

const here = dirname(fileURLToPath(import.meta.url));
const defaultEntrypoint = join(here, '..', 'index.ts');
const preloadPath = join(here, 'bash-timeout-input-e2e-preload.ts');
/** F1.546 — the ANSWER budget, from the child's first `ready`; the boot has its own (`real-server-clock.ts`). */
const REAL_SERVER_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = realServerTestBudget(REAL_SERVER_TIMEOUT_MS);

function writeJson(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

/**
 * R10 live-input regression (CDP pass 12, session 022b8e0b, instance fifteen):
 * the model called bash with `timeout: 3000` — MILLISECONDS, per Claude's Bash
 * contract — but the tool-input seam converted it as SECONDS
 * (`secondsToMilliseconds`), producing a 50-minute deadline, so an ~8s command
 * ran to completion with neither the transition nor the kill. This drives the
 * PRODUCTION tool-input path: real subprocess, the verbatim live tool call,
 * the production child-field allowlist, a real supervisor.
 */
async function runTimeoutScenario(options: { sessionId: string; env: Record<string, string> }) {
  const workspaceRootPath = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-bash-timeout-workspace-')));
  const sessionPath = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-bash-timeout-session-')));
  const storeRoot = join(sessionPath, 'process-store');
  const workspaceId = 'bash-timeout-e2e-workspace';
  const sessionKey = { workspaceId, sessionId: options.sessionId };
  const executionManifest = createRealServerExecutionManifest(sessionKey);

  const store = new ProcessStore({ root: storeRoot });
  const supervisor = new ProcessSupervisor({
    store,
    resolveIsolation: input => ({
      command: input.command,
      args: input.args,
      backend: 'test',
      profile: input.profile as Exclude<typeof input.profile, 'none'>,
    }),
  });

  const child = spawn(process.execPath, ['--preload', preloadPath, defaultEntrypoint], {
    cwd: join(here, '..', '..', '..', '..'),
    env: { ...process.env, NO_COLOR: '1', FAUX_API_KEY: 'test', ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = createInterface({ input: child.stdout });
  let stderr = '';
  let promptSent = false;
  const messages: any[] = [];
  const startRequests: SupervisedProcessChildStartRequest[] = [];

  child.stderr.on('data', chunk => {
    stderr += String(chunk);
  });

  const done = new Promise<void>((resolve, reject) => {
    const clock = startRealServerClock({
      answerWaitMs: REAL_SERVER_TIMEOUT_MS,
      onExpire: (_phase, why) => reject(new Error(`bash timeout-input e2e (${options.sessionId}) timed out — ${why}\nstderr:\n${stderr}`)),
    });

    child.on('error', error => {
      clock.clear();
      reject(error);
    });

    stdout.on('line', line => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      messages.push(message);

      if (message.type === 'ready') clock.ready();
      if (message.type === 'ready' && !promptSent) {
        promptSent = true;
        writeJson(child, {
          type: 'prompt',
          id: 'prompt-1',
          message: 'Run the ticker command with a 3000ms timeout.',
          systemPrompt: 'Call the bash tool as scripted.',
          manifestGeneration: executionManifest.snapshotGeneration,
          manifestHash: executionManifest.manifestHash,
        });
        return;
      }

      if (message.type === 'pre_tool_use_request') {
        writeJson(child, {
          type: 'pre_tool_use_response',
          requestId: message.requestId,
          action: 'allow',
          receipt: createRealServerAllowPermissionReceipt(executionManifest, {
            requestId: message.requestId, manifestResponseEpoch: message.manifestResponseEpoch,
            piName: message.piName,
            semanticId: message.semanticId,
            input: message.input,
          }),
        });
        return;
      }

      if (message.type === 'post_tool_use_request') {
        writeJson(child, {
          type: 'post_tool_use_response',
          requestId: message.requestId,
        });
        return;
      }

      if (message.type === 'process_start_request') {
        const request = message.request as SupervisedProcessChildStartRequest;
        startRequests.push(request);
        void supervisor.start({
          ...pickSupervisedChildStartFields(request),
          sessionKey,
          workspaceRoot: workspaceRootPath,
        }).then(
          result => writeJson(child, { type: 'process_start_response', requestId: message.requestId, result }),
          error => writeJson(child, {
            type: 'process_start_response',
            requestId: message.requestId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return;
      }

      if (message.type === 'event' && message.event?.type === 'agent_end' && promptSent) {
        clock.clear();
        resolve();
      }

      if (message.type === 'error') {
        clock.clear();
        reject(new Error(`${message.code}: ${message.message}\nstderr:\n${stderr}`));
      }
    });
  });

  writeJson(child, {
    type: 'init',
    apiKey: 'test',
    model: 'bash-timeout-e2e-model',
    cwd: workspaceRootPath,
    workingDirectory: workspaceRootPath,
    workspaceRootPath,
    workspaceId,
    sessionId: options.sessionId,
    sessionPath,
    plansFolderPath: join(sessionPath, 'plans'),
    thinkingLevel: 'off',
    executionManifest,
    piAuth: { provider: 'faux', credential: { type: 'api_key', key: 'test' } },
  });

  try {
    await done;
  } finally {
    writeJson(child, { type: 'shutdown' });
    child.kill();
    stdout.close();
  }

  const events = messages.filter(message => message.type === 'event').map(message => message.event);
  const bashEnd = events.find(event => event?.type === 'tool_execution_end' && event.toolName === 'bash');
  // Deliberately NOT reaped here: the transition test must observe the task
  // still running after the turn. Callers invoke cleanup() when done.
  const cleanup = async () => {
    const records = await store.list(sessionKey).catch(() => []);
    for (const record of records) {
      if (record.status === 'running') {
        await supervisor.stop({ sessionKey, handle: record.handle }).catch(() => undefined);
      }
    }
  };
  return { events, bashEnd, startRequests, store, storeRoot, sessionKey, workspaceRootPath, cleanup };
}

describe('bash tool-input timeout real server e2e', () => {
  it('timeout: 3000 in the tool input means a 3s deadline and the documented transition', async () => {
    const run = await runTimeoutScenario({ sessionId: 'bash-timeout-e2e-transition', env: {} });
    try {

    // The wire request the live app sends the supervisor: 3000ms, not 3000s.
    expect(run.startRequests).toHaveLength(1);
    expect(run.startRequests[0]!.timeoutMs).toBe(3_000);
    expect(run.startRequests[0]!.onTimeout).toBe('background');
    // Owner decision 2026-07-28: shell commands run with outbound network
    // allowed. `networked` carries the SAME writable root as `workspace`
    // (isolation/darwin.ts, isolation/linux.ts) and differs only in the
    // network dimension. Narrowing this again is R19 (parked) — flipping it
    // back must be a deliberate change, so it is pinned here.
    expect(run.startRequests[0]!.profile).toBe('networked');

    const resultText: string = run.bashEnd?.result?.content?.[0]?.text ?? '';
    expect(resultText).toContain('Command did not complete within its 3s timeout and was moved to the background');
    const shellId = /shell_id: (process_[0-9a-f]{32})/.exec(resultText)?.[1];
    expect(shellId).toBeDefined();
    expect(resultText).toContain(
      `Session cwd remains ${run.workspaceRootPath}; directory changes made by the backgrounded command do not apply to subsequent commands.`,
    );

    // The transitioned process keeps running to completion after the result.
    const outputFile = join(run.storeRoot, `${shellId}.log`);
    let logContent = '';
    for (let attempt = 0; attempt < 60 && !logContent.includes('ALL_DONE'); attempt += 1) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
      logContent = await readFile(outputFile, 'utf8').catch(() => '');
    }
    expect(logContent).toContain('ALL_DONE');
    // ALL_DONE reaching the log is the child's LAST WRITE, not its exit: the
    // supervisor records `exited` from the 'close' handler, several awaits
    // later (process-supervisor.ts — flush, get, then update). Reading the
    // store the instant the log lands races that tail, and loses under load.
    // Poll for the status the same bounded way the log is polled; the
    // assertion is unchanged, so a process that never settles still fails.
    let storeStatus = (await run.store.get(shellId!)).status;
    for (let attempt = 0; attempt < 60 && storeStatus !== 'exited'; attempt += 1) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
      storeStatus = (await run.store.get(shellId!)).status;
    }
    expect(storeStatus).toBe('exited');
    } finally {
      await run.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  it('with the disable env the same input is a plain 3s timeout kill', async () => {
    const run = await runTimeoutScenario({
      sessionId: 'bash-timeout-e2e-disabled',
      env: { NESSY_DISABLE_BACKGROUND_TASKS: '1' },
    });
    try {

    expect(run.startRequests).toHaveLength(1);
    expect(run.startRequests[0]!.timeoutMs).toBe(3_000);
    expect(run.startRequests[0]!.onTimeout).toBeUndefined();

    const resultText: string = run.bashEnd?.result?.content?.[0]?.text ?? '';
    expect(resultText).not.toContain('moved to the background');

    const records = await run.store.list(run.sessionKey);
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe('timed-out');
    // Killed at the 3s deadline: the 8s marker never printed.
    const log = await readFile(join(run.storeRoot, `${records[0]!.handle}.log`), 'utf8').catch(() => '');
    expect(log).not.toContain('ALL_DONE');
    } finally {
      await run.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});
