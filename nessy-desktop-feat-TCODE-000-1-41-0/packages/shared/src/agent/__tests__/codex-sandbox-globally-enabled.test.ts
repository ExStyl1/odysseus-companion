/**
 * T1 contour (e) — `CodexAgent.sandboxGloballyEnabled` must thread the SAME
 * managed floor contour (b) does (review fix, 2026-08-13, mirroring
 * `getMacosSeatbeltBashSandboxEnabled`'s fix): `resolveManagedSandboxEnabledFloor`
 * from `../config/storage.ts`, not the user layer alone.
 *
 * `sandboxGloballyEnabled` is a private method on a class that needs a mocked
 * adapter, credential manager and app-server subprocess just to construct
 * (see `codex-byo-upstream.test.ts`), and its entire body is a one-line
 * delegation to already-tested helpers (`resolveSandboxEnabled` —
 * `sandbox-settings.test.ts`; `resolveManagedSandboxEnabledFloor` —
 * `../../config/__tests__/managed-sandbox-enabled-provider.test.ts`).
 * Instantiating the class to re-prove logic it does not itself contain would
 * be a heavier duplicate of the same invariant those files already cover.
 * What only THIS file can pin is the WIRING — that the method actually calls
 * the bridge — the same seam `claude-turn-options.test.ts`'s contour (d) pin
 * ("never passes a sandbox key to the Claude SDK") uses for the identical
 * reason: a source-scan is the cheapest durable pin available.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('CodexAgent.sandboxGloballyEnabled — wired to the managed floor (T1 contour e)', () => {
  const source = readFileSync(new URL('../codex-agent.ts', import.meta.url), 'utf8');

  it('imports resolveManagedSandboxEnabledFloor from the same storage module as getUserSandboxSettings', () => {
    // The invariant is SAME MODULE, ONE STATEMENT — not the exact spelling of a
    // shared import line. Pinned as a literal until P6.704 (`026a44a42`) gave
    // the file a `resolvePlansDirectory` import and the line grew to six names,
    // which failed this case while the wiring it guards was untouched. Read as a
    // specifier list instead, so a seventh name joining cannot break it and a
    // symbol MOVING to another module still does.
    const storageImports = [...source.matchAll(/import \{([^}]*)\} from '\.\.\/config\/storage\.ts';/g)]
      .map(match => match[1]!.split(',').map(name => name.trim()));
    expect(storageImports.length).toBeGreaterThan(0);
    expect(storageImports.some(names =>
      names.includes('getUserSandboxSettings') && names.includes('resolveManagedSandboxEnabledFloor'),
    )).toBe(true);
  });

  it("passes resolveManagedSandboxEnabledFloor() as resolveSandboxEnabled's floor argument", () => {
    expect(source).toMatch(
      /private sandboxGloballyEnabled\(\): boolean \{\s*\n\s*return resolveSandboxEnabled\(\[getUserSandboxSettings\(\)\], resolveManagedSandboxEnabledFloor\(\)\);\s*\n\s*\}/,
    );
  });
});
