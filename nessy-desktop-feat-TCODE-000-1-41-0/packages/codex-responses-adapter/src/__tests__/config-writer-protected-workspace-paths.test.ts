/**
 * C3.343 — the host's protected-path floor, projected onto codex's own
 * `[permissions.<profile>.filesystem.":workspace_roots"]` table.
 *
 * ## What the row measured, and what it turned out to be
 *
 * RS-13 on the packaged 1.36.0 (rig day R1, 2026-09-12) drove one `.git` write
 * per runtime per mode: Pi and claude raised a permission card, codex raised
 * none and the file landed. Driven again here against the shipped
 * `codex-app-server` the reading SPLITS, and the split is the whole design:
 *
 *  - in a workspace outside `/tmp` and `$TMPDIR`, codex ALREADY refuses a
 *    `<ws>/.git` write at HEAD, with no host change — `Operation not permitted`.
 *    It protects three names of its own (`.git`, `.agents`, `.codex`), present or
 *    missing (`default_read_only_subpaths_for_writable_root` and the
 *    `protected_metadata_names` pair, `codex-rs/protocol/src/permissions.rs` at
 *    `rust-v0.150.1`).
 *  - in a workspace UNDER `$TMPDIR` — which is where RS-13's own rig put its
 *    probe repository — the same write LANDS, because `workspace-write` grants
 *    `/tmp` and `$TMPDIR` as writable roots of their own and the `.git` carve-out
 *    is computed per root.
 *  - every OTHER name on the host's list (`.claude`, `.vscode`, `.husky`, …) is
 *    unprotected on codex in both workspaces.
 *
 * So the floor really did not reach the codex arm; the `.git` half of it reached
 * most workspaces by codex's own default. Native-first: the fix enables codex's
 * own per-path mechanism with the host's own list rather than growing a second
 * gate beside it — there is no seam for one, because codex's pre-write
 * `item/started` is a notification it does not wait on
 * (`CodexAgent.checkpointCodexFileChange`).
 *
 * ## Why `read` and never `deny`
 *
 * The floor is about WRITES. `deny` would take the reads with it and stop
 * `git status`, every diff surface and every tool that reads `.git`;
 * `FileSystemAccessMode` is a real three-value `read`/`write`/`deny` and the
 * middle value says exactly "readable, not writable". The live arm asserts the
 * read still works, in the same boot as the refusal, for that reason.
 *
 * ## The two halves are separate files for the reason P2.306 measured
 *
 * The string-builder assertions below prove what we EMIT. Whether the binary
 * HONOURS it is a different proposition — the two have diverged on this runtime
 * before — so the live describe drives the binary and pairs every refusal with
 * an ordinary write that must land, plus a control boot WITHOUT the projection
 * where the same write must succeed. Without that control a rig that refused
 * everything would pass while proving nothing.
 */
import { test, expect, describe, afterAll } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCodexConfigToml,
  buildCodexRuntimeConfigOverride,
  validateConfigAgainstSchema,
  writeCodexConfig,
} from '../config-writer.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SCHEMA = join(REPO_ROOT, 'packages', 'codex-protocol', 'schema', 'config-schema.json');
const BIN = join(
  REPO_ROOT,
  'apps', 'electron', 'resources', 'bin', 'codex',
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server',
);

const BASE = {
  codexHome: '/tmp/nessy-codex-protected-paths',
  model: 'gpt-5-codex',
  adapterPort: 4242,
} as const;

/** Every temp directory this file made, removed in one `afterAll`. */
const RIGS: string[] = [];

afterAll(() => {
  for (const rig of RIGS) rmSync(rig, { recursive: true, force: true });
});

/** The line the floor writes for one entry, as it appears in the emitted TOML. */
const readEntry = (subpath: string): string => `"${subpath}" = "read"`;

/** The scoped table's header, exactly as the writer spells it. */
const SCOPED_HEADER = '[permissions.nessy_runtime.filesystem.":workspace_roots"]';

describe('C3.343 — what the writer emits', () => {
  test('every protected subpath becomes a `read` entry in codex\'s own scoped table', () => {
    const toml = buildCodexConfigToml({
      ...BASE,
      protectedWorkspaceSubpaths: ['.git', '.claude', '.config/git'],
    });
    expect(toml).toContain(SCOPED_HEADER);
    expect(toml).toContain(readEntry('.git'));
    expect(toml).toContain(readEntry('.claude'));
    // A multi-segment entry survives: `parse_relative_subpath` takes it, and the
    // profile the binary compiled from exactly this shape reported `allowed:true`.
    expect(toml).toContain(readEntry('.config/git'));
  });

  test('`read`, never `deny` — the floor is about writes and the reads must survive', () => {
    const toml = buildCodexConfigToml({ ...BASE, protectedWorkspaceSubpaths: ['.git'] });
    expect(toml).not.toContain('".git" = "deny"');
    // …and the entry is not smuggled into the profile's FLAT map, where it would
    // name a relative path codex resolves against nothing.
    const flat = toml.slice(toml.indexOf('[permissions.nessy_runtime.filesystem]'), toml.indexOf(SCOPED_HEADER));
    expect(flat).not.toContain('.git');
  });

  test('ABSENT BY DEFAULT: no list, not one byte different', () => {
    // The negative that keeps this row from changing every session that does not
    // pass a floor — including every OTHER caller of this writer.
    const withoutOption = buildCodexConfigToml({ ...BASE, deniedReadPaths: ['/etc/nessy/token'] });
    const withEmpty = buildCodexConfigToml({
      ...BASE, deniedReadPaths: ['/etc/nessy/token'], protectedWorkspaceSubpaths: [],
    });
    expect(withEmpty).toBe(withoutOption);
    expect(withoutOption).not.toContain(SCOPED_HEADER);
  });

  test('an ordinary workspace path is not in the table — only what the caller named is', () => {
    const toml = buildCodexConfigToml({ ...BASE, protectedWorkspaceSubpaths: ['.git'] });
    expect(toml).not.toContain(readEntry('src'));
    expect(toml).not.toContain(readEntry('.'));
  });

  test('the four spellings codex would reject or misread are refused HERE, loudly', () => {
    // codex discards the WHOLE config.toml on a bad key and says so on stderr
    // only (P2.330's fail-open shape), so each of these has to fail at the
    // writer rather than at the binary.
    const build = (subpath: string): string =>
      buildCodexConfigToml({ ...BASE, protectedWorkspaceSubpaths: [subpath] });
    expect(() => build('/etc/passwd')).toThrow('codex-protected-workspace-subpath-not-relative');
    expect(() => build('~/.ssh')).toThrow('codex-protected-workspace-subpath-not-relative');
    expect(() => build('../outside')).toThrow('codex-protected-workspace-subpath-escapes');
    // A glob subpath is accepted by codex ONLY with `deny` access
    // (`compile_scoped_filesystem_pattern`), and these entries are `read`.
    expect(() => build('**/.git')).toThrow('codex-protected-workspace-subpath-glob');
  });

  test('F1.927 — a name that only STARTS with `~`, or is space-edged, reaches codex verbatim; `~` itself is still refused', () => {
    // codex 0.156.1 reads a `:workspace_roots` subpath as HOME only for `~` or `~/…`
    // (`home_relative_suffix`) and keeps every other spelling as written
    // (`relative_subpath`); measured on the binary 2026-09-26: `~cfg/x` and ` sp/x` as
    // `read` refuse exactly those writes, and the trimmed `sp/x` stays writable.
    const toml = buildCodexConfigToml({ ...BASE, protectedWorkspaceSubpaths: ['~cfg/permissions.json', ' sp/hooks.json'] });
    expect(toml).toContain(readEntry('~cfg/permissions.json'));
    expect(toml).toContain(readEntry(' sp/hooks.json'));
    expect(toml).not.toContain(readEntry('sp/hooks.json'));
    const build = (subpath: string): string =>
      buildCodexConfigToml({ ...BASE, protectedWorkspaceSubpaths: [subpath] });
    expect(() => build('~')).toThrow('codex-protected-workspace-subpath-not-relative');
    expect(() => build('~/cfg/permissions.json')).toThrow('codex-protected-workspace-subpath-not-relative');
  });

  test('the PER-THREAD override carries the same entries, so a refork cannot drop the floor', () => {
    // `applySelectedPluginSkillRuntimePolicy` REPLACES the thread's permission
    // layer with this object. An override without the floor would silently undo
    // it mid-session, which is the shape this runtime has been bitten by before.
    const override = buildCodexRuntimeConfigOverride({
      mode: 'default',
      deniedReadPaths: ['/etc/nessy/token'],
      protectedWorkspaceSubpaths: ['.git', '.claude'],
    }) as {
      permissions?: Record<string, { filesystem?: Record<string, unknown> }>;
    };
    const scoped = override.permissions?.nessy_runtime?.filesystem?.[':workspace_roots'];
    expect(scoped).toEqual({ '.claude': 'read', '.git': 'read' });
  });

  test('the floor SAYS itself once per runtime, and says nothing when there is none', () => {
    // Not a nicety: codex reports a policy refusal as a bare
    // `Operation not permitted` with no attribution, so without this line a user
    // meets an unexplained failure — the P3.184 shape, one floor later. The
    // emission is asserted through `writeCodexConfig`, not through the formatter,
    // because a formatter nothing calls is the inertness defect this tree keeps
    // meeting (P3.2).
    const home = mkdtempSync(join(tmpdir(), 'nessy-c3343-diag-'));
    RIGS.push(home);
    const withFloor: string[] = [];
    writeCodexConfig({
      ...BASE, codexHome: home, protectedWorkspaceSubpaths: ['.git', '.claude'],
      onDiagnostic: message => withFloor.push(message),
    });
    const line = withFloor.find(message => message.startsWith('codex-protected-path-floor-os-enforced:'));
    expect(line).toBeDefined();
    expect(line).toContain('.git');
    expect(line).toContain('PROMPTS');

    const without: string[] = [];
    writeCodexConfig({ ...BASE, codexHome: home, onDiagnostic: message => without.push(message) });
    expect(without.some(message => message.includes('protected-path-floor'))).toBe(false);
  });

  test('the drift guard DEMANDS the profile keys when this floor is the only policy', () => {
    if (!existsSync(SCHEMA)) return;
    // `BASE` names no denied path and no writable root, so the floor alone is
    // what makes `hasCodexRuntimePathPolicy` true — and the guard then requires
    // `default_permissions` and `permissions` of the release schema. A config
    // that emitted the block without the guard demanding it is the silent half of
    // the fail-shape that function exists to refuse.
    expect(() => validateConfigAgainstSchema(
      { ...BASE, protectedWorkspaceSubpaths: ['.git', '.claude'] }, SCHEMA,
    )).not.toThrow();
    expect(buildCodexConfigToml({ ...BASE, protectedWorkspaceSubpaths: ['.git'] }))
      .toContain('default_permissions = "nessy_runtime"');
  });
});

/**
 * The live half. Skipped where the binary is absent — it is a build-time
 * download and gitignored, so CI's Linux container has none.
 */
const HAVE_BIN = existsSync(BIN);
const LIVE_BUDGET_MS = 180_000;

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
      // Refuse every escalation: an ACCEPTED one reruns the command unsandboxed,
      // which would make a hole look like enforcement and the reverse.
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

/**
 * One boot against an isolated `CODEX_HOME`, in a workspace UNDER `$TMPDIR` —
 * deliberately the shape RS-13's own rig had, because that is the shape codex's
 * own default does NOT cover.
 */
async function driveWorkspaceProbe(protectedWorkspaceSubpaths: readonly string[]): Promise<{
  control: ExecOutcome; gitWrite: ExecOutcome; gitRead: ExecOutcome; landed: boolean;
}> {
  const rig = mkdtempSync(join(tmpdir(), 'nessy-c3343-'));
  RIGS.push(rig);
  const workspace = join(rig, 'ws');
  const home = join(rig, 'home');
  mkdirSync(join(workspace, '.git'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(home, 'config.toml'), buildCodexConfigToml({
    codexHome: home,
    model: 'gpt-5-codex',
    adapterPort: 45999,
    // The shipped shape: `default` with the sandbox master switch OFF.
    mode: 'default',
    sandboxGloballyEnabled: false,
    deniedReadPaths: [join(rig, 'outside-credentials.enc')],
    ...(protectedWorkspaceSubpaths.length > 0 ? { protectedWorkspaceSubpaths } : {}),
  }));

  const child = spawn(BIN, [], {
    cwd: workspace,
    env: { ...process.env, CODEX_HOME: home, COMPANY_LLM_API_KEY: 'loopback' },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  const probe = new Probe(child);
  try {
    await probe.request('initialize', {
      clientInfo: { name: 'nessy-c3343', title: null, version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    probe.notify('initialized');
    const exec = async (command: string[]): Promise<ExecOutcome> => {
      const result = await probe.request(
        'command/exec', { command, cwd: workspace, timeoutMs: 15_000 }, 60_000,
      ) as { exitCode?: number; stderr?: string };
      return { exitCode: result.exitCode, stderr: result.stderr ?? '' };
    };
    const target = join(workspace, '.git', 'c3343.txt');
    return {
      control: await exec(['/usr/bin/touch', join(workspace, 'ordinary.txt')]),
      gitWrite: await exec(['/usr/bin/touch', target]),
      gitRead: await exec(['/bin/cat', join(workspace, '.git', 'HEAD')]),
      landed: existsSync(target),
    };
  } finally {
    probe.kill();
  }
}

describe.if(HAVE_BIN && process.platform !== 'win32')('C3.343 — driven on the shipped codex binary', () => {
  test('WITH the floor, a `.git` write is refused and the reads still work', async () => {
    const outcome = await driveWorkspaceProbe(['.git']);
    // The positive control first: without it a refusal below would be a dead rig.
    expect(outcome.control.exitCode).toBe(0);
    expect(outcome.gitWrite.exitCode).not.toBe(0);
    expect(outcome.gitWrite.stderr).toContain('Operation not permitted');
    expect(outcome.landed).toBe(false);
    // `read`, not `deny` — the half that keeps git usable.
    expect(outcome.gitRead.exitCode).toBe(0);
  }, LIVE_BUDGET_MS);

  test('WITHOUT it the same write lands — the control that makes the refusal ours', async () => {
    // A workspace under `$TMPDIR` is writable through codex's own tmp root, so
    // its per-root `.git` carve-out does not cover this one. This is the cell
    // RS-13 measured and the reason the row exists.
    const outcome = await driveWorkspaceProbe([]);
    expect(outcome.control.exitCode).toBe(0);
    expect(outcome.gitWrite.exitCode).toBe(0);
    expect(outcome.landed).toBe(true);
  }, LIVE_BUDGET_MS);
});

/**
 * F1.670 — the writer's absolute `read` carrier (`readOnlyPaths`): an absolute key in the profile's
 * FLAT map with codex's middle `FileSystemAccessMode`, so a host path can be kept from an agent
 * command's writes without taking its reads (F1.659's records, F1.664's config dir — F1.678).
 */
describe('F1.670 — the absolute `read` carrier', () => {
  const FLAT = '[permissions.nessy_runtime.filesystem]';
  test('a read-only path is an absolute `read` key in the flat map, and alone it still writes the profile', () => {
    const toml = buildCodexConfigToml({ ...BASE, mode: 'default', sandboxGloballyEnabled: false, readOnlyPaths: ['/srv/nessy/records/hooks.json'] });
    expect(toml).toContain('default_permissions = "nessy_runtime"');
    const flat = toml.slice(toml.indexOf(FLAT));
    expect(flat).toContain('"/srv/nessy/records/hooks.json" = "read"');
    const override = buildCodexRuntimeConfigOverride({ mode: 'default', sandboxGloballyEnabled: false, readOnlyPaths: ['/srv/nessy/records/hooks.json'] });
    const profile = (override.permissions as Record<string, { filesystem: Record<string, unknown> }>).nessy_runtime;
    expect(profile?.filesystem['/srv/nessy/records/hooks.json']).toBe('read');
  });

  test('BOUNDARY — a path also denied stays denied, and a path also granted refuses the config', () => {
    const toml = buildCodexConfigToml({ ...BASE, deniedReadPaths: ['/srv/nessy/x'], readOnlyPaths: ['/srv/nessy/x'] });
    expect(toml).toContain('"/srv/nessy/x" = "deny"');
    expect(toml).not.toContain('"/srv/nessy/x" = "read"');
    expect(() => buildCodexConfigToml({ ...BASE, writablePaths: ['/srv/nessy/x'], readOnlyPaths: ['/srv/nessy/x'] }))
      .toThrow('codex-runtime-path-policy-conflict');
    expect(() => buildCodexConfigToml({ ...BASE, readOnlyPaths: ['relative/x'] })).toThrow('codex-read-only-path-not-absolute');
  });

  test('ABSENT BY DEFAULT: an empty list is not one byte different', () => {
    expect(buildCodexConfigToml({ ...BASE, deniedReadPaths: ['/etc/nessy/token'], readOnlyPaths: [] }))
      .toBe(buildCodexConfigToml({ ...BASE, deniedReadPaths: ['/etc/nessy/token'] }));
  });
});

/**
 * F1.670 / F1.678 — the carrier driven on the shipped binary, in the layout F1.664 had to `deny`: a
 * folder under `$TMPDIR` (a codex writable root of its own under the `:workspace` parent) with the cwd a
 * project beside it. The absolute `read` key must refuse the write AND keep the read; the control boot
 * without it must let the same write land, and a sibling write beside the folder must land in both.
 */
async function driveReadCarrierProbe(readOnly: boolean): Promise<{
  write: ExecOutcome; read: ExecOutcome; sibling: ExecOutcome; landed: boolean;
}> {
  const rig = mkdtempSync(join(tmpdir(), 'nessy-f1670-'));
  RIGS.push(rig);
  const project = join(rig, 'project');
  const data = join(rig, 'data');
  const home = join(rig, 'home');
  for (const dir of [project, data, home]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(data, 'hooks.json'), '{}\n');
  writeFileSync(join(home, 'config.toml'), buildCodexConfigToml({
    codexHome: home, model: 'gpt-5-codex', adapterPort: 45998,
    mode: 'default', sandboxGloballyEnabled: false,
    protectedWorkspaceSubpaths: ['.git'],
    ...(readOnly ? { readOnlyPaths: [data] } : {}),
  }));
  const child = spawn(BIN, [], {
    cwd: project, env: { ...process.env, CODEX_HOME: home, COMPANY_LLM_API_KEY: 'loopback' }, stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  const probe = new Probe(child);
  try {
    await probe.request('initialize', {
      clientInfo: { name: 'nessy-f1670', title: null, version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    probe.notify('initialized');
    const exec = async (command: string[]): Promise<ExecOutcome> => {
      const result = await probe.request('command/exec', { command, cwd: project, timeoutMs: 15_000 }, 60_000) as { exitCode?: number; stderr?: string };
      return { exitCode: result.exitCode, stderr: result.stderr ?? '' };
    };
    const target = join(data, 'f1670.txt');
    return {
      write: await exec(['/usr/bin/touch', target]),
      read: await exec(['/bin/cat', join(data, 'hooks.json')]),
      sibling: await exec(['/usr/bin/touch', join(rig, 'sibling-f1670.txt')]),
      landed: existsSync(target),
    };
  } finally {
    probe.kill();
  }
}

describe.if(HAVE_BIN && process.platform !== 'win32')('F1.670 / F1.678 — the absolute `read` key on the shipped codex binary', () => {
  test('a folder under $TMPDIR as an absolute `read` key: the write is refused, the read and a sibling write work', async () => {
    const outcome = await driveReadCarrierProbe(true);
    expect(outcome.sibling.exitCode).toBe(0);
    expect(outcome.write.exitCode).not.toBe(0);
    expect(outcome.write.stderr).toContain('Operation not permitted');
    expect(outcome.landed).toBe(false);
    expect(outcome.read.exitCode).toBe(0);
  }, LIVE_BUDGET_MS);

  test('CONTROL — without the key the same write lands (the $TMPDIR root grants it)', async () => {
    const outcome = await driveReadCarrierProbe(false);
    expect(outcome.sibling.exitCode).toBe(0);
    expect(outcome.write.exitCode).toBe(0);
    expect(outcome.landed).toBe(true);
  }, LIVE_BUDGET_MS);
});
