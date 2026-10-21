import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';

import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

function config(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-cwd',
      name: 'Cwd',
      rootPath: '/tmp/nessy-cwd-old',
      workspaceRootPath: '/tmp/nessy-cwd-old',
      sessionRootPath: '/tmp/nessy-cwd-sessions',
    } as never,
    session: {
      id: 'session-cwd',
      createdAt: 0,
      lastUsedAt: 0,
      workingDirectory: '/tmp/nessy-cwd-old',
    } as never,
    isHeadless: true,
  };
}

type CwdRequest = {
  type: 'working_directory_transaction';
  id: string;
  phase: 'prepare' | 'commit' | 'rollback' | 'finalize';
  expectedGeneration: number;
  generation: number;
  cwd: string;
};

type PiCwdRuntime = {
  ensureSubprocess(): Promise<void>;
  spawnSubprocess(attempt: unknown): Promise<void>;
  prepareWorkingDirectoryUpdate(input: {
    previousPath: string;
    path: string;
    intent: 'keep' | 'bind' | 'unbind';
  }): Promise<{
    generation: number;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    finalize(): Promise<void>;
  }>;
  handleLine(line: string): void;
  subprocess: FakeChild | null;
  readline: FakeReadline | null;
  subprocessTermination: Promise<void> | null;
};

class FakeReadline {
  removeAllListeners(): void {}
  close(): void {}
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdin: { writable: boolean; write: (line: string) => boolean };

  constructor(writes: Array<Record<string, unknown>>) {
    super();
    this.stdin = {
      writable: true,
      write: (line) => {
        writes.push(JSON.parse(line) as Record<string, unknown>);
        return true;
      },
    };
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signalCode = signal;
    queueMicrotask(() => {
      this.exitCode = 0;
      this.emit('exit', 0, signal);
    });
    return true;
  }
}

function transactionRequests(writes: Array<Record<string, unknown>>): CwdRequest[] {
  return writes.filter((entry): entry is CwdRequest => entry.type === 'working_directory_transaction');
}

async function waitForNextRequest(
  writes: Array<Record<string, unknown>>,
  previousCount: number,
): Promise<CwdRequest> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const requests = transactionRequests(writes);
    if (requests.length > previousCount) return requests.at(-1)!;
    await Promise.resolve();
  }
  throw new Error('expected a working-directory transaction request');
}

function acknowledge(
  runtime: PiCwdRuntime,
  request: CwdRequest,
  overrides: Partial<Record<string, unknown>> = {},
): void {
  runtime.handleLine(JSON.stringify({
    type: 'working_directory_transaction_result',
    id: request.id,
    phase: request.phase,
    generation: request.generation,
    success: true,
    ...overrides,
  }));
}

describe('PiAgent live cwd transaction', () => {
  it('prepares through an acknowledged Pi-local generation', async () => {
    const agent = new PiAgent(config());
    const writes: Array<Record<string, unknown>> = [];
    const runtime = agent as never as {
      ensureSubprocess(): Promise<void>;
      prepareWorkingDirectoryUpdate(input: {
        previousPath: string;
        path: string;
        intent: 'keep' | 'bind' | 'unbind';
      }): Promise<{ generation: number; rollback(): Promise<void> }>;
      handleLine(line: string): void;
      subprocess: { stdin: { writable: boolean; write(line: string): boolean } };
    };
    runtime.ensureSubprocess = async () => {};
    runtime.subprocess = {
      stdin: {
        writable: true,
        write(line) {
          writes.push(JSON.parse(line) as Record<string, unknown>);
          return true;
        },
      },
    };

    const prepared = runtime.prepareWorkingDirectoryUpdate({
      previousPath: '/tmp/nessy-cwd-old',
      path: '/tmp/nessy-cwd-new',
      intent: 'keep',
    });
    await Promise.resolve();
    const request = writes[0];
    expect(request).toMatchObject({
      type: 'working_directory_transaction',
      phase: 'prepare',
      expectedGeneration: 0,
      generation: 1,
      cwd: '/tmp/nessy-cwd-new',
    });
    runtime.handleLine(JSON.stringify({
      type: 'working_directory_transaction_result',
      id: request?.id,
      phase: 'prepare',
      generation: 1,
      success: true,
    }));
    const transaction = await prepared;
    expect(transaction.generation).toBe(1);

    const rollback = transaction.rollback();
    await Promise.resolve();
    runtime.handleLine(JSON.stringify({
      type: 'working_directory_transaction_result',
      id: request?.id,
      phase: 'rollback',
      generation: 1,
      success: true,
    }));
    await rollback;
    agent.destroy();
  });

  it('retires poisoned generations and restarts the child protocol at generation zero', async () => {
    const agent = new PiAgent(config());
    const writes: Array<Record<string, unknown>> = [];
    const runtime = agent as never as PiCwdRuntime;
    let spawnCount = 0;
    runtime.spawnSubprocess = async () => {
      spawnCount += 1;
      runtime.subprocess = new FakeChild(writes);
      runtime.readline = new FakeReadline();
    };

    const firstPrepared = runtime.prepareWorkingDirectoryUpdate({
      previousPath: '/tmp/nessy-cwd-old',
      path: '/tmp/nessy-cwd-one',
      intent: 'keep',
    });
    const firstPrepare = await waitForNextRequest(writes, 0);
    acknowledge(runtime, firstPrepare);
    const first = await firstPrepared;
    let requestCount = transactionRequests(writes).length;
    const firstCommitPromise = first.commit();
    acknowledge(runtime, await waitForNextRequest(writes, requestCount));
    await firstCommitPromise;
    requestCount = transactionRequests(writes).length;
    const firstFinalizePromise = first.finalize();
    acknowledge(runtime, await waitForNextRequest(writes, requestCount));
    await firstFinalizePromise;

    requestCount = transactionRequests(writes).length;
    const mismatchedPreparePromise = runtime.prepareWorkingDirectoryUpdate({
      previousPath: '/tmp/nessy-cwd-one',
      path: '/tmp/nessy-cwd-two',
      intent: 'keep',
    });
    const mismatchedOutcome = mismatchedPreparePromise.then(
      () => 'resolved',
      error => error instanceof Error ? error.message : String(error),
    );
    const mismatchedPrepare = await waitForNextRequest(writes, requestCount);
    expect(mismatchedPrepare).toMatchObject({ expectedGeneration: 1, generation: 2 });
    acknowledge(runtime, mismatchedPrepare, { id: 'wrong-transaction' });
    expect(await mismatchedOutcome).toContain('stale or mismatched');
    await runtime.subprocessTermination;

    requestCount = transactionRequests(writes).length;
    const afterMismatchPromise = runtime.prepareWorkingDirectoryUpdate({
      previousPath: '/tmp/nessy-cwd-one',
      path: '/tmp/nessy-cwd-three',
      intent: 'keep',
    });
    const afterMismatch = await waitForNextRequest(writes, requestCount);
    expect(afterMismatch).toMatchObject({ expectedGeneration: 0, generation: 1 });
    acknowledge(runtime, afterMismatch);
    const recovered = await afterMismatchPromise;
    requestCount = transactionRequests(writes).length;
    const rollbackPromise = recovered.rollback();
    acknowledge(runtime, await waitForNextRequest(writes, requestCount));
    await rollbackPromise;

    expect(spawnCount).toBe(2);
    agent.destroy();
  });

  it('retires a child after any negative transaction result and recovers once', async () => {
    const agent = new PiAgent(config());
    const writes: Array<Record<string, unknown>> = [];
    const runtime = agent as never as PiCwdRuntime;
    let spawnCount = 0;
    runtime.spawnSubprocess = async () => {
      spawnCount += 1;
      runtime.subprocess = new FakeChild(writes);
      runtime.readline = new FakeReadline();
    };

    const failed = runtime.prepareWorkingDirectoryUpdate({
      previousPath: '/tmp/nessy-cwd-old',
      path: '/tmp/nessy-cwd-failed',
      intent: 'keep',
    });
    const outcome = failed.then(
      () => 'resolved',
      error => error instanceof Error ? error.message : String(error),
    );
    const failedRequest = await waitForNextRequest(writes, 0);
    expect(failedRequest.phase).toBe('prepare');
    acknowledge(runtime, failedRequest, {
      success: false,
      errorMessage: 'child restoration incomplete',
    });
    expect(await outcome).toContain('child restoration incomplete');
    await runtime.subprocessTermination;

    const beforeRetry = transactionRequests(writes).length;
    const retried = runtime.prepareWorkingDirectoryUpdate({
      previousPath: '/tmp/nessy-cwd-old',
      path: '/tmp/nessy-cwd-recovered',
      intent: 'keep',
    });
    const retryRequest = await waitForNextRequest(writes, beforeRetry);
    expect(retryRequest).toMatchObject({ expectedGeneration: 0, generation: 1 });
    acknowledge(runtime, retryRequest);
    const transaction = await retried;
    const beforeRollback = transactionRequests(writes).length;
    const rollback = transaction.rollback();
    acknowledge(runtime, await waitForNextRequest(writes, beforeRollback));
    await rollback;

    expect(spawnCount).toBe(2);
    agent.destroy();
  });

  it('restores parent cwd even when a committed child rejects rollback', async () => {
    const backendConfig = config();
    const session = backendConfig.session;
    if (!session) throw new Error('expected session config');
    const agent = new PiAgent(backendConfig);
    const writes: Array<Record<string, unknown>> = [];
    const runtime = agent as never as PiCwdRuntime;
    runtime.spawnSubprocess = async () => {
      runtime.subprocess = new FakeChild(writes);
      runtime.readline = new FakeReadline();
    };

    const prepared = runtime.prepareWorkingDirectoryUpdate({
      previousPath: '/tmp/nessy-cwd-old',
      path: '/tmp/nessy-cwd-committed',
      intent: 'keep',
    });
    let requestCount = transactionRequests(writes).length;
    acknowledge(runtime, await waitForNextRequest(writes, requestCount));
    const transaction = await prepared;

    requestCount = transactionRequests(writes).length;
    const committed = transaction.commit();
    acknowledge(runtime, await waitForNextRequest(writes, requestCount));
    await committed;
    expect(session.workingDirectory).toBe('/tmp/nessy-cwd-committed');

    requestCount = transactionRequests(writes).length;
    const rollback = transaction.rollback();
    const rollbackOutcome = rollback.then(
      () => 'resolved',
      error => error instanceof Error ? error.message : String(error),
    );
    acknowledge(runtime, await waitForNextRequest(writes, requestCount), {
      success: false,
      errorMessage: 'child rollback failed',
    });

    expect(await rollbackOutcome).toContain('child rollback failed');
    expect(session.workingDirectory).toBe('/tmp/nessy-cwd-old');
    await runtime.subprocessTermination;
    expect(runtime.subprocess).toBeNull();
    agent.destroy();
  });

  it('keeps child-committed state when the parent cwd update throws', async () => {
    const backendConfig = config();
    const session = backendConfig.session;
    if (!session) throw new Error('expected session config');
    const agent = new PiAgent(backendConfig);
    const writes: Array<Record<string, unknown>> = [];
    const runtime = agent as never as PiCwdRuntime;
    runtime.spawnSubprocess = async () => {
      runtime.subprocess = new FakeChild(writes);
      runtime.readline = new FakeReadline();
    };
    const permissionManager = agent.getPermissionManager() as unknown as {
      updateWorkingDirectory(path: string): void;
    };
    const updatePermissionCwd = permissionManager.updateWorkingDirectory.bind(permissionManager);
    let failParentCommit = true;
    permissionManager.updateWorkingDirectory = (path) => {
      if (failParentCommit) {
        failParentCommit = false;
        throw new Error('parent cwd update failed');
      }
      updatePermissionCwd(path);
    };

    const prepared = runtime.prepareWorkingDirectoryUpdate({
      previousPath: '/tmp/nessy-cwd-old',
      path: '/tmp/nessy-cwd-parent-failure',
      intent: 'keep',
    });
    let requestCount = transactionRequests(writes).length;
    acknowledge(runtime, await waitForNextRequest(writes, requestCount));
    const transaction = await prepared;

    requestCount = transactionRequests(writes).length;
    const commit = transaction.commit();
    const commitOutcome = commit.then(
      () => 'resolved',
      error => error instanceof Error ? error.message : String(error),
    );
    acknowledge(runtime, await waitForNextRequest(writes, requestCount));
    expect(await commitOutcome).toContain('parent cwd update failed');
    expect(session.workingDirectory).toBe('/tmp/nessy-cwd-parent-failure');

    requestCount = transactionRequests(writes).length;
    const rollback = transaction.rollback();
    acknowledge(runtime, await waitForNextRequest(writes, requestCount));
    await rollback;
    expect(session.workingDirectory).toBe('/tmp/nessy-cwd-old');
    agent.destroy();
  });

  it('propagates finalize cleanup failure, restores parent cwd, and retires the child', async () => {
    const backendConfig = config();
    const session = backendConfig.session;
    if (!session) throw new Error('expected session config');
    const agent = new PiAgent(backendConfig);
    const writes: Array<Record<string, unknown>> = [];
    const runtime = agent as never as PiCwdRuntime;
    runtime.spawnSubprocess = async () => {
      runtime.subprocess = new FakeChild(writes);
      runtime.readline = new FakeReadline();
    };

    const prepared = runtime.prepareWorkingDirectoryUpdate({
      previousPath: '/tmp/nessy-cwd-old',
      path: '/tmp/nessy-cwd-finalize-failure',
      intent: 'keep',
    });
    let requestCount = transactionRequests(writes).length;
    acknowledge(runtime, await waitForNextRequest(writes, requestCount));
    const transaction = await prepared;

    requestCount = transactionRequests(writes).length;
    const commit = transaction.commit();
    acknowledge(runtime, await waitForNextRequest(writes, requestCount));
    await commit;
    expect(session.workingDirectory).toBe('/tmp/nessy-cwd-finalize-failure');

    requestCount = transactionRequests(writes).length;
    const finalize = transaction.finalize();
    acknowledge(runtime, await waitForNextRequest(writes, requestCount), {
      success: false,
      errorMessage: 'old runtime dispose failed',
    });

    await expect(finalize).rejects.toThrow('old runtime dispose failed');
    await runtime.subprocessTermination;
    expect(session.workingDirectory).toBe('/tmp/nessy-cwd-old');
    expect(runtime.subprocess).toBeNull();
    await expect(transaction.rollback()).resolves.toBeUndefined();
    agent.destroy();
  });

  it('poisons and retires a child when a transaction phase times out', async () => {
    const agent = new PiAgent(config());
    const writes: Array<Record<string, unknown>> = [];
    const runtime = agent as never as PiCwdRuntime;
    runtime.spawnSubprocess = async () => {
      runtime.subprocess = new FakeChild(writes);
      runtime.readline = new FakeReadline();
    };

    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const phaseTimer = { callback: undefined as (() => void) | undefined };
    const syntheticHandle = {} as ReturnType<typeof setTimeout>;
    globalThis.setTimeout = ((callback: (...values: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === 15_000) {
        phaseTimer.callback = () => callback(...args);
        return syntheticHandle;
      }
      return originalSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
      if (handle !== syntheticHandle) originalClearTimeout(handle);
    }) as typeof clearTimeout;

    try {
      const prepared = runtime.prepareWorkingDirectoryUpdate({
        previousPath: '/tmp/nessy-cwd-old',
        path: '/tmp/nessy-cwd-timeout',
        intent: 'keep',
      });
      const outcome = prepared.then(
        () => 'resolved',
        error => error instanceof Error ? error.message : String(error),
      );
      await waitForNextRequest(writes, 0);
      expect(phaseTimer.callback).toBeFunction();
      phaseTimer.callback!();
      expect(await outcome).toContain('timed out after 15s');
      await runtime.subprocessTermination;

      const requestCount = transactionRequests(writes).length;
      const retried = runtime.prepareWorkingDirectoryUpdate({
        previousPath: '/tmp/nessy-cwd-old',
        path: '/tmp/nessy-cwd-retry',
        intent: 'keep',
      });
      const request = await waitForNextRequest(writes, requestCount);
      expect(request).toMatchObject({ expectedGeneration: 0, generation: 1 });
      acknowledge(runtime, request);
      const transaction = await retried;
      const beforeRollback = transactionRequests(writes).length;
      const rollback = transaction.rollback();
      acknowledge(runtime, await waitForNextRequest(writes, beforeRollback));
      await rollback;
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      agent.destroy();
    }
  });
});
