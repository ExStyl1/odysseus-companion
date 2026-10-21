/**
 * P2.360 / P2.361 / P2.362 — the Stop path, the restart path, and the two
 * entry points that led into them.
 *
 * ONE CAUSAL CHAIN, THREE DIFFERENT KINDS OF EVIDENCE, and they are deliberately
 * not merged:
 *
 *   - P2.361 is an OS-LEVEL claim ("the restart orphans the Pi child"), so it is
 *     measured against a real process — a pid that is still alive afterwards.
 *     `fixtures/subprocess-orphan-probe.ts`.
 *   - P2.360 is a CONTROL-FLOW claim ("the step that stops the runtime is
 *     skipped"), so it is measured by standing a marker in for that step.
 *     `fixtures/stop-path-totality-probe.ts`.
 *   - P2.362 is a REACHABILITY claim, so it is pinned statically here.
 *
 * WHY BOTH PROBES RUN IN PLAIN `bun` PROCESSES, and not as assertions in this
 * file: the same reason `floating-emission-escape.test.ts` gives — the runner
 * intercepts below `process` and these paths detach emissions — plus, for the
 * orphan probe, that an assertion about child processes should not share a
 * process with a runner that manages its own.
 *
 * EVERY ASSERTION HERE IS A DELTA. Each scenario has a `:rebroken` twin that
 * restores the pre-fix shape IN PLACE (`runTeardownStep` reduced to a bare
 * call), and the twin must fail the same assertion. A guard that cannot be shown
 * to fail is not a guard.
 */
import { describe, expect, it } from 'bun:test';
import { ClaudeAgent } from '../claude-agent.ts';

interface StopProbeResult {
  debug: string[];
  thrown: string[];
  timedOut?: boolean;
}

interface OrphanProbeResult {
  alive: boolean | null;
  rssKib: number | null;
  rssBeforeKib: number | null;
  thrown: string[];
  debug: string[];
  guard: string[];
}

const STOP_PROBE_URL = new URL('./fixtures/stop-path-totality-probe.ts', import.meta.url);
const ORPHAN_PROBE_URL = new URL('./fixtures/subprocess-orphan-probe.ts', import.meta.url);

/**
 * Run one scenario in a plain `bun` process and read its single result line.
 *
 * Sequential by construction — every caller awaits. Electron does not inherit
 * the shell's `ulimit -n` and this repo's floor is 256, so a fan-out of probe
 * children is exactly the shape that passes here and fails in the app.
 */
async function probe<T>(url: URL, scenario: string): Promise<T> {
  const child = Bun.spawn({
    cmd: [process.execPath, 'run', Bun.fileURLToPath(url), scenario],
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, PROBE_WATCHDOG_MS: '4000' },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  const line = stdout.split('\n').find(entry => entry.startsWith('__PROBE__'));
  if (!line) {
    throw new Error(`probe ${scenario} produced no result line.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return JSON.parse(line.slice('__PROBE__'.length)) as T;
}

const stopProbe = (scenario: string): Promise<StopProbeResult> => probe<StopProbeResult>(STOP_PROBE_URL, scenario);
const orphanProbe = (scenario: string): Promise<OrphanProbeResult> => probe<OrphanProbeResult>(ORPHAN_PROBE_URL, scenario);

/**
 * The step whose absence IS the defect, per backend. Naming the marker rather
 * than a line number: three of P2.303's six site line numbers were already wrong
 * when that row ran, and the scenario name is the durable identifier.
 */
const STOP_SITES: Array<{ scenario: string; marker: string; skipped: string }> = [
  { scenario: 'codex:forceAbort', marker: 'CODEX TURN INTERRUPTED', skipped: 'the app-server never heard the Stop' },
  { scenario: 'codex:abort', marker: 'CODEX TURN INTERRUPTED', skipped: 'the app-server never heard the abort' },
  { scenario: 'nestor:forceAbort', marker: 'NESTOR REMOTE TASK CANCELLED', skipped: 'a task left running on the server (F23)' },
  { scenario: 'nestor:abort', marker: 'NESTOR REMOTE TASK CANCELLED', skipped: 'a task left running on the server (F23)' },
  { scenario: 'pi:forceAbort', marker: 'PI SUBPROCESS ABORT SENT', skipped: 'the subprocess keeps running the stopped turn' },
  { scenario: 'pi:abort', marker: 'PI SUBPROCESS ABORT SENT', skipped: 'the subprocess keeps running the stopped turn' },
  { scenario: 'claude:abort', marker: 'CLAUDE TURN SLOT FAILED', skipped: 'a turn slot nothing will ever settle — a hang' },
];

describe('P2.360 — the Stop path is total', () => {
  for (const site of STOP_SITES) {
    it(`${site.scenario}: a throwing step no longer skips the one that matters (${site.skipped})`, async () => {
      const fixed = await stopProbe(`${site.scenario}:stepThrows`);
      // The marker proves the LATE step ran. Asserting only on the absent throw
      // would pass on a fix that swallowed the error and still skipped the work.
      expect(fixed.debug).toContain(site.marker);
      expect(fixed.thrown).toEqual([]);

      // THE CONTROL THAT MUST FAIL: the pre-fix shape restored in place.
      const rebroken = await stopProbe(`${site.scenario}:stepThrows:rebroken`);
      expect(rebroken.debug).not.toContain(site.marker);
      expect(rebroken.thrown.length).toBe(1);
    }, 180_000);
  }
});

describe('P2.361 — the restart path no longer orphans the Pi subprocess', () => {
  it('POSITIVE CONTROL: the probe refuses to signal a pid it did not spawn', async () => {
    // A probe that reaps processes on a machine running the user's editors and
    // other lanes' test runners must not be able to reach one it did not create.
    const result = await orphanProbe('probe-guard');
    expect(result.guard[0]).toContain('refusing to probe pid <foreign>');
    expect(result.guard[1]).toContain('allowed');
  }, 180_000);

  it('a real child process is still reaped when a prologue step throws', async () => {
    const fixed = await orphanProbe('pi:disposeForRestart:childReaped');
    // `rssBeforeKib` is the positive control on the reading itself: `ps` DID
    // report a resident process a moment earlier, so `alive: false` below is an
    // exit and not a broken measurement.
    expect(fixed.rssBeforeKib).toBeGreaterThan(0);
    expect(fixed.alive).toBe(false);
    expect(fixed.debug.some(line => line.includes('stopped for restart'))).toBe(true);
  }, 180_000);

  it('THE CONTROL THAT MUST FAIL: with the belt removed the child survives', async () => {
    const rebroken = await orphanProbe('pi:disposeForRestart:childReaped:rebroken');
    expect(rebroken.rssBeforeKib).toBeGreaterThan(0);
    // The whole finding in one reading: the process is STILL THERE, holding its
    // resident memory, after the method that exists to kill it has returned.
    expect(rebroken.alive).toBe(true);
    expect(rebroken.rssKib).toBeGreaterThan(0);
    expect(rebroken.thrown).toEqual(['config watcher close exploded']);
  }, 180_000);
});

describe('P2.362 — the two entry points', () => {
  it('close() is gone, and abort() could not be', () => {
    // `close()` was dead surface: on no interface, the only `close()` on any of
    // the four backends, and with zero callers of any kind. Pinned so it is not
    // quietly reintroduced — a plausible-looking public method that means
    // SESSION DEATH is exactly what invites a wrong call.
    expect(Reflect.has(ClaudeAgent.prototype, 'close')).toBe(false);

    // POSITIVE CONTROL for that assertion: the same check on the members that
    // ARE there. Without this, `Reflect.has` returning false would be
    // indistinguishable from a mistyped name.
    expect(Reflect.has(ClaudeAgent.prototype, 'abort')).toBe(true);
    expect(Reflect.has(ClaudeAgent.prototype, 'forceAbort')).toBe(true);

    // And why `abort()` stayed: it is a REQUIRED member of `AgentBackend` and
    // `abstract` on `BaseAgent`, so deleting it would not remove a dead method —
    // it would fail to implement an abstract one. The row proposed deleting both.
    expect(typeof ClaudeAgent.prototype.abort).toBe('function');
  });
});
