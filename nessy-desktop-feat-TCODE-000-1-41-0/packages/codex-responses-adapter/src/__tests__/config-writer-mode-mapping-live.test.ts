/**
 * F1.1056 — each Claude mode on codex's OWN settings, driven on the shipped
 * `codex-app-server` for the one mode whose codex posture this row changed.
 *
 * `dontAsk` is Claude's "Reads and pre-approved tools; anything that would
 * prompt is denied" (permission-modes.md, "Available modes"). With the sandbox
 * master switch ON, `CODEX_PERMISSION_MODE_TABLE` has always given it codex's
 * `read-only` sandbox. With the switch OFF (the shipped default) the profile's
 * parent followed the resolved `danger-full-access` and became `:workspace`,
 * so an in-workspace write landed with no approval at all — wider than Manual
 * on every runtime, recorded as a finding by C3.10 (W16-g) and left out of
 * F1.787 only because that decision named `plan` and `explore`.
 * `codexModeKeepsReadOnlyParent` now gives `dontAsk` codex's own built-in
 * `:read-only` parent in both switch positions, the mechanism F1.787 measured
 * for `plan`.
 *
 * The rig is C3.343's (`config-writer-protected-workspace-paths.test.ts`): the
 * config comes from the product's own `buildCodexConfigToml`, and codex's own
 * `command/exec` runs the command under the permission profile that config
 * selects. Every escalation is REFUSED, so a write that lands is the sandbox's
 * answer and not an approval's.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodexConfigToml, type CodexPermissionMode } from '../config-writer.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const BIN = join(
  REPO_ROOT,
  'apps', 'electron', 'resources', 'bin', 'codex',
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server',
);
const HAVE_BIN = existsSync(BIN);
const LIVE_BUDGET_MS = 180_000;

const RIGS: string[] = [];
afterAll(() => {
  for (const rig of RIGS) rmSync(rig, { recursive: true, force: true });
});

interface ExecOutcome { exitCode: number | undefined; stderr: string }

/** The smallest app-server client that can ask one question: run this, sandboxed. */
class Probe {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout }).on('line', line => this.onLine(line));
    child.stderr.resume();
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const id = msg.id;
    if (typeof id !== 'number') return;
    if (msg.result === undefined && msg.error === undefined) {
      // A server request: refuse every escalation, so nothing below is an approval's doing.
      this.child.stdin.write(`${JSON.stringify({ id, result: { decision: 'denied' } })}\n`);
      return;
    }
    const pending = this.pending.get(id);
    this.pending.delete(id);
    if (!pending) return;
    if (msg.error !== undefined) pending.reject(new Error(JSON.stringify(msg.error)));
    else pending.resolve(msg.result);
  }

  request(method: string, params: unknown = {}, timeoutMs = 90_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  kill(): void { this.child.kill('SIGKILL'); }
}

/** One boot, the product's config for `mode`, one in-workspace write and one read. */
async function driveMode(mode: CodexPermissionMode, sandboxGloballyEnabled: boolean): Promise<{
  write: ExecOutcome; read: ExecOutcome; landed: boolean;
}> {
  const rig = mkdtempSync(join(tmpdir(), 'nessy-f1056-'));
  RIGS.push(rig);
  const workspace = join(rig, 'ws');
  const home = join(rig, 'home');
  mkdirSync(join(workspace, '.git'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(workspace, 'README.md'), 'f1056\n');
  writeFileSync(join(home, 'config.toml'), buildCodexConfigToml({
    codexHome: home,
    model: 'gpt-5-codex',
    adapterPort: 45998,
    mode,
    sandboxGloballyEnabled,
    // The shipped shape: every real session passes the protected-folder floor, so a profile is written.
    protectedWorkspaceSubpaths: ['.git'],
  }));

  const child = spawn(BIN, [], {
    cwd: workspace,
    env: { ...process.env, CODEX_HOME: home, COMPANY_LLM_API_KEY: 'loopback' },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  const probe = new Probe(child);
  try {
    await probe.request('initialize', {
      clientInfo: { name: 'nessy-f1056', title: null, version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    probe.notify('initialized');
    const exec = async (command: string[]): Promise<ExecOutcome> => {
      const result = await probe.request(
        'command/exec', { command, cwd: workspace, timeoutMs: 15_000 }, 60_000,
      ) as { exitCode?: number; stderr?: string };
      return { exitCode: result.exitCode, stderr: result.stderr ?? '' };
    };
    const target = join(workspace, 'f1056.txt');
    return {
      write: await exec(['/usr/bin/touch', target]),
      read: await exec(['/bin/cat', join(workspace, 'README.md')]),
      landed: existsSync(target),
    };
  } finally {
    probe.kill();
  }
}

describe('F1.1056 — the detector is armed', () => {
  test('the pinned codex binary is present, or the skip is said out loud', () => {
    if (!HAVE_BIN) console.warn(`[F1.1056] ${BIN} is absent: the live arms below are skipped`);
    expect(typeof HAVE_BIN).toBe('boolean');
  });
});

describe.if(HAVE_BIN && process.platform !== 'win32')('F1.1056 — dontAsk on the shipped codex binary', () => {
  test('switch OFF (the shipped default): an in-workspace write is refused by the OS, and reads still run', async () => {
    const outcome = await driveMode('dontAsk', false);
    expect(outcome.read.exitCode).toBe(0);
    expect(outcome.write.exitCode).not.toBe(0);
    expect(outcome.write.stderr).toContain('Operation not permitted');
    expect(outcome.landed).toBe(false);
  }, LIVE_BUDGET_MS);

  test('switch ON: the same refusal, so the two positions now agree', async () => {
    const outcome = await driveMode('dontAsk', true);
    expect(outcome.read.exitCode).toBe(0);
    expect(outcome.write.exitCode).not.toBe(0);
    expect(outcome.landed).toBe(false);
  }, LIVE_BUDGET_MS);

  test('CONTROL: Accept edits on the same rig writes the same file, so the refusal is the mode\'s', async () => {
    const outcome = await driveMode('acceptEdits', false);
    expect(outcome.write.exitCode).toBe(0);
    expect(outcome.landed).toBe(true);
  }, LIVE_BUDGET_MS);
});
