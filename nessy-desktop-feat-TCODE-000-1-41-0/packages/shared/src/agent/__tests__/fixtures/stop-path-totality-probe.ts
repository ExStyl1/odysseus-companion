/**
 * P2.360 — the STOP path's totality, measured on the step that actually stops
 * something.
 *
 * P2.333 made `destroy()` total and P2.347 made `disposeForRestart()` total.
 * Both are DISPOSAL. The user's Stop is a different family — `shared/AGENTS.md`
 * separates a turn abort from a disposal by name, and that separation is the
 * reason P2.347's lane deliberately left these four alone rather than smuggling
 * them into a disposal row. What they share is only the SHAPE: a bare sequence
 * of foreign calls in which the first thrower silently cancels the rest.
 *
 * The shape matters more here than there, for two reasons the row names:
 *
 *   - FREQUENCY. `SessionManager.cancelProcessing` calls `forceAbort` by name on
 *     every user Stop. A restart is rare; this is not.
 *   - `forceAbort` IS SYNCHRONOUS. `disposeForRestart` is `async`, so its throw
 *     was only ever a rejection (P2.347 corrected its own row on exactly that
 *     point). A throwing step here really does take `cancelProcessing` down.
 *
 * WHAT EACH SCENARIO MEASURES IS THE LAST STEP, NOT THE THROW. Asserting on the
 * visible throw would pass on a "fix" that swallowed the error and still skipped
 * the work. So every scenario stands a marker in for the step whose absence is
 * the actual harm, and asserts the marker:
 *
 *   | backend | marker step            | what its absence means                |
 *   | ------- | ---------------------- | ------------------------------------- |
 *   | codex   | `turn/interrupt`       | the app-server never heard the Stop    |
 *   | nestor  | `turn.cancel()`        | a task still running ON THE SERVER —   |
 *   |         |                        | there is no close-session RPC (F23)    |
 *   | pi      | `send({type:'abort'})` | the subprocess keeps running the turn  |
 *
 * Each has a `:rebroken` twin that reduces `runTeardownStep` to a bare call —
 * the code exactly as it stood — so every assertion is a DELTA against a control
 * that must fail.
 *
 * A plain `bun` process rather than an in-runner assertion, matching
 * `floating-emission-probe.ts`: these paths detach emissions, and this is the
 * surface production has.
 *
 * Invoked as: bun <this file> <scenario>
 * Prints exactly one line: __PROBE__{"debug":[…],"thrown":[…]}
 */
import type { BackendConfig } from '../../backend/types.ts';
import { AbortReason } from '../../backend/types.ts';
import { ClaudeAgent } from '../../claude-agent.ts';
import { CodexAgent } from '../../codex-agent.ts';
import { NestorCloudAgent } from '../../nestor-cloud-agent.ts';
import { PiAgent } from '../../pi-agent.ts';
import { createMockBackendConfig } from '../test-utils.ts';

const debug: string[] = [];
const thrown: string[] = [];

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
}

function wire(agent: object): void {
  (agent as { onDebug?: (m: string) => void }).onDebug = (message: string) => { debug.push(message); };
}

/**
 * Reduce `runTeardownStep` to a bare call — the pre-fix shape, restored in
 * place. Every `:rebroken` twin uses it and every one of them must still fail.
 */
function rebreakTeardownStep(agent: object): void {
  (agent as { runTeardownStep: unknown }).runTeardownStep =
    (_what: string, step: () => void): void => { step(); };
}

/** Run a SYNCHRONOUS `forceAbort` and record a throw instead of dying on it. */
function forceAbortRecordingThrow(agent: { forceAbort(reason: AbortReason): void }): void {
  try {
    agent.forceAbort(AbortReason.UserStop);
  } catch (error) {
    thrown.push(error instanceof Error ? error.message : String(error));
  }
}

/** The `async` sibling: the same throw arrives as a rejection. */
async function abortRecordingThrow(agent: { abort(reason?: string): Promise<void> }): Promise<void> {
  try {
    await agent.abort('probe');
  } catch (error) {
    thrown.push(error instanceof Error ? error.message : String(error));
  }
}

function codexConfig(): BackendConfig {
  return {
    ...createMockBackendConfig(),
    provider: 'codex-runtime',
    model: 'codex/test-model',
    isHeadless: true,
  } as BackendConfig;
}

/**
 * A codex agent whose Stop has somewhere real to go.
 *
 * The interrupt is the marker because it is the ONLY thing on this path that
 * stops the codex turn — P2.303 measured that a Stop which fails to send it
 * "interrupted nothing". `denyPendingApprovals` is the thrower because it is the
 * first statement after the latch and it ends in FOREIGN resolvers on a shared
 * elicitation pool, so it is a reachable failure rather than a contrived one.
 */
function buildCodex(): CodexAgent {
  const agent = new CodexAgent(codexConfig());
  wire(agent);
  (agent as unknown as { denyPendingApprovals: unknown }).denyPendingApprovals =
    (): never => { throw new Error('pending approvals settle exploded'); };
  (agent as unknown as { client: unknown }).client = {
    request: async (method: string): Promise<void> => {
      if (method === 'turn/interrupt') debug.push('CODEX TURN INTERRUPTED');
    },
  };
  (agent as unknown as { threadId: string }).threadId = 'probe-thread';
  (agent as unknown as { activeTurnId: string }).activeTurnId = 'probe-turn';
  return agent;
}

/**
 * A nestor agent with a live remote turn.
 *
 * The thrower is the abort controller — a foreign object whose listeners are
 * not ours — and the marker is the remote cancel, which on this backend is the
 * entire stop mechanism: no server-side close-session RPC exists (F23), so a
 * skipped cancel leaves a task running on the server with nobody left to hear
 * about it.
 */
function buildNestor(): NestorCloudAgent {
  const agent = new NestorCloudAgent(createMockBackendConfig());
  wire(agent);
  (agent as unknown as { abortController: unknown }).abortController =
    { abort: (): never => { throw new Error('abort controller exploded'); } };
  (agent as unknown as { currentTurn: unknown }).currentTurn = {
    cancel: async (): Promise<void> => { debug.push('NESTOR REMOTE TASK CANCELLED'); },
  };
  return agent;
}

/**
 * A pi agent whose subprocess abort is observable.
 *
 * `abortPreModelWork` is the first statement of both stop methods, so a throw
 * there is the widest possible skip; `send` is the marker because
 * `send({ type: 'abort' })` is what actually tells the Pi child to stop — and on
 * `forceAbort` it is the LAST statement, the same position that made
 * `killSubprocessGracefully` the expensive casualty in P2.361.
 */
function buildPi(): PiAgent {
  const agent = new PiAgent(createMockBackendConfig());
  wire(agent);
  (agent as unknown as { abortPreModelWork: unknown }).abortPreModelWork =
    (): never => { throw new Error('pre-model abort exploded'); };
  (agent as unknown as { send: unknown }).send = (cmd: { type: string }): void => {
    if (cmd.type === 'abort') debug.push('PI SUBPROCESS ABORT SENT');
  };
  return agent;
}

/**
 * P2.362's surviving entry point, driven end-to-end.
 *
 * `ClaudeAgent.abort()` is the one the row wanted deleted and could not be: it
 * is a REQUIRED member of `AgentBackend` and `abstract` on `BaseAgent`. Its
 * sibling `close()` — dead, on no interface, zero callers — was deleted instead.
 * So what is left to prove is the other half of the row's worry: that this entry
 * point is not "pre-wired to reintroduce the defect".
 *
 * It enters `killLiveSession` -> `cancelTurnScopedUi` + `endLiveSession`, both
 * belted by P2.347. The thrower is the model-question cancel (the first foreign
 * call on that path) and the marker is `orphaned.fail(...)`, the LAST step and
 * the only thing that settles a turn slot `chatImpl` is blocked on — so its
 * absence is a HANG, not a leak.
 */
function buildClaude(): ClaudeAgent {
  const agent = new ClaudeAgent(createMockBackendConfig());
  wire(agent);
  (agent as unknown as { modelQuestionAsk: unknown }).modelQuestionAsk =
    { cancelAll: (): never => { throw new Error('model question cancel exploded'); } };
  (agent as unknown as { openSlot: unknown }).openSlot = {
    settled: false,
    fail: (): void => { debug.push('CLAUDE TURN SLOT FAILED'); },
  };
  return agent;
}

const SCENARIOS: Record<string, () => Promise<void>> = {
  async 'claude:abort:stepThrows'() {
    await abortRecordingThrow(buildClaude());
    await settle();
  },
  async 'claude:abort:stepThrows:rebroken'() {
    const agent = buildClaude();
    rebreakTeardownStep(agent);
    await abortRecordingThrow(agent);
    await settle();
  },

  async 'codex:forceAbort:stepThrows'() {
    forceAbortRecordingThrow(buildCodex());
    await settle();
  },
  async 'codex:forceAbort:stepThrows:rebroken'() {
    const agent = buildCodex();
    rebreakTeardownStep(agent);
    forceAbortRecordingThrow(agent);
    await settle();
  },
  async 'codex:abort:stepThrows'() {
    await abortRecordingThrow(buildCodex());
    await settle();
  },
  async 'codex:abort:stepThrows:rebroken'() {
    const agent = buildCodex();
    rebreakTeardownStep(agent);
    await abortRecordingThrow(agent);
    await settle();
  },

  async 'nestor:forceAbort:stepThrows'() {
    forceAbortRecordingThrow(buildNestor());
    await settle();
  },
  async 'nestor:forceAbort:stepThrows:rebroken'() {
    const agent = buildNestor();
    rebreakTeardownStep(agent);
    forceAbortRecordingThrow(agent);
    await settle();
  },
  async 'nestor:abort:stepThrows'() {
    await abortRecordingThrow(buildNestor());
    await settle();
  },
  async 'nestor:abort:stepThrows:rebroken'() {
    const agent = buildNestor();
    rebreakTeardownStep(agent);
    await abortRecordingThrow(agent);
    await settle();
  },

  async 'pi:forceAbort:stepThrows'() {
    forceAbortRecordingThrow(buildPi());
    await settle();
  },
  async 'pi:forceAbort:stepThrows:rebroken'() {
    const agent = buildPi();
    rebreakTeardownStep(agent);
    forceAbortRecordingThrow(agent);
    await settle();
  },
  async 'pi:abort:stepThrows'() {
    await abortRecordingThrow(buildPi());
    await settle();
  },
  async 'pi:abort:stepThrows:rebroken'() {
    const agent = buildPi();
    rebreakTeardownStep(agent);
    await abortRecordingThrow(agent);
    await settle();
  },
};

const scenario = process.argv[2] ?? '';
const run = SCENARIOS[scenario];
if (!run) {
  console.log(`__PROBE__${JSON.stringify({ error: `unknown scenario ${scenario}`, known: Object.keys(SCENARIOS) })}`);
  process.exit(2);
}
/**
 * A WATCHDOG for the same reason `floating-emission-probe.ts` has one: some of
 * these paths await a runtime that does not exist in a probe, and a detector
 * that hangs is a detector people stop running.
 */
const WATCHDOG_MS = Number(process.env.PROBE_WATCHDOG_MS ?? 5000);
let timedOut = false;
await Promise.race([
  run().then(() => settle()),
  new Promise<void>(resolve => setTimeout(() => { timedOut = true; resolve(); }, WATCHDOG_MS)),
]);
console.log(`__PROBE__${JSON.stringify({ debug, thrown, ...(timedOut ? { timedOut: true } : {}) })}`);
process.exit(0);
