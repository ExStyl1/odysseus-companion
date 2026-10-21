/**
 * P2.254 — the PowerShell validator must not throw out of a permission check,
 * and must not answer "allowed" when it cannot find its parser script.
 *
 * The defect: `parseCommand` resolved the parser script OUTSIDE its own `try`,
 * through a function that THREW when `setPowerShellValidatorRoot()` had never
 * been called — and the only production caller of that setter is the Electron
 * main process. `getDeniedPathViolation` reaches `extractPowerShellWriteTarget`
 * on EVERY Bash permission check, so on a `nessy-server` or `apps/cli` host with
 * `pwsh`/`powershell.exe` on PATH (on Windows: all of them) the FIRST Bash
 * permission check threw an uncaught error.
 *
 * These cases deliberately do NOT rely on any other test file having registered
 * a root. Before this fix, `packages/shared/tests/mode-manager.test.ts` called
 * the setter at module scope and rescued its neighbours whenever bun happened to
 * schedule them into the same process — so a green run was an artifact of which
 * files ran together. Each case here sets the module state it depends on and
 * restores it, so the outcome is the same alone or co-scheduled.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  extractPowerShellWriteTarget,
  getPowerShellValidatorRoot,
  isPowerShellAvailable,
  setPowerShellValidatorRoot,
  validatePowerShellCommand,
} from '../powershell-validator.ts';
import { shouldAllowToolInMode } from '../mode-manager.ts';

// One parser spawn costs ~0.7-0.9s idle on a host with a real pwsh, and the
// production `spawnSync` ceiling is 10s. bun's 5s default sits between the two,
// i.e. BELOW this file's resting cost under load, which manufactures its own
// failures (AGENTS.md, "a narrowing test knob set below the system's RESTING
// state"). Same value `packages/shared/tests/mode-manager.test.ts` uses.
setDefaultTimeout(30_000);

/** The parser script sits next to `powershell-validator.ts` in the source tree. */
const PS_AVAILABLE = isPowerShellAvailable();

let savedRoot: string | undefined;
let warnings: string[];
const realWarn = console.warn;

beforeEach(() => {
  savedRoot = getPowerShellValidatorRoot();
  warnings = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
});

afterEach(() => {
  console.warn = realWarn;
  setPowerShellValidatorRoot(savedRoot);
});

describe('PowerShell parser script resolution', () => {
  it('a host that never registered a root still gets a decision, not a throw', () => {
    setPowerShellValidatorRoot(undefined);

    // This is the product path: the first Bash permission check on a
    // non-Electron host. `npm install` has no bash write target, so
    // `getDeniedPathViolation` falls through to the PowerShell extractor.
    expect(() =>
      shouldAllowToolInMode('Bash', { command: 'npm install' }, 'plan')
    ).not.toThrow();
    expect(shouldAllowToolInMode('Bash', { command: 'npm install' }, 'plan').allowed).toBe(false);
  });

  it('with no root registered it falls back to the script beside this module', () => {
    setPowerShellValidatorRoot(undefined);

    const target = extractPowerShellWriteTarget(
      `'x' | Out-File -FilePath 'C:\\Users\\test\\plans\\plan.md'`
    );

    if (PS_AVAILABLE) {
      // Can only be non-null if the parser script was located AND spawned — the
      // positive control that the module-adjacent default is a REAL default and
      // not merely a silenced throw.
      expect(target).toBe('C:\\Users\\test\\plans\\plan.md');
      expect(warnings).toEqual([]);
    } else {
      // Documented behaviour without an interpreter: the extractor short-circuits
      // before any script is needed, so there is nothing to warn about either.
      expect(target).toBeNull();
      expect(warnings).toEqual([]);
    }
  });

  it('a registered root without the script REFUSES rather than allowing', () => {
    if (!PS_AVAILABLE) {
      // Without an interpreter `validatePowerShellCommand` refuses one step
      // earlier, with `powershell_unavailable` — still a refusal, but it would
      // not be evidence about the script-missing branch.
      expect(validatePowerShellCommand('Get-Process', []).allowed).toBe(false);
      return;
    }

    const emptyRoot = mkdtempSync(join(tmpdir(), 'p2254-no-parser-'));
    try {
      setPowerShellValidatorRoot(emptyRoot);

      // `Get-Process` is the command the suite elsewhere expects to be ALLOWED
      // once it can be parsed. With the script missing it must not be.
      const result = validatePowerShellCommand('Get-Process', [
        { regex: /^Get-Process\b/, source: '^Get-Process\\b', comment: 'read-only' },
      ]);

      expect(result.allowed).toBe(false);
      expect(result.reason?.type).toBe('parse_error');
      expect(
        result.reason && 'error' in result.reason ? result.reason.error : ''
      ).toContain('powershell-parser.ps1');

      // An explicit root is a claim about where the app staged the script, so a
      // miss there is a packaging break and is never papered over by reaching
      // for the module-adjacent copy.
      expect(warnings.join('\n')).toContain(emptyRoot);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it('a registered root without the script does not throw out of a Bash check', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'p2254-no-parser-'));
    try {
      setPowerShellValidatorRoot(emptyRoot);
      expect(() =>
        shouldAllowToolInMode('Bash', { command: 'npm install' }, 'plan')
      ).not.toThrow();
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});
