/**
 * F1.107 (origin `D1.432`, the F1.12 safety review's critic, MEDIUM and
 * UNVERIFIED) — what does `script_sandbox`'s sandbox profile actually DENY?
 *
 * The claim under test, verbatim from the origin row: *"`script_sandbox` reads
 * the whole filesystem outside every read floor: it is not in
 * `READS_OUTSIDE_WORKING_DIRECTORIES_TOOLS`, its input carries no path field for
 * `getDeniedPathViolation`, and it raises no card on any surface — only the
 * credential roots are denied."*
 *
 * ## This file MEASURES rather than re-reads the source
 *
 * Two of the three clauses are settled by reading (`script_sandbox` is not in
 * that tool set; `ScriptSandboxArgs` carries `script`/`inputFiles`/`stdin` and
 * no path). The third — *only the credential roots are denied* — is a claim
 * about the PROFILE, and a source read cannot see it: the deny list is composed
 * in the handler, handed to `applyFilesystemIsolation`, rendered into a
 * `sandbox-exec` profile string and enforced by the kernel. So every case here
 * drives the REAL handler, which builds the REAL profile and spawns a REAL
 * sandboxed child, and reads what the child could and could not open.
 *
 * ## The positive control comes FIRST, and every case is gated on it
 *
 * An absence finding needs a positive control on the same rig (AGENTS.md), and
 * here the hazard is specific: on a host with no usable `sandbox-exec` the
 * handler fails closed and EVERY read is refused — which reads exactly like a
 * floor that binds. {@link sandboxEnforced} spawns one script that reads a file
 * the credential floor denies (`<configRoot>/credentials.enc`, the first entry
 * of `credentialDenyRoots`, pointed at this test's own temp dir so no real
 * credential is touched) and one that reads a file nothing denies. The rig is
 * usable only when the first is refused AND the second succeeds; otherwise the
 * suite skips, because a rig that refuses everything can prove nothing about a
 * floor.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionToolContext } from '../context.ts';
import { handleScriptSandbox } from './script-sandbox.ts';

const SECRET = 'WJ-L-F1-107-SECRET-PAYLOAD';
const OPEN_MARKER = 'WJ-L-F1-107-OPEN-PAYLOAD';
const LATCHED_SECRET = 'WJ-L-F1-191-LATCHED-HOME-CREDS';

describe('script_sandbox read floor (F1.107)', () => {
  let rootDir: string;
  let sessionDir: string;
  let dataDir: string;
  /** Outside the session directory, inside no credential root: the vault. */
  let vaultDir: string;
  let vaultFile: string;
  /** Outside the session directory and denied by nothing: the negative. */
  let openFile: string;

  beforeEach(() => {
    // `realpathSync`, and the reason is a MEASUREMENT: on macOS `$TMPDIR` is
    // `/var/folders/…`, a symlink to `/private/var/folders/…`, and
    // `buildDarwinSandboxProfile` renders every deny root through `resolve()`,
    // which is LEXICAL. A lexically-spelled deny of a path the kernel knows by
    // its canonical name never matches, so the FIRST run of this file read a
    // credential-floor file back with `filesystemIsolation: enforced` beside it.
    // The rig is canonicalised here so the cases measure the read POLICY; the
    // lexical/canonical gap itself is a separate finding (the supervised funnel
    // pairs both spellings, `server-core/src/pi-harness/isolation.ts` symbol
    // `denyRootPair`; this handler pairs neither).
    rootDir = realpathSync(mkdtempSync(join(tmpdir(), 'script-sandbox-read-floor-')));
    sessionDir = join(rootDir, 'session');
    dataDir = join(sessionDir, 'data');
    vaultDir = join(rootDir, 'vault');
    vaultFile = join(vaultDir, 'secret.txt');
    openFile = join(rootDir, 'open.txt');

    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(vaultFile, SECRET);
    writeFileSync(openFile, OPEN_MARKER);
    // The credential floor's first entry is `join(configRoot, 'credentials.enc')`
    // and `configRoot` is this temp directory, so the control reads a file this
    // test created rather than anything of the developer's.
    writeFileSync(join(rootDir, 'credentials.enc'), 'control-credential');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function ctx(extra: Partial<SessionToolContext> = {}): SessionToolContext {
    return {
      configRoot: rootDir,
      sessionId: 'read-floor-session',
      workspacePath: rootDir,
      sourcesPath: join(rootDir, 'sources'),
      skillsPath: join(rootDir, 'skills'),
      plansFolderPath: join(sessionDir, 'plans'),
      workingDirectory: sessionDir,
      callbacks: { onPlanSubmitted: () => {}, onAuthRequest: () => {} },
      fs: {
        exists: () => false,
        readFile: () => '',
        readFileBuffer: () => Buffer.from(''),
        writeFile: () => {},
        isDirectory: () => false,
        readdir: () => [],
        stat: () => ({ size: 0, isDirectory: () => false }),
      },
      loadSourceConfig: () => null,
      sessionPath: sessionDir,
      dataPath: dataDir,
      ...extra,
    } as SessionToolContext;
  }

  /** `node -e`-style read, reported as one line the assertions can read. */
  function readScript(path: string): string {
    return `try { process.stdout.write('READ:' + require('node:fs').readFileSync(${JSON.stringify(path)}, 'utf8')) }`
      + ` catch (e) { process.stdout.write('DENIED:' + String(e && e.code)) }`;
  }

  async function run(path: string, extra: Partial<SessionToolContext> = {}): Promise<string> {
    const result = await handleScriptSandbox(ctx(extra), {
      language: 'node',
      script: readScript(path),
      timeoutMs: 5_000,
    });
    return result.content[0]?.text ?? '';
  }

  /**
   * Is the profile binding on this rig at all? Both halves are required: a
   * credential-floor read refused, and an undenied read outside the session
   * directory allowed. The second half is what separates "the floor binds" from
   * "the handler failed closed and nothing ran".
   */
  async function sandboxEnforced(): Promise<boolean> {
    const control = await run(join(rootDir, 'credentials.enc'));
    const negative = await run(openFile);
    return control.includes('DENIED:')
      && control.includes('filesystemIsolation: enforced')
      && negative.includes(`READ:${OPEN_MARKER}`);
  }

  it('POSITIVE CONTROL — the credential floor binds and an undenied read outside the session directory does not', async () => {
    const control = await run(join(rootDir, 'credentials.enc'));
    const negative = await run(openFile);
    // ONE unconditional assertion on a DERIVED verdict, rather than an
    // `expect` inside an `if` — `lint:conditional-expect`'s rule, and the
    // reason is this file's own hazard: a branch that returns early takes its
    // assertion with it, so the arm that matters most would be the one that
    // stopped running. `no-backend` is a legitimate outcome on a host with no
    // usable `sandbox-exec` (the handler's fail-closed path is pinned by
    // `script-sandbox.test.ts`); every other non-`enforced` value names what
    // went wrong and fails here.
    const verdict = !control.includes('filesystemIsolation: enforced')
      ? 'no-backend'
      : !control.includes('DENIED:')
        ? `the credential floor did NOT bind: ${control}`
        : !negative.includes(`READ:${OPEN_MARKER}`)
          ? `an undenied read outside the session directory was refused: ${negative}`
          : 'enforced';
    expect(['enforced', 'no-backend']).toContain(verdict);
  }, 30_000);

  it('a path the host declares denied is UNREADABLE by a sandboxed script', async () => {
    if (!(await sandboxEnforced())) return;
    // The host's read policy, handed to the tool the way `configRoot` already
    // is. Before F1.107 the handler ignored it and the secret came back in
    // stdout with `filesystemIsolation: enforced` on the same receipt; that is
    // the failing arm this row was measured with.
    const text = await run(vaultFile, {
      sandboxReadFloor: () => ({ deniedReadRoots: [vaultDir] }),
    });
    expect(text).not.toContain(SECRET);
    expect(text).toContain('DENIED:');
  }, 30_000);

  it('a host-declared denial does not blind the script to everything else', async () => {
    if (!(await sandboxEnforced())) return;
    const text = await run(openFile, {
      sandboxReadFloor: () => ({ deniedReadRoots: [vaultDir] }),
    });
    expect(text).toContain(`READ:${OPEN_MARKER}`);
  }, 30_000);

  /**
   * The residue made visible rather than silent. A runtime that has not been
   * wired to the accessor — codex, whose context is built in the session-MCP
   * subprocess — keeps the credential floor and says so on its own receipt, so
   * the per-runtime difference is readable from a transcript instead of being
   * something only the source shows.
   */
  it('the receipt names which floor the profile carried, declared or not', async () => {
    if (!(await sandboxEnforced())) return;
    const undeclared = await run(openFile);
    expect(undeclared).toContain('this runtime declares no read policy');

    const declared = await run(openFile, {
      sandboxReadFloor: () => ({ deniedReadRoots: [vaultDir] }),
    });
    expect(declared).toMatch(/readFloor: \d+ denied roots \(\d+ credential floor, 1 host read policy\)/);
  }, 30_000);

  /**
   * F1.191 (origin WJ-k P-WJk-1) — the credential roots anchor on the home the
   * HOST says the session started with, not on this process's live
   * `os.homedir()`.
   *
   * The live home follows a confirmed managed `HOME` on Node and Electron
   * (`shared/src/config/home-latch.ts` measures all three runtimes), while the
   * credential store stays latched to the launch home, so a floor built from the
   * live value denied `<managed home>/.nessy` and left the real
   * `~/.nessy/dp_auth_creds.json` readable. The launch home here is a directory
   * of this test's own, holding a fake creds file, so nothing of the developer's
   * is read; under `bun test` moving `process.env.HOME` moves nothing (P3.169),
   * which is why the arm moves the host's answer instead.
   */
  it('F1.191 — the credential floor anchors on the host LATCHED home, not the live one', async () => {
    if (!(await sandboxEnforced())) return;
    const launchHome = join(rootDir, 'launch-home');
    const creds = join(launchHome, '.nessy', 'dp_auth_creds.json');
    mkdirSync(join(launchHome, '.nessy'), { recursive: true });
    writeFileSync(creds, LATCHED_SECRET);

    const latched = await run(creds, { credentialHomeDir: () => launchHome });
    expect(latched).not.toContain(LATCHED_SECRET);
    expect(latched).toContain('DENIED:');

    // CONTROL on the same rig: with no host answer the floor anchors on the live
    // home, which this directory is not — so the same file reads back. That is
    // both the pre-F1.191 behaviour and the documented fallback for a context
    // that supplies nothing, and it is what makes the arm above able to fail.
    const live = await run(creds);
    expect(live).toContain(`READ:${LATCHED_SECRET}`);
  }, 30_000);

  /**
   * `permissions.blockReadsOutsideWorkingDirectories` names an ALLOW boundary
   * and only one of the three isolation backends can express a read allowlist,
   * so the tool refuses instead of shipping a fence that binds on darwin alone.
   * Asserted WITHOUT the sandbox gate: the refusal is decided before any
   * backend is resolved, which is also why it cannot be mistaken for the
   * fail-closed "no backend" path — the message names the setting.
   */
  it('refuses outright while the host fences reads to the working directories', async () => {
    const result = await handleScriptSandbox(
      ctx({ sandboxReadFloor: () => ({ readsFencedToWorkingDirectory: true }) }),
      { language: 'node', script: "console.log('never runs')", timeoutMs: 1_500 },
    );
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('permissions.blockReadsOutsideWorkingDirectories');
    expect(text).not.toContain('isolationPolicy:');

    // The negative that keeps the arm honest: the same context with the fence
    // OFF runs, so the refusal is the setting's doing and not the rig's.
    const off = await handleScriptSandbox(
      ctx({ sandboxReadFloor: () => ({ readsFencedToWorkingDirectory: false }) }),
      { language: 'node', script: "console.log('runs')", timeoutMs: 1_500 },
    );
    expect(off.content[0]?.text ?? '').not.toContain('blockReadsOutsideWorkingDirectories');
  }, 30_000);
});
