/**
 * P2.361 — a leak detector that measures a REAL process, not a code shape.
 *
 * WHY THIS FILE IS A SUBPROCESS AND NOT A TEST, and why it spawns a second one.
 *
 * The claim under test is "`PiAgent.disposeForRestart` orphans the Pi child".
 * That is a statement about an operating-system resource, and the only honest
 * evidence for it is an OS reading: a pid that is still there afterwards. A
 * spy on `killSubprocessGracefully` would prove the call was skipped, which is
 * the CODE SHAPE, and every previous row in this family has found the shape and
 * the consequence disagreeing at least once — `disposeForRestart` looked like it
 * took its caller down and does not (P2.347's own correction).
 *
 * So this probe:
 *   1. spawns a real, harmless stand-in child and RECORDS ITS PID,
 *   2. hands it to a `PiAgent` as `this.subprocess`,
 *   3. makes one prologue step of `disposeForRestart` throw,
 *   4. asks the OS whether that pid is still alive when the dust settles,
 *   5. reaps its own child unconditionally.
 *
 * A plain `bun` process rather than the test runner, for the same reason
 * `floating-emission-probe.ts` is one: this is the surface production has
 * (Electron main, the headless server), and the runner's own child handling is
 * not something an OS-level assertion should have to share a process with.
 *
 * THE STAND-IN IS `sleep`, DELIBERATELY.
 *   - It is spawned by BARE COMMAND NAME through PATH, so no string this file
 *     executes names a home directory or a filesystem root in any form.
 *   - It exits on SIGTERM, which is the exact signal
 *     `terminateCapturedSubprocess` sends first, so the graceful arm of the real
 *     termination sequence is the one being exercised rather than the SIGKILL
 *     fallback.
 *   - Its RSS is a megabyte, not the Pi runtime's. That is a deliberate limit of
 *     this rig and it is stated rather than hidden: what is measured here is
 *     SURVIVAL — whether the process is still there — and survival is the whole
 *     of the defect. How expensive the survivor is, is a property of what Pi
 *     loads, not of this teardown.
 *
 * THE PID GUARD IS THE POINT OF THE `OWNED` SET. A probe that reaps processes
 * must never be able to reach one it did not create: this machine runs the
 * user's own editors and other lanes' test runners. Every signalling helper
 * below refuses a pid that is not in `OWNED`, including the liveness check,
 * which signals 0. `probe-guard` is the scenario that proves the refusal fires.
 *
 * Invoked as: bun <this file> <scenario>
 * Prints exactly one line: __PROBE__{"alive":…,"rssKib":…,"thrown":[…],…}
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { PiAgent } from '../../pi-agent.ts';
import { createMockBackendConfig } from '../test-utils.ts';

const debug: string[] = [];
const thrown: string[] = [];
const guard: string[] = [];

/** Every pid this probe itself spawned. Nothing else may ever be signalled. */
const OWNED = new Set<number>();

function assertOwned(pid: number, what: string): void {
  if (!OWNED.has(pid)) {
    throw new Error(`refusing to ${what} pid ${pid}: this probe did not spawn it`);
  }
}

/**
 * A harmless stand-in for the Pi child. `sleep` resolved through PATH — the
 * executed string is a bare command name and carries no path of any kind.
 */
function spawnStandIn(): ChildProcess {
  const child = spawn('sleep', ['600'], { stdio: ['pipe', 'pipe', 'pipe'] });
  if (typeof child.pid === 'number') OWNED.add(child.pid);
  return child;
}

/** Signal 0: existence only, and still refused for a pid we do not own. */
function isAlive(pid: number): boolean {
  assertOwned(pid, 'probe');
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resident set size in KiB, or null once the process is gone. */
function rssKib(pid: number): number | null {
  assertOwned(pid, 'measure');
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return out ? Number(out) : null;
  } catch {
    return null;
  }
}

function reap(pid: number): void {
  assertOwned(pid, 'reap');
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone — the outcome this probe wants anyway */
  }
}

/** Let the termination sequence's own waits finish without sleeping on a clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 80; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
}

function wire(agent: object): void {
  (agent as { onDebug?: (m: string) => void }).onDebug = (message: string) => { debug.push(message); };
}

/**
 * Reduce `runTeardownStep` to a bare call — the pre-fix shape, restored in
 * place. This is what makes the assertion a DELTA rather than a hope.
 */
function rebreakTeardownStep(agent: object): void {
  (agent as { runTeardownStep: unknown }).runTeardownStep =
    (_what: string, step: () => void): void => { step(); };
}

/**
 * Build the agent, give it a real child, and arm the thrower.
 *
 * `stopConfigWatcher` is the thrower because it is the SECOND statement of
 * `disposeForRestart` — early enough that everything after it is skipped, and a
 * genuinely reachable failure rather than a contrived one (it is a foreign
 * watcher handle).
 */
function buildAgentWithChild(): { agent: PiAgent; child: ChildProcess; pid: number } {
  const agent = new PiAgent(createMockBackendConfig());
  wire(agent);
  const child = spawnStandIn();
  const pid = child.pid;
  if (typeof pid !== 'number') throw new Error('stand-in child reported no pid');
  (agent as unknown as { subprocess: ChildProcess | null }).subprocess = child;
  (agent as unknown as { stopConfigWatcher: unknown }).stopConfigWatcher =
    (): never => { throw new Error('config watcher close exploded'); };
  return { agent, child, pid };
}

async function runDisposal(agent: PiAgent): Promise<void> {
  try {
    await agent.disposeForRestart();
  } catch (error) {
    thrown.push(error instanceof Error ? error.message : String(error));
  }
}

interface Result {
  /** The reading that is the whole finding: was the child still there? */
  alive: boolean | null;
  rssKib: number | null;
  /** RSS while the child was definitely alive — the positive control on `ps`. */
  rssBeforeKib: number | null;
  thrown: string[];
  debug: string[];
  guard: string[];
}

const SCENARIOS: Record<string, () => Promise<Result>> = {
  /**
   * The fix, measured: a prologue throw is isolated, so
   * `killSubprocessGracefully()` — the LAST statement — still runs and the child
   * is gone.
   */
  async 'pi:disposeForRestart:childReaped'() {
    const { agent, pid } = buildAgentWithChild();
    const rssBeforeKib = rssKib(pid);
    await runDisposal(agent);
    await settle();
    const alive = isAlive(pid);
    const rss = rssKib(pid);
    reap(pid);
    return { alive, rssKib: rss, rssBeforeKib, thrown, debug, guard };
  },

  /**
   * THE CONTROL THAT MUST FAIL: the pre-fix shape restored in place. With
   * `runTeardownStep` reduced to a bare call, the throwing `stopConfigWatcher`
   * skips every remaining statement — the kill among them — and the child is
   * STILL ALIVE when this reads it.
   */
  async 'pi:disposeForRestart:childReaped:rebroken'() {
    const { agent, pid } = buildAgentWithChild();
    const rssBeforeKib = rssKib(pid);
    rebreakTeardownStep(agent);
    await runDisposal(agent);
    await settle();
    const alive = isAlive(pid);
    const rss = rssKib(pid);
    reap(pid);
    return { alive, rssKib: rss, rssBeforeKib, thrown, debug, guard };
  },

  /**
   * The guard's own self-test, because a safety rail nobody exercises is a
   * comment. Ask about a pid this probe did not spawn — its own parent — and the
   * refusal must fire instead of a signal going out.
   */
  async 'probe-guard'() {
    const foreign = process.ppid;
    try {
      isAlive(foreign);
      guard.push('GUARD DID NOT FIRE');
    } catch (error) {
      guard.push(error instanceof Error ? error.message.replace(String(foreign), '<foreign>') : String(error));
    }
    // And the positive control on the same rail: a pid we DID spawn is allowed.
    const child = spawnStandIn();
    const pid = child.pid ?? 0;
    guard.push(`owned pid probe: ${isAlive(pid) ? 'allowed' : 'allowed-but-dead'}`);
    reap(pid);
    return { alive: null, rssKib: null, rssBeforeKib: null, thrown, debug, guard };
  },
};

const scenario = process.argv[2] ?? '';
const run = SCENARIOS[scenario];
if (!run) {
  console.log(`__PROBE__${JSON.stringify({ error: `unknown scenario ${scenario}`, known: Object.keys(SCENARIOS) })}`);
  process.exit(2);
}
const result = await run();
console.log(`__PROBE__${JSON.stringify(result)}`);
// Belt and braces: nothing this probe spawned may outlive it, whatever the
// scenario did. Only pids in OWNED are reachable from here by construction.
for (const pid of OWNED) reap(pid);
process.exit(0);
