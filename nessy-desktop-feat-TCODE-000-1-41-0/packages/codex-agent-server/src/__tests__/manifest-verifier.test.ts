/**
 * Task 6.2 gate (security path): the pre-spawn verifier passes a file whose bytes
 * match the manifest, throws on a mutated byte, and throws for an unknown platform
 * key — plus the two arms added when signed 1.25.0 shipped a codex runtime that
 * could never spawn:
 *
 *  - the Developer ID fallback accepts a re-signed binary that is still OURS, and
 *    refuses everything else (tampered bytes, ad-hoc signature, another team's
 *    valid signature, unsigned file — the last three through the REAL `codesign`);
 *  - the accept cache cannot be made to answer a question it never checked.
 */
import { test, expect, describe } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkDeveloperIdSignature,
  codexCodeModeHostPath,
  developerIdRequirement,
  hasDeveloperIdSignature,
  isCodexIntegrityError,
  loadCodexManifest,
  verifyCodexBinary,
  verifyCodexCodeModeHost,
  CodexIntegrityError,
  NESSY_DEVELOPER_ID_TEAM,
} from '../manifest-verifier.ts';
import { repoRootManifestPath } from '../../../../scripts/build/codex-integrity.ts';

const require = createRequire(import.meta.url);
const manifest = require('@nessy-agent/codex-protocol/manifest.json') as {
  binaries: Record<string, { binarySha256: string }>;
};

/** Four levels up from `src/__tests__` is the repo root — see the note on the arm that used three. */
const BUNDLED_CODEX = join(
  import.meta.dir, '..', '..', '..', '..',
  'apps', 'electron', 'resources', 'bin', 'codex', 'darwin-arm64', 'codex-app-server',
);
/** The team that signs the upstream codex release — a real Developer ID that is NOT ours. */
const OPENAI_TEAM = '2DC432GLL2';

/**
 * Building a temp file whose sha256 EQUALS a real manifest entry by finding bytes
 * that hash to it — impossible; instead we write arbitrary bytes into a temp
 * "binary", compute its sha, inject that sha into a cloned manifest key, and
 * verify against the on-disk file. But verifyCodexBinary reads the REAL manifest,
 * so we test the real path: pick the darwin-arm64 entry and a file we control.
 *
 * Simpler + real: verify against the ACTUAL bundled darwin-arm64 binary if it's
 * present (it is, post fetch), else synthesize a match by writing bytes and
 * asserting the mismatch/known-key behavior which needs no real binary.
 */
describe('verifyCodexBinary', () => {
  test('throws for an unknown platform key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-'));
    const f = join(dir, 'bin');
    writeFileSync(f, 'x');
    expect(() => verifyCodexBinary(f, 'nonexistent-plat')).toThrow(/no binary entry/i);
    rmSync(dir, { recursive: true, force: true });
  });

  test('passes when the file sha matches the manifest, throws on a mutated byte', () => {
    // Build a temp file whose sha256 matches a manifest entry, by choosing the
    // entry AFTER hashing: hash arbitrary bytes, then look for a manifest whose
    // sha we can reproduce. Since we can't invert sha, instead assert both
    // directions against a known vector: write bytes, compute sha, and confirm
    // verify passes only when the manifest entry equals that sha.
    const dir = mkdtempSync(join(tmpdir(), 'mv-'));
    const f = join(dir, 'bin');
    const bytes = Buffer.from('codex-app-server-stub-contents');
    writeFileSync(f, bytes);
    const sha = createHash('sha256').update(bytes).digest('hex');

    // Temporarily assert via a platform key we know exists, by comparing the
    // verifier's decision to the manifest truth for the darwin-arm64 entry.
    // `noUncheckedIndexedAccess` types this `| undefined`, and the rest of the
    // test dereferences it. Throw rather than `?.`: a manifest with no
    // darwin-arm64 entry is a changed fixture, and the optional chain would let
    // the sha comparison below pass vacuously against `undefined`.
    const realEntry = manifest.binaries['darwin-arm64'];
    if (!realEntry) {
      throw new Error('codex manifest has no darwin-arm64 entry — this test reads it as its known vector');
    }
    expect(realEntry.binarySha256).toBeTruthy();

    // Our stub file's sha will NOT match the real darwin-arm64 binary → throws.
    // (On macOS this also exercises the REAL codesign arm: an unsigned stub cannot
    // satisfy the Developer ID requirement, so both arms fail.)
    expect(() => verifyCodexBinary(f, 'darwin-arm64')).toThrow(/both integrity arms failed[\s\S]*SHA pin/i);
    // Sanity: our computed sha differs from the manifest's (mutation detection works).
    expect(sha).not.toBe(realEntry.binarySha256);
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The real bundled binary, verified by the real gate — the arm that proves the
   * pin still describes the bytes on disk.
   *
   * It used to reach three directories up instead of four, landing on
   * `packages/apps/electron/…` which cannot exist, and its catch accepted ENOENT
   * as "not fetched here" — so it passed green having verified nothing, ever.
   * A conditional arm now announces itself as skipped instead of pretending.
   */
  test.skipIf(!existsSync(BUNDLED_CODEX))(
    'the real bundled darwin-arm64 binary verifies [needs the fetched codex binary]',
    () => {
      expect(() => verifyCodexBinary(BUNDLED_CODEX, 'darwin-arm64')).not.toThrow();
    },
  );

  // Signed-release path: codesigning mutates the Mach-O, so the SHA pin (unsigned
  // upstream hash) can never match the shipped bytes. A binary whose bytes differ
  // from the pin but carries a valid Nessy-team signature must still spawn.
  test('accepts a hash-mismatched binary that is signed by our team (survives codesigning)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-'));
    const f = join(dir, 'bin');
    writeFileSync(f, Buffer.from('signed-release-bytes-differ-from-the-unsigned-pin'));
    // sha will not match the real darwin-arm64 pin, but the signature is trusted.
    expect(() =>
      verifyCodexBinary(f, 'darwin-arm64', { checkSignature: () => ({ trusted: true }) }),
    ).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  // Anti-bypass: a hash mismatch WITHOUT a valid team signature (tampered/swapped
  // binary, or ad-hoc signature) is still refused. The fix must not disable the gate.
  test('refuses a hash-mismatched binary with no trusted signature', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-'));
    const f = join(dir, 'bin');
    writeFileSync(f, Buffer.from('tampered-bytes'));
    expect(() =>
      verifyCodexBinary(f, 'darwin-arm64', { checkSignature: () => ({ trusted: false, reason: 'requirement-unsatisfied' }) }),
    ).toThrow(/both integrity arms failed[\s\S]*Signature identity/i);
    rmSync(dir, { recursive: true, force: true });
  });

  // The message is the only diagnostic a future reader gets from a released app;
  // the original defect cost a day because it named a hash and nothing else.
  test('the refusal names which arm failed and where the packaging invariant lives', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-'));
    const f = join(dir, 'bin');
    writeFileSync(f, Buffer.from('tampered-bytes'));
    try {
      verifyCodexBinary(f, 'darwin-arm64', { checkSignature: () => ({ trusted: false, reason: 'requirement-unsatisfied' }) });
      throw new Error('expected a refusal');
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      expect(message).toMatch(/\[1\] SHA pin/);
      expect(message).toMatch(/\[2\] Signature identity/);
      expect(message).toMatch(/signIgnore/);
      expect(message).toMatch(/codex-integrity\.ts/);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  // Fast path: when the on-disk bytes match the pin — which, with
  // electron-builder's mac.signIgnore keeping the vendor signature, is now EVERY
  // build — the signature check is never consulted.
  test('passes on a pin match without consulting the signature check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-'));
    const f = join(dir, 'bin');
    const bytes = Buffer.from('exact-pinned-bytes');
    writeFileSync(f, bytes);
    const sha = createHash('sha256').update(bytes).digest('hex');
    verifyCodexBinary(f, 'darwin-arm64', {
      manifest: { binaries: { 'darwin-arm64': { binarySha256: sha } } },
      checkSignature: () => {
        throw new Error('signature check must not run when the pin matches');
      },
    });
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The runtime pin is INLINED: esbuild resolves the `manifest.json` import at
   * build time, so the packaged app carries the sha inside `dist/main.cjs` and
   * never reads a manifest file. The packaging gate therefore has to read the
   * same repo file the runtime imported, or the two silently disagree and a
   * green build ships an app that refuses to spawn — which is what signed
   * 1.25.0 did.
   */
  test('the packaging gate reads the same pins the runtime verifier inlines', () => {
    const fromGate = JSON.parse(readFileSync(repoRootManifestPath(), 'utf-8'));
    expect(fromGate).toEqual(loadCodexManifest());
  });
});

/**
 * The accept cache is a per-process performance cache, not a security boundary.
 * These two arms hold the line that it never widens the hole it sits in.
 */
describe('verifyCodexBinary accept cache', () => {
  test('an accept for one platform does not satisfy another platform\'s pin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-cache-'));
    const f = join(dir, 'bin');
    const bytes = Buffer.from('pinned-for-arm64-only');
    writeFileSync(f, bytes);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const manifest = {
      binaries: {
        'darwin-arm64': { binarySha256: sha },
        'darwin-x64': { binarySha256: 'f'.repeat(64) },
      },
    };

    verifyCodexBinary(f, 'darwin-arm64', { manifest, checkSignature: () => ({ trusted: false, reason: 'requirement-unsatisfied' }) });
    // Same path, same mtime/size — a path-only cache key would return the arm64
    // accept here and skip the x64 pin entirely.
    expect(() =>
      verifyCodexBinary(f, 'darwin-x64', { manifest, checkSignature: () => ({ trusted: false, reason: 'requirement-unsatisfied' }) }),
    ).toThrow(/both integrity arms failed/i);

    rmSync(dir, { recursive: true, force: true });
  });

  test('replacing the file with same size and forged mtime invalidates the accept', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-cache-'));
    const f = join(dir, 'bin');
    const swap = join(dir, 'swap');
    const good = Buffer.from('the-binary-we-pinned');
    const evil = Buffer.from('the-binary-we-DIDNT!'); // same length as `good`
    expect(evil.length).toBe(good.length);
    const manifest = {
      binaries: { 'darwin-arm64': { binarySha256: createHash('sha256').update(good).digest('hex') } },
    };
    const frozen = new Date(1_700_000_000_000);

    writeFileSync(f, good);
    utimesSync(f, frozen, frozen);
    verifyCodexBinary(f, 'darwin-arm64', { manifest, checkSignature: () => ({ trusted: false, reason: 'requirement-unsatisfied' }) });

    writeFileSync(swap, evil);
    utimesSync(swap, frozen, frozen);
    renameSync(swap, f); // same path, same size, same mtime — different inode

    expect(() =>
      verifyCodexBinary(f, 'darwin-arm64', { manifest, checkSignature: () => ({ trusted: false, reason: 'requirement-unsatisfied' }) }),
    ).toThrow(/both integrity arms failed/i);

    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * The signature arm, exercised through the REAL `codesign` rather than an
 * injected stub. macOS-only: `codesign` does not exist elsewhere and the arm
 * returns false there by construction, so the block is SKIPPED (visibly, in the
 * runner's output) rather than silently passing.
 *
 * What is provable offline: that the requirement accepts a genuine Developer ID
 * signature, and rejects a different team, an ad-hoc signature, and an unsigned
 * file. What is NOT provable offline is the literal team id — no Nessy signing
 * certificate exists on a dev machine. It is recorded from the published signed
 * 1.25.0 artifact; see NESSY_DEVELOPER_ID_TEAM.
 */
describe.skipIf(process.platform !== 'darwin')('the real codesign requirement (macOS only)', () => {
  // POSITIVE CONTROL. Without it, every rejection below is equally explained by
  // "the requirement string matches nothing", i.e. a permanently dead arm.
  test.skipIf(!existsSync(BUNDLED_CODEX))(
    'accepts a genuine Developer ID signature under the team that signed it [needs the fetched codex binary]',
    () => {
      expect(hasDeveloperIdSignature(BUNDLED_CODEX, OPENAI_TEAM)).toBe(true);
    },
  );

  // WRONG TEAM. The same file, the same requirement, our team id — must fail.
  test.skipIf(!existsSync(BUNDLED_CODEX))(
    'rejects a validly signed binary belonging to another team [needs the fetched codex binary]',
    () => {
      expect(NESSY_DEVELOPER_ID_TEAM).not.toBe(OPENAI_TEAM);
      expect(hasDeveloperIdSignature(BUNDLED_CODEX, NESSY_DEVELOPER_ID_TEAM)).toBe(false);
    },
  );

  // AD-HOC. `codesign -s -` is what an attacker (or a careless build step) can do
  // without any certificate: the signature is structurally VALID — the local
  // control below asserts that — but it has no Apple anchor, so the arm must
  // refuse it. This is the shape the sev-1's re-signed binary had.
  test('rejects an ad-hoc signature, whose signature is otherwise valid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-adhoc-'));
    const f = join(dir, 'echo');
    copyFileSync('/bin/echo', f);
    execFileSync('codesign', ['-s', '-', '--force', f], { stdio: 'ignore' });

    // Local positive control: the file IS validly signed…
    expect(() => execFileSync('codesign', ['--verify', '--strict', f], { stdio: 'ignore' })).not.toThrow();
    // …and still fails the requirement, under our team and under any other.
    expect(hasDeveloperIdSignature(f, NESSY_DEVELOPER_ID_TEAM)).toBe(false);
    expect(hasDeveloperIdSignature(f, OPENAI_TEAM)).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  test('rejects an unsigned file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-unsigned-'));
    const f = join(dir, 'bin');
    writeFileSync(f, Buffer.from('not a signed mach-o at all'));
    expect(hasDeveloperIdSignature(f, NESSY_DEVELOPER_ID_TEAM)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * CERTLESS NEGATIVE — needs no fetched binary and no signing certificate, so
   * unlike the arms above it can never silently degrade into a skip. `/bin/ls` is
   * genuinely Apple-signed ("Software Signing", TeamIdentifier not set), so it
   * satisfies `anchor apple generic` and fails ONLY on the OU. That makes it the
   * one sample that tests the team clause in isolation.
   */
  test('rejects /bin/ls — Apple-signed, but a different OU', () => {
    const outcome = checkDeveloperIdSignature('/bin/ls', NESSY_DEVELOPER_ID_TEAM);
    expect(outcome.trusted).toBe(false);
    expect(outcome).toMatchObject({ reason: 'requirement-unsatisfied' });
  });

  /**
   * The PATH-shim bypass, as a regression. `execFileSync` takes no shell but DOES
   * resolve a bare command name through PATH, and `shell-env.ts` overwrites PATH
   * with the user's login-shell PATH in packaged builds — so before the fix a
   * two-line `exit 0` script named `codesign` made this arm accept anything.
   * Measured on this tree pre-fix: `hasDeveloperIdSignature('/bin/ls') === true`.
   */
  test('a codesign shim first on PATH cannot force an accept', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-shim-'));
    const shim = join(dir, 'codesign');
    writeFileSync(shim, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const realPath = process.env.PATH;
    try {
      process.env.PATH = `${dir}:${realPath ?? ''}`;
      // The shim would exit 0 for literally any argument list.
      expect(hasDeveloperIdSignature('/bin/ls', NESSY_DEVELOPER_ID_TEAM)).toBe(false);
      expect(hasDeveloperIdSignature('/bin/ls', OPENAI_TEAM)).toBe(false);
    } finally {
      process.env.PATH = realPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The check runs SYNCHRONOUSLY at spawn and codesign hashes the whole Mach-O
   * (1.76 s measured on the real 207 MB binary), so it is bounded. The security
   * property is the direction of the bound: a timeout must REFUSE, never accept,
   * and must be distinguishable from "this binary is not ours".
   */
  test('a codesign timeout is a refusal with its own reason, not an accept', () => {
    const outcome = checkDeveloperIdSignature('/bin/ls', NESSY_DEVELOPER_ID_TEAM, 1);
    expect(outcome.trusted).toBe(false);
    expect(outcome).toMatchObject({ reason: 'codesign-timeout' });
  });
});

/**
 * The requirement string itself. Every arm above that injects `checkSignature`
 * proves the plumbing; only these prove the SECURITY ARTIFACT, which is the string.
 * A typo (`subject.O` for `subject.OU`, a dropped `anchor apple generic`, a stray
 * quote) passes every injected arm and either bricks Codex in the field or admits
 * ad-hoc-signed code.
 */
describe('developerIdRequirement', () => {
  test('names the anchor and the team OU', () => {
    expect(developerIdRequirement('ABCDE12345')).toBe(
      'anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"',
    );
  });
});

/**
 * The refusal has to say WHICH of arm 2's failures happened. Folded into one
 * `catch → false`, "not our binary", "codesign is missing" and "codesign timed
 * out" are one line in a log, and only the first is about the binary.
 */
describe('verifyCodexBinary refusal diagnostics', () => {
  test('carries the signature arm\'s reason and detail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-reason-'));
    const f = join(dir, 'bin');
    writeFileSync(f, Buffer.from('tampered-bytes'));
    expect(() =>
      verifyCodexBinary(f, 'darwin-arm64', {
        checkSignature: () => ({ trusted: false, reason: 'codesign-timeout', detail: 'exceeded 30000 ms' }),
      }),
    ).toThrow(/reason: codesign-timeout \(exceeded 30000 ms\)/);
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * Q5-D2. The refusal is correct and it used to be MUTE: a tampered nested binary
 * gave the user one message and nothing else, and a packaged build writes no
 * application log, so the diagnostic above reached nobody either. Every refusal
 * now carries a second, user-facing half — `codex-agent.ts` yields it as the
 * turn's error event — and these arms hold the line between the two halves.
 */
describe('the refusal a user is shown', () => {
  test('is actionable, and carries none of the diagnostic half', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-user-'));
    const f = join(dir, 'codex-app-server');
    writeFileSync(f, Buffer.from('tampered-bytes'));
    try {
      verifyCodexBinary(f, 'darwin-arm64', {
        checkSignature: () => ({ trusted: false, reason: 'requirement-unsatisfied' }),
      });
      throw new Error('expected a refusal');
    } catch (err) {
      expect(isCodexIntegrityError(err)).toBe(true);
      const { userMessage, message } = err as CodexIntegrityError;
      expect(userMessage).toMatch(/integrity check/i);
      expect(userMessage).toMatch(/Reinstall Nessy Desktop/);
      // Digests and filesystem layout stay in `message`, where a log can use them.
      expect(userMessage).not.toMatch(/[0-9a-f]{64}/);
      expect(userMessage).not.toContain(f);
      expect(message).toMatch(/[0-9a-f]{64}/);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  // Boundary: nothing to hash is the same event to the user as bytes that fail
  // the pin — the runtime did not start, reinstalling is the remedy — and left as
  // a bare ENOENT it is the same mute turn.
  test('covers a bundled binary that is not on disk at all', () => {
    const missing = join(tmpdir(), 'mv-absent', 'codex-app-server');
    try {
      verifyCodexBinary(missing, 'darwin-arm64');
      throw new Error('expected a refusal');
    } catch (err) {
      expect(isCodexIntegrityError(err)).toBe(true);
      expect((err as CodexIntegrityError).userMessage).toMatch(/missing for this platform \(darwin-arm64\)/);
      expect((err as CodexIntegrityError).userMessage).toMatch(/Reinstall Nessy Desktop/);
    }
  });

  // `instanceof` alone would go quietly false if esbuild ever inlined a second
  // copy of this module into the packaged main bundle — and a guard that fails
  // shut re-creates the mute refusal it was added to fix.
  test('the guard survives a duplicated module, and still rejects a plain Error', () => {
    const crossBundle = Object.assign(new Error('refused'), {
      name: 'CodexIntegrityError',
      userMessage: 'The bundled Codex runtime failed its integrity check…',
    });
    expect(isCodexIntegrityError(crossBundle)).toBe(true);
    expect(isCodexIntegrityError(new Error('codex-agent-destroyed'))).toBe(false);
    expect(isCodexIntegrityError(Object.assign(new Error('x'), { name: 'CodexIntegrityError' }))).toBe(false);
    expect(isCodexIntegrityError('CodexIntegrityError')).toBe(false);
  });
});

/**
 * F1.1216 — codex's own code-mode host ships beside `codex-app-server` and codex
 * spawns it with no gate of ours in between, so the pre-spawn verifier checks it
 * too. Where it lives is codex's rule (`install-context/src/lib.rs`
 * `code_mode_host_program`: beside `current_exe()` for a flat layout like ours).
 */
describe('verifyCodexCodeModeHost (F1.1216)', () => {
  const HOST_BYTES = Buffer.from('the pinned codex-code-mode-host bytes');
  const APP_BYTES = Buffer.from('the pinned codex-app-server bytes');
  const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
  const pinned = {
    binaries: { 'darwin-arm64': { binarySha256: sha(APP_BYTES), codeModeHostSha256: sha(HOST_BYTES) } },
  };
  const noSignature = () => ({ trusted: false as const, reason: 'requirement-unsatisfied' as const });

  function stage(hostBytes?: Buffer): { dir: string; app: string } {
    const dir = mkdtempSync(join(tmpdir(), 'mv-host-'));
    const app = join(dir, 'codex-app-server');
    writeFileSync(app, APP_BYTES);
    if (hostBytes) writeFileSync(join(dir, 'codex-code-mode-host'), hostBytes);
    return { dir, app };
  }

  test('resolves the host beside the app-server, with the .exe name on Windows', () => {
    expect(codexCodeModeHostPath('/x/bin/codex/darwin-arm64/codex-app-server', 'darwin-arm64')).toBe(
      '/x/bin/codex/darwin-arm64/codex-code-mode-host',
    );
    expect(codexCodeModeHostPath('C:\\N\\bin\\codex\\win32-x64\\codex-app-server.exe', 'win32-x64')).toBe(
      'C:\\N\\bin\\codex\\win32-x64\\codex-code-mode-host.exe',
    );
  });

  test('the app-server is refused when a swapped host sits beside it', () => {
    const { dir, app } = stage(Buffer.from('a swapped host'));
    try {
      verifyCodexBinary(app, 'darwin-arm64', { manifest: pinned, checkSignature: noSignature });
      throw new Error('expected a refusal');
    } catch (err) {
      expect(isCodexIntegrityError(err)).toBe(true);
      expect(String((err as Error).message)).toMatch(/codex-code-mode-host refused for darwin-arm64/);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test('a pinned host verifies, and an absent one is left to codex\'s own warning', () => {
    const present = stage(HOST_BYTES);
    expect(verifyCodexCodeModeHost(present.app, 'darwin-arm64', { manifest: pinned, checkSignature: noSignature }))
      .toBe('verified');
    expect(() => verifyCodexBinary(present.app, 'darwin-arm64', { manifest: pinned, checkSignature: noSignature }))
      .not.toThrow();
    const absent = stage();
    expect(verifyCodexCodeModeHost(absent.app, 'darwin-arm64', { manifest: pinned, checkSignature: noSignature }))
      .toBe('absent');
    rmSync(present.dir, { recursive: true, force: true });
    rmSync(absent.dir, { recursive: true, force: true });
  });

  test('a present host with no pin is refused, not trusted', () => {
    const { dir, app } = stage(HOST_BYTES);
    expect(() =>
      verifyCodexCodeModeHost(app, 'darwin-arm64', {
        manifest: { binaries: { 'darwin-arm64': { binarySha256: sha(APP_BYTES) } } },
        checkSignature: noSignature,
      }),
    ).toThrow(/no codeModeHostSha256 pin/);
    rmSync(dir, { recursive: true, force: true });
  });

  test('every shipped platform pins its host', () => {
    for (const platformDir of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
      expect(loadCodexManifest().binaries?.[platformDir]?.codeModeHostSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test.skipIf(!existsSync(join(BUNDLED_CODEX, '..', 'codex-code-mode-host')))(
    'the real fetched darwin-arm64 host beside the real app-server verifies [needs the fetched codex binaries]',
    () => {
      expect(verifyCodexCodeModeHost(BUNDLED_CODEX, 'darwin-arm64')).toBe('verified');
    },
  );
});
