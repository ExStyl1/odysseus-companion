import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AgentEvent } from '@nessy-agent/core/types';
import { TERMINAL_REASON_VALUES } from '@nessy-agent/core/types';
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol';
import { AbortReason } from '../core/session-lifecycle.ts';
import { EventQueue } from '../backend/event-queue.ts';
import { NestorCloudEventAdapter } from '../backend/nestor-cloud/event-adapter.ts';
import { buildToolResultPart } from '../backend/nestor-cloud/client.ts';
import { NestorCloudTurn } from '../backend/nestor-cloud/turn.ts';
import { toLocalToolCall } from '../backend/nestor-cloud/local-tool-adapter.ts';
import {
  NESTOR_BUILTIN_TOOL_NAMES,
  NESTOR_TERMINAL_TOOL_NAMES,
  buildA2AToolResultData,
  normalizeNestorToolCall,
} from '../backend/nestor-cloud/tool-schema.ts';
import {
  defaultMidStreamBehavior,
  resolveMidStreamBehavior,
} from '../../config/llm-connections.ts';
import {
  PERMISSION_MODE_AGENT_LABELS,
  PERMISSION_MODE_ORDER,
  PERMISSION_MODE_TO_CANONICAL,
  type PermissionMode,
} from '../mode-types.ts';
import { cleanupModeState, initializeModeState } from '../mode-manager.ts';
import { runPreToolUseChecks } from '../core/pre-tool-use.ts';
import { registerSessionsHandlers } from '../../../../server-core/src/handlers/rpc/sessions.ts';

const fixturesDir = resolve(import.meta.dir, 'fixtures/adjacent-backends');
const repoRoot = resolve(import.meta.dir, '../../../../..');

type EventFor<K extends AgentEvent['type']> = Extract<AgentEvent, { type: K }>;
type EventFieldMap = {
  [K in AgentEvent['type']]: {
    readonly required: readonly Exclude<keyof EventFor<K>, 'type'>[];
    readonly optional: readonly Exclude<keyof EventFor<K>, 'type'>[];
  };
};

const EVENT_FIELDS = {
  // `retry` added 2026-09-09 (P6.916): the retry's own facts, minted with the
  // sentence by `retryStatusEvent` and produced by all three runtimes, so this
  // is a golden that follows an owned field rather than one nobody emits.
  // `phase` added 2026-10-10 (TFP1 re-freeze after F1.1150 `835fccd2c` +
  // `13062de1a`): declared on the `status` branch in
  // `packages/core/src/types/message.ts` and produced by the codex adapter
  // (the re-fork label and the in-flight auto-review), forwarded by
  // SessionManager as `statusType: 'phase'` and handled label-only by the
  // renderer — an owned, emitted field the golden lagged, in source order
  // after `retry`.
  status: { required: ['message'], optional: ['retry', 'phase'] },
  // `answersSessionCommand` added 2026-09-19 (WI-bs, re-freezing D1.245's
  // field): declared on the `info` branch in `packages/core/src/types/message.ts`
  // and PRODUCED at three sites in `packages/shared/src/agent/base-agent.ts`,
  // with its own suite in `session-command-answer-marker-seam.test.ts` — so
  // this is a golden that lagged an owned, emitted field, not a branch that
  // grew one nobody sets. `compactionTrigger` (F1.241, stamped by Pi + claude): same.
  info: { required: ['message'], optional: ['level', 'answersSessionCommand', 'compactionTrigger'] },
  text_delta: { required: ['text'], optional: ['turnId', 'parentToolUseId'] },
  text_discard: { required: ['turnId'], optional: [] }, // F1.298 2026-09-24: Pi adapter emits, SessionManager + renderer read
  // `isThinking` re-frozen 2026-09-03: declared in `a6d56aabc` and produced by `5800696b9` (codex
  // reasoning); the field is read on all four adapters plus
  // `packages/ui/src/components/chat/turn-utils.ts` — so this is a golden that lagged an owned
  // field, not a branch that grew one nobody emits. `runtimeTurnId` added 2026-09-06 (P6.102):
  // codex's own turn id, which its per-message `turnId` cannot carry. Owned and produced — the
  // codex adapter sets it and `SessionManager` anchors branches on it.
  text_complete: { required: ['text'], optional: ['isIntermediate', 'isThinking', 'thinkingSignature', 'turnId', 'parentToolUseId', 'sdkMessageId', 'runtimeTurnId'] },
  pi_turn_anchor: { required: ['sdkMessageId', 'sdkTurnAnchor'], optional: [] },
  tool_start: { required: ['toolName', 'toolUseId', 'input'], optional: ['intent', 'displayName', 'turnId', 'parentToolUseId', 'toolDisplayMeta'] },
  tool_result: { required: ['toolUseId', 'result', 'isError'], optional: ['toolName', 'structuredContent', 'input', 'turnId', 'parentToolUseId'] },
  // `origin` added 2026-09-08 (P6.709): WHO raised the card — host gate / claude
  // native / codex approval. Optional and last, in source order; absent means
  // unknown, never host.
  permission_request: { required: ['requestId', 'toolName', 'description'], optional: ['command', 'permissionType', 'appName', 'reason', 'impact', 'requiresSystemPrompt', 'rememberForMinutes', 'commandHash', 'approvalTtlSeconds', 'origin'] },
  permission_request_cancelled: { required: ['requestId'], optional: [] },
  error: { required: ['message'], optional: [] },
  typed_error: { required: ['error'], optional: [] },
  complete: { required: [], optional: ['usage', 'terminalReason', 'deferredToolUse', 'terminalIsError', 'structuredOutput', 'structuredOutputSubtype', 'structuredOutputErrors'] },
  working_directory_changed: { required: ['workingDirectory'], optional: [] },
  task_backgrounded: { required: ['toolUseId', 'taskId'], optional: ['kind', 'intent', 'turnId'] },
  shell_backgrounded: { required: ['toolUseId', 'shellId'], optional: ['intent', 'command', 'turnId'] },
  task_progress: { required: ['toolUseId'], optional: ['elapsedSeconds', 'orchestrationProgress', 'turnId'] },
  // UB9.8 (2026-10-16, craft-agents-oss v0.15.1): a running background task's activity. Produced by the claude
  // adapter (in-turn) and `ClaudeAgent.noteBetweenTurnsMessage` (between turns), forwarded by SessionManager only
  // for a registered task.
  task_activity: { required: ['taskId'], optional: ['toolUseId', 'summary', 'lastToolName', 'toolUses', 'turnId'] },
  // P6.109 · REPLACE semantics, so the whole set is the payload and `tasks: []`
  // is meaningful. No `turnId`: a membership change is not a turn's news, and
  // the rows outlive the turn that started them.
  background_tasks_replaced: { required: ['tasks'], optional: [] },
  task_completed: { required: ['taskId', 'status'], optional: ['outputFile', 'summary', 'turnId'] },
  // R10: the settled result of a detached (auto-backgrounded) MCP call.
  task_notification: { required: ['taskId', 'text'], optional: ['turnId'] },
  shell_killed: { required: ['shellId'], optional: ['turnId'] },
  source_activated: { required: ['sourceSlug', 'originalMessage'], optional: [] },
  usage_update: { required: ['usage'], optional: [] },
  // `messageId` added 2026-09-23 (F1.238): the transcript id `redirect()` got,
  // echoed so a refusal re-queues THAT message. `origin` added 2026-09-24 (F1.343):
  // 'monitor' for a plugin monitor's text, which goes to the monitor-event queue.
  // Produced by `ClaudeAgent.handBackPendingSteers`, read by `requeueUndeliveredSteer`.
  steer_undelivered: { required: ['message'], optional: ['messageId', 'origin'] },
} as const satisfies EventFieldMap;

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8')) as T;
}

function sourceAt(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function stream(events: unknown[]): AsyncIterable<any> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

function stripSignal(value: Record<string, unknown>): Record<string, unknown> {
  const { signal: _signal, ...rest } = value;
  return rest;
}

class FixtureNestorClient {
  loadCount = 0;
  readonly messageCalls: Array<Record<string, unknown>> = [];
  readonly toolResultCalls: Array<Record<string, unknown>> = [];
  readonly messageStreams: Array<AsyncIterable<any>> = [];
  readonly toolStreams: Array<AsyncIterable<any>> = [];

  async loadAgentCard() {
    this.loadCount += 1;
    return {};
  }

  sendMessageStream(args: Record<string, unknown>) {
    this.messageCalls.push(stripSignal(args));
    return this.messageStreams.shift() ?? stream([]);
  }

  sendToolResultsStream(args: Record<string, unknown>) {
    this.toolResultCalls.push(stripSignal(args));
    return this.toolStreams.shift() ?? stream([]);
  }

  async cancelTask() {}
}

async function collectTurn(turn: NestorCloudTurn, message: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of turn.run(message)) events.push(event);
  return events;
}

// A2A 1.0 frames: a oneof envelope keyed by `message`/`task`/`statusUpdate`,
// `TASK_STATE_*` states, flattened parts, and no `final` flag (the codec
// computes it). See `docs/superpowers/specs/2026-08-22-nestor-a2a-v2-wire-and-quota.md`.
function adapterToolOutput(adapter: NestorCloudEventAdapter, input: any): any {
  const outputs = adapter.adapt({
    message: {
      messageId: `message-${input.id}`,
      role: 'ROLE_AGENT',
      parts: [{
        data: {
          data_type: 'tool_call',
          data_version: 1,
          id: input.id,
          index: input.index,
          function: { name: input.name, arguments: input.arguments },
        },
      }],
    },
  } as never);
  return outputs.find(output => output.kind === 'tool_call');
}

function completedStreamEvent(text = ''): any {
  return {
    statusUpdate: {
      taskId: 'task-1',
      contextId: 'ctx-1',
      status: {
        state: 'TASK_STATE_COMPLETED',
        message: {
          messageId: 'terminal-complete',
          role: 'ROLE_AGENT',
          parts: text ? [{ text }] : [],
        },
      },
    },
  };
}

function terminalStreamEvent(input: any): any {
  return {
    statusUpdate: {
      taskId: 'task-1',
      contextId: 'ctx-1',
      status: {
        state: 'TASK_STATE_INPUT_REQUIRED',
        message: {
          messageId: `message-${input.id}`,
          role: 'ROLE_AGENT',
          parts: [{
            data: {
              data_type: 'tool_call',
              data_version: 1,
              id: input.id,
              index: input.index,
              function: { name: input.name, arguments: input.arguments },
            },
          }],
        },
      },
    },
  };
}

function agentEventBranch(source: string, type: string): string {
  const unionStart = source.indexOf('export type AgentEvent =');
  const unionEnd = source.indexOf('\n\n/**', unionStart);
  const marker = `type: '${type}'`;
  const start = source.indexOf(marker, unionStart);
  const end = source.indexOf('\n  | ', start + marker.length);
  expect(unionStart, 'AgentEvent union').toBeGreaterThanOrEqual(0);
  expect(unionEnd, 'AgentEvent union end').toBeGreaterThan(unionStart);
  expect(start, `AgentEvent.${type}`).toBeGreaterThanOrEqual(0);
  return source.slice(start, end >= 0 && end < unionEnd ? end : unionEnd);
}

function agentEventFields(source: string, type: string): { required: string[]; optional: string[] } {
  const branch = agentEventBranch(source, type);
  const required: string[] = [];
  const optional: string[] = [];
  for (const match of branch.matchAll(/(?:^|[;{\n])\s*([A-Za-z_][A-Za-z0-9_]*)(\?)?:/g)) {
    const field = match[1];
    if (!field || field === 'type') continue;
    (match[2] ? optional : required).push(field);
  }
  return { required, optional };
}

async function drainQueue(events: AgentEvent[]): Promise<AgentEvent[]> {
  const queue = new EventQueue();
  for (const event of events) queue.enqueue(event);
  queue.complete();
  const drained: AgentEvent[] = [];
  for await (const event of queue.drain()) drained.push(event);
  return drained;
}

const FEATURE_ENV_KEYS = [
  'NESSY_FEATURE_PROVIDER_CLAUDE',
  'NESSY_FEATURE_CLAUDE_RUNTIME',
  'NESSY_FEATURE_CODEX_RUNTIME',
  'NESSY_FEATURE_PROVIDER_NESTOR_CLOUD',
] as const;

// The probe below spends its first phase inside one `await import()` of the
// backend factory's module graph, and that graph is COLD and I/O-bound: three
// direct readings — 188 709 ms at load 9.62 (W9-i), then 142 442 ms at load 13.39
// and 209 875 ms at load 12.09 (W9-bg) — all at ~1.5 % cpu, I/O wait rather than
// contention, and the spread runs BACKWARDS against load, so a quieter box does
// not make it faster. A single fixed bound smaller than that spread makes this
// case red under every load, which is what a `boundedProcess(…, 90_000)` did
// until P6.900 — the same defect P6.893 fixed in the four MCP harnesses, and the
// same remedy: the child announces its own readiness once the graph is up, the
// harness WAITS for that line, and the two phases get separate windows.
const PROBE_READY_MARKER = '__ADJACENT_READY__';
// And the direct probe is the FLOOR, not the figure to budget against: inside
// `bun test` the parent is building its own graph off the same disk. The line
// this case prints read 120 644 ms on a 200.28 s run of the file at load 14.01;
// the run before it, on the same bytes, took 436.34 s in total, so the same
// phase cost roughly three times as much minutes apart — the lottery AGENTS.md
// names, on an I/O-bound graph. The window is ~2x the worst of those, and it
// exists to turn a HANG into a named error, never to price the import. Re-derive
// it from the printed line rather than from this sentence.
const PROBE_READY_TIMEOUT_MS = 900_000;
// The work AFTER the graph is up — every construction, redirect, abort and
// destroy this case pins — measured 208 ms and 19 ms in the same two probes.
// Never zero.
const PROBE_WORK_TIMEOUT_MS = 60_000;

async function boundedProcess(command: string[], bounds: {
  readyMarker: string;
  readyTimeoutMs: number;
  workTimeoutMs: number;
}): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  readyAtMs: number;
  workMs: number;
}> {
  const startedAt = Date.now();
  const child = Bun.spawn(command, {
    cwd: repoRoot,
    env: process.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdoutPromise = new Response(child.stdout).text();
  let stderr = '';
  let readyAtMs: number | undefined;
  let signalReady: (() => void) | undefined;
  const ready = new Promise<void>(resolve => { signalReady = resolve; });
  // stderr is drained AS IT ARRIVES rather than at exit: it is the only place the
  // readiness line appears, and an undrained pipe can block the child.
  const stderrDone = (async () => {
    const reader = child.stderr.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) stderr += decoder.decode(value, { stream: true });
      if (readyAtMs === undefined && stderr.includes(bounds.readyMarker)) {
        readyAtMs = Date.now() - startedAt;
        signalReady?.();
      }
    }
    stderr += decoder.decode();
  })();
  const deadline = (ms: number, label: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    });
    return { promise, cancel: () => { if (timer) clearTimeout(timer); } };
  };
  // A child that dies before announcing readiness must not cost the whole window,
  // and it must fail LOUDLY carrying its stderr — a silent return forty lines
  // before the assertions is what made the old shape unreadable.
  const exitedBeforeReady = child.exited.then(async () => {
    if (readyAtMs !== undefined) return;
    await stderrDone;
    throw new Error(`adjacent-backend-probe-exited-before-ready (exit ${child.exitCode}): ${stderr}`);
  });
  exitedBeforeReady.catch(() => {});
  try {
    const readyDeadline = deadline(bounds.readyTimeoutMs, 'adjacent-backend-probe-never-ready');
    try {
      await Promise.race([ready, exitedBeforeReady, readyDeadline.promise]);
    } finally {
      readyDeadline.cancel();
    }
    const readyMs = readyAtMs;
    if (readyMs === undefined) throw new Error('adjacent-backend-probe-never-ready');
    const workDeadline = deadline(bounds.workTimeoutMs, 'adjacent-backend-probe-work-timeout');
    let exitCode: number;
    try {
      exitCode = await Promise.race([child.exited, workDeadline.promise]);
    } finally {
      workDeadline.cancel();
    }
    await stderrDone;
    const elapsedMs = Date.now() - startedAt;
    return {
      exitCode,
      stdout: await stdoutPromise,
      stderr,
      elapsedMs,
      readyAtMs: readyMs,
      workMs: elapsedMs - readyMs,
    };
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

function protocolDiscriminants(source: string, alias: string, sourcePath?: string): string[] {
  const start = source.indexOf(`type ${alias} =`);
  const end = source.indexOf('\n\n', start);
  expect(start, alias).toBeGreaterThanOrEqual(0);
  expect(end, `${alias} end`).toBeGreaterThan(start);
  const block = source.slice(start, end);
  const values: string[] = [];
  // F1.302 — split on EVERY top-level `|`, not on newline-then-`|`: 862a4f0fe put
  // `| { type: 'cancel_ephemeral_query' … }` on the `llm_query` line, and that split
  // read the pair as ONE member — this half went blind while the switch half saw
  // it. `topLevelUnionMembers` (end of file) drops comments and keeps strings and
  // nested `{}`/`[]`/`()`/`<>` whole, so a MULTI-LINE inline object is one member.
  const members = topLevelUnionMembers(block.slice(block.indexOf('=') + 1));
  for (const member of members) {
    const inline = member.match(/^\{\s*type:\s*'([^']+)'/);
    if (inline?.[1]) {
      values.push(inline[1]);
      continue;
    }
    const name = member.match(/^([A-Z][A-Za-z0-9_]*)$/)?.[1];
    expect(name, `${alias} branch`).toBeDefined();
    // F1.1078 — a branch IMPORTED into the union (F1.957's `OutsideRootCancelMessage`) is read in the
    // module that declares it; the import line itself is not a declaration (it made this read `undefined`).
    const declaration = unionMemberDeclaration(source, name!, sourcePath);
    expect(declaration, name).toBeDefined();
    const discriminant = declaration!.match(/type:\s*'([^']+)'/)?.[1];
    expect(discriminant, name).toBeDefined();
    values.push(discriminant!);
  }
  return values;
}

type RpcHandler = (ctx: any, ...args: any[]) => Promise<any>;

function createRpcHarness(sendMessage: (...args: any[]) => Promise<void>, overrides: Record<string, any> = {}) {
  const handlers = new Map<string, RpcHandler>();
  const pushes: any[][] = [];
  const server = {
    handle(channel: string, handler: RpcHandler) { handlers.set(channel, handler); },
    push(...args: any[]) { pushes.push(args); },
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const sessionManager = new Proxy({ sendMessage, ...overrides }, {
    get(target, property) {
      if (property in target) return (target as any)[property];
      return () => undefined;
    },
  });
  registerSessionsHandlers(server as never, { sessionManager, platform: { logger } } as never);
  const handler = handlers.get(RPC_CHANNELS.sessions.SEND_MESSAGE);
  expect(handler).toBeDefined();
  return { handler: handler!, pushes };
}

describe('adjacent backend frozen contract', () => {
  test('drives Nestor adapter, turn handoff, terminal suppression, and A2A envelopes', async () => {
    const data = fixture<any>('nestor-a2a.json');
    expect(data.schemaVersion).toBe(2);
    expect([...NESTOR_BUILTIN_TOOL_NAMES]).toEqual(data.builtInTools);
    expect([...NESTOR_TERMINAL_TOOL_NAMES]).toEqual(data.terminalTools);
    expect(data.builtinCases.map((entry: any) => entry.input.name)).toEqual(data.builtInTools);

    const adapter = new NestorCloudEventAdapter();
    adapter.startTurn();
    for (const entry of data.builtinCases) {
      const output = adapterToolOutput(adapter, entry.input);
      expect(output, entry.input.name).toBeDefined();
      const normalized = normalizeNestorToolCall(output.toolCall);
      expect(normalized).toMatchObject({
        kind: 'builtin',
        name: entry.input.name,
        builtinName: entry.input.name,
        args: entry.expectedArgs,
      });
      expect(toLocalToolCall(normalized), entry.input.name).toEqual(entry.expectedLocal);
      expect(output.terminal === true).toBe(entry.terminal);
      if (entry.terminal) {
        expect(output.startEvent).toBeUndefined();
      } else {
        expect(output.startEvent).toMatchObject({
          type: 'tool_start',
          toolName: entry.input.name,
          toolUseId: entry.input.id,
          input: entry.expectedArgs,
        });
      }
    }

    for (const example of [data.directMcp, data.useMcpTool]) {
      const output = adapterToolOutput(adapter, example.input);
      const normalized = normalizeNestorToolCall(output.toolCall);
      expect({
        kind: normalized.kind,
        name: normalized.name,
        server: normalized.mcp?.server,
        tool: normalized.mcp?.tool,
        proxyName: normalized.mcp?.proxyName,
        args: normalized.mcp?.args,
      }).toEqual(example.expected);
      expect(output.startEvent).toMatchObject({
        type: 'tool_start', toolName: example.input.name, toolUseId: example.input.id,
      });
    }

    for (const payload of Object.values(data.resultPayloads) as any[]) {
      expect(buildA2AToolResultData(payload.input)).toEqual(payload.expected);
      expect(buildToolResultPart(payload.input)).toEqual({ data: payload.expected });
    }

    const client = new FixtureNestorClient();
    client.messageStreams.push(stream(data.turn.initialStream));
    client.toolStreams.push(stream(data.turn.continuationStream));
    const executed: any[] = [];
    const contextUpdates: any[] = [];
    const turn = new NestorCloudTurn({
      client: client as never,
      metadata: data.turn.metadata,
      executeTool: async (toolCall) => {
        executed.push(toolCall);
        return { content: data.turn.execution.content };
      },
      onContextUpdate: update => { contextUpdates.push(update); },
    });
    const events = await collectTurn(turn, data.turn.message);
    expect(client.loadCount).toBe(1);
    expect(events.map(event => event.type)).toEqual(data.turn.expected.eventTypes);
    expect(events.filter(event => event.type === 'text_delta').map(event => event.text))
      .toEqual(data.turn.expected.textDeltas);
    expect(events).toContainEqual(data.turn.expected.toolResultEvent);
    expect(executed).toEqual([{
      id: data.turn.execution.toolCallId,
      index: 0,
      name: data.turn.execution.toolName,
      arguments: '{"path":"/workspace"}',
    }]);
    expect(contextUpdates).toEqual(data.turn.expected.contextUpdates);
    expect(client.messageCalls).toEqual([data.turn.expected.messageCall]);
    expect(client.toolResultCalls).toEqual([data.turn.expected.toolResultCall]);

    // A terminal tool SUSPENDS the turn: nothing executes it, nothing answers it,
    // and the parked call rides the context sidecar until the next user prompt
    // becomes its `tool_result` (F5; CONNECTOR/src/core/turn.ts:340-357).
    for (const terminal of data.terminalHandoffs) {
      const terminalClient = new FixtureNestorClient();
      terminalClient.messageStreams.push(stream([
        { task: { id: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_SUBMITTED' } } },
        terminalStreamEvent(terminal.input),
      ]));
      const executed: unknown[] = [];
      const terminalUpdates: any[] = [];
      const terminalTurn = new NestorCloudTurn({
        client: terminalClient as never,
        executeTool: async (toolCall) => {
          executed.push(toolCall);
          return { content: 'must not be produced' };
        },
        onContextUpdate: update => { terminalUpdates.push(update); },
      });
      const terminalEvents = await collectTurn(terminalTurn, 'terminal');
      expect(executed, terminal.input.name).toEqual([]);
      expect(terminalClient.toolResultCalls, terminal.input.name).toEqual([]);
      expect(terminalEvents.some(event => event.type === 'tool_start' || event.type === 'tool_result')).toBe(false);
      expect(terminalEvents.filter(event => event.type === 'text_complete'))
        .toEqual([{ type: 'text_complete', text: terminal.expectedText }]);
      expect(terminalEvents.at(-1)).toEqual(terminal.expectedComplete);
      expect(terminalUpdates).toContainEqual(terminal.expectedContextUpdate);
      // input-required is not terminal: the task id survives so the answer can address it.
      expect(terminalUpdates.some((update: any) => update.clearTask === true)).toBe(false);
    }

    const answerClient = new FixtureNestorClient();
    answerClient.toolStreams.push(stream([completedStreamEvent('acknowledged')]));
    const answerUpdates: any[] = [];
    const answerTurn = new NestorCloudTurn({
      client: answerClient as never,
      contextId: 'ctx-1',
      taskId: 'task-1',
      answerToolCall: {
        toolCallId: data.terminalHandoffs[0].input.id,
        name: data.terminalHandoffs[0].input.name,
      },
      onContextUpdate: update => { answerUpdates.push(update); },
    });
    await collectTurn(answerTurn, data.terminalAnswer.prompt);
    expect(answerClient.messageCalls).toEqual([]);
    expect(answerClient.toolResultCalls).toEqual([data.terminalAnswer.expectedToolResultCall]);
    expect(answerUpdates).toContainEqual({ clearPendingTerminalTool: true });
  });

  test('pins every AgentEvent branch and drains the fixture lifecycle through EventQueue', async () => {
    const data = fixture<any>('agent-events.json');
    expect(data.schemaVersion).toBe(2);
    const currentTypes = Object.keys(EVENT_FIELDS) as AgentEvent['type'][];
    expect(data.variants.map((variant: { type: string }) => variant.type)).toEqual(currentTypes);

    const source = sourceAt('packages/core/src/types/message.ts');
    for (const variant of data.variants as Array<{
      type: AgentEvent['type'];
      requiredFields: string[];
      optionalFields: string[];
    }>) {
      const expected = EVENT_FIELDS[variant.type];
      expect(variant.requiredFields).toEqual([...expected.required]);
      expect(variant.optionalFields).toEqual([...expected.optional]);
      expect(agentEventFields(source, variant.type), variant.type).toEqual({
        required: [...expected.required],
        optional: [...expected.optional],
      });
    }
    for (const isolation of data.variantIsolation) {
      const branch = agentEventBranch(source, isolation.type);
      for (const field of isolation.fieldsOwnedByOtherVariants) {
        expect(branch, `${isolation.type} must not borrow ${field}`).not.toMatch(new RegExp(`\\b${field}\\??:`));
      }
    }

    const lifecycle = data.lifecycleEvents as AgentEvent[];
    expect(lifecycle.map(event => event.type)).toEqual(data.lifecycleOrder);
    expect(await drainQueue(lifecycle)).toEqual(lifecycle);
  });

  test('carries an optional terminal reason on complete without changing success', () => {
    // A successful turn must be byte-identical to today: no reason field at all.
    const success: EventFor<'complete'> = { type: 'complete', usage: { inputTokens: 1, outputTokens: 1 } };
    expect('terminalReason' in success).toBe(false);

    // A capped turn names the reason from the existing AbortReason vocabulary.
    const capped: EventFor<'complete'> = { type: 'complete', terminalReason: AbortReason.MaxBudgetUsd };
    expect(capped.terminalReason).toBe('max_budget_usd');
  });

  test('pins AgentTerminalReason to the AbortReason enum', () => {
    // core cannot import shared, so nothing but this test stops the two from drifting.
    const fromEnum = Object.values(AbortReason).sort();
    expect(TERMINAL_REASON_VALUES.slice().sort()).toEqual(fromEnum);
  });

  test('pins provider mappings, env-gated availability, and safe backend construction', async () => {
    const data = fixture<any>('rpc-and-backends.json');
    expect(data.schemaVersion).toBe(2);
    expect(data.backendFactory.availabilityEnvKeys).toEqual([...FEATURE_ENV_KEYS]);
    const probeScript = `
      const data = ${JSON.stringify(data.backendFactory)};
      const factory = await import('./packages/shared/src/agent/backend/factory.ts');
      // Readiness line, announced BEFORE anything is constructed: the harness waits
      // for this instead of guessing a bound for a cold module graph (P6.900).
      process.stderr.write('${PROBE_READY_MARKER}\\n');
      const envKeys = data.availabilityEnvKeys;
      const original = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
      const availability = [];
      try {
        for (const entry of data.availabilityCases) {
          for (const key of envKeys) {
            const value = entry.env[key];
            if (value === null || value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
          availability.push({ name: entry.name, providers: factory.getAvailableProviders() });
        }
      } finally {
        for (const key of envKeys) {
          const value = original[key];
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      const constructions = [];
      for (const [index, entry] of data.constructions.entries()) {
        const workspaceId = 'adjacent-workspace-' + index;
        const agent = factory.createBackend({
          provider: entry.provider,
          model: entry.model,
          isHeadless: true,
          workspace: {
            id: workspaceId,
            workspaceRootPath: '/fixture/' + workspaceId,
            sessionRootPath: '/fixture/sessions/' + workspaceId,
            config: { id: workspaceId, name: workspaceId, createdAt: 1, updatedAt: 1 },
            lastAccessedAt: 1,
          },
          session: {
            id: 'adjacent-session-' + index,
            workspaceId,
            createdAt: 1,
            lastUsedAt: 1,
            permissionMode: 'ask',
          },
        });
        try {
          constructions.push({
            className: agent.constructor.name,
            provider: agent.config.provider,
            model: agent.config.model,
            processingBefore: agent.isProcessing(),
            idleRedirectAccepted: agent.redirect('fixture redirect'),
            processingAfter: agent.isProcessing(),
          });
          await agent.abort('fixture cleanup');
        } finally {
          agent.destroy();
        }
      }
      const mappings = data.mappings.map(entry => ({
        providerType: entry.providerType,
        agentProvider: factory.providerTypeToAgentProvider(entry.providerType),
      }));
      process.stdout.write('__ADJACENT_RESULT__' + JSON.stringify({ mappings, availability, constructions }) + '\\n');
      process.exit(0);
    `;
    const probe = await boundedProcess([
      process.execPath,
      '--no-env-file',
      '--no-install',
      '-e',
      probeScript,
    ], {
      readyMarker: PROBE_READY_MARKER,
      readyTimeoutMs: PROBE_READY_TIMEOUT_MS,
      workTimeoutMs: PROBE_WORK_TIMEOUT_MS,
    });
    if (probe.exitCode !== 0) throw new Error(probe.stderr);
    const resultLine = probe.stdout.split('\n').find(line => line.startsWith('__ADJACENT_RESULT__'));
    expect(resultLine).toBeDefined();
    const observed = JSON.parse(resultLine!.slice('__ADJACENT_RESULT__'.length));
    expect(observed.mappings).toEqual(data.backendFactory.mappings);
    expect(observed.availability).toEqual(data.backendFactory.availabilityCases.map((entry: any) => ({
      name: entry.name,
      providers: entry.expected,
    })));
    expect(observed.constructions).toEqual(data.backendFactory.constructions.map((entry: any) => entry.expectedBehavior));
    // What this case can honestly bound is the WORK, not the module graph: the
    // import's duration is I/O and asserting it is what made the case red at every
    // load. The per-test timer is derived from the two windows plus spawn headroom
    // so that raising one bound without the other — the register's own warning —
    // is no longer possible.
    expect(probe.workMs).toBeLessThan(PROBE_WORK_TIMEOUT_MS);
    // Printed, not asserted: three lanes have now hand-measured this import to
    // set a bound. A run of the suite reports its own two phases so the fourth
    // does not have to (P6.900).
    console.error(`[adjacent-backend probe] module graph ready in ${probe.readyAtMs} ms, work ${probe.workMs} ms`);
  }, PROBE_READY_TIMEOUT_MS + PROBE_WORK_TIMEOUT_MS + 60_000);

  test('binds every Pi JSONL discriminant and all six permission modes to production behavior (F1.1050 retired explore)', () => {
    const runtime = JSON.parse(sourceAt('packages/pi-agent-server/src/__tests__/harness-contract/fixtures/runtime-behavior.json'));
    const piSource = sourceAt(PI_SERVER_INDEX);
    // P3.272's PAIR re-frozen into the fixture 2026-09-03, both halves — the
    // outbound `denied_paths_request` (`index.ts:551`, sent at `:2670`) and the
    // inbound `denied_paths_response` (`:384`, handled at `:5119`, sent from two
    // `pi-agent.ts` sites), all from `36bf207fe`, with
    // `pi-denied-result-paths.test.ts` driving the round trip. Owned and driven,
    // so the golden lagged the protocol rather than hiding an unhandled message.
    // Worth noting for the next re-freeze: the two assertions below are separate
    // `expect`s, so the first one's failure MASKED the second, and one commit's
    // request/response pair reads as two unrelated drifts one run apart.
    // F1.285 re-froze the inbound `cancel_ephemeral_query` (F1.239, `862a4f0fe`),
    // driven end to end by `pi-agent-server/src/__tests__/ephemeral-query-routing-
    // real-server.test.ts`; the fixture spells it on the `llm_query` line, as
    // `index.ts` does, and F1.302's split is what lets the union half see it there.
    // UB12.59 re-froze outbound `tool_execute_detached` (UB2.10, `cf31de0ce`): owned, and driven by pi-detached-tool-survives-stop.
    expect(protocolDiscriminants(piSource, 'InboundMessage', PI_SERVER_INDEX)).toEqual(runtime.jsonl.inbound);
    expect(protocolDiscriminants(piSource, 'OutboundMessage', PI_SERVER_INDEX)).toEqual(runtime.jsonl.outbound);
    const switchStart = piSource.indexOf('async function processMessage(msg: InboundMessage)');
    const switchEnd = piSource.indexOf('\n}\n\nfunction main()', switchStart);
    expect([...piSource.slice(switchStart, switchEnd).matchAll(/case '([^']+)'/g)]
      .map(match => match[1])).toEqual(runtime.jsonl.inbound);

    const data = fixture<any>('rpc-and-backends.json');
    expect(PERMISSION_MODE_ORDER).toEqual(data.permissionModes.map((entry: any) => entry.mode));
    const permissionManager = {
      isCommandWhitelisted: () => false,
      isDangerousCommand: () => false,
      getBaseCommand: (command: string) => command.trim().split(/\s+/)[0] ?? '',
      extractDomainFromNetworkCommand: () => null,
      isDomainWhitelisted: () => false,
      getCapabilityPermissionsContext: () => null,
    };
    // `/fixture/out.txt` sits outside both the working directory and the workspace
    // root, so `acceptEdits` prompts rather than auto-approving: its auto-approval
    // is bounded by the session's roots plus any configured additional directory
    // (`accept-edits-scope.test.ts` pins the in-root half).
    for (const entry of data.permissionModes) {
      const sessionKey = { workspaceId: 'adjacent-permissions', sessionId: `mode-${entry.mode}` };
      initializeModeState(sessionKey, entry.mode);
      try {
        const outcome = runPreToolUseChecks({
          toolName: 'Write',
          input: { file_path: '/fixture/out.txt', content: 'value' },
          sessionId: sessionKey.sessionId,
          sessionKey,
          permissionMode: entry.mode,
          workspaceRootPath: '/fixture/workspace',
          workspaceId: sessionKey.workspaceId,
          workingDirectory: '/fixture/project',
          activeSourceSlugs: [],
          allSourceSlugs: [],
          hasSourceActivation: false,
          permissionManager,
        });
        expect(PERMISSION_MODE_TO_CANONICAL[entry.mode as PermissionMode]).toBe(entry.canonical);
        expect(PERMISSION_MODE_AGENT_LABELS[entry.mode as PermissionMode]).toBe(entry.displayName);
        expect(outcome.type, entry.mode).toBe(entry.writeOutcome);
      } finally {
        cleanupModeState(sessionKey);
      }
    }
  });

  test('pins provider midstream defaults and explicit overrides through production exports', () => {
    const data = fixture<any>('rpc-and-backends.json');
    for (const entry of data.midstream.defaults) {
      expect(defaultMidStreamBehavior(entry.providerType), entry.providerType).toBe(entry.behavior);
      expect(resolveMidStreamBehavior({ providerType: entry.providerType }), entry.providerType)
        .toBe(entry.behavior);
    }
    for (const entry of data.midstream.overrides) {
      expect(resolveMidStreamBehavior({
        providerType: entry.providerType,
        midStreamBehavior: entry.configured,
      }), `${entry.providerType}:${entry.configured}`).toBe(entry.expected);
    }
    expect(sourceAt('packages/server-core/src/sessions/SessionManager.ts'))
      .toContain("const behavior = connection ? resolveMidStreamBehavior(connection) : 'steer'");
  });

  test('invokes registered SEND_MESSAGE with workspace scoping, legacy args, ack, and routing', async () => {
    const data = fixture<any>('rpc-and-backends.json');
    expect(data.sendMessage.rpcMethod).toBe('SEND_MESSAGE');

    const rejected = createRpcHarness(async () => undefined);
    await expect(rejected.handler({ clientId: 'client-no-workspace' }, 'session', 'message'))
      .rejects.toThrow(data.sendMessage.workspaceError);

    const legacyCalls: any[][] = [];
    const legacy = createRpcHarness(async (...args: any[]) => {
      legacyCalls.push(args);
      args[7](data.sendMessage.legacyCall.acknowledgement.messageId);
    });
    const legacyAck = await legacy.handler(
      data.sendMessage.context,
      data.sendMessage.legacyCall.sessionId,
      data.sendMessage.legacyCall.message,
    );
    expect(legacyAck).toEqual(data.sendMessage.legacyCall.acknowledgement);
    const legacyCall = legacyCalls[0]!;
    expect({
      sessionId: legacyCall[0],
      message: legacyCall[1],
      attachments: legacyCall[2] ?? null,
      storedAttachments: legacyCall[3] ?? null,
      options: legacyCall[4] ?? null,
      hasAck: typeof legacyCall[7] === 'function',
      routing: legacyCall[8],
      modelMessage: legacyCall[9] ?? null,
    }).toEqual({
      sessionId: data.sendMessage.legacyCall.sessionId,
      message: data.sendMessage.legacyCall.message,
      attachments: null,
      storedAttachments: null,
      options: data.sendMessage.midstreamDefault.forwardedOptions,
      hasAck: true,
      routing: data.sendMessage.legacyCall.expectedRouting,
      modelMessage: null,
    });
    expect(data.sendMessage.midstreamDefault.inputOptions).toBeNull();
    expect(data.sendMessage.midstreamDefault.execution).toContain('preserves undefined options');
    expect(data.sendMessage.midstreamDefault.behavior).toBe('provider-resolved; no-connection fallback steer');

    const slash = data.sendMessage.customSlashCall;
    const slashCalls: any[][] = [];
    const resolvedKeys: any[] = [];
    const modelUpdates: any[] = [];
    const stagedCalls: any[] = [];
    const slashHarness = createRpcHarness(async (...args: any[]) => {
      slashCalls.push(args);
      args[7](slash.acknowledgement.messageId);
    }, {
      resolveCustomSlashCommand: async (key: any, commandId: string) => {
        resolvedKeys.push({ key, commandId });
        return slash.resolved;
      },
      updateSessionModel: async (...args: any[]) => { modelUpdates.push(args); },
      resolveStagedAttachments: (...args: any[]) => {
        stagedCalls.push(args);
        return slash.storedAttachments;
      },
    });
    const slashAck = await slashHarness.handler(
      data.sendMessage.context,
      slash.sessionId,
      slash.message,
      undefined,
      slash.attachmentRefs,
      undefined,
      slash.customSlashCommandId,
    );
    expect(slashAck).toEqual(slash.acknowledgement);
    expect(resolvedKeys).toEqual([{ key: data.sessionKey, commandId: slash.customSlashCommandId }]);
    expect(modelUpdates).toEqual([[slash.sessionId, data.sessionKey.workspaceId, slash.resolved.model]]);
    expect(stagedCalls).toEqual([[
      data.sendMessage.context.clientId,
      slash.sessionId,
      data.sessionKey.workspaceId,
      slash.attachmentRefs.map((attachment: any) => attachment.handleId),
    ]]);
    // Visible message = the resolved label + the preserved invocation-tail
    // arguments (A6); the model body has no literal $ARGUMENTS token so it is
    // sent unchanged.
    expect(slashCalls[0]![1]).toBe(`${slash.resolved.label} ${slash.message}`);
    expect(slashCalls[0]![3]).toEqual(slash.storedAttachments);
    expect(slashCalls[0]![8]).toEqual({
      callerClientId: data.sendMessage.context.clientId,
      workspaceId: data.sessionKey.workspaceId,
    });
    expect(slashCalls[0]![9]).toBe(slash.resolved.body);

    const postPersist = createRpcHarness(async (...args: any[]) => {
      args[7]('message-post-persist');
      throw new Error(data.sendMessage.postPersistRouting.error);
    });
    expect(await postPersist.handler(
      data.sendMessage.context,
      data.sendMessage.legacyCall.sessionId,
      data.sendMessage.legacyCall.message,
    )).toEqual({ accepted: true, messageId: 'message-post-persist' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(postPersist.pushes.map(([channel, target, event]) => ({ channel, target, type: event.type })))
      .toEqual(data.sendMessage.postPersistRouting.eventTypes.map((type: string) => ({
        channel: RPC_CHANNELS.sessions.EVENT,
        target: data.sendMessage.postPersistRouting.target,
        type,
      })));
  });
});

/**
 * F1.302 — the members of a union's right-hand side, split on every `|` at nesting
 * depth 0. Comments are dropped; string literals and anything inside `{}`, `[]`,
 * `()` or `<>` (an arrow's `=>` is not a bracket) stay whole, so `'allow' | 'block'`
 * inside a member never splits it and two members on one line always do. Each
 * member comes back trimmed, without its `|` and without a trailing `;`.
 */
function topLevelUnionMembers(text: string): string[] {
  const members: string[] = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '/' && text[i + 1] === '/') {
      const eol = text.indexOf('\n', i);
      i = eol < 0 ? text.length : eol - 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? text.length : close + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      current += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if ('{[(<'.includes(ch)) depth++;
    else if ('}])'.includes(ch) || (ch === '>' && text[i - 1] !== '=')) depth--;
    if (ch === '|' && depth === 0) {
      members.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  members.push(current);
  return members.map(member => member.trim().replace(/;$/, '').trim()).filter(member => member.length > 0);
}

describe('protocolDiscriminants (F1.302)', () => {
  test('reads every top-level union member: two on one line, a multi-line object, a nested pipe and a comment', () => {
    // The shape `862a4f0fe` wrote into `InboundMessage` — a second member on the
    // `llm_query` line — is the third line of the union. The newline-then-`|`
    // split this replaced answered ['named', 'one', 'two', 'four'] here.
    const source = [
      'type Probe =',
      '  | NamedProbe',
      "  | { type: 'one'; mode: 'a' | 'b'; cb?: (x: string) => void }",
      "  /** a comment | with a pipe, and an apostrophe's */",
      "  | { type: 'two'; id: string } | { type: 'three'; id: string }",
      '  | {',
      "      type: 'four';",
      "      items: Array<{ kind: 'x' | 'y' }>;",
      '    };',
      '',
      "interface NamedProbe { type: 'named'; }",
      '',
    ].join('\n');
    expect(protocolDiscriminants(source, 'Probe')).toEqual(['named', 'one', 'two', 'three', 'four']);
  });
});

describe('protocolDiscriminants (F1.1078)', () => {
  // F1.957 put `OutsideRootCancelMessage` into the Pi server's `OutboundMessage` union while declaring it in
  // `local-tools/outside-root-call-end.ts`; the reader took the IMPORT line for its declaration and read `undefined`.
  const importedProbe = [
    "import { bindOutsideRootRequestToCall, type OutsideRootCancelMessage } from './local-tools/outside-root-call-end.ts';",
    'type Probe =',
    '  | OutsideRootCancelMessage',
    "  | { type: 'inline' };",
    '',
    '',
  ].join('\n');

  test('reads an imported member in the module that declares it, resolved from the importing file', () => {
    expect(protocolDiscriminants(importedProbe, 'Probe', PI_SERVER_INDEX)).toEqual(['outside_root_cancel', 'inline']);
  });

  test('an import line is not a declaration: with no importing path to follow, the member stays unresolved', () => {
    expect(() => protocolDiscriminants(importedProbe, 'Probe')).toThrow('OutsideRootCancelMessage');
  });
});

const PI_SERVER_INDEX = 'packages/pi-agent-server/src/index.ts';

/**
 * F1.1078 — the declaration of a named union member, as text up to the next blank line. A declaration is a statement
 * at the start of a line (`interface X`, `type X =`, optionally exported); an import's `type X` is not one. A name
 * declared nowhere in `source` is followed ONE hop through the relative import that names it, resolved from
 * `sourcePath` (repo-relative), and read in that module. Undefined when neither finds it.
 */
function unionMemberDeclaration(source: string, name: string, sourcePath?: string): string | undefined {
  const declaredIn = (text: string): string | undefined => {
    const start = text.search(new RegExp(`^(?:export )?(?:interface|type) ${name}(?:\\s|=|<)`, 'm'));
    if (start < 0) return undefined;
    const end = text.indexOf('\n\n', start);
    return text.slice(start, end < 0 ? undefined : end);
  };
  const local = declaredIn(source);
  if (local !== undefined || sourcePath === undefined) return local;
  const from = source.match(new RegExp(`import (?:type )?\\{[^}]*\\b${name}\\b[^}]*\\} from '(\\.[^']+)'`))?.[1];
  return from === undefined ? undefined : declaredIn(readFileSync(resolve(repoRoot, dirname(sourcePath), from), 'utf8'));
}
