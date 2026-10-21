/**
 * T1a's PRIMARY GATE — `thread/inject_items` really is model-visible history.
 *
 * `docs/superpowers/plans/2026-08-20-cross-runtime-history-carry.md`, T1a. The
 * plan's earlier gate ("plant a fact, ask for it after a switch") **could not
 * fail**: it passes on today's build for any fact inside the 24 × 1200
 * character text handoff. What actually needs settling is the load-bearing
 * claim underneath the whole task — that items handed to the app-server over
 * `thread/inject_items` are put on the wire to the model as conversation, not
 * merely recorded in a rollout file nobody reads.
 *
 * So this drives the BUNDLED `codex-app-server` against a loopback Responses
 * provider and reads the request body it sends. Three properties, each of which
 * a weaker rig would have missed:
 *
 * 1. **Both injected items appear in `input`, in order, BEFORE the user's own
 *    message.** Order matters: a history the model reads after the question is
 *    not history.
 * 2. **A `thread/fork` after the inject does not lose them, and does not
 *    duplicate them.** Injected items survive a fork byte-identically — which
 *    is exactly why the agent must never "re-inject after a re-fork". This is
 *    the assertion that would catch such a change.
 * 3. **No `<turn_aborted>` developer message reaches the model.** The inject
 *    stamps its records with a synthetic `turn_id: "auto-compact-0"` it never
 *    closes, and a fork on top of an unclosed turn makes the app-server append
 *    "The previous turn was interrupted on purpose…" — a false statement about
 *    this conversation, and one the model would read.
 * 4. **T1b: a paired `function_call` + `function_call_output` round-trips,
 *    adjacent and in order, ahead of the new user message.** The first three
 *    tests cannot see a tool item at all — `flatten()` reads `content[].text`
 *    and a tool item has no `content` array — so the last test reads the raw
 *    items instead.
 *
 * **Gated on `NESSY_CODEX_E2E=1`, following `codex-e2e.test.ts`.** The bundled
 * binary is ~180 MB, untracked and gitignored (fetched by
 * `scripts/fetch-codex.mjs`), so a committed test that spawns it cannot run on
 * a fresh clone or in CI. Unlike `codex-e2e.test.ts` this one needs **no
 * network and no credentials** — the provider is a loopback stub — so it is
 * runnable by anyone who has run the fetch script:
 *
 *   NESSY_CODEX_E2E=1 bun test packages/shared/src/agent/__tests__/codex-inject-items-e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServerClient } from '@nessy-agent/codex-agent-server/app-server-client';
import { CodexRuntimeManager } from '@nessy-agent/codex-agent-server/runtime-manager';
import { writeCodexConfig, CODEX_API_KEY_ENV } from '@nessy-agent/codex-responses-adapter/config-writer';
import { startStubAdapter, type StubAdapterHandle } from '@nessy-agent/codex-responses-adapter/stub-server';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

const USER_SPAN = 'the fixture password is opal-lantern-77';
const ASSISTANT_SPAN = 'Noted — opal-lantern-77.';
const PROMPT = 'what was the fixture password?';

function platformKey(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
  return `${process.platform}-${arch}`;
}

function binaryPath(): string {
  const name = process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server';
  return join(REPO_ROOT, 'apps', 'electron', 'resources', 'bin', 'codex', platformKey(), name);
}

/** The exact mapping `buildCodexInjectItems` performs for a T1a text payload. */
const INJECT_ITEMS = [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: USER_SPAN }] },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: ASSISTANT_SPAN }] },
];

// ── T1b ─────────────────────────────────────────────────────────────────────
//
// The tool half. `TOOL_RESULT` is the fact whose ONLY source is a tool result —
// the plan's DONE criterion in one string — and `CALL_ID` is the join the two
// halves share.
const TOOL_NAME = 'Read';
const TOOL_ARGS = JSON.stringify({ file_path: './deploy.key' });
const TOOL_RESULT = 'DEPLOY_FINGERPRINT=jade-cinder-42';
const CALL_ID = 'nessy_handoff_e2e_tool';
const TOOL_PROMPT = 'what was the deploy fingerprint?';

/** What `buildCodexInjectItems` emits for one `kind: 'tool'` history entry. */
const INJECT_ITEMS_WITH_TOOL = [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: USER_SPAN }] },
  { type: 'function_call', name: TOOL_NAME, arguments: TOOL_ARGS, call_id: CALL_ID },
  { type: 'function_call_output', call_id: CALL_ID, output: TOOL_RESULT },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: ASSISTANT_SPAN }] },
];

interface ResponsesRequest {
  input?: Array<{
    type?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    // `function_call` / `function_call_output` carry no `content` array — their
    // payload is these three flat fields, which is why `flatten()` below cannot
    // see them and the tool test needs its own reader.
    name?: string;
    arguments?: string;
    call_id?: string;
    output?: unknown;
  }>;
}

/**
 * `turn/start` is fire-and-forget — the app-server answers before it has
 * spoken to the provider, and the turn settles through notifications. So the
 * request body arrives AFTER the RPC resolves, and a test that read `bodies`
 * straight afterwards would measure nothing at all (measured: it did).
 */
async function nextBody<T>(bodies: T[], before: number, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (bodies.length <= before) {
    if (Date.now() > deadline) {
      throw new Error(`the loopback provider received no request within ${timeoutMs}ms of turn/start`);
    }
    await new Promise(r => setTimeout(r, 25));
  }
  return bodies[before]!;
}

/** Every text fragment in one captured request, flattened in wire order. */
function flatten(body: ResponsesRequest): Array<{ role: string; text: string }> {
  const out: Array<{ role: string; text: string }> = [];
  for (const item of body.input ?? []) {
    for (const part of item.content ?? []) {
      if (typeof part.text === 'string') out.push({ role: item.role ?? '?', text: part.text });
    }
  }
  return out;
}

/**
 * D1.226 — the switch, said out loud.
 *
 * `describe.if(false)` reports `N skip` and NO REASON, so a developer who runs
 * this file alone sees a green run over nothing and cannot tell a deliberate
 * opt-in from a suite that was deleted or from one whose gate has rotted. The
 * other gate in this live-boot family already prints its own skip (the
 * `HAVE_BIN` detector in `codex-responses-adapter`'s `sandbox-enforcement`);
 * this is that shape for the env gate, and it is the ONLY arm of this file
 * that runs while the gate is off.
 */
const CODEX_E2E = process.env.NESSY_CODEX_E2E === '1';

describe('codex thread/inject_items live — the switch is visible', () => {
  test('runs only under NESSY_CODEX_E2E=1, and says why when it does not', () => {
    if (CODEX_E2E) {
      expect(CODEX_E2E).toBe(true);
      return;
    }
    console.warn(
      '[codex-e2e] SKIPPED codex-inject-items-e2e.test.ts: NESSY_CODEX_E2E is not "1". '
      + 'NOT verified in this run: injected items reaching the model, adjacent and in order. Run it with '
      + '`NESSY_CODEX_E2E=1 bun test ./packages/shared/src/agent/__tests__/codex-inject-items-e2e.test.ts`, '
      + 'or `bun scripts/codex-live-suites.ts`, which sets this gate for the whole '
      + 'live-boot family. It needs the staged codex-app-server '
      + '(`node scripts/fetch-codex.mjs`) and no network and no credentials.',
    );
    expect(CODEX_E2E).toBe(false);
  });
});

describe.if(CODEX_E2E)('thread/inject_items reaches the model (offline)', () => {
  let stub: StubAdapterHandle;
  let manager: CodexRuntimeManager;
  let client: AppServerClient;
  let codexHome = '';
  let workspace = '';
  const bodies: ResponsesRequest[] = [];
  /** F1.1225 — every `turn/completed` the app-server sent, by thread. */
  const completedTurns: string[] = [];

  /** Resolve once `threadId`'s turn has COMPLETED, not merely reached the provider. */
  async function turnCompleted(threadId: string | undefined, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!completedTurns.includes(threadId ?? '')) {
      if (Date.now() > deadline) throw new Error(`no turn/completed for thread ${threadId} within ${timeoutMs}ms`);
      await new Promise(r => setTimeout(r, 25));
    }
  }

  beforeAll(async () => {
    const bin = binaryPath();
    if (!existsSync(bin)) {
      throw new Error(`codex-app-server not found at ${bin}. Run: node scripts/fetch-codex.mjs`);
    }
    codexHome = mkdtempSync(join(tmpdir(), 'codex-inject-home-'));
    workspace = mkdtempSync(join(tmpdir(), 'codex-inject-ws-'));
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    writeFileSync(join(workspace, 'README.md'), '# inject fixture\n');
    execFileSync('git', ['-c', 'user.email=e2e@nessy', '-c', 'user.name=e2e', 'add', '-A'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.email=e2e@nessy', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: workspace });

    // The loopback Responses provider. `emitToolCall: false` keeps the turn to
    // ONE round trip: with a tool call codex would reach its approval path,
    // which has nobody to answer it here.
    stub = await startStubAdapter({
      model: MODEL,
      emitToolCall: false,
      onRequestBody: (raw) => {
        try { bodies.push(JSON.parse(raw) as ResponsesRequest); } catch { /* not JSON — ignored */ }
      },
    });
    // `wire_api = "responses"` + `base_url = http://127.0.0.1:<port>/v1`, from
    // the shipped writer rather than a hand-rolled TOML, so this run exercises
    // the configuration the product actually writes.
    writeCodexConfig({ codexHome, model: MODEL, adapterPort: stub.port });

    manager = new CodexRuntimeManager();
    const child = manager.spawn({
      binaryPath: bin,
      cwd: workspace,
      codexHome,
      env: { [CODEX_API_KEY_ENV]: 'loopback' },
      platformDir: platformKey(),
    });
    client = new AppServerClient(child, {
      onNotification: (method, params) => {
        const threadId = (params as { threadId?: unknown } | undefined)?.threadId;
        if (method === 'turn/completed' && typeof threadId === 'string') completedTurns.push(threadId);
      },
    });
    await client.request('initialize', {
      clientInfo: { name: 'nessy-codex-inject-e2e', title: null, version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    client.notify('initialized');
  }, 120_000);

  afterAll(async () => {
    try { client?.close(); } catch { /* already closed */ }
    await manager?.kill().catch(() => {});
    await stub?.close();
    if (codexHome) rmSync(codexHome, { recursive: true, force: true });
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  test('injected items ride the request, in order, ahead of the new user message', async () => {
    const started = await client.request('thread/start', { cwd: workspace, model: MODEL }) as { thread?: { id?: string } };
    const threadId = started.thread?.id;
    expect(threadId).toBeTruthy();

    // The inject itself: no network, no turn — it answers `{}`.
    const injected = await client.request('thread/inject_items', { threadId, items: INJECT_ITEMS });
    expect(injected).toEqual({});

    const before = bodies.length;
    await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: PROMPT, text_elements: [] }],
    });

    const texts = flatten(await nextBody(bodies, before));
    const joined = texts.map(t => t.text);
    const user = joined.findIndex(t => t.includes(USER_SPAN));
    const assistant = joined.findIndex(t => t.includes(ASSISTANT_SPAN));
    const prompt = joined.findIndex(t => t.includes(PROMPT));

    // 1 — both items are on the wire.
    expect(user).toBeGreaterThanOrEqual(0);
    expect(assistant).toBeGreaterThanOrEqual(0);
    expect(prompt).toBeGreaterThanOrEqual(0);
    // 2 — in order, and both BEFORE the question they are the history for.
    expect(user).toBeLessThan(assistant);
    expect(assistant).toBeLessThan(prompt);
    // 3 — with their roles preserved, not flattened into one user blob.
    expect(texts[user]!.role).toBe('user');
    expect(texts[assistant]!.role).toBe('assistant');
    // Negative control: the span crossed as HISTORY, not inside the prompt.
    expect(texts[prompt]!.text).not.toContain(USER_SPAN);
    expect(joined.some(t => t.includes('<runtime_handoff_context>'))).toBe(false);
  }, 120_000);

  /**
   * THE POSITIVE CONTROL for the ordering guard, and the reason the guard is a
   * guard rather than a preference.
   *
   * `thread/inject_items` stamps its records with
   * `internal_chat_message_metadata_passthrough: {"turn_id":"auto-compact-0"}`
   * and never closes that turn. Fork on top of it and the app-server concludes
   * a turn was abandoned, so it appends a `developer` message reading
   * `<turn_aborted> The previous turn was interrupted on purpose…` — and the
   * model reads it, about a conversation in which nothing was interrupted.
   *
   * AGENTS.md: *"A finding that is an ABSENCE needs a positive control."* The
   * next test asserts an absence of `turn_aborted`; this one makes it appear on
   * the same rig, so that absence means something.
   */
  test('POSITIVE CONTROL — forking AFTER an inject makes the app-server append a turn_aborted message', async () => {
    const started = await client.request('thread/start', { cwd: workspace, model: MODEL }) as { thread?: { id?: string } };
    const threadId = started.thread?.id;
    await client.request('thread/inject_items', { threadId, items: INJECT_ITEMS });

    const forked = await client.request('thread/fork', {
      threadId,
      cwd: workspace,
      model: MODEL,
    }) as { thread?: { id?: string } };
    const forkedId = forked.thread?.id;
    expect(forkedId).toBeTruthy();
    expect(forkedId).not.toBe(threadId);

    const before = bodies.length;
    await client.request('turn/start', {
      threadId: forkedId,
      input: [{ type: 'text', text: PROMPT, text_elements: [] }],
    });
    const joined = flatten(await nextBody(bodies, before)).map(t => t.text);

    // Injected items survive a fork BYTE-IDENTICALLY — exactly once each.
    // Which is precisely why "re-inject after the re-fork" would DUPLICATE the
    // span rather than restore it: nothing was lost to restore.
    expect(joined.filter(t => t.includes(USER_SPAN))).toHaveLength(1);
    expect(joined.filter(t => t.includes(ASSISTANT_SPAN))).toHaveLength(1);
    // And the hazard, live.
    expect(joined.filter(t => t.includes('turn_aborted'))).toHaveLength(1);
  }, 120_000);

  /**
   * The PRODUCT's ordering — the fork first (it belongs to
   * `applySelectedPluginSkillRuntimePolicy`, which runs when the config layer
   * or the model drifts), then the inject as the last RPC, then the turn.
   *
   * This is the shape `CodexAgent.chatImpl` produces on a switch followed by a
   * model change, and it is the one that must be clean.
   *
   * **A turn runs first, and that is not padding.** Measured here: `thread/fork`
   * on a thread that has never taken a turn answers
   * `no rollout found for thread id …` — there is nothing to fork. So the only
   * sequence in which a fork and an inject can meet at all is one where the
   * thread already has history, which is exactly the switch → model change →
   * turn case the plan asks about.
   */
  test('the product ordering — fork, then inject, then turn — carries the span with no turn_aborted', async () => {
    const started = await client.request('thread/start', { cwd: workspace, model: MODEL }) as { thread?: { id?: string } };
    const threadId = started.thread?.id;

    // Establish the rollout a fork needs.
    const seeded = bodies.length;
    await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
    });
    await nextBody(bodies, seeded);
    // F1.1225 — the request reaching the provider is not the turn ending. A fork
    // taken while the seeding turn still runs makes the app-server append a real
    // `<turn_aborted>` (CX-1 measured the case red that way on both 0.156.1 and
    // 0.159.3, intermittently, under load), so the rig waits for the turn's own
    // `turn/completed`, the signal a USER turn's sink closes on in the product.
    // Not every path waits for it: `CodexAgent.chatImpl`'s `/compact` arm closes
    // on the `thread/compact/start` RESPONSE, which lands before the compact
    // turn's `turn/started`, so the next turn head's re-fork CAN fork a running
    // compact turn (measured on 0.159.3, 2026-10-09: two `<turn_aborted>` in the
    // forked thread's request; the F1.1225 follow-up row owns the product side).
    await turnCompleted(threadId);

    const forked = await client.request('thread/fork', {
      threadId,
      cwd: workspace,
      model: MODEL,
    }) as { thread?: { id?: string } };
    const forkedId = forked.thread?.id;
    expect(forkedId).not.toBe(threadId);

    await client.request('thread/inject_items', { threadId: forkedId, items: INJECT_ITEMS });

    const before = bodies.length;
    await client.request('turn/start', {
      threadId: forkedId,
      input: [{ type: 'text', text: PROMPT, text_elements: [] }],
    });
    const joined = flatten(await nextBody(bodies, before)).map(t => t.text);

    expect(joined.filter(t => t.includes(USER_SPAN))).toHaveLength(1);
    expect(joined.filter(t => t.includes(ASSISTANT_SPAN))).toHaveLength(1);
    // The absence that matters, against a control that just produced its
    // presence two tests up.
    expect(joined.filter(t => t.includes('turn_aborted'))).toHaveLength(0);
  }, 120_000);

  /**
   * T1b's PRIMARY GATE — a paired `function_call` + `function_call_output`
   * round-trips to the model, adjacent and in order.
   *
   * The three tests above prove text history reaches the wire; none of them
   * touches a tool item, and none of them COULD: `flatten()` reads
   * `content[].text`, and a `function_call` has no `content` array at all. So
   * this one reads the raw items.
   *
   * What it settles, and what a weaker rig would miss:
   *
   * 1. The app-server **accepts** the pair (it answers `{}`) — probed at U4 on
   *    the installed 0.148.0 binary, asserted here on the bundled one.
   * 2. **Both halves reach the provider request body**, joined by the same
   *    `call_id`, ADJACENT and with the call before its output. An unpaired or
   *    reordered `function_call` in model-visible history is a hard provider
   *    error, which is why this is an ordering assertion and not a membership
   *    one.
   * 3. The pair sits **before** the new user message — history the model reads
   *    after the question is not history.
   *
   * The fact in `TOOL_RESULT` appears in NO prose item, so its presence on the
   * wire can only have come through the tool pair. That is the plan's DONE
   * criterion, measured at the wire rather than argued.
   */
  test('T1b — a paired function_call and function_call_output round-trip in order', async () => {
    const started = await client.request('thread/start', { cwd: workspace, model: MODEL }) as { thread?: { id?: string } };
    const threadId = started.thread?.id;
    expect(threadId).toBeTruthy();

    const injected = await client.request('thread/inject_items', { threadId, items: INJECT_ITEMS_WITH_TOOL });
    expect(injected).toEqual({});

    const before = bodies.length;
    await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: TOOL_PROMPT, text_elements: [] }],
    });
    const body = await nextBody(bodies, before);
    const items = body.input ?? [];

    // 1 — both halves are on the wire, exactly once each.
    const call = items.findIndex(i => i.type === 'function_call' && i.call_id === CALL_ID);
    const output = items.findIndex(i => i.type === 'function_call_output' && i.call_id === CALL_ID);
    expect(items.filter(i => i.type === 'function_call' && i.call_id === CALL_ID)).toHaveLength(1);
    expect(items.filter(i => i.type === 'function_call_output' && i.call_id === CALL_ID)).toHaveLength(1);

    // 2 — adjacent, and the call before its output.
    expect(output).toBe(call + 1);
    expect(items[call]!.name).toBe(TOOL_NAME);
    expect(items[call]!.arguments).toBe(TOOL_ARGS);
    expect(JSON.stringify(items[output]!.output)).toContain(TOOL_RESULT);

    // 3 — before the question, and the surrounding prose kept its order too.
    const texts = flatten(body).map(t => t.text);
    const prompt = items.findIndex(i => (i.content ?? []).some(p => (p.text ?? '').includes(TOOL_PROMPT)));
    expect(prompt).toBeGreaterThan(output);
    expect(texts.findIndex(t => t.includes(USER_SPAN))).toBeGreaterThanOrEqual(0);
    expect(texts.findIndex(t => t.includes(ASSISTANT_SPAN))).toBeGreaterThanOrEqual(0);

    // The DONE criterion, at the wire: the fact exists in no prose item, so its
    // presence here came through the tool pair and nothing else.
    expect(texts.some(t => t.includes(TOOL_RESULT))).toBe(false);
    expect(JSON.stringify(items)).toContain(TOOL_RESULT);
  }, 120_000);
});
