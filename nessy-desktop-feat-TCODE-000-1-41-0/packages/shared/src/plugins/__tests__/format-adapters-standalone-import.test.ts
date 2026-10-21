/**
 * Every format adapter must be importable on its own, without the barrel having
 * been loaded first (P6.671).
 *
 * ## What was measured, and why a normal suite could never see it
 *
 * `format-adapters.ts` imports each adapter, and `format-adapters/codex.ts` and
 * `format-adapters/claude.ts` both import `mapExternalHookEventName` back out of
 * that barrel. Two cycles, identical in shape — and only one of them crashed:
 *
 *   ARM A   import codex.ts alone
 *           ReferenceError: Cannot access 'CODEX_MANIFEST_RELATIVE_PATH'
 *           before initialization   at format-adapters.ts
 *   ARM B   import the barrel first, then codex.ts     OK, 5 exports
 *   CONTROL import claude.ts alone                     OK, 5 exports
 *
 * The cycle is therefore NOT the defect on its own. What crashed was a
 * MODULE-INIT-TIME read: the barrel's top-level `CODEX_ADAPTER_MANIFEST_CANDIDATES`
 * array evaluated a binding that `codex.ts` had not reached yet, so entering the
 * graph through `codex.ts` hit its temporal dead zone. `claude.ts` survives the
 * same cycle because nothing at the barrel's top level reads a `claude.ts`
 * binding.
 *
 * A conventional suite is structurally blind to this. `format-adapters.test.ts`
 * is green only because it imports the barrel on the line ABOVE its `codex.ts`
 * import — one line of ordering — and two other suites carry hand-written
 * comments routing their imports around the same crash and calling it
 * "pre-existing" (`codex-contract-fields.test.ts`,
 * `codex-agent-frontmatter.test.ts`). Three files had already met this defect
 * and none of them could fail on it. That is why the case below spawns a CHILD
 * per adapter: the only instrument that can see an import-order bug is a process
 * whose first import is the one under test. In-process `await import()` would
 * inherit this file's own already-warm module graph and pass regardless.
 *
 * ## Why all three adapters, not just the one that broke
 *
 * The fix moved one constant into a leaf. It did not remove the cycle, and
 * removing the cycle is a larger change than this row is worth — so what keeps
 * the fix from silently regressing is this case covering the CLASS: the next
 * top-level read of any adapter binding from the barrel turns it red, whichever
 * adapter it lands on. Stated rather than implied, because "the cycle is gone"
 * would be a false claim about what was done here.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The adapters pull in the whole plugin schema graph, whose cold import cost was
// measured at tens of seconds on this rig (W8-x, P6.560: `user 0.08 / sys 0.05`
// against `real 23.17` for one module — I/O wait, not compute). Three children
// each pay it once.
setDefaultTimeout(180_000);

const ADAPTERS_DIR = join(import.meta.dir, '..', 'format-adapters');

/** Spawn a child whose FIRST import is the adapter, and report what it said. */
function importFirstInChild(adapterFile: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'nessy-standalone-import-'));
  try {
    // The probe lives inside the repo tree's tmpdir-adjacent scratch and imports
    // by ABSOLUTE path, so it resolves this checkout's own module — the rig-
    // provenance trap in AGENTS.md § Traps is about `node_modules` resolution,
    // and nothing here imports a package by name.
    const probe = join(dir, 'probe.ts');
    writeFileSync(
      probe,
      `import * as adapter from ${JSON.stringify(join(ADAPTERS_DIR, adapterFile))};\n`
      + 'if (Object.keys(adapter).length === 0) throw new Error("no exports");\n'
      + 'console.log("OK");\n',
    );
    const result = Bun.spawnSync(['bun', probe], {
      stdout: 'pipe',
      stderr: 'pipe',
      // The child inherits `NODE_ENV=test` from this runner but NOT the root
      // `bunfig.toml` preload that isolates the config dir, so `config/paths.ts`
      // refuses to start — correctly, and its own message names this remedy.
      // Set BEFORE bun starts, which is the only form that works
      // (AGENTS.md § Traps: the isolate preload isolates under `bun test` and
      // not under `bun <file>`).
      env: { ...process.env, NESSY_CONFIG_DIR: join(dir, 'config') },
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    return { ok: result.exitCode === 0, output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('a format adapter imported before the barrel (P6.671)', () => {
  it.each(['codex.ts', 'claude.ts', 'mcpb.ts'])('%s imports standalone', (adapterFile) => {
    const { ok, output } = importFirstInChild(adapterFile);
    // The message is asserted, not just the exit code: a child that fails for an
    // unrelated reason should not read as this defect returning — and the
    // child's own output rides on the failure so the next reader is not left
    // with a bare `expected true, received false`.
    expect(output).not.toContain('before initialization');
    expect(ok ? '' : output).toBe('');
  });

  it('the child is a real instrument, not a stub that always passes', () => {
    // Positive control for the RIG. Without it, a spawn that silently succeeded
    // on an empty file would make all three cases above vacuous — the same
    // failure mode as `bun test` given a path that does not exist.
    const { ok, output } = importFirstInChild('definitely-not-an-adapter.ts');
    expect(ok).toBe(false);
    expect(output.length).toBeGreaterThan(0);
  });
});
