/**
 * Task 7.5 — sandbox / security regression (config-enforcement invariants).
 *
 * Codex's Rust sandbox enforces the `config.toml` `sandbox_mode`/`approval_policy`
 * we write; Nessy's PolicyEngine is the gate on top. These deterministic
 * assertions prove the mapping NEVER grants unsafe access — the security path
 * that gates the OS-level behavior. The live OS-sandbox behavior (a command that
 * tries to escape) is exercised by the agentic eval (`evals/run.mjs`,
 * unauthorizedWrites=0) and is DEFER-TO-REVIEW for a dedicated live
 * malicious-write test (needs the model to cooperate + seatbelt observation).
 *
 * SECURITY PATH — do not simplify away these assertions.
 *
 * One qualification, added in review of T1 (2026-08-12, "sandbox.enabled kill
 * switch"): with the master switch OFF, `codexSandboxConfigForMode` DOES map
 * every mode to `danger-full-access` — a deliberate T1 exception to this
 * file's "NO Nessy mode ever maps to danger-full-access" absolute, gated by
 * that function's `sandboxGloballyEnabled` parameter (default `true`, so every
 * assertion below is unaffected — none of them pass a second argument). See
 * sibling file `config-writer.test.ts`'s
 * "codexSandboxConfigForMode — the T1 sandboxGloballyEnabled master switch"
 * suite for that path's own coverage.
 *
 * A second qualification, from R13 (2026-08-16): `MODES` here omits `dontAsk`,
 * so "every mode keeps approval on-request" has always been a statement about
 * the four listed modes at switch-ON. `dontAsk` is `never` at switch-ON (bounded
 * by `read-only`, which is what makes that safe) and, at switch-OFF, whatever
 * `degradeUnboundedApprovalPolicy` yields — `untrusted` until `rust-v0.150.1`
 * retired it, `on-request` since (P7.2).
 * The absolute that DOES hold in both positions, and that R13 added, is that no
 * mode is left with neither a sandbox nor an approval channel; it is asserted in
 * the sibling suite named above and in `permission-mode-runtime-translations.test.ts`.
 */
import { test, expect, describe } from 'bun:test';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexSandboxConfigForMode, buildCodexConfigToml, validateConfigAgainstSchema, type CodexPermissionMode } from '../config-writer.ts';

const SCHEMA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'codex-protocol', 'schema', 'config-schema.json');
const MODES: CodexPermissionMode[] = ['plan', 'default', 'auto', 'bypassPermissions'];

describe('sandbox config enforcement invariants', () => {
  test('NO Nessy mode ever maps to danger-full-access', () => {
    for (const mode of MODES) {
      expect(codexSandboxConfigForMode(mode).sandbox_mode).not.toBe('danger-full-access');
    }
  });

  test('plan is read-only (no writes at all)', () => {
    expect(codexSandboxConfigForMode('plan').sandbox_mode).toBe('read-only');
  });

  test('default + bypassPermissions are workspace-write (writes confined to the workspace) — never broader', () => {
    expect(codexSandboxConfigForMode('default').sandbox_mode).toBe('workspace-write');
    expect(codexSandboxConfigForMode('bypassPermissions').sandbox_mode).toBe('workspace-write');
  });

  test('every mode keeps approval on-request (Nessy PolicyEngine stays the gate)', () => {
    for (const mode of MODES) {
      expect(codexSandboxConfigForMode(mode).approval_policy).toBe('on-request');
    }
  });

  test('the written config.toml carries the enforcing sandbox_mode + validates against the schema', () => {
    for (const mode of MODES) {
      const opts = {
        codexHome: '/tmp/x',
        model: 'm',
        adapterPort: 1,
        mode,
        deniedReadPaths: ['/private/nessy/credentials.enc'],
      };
      const toml = buildCodexConfigToml(opts);
      expect(toml).toContain(`sandbox_mode = "${codexSandboxConfigForMode(mode).sandbox_mode}"`);
      expect(toml).not.toContain('danger-full-access');
      expect(toml).toContain('"/private/nessy/credentials.enc" = "deny"');
      expect(() => validateConfigAgainstSchema(opts, SCHEMA)).not.toThrow();
    }
  });
});
