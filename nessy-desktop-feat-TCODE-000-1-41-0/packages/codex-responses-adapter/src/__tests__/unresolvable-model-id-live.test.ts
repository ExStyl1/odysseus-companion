/**
 * P6.164 — what the codex binary does with a model id no catalogue serves.
 *
 * ## Why the run was worth making
 *
 * The question decides whether an unresolvable id is a **legible refusal** or a
 * **silent substitution**, and those want opposite fixes. The schema side was
 * already settled and says there is nothing to resolve WITH: parsing
 * `packages/codex-protocol/schema/config-schema.json`, the keys `alias`,
 * `model_alias` and `aliases` score 0, against `AgentsToml.default_subagent_model`
 * and `MultiAgentV2ConfigToml.expose_spawn_agent_model_overrides` as present
 * controls. Only the binary could answer the other half.
 *
 * ## What was measured, 2026-09-06, on the shipped darwin-arm64 binary
 *
 * Neither. **The id is forwarded to the upstream VERBATIM** — `model: "opus"`
 * arrives at the stub as `"opus"` — so there is no substitution to be silent
 * about, and no refusal either: `thread/start` succeeds, the turn runs to
 * `turn/completed`, and the failure (if any) is the endpoint's, one hop later.
 *
 * **And the one notification that looks like a refusal does not discriminate.**
 * codex emits a `warning` — not `configWarning`, not `model/verification`, both
 * of which the row expected — reading *"Model metadata for `X` not found.
 * Defaulting to fallback metadata; this can degrade performance and cause
 * issues."* It fires **identically for the gateway's own default model**, which
 * codex's catalogue does not know either. So on every Nessy codex session this
 * warning is already present, and it carries no information about whether the id
 * the user pinned is servable. That is what the control here exists to prove: the
 * control is not a discriminator, and a reader who took this warning as the
 * unresolvable-id signal would be reading a constant.
 *
 * ## The rig
 *
 * The shipped `codex-app-server` for the host platform, an isolated `CODEX_HOME`
 * written by the REAL `buildCodexConfigToml`, and the in-tree stub Responses
 * server with `emitToolCall: false` so the turn ends in one round trip. No app,
 * no network beyond loopback. Skips where the binary is absent — it is a
 * build-time download and gitignored, so CI's Linux container has none.
 */
import { test, expect, describe, afterAll } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodexConfigToml } from '../config-writer.ts';
import { startStubAdapter } from '../stub-server.ts';
import { AppServer } from './app-server-rig.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const BIN = join(
  REPO_ROOT, 'apps', 'electron', 'resources', 'bin', 'codex',
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server',
);
const HAVE_BIN = existsSync(BIN);

/** The gateway's own default — the control, and a model codex also does not know. */
const SERVED_MODEL = 'tgpt/qwen35-397b-a17b-fp8';
/** An alias no catalogue this product talks to serves. */
const UNRESOLVABLE_MODEL = 'opus';

const ROOT = join(homedir(), '.cache', 'nessy-p6164-unresolvable-model');
const WS = join(ROOT, 'ws');
const BUDGET_MS = 180_000;

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

interface ArmResult {
  /** The `model` field on the FIRST upstream request, as the endpoint sees it. */
  upstreamModel: unknown;
  upstreamRequests: number;
  threadStarted: boolean;
  turnCompleted: boolean;
  /** Every `warning` notification's message, in order. */
  warnings: string[];
  methods: string[];
}

/** One boot, one thread pinned to `model`, one turn, one upstream round trip. */
async function runArm(name: string, model: string): Promise<ArmResult> {
  const bodies: string[] = [];
  const stub = await startStubAdapter({ emitToolCall: false, onRequestBody: b => bodies.push(b) });
  const home = join(ROOT, 'homes', name);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(WS, { recursive: true });
  // The config carries the SERVED model in both arms; what varies is the id the
  // thread is pinned to, which is the surface a user or an agent role reaches.
  writeFileSync(join(home, 'config.toml'), buildCodexConfigToml({
    codexHome: home,
    model: SERVED_MODEL,
    adapterPort: stub.port,
    mode: 'default',
    sandboxGloballyEnabled: false,
  }));
  const child = spawn(BIN, [], {
    cwd: WS,
    env: { ...process.env, CODEX_HOME: home, COMPANY_LLM_API_KEY: 'loopback' },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  const server = new AppServer(child);
  let threadStarted = false;
  let turnCompleted = false;
  try {
    await server.request('initialize', {
      clientInfo: { name: 'nessy-p6164', title: null, version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    server.notify('initialized');
    const started = await server.request('thread/start', { cwd: WS, model }) as {
      thread?: { id?: string }; threadId?: string;
    };
    const threadId = started.thread?.id ?? started.threadId;
    threadStarted = typeof threadId === 'string' && threadId.length > 0;
    await server.request('turn/start', {
      threadId, input: [{ type: 'text', text: 'say hi', text_elements: [] }],
    });
    await server.waitForTurn(60_000);
    turnCompleted = server.notifications.some(n => n.method === 'turn/completed');
  } finally {
    server.kill();
    await stub.close();
  }
  const first = bodies[0] ? JSON.parse(bodies[0]) as { model?: unknown } : undefined;
  return {
    upstreamModel: first?.model,
    upstreamRequests: bodies.length,
    threadStarted,
    turnCompleted,
    warnings: server.notifications
      .filter(n => n.method === 'warning')
      .map(n => String((n.params as { message?: unknown } | undefined)?.message ?? '')),
    methods: server.notifications.map(n => n.method),
  };
}

describe.if(HAVE_BIN)('P6.164 — an unresolvable model id on the shipped codex binary', () => {
  test('CONTROL: the served model reaches the upstream verbatim, and the turn completes', async () => {
    const control = await runArm('control', SERVED_MODEL);
    expect(control.threadStarted).toBe(true);
    expect(control.upstreamRequests).toBeGreaterThanOrEqual(1);
    expect(control.upstreamModel).toBe(SERVED_MODEL);
    expect(control.turnCompleted).toBe(true);
    // The control's OTHER job: it fires the same metadata warning, so that
    // warning cannot be read as the unresolvable-id signal.
    expect(control.warnings.join('\n')).toContain('Model metadata for');
    expect(control.warnings.join('\n')).toContain(SERVED_MODEL);
  }, BUDGET_MS);

  test('an alias no catalogue serves is FORWARDED VERBATIM — not refused, not substituted', async () => {
    const arm = await runArm('unresolvable', UNRESOLVABLE_MODEL);
    expect(arm.threadStarted).toBe(true);
    expect(arm.upstreamRequests).toBeGreaterThanOrEqual(1);
    // The finding: no substitution. What the caller pinned is what the endpoint
    // is asked for, and the failure — if the endpoint has one — is one hop away.
    expect(arm.upstreamModel).toBe(UNRESOLVABLE_MODEL);
    // And no refusal: the thread starts and the turn completes.
    expect(arm.turnCompleted).toBe(true);
    expect(arm.methods).not.toContain('configWarning');
    expect(arm.methods).not.toContain('model/verification');
    // The only notification that mentions the id is the same metadata warning
    // the control fires, quoted here so a wording change is visible.
    expect(arm.warnings.join('\n')).toContain(
      `Model metadata for \`${UNRESOLVABLE_MODEL}\` not found. Defaulting to fallback metadata; `
      + 'this can degrade performance and cause issues.',
    );
  }, BUDGET_MS);
});

test('the binary is present, or this measurement is skipped and says so', () => {
  if (!HAVE_BIN) {
    expect(HAVE_BIN).toBe(false);
    return;
  }
  expect(HAVE_BIN).toBe(true);
});
