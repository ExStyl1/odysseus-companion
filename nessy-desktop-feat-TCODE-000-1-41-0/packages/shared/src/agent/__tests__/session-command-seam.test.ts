/**
 * S15 — the session-command seam, from the send path to the session action.
 *
 * `/compact` and `/subtask` are instructions to the SESSION, not prompts. Both
 * shipped dead: `BaseAgent.chat()` composes the pinned capability block onto the
 * front of every turn, so `chatImpl`'s anchored `^\/compact` and
 * `parseSubtaskCommand` never saw the leading slash and the command went to the
 * model as prose.
 *
 * Both halves had unit tests — `parseSubtaskCommand` matches the exact string,
 * `requestCompact` compacts when called — and NOTHING tested between them. That
 * is the shape of the defect: the seam, not either side of it. These tests drive
 * the real `chat()` entry point with a capability runtime active (as every live
 * send has) and assert the SESSION ACTED, because a command that silently does
 * nothing also fails to make the model answer.
 */

import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { CONFIG_DIR } from '../../config/paths.ts';
import { getAdvisorEnabled, saveConfig, type StoredConfig } from '../../config/storage.ts';
import { parseSessionCommand } from '../../slash-commands/session-command.ts';
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts';
import type { PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts';
import { PiAgent } from '../pi-agent.ts';
import { collectEvents } from './test-utils.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-seam',
      name: 'Seam Workspace',
      rootPath: '/tmp/nessy-seam-test',
      workspaceRootPath: '/tmp/nessy-seam-test',
      sessionRootPath: '/tmp/nessy-seam-test-sessions/ws-seam',
    } as any,
    session: {
      id: 'session-seam',
      workspaceRootPath: '/tmp/nessy-seam-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
  };
}

/**
 * The minimum live-shaped capability turn. Even with no layers at all the pinned
 * block is `<capability-generation>…</capability-generation>`, so a real send
 * ALWAYS reaches `chatImpl` with the user's text pushed off the front.
 */
function capabilityRuntime(): CapabilityTurnRuntime {
  const manifestSeed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: 'generation-seam-1',
    sessionKey: { workspaceId: 'ws-seam', sessionId: 'session-seam' },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: [],
  };
  return {
    provider: 'pi',
    view: {
      generation: manifestSeed.snapshotGeneration,
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [],
      apps: [], lspServers: [], monitors: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath(resource: unknown) { return (resource as { absolutePath: string }).absolutePath; },
      async readText() { return ''; },
      resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
    },
    piExecutionManifestSeed: manifestSeed,
  } as CapabilityTurnRuntime;
}

/** A Pi agent whose subprocess is faked: RPCs are answered, prompts recorded. */
function setupAgent(configPatch?: Partial<BackendConfig>) {
  const agent = new PiAgent({ ...createConfig(), ...configPatch });
  const internals = agent as any;
  const sent: Array<Record<string, unknown>> = [];
  internals.ensureSubprocess = async () => undefined;
  internals.emitAutomationEvent = async () => undefined;
  // A model turn ends immediately. A command turn returns before the drain, so
  // this only matters for the prose case — and it keeps a REGRESSION visible as
  // a failed assertion rather than as a five-second timeout.
  internals.eventQueue.drain = async function* () { yield { type: 'complete' }; };
  internals.send = (command: Record<string, unknown>) => {
    sent.push(command);
    if (command.type === 'compact') {
      queueMicrotask(() => internals.handleLine(JSON.stringify({
        type: 'compact_result',
        id: command.id,
        success: true,
        result: { summary: 'shorter', firstKeptEntryId: 'entry-1', tokensBefore: 12_345 },
      })));
      return;
    }
    if (command.type === 'subtask_start') {
      queueMicrotask(() => internals.handleLine(JSON.stringify({
        type: 'subtask_start_result',
        id: command.id,
        ok: true,
        agentId: 'child-1',
        name: 'Draft the tests',
      })));
    }
  };
  agent.setCapabilityTurnRuntime(capabilityRuntime());
  // Pre-publish the turn's execution manifest so the prompt path has a real one
  // without a manifest round-trip to the (absent) subprocess.
  const execution = internals.buildExecutionManifestForCurrentTurn();
  internals.activeExecutionManifest = execution.manifest;
  internals.adapter.setExecutionManifest(execution.manifest);
  return { agent, internals, sent };
}

test('`/compact` from the composer compacts the session instead of prompting the model', async () => {
  const { agent, sent } = setupAgent();
  try {
    const events = await collectEvents(agent.chat('/compact keep the decisions'));

    const compact = sent.find(command => command.type === 'compact');
    expect(compact).toBeDefined();
    expect(sent.some(command => command.type === 'prompt')).toBe(false);
    // The renderer keys `compaction_complete` off an info message that starts
    // with "Compacted" (SessionManager's `info` case), and the pre-plan
    // compaction waits on exactly that event.
    expect(events.some(event => event.type === 'info' && event.message.startsWith('Compacted'))).toBe(true);
  } finally {
    agent.destroy();
  }
});

test('`/subtask` from the composer forks a child instead of prompting the model', async () => {
  const { agent, sent } = setupAgent();
  try {
    const events = await collectEvents(agent.chat('/subtask draft the tests'));

    expect(sent.find(command => command.type === 'subtask_start')).toMatchObject({
      type: 'subtask_start',
      task: 'draft the tests',
    });
    expect(sent.some(command => command.type === 'prompt')).toBe(false);
    expect(events.some(event => event.type === 'info' && event.message.includes('Forked this conversation into'))).toBe(true);
  } finally {
    agent.destroy();
  }
});

/**
 * The model's own path. `SlashCommand` hands `dispatchSlashCommand` a BARE
 * command string, so a fix that only taught the seam about the wrapped form —
 * or that moved the parse somewhere the bare form never reaches — would repair
 * the user's `/compact` by breaking the model's. Both forms now go through
 * `parseSessionCommand` and land on the same `requestCompact`; this is the test
 * that keeps them together.
 */
test('the model\'s bare `/compact` still compacts, with its instructions intact', async () => {
  const { agent, internals, sent } = setupAgent();
  try {
    const result = await internals.executeSessionTool('SlashCommand', {
      command: 'compact',
      arguments: 'preserve the decisions',
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Compacted context');
    // Not a stubbed `requestCompact`: the real RPC went to the subprocess.
    expect(sent.find(command => command.type === 'compact')).toBeDefined();
    expect(String(sent.find(command => command.type === 'compact')?.customInstructions ?? ''))
      .toContain('preserve the decisions');
  } finally {
    agent.destroy();
  }
});

test('prose that merely mentions a command is still a prompt for the model', async () => {
  const { agent, sent } = setupAgent();
  try {
    await collectEvents(agent.chat('remind me what /compact does before I run it'));

    expect(sent.some(command => command.type === 'prompt')).toBe(true);
    expect(sent.some(command => command.type === 'compact')).toBe(false);
  } finally {
    agent.destroy();
  }
});

/**
 * R36 — `/clear` executes at the `BaseAgent.chat` seam itself: `clearHistory`
 * runs, and `chatImpl` is NEVER entered (slash-commands.md:212 — the reset is
 * dropping the resume anchor, not a model turn). The chatImpl override here is
 * the proof: a regression that routes `/clear` back through the backend fails
 * loudly instead of silently prompting the model.
 */
test('`/clear` from the composer clears history at the seam and never reaches chatImpl', async () => {
  const { agent, internals, sent } = setupAgent();
  try {
    let clearHistoryCalls = 0;
    const realClearHistory = agent.clearHistory.bind(agent);
    (agent as unknown as { clearHistory: () => Promise<void> }).clearHistory = async () => {
      clearHistoryCalls += 1;
      await realClearHistory();
    };
    internals.chatImpl = async function* () {
      throw new Error('chatImpl must not run for /clear');
    };

    const events = await collectEvents(agent.chat('/clear'));

    expect(clearHistoryCalls).toBe(1);
    expect(sent.some(command => command.type === 'prompt')).toBe(false);
    expect(events.some(event => event.type === 'info' && event.message.includes('cleared'))).toBe(true);
    // Never "Compacted…": SessionManager keys compaction_complete off that prefix.
    expect(events.some(event => event.type === 'info' && event.message.startsWith('Compacted'))).toBe(false);
    expect(events.some(event => event.type === 'complete')).toBe(true);
  } finally {
    agent.destroy();
  }
});

/**
 * R48 — tools-reference.md:451: "Running `/clear` resets the count" (the
 * session WebSearch budget). The clear signal never reaches the Pi subprocess
 * as a message — `clearHistory()` KILLS it, and the replacement process starts
 * a fresh module-scope budget — so the wire point under test is the host half:
 * the remembered total must be zeroed, or the next spawn would re-seed the new
 * budget with the pre-clear count via `InitMessage.webSearchesUsed`.
 */
test('`/clear` zeroes the host-remembered WebSearch count that seeds the next subprocess', async () => {
  const usageReports: number[] = [];
  let remembered: number | undefined;
  const { agent, internals } = setupAgent({
    onPiWebSearchUsage: used => {
      usageReports.push(used);
      remembered = used;
    },
    getPiWebSearchesUsed: () => remembered,
  });
  try {
    // The subprocess reports consumption; the host mirrors the absolute count.
    internals.handleLine(JSON.stringify({ type: 'web_search_usage', used: 7 }));
    expect(usageReports).toEqual([7]);
    expect(remembered).toBe(7);
    // A malformed report is dropped, never mirrored.
    internals.handleLine(JSON.stringify({ type: 'web_search_usage', used: -3 }));
    internals.handleLine(JSON.stringify({ type: 'web_search_usage', used: 'many' }));
    expect(usageReports).toEqual([7]);

    await collectEvents(agent.chat('/clear'));

    expect(usageReports).toEqual([7, 0]);
    // The seed the NEXT subprocess spawn would read is the reset value.
    expect(agent['config'].getPiWebSearchesUsed?.()).toBe(0);
  } finally {
    agent.destroy();
  }
});

test('prose that merely mentions /clear is still a prompt and clears nothing', async () => {
  const { agent, sent } = setupAgent();
  try {
    let clearHistoryCalls = 0;
    const realClearHistory = agent.clearHistory.bind(agent);
    (agent as unknown as { clearHistory: () => Promise<void> }).clearHistory = async () => {
      clearHistoryCalls += 1;
      await realClearHistory();
    };

    await collectEvents(agent.chat('please /clear this up'));

    expect(sent.some(command => command.type === 'prompt')).toBe(true);
    expect(clearHistoryCalls).toBe(0);
  } finally {
    agent.destroy();
  }
});

/**
 * The classifier claims the two out-of-band commands so no seam can ever see
 * them as prose. `/clear` and `/recap` are whole-message and take no argument;
 * `/btw`'s bare form parses with an empty question — the documented REOPEN
 * (interactive-mode.md:374), not a usage error.
 */
test('parseSessionCommand claims /clear, /btw and /recap, whole-message only', () => {
  expect(parseSessionCommand('/clear')).toEqual({ kind: 'clear' });
  expect(parseSessionCommand('  /CLEAR  ')).toEqual({ kind: 'clear' });
  expect(parseSessionCommand('/clear everything')).toBeNull();

  expect(parseSessionCommand('/btw what was that config file?'))
    .toEqual({ kind: 'btw', question: 'what was that config file?' });
  expect(parseSessionCommand('/btw')).toEqual({ kind: 'btw', question: '' });

  expect(parseSessionCommand('/recap')).toEqual({ kind: 'recap' });
  expect(parseSessionCommand('/recap the meeting')).toBeNull();

  expect(parseSessionCommand('ask /btw later')).toBeNull();
});

/**
 * T17 — `/quota` executes at the same seam as `/clear`, and the BASE
 * implementation is provider-neutral: a runtime with no quota surface says so
 * and returns, so the command can never reach `chatImpl` as prose.
 *
 * T19 — this agent is a Pi one, and `PiAgent` now DOES override
 * `describeQuota()`. It still lands here because the override is gated on the
 * connection: this config carries no gateway `baseUrl`, so it falls back to
 * `super`. That makes this row the fallback's negative control at the seam;
 * `pi-agent-quota.test.ts` drives the other side.
 */
test('`/quota` on a runtime without a quota surface answers at the seam and never reaches chatImpl', async () => {
  const { agent, internals, sent } = setupAgent();
  try {
    internals.chatImpl = async function* () {
      throw new Error('chatImpl must not run for /quota');
    };

    const events = await collectEvents(agent.chat('/quota'));

    expect(sent.some(command => command.type === 'prompt')).toBe(false);
    expect(events.map(event => event.type)).toEqual(['info', 'complete']);
    expect(events.some(event => event.type === 'info' && event.message === 'Quota is not available on this runtime.')).toBe(true);
    // Never "Compacted…": SessionManager keys compaction_complete off that prefix.
    expect(events.some(event => event.type === 'info' && event.message.startsWith('Compacted'))).toBe(false);
  } finally {
    agent.destroy();
  }
});

test('prose that merely mentions /quota is still a prompt for the model', async () => {
  const { agent, sent } = setupAgent();
  try {
    await collectEvents(agent.chat('how do I read my /quota again?'));

    expect(sent.some(command => command.type === 'prompt')).toBe(true);
  } finally {
    agent.destroy();
  }
});

/**
 * P3.25 — `/approve` had NO ROUTE. Measured before this test existed:
 * `parseSessionCommand('/approve')` returned `null`, so the send path composed
 * the pinned capability block onto the front of it and asked the MODEL to
 * approve the action the guardian had denied. Whole-message and argument-free
 * like `/clear`: the command applies to the denial the session already holds,
 * so there is nothing for an argument to name.
 */
test('parseSessionCommand claims /approve, whole-message only', () => {
  expect(parseSessionCommand('/approve')).toEqual({ kind: 'approve' });
  expect(parseSessionCommand('  /APPROVE  ')).toEqual({ kind: 'approve' });
  expect(parseSessionCommand('/approve this')).toBeNull();
  expect(parseSessionCommand('can you /approve that?')).toBeNull();
});

/**
 * P3.25 — THE ARM IS WHAT MAKES THE REGISTRATION SAFE. `BaseAgent.chat` ends its
 * session-command branch by falling through to `chatImpl`, so a kind registered
 * with no arm would send the bare `/approve` to the model on EVERY runtime — a
 * different failure from the one the row started with, and a worse-looking one.
 * This drives the real `chat()` with a live capability runtime, the shape every
 * send has.
 */
test('`/approve` on a runtime with no guardian answers at the seam and never reaches chatImpl', async () => {
  const { agent, internals, sent } = setupAgent();
  try {
    internals.chatImpl = async function* () {
      throw new Error('chatImpl must not run for /approve');
    };

    const events = await collectEvents(agent.chat('/approve'));

    expect(sent.some(command => command.type === 'prompt')).toBe(false);
    expect(events.map(event => event.type)).toEqual(['info', 'complete']);
    const info = events.find(event => event.type === 'info') as { message?: string };
    // The i18n guard: an uninitialized i18next returns `undefined` from `t()`,
    // and an empty info line is indistinguishable from a command that did
    // nothing — which is the whole defect this row is about.
    expect(typeof info.message).toBe('string');
    expect(info.message).toContain('/approve');
  } finally {
    agent.destroy();
  }
});

test('prose that merely mentions /approve is still a prompt for the model', async () => {
  const { agent, sent } = setupAgent();
  try {
    await collectEvents(agent.chat('should I /approve that denial?'));

    expect(sent.some(command => command.type === 'prompt')).toBe(true);
  } finally {
    agent.destroy();
  }
});

/**
 * R49/f210 — `/heapdump` (troubleshooting.md:39) is whole-message and takes
 * no argument, exactly like `/clear`: trailing text makes it prose for the
 * model, and a mid-sentence mention is never a command.
 */
test('parseSessionCommand claims /heapdump, whole-message only', () => {
  expect(parseSessionCommand('/heapdump')).toEqual({ kind: 'heapdump' });
  expect(parseSessionCommand('  /HEAPDUMP  ')).toEqual({ kind: 'heapdump' });
  expect(parseSessionCommand('/heapdump now')).toBeNull();
  expect(parseSessionCommand('what does /heapdump do?')).toBeNull();
});

/**
 * P2.278 — the classifier claims the three `/advisor` forms and nothing else.
 *
 * `advisor.md#use-the-/advisor-command`: "Run `/advisor` without arguments to
 * open a picker listing the available advisor models, or pass the model
 * directly:". A composer has no picker, so the bare form REPORTS here instead —
 * and the model-naming form stays prose, which is why `/advisor opus` and
 * `/advisor use opus` must both fall through to the model rather than be eaten
 * by an over-greedy pattern.
 */
test('parseSessionCommand claims /advisor in three forms, whole-message only', () => {
  expect(parseSessionCommand('/advisor')).toEqual({ kind: 'advisor', action: 'status' });
  expect(parseSessionCommand('  /ADVISOR  ')).toEqual({ kind: 'advisor', action: 'status' });
  expect(parseSessionCommand('/advisor on')).toEqual({ kind: 'advisor', action: 'on' });
  expect(parseSessionCommand('/advisor OFF')).toEqual({ kind: 'advisor', action: 'off' });
  expect(parseSessionCommand('/advisor opus')).toBeNull();
  expect(parseSessionCommand('/advisor use opus')).toBeNull();
  expect(parseSessionCommand('should I turn the /advisor on?')).toBeNull();
});

/**
 * P2.278 — THE ARM, AND THE STATE IT MOVES.
 *
 * Measured before this test existed: `parseSessionCommand` returned
 * `{ kind: 'advisor' }` and `BaseAgent.chat`'s session-command block had arms
 * for `clear`, `quota` and `approve` and NONE for `advisor`, so all three forms
 * fell through to `chatImpl` and were sent to the MODEL as prose on every
 * runtime — while `session-command.ts` and `pi-agent.ts` both documented an arm
 * that did not exist. The `/quota` and `/approve` rows above are the positive
 * control: they answered at the seam throughout, and `/advisor` did not.
 *
 * The assertion that matters is the STATE, not the sentence. The advisor is
 * OPT-IN and default-off (`config-defaults.json`: `"advisorEnabled": false`),
 * and before this arm `setAdvisorEnabled` had no production caller at all — so
 * an arm that merely intercepts the text and reports success would be a worse
 * defect than the fall-through, because it would look fixed. This drives the
 * REAL `setAdvisorEnabled`/`getAdvisorEnabled` pair (no double) and reads the
 * persisted `config.json` back off disk.
 *
 * `advisor.md#impact-on-prompt-caching`: "Enabling or disabling the advisor
 * mid-session does not invalidate your main model's prompt cache." — the toggle
 * is a mid-session operation, which is exactly what the seam arm makes possible.
 */
test('`/advisor on|off` moves the persisted setting at the seam and never reaches chatImpl', async () => {
  const configFile = join(CONFIG_DIR, 'config.json');
  const priorBytes = existsSync(configFile) ? readFileSync(configFile) : null;
  const restoreConfig = () => {
    if (priorBytes) writeFileSync(configFile, priorBytes);
    else rmSync(configFile, { force: true });
  };
  // `setAdvisorEnabled` reads-modifies-writes and RETURNS SILENTLY when there is
  // no config.json (`loadStoredConfig()` is null); the isolated test config dir
  // is seeded by `ensureConfigDir()`, which does not create one. Seed it, so the
  // setter under test is exercised rather than skipped.
  const seed: StoredConfig = { workspaceRefs: [], activeWorkspaceId: null, activeSessionId: null };
  saveConfig(seed);

  let harness: ReturnType<typeof setupAgent>;
  try {
    harness = setupAgent();
  } catch (error) {
    restoreConfig();
    throw error;
  }
  const { agent, internals, sent } = harness;
  try {
    internals.chatImpl = async function* () {
      throw new Error('chatImpl must not run for /advisor');
    };

    expect(getAdvisorEnabled()).toBe(false);

    const onEvents = await collectEvents(agent.chat('/advisor on'));

    expect(sent.some(command => command.type === 'prompt')).toBe(false);
    expect(onEvents.map(event => event.type)).toEqual(['info', 'complete']);
    const onInfo = onEvents.find(event => event.type === 'info') as { message?: string };
    // The i18n guard: an uninitialized i18next returns `undefined` from `t()`,
    // and an empty info line is indistinguishable from a command that did
    // nothing — the very confusion this row is about.
    //
    // CONFOUNDED IN A WHOLE-FILE RUN, and measured to be: `/approve`'s row above
    // runs first and its own guard initializes i18next, so this line passes with
    // OR without `describeAdvisor`'s guard. The rig that discriminates is
    //   bun test packages/shared/src/agent/__tests__/session-command-seam.test.ts -t advisor
    // which filters `/approve` out — without the guard it fails here with
    // `Received: "undefined"`. Re-run that if you ever touch the guard.
    expect(typeof onInfo.message).toBe('string');
    expect(onInfo.message!.length).toBeGreaterThan(0);
    // The switch actually flipped...
    expect(getAdvisorEnabled()).toBe(true);
    // ...and it PERSISTED, which is the half `/advisor on` exists to do.
    expect(JSON.parse(readFileSync(configFile, 'utf-8')).advisorEnabled).toBe(true);

    // The bare form reports and must NOT toggle: a blind toggle makes the
    // command's effect depend on state the user cannot see from the composer.
    const statusEvents = await collectEvents(agent.chat('/advisor'));
    expect(statusEvents.map(event => event.type)).toEqual(['info', 'complete']);
    expect(getAdvisorEnabled()).toBe(true);

    // `advisor.md#turn-the-advisor-off`: "To stop using the advisor and clear
    // your saved `advisorModel`, run `/advisor off` or choose **No advisor** in
    // the `/advisor` picker:". We keep `advisorModel` (it is a separate setting
    // here, and the OFF switch is our own `advisorEnabled`), but the stop half
    // is this.
    const offEvents = await collectEvents(agent.chat('/advisor off'));
    expect(offEvents.map(event => event.type)).toEqual(['info', 'complete']);
    const offInfo = offEvents.find(event => event.type === 'info') as { message?: string };
    expect(typeof offInfo.message).toBe('string');
    // Present in every locale's `settings.ai.advisor.statusOff`.
    expect(offInfo.message).toContain('/advisor');
    expect(getAdvisorEnabled()).toBe(false);
    expect(JSON.parse(readFileSync(configFile, 'utf-8')).advisorEnabled).toBe(false);

    // Not once, across all three forms.
    expect(sent.some(command => command.type === 'prompt')).toBe(false);
    // Never "Compacted…": SessionManager keys compaction_complete off that prefix.
    expect(onEvents.some(event => event.type === 'info' && event.message.startsWith('Compacted'))).toBe(false);
  } finally {
    agent.destroy();
    restoreConfig();
  }
});

test('prose that merely mentions /advisor is still a prompt for the model', async () => {
  const { agent, sent } = setupAgent();
  try {
    await collectEvents(agent.chat('should I turn the /advisor on for this task?'));

    expect(sent.some(command => command.type === 'prompt')).toBe(true);
  } finally {
    agent.destroy();
  }
});

/**
 * The arm must not become a swallower. `/advisor use opus` names a MODEL, and
 * `advisorModel` is the setting that chooses one — so the request belongs to
 * the model, exactly as the parser's own docs say. This is the discriminator
 * against a fix that intercepts everything starting with `/advisor`.
 */
test('`/advisor use opus` names a model and stays a prompt for the model', async () => {
  const { agent, sent } = setupAgent();
  try {
    await collectEvents(agent.chat('/advisor use opus'));

    expect(sent.some(command => command.type === 'prompt')).toBe(true);
  } finally {
    agent.destroy();
  }
});
