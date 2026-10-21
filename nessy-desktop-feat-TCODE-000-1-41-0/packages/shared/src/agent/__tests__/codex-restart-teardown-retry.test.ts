/**
 * F1.483 (origin: WJ-ss-b's P-WJ-ss-b-1, F1.411's residue) — a codex runtime
 * teardown that FAILED is retried by the next `disposeForRestart()`; one that
 * succeeded still runs once.
 *
 * ## The defect, measured before the fix
 *
 * `disposeForRestart` memoised its first teardown promise in `runtimeDisposal`
 * and latched `destroyed`. A strict dispose that rejects keeps `managed.agent`
 * (`SessionManager.disposeManagedAgentRuntime`), and F1.411 re-marks the plugin
 * refresh pending so the next turn end or send retries it — but every retry
 * re-awaited the SAME rejection (`teardownRuns=1`), so the session could never
 * be refreshed again and every later send failed. WJ-ss-b's probe
 * (`work/wjssb/probe/codex-dispose-memo.probe.test.ts`, untracked) measured
 * `first=second=codex-runtime-cleanup-failed teardownRuns=1`.
 *
 * ## Why forgetting the memo is not the whole fix
 *
 * `teardownRuntime` nulls every handle BEFORE `cleanupRuntimeResources` releases
 * them, so a bare re-run releases nothing and RESOLVES: the refresh would land
 * over the managed CODEX_HOME the first attempt could not delete — P3.341's
 * option B ("switch anyway and leave that directory on disk"), which the owner
 * did not take (see the throw site in `codex-agent.ts`). So the handles of a
 * failed RESTART release are kept and the retry releases them for real; the
 * `codexHome` arm below is the case that tells the two apart, driven by a real
 * `rmSync` refused by real directory permissions (the attribution test's
 * instrument, precondition included). Only a restart keeps them: `clearHistory`
 * reports its teardown failure and clears anyway, and that path is unchanged.
 *
 * WHAT EACH CASE KILLS (measured on mutant copies, WJ-ab 2026-09-24):
 *  - "fails once, then lands" dies on the memo (the shipped state: the second
 *    call re-awaits the first rejection and the teardown never re-runs) and on
 *    a fix that forgets a successful teardown too.
 *  - "the retry is REAL" dies on the memo AND on the bare forget-the-memo fix
 *    (the second call resolves while the directory is still on disk).
 *  - "a failed /clear teardown keeps nothing" dies on a fix that keeps every
 *    path's bundle, which would let a /clear leak refuse a later restart.
 *  - "concurrent callers share one attempt" is a PIN: two callers of one failed
 *    attempt see one rejection, and two callers after it share one retry.
 *  - "the worker notice is said once" is a PIN, not a kill: the retry re-runs
 *    `disposeForRestart`'s prologue, and `surfaceCodexOperatorNotice` holding a
 *    notice once is what keeps it single (a guard that skipped the prologue was
 *    tried and survived every arm here, so it was not shipped).
 *  - CONTROL "a teardown that succeeds runs once" dies on a fix that forgets a
 *    successful teardown too.
 */
import { describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent, CODEX_TEARDOWN_STEP_FAILURE_PREFIX } from '../codex-agent.ts';

/** Can an r-x PARENT stop an unlink on this host? Not as root / CAP_DAC_OVERRIDE — see `codex-teardown-failure-attribution.test.ts`. */
const rxParentBlocksUnlink = (() => {
  const parent = mkdtempSync(join(tmpdir(), 'f1483-precondition-'));
  const victim = join(parent, 'probe');
  try {
    writeFileSync(victim, 'x\n');
    chmodSync(parent, 0o500);
    try {
      rmSync(victim, { force: true });
      return false;
    } catch {
      return true;
    }
  } catch {
    return false;
  } finally {
    chmodSync(parent, 0o700);
    rmSync(parent, { recursive: true, force: true });
  }
})();
if (!rxParentBlocksUnlink) {
  console.warn('[codex-restart-teardown-retry.test.ts] the real-codexHome case is SKIPPED: an r-x parent does not prevent an unlink on this host (root, or CAP_DAC_OVERRIDE).');
}

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-f1483',
      name: 'F1.483 Workspace',
      rootPath: '/tmp/ws-f1483-root',
      workspaceRootPath: '/tmp/ws-f1483-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-f1483',
    } as never,
    session: {
      id: 'session-f1483',
      workspaceRootPath: '/tmp/ws-f1483-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as never,
    model: 'codex/test-model',
    isHeadless: true,
  } as BackendConfig;
}

interface Internals {
  teardownRuntime: () => Promise<void>;
  debug: (message: string) => void;
  codexHome: string | null;
  pendingServerWarningNotices: string[];
}

function rig() {
  const agent = new CodexAgent(createConfig());
  const internals = agent as unknown as Internals;
  internals.debug = () => {};
  return { agent, internals };
}

/** `disposeForRestart` as a settled value: 'ok' or the rejection's message. */
const dispose = (agent: CodexAgent) => agent.disposeForRestart().then(() => 'ok', (error: Error) => error.message);

/** A teardown that throws `failures` times (the shape `cleanupRuntimeResources` throws), then succeeds. */
function plantTeardown(internals: Internals, failures: number): { runs: () => number } {
  let runs = 0;
  internals.teardownRuntime = async () => {
    runs += 1;
    if (runs <= failures) throw new AggregateError([new Error('CODEX_HOME rm EBUSY')], 'codex-runtime-cleanup-failed');
  };
  return { runs: () => runs };
}

const NOTICE = 'Codex worker is shutting down (runtime_restart).';

describe('F1.483 — a failed codex restart teardown is retried, not re-awaited', () => {
  it('THE DEFECT — a teardown that fails once is re-run by the next call, and the retry lands', async () => {
    const { agent, internals } = rig();
    const teardown = plantTeardown(internals, 1);

    expect(await dispose(agent)).toBe('codex-runtime-cleanup-failed');
    expect(await dispose(agent)).toBe('ok');
    expect(teardown.runs()).toBe(2);
    // …and once it has landed it is memoised like any successful teardown.
    expect(await dispose(agent)).toBe('ok');
    expect(teardown.runs()).toBe(2);
  });

  it('a teardown that keeps failing rejects on every call, and every call re-runs it', async () => {
    const { agent, internals } = rig();
    const teardown = plantTeardown(internals, 3);

    for (let call = 1; call <= 3; call += 1) {
      expect(await dispose(agent)).toBe('codex-runtime-cleanup-failed');
      expect(teardown.runs()).toBe(call);
    }
    expect(await dispose(agent)).toBe('ok');
  });

  it.skipIf(!rxParentBlocksUnlink)('the retry is REAL — the CODEX_HOME the first attempt could not delete is deleted by the second', async () => {
    // NEVER a real home: a fresh mkdtemp under the OS temp dir, removed in the finally.
    const parent = mkdtempSync(join(tmpdir(), 'f1483-parent-'));
    const codexHome = join(parent, 'codex-home');
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, 'rollout.jsonl'), '{}\n');
    const { agent, internals } = rig();
    internals.codexHome = codexHome;
    try {
      chmodSync(parent, 0o500);
      const first = await agent.disposeForRestart().then(() => null, (error: unknown) => error);
      expect(first).toBeInstanceOf(AggregateError);
      const leaves = (first as AggregateError).errors.map(leaf => (leaf as Error).message);
      expect(leaves).toHaveLength(1);
      expect(leaves[0]!.startsWith(`${CODEX_TEARDOWN_STEP_FAILURE_PREFIX}codexHome: `)).toBe(true);
      expect(existsSync(codexHome)).toBe(true);

      // What made the removal fail goes away; the next refresh's teardown retries it.
      chmodSync(parent, 0o700);
      expect(await dispose(agent)).toBe('ok');
      expect(existsSync(codexHome)).toBe(false);
    } finally {
      chmodSync(parent, 0o700);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it.skipIf(!rxParentBlocksUnlink)('a failed /clear teardown keeps nothing: the next restart does not retry its CODEX_HOME', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'f1483-clear-'));
    const codexHome = join(parent, 'codex-home');
    mkdirSync(codexHome);
    const { agent, internals } = rig();
    internals.codexHome = codexHome;
    try {
      chmodSync(parent, 0o500);
      // `clearHistory` calls exactly this and reports the failure; it passes no keep flag.
      const cleared = await internals.teardownRuntime().then(() => null, (error: unknown) => error);
      expect(cleared).toBeInstanceOf(AggregateError);
      // Nothing was kept, so a restart with the directory STILL unremovable has nothing to release.
      expect(await dispose(agent)).toBe('ok');
      expect(existsSync(codexHome)).toBe(true);
    } finally {
      chmodSync(parent, 0o700);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('the worker notice is said once, not once per retry', async () => {
    const { agent, internals } = rig();
    plantTeardown(internals, 1);

    await dispose(agent);
    await dispose(agent);
    // No turn open in this rig, so the notice is held for the next turn.
    expect(internals.pendingServerWarningNotices.filter(notice => notice === NOTICE)).toHaveLength(1);
  });

  it('concurrent callers share one attempt: one failed teardown, then ONE retry between them', async () => {
    const { agent, internals } = rig();
    const teardown = plantTeardown(internals, 1);

    expect(await Promise.all([dispose(agent), dispose(agent)])).toEqual(['codex-runtime-cleanup-failed', 'codex-runtime-cleanup-failed']);
    expect(teardown.runs()).toBe(1);
    expect(await Promise.all([dispose(agent), dispose(agent)])).toEqual(['ok', 'ok']);
    expect(teardown.runs()).toBe(2);
  });
});

describe('F1.483 — CONTROL', () => {
  it('a teardown that succeeds runs once, however many callers ask again', async () => {
    const { agent, internals } = rig();
    const teardown = plantTeardown(internals, 0);

    expect(await dispose(agent)).toBe('ok');
    expect(await dispose(agent)).toBe('ok');
    expect(teardown.runs()).toBe(1);
  });
});
