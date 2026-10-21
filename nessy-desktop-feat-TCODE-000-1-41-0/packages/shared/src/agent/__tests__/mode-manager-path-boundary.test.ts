import { describe, it, expect, beforeEach, afterEach, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shouldAllowToolInMode, extractBashWriteTarget } from '../../agent/mode-manager.ts';

// P2.254: every `shouldAllowToolInMode('Bash', …)` here reaches
// `getDeniedPathViolation` -> `extractPowerShellWriteTarget`, which spawns
// `powershell-parser.ps1` on any host with a real PowerShell (P2.241 owns the
// ungated spawn itself). One spawn is 0.69-0.88s idle, so bun's 5s default sits
// BELOW this file's resting cost and manufactures its own failures — measured
// here as 5.0-5.7s "timed out after 5000ms" on cases that assert instantly.
// Until this defect was fixed the spawn never happened (the validator THREW
// instead), which is why the ceiling was never needed before. Same value and
// same reason as `packages/shared/tests/mode-manager.test.ts`.
setDefaultTimeout(30_000);

describe('mode-manager path containment for plans/data exceptions', () => {
  let base: string;
  let plansDir: string;
  let dataDir: string;
  let additionalDir: string;
  let siblingPlans: string;
  let siblingData: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'nessy-mode-boundary-test-'));
    plansDir = join(base, 'plans');
    dataDir = join(base, 'data');
    additionalDir = join(base, 'external-artifacts');
    siblingPlans = join(base, 'plans-evil', 'pwn.md');
    siblingData = join(base, 'data-bypass', 'out.json');

    mkdirSync(plansDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(additionalDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('allows Write inside plans folder', () => {
    const result = shouldAllowToolInMode(
      'Write',
      { file_path: join(plansDir, 'ok.md') },
      'plan',
      { plansFolderPath: plansDir, dataFolderPath: dataDir }
    );
    expect(result.allowed).toBe(true);
  });

  it('blocks Write to sibling path with plans prefix', () => {
    const result = shouldAllowToolInMode(
      'Write',
      { file_path: siblingPlans },
      'plan',
      { plansFolderPath: plansDir, dataFolderPath: dataDir }
    );
    expect(result.allowed).toBe(false);
  });

  it('blocks Bash redirect to sibling path with data prefix', () => {
    const result = shouldAllowToolInMode(
      'Bash',
      { command: `echo "x" > "${siblingData}"` },
      'plan',
      { plansFolderPath: plansDir, dataFolderPath: dataDir }
    );
    expect(result.allowed).toBe(false);
  });

  // F1.1050 (DN-272): three explore-only arms were deleted with the retired mode — a Bash redirect into the data
  // folder, and a Write and a Bash redirect into additionalDirectories. Plan absorbs explore's data-folder WRITE
  // (the four file tools), not its shell-redirect or additional-directory exceptions; the arms below pin that.
  it('F1.1050: plan allows Write inside the data folder', () => {
    const result = shouldAllowToolInMode(
      'Write',
      { file_path: join(dataDir, 'ok.json') },
      'plan',
      { plansFolderPath: plansDir, dataFolderPath: dataDir }
    );
    expect(result.allowed).toBe(true);
  });

  it('F1.1050: plan blocks Write to a sibling path with the data prefix, and via a symlink escape from it', () => {
    expect(shouldAllowToolInMode(
      'Write',
      { file_path: siblingData },
      'plan',
      { plansFolderPath: plansDir, dataFolderPath: dataDir }
    ).allowed).toBe(false);
    if (process.platform === 'win32') return;
    const outsideDir = join(base, 'outside-data');
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, join(dataDir, 'escape-write'), 'dir');
    expect(shouldAllowToolInMode(
      'Write',
      { file_path: join(dataDir, 'escape-write', 'evil.json') },
      'plan',
      { plansFolderPath: plansDir, dataFolderPath: dataDir }
    ).allowed).toBe(false);
  });

  it('F1.1050: plan does not inherit the redirect or additional-directory exceptions', () => {
    expect(shouldAllowToolInMode(
      'Bash',
      { command: `echo "x" > "${join(dataDir, 'ok.json')}"` },
      'plan',
      { plansFolderPath: plansDir, dataFolderPath: dataDir }
    ).allowed).toBe(false);
    expect(shouldAllowToolInMode(
      'Write',
      { file_path: join(additionalDir, 'report.md') },
      'plan',
      { plansFolderPath: plansDir, dataFolderPath: dataDir, additionalDirectories: [additionalDir] }
    ).allowed).toBe(false);
  });

  it('blocks Write outside additionalDirectories', () => {
    const result = shouldAllowToolInMode(
      'Write',
      { file_path: join(base, 'outside', 'report.md') },
      'plan',
      {
        plansFolderPath: plansDir,
        dataFolderPath: dataDir,
        additionalDirectories: [additionalDir],
      }
    );
    expect(result.allowed).toBe(false);
  });

  it('keeps deniedPaths above additionalDirectories', () => {
    const result = shouldAllowToolInMode(
      'Write',
      { file_path: join(additionalDir, '.env') },
      'plan',
      {
        plansFolderPath: plansDir,
        dataFolderPath: dataDir,
        additionalDirectories: [additionalDir],
      }
    );

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.denyPathBlocked).toBe(true);
      expect(result.reason).toContain('Sensitive path blocked');
    }
  });

  it('blocks Write via symlink escape from plans folder', () => {
    if (process.platform === 'win32') return;

    const outsideDir = join(base, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, join(plansDir, 'escape-link'), 'dir');

    const result = shouldAllowToolInMode(
      'Write',
      { file_path: join(plansDir, 'escape-link', 'evil.md') },
      'plan',
      { plansFolderPath: plansDir, dataFolderPath: dataDir }
    );
    expect(result.allowed).toBe(false);
  });

  it('blocks Bash redirect via symlink escape from data folder', () => {
    if (process.platform === 'win32') return;

    const outsideDir = join(base, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, join(dataDir, 'escape-link'), 'dir');

    const result = shouldAllowToolInMode(
      'Bash',
      { command: `echo "x" > "${join(dataDir, 'escape-link', 'evil.json')}"` },
      'plan',
      { plansFolderPath: plansDir, dataFolderPath: dataDir }
    );
    expect(result.allowed).toBe(false);
  });

  it('does not treat JavaScript arrow syntax (=>) as a bash write redirect target', () => {
    const command = "node -e \"const f = (s) => s.includes('electron'); console.log(f('typecheck'))\"";
    expect(extractBashWriteTarget(command)).toBeNull();
  });

  it('keeps allowlist mismatch messaging for node -e arrow command (no write-path error)', () => {
    const command = "node -e \"const f = (s) => s.includes('electron'); console.log(f('typecheck'))\"";
    const result = shouldAllowToolInMode(
      'Bash',
      { command },
      'plan',
      { plansFolderPath: plansDir, dataFolderPath: dataDir }
    );

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('read-only allowlist');
      expect(result.reason).not.toContain('target not in allowed folders');
    }
  });
});
