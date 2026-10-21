/**
 * P3.332 — a PowerShell parse REFUSAL must not read as "this command writes
 * nothing" on the denied-path floor.
 *
 * `extractPowerShellWriteTarget` returns `null` for two different things, and
 * `getDeniedPathViolation` could only see one of them: a spawn that timed out,
 * died with `EAGAIN`/`EMFILE` under a fan-out, or found no parser script
 * arrived as a command that named no path. `validatePowerShellCommand` consumes
 * the identical refusal and correctly answers `allowed: false` — so the two
 * readers of one signal disagreed, and the disagreeing one is the floor that
 * runs FIRST, ahead of the `bypassPermissions` blanket-allow.
 *
 * ## The instrument, and why it is not a crushed timeout
 *
 * The refusal is forced by pointing the validator root at a directory with no
 * parser script. That is `parseCommand`'s own
 * `PARSER_SCRIPT_MISSING_ERROR` branch, which produces the SAME
 * `{ success: false }` a timeout produces, with two advantages over crushing
 * `PARSE_SPAWN_TIMEOUT_MS`: it spawns nothing, so the verdict does not move
 * with machine load (the pwsh spawn family is registered as load-dependent),
 * and it needs no mutation of shipped source. The healthy-parser arm is not
 * asserted here for the same reason — it is exactly the arm that flakes under
 * load, and `powershell-cmdlet-gate.test.ts` already owns the parser's own
 * behaviour.
 */
import { describe, it, expect, afterAll, beforeAll } from 'bun:test';
import { shouldAllowToolInMode } from '../mode-manager.ts';
import {
  extractPowerShellWriteTarget,
  powerShellWriteTargetCandidates,
  setPowerShellValidatorRoot,
} from '../powershell-validator.ts';

/** A directory that exists nowhere, so the parser script can never be found. */
const NO_PARSER_ROOT = '/nonexistent/w5e-powershell-parser-root';

function deniedPathFired(command: string): boolean {
  const result = shouldAllowToolInMode('Bash', { command }, 'default' as never);
  const reason = String((result as { reason?: unknown }).reason ?? '');
  return !result.allowed && reason.includes('Sensitive path blocked');
}

describe('powerShellWriteTargetCandidates — spawn-free, additive', () => {
  it('names the six shapes that survived a refusal, in every quoting spelling', () => {
    const expected: Array<[string, string]> = [
      [String.raw`Out-File -FilePath C:\Users\me\.ssh\id_rsa`, String.raw`C:\Users\me\.ssh\id_rsa`],
      [String.raw`Out-File -FilePath id_rsa`, 'id_rsa'],
      [String.raw`Out-File -LiteralPath 'C:\Users\me\.ssh\id_rsa'`, String.raw`C:\Users\me\.ssh\id_rsa`],
      [String.raw`Set-Content -Path C:\Users\me\.ssh\id_rsa -Value x`, String.raw`C:\Users\me\.ssh\id_rsa`],
      [String.raw`Set-Content C:\Users\me\.ssh\id_rsa -Value x`, String.raw`C:\Users\me\.ssh\id_rsa`],
      ['Add-Content id_rsa -Value x', 'id_rsa'],
    ];
    for (const [command, target] of expected) {
      expect(powerShellWriteTargetCandidates(command)).toContain(target);
    }
  });

  it('reads through the powershell.exe -Command wrapper Codex produces on Windows', () => {
    const wrapped = 'powershell.exe -NoProfile -Command '
      + '"Set-Content -Path \\"C:\\\\Users\\\\me\\\\.ssh\\\\id_rsa\\" -Value x"';
    expect(powerShellWriteTargetCandidates(wrapped).join('|')).toContain('id_rsa');
  });

  it('costs nothing on commands that cannot name a write cmdlet', () => {
    // The `cannotNamePowerShellCmdlet` superset gate runs first, so an ordinary
    // POSIX command returns before either regex is touched.
    for (const command of ['printf ok', 'ls -la', 'git status', 'grep -r foo .', 'cat /etc/hosts']) {
      expect(powerShellWriteTargetCandidates(command)).toEqual([]);
    }
  });

  it('never offers a flag or regex debris as a path', () => {
    expect(powerShellWriteTargetCandidates('Set-Content -Value x')).toEqual([]);
    for (const candidate of powerShellWriteTargetCandidates('Out-File -Path -Encoding utf8')) {
      expect(candidate.startsWith('-')).toBe(false);
    }
  });
});

describe('the denied-path floor under a forced parser refusal', () => {
  beforeAll(() => setPowerShellValidatorRoot(NO_PARSER_ROOT));
  afterAll(() => setPowerShellValidatorRoot(undefined));

  it('confirms the refusal is a refusal — the AST reader answers null for every shape', () => {
    // The positive control for the instrument: with the parser unreachable, the
    // AST path cannot answer, which is precisely the state the floor used to
    // misread. Without this the suite could pass on a healthy parser and prove
    // nothing about the refusal.
    expect(extractPowerShellWriteTarget(String.raw`Out-File -FilePath 'C:\Users\me\.ssh\id_rsa'`)).toBeNull();
    expect(extractPowerShellWriteTarget(String.raw`Set-Content C:\Users\me\.ssh\id_rsa -Value x`)).toBeNull();
  });

  it('denies the Windows-rooted and bare-filename shapes it used to allow', () => {
    // Measured before the fix at HEAD: every one of these six returned
    // `allowed: true` while the parser refused. `deniedPaths` carries
    // `~/.ssh/**` and `**/id_rsa`; a bare name resolves under cwd and matches
    // the latter, which is the shape a Windows host's list is written in.
    const shapes = [
      String.raw`Out-File -FilePath C:\Users\me\.ssh\id_rsa`,
      String.raw`Out-File -FilePath id_rsa`,
      String.raw`Out-File -LiteralPath 'C:\Users\me\.ssh\id_rsa'`,
      String.raw`Set-Content -Path C:\Users\me\.ssh\id_rsa -Value x`,
      String.raw`Set-Content C:\Users\me\.ssh\id_rsa -Value x`,
      'Add-Content id_rsa -Value x',
    ];
    for (const command of shapes) {
      expect({ command, denied: deniedPathFired(command) }).toEqual({ command, denied: true });
    }
  });

  it('keeps the quoted shapes the spawn-free regexes already caught', () => {
    for (const command of [
      String.raw`Out-File -FilePath 'C:\Users\me\.ssh\id_rsa'`,
      String.raw`Out-File 'C:\Users\me\.ssh\id_rsa'`,
      String.raw`Set-Content -Path 'C:\Users\me\.ssh\id_rsa' -Value x`,
    ]) {
      expect({ command, denied: deniedPathFired(command) }).toEqual({ command, denied: true });
    }
  });

  it('leaves innocent commands alone — the negative controls', () => {
    // A write cmdlet aimed at an undenied path, and a command that names no
    // cmdlet at all. Without these the suite would pass on a floor that denied
    // everything.
    for (const command of [
      'printf ok',
      String.raw`Out-File -FilePath C:\Users\me\notes.txt`,
      'echo hi | Out-File out.txt',
    ]) {
      expect({ command, denied: deniedPathFired(command) }).toEqual({ command, denied: false });
    }
  });
});
