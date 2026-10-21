/**
 * The grandchild-marker proof for the UNSUPERVISED stdio path (DA3.1).
 *
 * The supervised path has had one since `feba3c424`
 * (`packages/server-core/src/pi-harness/process-supervisor.test.ts` case
 * "keeps scratch outside the workspace and kills descendant trees on timeout"),
 * and that is exactly why this file exists: the coverage rig that measures
 * process-tree termination drives BASH children, which are supervised and
 * group-killed, so it comes back green while the MCP path leaks. Every case
 * here drives a REAL process tree.
 *
 * **Each shape is run through BOTH transports.** The vendored SDK's
 * `StdioClientTransport` is the NEGATIVE CONTROL, and it is not decoration: a
 * teardown test whose two arms cannot disagree is the default-flip trap this
 * repo has already paid for. The control arm asserts the marker IS written —
 * i.e. that the leak is real on the transport this branch used to take — so a
 * change that silently stopped killing the group turns the fix arms red instead
 * of leaving them vacuously green.
 *
 * **That negative control does NOT price the fix arms' own window, and saying
 * so is DA3.13.** It runs through the other transport, whose close ladder waits
 * on the PIPES, so its window is wider than the arm it defends — the two are
 * the same shape and never the same clock. The window each fix arm actually
 * sleeps is priced on the transport under test, by the POSITIVE CONTROL that
 * holds the same wrapper open without tearing it down and asserts the marker IS
 * there.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManagedStdioTransport } from '../managed-stdio-transport.ts';

// Real spawns plus two deliberate waits per case. The budget belongs to the
// FILE, sized against the slowest shape, not to a single body.
setDefaultTimeout(60_000);

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function markerRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'nessy-mcp-stdio-teardown-'));
  roots.push(root);
  return root;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A wrapper command that forks a descendant which writes a marker after
 * `markerDelayMs`, exactly like an `npx`/`uvx`/`pipx` shim forking the real
 * server. `leader: 'exits'` drains stdin and ends with it (the wrapper is gone
 * before teardown escalates); `leader: 'stays'` waits (the wrapper is alive and
 * is the process a direct-child kill reaches).
 */
function wrapperArgs(marker: string, markerDelayMs: number, leader: 'exits' | 'stays'): string[] {
  const descendant = `(sleep ${(markerDelayMs / 1000).toFixed(2)}; printf leaked > ${JSON.stringify(marker)}) &`;
  return ['-lc', `${descendant} ${leader === 'exits' ? 'cat > /dev/null' : 'wait'}`];
}

async function driveTeardown(
  transport: Transport,
  settleMs: number,
): Promise<void> {
  await transport.start();
  await transport.close();
  await sleep(settleMs);
}

describe('unsupervised stdio teardown', () => {
  // POSIX only: the Windows arm kills the tree with `taskkill /T` and cannot be
  // driven from this rig. Recorded as a residue rather than faked with a stub,
  // which would assert our own mock rather than the OS.
  const posix = process.platform !== 'win32';

  test.if(posix)('kills a descendant the wrapper left behind after exiting', async () => {
    // The wrapper is GONE by the time teardown escalates, so the SDK never
    // signals anything at all. Group teardown still reaches the descendant,
    // because the group outlives its leader while any member is alive.
    //
    // The control arm below also pins the SECOND half of the SDK's blindness on
    // this shape, measured 2026-09-14: its ladder waits for `close`, which is
    // the PIPES, and the descendant inherits stdout — so `close` does not
    // arrive until the descendant is finished, which is after the marker.
    const root = markerRoot();
    const managedMarker = join(root, 'managed-leader-exits');
    const sdkMarker = join(root, 'sdk-leader-exits');

    await driveTeardown(createManagedStdioTransport({
      command: '/bin/sh',
      args: wrapperArgs(managedMarker, 1_200, 'exits'),
      stderr: 'ignore',
    }), 1_800);
    expect(existsSync(managedMarker)).toBe(false);

    // NEGATIVE CONTROL on the same shape and DELIBERATELY NOT on the same
    // clock — which is the whole reason this arm is the negative one. The SDK's
    // `close()` waits for the PIPES, so its window is its own close (~1.2 s on
    // this shape) plus this settle, where the managed arm's is ~15 ms plus the
    // same settle. What this control proves is that the leak is real on the
    // transport this branch used to take; what proves the managed arm's own
    // window is long enough is the positive control below, on the transport
    // under test.
    await driveTeardown(new StdioClientTransport({
      command: '/bin/sh',
      args: wrapperArgs(sdkMarker, 1_200, 'exits'),
      stderr: 'ignore',
    }), 1_800);
    expect(existsSync(sdkMarker)).toBe(true);
  });

  test.if(posix)('kills a descendant of a wrapper that is still running', async () => {
    // The classic shape the row names: the wrapper ignores stdin close, so the
    // close ladder escalates. `SIGTERM` reaches the whole group here and only
    // the wrapper on the SDK transport — the marker delay sits past the 2 s
    // graceful step on purpose, so both arms escalate before it fires.
    const root = markerRoot();
    const managedMarker = join(root, 'managed-leader-stays');
    const sdkMarker = join(root, 'sdk-leader-stays');

    await driveTeardown(createManagedStdioTransport({
      command: '/bin/sh',
      args: wrapperArgs(managedMarker, 2_600, 'stays'),
      stderr: 'ignore',
    }), 1_200);
    expect(existsSync(managedMarker)).toBe(false);

    // NEGATIVE CONTROL on the same shape and, again, NOT on the same clock: on
    // this shape BOTH transports spend a full graceful step before escalating,
    // and only the managed one then reaches the whole group. The positive
    // control below prices the managed arm's own window.
    await driveTeardown(new StdioClientTransport({
      command: '/bin/sh',
      args: wrapperArgs(sdkMarker, 2_600, 'stays'),
      stderr: 'ignore',
    }), 1_200);
    expect(existsSync(sdkMarker)).toBe(true);
  });

  test.if(posix)('POSITIVE CONTROL: on the managed transport itself, each fix arm sleeps past its own descendant', async () => {
    // The two arms above assert an ABSENCE, and until this case the only thing
    // saying their window was wide enough was a control spawned through the
    // OTHER transport, whose window is its own. So the slack was unpriced on
    // the transport under test — and an absence measured through a window
    // nothing has priced is the vacuum an absence probe exists to avoid. Here
    // the SAME transport runs the SAME wrapper and is NOT torn down: what the
    // marker does inside that window is what the fix arm would have met had the
    // group kill not landed.
    const root = markerRoot();

    // Fix arm 1's shape and its exact settle. The wrapper ends with stdin, so
    // its `close()` costs ~15 ms and the window it defends IS the settle.
    const exitsMarker = join(root, 'held-leader-exits');
    const exits = createManagedStdioTransport({
      command: '/bin/sh',
      args: wrapperArgs(exitsMarker, 1_200, 'exits'),
      stderr: 'ignore',
    });
    await exits.start();
    await sleep(1_800);
    expect(existsSync(exitsMarker)).toBe(true);
    await exits.close();

    // Fix arm 2's shape — and its window is NOT the settle alone, which is why
    // the number here is not 1_200. That wrapper ignores stdin close, so
    // `waitForExit` spends the whole graceful step (`CLOSE_STEP_MS` = 2_000 in
    // `managed-stdio-transport.ts`) before the group kill, and only then does
    // the arm sleep its 1_200. 3_200 is that arm's real clock, stated rather
    // than copied, because copying the literal would have priced the wrong
    // window and looked right.
    const staysMarker = join(root, 'held-leader-stays');
    const stays = createManagedStdioTransport({
      command: '/bin/sh',
      args: wrapperArgs(staysMarker, 2_600, 'stays'),
      stderr: 'ignore',
    });
    await stays.start();
    await sleep(3_200);
    expect(existsSync(staysMarker)).toBe(true);
    await stays.close();
  });

  test.if(posix)('reaps an ordinary childless server and keeps the SDK stderr contract', async () => {
    // The boundary: detaching must not change what teardown does to a plain
    // server with no descendants, and the `stderr: 'pipe'` PassThrough must
    // still exist BEFORE start() — the validator attaches its idle watchdog to
    // it there, and losing that would silently disarm the cold-install timer.
    const transport = createManagedStdioTransport({
      command: '/bin/sh',
      args: ['-lc', 'cat > /dev/null'],
      stderr: 'pipe',
    });
    expect(transport.stderr).not.toBeNull();

    await transport.start();
    const pid = transport.pid;
    expect(pid).not.toBeNull();
    await transport.close();
    await sleep(200);

    let alive = true;
    try { process.kill(pid!, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  });
});
