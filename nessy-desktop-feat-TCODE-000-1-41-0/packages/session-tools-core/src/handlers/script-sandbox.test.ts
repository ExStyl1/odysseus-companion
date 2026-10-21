import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { SessionToolContext } from '../context.ts';
import { credentialDenyRoots } from '../runtime/credential-deny-roots.ts';
import * as filesystemIsolation from '../runtime/filesystem-isolation.ts';
import { handleScriptSandbox } from './script-sandbox.ts';

describe('script_sandbox', () => {
  // Port of upstream v0.13.4's dev-mode pin (commit acd37737, rebranded
  // CRAFT_IS_PACKAGED → NESSY_IS_PACKAGED): pin dev-mode runtime resolution
  // for the duration of this suite. These tests assert dev behavior (PATH
  // fallback allowed); when the suite itself runs under a packaged Nessy host
  // (agent Bash sessions inherit NESSY_IS_PACKAGED=true), resolveScriptRuntime
  // would otherwise flip into packaged-mode hardening and change the outcomes.
  // The name is written delete-then-assign and restored the same way (the Bun
  // 1.3.14 process.env rule, AGENTS.md) — upstream's plain assignment adapted.
  const SAVED_IS_PACKAGED = process.env.NESSY_IS_PACKAGED;
  beforeAll(() => {
    delete process.env.NESSY_IS_PACKAGED;
    process.env.NESSY_IS_PACKAGED = 'false';
  });
  afterAll(() => {
    delete process.env.NESSY_IS_PACKAGED;
    if (SAVED_IS_PACKAGED !== undefined) process.env.NESSY_IS_PACKAGED = SAVED_IS_PACKAGED;
  });

  let rootDir: string;
  let sessionDir: string;
  let dataDir: string;
  let siblingDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'script-sandbox-'));
    sessionDir = join(rootDir, 'session');
    dataDir = join(sessionDir, 'data');
    siblingDir = join(rootDir, 'session-evil');

    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(siblingDir, { recursive: true });

    writeFileSync(join(sessionDir, 'in.txt'), 'hello sandbox');
    writeFileSync(join(siblingDir, 'outside.txt'), 'evil');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function ctx(): SessionToolContext {
    return {
      configRoot: rootDir,
      sessionId: 'sandbox-session',
      workspacePath: rootDir,
      sourcesPath: join(rootDir, 'sources'),
      skillsPath: join(rootDir, 'skills'),
      plansFolderPath: join(sessionDir, 'plans'),
      callbacks: {
        onPlanSubmitted: () => {},
        onAuthRequest: () => {},
      },
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
    };
  }

  it('rejects input path traversal/sibling-prefix bypass', async () => {
    const result = await handleScriptSandbox(ctx(), {
      language: 'node',
      script: "console.log('ok')",
      inputFiles: [join(rootDir, 'session-evil', 'outside.txt')],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('inputFile must be within the session directory');
  });

  it('enforces network/filesystem isolation or fails with clear diagnostics', async () => {
    const result = await handleScriptSandbox(ctx(), {
      language: 'node',
      script: "console.log('hello')",
      timeoutMs: 1500,
    });

    const text = result.content[0]?.text ?? '';

    if (result.isError) {
      expect(text.length > 0).toBe(true);
      expect(
        text.includes('network isolation') ||
        text.includes('filesystem isolation') ||
        text.includes('networkIsolation:') ||
        text.includes('filesystemIsolation:') ||
        text.includes('runtime') ||
        text.includes('Error running sandboxed script')
      ).toBe(true);
      return;
    }

    expect(text).toContain('networkIsolation: enforced');
    expect(text).toContain('filesystemIsolation: enforced');
    expect(text).toContain('stdout:');
  });

  it('blocks writes outside session directory when sandbox runs', async () => {
    const outsidePath = join(rootDir, 'outside-write.txt');

    const result = await handleScriptSandbox(ctx(), {
      language: 'node',
      script: `require('node:fs').writeFileSync(${JSON.stringify(outsidePath)}, 'nope'); console.log('done')`,
      timeoutMs: 1500,
    });

    const text = result.content[0]?.text ?? '';

    if (
      text.includes('filesystem isolation') ||
      text.includes('network isolation') ||
      text.includes('sandbox_apply') ||
      text.includes('Operation not permitted')
    ) {
      // Backend unavailable or host sandbox denied in this environment.
      expect(result.isError).toBe(true);
      return;
    }

    expect(result.isError).toBe(true);
    expect(existsSync(outsidePath)).toBe(false);
  });

  it('passes stdin through when sandbox backend is available', async () => {
    const result = await handleScriptSandbox(ctx(), {
      language: 'node',
      script: "process.stdin.on('data', d => process.stdout.write(String(d).toUpperCase()));",
      stdin: 'hello stdin',
      timeoutMs: 1500,
    });

    const text = result.content[0]?.text ?? '';
    if (
      result.isError &&
      (
        text.includes('filesystem isolation') ||
        text.includes('network isolation') ||
        text.includes('sandbox_apply') ||
        text.includes('Operation not permitted')
      )
    ) {
      expect(text.length > 0).toBe(true);
      return;
    }

    expect(result.isError).toBe(false);
    expect(text).toContain('HELLO STDIN');
  });

  it('seeds the shared credential deny list into every isolation call', async () => {
    // This call site was the forgotten one, so assert the ARGUMENT rather than
    // the behaviour: a behavioural read-denied assertion here passes on the old
    // code whenever the sandbox backend is unavailable, i.e. for the wrong
    // reason. Every `applyFilesystemIsolation` call on the handler's path must
    // carry the list — the darwin branch replaces the first plan, and a call
    // that forgot the option would silently win on some platform.
    const spy = spyOn(filesystemIsolation, 'applyFilesystemIsolation');
    try {
      await handleScriptSandbox(ctx(), {
        language: 'node',
        script: "console.log('ok')",
        timeoutMs: 1500,
      });

      expect(spy.mock.calls.length).toBeGreaterThan(0);
      for (const call of spy.mock.calls) {
        // The WHOLE list, from the one constant, so an entry added there cannot
        // reach the supervisor and miss this handler.
        expect(call[3]?.deniedReadRoots)
          .toEqual(credentialDenyRoots(homedir(), rootDir));
        // Spot-checked so the assertion above cannot pass against an empty list.
        expect(call[3]?.deniedReadRoots).toContain(join(rootDir, 'credentials.enc'));
        expect(call[3]?.deniedReadRoots).toContain(join(homedir(), '.ssh'));
        expect(call[3]?.deniedReadRoots).toContain(join(homedir(), '.docker'));
        expect(call[3]?.deniedReadRoots).toContain(join(homedir(), '.netrc'));
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('reports timeout when script exceeds timeoutMs', async () => {
    const result = await handleScriptSandbox(ctx(), {
      language: 'node',
      script: 'setInterval(() => {}, 100);',
      timeoutMs: 200,
    });

    const text = result.content[0]?.text ?? '';
    if (
      result.isError &&
      (
        text.includes('filesystem isolation') ||
        text.includes('network isolation') ||
        text.includes('sandbox_apply') ||
        text.includes('Operation not permitted')
      )
    ) {
      expect(text.length > 0).toBe(true);
      return;
    }

    expect(text).toContain('timedOut: true');
  });

  /**
   * T1 contour (c), 2026-08-12 — script_sandbox is the ONE deliberate exception
   * to the `sandbox.enabled` master kill switch. Category string:
   * `deviation: script-sandbox-keeps-isolation`. Reasons: its wrap covers only
   * its own inline diagnostic scripts (never user Bash, never browsers), so it
   * is not the instability source the plan exists to remove; isolation is the
   * tool's `safeMode: 'allow'` rationale — auto-allowed BECAUSE wrapped — so
   * unwrapping it silently would be a security inversion; and it already fails
   * closed where no backend exists.
   *
   * Pinned two ways: the handler does not even reference the master switch
   * (so there is no code path for it to turn this off through), and it still
   * enforces isolation exactly as every other test in this file already
   * proves.
   */
  it('keeps its own isolation unconditionally — does not reference the sandbox.enabled master switch (T1 contour c)', async () => {
    const source = readFileSync(new URL('./script-sandbox.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/sandboxEnabled|resolveSandboxEnabled|getMacosSeatbeltBashSandboxEnabled|resolveHostSandboxSettings/);

    const result = await handleScriptSandbox(ctx(), {
      language: 'node',
      script: "console.log('still-wrapped')",
      timeoutMs: 1500,
    });
    const text = result.content[0]?.text ?? '';
    if (result.isError) {
      // Backend unavailable in this environment — same tolerance as the
      // "enforces network/filesystem isolation" test above.
      expect(text.length > 0).toBe(true);
      return;
    }
    expect(text).toContain('networkIsolation: enforced');
    expect(text).toContain('filesystemIsolation: enforced');
  });
});
