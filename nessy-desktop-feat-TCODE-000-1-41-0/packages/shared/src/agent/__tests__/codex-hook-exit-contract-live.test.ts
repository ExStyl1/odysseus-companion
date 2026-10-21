/**
 * C3.84 (D1.41, born P6.290) — codex runs its own hook processes, so the
 * exit-code blocking contract there is the BINARY's. This is that contract,
 * driven, beside ours.
 *
 * ## The residue the source read cannot settle
 *
 * C3.83 reads `codex-rs/hooks/` at the tag we ship; what a source read cannot
 * answer is the composed question P6.290 asked — *does a non-zero-exit hook
 * that prints nothing block anything* — because the decision is spread across
 * the output parser, the command runner and the turn driver. So it is driven.
 *
 * ## The reading, 2026-09-11, on the SHIPPED `codex-app-server` (`rust-v0.150.1`)
 *
 * One `userPromptSubmit` command hook per arm, in a `CODEX_HOME` this test
 * writes, trusted through the two-pass `[hooks.state]` protocol
 * `config-writer-hooks-live.test.ts` established, then `thread/start` +
 * `turn/start`. Each hook also touches a marker file, so "it did not block" is
 * never confused with "it did not run".
 *
 * | arm | `hook/completed.status` | entry | turn proceeded |
 * | --- | --- | --- | --- |
 * | exit 0, no output (CONTROL) | `completed` | — | yes |
 * | **exit 2, NOTHING on stderr** | `failed` | error: *"UserPromptSubmit hook exited with code 2 but did not write a blocking reason to stderr"* | **YES** |
 * | exit 2, a reason on stderr | `blocked` | feedback: the stderr text | no |
 * | exit 1, a reason on stderr | `failed` | error: *"hook exited with code 1"* — the stderr text is DISCARDED | yes |
 * | exit 0 + `{"decision":"block","reason":…}` on stdout | `blocked` | feedback: the reason | no |
 * | command cannot start | `failed` | error: *"hook exited with code 127"* | yes |
 *
 * So codex's exit-code channel is ONE code wide and conditional: **exit 2
 * blocks if and only if the hook wrote a reason to stderr**, every other
 * non-zero code is a non-blocking diagnostic, and stderr is read on exit 2 and
 * nowhere else.
 *
 * ## Against our contract — two divergences, one of them a permission divergence
 *
 * `getHookCommandPreToolDecision` (`shared/src/automations/hook-command.ts`)
 * has two arms and codex matches NEITHER exactly:
 *
 *  1. **exit 2 with empty streams.** Ours blocks on both arms — the imported-hook
 *     arm falls back to the literal *"Hook command reported a blocking error."* —
 *     and codex does not block at all. A user hook written to STOP something
 *     stops it here and does not stop it there: a PERMISSION divergence.
 *  2. **any other non-zero.** Our NATIVE-automation arm (`blockOnNonZero !== false`)
 *     blocks; codex does not, and neither does our imported-hook arm, which is
 *     Claude's documented three-way semantics. That one is our own
 *     native-vs-imported split and is already reasoned at the site.
 *
 * Both agree on the two remaining arms: exit 0 with a decision on stdout blocks,
 * and exit 2 WITH a reason blocks.
 *
 * ## Why this earns no switch-cost row today, stated rather than assumed
 *
 * The divergence is in a code path our sessions do not reach. The native
 * `[hooks]` route is closed by the owner's 2026-08-29 ruling for anything the
 * host did not author, and the host authors none —
 * `CodexAgent.hostAuthoredHookProjection` returns `{}`, so `buildCodexHooksToml`
 * is handed `undefined` and no `[hooks]` table is written for any real session.
 * Every host, user and plugin hook on a codex session therefore runs through
 * `hook-command.ts` and obeys OUR contract, identically to Pi's. What this
 * reading prices is the cost of OPENING that route — it is the third fact on
 * that ledger, beside the two `buildCodexHooksToml` already records about the
 * `mcp_tool` handler kind.
 *
 * Skips loudly where the binary is absent (a gitignored build-time download), in
 * the armed-check idiom `config-writer-hooks-live.test.ts` established. It lives in
 * `shared` rather than beside that file because it compares the binary's verdict
 * with the HOST's, and `hook-command.ts` is shared's — the adapter is the
 * dependency ROOT of the pair and may not import back into it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodexConfigToml, mintHostAuthoredCodexHooks } from '@nessy-agent/codex-responses-adapter/config-writer';
import { getHookCommandPreToolDecision } from '../../automations/hook-command.ts';
import type { HookCommandAction, HookCommandActionResult } from '../../automations/types.ts';
import { AppServer } from '../../../../codex-responses-adapter/src/__tests__/app-server-rig.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const BIN = join(
  REPO_ROOT, 'apps', 'electron', 'resources', 'bin', 'codex',
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server',
);
const HAVE_BIN = existsSync(BIN);

/** Two spawns of a ~185 MB binary per arm; generous because timing is part of no claim here. */
const BUDGET_MS = 180_000;

const ROOT = HAVE_BIN ? mkdtempSync(join(tmpdir(), 'nessy-codex-hookexit-')) : '';
const WS = join(ROOT, 'ws');
afterAll(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }); });

/** Never dialled: the model call fails on connect, which is AFTER the hook has decided. */
const UNDIALLED_ADAPTER_PORT = 1;

interface HookRun {
  eventName: string;
  status: string;
  entries: { kind: string; text: string }[];
}

/** One `userPromptSubmit` command hook, through the REAL mint and the REAL writer. */
function configFor(home: string, command: string, state?: Record<string, string>): string {
  return buildCodexConfigToml({
    codexHome: home,
    model: 'w16g-probe-model',
    adapterPort: UNDIALLED_ADAPTER_PORT,
    mode: 'default',
    sandboxGloballyEnabled: false,
    hooks: mintHostAuthoredCodexHooks(
      { origin: 'codexHookExitContractRig', revocation: { kind: 'next-runtime-build' } },
      { UserPromptSubmit: [{ hooks: [{ command, timeoutSec: 10 }] }], ...(state ? { state } : {}) },
    ),
  });
}

function spawnServer(home: string): AppServer {
  const child = spawn(BIN, [], {
    cwd: WS,
    // The provider's `env_key`, so the turn reaches the (undialled) transport
    // rather than being refused for a missing credential BEFORE the hook runs.
    env: { ...process.env, CODEX_HOME: home, COMPANY_LLM_API_KEY: 'w16g-probe-not-a-real-key' },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  return new AppServer(child);
}

async function initialize(server: AppServer): Promise<void> {
  await server.request('initialize', {
    clientInfo: { name: 'nessy-codex-hook-exit', title: null, version: '0.0.0' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  server.notify('initialized');
}

interface ArmResult {
  run: HookRun;
  /** True when the turn went on to build a user message — i.e. nothing blocked it. */
  turnProceeded: boolean;
  hookRan: boolean;
}

/**
 * Drive one arm: trust pass, then a real turn, then read the binary's own
 * verdict for the `userPromptSubmit` hook and whether the turn survived it.
 */
async function driveArm(name: string, command: string): Promise<ArmResult> {
  const home = join(ROOT, name);
  const marker = join(ROOT, `${name}.marker`);
  mkdirSync(home, { recursive: true });
  mkdirSync(WS, { recursive: true });
  const withMarker = `sh -c 'echo ran > ${marker}; ${command}'`;

  // Pass one: the key and hash are the BINARY's, published by `hooks/list`.
  writeFileSync(join(home, 'config.toml'), configFor(home, withMarker));
  const first = spawnServer(home);
  let state: Record<string, string>;
  try {
    await initialize(first);
    const listed = await first.request('hooks/list', { cwds: [WS] }) as {
      data?: { hooks?: { key: string; currentHash: string }[] }[];
    };
    const hooks = listed.data?.[0]?.hooks ?? [];
    if (hooks.length !== 1) throw new Error(`hooks/list returned ${hooks.length} entries for ${name}`);
    state = Object.fromEntries(hooks.map(hook => [hook.key, hook.currentHash]));
  } finally {
    first.kill();
  }

  // Pass two: the same table, now trusted, and a turn that reaches the hook.
  writeFileSync(join(home, 'config.toml'), configFor(home, withMarker, state));
  const second = spawnServer(home);
  try {
    await initialize(second);
    const started = await second.request('thread/start', {
      cwd: WS, model: 'w16g-probe-model', developerInstructions: 'hook exit contract probe',
    }, 90_000) as { thread?: { id?: string } };
    const threadId = started.thread?.id;
    if (!threadId) throw new Error(`no thread id for ${name}`);
    void second.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'probe', text_elements: [] }],
    }, 90_000).catch(() => undefined);

    const isHookCompleted = (n: { method: string; params: Record<string, unknown> }): boolean =>
      n.method === 'hook/completed'
      && (n.params.run as HookRun | undefined)?.eventName === 'userPromptSubmit';
    if (!await second.waitFor(isHookCompleted)) throw new Error(`no hook/completed for ${name}`);
    const run = (second.notifications.find(isHookCompleted)!.params.run as HookRun);

    // The CONSEQUENCE, read from whichever of the two outcomes arrives first: a
    // turn that survived the hook builds its user message; a blocked one ends.
    await second.waitFor(n => n.method === 'item/started' || n.method === 'turn/completed', 20_000);
    const turnProceeded = second.notifications.some(n => n.method === 'item/started');
    return { run, turnProceeded, hookRan: existsSync(marker) };
  } finally {
    second.kill();
  }
}

describe('codex hook exit contract — the detector is armed', () => {
  test('the bundled codex binary is present, or the skip is deliberate', () => {
    if (HAVE_BIN) {
      expect(HAVE_BIN).toBe(true);
      return;
    }
    console.warn(
      `[codex-hook-exit] SKIPPED: no codex binary at ${BIN}. The exit-code contract in this file's header`
      + ' was NOT re-driven in this run; it remains a dated reading.',
    );
    expect(HAVE_BIN).toBe(false);
  });
});

describe.if(HAVE_BIN)('codex hook exit contract — driven on the shipped binary', () => {
  test('CONTROL: exit 0 with no output runs the hook and blocks nothing', async () => {
    const { run, turnProceeded, hookRan } = await driveArm('control-exit0', 'exit 0');
    expect(hookRan).toBe(true);
    expect(run.status).toBe('completed');
    expect(run.entries).toEqual([]);
    expect(turnProceeded).toBe(true);
  }, BUDGET_MS);

  test('exit 2 with NOTHING on stderr does NOT block, and the binary says why', async () => {
    // P6.290's own question. Our contract blocks here on both of its arms; codex
    // does not, and names the missing half rather than failing silently.
    const { run, turnProceeded, hookRan } = await driveArm('exit2-silent', 'exit 2');
    expect(hookRan).toBe(true);
    expect(run.status).toBe('failed');
    expect(run.entries[0]?.kind).toBe('error');
    expect(run.entries[0]?.text).toContain('did not write a blocking reason to stderr');
    expect(turnProceeded).toBe(true);
  }, BUDGET_MS);

  test('exit 2 WITH a reason on stderr blocks, and the reason is the feedback', async () => {
    // The discriminator: without this arm the case above would read as "codex
    // ignores exit 2", which is false — the exit code and the stream are ONE
    // signal there.
    const { run, turnProceeded } = await driveArm('exit2-stderr', 'echo "w16g stderr reason" >&2; exit 2');
    expect(run.status).toBe('blocked');
    expect(run.entries[0]).toEqual({ kind: 'feedback', text: 'w16g stderr reason' });
    expect(turnProceeded).toBe(false);
  }, BUDGET_MS);

  test('exit 1 with a reason on stderr neither blocks nor carries the reason', async () => {
    // Two facts in one arm: the code channel is exactly one code wide, and
    // stderr is read on exit 2 and nowhere else — the reason is DISCARDED here.
    const { run, turnProceeded } = await driveArm('exit1-stderr', 'echo "w16g stderr reason" >&2; exit 1');
    expect(run.status).toBe('failed');
    expect(run.entries[0]?.kind).toBe('error');
    expect(run.entries[0]?.text).toBe('hook exited with code 1');
    expect(turnProceeded).toBe(true);
  }, BUDGET_MS);

  test('exit 0 with a decision JSON on stdout blocks', async () => {
    const { run, turnProceeded } = await driveArm(
      'exit0-json',
      // Double quotes, not single: `driveArm` wraps the arm in `sh -c '…'`, so a
      // single-quoted JSON literal would close that quoting and the hook would
      // print nothing — which reads exactly like "codex ignored the decision".
      'printf %s "{\\"decision\\":\\"block\\",\\"reason\\":\\"w16g json reason\\"}"; exit 0',
    );
    expect(run.status).toBe('blocked');
    expect(run.entries[0]).toEqual({ kind: 'feedback', text: 'w16g json reason' });
    expect(turnProceeded).toBe(false);
  }, BUDGET_MS);

  test('a command that cannot start is a non-blocking failure', async () => {
    const { run, turnProceeded } = await driveArm('cannot-start', `${join(ROOT, 'no-such-binary')}`);
    expect(run.status).toBe('failed');
    expect(run.entries[0]?.text).toBe('hook exited with code 127');
    expect(turnProceeded).toBe(true);
  }, BUDGET_MS);
});

/**
 * The CONTROL half of P6.290's rig — "the identical four hooks on Pi, where
 * `hook-decision-contract.ts` owns the verdict" — driven through the host
 * decision function itself rather than through a Pi subprocess. That function
 * IS the verdict on Pi and on claude's host tier alike, so driving it compares
 * the two contracts without a second runtime's spawn cost, and it runs with no
 * binary present.
 */
describe('the host contract, for the same four outcomes', () => {
  const action = (blockOnNonZero: boolean): HookCommandAction =>
    ({ type: 'command', command: './hook.sh', ...(blockOnNonZero ? {} : { blockOnNonZero: false }) }) as HookCommandAction;
  const result = (over: Partial<HookCommandActionResult>): HookCommandActionResult =>
    ({ type: 'command', command: './hook.sh', success: false, exitCode: 1, signal: null, durationMs: 1, ...over }) as HookCommandActionResult;

  test('exit 2 with empty streams BLOCKS on both host arms — the permission divergence', () => {
    const native = getHookCommandPreToolDecision(action(true), result({ exitCode: 2 }));
    const imported = getHookCommandPreToolDecision(action(false), result({ exitCode: 2 }));
    expect(native?.decision).toBe('block');
    expect(imported?.decision).toBe('block');
  });

  test('any other non-zero blocks on the NATIVE arm and not on the imported one', () => {
    expect(getHookCommandPreToolDecision(action(true), result({ exitCode: 1 }))?.decision).toBe('block');
    expect(getHookCommandPreToolDecision(action(false), result({ exitCode: 1 }))).toBeUndefined();
    expect(getHookCommandPreToolDecision(action(false), result({ exitCode: 127 }))).toBeUndefined();
  });

  test('CONTROL: exit 0 decides from stdout on both arms, so the arms are not identical by construction', () => {
    const stdout = JSON.stringify({ decision: 'block', reason: 'host json reason' });
    const ok = { success: true, exitCode: 0, stdout } as Partial<HookCommandActionResult>;
    expect(getHookCommandPreToolDecision(action(true), result(ok))?.reason).toContain('host json reason');
    expect(getHookCommandPreToolDecision(action(false), result(ok))?.reason).toContain('host json reason');
    // And a clean exit 0 with nothing on stdout decides nothing at all.
    expect(getHookCommandPreToolDecision(action(true), result({ success: true, exitCode: 0, stdout: '' }))).toBeUndefined();
  });
});
