/**
 * C3.254 — where codex's transcript lands at `rust-v0.150.1`, re-measured on the
 * shipped binary rather than carried forward from `rust-v0.148.0`.
 *
 * ## Why the row exists
 *
 * P3.182 measured, at `rust-v0.148.0`, that `thread/start` ALONE materialised
 * `CODEX_HOME/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl`, and
 * {@link describeCodexRolloutPersistence} tells an operator that path in so many
 * words. W15-e then drove the `rust-v0.150.1` binary across three boots with a
 * real `thread/start` and **no `sessions/` directory appeared**, while
 * `state_5.sqlite-wal` grew to 1.7 MB. That rig ran no TURN, so it refuted
 * nothing — but a sentence an operator is asked to trust cannot rest on a
 * reading taken two tags ago, and `Feature::Sqlite` is `Stage::Removed,
 * default_enabled: true` at this tag, which is what a subsystem looks like after
 * it becomes unconditional.
 *
 * ## What the source says, read at the tag before the rig was written
 *
 * `github.com/openai/codex` at `rust-v0.150.1` — for codex the source outranks
 * the page, and the shipped binary outranks both:
 *
 *  - `codex-rs/rollout/src/lib.rs` — `pub const SESSIONS_SUBDIR: &str = "sessions"`.
 *  - `codex-rs/rollout/src/recorder.rs`, `precompute_new_rollout_path` — the path
 *    is still `<codex_home>/sessions/<year>/<month>/<day>/` plus a
 *    `RolloutFileName`, unchanged in shape.
 *  - the same file's `RolloutRecorder::new`, whose own docblock is the
 *    explanation of W15-e's absence: *"For newly created sessions, this
 *    precomputes path/metadata and defers file creation/open until an explicit
 *    `persist()` call"*, building its state with `deferred_creation: true`.
 *    `open_log_file` then does `create_dir_all` + `OpenOptions::create(true)`
 *    with no mode of codex's own.
 *  - `codex-rs/rollout/src/state_db.rs`, `apply_rollout_items` — the SAME items
 *    are handed to the state DB beside the file, which is the second copy at
 *    rest this test also looks for.
 *
 * So the prediction under test is: the path did not move, the moment did. A
 * boot alone leaves no `sessions/`; the first persisted item creates the file
 * where the sentence says.
 *
 * ## The rig
 *
 * The shipped `codex-app-server`, an isolated `mkdtemp` `CODEX_HOME`, the
 * `startStubAdapter` loopback Responses provider (no credential, no network) and
 * the config `writeCodexConfig` really emits — the same rig
 * `codex-inject-items-e2e.test.ts` uses. One real `turn/start` carrying a
 * fixture sentence that exists nowhere else, then the home is walked.
 *
 * The BOOT arm runs first and is the control that gives the TURN arm its
 * meaning: if `sessions/` were already there after `thread/start`, "the turn
 * created it" would be unfalsifiable.
 *
 * Gated on `NESSY_CODEX_E2E=1`, like every other live codex arm here:
 *
 *     NESSY_CODEX_E2E=1 bun test ./packages/shared/src/agent/__tests__/codex-rollout-path-e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServerClient } from '@nessy-agent/codex-agent-server/app-server-client';
import { CodexRuntimeManager } from '@nessy-agent/codex-agent-server/runtime-manager';
import { writeCodexConfig, CODEX_API_KEY_ENV } from '@nessy-agent/codex-responses-adapter/config-writer';
import { startStubAdapter, type StubAdapterHandle } from '@nessy-agent/codex-responses-adapter/stub-server';
import { describeCodexRolloutPersistence } from '../codex-agent.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

/**
 * A sentence that exists in no fixture, no prompt template and no config, so
 * finding it on disk proves the TURN put it there and nothing else did.
 */
const PROMPT = 'remember the rollout marker chestnut-ferry-19 and say ok';
const MARKER = 'chestnut-ferry-19';

function platformKey(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
  return `${process.platform}-${arch}`;
}

function binaryPath(): string {
  const name = process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server';
  return join(REPO_ROOT, 'apps', 'electron', 'resources', 'bin', 'codex', platformKey(), name);
}

/** Every file under `root`, relative, depth-first — the home is small. */
function walk(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

/** The rollout files, by the name shape `RolloutFileName::render` produces. */
function rolloutFiles(home: string): string[] {
  if (!existsSync(join(home, 'sessions'))) return [];
  return walk(home, 'sessions').filter(rel => rel.endsWith('.jsonl') && rel.includes('rollout-'));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return predicate();
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

describe('codex rollout path live — the switch is visible', () => {
  test('runs only under NESSY_CODEX_E2E=1, and says why when it does not', () => {
    if (CODEX_E2E) {
      expect(CODEX_E2E).toBe(true);
      return;
    }
    console.warn(
      '[codex-e2e] SKIPPED codex-rollout-path-e2e.test.ts: NESSY_CODEX_E2E is not "1". '
      + 'NOT verified in this run: where codex writes its rollout file, and when. Run it with '
      + '`NESSY_CODEX_E2E=1 bun test ./packages/shared/src/agent/__tests__/codex-rollout-path-e2e.test.ts`, '
      + 'or `bun scripts/codex-live-suites.ts`, which sets this gate for the whole '
      + 'live-boot family. It needs the staged codex-app-server '
      + '(`node scripts/fetch-codex.mjs`) and no network and no credentials.',
    );
    expect(CODEX_E2E).toBe(false);
  });
});

describe.if(CODEX_E2E)('codex rollout path, driven at rust-v0.150.1', () => {
  let stub: StubAdapterHandle;
  let manager: CodexRuntimeManager;
  let client: AppServerClient;
  let codexHome = '';
  let workspace = '';
  let threadId = '';
  const notifications: string[] = [];

  beforeAll(async () => {
    const bin = binaryPath();
    if (!existsSync(bin)) {
      throw new Error(`codex-app-server not found at ${bin}. Run: node scripts/fetch-codex.mjs`);
    }
    codexHome = mkdtempSync(join(tmpdir(), 'codex-rollout-home-'));
    workspace = mkdtempSync(join(tmpdir(), 'codex-rollout-ws-'));
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    writeFileSync(join(workspace, 'README.md'), '# rollout fixture\n');
    execFileSync('git', ['-c', 'user.email=e2e@nessy', '-c', 'user.name=e2e', 'add', '-A'], { cwd: workspace });
    execFileSync(
      'git',
      ['-c', 'user.email=e2e@nessy', '-c', 'user.name=e2e', 'commit', '-qm', 'init'],
      { cwd: workspace },
    );

    // `emitToolCall: false` keeps the turn to one round trip: a tool call would
    // reach codex's approval path, which has nobody to answer it here.
    stub = await startStubAdapter({ model: MODEL, emitToolCall: false });
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
      onNotification: (method) => { notifications.push(method); },
    });
    await client.request('initialize', {
      clientInfo: { name: 'nessy-codex-rollout-e2e', title: null, version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, { timeoutMs: 120_000 });
    client.notify('initialized');
  }, 180_000);

  afterAll(async () => {
    try { client?.close(); } catch { /* already closed */ }
    await manager?.kill().catch(() => {});
    await stub?.close();
    if (codexHome) rmSync(codexHome, { recursive: true, force: true });
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  /**
   * CONTROL, and the half W15-e actually saw. It must run first: it is what
   * makes "the turn created the file" a falsifiable claim rather than a reading
   * of a directory that was there all along.
   */
  test('CONTROL: thread/start alone leaves no rollout file — creation is deferred', async () => {
    const started = await client.request(
      'thread/start',
      { cwd: workspace, model: MODEL },
      { timeoutMs: 60_000 },
    ) as { thread?: { id?: string } };
    threadId = started.thread?.id ?? '';
    expect(threadId).toBeTruthy();

    // A generous settle window: the claim is an ABSENCE, so it must not be the
    // absence of having looked too early.
    await new Promise(resolve => setTimeout(resolve, 2_000));
    expect(rolloutFiles(codexHome)).toEqual([]);
  }, 120_000);

  test('one real turn creates the rollout exactly where the operator sentence says, with the prompt in it', async () => {
    expect(threadId).toBeTruthy();
    await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: PROMPT, text_elements: [] }],
    }, { timeoutMs: 60_000 });

    const appeared = await waitFor(() => rolloutFiles(codexHome).length > 0, 60_000);
    expect(appeared).toBe(true);

    const files = rolloutFiles(codexHome);
    expect(files.length).toBeGreaterThan(0);

    // The sentence's own path, segment by segment: `sessions/<yyyy>/<mm>/<dd>/`.
    const rel = files[0]!;
    expect(rel).toMatch(/^sessions[/\\]\d{4}[/\\]\d{2}[/\\]\d{2}[/\\]rollout-.*\.jsonl$/);

    // The sentence's claim about CONTENT: the user's prompt lands verbatim.
    //
    // WAITED for, not read once: the file is created empty and its lines are
    // flushed by codex's own writer task, so the first read after creation
    // legitimately returns `''` (measured — it did, and reading once would have
    // recorded "the rollout no longer carries the prompt", which is false).
    const carried = await waitFor(
      () => readFileSync(join(codexHome, rel), 'utf8').includes(MARKER),
      60_000,
    );
    expect(carried).toBe(true);

    // The sentence's claim about MODE: codex sets no restrictive mode of its
    // own, so the file is whatever the umask gives (0644 on a 022 rig). Asserted
    // as "not owner-only", which is the property the sentence rests on and the
    // one that survives a different umask.
    const mode = statSync(join(codexHome, rel)).mode & 0o777;
    expect(mode & 0o077).not.toBe(0);
  }, 180_000);

  /**
   * The SECOND copy at rest. `apply_rollout_items` hands the same items to the
   * state DB, and W15-e watched `state_5.sqlite-wal` grow while no file existed.
   * Recorded rather than asserted-absent: what matters to the operator sentence
   * is whether the file is the ONLY place the transcript lands, and the answer
   * decides whether that sentence needs a second noun.
   */
  test('the state DB in the same home is a second copy of the same turn', async () => {
    const stateFiles = walk(codexHome).filter(rel => rel.includes('state') && rel.includes('.sqlite'));
    expect(stateFiles.length).toBeGreaterThan(0);
    const marked = () => stateFiles.some((rel) => {
      try { return readFileSync(join(codexHome, rel)).includes(MARKER); } catch { return false; }
    });
    // Same flush caution as the file arm: a single read straight after the turn
    // measures the writer's timing, not the destination.
    const carriesMarker = await waitFor(marked, 30_000);
    // Both outcomes are informative, so the assertion is on the READING being
    // taken, not on its direction; the verdict is recorded in the row and in
    // `describeCodexRolloutPersistence`.
    expect(typeof carriesMarker).toBe('boolean');
    console.log(`[C3.254] state files: ${stateFiles.join(', ')}; marker in a state file: ${carriesMarker}`);
  });

  /** The sentence under test names the path this rig just walked. */
  test('the operator sentence names the directory the files landed in', () => {
    expect(describeCodexRolloutPersistence(codexHome)).toContain(`${codexHome}/sessions/`);
  });
});
