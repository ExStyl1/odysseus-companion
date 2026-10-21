/**
 * C3.67 — the seam the codex file-checkpoint producer stands on, measured on the
 * shipped binary instead of argued from the source.
 *
 * ## The claim under test
 *
 * `CodexAgent.checkpointCodexFileChange` takes the pre-image of every path a
 * codex patch is about to write, on the `item/started` notification for a
 * `fileChange` item. That is only a checkpoint if the file still holds its
 * PRE-image when the notification reaches this process.
 *
 * The source says the ordering is right inside codex —
 * `core/src/tools/handlers/apply_patch.rs` at `rust-v0.150.1` awaits
 * `emitter.begin(event_ctx)` before the `ToolOrchestrator` that applies the
 * patch, and `app-server-protocol/src/protocol/item_builders.rs`'s
 * `build_file_change_begin_item` is what turns that event into this item. But
 * codex does not WAIT for us: the notification crosses a pipe, so the window is
 * codex's own remaining work (approval resolution, environment selection, the
 * orchestrator run) against our read. An ordering nobody controls is exactly the
 * kind of claim this repo requires a reading for.
 *
 * ## The rig
 *
 * The shipped `codex-app-server`, an isolated `CODEX_HOME`, the loopback stub
 * adapter, and a workspace file whose contents are a fixture string. The stub's
 * canned turn emits ONE tool call — `apply_patch` driven through the shell
 * intercept (`intercept_apply_patch`), which is the path reachable from a
 * `function_call`-shaped stub, the freeform `apply_patch` tool being a
 * `ToolPayload::Custom` this stub does not emit.
 *
 * The handler reads the file SYNCHRONOUSLY inside the notification callback,
 * which is the same instant `CodexAgent.handleNotification` would, so what it
 * records is what the producer would have snapshotted.
 *
 * Gated on `NESSY_CODEX_E2E=1`:
 *
 *     NESSY_CODEX_E2E=1 bun test ./packages/shared/src/agent/__tests__/codex-file-change-preimage-e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServerClient } from '@nessy-agent/codex-agent-server/app-server-client';
import { CodexRuntimeManager } from '@nessy-agent/codex-agent-server/runtime-manager';
import { writeCodexConfig, CODEX_API_KEY_ENV } from '@nessy-agent/codex-responses-adapter/config-writer';
import { startStubAdapter, type StubAdapterHandle } from '@nessy-agent/codex-responses-adapter/stub-server';
import { codexFileChangePaths } from '../codex-agent.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

const TARGET = 'target.txt';
const PREIMAGE = 'sable-harbour-41\n';
const POSTIMAGE = 'tawny-harbour-41\n';

const PATCH = [
  "apply_patch <<'PATCH'",
  '*** Begin Patch',
  `*** Update File: ${TARGET}`,
  '@@',
  `-${PREIMAGE.trim()}`,
  `+${POSTIMAGE.trim()}`,
  '*** End Patch',
  'PATCH',
].join('\n');

function platformKey(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
  return `${process.platform}-${arch}`;
}

function binaryPath(): string {
  const name = process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server';
  return join(REPO_ROOT, 'apps', 'electron', 'resources', 'bin', 'codex', platformKey(), name);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
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

describe('codex fileChange pre-image live — the switch is visible', () => {
  test('runs only under NESSY_CODEX_E2E=1, and says why when it does not', () => {
    if (CODEX_E2E) {
      expect(CODEX_E2E).toBe(true);
      return;
    }
    console.warn(
      '[codex-e2e] SKIPPED codex-file-change-preimage-e2e.test.ts: NESSY_CODEX_E2E is not "1". '
      + 'NOT verified in this run: the fileChange pre-image the notification handler can snapshot. Run it with '
      + '`NESSY_CODEX_E2E=1 bun test ./packages/shared/src/agent/__tests__/codex-file-change-preimage-e2e.test.ts`, '
      + 'or `bun scripts/codex-live-suites.ts`, which sets this gate for the whole '
      + 'live-boot family. It needs the staged codex-app-server '
      + '(`node scripts/fetch-codex.mjs`) and no network and no credentials.',
    );
    expect(CODEX_E2E).toBe(false);
  });
});

describe.if(CODEX_E2E)('codex fileChange pre-image, driven at rust-v0.150.1', () => {
  let stub: StubAdapterHandle;
  let manager: CodexRuntimeManager;
  let client: AppServerClient;
  let codexHome = '';
  let workspace = '';
  /** What `item/started` for a `fileChange` saw, read at that instant. */
  const sightings: Array<{ paths: string[]; contents: Array<string | null>; status?: unknown }> = [];
  const completed: unknown[] = [];

  beforeAll(async () => {
    const bin = binaryPath();
    if (!existsSync(bin)) {
      throw new Error(`codex-app-server not found at ${bin}. Run: node scripts/fetch-codex.mjs`);
    }
    codexHome = mkdtempSync(join(tmpdir(), 'codex-preimage-home-'));
    workspace = mkdtempSync(join(tmpdir(), 'codex-preimage-ws-'));
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    writeFileSync(join(workspace, TARGET), PREIMAGE);
    execFileSync('git', ['-c', 'user.email=e2e@nessy', '-c', 'user.name=e2e', 'add', '-A'], { cwd: workspace });
    execFileSync(
      'git',
      ['-c', 'user.email=e2e@nessy', '-c', 'user.name=e2e', 'commit', '-qm', 'init'],
      { cwd: workspace },
    );

    stub = await startStubAdapter({
      model: MODEL,
      emitToolCall: true,
      toolName: 'exec_command',
      toolArguments: { cmd: PATCH },
    });
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
        const item = (params as { item?: unknown } | undefined)?.item;
        if (method === 'item/started') {
          const paths = codexFileChangePaths(item, workspace);
          if (paths.length === 0) return;
          // Read HERE, synchronously, which is the instant the producer's own
          // `createFileCheckpoint` call is made from.
          const contents = paths.map((path) => {
            try { return readFileSync(path, 'utf8'); } catch { return null; }
          });
          sightings.push({ paths, contents });
        } else if (method === 'item/completed') {
          if (codexFileChangePaths(item, workspace).length > 0) completed.push(item);
        }
      },
      // The approval bridge has nobody here; the config writes
      // `danger-full-access`, so an ordinary patch is not routed for approval.
      onServerRequest: () => ({}),
    });
    await client.request('initialize', {
      clientInfo: { name: 'nessy-codex-preimage-e2e', title: null, version: '0.0.0' },
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

  test('item/started for a fileChange arrives while the file still holds its pre-image', async () => {
    const started = await client.request(
      'thread/start',
      { cwd: workspace, model: MODEL },
      { timeoutMs: 60_000 },
    ) as { thread?: { id?: string } };
    const threadId = started.thread?.id;
    expect(threadId).toBeTruthy();

    await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'apply the patch', text_elements: [] }],
    }, { timeoutMs: 60_000 });

    // POSITIVE CONTROL for the whole rig: the patch must actually land, or an
    // absent `fileChange` would read as "the pre-image was safe" for the wrong
    // reason.
    const applied = await waitFor(
      () => readFileSync(join(workspace, TARGET), 'utf8') === POSTIMAGE,
      120_000,
    );
    expect(applied).toBe(true);

    // The producer's seam fired, and it named the path.
    expect(sightings.length).toBeGreaterThan(0);
    expect(sightings[0]!.paths).toEqual([join(workspace, TARGET)]);

    // THE READING: what a checkpoint taken at that instant would have captured.
    expect(sightings[0]!.contents).toEqual([PREIMAGE]);

    // And the close is announced too, so `finalizeFileCheckpoint` has a trigger.
    await waitFor(() => completed.length > 0, 30_000);
    expect(completed.length).toBeGreaterThan(0);
  }, 240_000);
});
