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
import { handleBashOutput } from '../../../session-tools-core/src/handlers/bash-output.ts';
import { handleProcessStop } from '../../../session-tools-core/src/handlers/process-stop.ts';
import {
  createRealServerAllowPermissionReceipt,
  createRealServerExecutionManifest,
} from '../__tests__/real-server-execution-manifest.ts';
import {
  commandRunsGit,
  isSleepPrefixedCommand,
  isUnparseableCompoundCommand,
} from '../../../shared/src/config/background-task-settings.ts';

const here = dirname(fileURLToPath(import.meta.url));
const defaultEntrypoint = join(here, '..', 'index.ts');
const preloadPath = join(here, 'bash-auto-background-e2e-preload.ts');
/** F1.546 — the ANSWER budget, from the child's first `ready`; the boot has its own (`real-server-clock.ts`). */
const REAL_SERVER_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = realServerTestBudget(REAL_SERVER_TIMEOUT_MS);

function writeJson(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

/**
 * R10 Bash auto-background through the PRODUCTION chain: real pi-agent-server
 * subprocess (real bash tool + runCommand seam), the real wire messages, the
 * production child-field allowlist (`pickSupervisedChildStartFields`, the same
 * function the host uses), and a REAL ProcessSupervisor spawning real
 * processes. A detach performed on a mock while the real SIGTERM path still
 * kills is THE recurring defect this test exists to catch.
 */
/**
 * D1.108 — the fixture commands' PREDICATE PROFILE, asserted before the real
 * server ever runs.
 *
 * The real-server arms below prove the production chain STOPS these two
 * commands; on their own they cannot say WHICH of the three never-background
 * rules stopped them, and an arm that could have been satisfied by any of the
 * three is not an arm for the one it is named after. These four lines are the
 * discriminator, and they cost no spawn: each command matches exactly one
 * predicate. They also fail loudly if somebody edits a fixture command into a
 * shape that happens to trip a second rule — which is exactly how this coverage
 * was lost in the first place (`d67af6f1e` turned arm 1's `while` loop into an
 * unparseable compound, and the rig became a second copy of the `sleep` arm).
 */
const GIT_ARM = 'echo git-arm; git --version; sleep 60';
const COMPOUND_ARM = 'i=0; while [ $i -lt 300 ]; do echo compound-alive; i=$((i+1)); sleep 0.2; done';

describe('D1.108 — each fixture command trips exactly one never-background rule', () => {
  it('the git arm is stopped by the git rule and by nothing else', () => {
    expect(commandRunsGit(GIT_ARM)).toBe(true);
    expect(isSleepPrefixedCommand(GIT_ARM)).toBe(false);
    expect(isUnparseableCompoundCommand(GIT_ARM)).toBe(false);
  });

  it('the compound arm is stopped by the parse rule and by nothing else', () => {
    expect(isUnparseableCompoundCommand(COMPOUND_ARM)).toBe(true);
    expect(isSleepPrefixedCommand(COMPOUND_ARM)).toBe(false);
    expect(commandRunsGit(COMPOUND_ARM)).toBe(false);
  });

  it('CONTROL — the transitioning arm trips NONE of the three', () => {
    // Arm 1 of the preload. Without this the two cases above would pass just as
    // well against predicates that answered `true` for everything.
    const transitions = 'echo tick-0; sleep 0.5; echo tick-1; sleep 0.5; echo tick-2; sleep 0.5; echo tick-3; sleep 0.5; echo bg-done';
    expect(commandRunsGit(transitions)).toBe(false);
    expect(isSleepPrefixedCommand(transitions)).toBe(false);
    expect(isUnparseableCompoundCommand(transitions)).toBe(false);
  });
});

describe('bash auto-background real server e2e', () => {
  it('transitions on timeout, excludes sleep, and honors run_in_background', async () => {
    const workspaceRootPath = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-bash-bg-workspace-')));
    const sessionPath = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-bash-bg-session-')));
    const storeRoot = join(sessionPath, 'process-store');
    const workspaceId = 'bash-bg-e2e-workspace';
    const sessionId = 'bash-bg-e2e-session';
    const sessionKey = { workspaceId, sessionId };
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
      env: { ...process.env, NO_COLOR: '1', FAUX_API_KEY: 'test' },
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
        onExpire: (_phase, why) => reject(new Error(`bash auto-background real-server e2e timed out — ${why}\nstderr:\n${stderr}`)),
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
            message: 'Run the three bash commands.',
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
          // The PRODUCTION allowlist rebuild — the same function pi-agent.ts uses.
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
      model: 'bash-bg-e2e-model',
      cwd: workspaceRootPath,
      workingDirectory: workspaceRootPath,
      workspaceRootPath,
      workspaceId,
      sessionId,
      sessionPath,
      plansFolderPath: join(sessionPath, 'plans'),
      thinkingLevel: 'off',
      executionManifest,
      piAuth: { provider: 'faux', credential: { type: 'api_key', key: 'test' } },
    });

    try {
      await done;

      const events = messages.filter(message => message.type === 'event').map(message => message.event);
      const bashEnds = events.filter(event => event?.type === 'tool_execution_end' && event.toolName === 'bash');
      expect(bashEnds).toHaveLength(5);

      // --- 1. The timeout transition returns the documented handle. ---
      // The fixture command is a LIST OF SIMPLE COMMANDS for a reason the
      // preload spells out: `d67af6f1e` made an unparseable compound one of the
      // three kinds the page says to STOP rather than background, and the old
      // `while`-loop fixture silently became a second copy of arm 2.
      const timeoutResultText: string = bashEnds[0]?.result?.content?.[0]?.text ?? '';
      expect(timeoutResultText).toContain('Command did not complete within its 1s timeout and was moved to the background');
      const shellId = /shell_id: (process_[0-9a-f]{32})/.exec(timeoutResultText)?.[1];
      expect(shellId).toBeDefined();
      const outputFile = /output_file: (.+)/.exec(timeoutResultText)?.[1];
      expect(outputFile).toBe(join(storeRoot, `${shellId}.log`));
      expect(timeoutResultText).toContain(
        `Session cwd remains ${workspaceRootPath}; directory changes made by the backgrounded command do not apply to subsequent commands.`,
      );

      // The transitioned process KEPT RUNNING after the tool result: the real
      // log file grows to completion.
      let logContent = '';
      for (let attempt = 0; attempt < 60 && !logContent.includes('bg-done'); attempt += 1) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
        logContent = await readFile(outputFile!, 'utf8').catch(() => '');
      }
      expect(logContent).toContain('bg-done');
      expect((await store.get(shellId!)).status).toBe('exited');

      // The transition surfaced as a background shell for the existing listing.
      const backgroundedEvents = events.filter(event => event?.type === 'shell_backgrounded');
      expect(backgroundedEvents.some((event: any) => event.shellId === shellId)).toBe(true);

      // BashOutput (the ordinary retrieval surface) reads the transitioned task.
      const bashOutput = await handleBashOutput(
        { readBackgroundShellOutput: async (id: string, offset?: number) => {
          const read = await supervisor.read({ sessionKey, handle: id, cursor: offset });
          return { shellId: read.handle, output: read.output, nextOffset: read.nextCursor, isRunning: read.isRunning };
        } } as never,
        { shell_id: shellId! },
      );
      const bashOutputText = (bashOutput.content[0] as { text: string }).text;
      expect(bashOutput.isError).toBeFalsy();
      expect(bashOutputText).toContain('tick-0');
      expect(bashOutputText).toContain('bg-done');

      // --- 2. sleep-prefixed command: killed exactly as today. ---
      const sleepResultText: string = bashEnds[1]?.result?.content?.[0]?.text ?? '';
      expect(sleepResultText).not.toContain('moved to the background');
      // The child wraps commands for the shell: command '/bin/sh', args ['-lc', <raw>].
      const sleepRequest = startRequests.find(request => request.args?.[1] === 'sleep 60');
      expect(sleepRequest).toBeDefined();
      const sleepRecords = (await store.list(sessionKey)).filter(record => record.executionId === sleepRequest!.executionId);
      expect(sleepRecords).toHaveLength(1);
      expect(sleepRecords[0]!.status).toBe('timed-out');

      // --- 3. run_in_background: immediate handle, then ProcessStop stops it. ---
      const backgroundResultText: string = bashEnds[2]?.result?.content?.[0]?.text ?? '';
      expect(backgroundResultText).not.toContain('did not complete within');
      const backgroundShellId = /shell_id: (process_[0-9a-f]{32})/.exec(backgroundResultText)?.[1];
      expect(backgroundShellId).toBeDefined();
      expect(backgroundShellId).not.toBe(shellId);
      expect(backgroundResultText).toContain(`output_file: ${join(storeRoot, `${backgroundShellId}.log`)}`);
      expect(backgroundResultText).toContain(
        `Session cwd remains ${workspaceRootPath}; directory changes made by the backgrounded command do not apply to subsequent commands.`,
      );
      expect((await store.get(backgroundShellId!)).status).toBe('running');

      const stopResult = await handleProcessStop(
        { stopBackgroundShell: async (id: string) => { await supervisor.stop({ sessionKey, handle: id }); } } as never,
        { shell_id: backgroundShellId! },
      );
      expect(stopResult.isError).toBeFalsy();
      expect((await store.get(backgroundShellId!)).status).toBe('stopped');

      // --- D1.108 · 4 and 5. The OTHER TWO never-auto-background kinds. ---
      //
      // `tools-reference.md#background-commands` names three, `d67af6f1e` built
      // all three predicates, and only the `sleep` one had a real-server arm:
      // both bash rigs were exercising an unparseable compound BY ACCIDENT, and
      // once `f60dcd2bf`/`97648da02` corrected that, the production chain lost
      // the coverage without anything going red. Arm 1 above is the standing
      // POSITIVE CONTROL for both — a parseable, git-free, non-`sleep` command
      // that DOES transition on the same timeout in the same run — so a chain
      // that backgrounded nothing at all could not make these two pass.
      const stoppedAtTimeout = async (raw: string): Promise<void> => {
        const request = startRequests.find(item => item.args?.[1] === raw);
        expect(request).toBeDefined();
        const records = (await store.list(sessionKey)).filter(record => record.executionId === request!.executionId);
        expect(records).toHaveLength(1);
        expect(records[0]!.status).toBe('timed-out');
      };

      // 4. "A command that runs `git` anywhere in it." Not `sleep`-prefixed and
      //    a plain list of simple commands, so `commandRunsGit` is the only one
      //    of the three predicates that can have stopped it.
      const gitResultText: string = bashEnds[3]?.result?.content?.[0]?.text ?? '';
      expect(gitResultText).not.toContain('moved to the background');
      expect(gitResultText).not.toContain('shell_id:');
      await stoppedAtTimeout(GIT_ARM);

      // 5. "A compound command Claude Code can't fully parse into simple
      //    commands." No `git`, no leading `sleep`, so this arm is
      //    `isUnparseableCompoundCommand` alone.
      const compoundResultText: string = bashEnds[4]?.result?.content?.[0]?.text ?? '';
      expect(compoundResultText).not.toContain('moved to the background');
      expect(compoundResultText).not.toContain('shell_id:');
      await stoppedAtTimeout(COMPOUND_ARM);
    } finally {
      // Reap anything still running so no detached process outlives the test.
      const records = await store.list(sessionKey).catch(() => []);
      for (const record of records) {
        if (record.status === 'running') {
          await supervisor.stop({ sessionKey, handle: record.handle }).catch(() => undefined);
        }
      }
      writeJson(child, { type: 'shutdown' });
      child.kill();
      stdout.close();
    }
  }, TEST_TIMEOUT_MS);
});
