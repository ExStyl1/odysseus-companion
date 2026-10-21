import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { PiAgent } from '../pi-agent.ts';
import { piDriver } from '../backend/internal/drivers/pi.ts';
import type { BackendConfig } from '../backend/types.ts';

/**
 * F1.727 — a Pi `find` / `grep` on the PACKAGED build finds the ripgrep the
 * bundle ships.
 *
 * Measured on the 1.41.0 release sitting (lane SIT-i, packaged `5896a66d2`):
 * Pi's `find` answered "This tool requires `rg` (ripgrep), which is not
 * available on this host … exit 127" while the bundle carried
 * `Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg`. Those tools are
 * `LocalToolRuntime` operations that run a bare `rg …` through the HOST's
 * process supervisor (`requestSupervisedProcess` in the Pi child →
 * `PiAgent.handleProcessStartRequest` → `port.start`), so the binary is looked
 * up on the PATH that method hands the supervisor — and nothing put the
 * bundle's copy there.
 *
 * The rig is the production chain with no planted collaborator between the two
 * halves: the REAL `piDriver.buildRuntime` over a packaged-layout directory
 * tree (asar is off — `electron-builder.yml` `asar: false` — so the binary is a
 * plain file under `Resources/app`, the layout `build-dmg.sh` guarantees), its
 * runtime handed to a REAL `PiAgent`, and the REAL `handleProcessStartRequest`
 * answering a `find`-shaped start. Only the supervisor port is a recorder, and
 * the recorded env is then used to run `command -v rg` in a real shell — so the
 * verdict is "the shell found the bundled binary", not "a string contained a
 * directory".
 *
 * The host PATH is pinned to `/usr/bin:/bin` for the arms that need a host with
 * no ripgrep (macOS ships none there; the positive control below proves the
 * shell probe can see a binary when one is on the PATH).
 */

// The pi-agent module graph is large; the bodies are milliseconds.
setDefaultTimeout(120_000);

const HOST_PATH_WITHOUT_RG = ['/usr/bin', '/bin'].join(delimiter);

let root: string;
let appRoot: string;
let bundledRg: string;
let systemRgDir: string;

function writeExecutable(path: string, marker: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho ${marker}\n`);
  chmodSync(path, 0o755);
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'f1727-rg-')));
  // The packaged layout, spelled with the space the real bundle name carries.
  appRoot = join(root, 'Nessy Desktop.app', 'Contents', 'Resources', 'app');
  bundledRg = join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg');
  writeExecutable(bundledRg, 'BUNDLED-RG');
  systemRgDir = join(root, 'system-bin');
  writeExecutable(join(systemRgDir, 'rg'), 'SYSTEM-RG');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function packagedRuntime() {
  return piDriver.buildRuntime({
    context: {
      connection: null,
      provider: 'pi',
      resolvedModel: 'pi/test-model',
      capabilities: { needsHttpPoolServer: false },
    },
    coreConfig: {} as never,
    hostRuntime: {
      appRootPath: appRoot,
      resourcesPath: dirname(appRoot),
      isPackaged: true,
    },
    resolvedPaths: { piServerPath: '/nonexistent/pi-agent-server/index.js' },
  });
}

function createConfig(runtime: Record<string, unknown>, starts: Array<Record<string, unknown>>): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-f1727',
      name: 'F1.727 Workspace',
      rootPath: root,
      workspaceRootPath: root,
      sessionRootPath: join(root, 'sessions'),
    } as never,
    session: {
      id: 'session-f1727',
      workspaceRootPath: root,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as never,
    isHeadless: true,
    skipConfigWatcher: true,
    processSupervisorPort: {
      start: async (request: Record<string, unknown>) => {
        starts.push(request);
        return { handle: 'h', output: '', exitCode: 0 };
      },
    } as never,
    runtime,
  } as BackendConfig;
}

/**
 * Drive one `find`-shaped start — the exact command `LocalToolRuntime.find`
 * builds — and return the PATH the supervisor would run it under: the
 * request's `env.PATH` when the host sent one, else the host's own PATH (the
 * supervisor merges `env` over the selected host environment,
 * `process-supervisor.ts`).
 */
async function effectivePathOfOneFindStart(runtime: Record<string, unknown>, hostPath: string): Promise<{
  requestPath: string | undefined;
  effectivePath: string;
}> {
  const starts: Array<Record<string, unknown>> = [];
  const agent = new PiAgent(createConfig(runtime, starts));
  const sent: Array<Record<string, unknown>> = [];
  (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
  (agent as any).debug = () => {};
  (agent as any).subprocess = {};
  const savedPath = process.env.PATH;
  try {
    // PATH is always set at launch, so an assignment stays enumerable (the
    // AGENTS.md Bun trap is about names ABSENT at launch).
    process.env.PATH = hostPath;
    await (agent as any).handleProcessStartRequest({
      requestId: 'req-find',
      request: {
        executionId: 'exec-find',
        semanticId: 'find',
        command: '/bin/sh',
        args: ['-lc', `'rg' '--files' '--hidden' '--glob' '!**/.git/**' '${root}'`],
        cwd: root,
        profile: 'read-only',
        background: false,
        timeoutMs: 20_000,
      },
    });
  } finally {
    process.env.PATH = savedPath;
    (agent as any).subprocess = null;
    agent.destroy();
  }
  expect(sent.map(message => message.type)).toEqual(['process_start_response']);
  expect(sent[0]!.error).toBeUndefined();
  expect(starts).toHaveLength(1);
  const env = starts[0]!.env as Record<string, string> | undefined;
  return { requestPath: env?.PATH, effectivePath: env?.PATH ?? hostPath };
}

/** What `/bin/sh` resolves `rg` to under this PATH — the real lookup, not a string test. */
function shellResolvesRg(path: string): { status: number | null; stdout: string } {
  const probe = spawnSync('/bin/sh', ['-c', 'command -v rg'], { env: { PATH: path }, encoding: 'utf8' });
  return { status: probe.status, stdout: probe.stdout.trim() };
}

describe('F1.727 — the packaged Pi find/grep reaches the bundled ripgrep', () => {
  it('the Pi driver names the bundled rg of a packaged layout', () => {
    expect(packagedRuntime().paths?.ripgrep).toBe(bundledRg);
  });

  it('a find start on a host with no ripgrep runs under a PATH whose shell finds the bundled rg', async () => {
    // Positive control for the probe itself, same instrument, same minute.
    expect(shellResolvesRg([HOST_PATH_WITHOUT_RG, systemRgDir].join(delimiter)).stdout)
      .toBe(join(systemRgDir, 'rg'));
    // And the host this arm stands for really has none.
    expect(shellResolvesRg(HOST_PATH_WITHOUT_RG).status).not.toBe(0);

    const { effectivePath } = await effectivePathOfOneFindStart(packagedRuntime(), HOST_PATH_WITHOUT_RG);
    expect(shellResolvesRg(effectivePath)).toEqual({ status: 0, stdout: bundledRg });
    // Appended: the host's own entries keep their order and come first.
    expect(effectivePath).toBe([HOST_PATH_WITHOUT_RG, dirname(bundledRg)].join(delimiter));
  });

  it('CONTROL — a host that already resolves rg keeps its own (appended, never shadowing)', async () => {
    const hostPath = [HOST_PATH_WITHOUT_RG, systemRgDir].join(delimiter);
    const { effectivePath } = await effectivePathOfOneFindStart(packagedRuntime(), hostPath);
    expect(shellResolvesRg(effectivePath)).toEqual({ status: 0, stdout: join(systemRgDir, 'rg') });
    expect(effectivePath.startsWith(`${hostPath}${delimiter}`)).toBe(true);
  });

  it('BOUNDARY — nothing to add leaves the start without a PATH key (no ripgrep resolved, or already on PATH)', async () => {
    const noRipgrep = await effectivePathOfOneFindStart({ paths: {} }, HOST_PATH_WITHOUT_RG);
    expect(noRipgrep.requestPath).toBeUndefined();

    const alreadyThere = [HOST_PATH_WITHOUT_RG, dirname(bundledRg)].join(delimiter);
    const deduped = await effectivePathOfOneFindStart(packagedRuntime(), alreadyThere);
    expect(deduped.requestPath).toBeUndefined();
    expect(shellResolvesRg(deduped.effectivePath).stdout).toBe(bundledRg);
  });
});
