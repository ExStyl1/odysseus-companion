/**
 * P3.11 — what a CODEX client actually receives for a refusal.
 *
 * T6 measured the defect on the live app
 * (`docs/testing/cdp-runs/2026-08-23-t6-codex-scheduling.md`): a `Monitor` deny
 * was ENFORCED (no watch started, the rule named in the host's error) and the
 * model was told `{}` — twice, in two fresh sessions, after which it reported a
 * watch "started successfully". Four of the eight measured replies arrived as
 * `{}` or as a confabulated JSON shape, while the ones carrying host-generated
 * ids arrived intact.
 *
 * The seam is codex's own MCP-result conversion, read verbatim at the tag this
 * repo pins (`packages/codex-protocol/manifest.json` → `rust-v0.148.0`),
 * `codex-rs/protocol/src/models.rs`, `CallToolResult::as_function_call_output_payload`:
 *
 *   if let Some(structured_content) = &self.structured_content
 *       && !structured_content.is_null()
 *   { ... return FunctionCallOutputBody::Text(serialized_structured_content) }
 *   // only then is `content` serialized
 *
 * The test is `is_null()`, not "is empty": an EMPTY `structuredContent` is a
 * present one, so `structuredContent: {}` — which every `successResponse` and
 * `errorResponse` used to carry — replaced the reply text with the two
 * characters `{}`. That is the whole defect, and it explains the measured
 * split: the replies that survived are exactly the ones whose handler filled
 * `structuredContent` with the record.
 *
 * These rows drive the REAL `session-mcp-server` subprocess over MCP stdio
 * against the REAL host bridge (the T5 harness), and then put the raw
 * `CallToolResult` through `codexFunctionCallOutput()` below — the same rule,
 * transcribed — so what is asserted is what the MODEL is handed, not what the
 * host meant to say.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChildPool, type PooledRpcResponse } from './__tests__/child-pool.ts';
import type {
  SessionCronPort,
  SessionGoalPort,
  SessionMonitorPort,
} from '@nessy-agent/session-tools-core';
import {
  startCodexSessionCallbackBridge,
  type CodexSessionCallbackBridgeHandle,
} from '@nessy-agent/shared/agent/backend/codex/session-callback-bridge';
import { describePermissionDslMatch } from '@nessy-agent/shared/agent/pi-harness/permission-dsl';

const SESSION_ID = 'codex-reply-fidelity-session';

/**
 * P2.470 — this was a HARD-CODED refusal sentence, and it had gone two
 * generations stale: `permission rule "t6-no-tail" (workspace)`, where the host
 * has said ``permission rule `t6-no-tail` (workspace scope)`` since every
 * refusal moved onto `describePermissionDslMatch`.
 *
 * The row that found it called it a golden nothing calls. That is not the
 * defect. It IS called — `fakePorts` throws it and the Monitor row asserts it —
 * but **the harness throws the very string it then asserts, so the assertion is
 * a TAUTOLOGY with respect to the format** and could never have caught the
 * drift. A stale literal that cannot fail is not a weak test; inside a test file
 * it is documentation of a sentence that no longer exists, and every reader
 * takes it for the host's current wording.
 *
 * So the format claim is DELETED FROM HERE and left with its owner. The clause
 * comes from the host's own describer, which means no literal in this file can
 * go stale again; the SENTENCE around it is pinned against the real producer by
 * `permission-refusal-names-rule.test.ts`, which drives `authorizeMonitorCommand`
 * through the production parse-and-merge and asserts the whole thrown message —
 * including the id-fallback branch this rule uses. This file's subject is
 * codex's `structuredContent` conversion, and the wire is what its rows assert.
 *
 * Calling the describer on a literal match is not a hand-built policy: nothing
 * here is handed to an evaluator, and no rule id is asserted that a user would
 * not get. The values are T6's own — an author-written rule whose id IS what the
 * author wrote, which is exactly the describer's id-fallback branch.
 *
 * Imported by subpath rather than off `@nessy-agent/shared/agent` on purpose:
 * this is a wire test that already spawns two real processes, and the barrel
 * would pull the whole agent surface into the harness for one string.
 */
const T6_RULE_CLAUSE = describePermissionDslMatch({
  ruleId: 't6-no-tail',
  scope: 'workspace',
  sourceDigest: 't6-measured-source',
});

/**
 * The whole sentence the fake port throws: harness INPUT, not a claim about the
 * host's format. Its clause half is live, so a format move carries it along.
 */
const T6_DENY = `Monitor command watch was denied by permission ${T6_RULE_CLAUSE}.`;

interface McpContentBlock {
  type: string;
  text?: string;
  _meta?: Record<string, unknown>;
}

interface McpCallToolResult {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** This file's reply shape; the pool is generic in exactly this (P6.908). */
type RpcResponse = PooledRpcResponse<McpCallToolResult & { tools?: Array<{ name: string }> }>;

/**
 * `convert_mcp_content_to_items` (models.rs:2172-2276) sets `saw_content_item`
 * for exactly three block kinds: an image (2232), an audio (2259), and a TEXT
 * block whose `_meta` carries `codex/encryptedContent: true` (2219). A plain
 * text block does not set it (2224) — that is the whole point of the flag.
 */
function setsSawContentItem(block: McpContentBlock): boolean {
  if (block.type === 'image' || block.type === 'audio') return true;
  return block.type === 'text' && block._meta?.['codex/encryptedContent'] === true;
}

/**
 * A fake codex client: `CallToolResult` → the `function_call_output` the model
 * is handed, per `as_function_call_output_payload` (models.rs:2114-2165, cited
 * in the file header) and its helper `convert_mcp_content_to_items`, both read
 * verbatim at the pinned tag. Three branches, in upstream's order:
 *
 *  1. any ENCRYPTED content item wins outright, before `structured_content` is
 *     even read (2116-2125);
 *  2. a present, non-null `structured_content` → its JSON, INSTEAD of `content`
 *     (2127-2144) — the defect this task fixed;
 *  3. otherwise `serde_json::to_string(&self.content)` (2146/2158), because
 *     `convert_mcp_content_to_items` returns `Some(items)` only
 *     `if saw_content_item` (2275) and a TEXT-ONLY result therefore returns
 *     `None`. So the model is handed the whole content ARRAY as JSON —
 *     `[{"type":"text","text":"[ERROR] …"}]`, inner quotes `\"`-escaped — and
 *     NOT the joined block texts. Every row below lands in this branch;
 *     asserting on joined texts would have been asserting on an idealization.
 *
 * `success` is upstream's flag, recorded for the record and deliberately NOT
 * what any row leans on: upstream's own `Serialize` impl (2065-2075) writes the
 * body and nothing else, so the `[ERROR]` prefix inside the text is the only
 * carrier that reaches the model.
 */
function codexFunctionCallOutput(result: McpCallToolResult | undefined): {
  text: string;
  success: boolean;
} {
  const success = result?.isError !== true;
  const content = result?.content ?? [];
  if (content.some(setsSawContentItem)) {
    // Upstream would build a `ContentItems` body here. No session tool emits an
    // image, an audio, or an encrypted block, so the harness refuses to guess a
    // wire shape it has never observed rather than assert against an invented one.
    throw new Error(
      'a content-item block reached the harness — transcribe that branch before asserting on it',
    );
  }
  const structured = result?.structuredContent;
  if (structured !== undefined && structured !== null) {
    return { text: JSON.stringify(structured), success };
  }
  return { text: JSON.stringify(content), success };
}

/** The texts a reader recovers from a branch-3 payload, escaping undone. */
function textBlocksOf(payload: string): string[] {
  return (JSON.parse(payload) as McpContentBlock[])
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '');
}

/**
 * ONE child per distinct argv for the WHOLE FILE, instead of one per case
 * (P6.901).
 *
 * This server's boot is a cold, I/O-bound module graph — 28.3–46.6 s in a direct
 * probe and 70 689 ms under `bun test` at load 12.8 (P6.893's measurements) — and
 * these five cases paid it five times for five children that were spawned with
 * the SAME argv. They now share one.
 *
 * WHAT THESE CASES ARE NO LONGER ISOLATED FROM, stated because sharing a child
 * is a real trade and an unstated one is a trap:
 *  - the WORKSPACE directory, the plans folder and the config root, now created
 *    once for the file rather than once per case;
 *  - the SERVER PROCESS, so anything `index.ts` keeps between requests is carried
 *    between cases. Every tool these cases call is proxied to the host ports
 *    below, so none of them writes server-local state;
 *  - the BRIDGE, one per file on a stable port — the port is in the child's argv,
 *    so a per-case bridge is a per-case child.
 * What stays PER CASE is the thing that would make a shared child dishonest: the
 * host ports themselves. `resolvePorts` is consulted per REQUEST, so `beforeEach`
 * installs a fresh `fakePorts` and every refusal, every id and every recorded
 * call a case reads is its own. A case does not return until every id it asked
 * for has answered, so a call raised by an earlier case cannot land on a later
 * case's ports — which is the property the per-case SIGKILL used to buy.
 */
const pool = createChildPool<RpcResponse['result']>();

/** Run one exchange on the child that owns this argv, and answer by CALLER id. */
const runMcpSession = (args: string[], requests: object[]) => pool.runMcpSession(args, requests);

/**
 * The host's ports. `monitor.start` REFUSES with T6's text — a thrown gate
 * refusal is what the real Monitor gate does on a deny, and the bridge turns it
 * into `200 { error }` for the tool to re-throw as its own failure text.
 */
function fakePorts(options: { withGoal: boolean }) {
  const cronPort: SessionCronPort = {
    create: async input => ({
      id: 'ab12cd34',
      schedule: input.schedule ?? 'dynamic',
      recurring: input.recurring,
      prompt: input.prompt,
    }),
    list: async () => [],
    remove: async () => true,
  };
  const monitorPort: SessionMonitorPort = {
    start: async () => {
      throw new Error(T6_DENY);
    },
    stop: async () => true,
  };
  const goalPort: SessionGoalPort = {
    execute: async args => ({ schemaVersion: 1, goal: { id: 'goal-77', revision: 1, ...(args as object) } }),
  };
  return {
    cronPort,
    monitorPort,
    ...(options.withGoal ? { goalPort } : {}),
  };
}

let bridge: CodexSessionCallbackBridgeHandle | undefined;
let workspace: string;
/** Replaced per case; the bridge reads it per request. */
let ports: ReturnType<typeof fakePorts> = fakePorts({ withGoal: true });

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'smcp-fidelity-'));
  bridge = await startCodexSessionCallbackBridge({
    sessionKey: { workspaceId: 'ws-1', sessionId: SESSION_ID },
    resolvePorts: () => ports,
  });
});

beforeEach(() => {
  ports = fakePorts({ withGoal: true });
});

afterAll(async () => {
  await pool.killAll();
  await bridge?.close();
  bridge = undefined;
  rmSync(workspace, { recursive: true, force: true });
});

function spawnArgs(bridgePort?: number): string[] {
  return [
    '--session-id', SESSION_ID,
    '--workspace-root', workspace,
    '--plans-folder', join(workspace, 'plans'),
    '--config-root', workspace,
    '--external-standalone-only',
    ...(typeof bridgePort === 'number' ? ['--host-callback-port', String(bridgePort)] : []),
  ];
}

/**
 * The bridge and its port are the file's; what a case chooses is what sits
 * BEHIND it. `resolvePorts` is called per request, so swapping the ports here is
 * indistinguishable, from the child's side, from the per-case bridge this used
 * to start — and it keeps the port stable, which is what lets one child serve
 * every case.
 */
function usePorts(withGoal: boolean): number {
  ports = fakePorts({ withGoal });
  return bridge!.port;
}

describe('codex reply fidelity (real process, real bridge, model-facing payload)', () => {
  /**
   * The T6 case itself. What the model is handed must NAME the refusal — the
   * measured `{}` let a model report a watch it never started.
   */
  test('the T6 Monitor deny reaches the model as the rule text, not as {}', async () => {
    const port = usePorts(true);
    const responses = await runMcpSession(spawnArgs(port), [
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'Monitor', arguments: { description: 'T6 probe watch', command: 'tail -f /tmp/t6-probe.log' } } },
    ]);

    const raw = responses.get(2)?.result;
    expect(raw?.isError).toBe(true);
    const seen = codexFunctionCallOutput(raw);

    expect(seen.text).not.toBe('{}');
    expect(seen.text.includes('[ERROR]')).toBe(true);
    expect(seen.text).toContain('t6-no-tail');
    // The sentence is asserted after undoing upstream's JSON escaping rather
    // than against the raw payload. With the describer's current clause nothing
    // in it needs escaping — backticks and parentheses survive `JSON.stringify`
    // untouched, so a raw `toContain` would pass today — but the rule name is
    // operator data and the clause is not this file's to predict, so the reading
    // stays the one a model-facing reader actually does.
    //
    // What the row can still catch is the wire: `t6-no-tail` above is the
    // independent control that this assertion is reading the payload rather
    // than agreeing with itself, and it is what fails if the clause ever comes
    // back empty.
    expect(textBlocksOf(seen.text).join('\n')).toContain(T6_DENY);
    expect(seen.success).toBe(false);
  }, 330_000);

  /**
   * P2.2's review (I1) — the goal refusals ride the same wire. Two shapes:
   * the tool's own schema rejection, and the host's `Goal is unavailable`
   * (a bridge reply, not a local decision).
   */
  test('a schema-rejected Goal reaches the model as the reason, not as {}', async () => {
    const port = usePorts(true);
    const responses = await runMcpSession(spawnArgs(port), [
      // `complete` requires `evidence`; the union refuses it without one.
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'Goal', arguments: { action: 'complete', id: 'goal-77', revision: 1, reason: 'shipped it' } } },
    ]);

    const raw = responses.get(2)?.result;
    expect(raw?.isError).toBe(true);
    const seen = codexFunctionCallOutput(raw);

    expect(seen.text).not.toBe('{}');
    expect(seen.text).toContain('[ERROR]');
    expect(seen.text).toContain('Goal input is invalid');
    expect(seen.text).toContain('evidence');
  }, 330_000);

  test('the host bridge\'s "Goal is unavailable" reaches the model as text, not as {}', async () => {
    // The bridge is up, the session matches — only the goal port is missing,
    // which the host answers with its own refusal for the tool to re-throw.
    const port = usePorts(false);
    const responses = await runMcpSession(spawnArgs(port), [
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'Goal', arguments: { action: 'create', condition: 'Ship the retry' } } },
    ]);

    const raw = responses.get(2)?.result;
    expect(raw?.isError).toBe(true);
    const seen = codexFunctionCallOutput(raw);

    expect(seen.text).not.toBe('{}');
    expect(seen.text).toContain('[ERROR]');
    expect(seen.text).toContain('Goal is unavailable for this session.');
  }, 330_000);

  /**
   * The regression pin. T6 measured that the id-carrying success path already
   * works — the model read back `ab12cd34`-shaped ids it could not have
   * invented — so this row holds that reply BYTE-IDENTICAL: the same
   * `structuredContent` record, still winning over `content`, still the exact
   * JSON the model was handed before this fix.
   */
  test('the id-carrying success path is unchanged — structuredContent still wins', async () => {
    const port = usePorts(true);
    const responses = await runMcpSession(spawnArgs(port), [
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'CronCreate', arguments: { schedule: '0 9 * * *', prompt: 'daily standup' } } },
    ]);

    const raw = responses.get(2)?.result;
    expect(raw?.isError).toBeFalsy();
    expect(raw?.structuredContent).toEqual({
      task: { id: 'ab12cd34', schedule: '0 9 * * *', recurring: true, prompt: 'daily standup' },
    });
    expect(raw?.content?.[0]?.text).toBe(
      'Scheduled task ab12cd34: 0 9 * * * (recurring) — daily standup',
    );

    const seen = codexFunctionCallOutput(raw);
    expect(seen.text).toBe(
      '{"task":{"id":"ab12cd34","schedule":"0 9 * * *","recurring":true,"prompt":"daily standup"}}',
    );
    expect(seen.success).toBe(true);
  }, 330_000);

  /**
   * The property the whole row exists for: at the CLIENT, a refusal and a
   * success are not the same reply. Both are read through the same conversion,
   * in one session, so the comparison is between two payloads the model would
   * have received one after the other.
   */
  test('an isError reply is distinguishable from a success reply at the client', async () => {
    const port = usePorts(true);
    const responses = await runMcpSession(spawnArgs(port), [
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'Monitor', arguments: { description: 'T6 probe watch', command: 'tail -f /tmp/t6-probe.log' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'CronCreate', arguments: { schedule: '0 9 * * *', prompt: 'daily standup' } } },
    ]);

    const refused = codexFunctionCallOutput(responses.get(2)?.result);
    const succeeded = codexFunctionCallOutput(responses.get(3)?.result);

    expect(refused.text).not.toBe(succeeded.text);
    // `includes`, not `startsWith`: the refusal payload starts with `[{"type"`
    // — the content array's JSON — and carries the marker inside the text block.
    expect(refused.text.includes('[ERROR]')).toBe(true);
    expect(succeeded.text.includes('[ERROR]')).toBe(false);
    // Neither reply is the empty object that made them indistinguishable.
    expect(refused.text).not.toBe('{}');
    expect(succeeded.text).not.toBe('{}');
  }, 330_000);
});
