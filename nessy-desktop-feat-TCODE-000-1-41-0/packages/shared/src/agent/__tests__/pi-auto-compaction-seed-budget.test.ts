import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';

import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

/**
 * C3.383 — the auto-compaction seed is the LAST step of subprocess bring-up, and
 * the budget it used to carry was measured against the wrong work.
 *
 * `requestSetAutoCompaction` has exactly one caller, at the end of
 * `spawnSubprocess`, and `pi-agent-server` answers it by constructing the entire
 * Pi session: its `handleInit` sends `ready` with `sessionId: null` and never
 * calls `ensureSession()`, so `handleSetAutoCompaction`'s own `await
 * ensureSession()` is the first construction there is. The generic 15 000 ms RPC
 * budget therefore covered the authenticated model registry, the session
 * definition, extension isolation, the `.pi-sessions` sidecar and the fork
 * preflight — and its rejection propagated out of `spawnSubprocess` and killed
 * the child. Measured three times on packaged builds (R7 2026-09-12; W19-r
 * twice, once on a fresh session's FIRST turn).
 *
 * The instrument is the one `pi-agent-live-cwd.test.ts` established for exactly
 * this class: a fake child, the private method reached through a runtime cast,
 * and `setTimeout` intercepted BY DELAY so the budget is observed rather than
 * waited out. Intercepting by delay is also what makes the positive arm
 * meaningful — a test that merely waited would pass at either number.
 */

function config(): BackendConfig {
	return {
		provider: 'pi',
		workspace: {
			id: 'ws-seed',
			name: 'Seed',
			rootPath: '/tmp/nessy-seed',
			workspaceRootPath: '/tmp/nessy-seed',
			sessionRootPath: '/tmp/nessy-seed-sessions',
		} as never,
		session: {
			id: 'session-seed',
			createdAt: 0,
			lastUsedAt: 0,
			workingDirectory: '/tmp/nessy-seed',
		} as never,
		isHeadless: true,
	};
}

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

	kill(): boolean {
		return true;
	}
}

type PiSeedRuntime = {
	requestSetAutoCompaction(
		policy: { enabled: boolean; thresholdPercent?: number },
		protocolAlreadyReady?: boolean,
	): Promise<boolean>;
	handleLine(line: string): void;
	subprocess: FakeChild | null;
	readline: FakeReadline | null;
};

/** Drives the real private method against a fake child, with the timer captured. */
async function driveSeed(
	policy: { enabled: boolean; thresholdPercent?: number },
): Promise<{
	writes: Array<Record<string, unknown>>;
	delays: number[];
	fire: () => void;
	outcome: Promise<string | boolean>;
	runtime: PiSeedRuntime;
}> {
	const agent = new PiAgent(config());
	const writes: Array<Record<string, unknown>> = [];
	const runtime = agent as never as PiSeedRuntime;
	runtime.subprocess = new FakeChild(writes);
	runtime.readline = new FakeReadline();

	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const delays: number[] = [];
	const captured = { callback: undefined as (() => void) | undefined };
	const syntheticHandle = {} as ReturnType<typeof setTimeout>;
	globalThis.setTimeout = ((callback: (...values: unknown[]) => void, delay?: number, ...args: unknown[]) => {
		// The seed is the only thing running, so every timer registered under it
		// is its own; the delay is recorded rather than matched against a number
		// this test would otherwise be asserting twice.
		if (typeof delay === 'number' && delay >= 1_000) {
			delays.push(delay);
			captured.callback = () => callback(...args);
			return syntheticHandle;
		}
		return originalSetTimeout(callback, delay, ...args);
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
		if (handle !== syntheticHandle) originalClearTimeout(handle);
	}) as typeof clearTimeout;

	try {
		const promise = runtime.requestSetAutoCompaction(policy, true);
		const outcome = promise.then(
			value => value,
			error => (error instanceof Error ? error.message : String(error)),
		);
		// Let the promise body run so the send and the timer registration happen.
		await Promise.resolve();
		return {
			writes,
			delays,
			fire: () => captured.callback?.(),
			outcome,
			runtime,
		};
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
	}
}

describe('C3.383 · the auto-compaction seed is a bring-up wait, not a toggle RPC', () => {
	it('CONTROL — the seed really is written to the subprocess, so the arms below drive the real path', async () => {
		const { writes } = await driveSeed({ enabled: true, thresholdPercent: 80 });
		const seed = writes.find(write => write.type === 'set_auto_compaction');
		expect(seed).toBeDefined();
		expect(seed).toMatchObject({ enabled: true, thresholdPercent: 80 });
		expect(typeof seed?.id).toBe('string');
	});

	it('carries the bring-up budget, not the generic 15 s RPC one', async () => {
		const { delays } = await driveSeed({ enabled: true });
		// Read the number out of the registration rather than asserting a literal
		// twice: what this row is about is that it is NOT the 15 000 ms every
		// other subprocess RPC in this file uses for a real round trip.
		expect(delays).toHaveLength(1);
		expect(delays[0]).not.toBe(15_000);
		expect(delays[0]).toBeGreaterThanOrEqual(300_000);
	});

	it('NEGATIVE — the timeout names the bring-up, and no longer reads as an auto-compaction defect', async () => {
		const { fire, outcome } = await driveSeed({ enabled: true });
		fire();
		const message = await outcome;
		expect(typeof message).toBe('string');
		// The sentence three packaged sightings were read by. It taught two lanes
		// that auto-compaction was broken when the subprocess was still building
		// its session, so its absence is the user-facing half of this row.
		expect(String(message)).not.toContain('set_auto_compaction timed out');
		expect(String(message)).toContain('did not finish building its session');
		expect(String(message)).toContain('the policy itself was already delivered');
	});

	it('BOUNDARY — a result that arrives in time still resolves with the session’s own value', async () => {
		const { writes, runtime, outcome } = await driveSeed({ enabled: true });
		const seed = writes.find(write => write.type === 'set_auto_compaction');
		runtime.handleLine(JSON.stringify({
			type: 'set_auto_compaction_result',
			id: seed?.id,
			success: true,
			// Pi's per-model resolution can disagree with what was asked for; the
			// host reports what the session holds, which is why the value is read
			// back at all.
			enabled: false,
		}));
		expect(await outcome).toBe(false);
	});
});
