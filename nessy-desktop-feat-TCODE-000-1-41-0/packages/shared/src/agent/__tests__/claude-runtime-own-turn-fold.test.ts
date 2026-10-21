/**
 * F1.528 (origin the 1.41.0 review, finding C-claude-runtime-2) — F1.509's `runtimeOwnTurn` must settle when the
 * turn the child opened ITSELF ends inside a HOST slot, and it must never wait forever.
 *
 * ## The defect, measured before this row (vendored `claude` 2.1.251, driven through `ClaudeAgent`, WJ-ar's rig)
 *
 * F1.509 marks a slot-less `system/init` as the child's own turn and settled it ONLY on a `result` that arrived with
 * no slot open. `SessionManager.sendMessage` reads the marker once, before the long turn preparation — so a send that
 * read `null` can open its slot AFTER the child's own `init` and write into the live input mid-turn. The rig did
 * exactly that (`work/wjar/probe-f1528.test.ts`, ungated host write 400 ms after the own turn's slot-less `init`):
 *
 * - **The CLI FOLDS the write when its own turn has a tool boundary left.** The own turn's second request carried
 *   the host's text as a system-reminder beside the tool result ("… rather than as a separate conversation turn"),
 *   ONE `result` arrived, and it landed in the host's slot. `runtimeOwnTurnSettled()` was still a pending promise
 *   11 s later — and no slot-less `result` would ever come, so every later send queued behind it and nothing replayed.
 * - **With no boundary left it does not fold** (the plain arm): the own turn's reply landed in the host slot, the
 *   host's text ran as the child's next turn with no slot open, and THAT turn's slot-less `result` settled the
 *   marker. That arm is the CONTROL below: it passes before and after.
 *
 * ## What this file pins
 *
 * (a) A `result` ends the turn the child was running WHEREVER it is routed, so the fold leaves the marker `null`.
 * (b) The marker is bounded: a pending own turn that never reports its end settles itself after a bound, and says so
 *     on the notice channel. (c) CONTROL: the no-fold shape, and an own turn that ends normally queues no notice.
 *
 * The rig is `claude-runtime-own-turn.test.ts`'s: the SDK's `query` is faked, everything under it is the real
 * `ClaudeAgent` reader, adapter and slot.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, setDefaultTimeout } from 'bun:test';
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';

// Importing `claude-agent.ts` is this file's wall-clock cost; the cases are milliseconds (AGENTS.md: size the budget
// against the FILE, not the case).
setDefaultTimeout(120_000);

const realSdk = { ...sdkPackage };

const scripts: Array<() => AsyncGenerator<unknown>> = [];

function resultMessage(text = 'ok'): unknown {
  return {
    type: 'result',
    subtype: 'success',
    result: text,
    num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

async function* plainSuccess(): AsyncGenerator<unknown> {
  yield resultMessage();
}

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    async function* serveTurns(): AsyncGenerator<unknown> {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        const script = scripts.shift() ?? plainSuccess;
        yield* script();
      }
    }
    const stream = serveTurns() as AsyncGenerator<unknown> & { interrupt(): Promise<unknown> };
    stream.interrupt = async () => ({ still_queued: [] });
    return stream;
  },
}));

afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk);
});

const { ClaudeAgent } = await import('../claude-agent.ts');

const WORKSPACE_ROOT = '/tmp/nessy-f1-528';

function agentConfig(sessionId: string): BackendConfig {
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-f1-528',
      name: 'F1.528',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: { id: sessionId, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: WORKSPACE_ROOT } as never,
    onBetweenTurnsEvent: () => {},
  } as BackendConfig;
}

type OwnTurnAgent = InstanceType<typeof ClaudeAgent> & { runtimeOwnTurnSettled?: () => Promise<void> | null };

interface Internals {
  pendingDegradationNotices: string[];
  runtimeOwnTurnBoundMs?: number;
}

/** The CLI's own turn up to its tool call, as the rig's `route` log showed it (init, status, a tool_use). */
const ownTurnHead: unknown[] = [
  { type: 'system', subtype: 'init', session_id: 'sdk-f1-528', uuid: 'u-own-init' },
  { type: 'system', subtype: 'status', status: 'requesting', session_id: 'sdk-f1-528', uuid: 'u-own-status' },
  {
    type: 'assistant', parent_tool_use_id: null, session_id: 'sdk-f1-528', uuid: 'a-own-tool',
    message: {
      id: 'msg_own_tool', role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_f1528_own_read', name: 'Read', input: { file_path: '/tmp/nessy-f1-528/note.txt' } }],
    },
  },
];

/** The rest of the own turn once the host's text was folded into it: the tool result, the reply, ONE result. */
const foldedTail: unknown[] = [
  {
    type: 'user', parent_tool_use_id: null, session_id: 'sdk-f1-528', uuid: 'u-own-tool-result',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_f1528_own_read', content: 'F1528 note line' }] },
  },
  {
    type: 'assistant', parent_tool_use_id: null, session_id: 'sdk-f1-528', uuid: 'a-own-folded',
    message: { id: 'msg_own_folded', role: 'assistant', content: [{ type: 'text', text: 'F1528-FOLDED-REPLY' }] },
  },
  resultMessage('F1528-FOLDED-REPLY'),
];

/** The plain own turn's reply (no boundary left to fold into): its reply and its result. */
const plainTail: unknown[] = [
  {
    type: 'assistant', parent_tool_use_id: null, session_id: 'sdk-f1-528', uuid: 'a-own-plain',
    message: { id: 'msg_own_plain', role: 'assistant', content: [{ type: 'text', text: 'F1528-BG-REPLY-PLAIN' }] },
  },
  resultMessage('F1528-BG-REPLY-PLAIN'),
];

/**
 * Turn 1 ends; on `startOwn()` the child opens a turn of its own and pauses after `head`; on `resumeOwn()` it
 * yields `tail`. Whatever the host writes meanwhile is read by the fake only AFTER the own turn's script ends — the
 * `afterOwn` script answers it (nothing at all for a fold, a whole slot-less turn for the plain shape).
 */
function turnThenOwnTurn(head: unknown[], tail: unknown[], afterOwn?: () => AsyncGenerator<unknown>): {
  startOwn(): void; resumeOwn(): void; headRouted: Promise<void>; ownScriptDone: Promise<void>;
} {
  let openStart!: () => void;
  let openResume!: () => void;
  let headDone!: () => void;
  let scriptDone!: () => void;
  const start = new Promise<void>(resolve => { openStart = resolve; });
  const resume = new Promise<void>(resolve => { openResume = resolve; });
  const headRouted = new Promise<void>(resolve => { headDone = resolve; });
  const ownScriptDone = new Promise<void>(resolve => { scriptDone = resolve; });
  scripts.push(async function* turnThenOwn() {
    yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-528', uuid: 'u-host-init' };
    yield resultMessage();
    await start;
    for (const message of head) yield message;
    headDone();
    await resume;
    for (const message of tail) yield message;
    scriptDone();
  });
  if (afterOwn) scripts.push(afterOwn);
  return { startOwn: () => openStart(), resumeOwn: () => openResume(), headRouted, ownScriptDone };
}

async function runTurn(agent: OwnTurnAgent, message: string): Promise<AgentEvent[]> {
  const chatImpl = (agent as unknown as { chatImpl: (message: string) => AsyncGenerator<AgentEvent> }).chatImpl.bind(agent);
  const events: AgentEvent[] = [];
  for await (const event of chatImpl(message)) events.push(event);
  return events;
}

/** The reader is detached; one macrotask after a release lets its last `routeLiveMessage` settle. */
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (predicate()) return;
    await tick(10);
  }
  throw new Error(`F1.528 rig: timed out waiting for ${label}`);
}

let counter = 0;
let liveAgent: OwnTurnAgent | null = null;

beforeEach(() => {
  scripts.length = 0;
});

afterEach(() => {
  liveAgent?.destroy();
  liveAgent = null;
});

function freshAgent(): OwnTurnAgent {
  counter += 1;
  liveAgent = new ClaudeAgent(agentConfig(`session-f1-528-${counter}`)) as OwnTurnAgent;
  // The fixture's runtime is asserted rather than assumed (AGENTS.md, the 2026-09-20 fixture trap).
  expect(liveAgent).toBeInstanceOf(ClaudeAgent);
  return liveAgent;
}

/**
 * F1.528's order: turn 1 ends, the child opens its own turn (slot-less init routed), and only THEN does a host send
 * open its slot and write — the send read the marker as null before the init, so nothing gated it.
 */
async function hostWritesIntoOwnTurn(agent: OwnTurnAgent, own: ReturnType<typeof turnThenOwnTurn>): Promise<{
  hostTurn: Promise<AgentEvent[]>; pendingBeforeWrite: Promise<void> | null;
}> {
  await runTurn(agent, 'start a background subagent');
  expect(agent.runtimeOwnTurnSettled?.() ?? null).toBeNull();
  own.startOwn();
  await own.headRouted;
  await tick();
  const pendingBeforeWrite = agent.runtimeOwnTurnSettled?.() ?? null;
  // F1.540 — `chatImpl` now reads the marker again just before its slot opens and WAITS OUT a pending own turn, so
  // this order no longer happens through the gate (`claude-own-turn-slot-gate.test.ts`). It is FORCED here — the
  // gate's one read answers `null`, as the send's own read did before the child's `init` — because F1.528's
  // settle-anywhere is the defence that must still hold if the order recurs (a bound that expired under a turn still
  // running is one such path). Every later read is the real marker.
  const readMarker = agent.runtimeOwnTurnSettled!.bind(agent);
  let gateRead = false;
  (agent as { runtimeOwnTurnSettled: () => Promise<void> | null }).runtimeOwnTurnSettled = () => {
    if (gateRead) return readMarker();
    gateRead = true;
    return null;
  };
  const hostTurn = runTurn(agent, 'F1528-HOST-MID-OWN-TURN please also say hi');
  await until(() => agent.isProcessing(), 'the host slot to open');
  own.resumeOwn();
  return { hostTurn, pendingBeforeWrite };
}

describe('F1.528 — the child\'s own turn ends even when its result lands in a host slot', () => {
  it('(a) FOLD: the one result arrives in the host slot, and the own-turn marker is null afterwards', async () => {
    const agent = freshAgent();
    // The fold: the host's text rode the own turn, so the fake answers the written message with nothing at all.
    const own = turnThenOwnTurn(ownTurnHead, foldedTail, async function* folded() {});

    const { hostTurn, pendingBeforeWrite } = await hostWritesIntoOwnTurn(agent, own);
    // The precondition the row names: the own turn WAS pending when the host wrote into it.
    expect(pendingBeforeWrite).toBeInstanceOf(Promise);

    const events = await hostTurn;
    await own.ownScriptDone;
    await tick();
    // The folded reply reached the HOST slot — the measured shape, and why no slot-less result will ever follow.
    expect(events.filter(e => e.type === 'text_complete').map(e => (e as { text?: string }).text)).toEqual(['F1528-FOLDED-REPLY']);
    expect(events.some(e => e.type === 'complete')).toBe(true);

    // THE DEFECT: before this row the marker stayed a pending promise here, and the host queued every send behind it.
    expect(agent.runtimeOwnTurnSettled?.() ?? null).toBeNull();
    let settled = false;
    void pendingBeforeWrite?.then(() => { settled = true; });
    await tick();
    expect(settled).toBe(true);
  });

  it('CONTROL — no fold: the own turn\'s reply lands in the host slot, the host text runs slot-less, and its result settles', async () => {
    const agent = freshAgent();
    let answerRouted!: () => void;
    let releaseAnswerEnd!: () => void;
    const routed = new Promise<void>(resolve => { answerRouted = resolve; });
    const answerEnd = new Promise<void>(resolve => { releaseAnswerEnd = resolve; });
    const own = turnThenOwnTurn(ownTurnHead.slice(0, 2), plainTail, async function* hostTextRunsSlotLess() {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-528', uuid: 'u-host-text-init' };
      yield {
        type: 'assistant', parent_tool_use_id: null, session_id: 'sdk-f1-528', uuid: 'a-host-text',
        message: { id: 'msg_host_text', role: 'assistant', content: [{ type: 'text', text: 'F1528-HOST-OWN-REPLY' }] },
      };
      answerRouted();
      await answerEnd;
      yield resultMessage('F1528-HOST-OWN-REPLY');
    });

    const { hostTurn } = await hostWritesIntoOwnTurn(agent, own);
    const events = await hostTurn;
    expect(events.filter(e => e.type === 'text_complete').map(e => (e as { text?: string }).text)).toEqual(['F1528-BG-REPLY-PLAIN']);

    await routed;
    await tick();
    // The host text is being answered in a turn no slot watches: the marker must say a turn is running.
    expect(agent.runtimeOwnTurnSettled?.() ?? null).toBeInstanceOf(Promise);
    releaseAnswerEnd();
    await tick();
    expect(agent.runtimeOwnTurnSettled?.() ?? null).toBeNull();
  });
});

describe('F1.528 — a pending own turn is bounded', () => {
  it('(b) an own turn that never reports its end settles itself after the bound, and says so on the notice channel', async () => {
    const agent = freshAgent();
    const internals = agent as unknown as Internals;
    // Production takes the named constant; the rig shortens it, as `claude-permission-card-deadline.test.ts` does.
    internals.runtimeOwnTurnBoundMs = 150;
    const own = turnThenOwnTurn(ownTurnHead, foldedTail);

    await runTurn(agent, 'start a background subagent');
    own.startOwn();
    await own.headRouted;
    await tick();
    const pending = agent.runtimeOwnTurnSettled?.() ?? null;
    expect(pending).toBeInstanceOf(Promise);

    const outcome = await Promise.race([
      pending!.then(() => 'settled'),
      new Promise(resolve => setTimeout(() => resolve('pending'), 1_500)),
    ]);
    expect(outcome).toBe('settled');
    expect(agent.runtimeOwnTurnSettled?.() ?? null).toBeNull();
    expect(internals.pendingDegradationNotices.join('\n')).toContain('had not reported the end of that turn');
    own.resumeOwn();
  });

  it('CONTROL — an own turn that ends normally inside the bound queues no notice', async () => {
    const agent = freshAgent();
    const internals = agent as unknown as Internals;
    internals.runtimeOwnTurnBoundMs = 300;
    const own = turnThenOwnTurn(ownTurnHead.slice(0, 2), plainTail);

    await runTurn(agent, 'start a background subagent');
    own.startOwn();
    await own.headRouted;
    await tick();
    expect(agent.runtimeOwnTurnSettled?.() ?? null).toBeInstanceOf(Promise);
    own.resumeOwn();
    await own.ownScriptDone;
    await tick();
    expect(agent.runtimeOwnTurnSettled?.() ?? null).toBeNull();
    // Past the bound: a cleared timer fires nothing.
    await tick(450);
    expect(internals.pendingDegradationNotices.join('\n')).not.toContain('had not reported the end of that turn');
  });
});
