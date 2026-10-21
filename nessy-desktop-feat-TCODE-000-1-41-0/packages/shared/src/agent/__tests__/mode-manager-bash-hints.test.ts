import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  getBashRejectionReason,
  formatBashRejectionMessage,
  shouldAllowToolInMode,
  type ModeConfig,
} from '../../agent/mode-manager.ts';
import { PERMISSION_MODE_AGENT_LABELS } from '../../agent/mode-types.ts';

// P2.254: `shouldAllowToolInMode('Bash', …)` reaches `getDeniedPathViolation` ->
// `extractPowerShellWriteTarget`, which spawns `powershell-parser.ps1` on any
// host with a real PowerShell (P2.241 owns the ungated spawn itself). One spawn
// is 0.69-0.88s idle, so bun's 5s default sits BELOW this file's resting cost
// and manufactures its own failures — measured here as a 5.7s "timed out after
// 5000ms" on a case that asserts instantly. Until this defect was fixed the
// spawn never happened (the validator THREW instead), which is why the ceiling
// was never needed before. Same value and reason as
// `packages/shared/tests/mode-manager.test.ts`.
setDefaultTimeout(30_000);

function buildConfig(overrides?: Partial<ModeConfig>): ModeConfig {
  return {
    blockedTools: new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']),
    readOnlyBashPatterns: [
      {
        regex: /^printenv\b/,
        source: '^printenv\\b',
        comment: 'Print environment variables',
      },
      {
        regex: /^sed\s+-n\b/,
        source: '^sed\\s+-n\\b',
        comment: 'sed in print-only mode (no editing)',
      },
    ],
    blockedCommandHints: [
      {
        command: 'printf',
        reason: 'printf is not in the default read-only allowlist of Plan and Don\'t ask modes.',
        context: 'Plan and Don\'t ask modes intentionally keep a narrow command surface.',
        tryInstead: [
          'Use `echo` for simple separators and labels.',
        ],
        example: "echo '--- files ---'",
      },
      {
        command: 'sed',
        reason: 'Only print-only sed is in the default read-only allowlist of Plan and Don\'t ask modes.',
        whenNotMatching: '^sed\\s+-n\\b',
        whenNotMatchingRegex: /^sed\s+-n\b/,
      },
    ],
    readOnlyMcpPatterns: [],
    allowedApiEndpoints: [],
    displayName: 'Plan',
    shortcutHint: 'SHIFT+TAB',
    ...overrides,
  };
}

describe('mode-manager blocked command hints', () => {
  it('adds deterministic command-specific guidance for blocked printf', () => {
    const config = buildConfig();

    const rejection = getBashRejectionReason('printf "\\n--- files ---\\n"', config);
    expect(rejection).not.toBeNull();
    expect(rejection?.type).toBe('no_safe_pattern');

    const formatted = formatBashRejectionMessage(rejection!, config, 'plan');

    expect(formatted).toContain('Why: printf is not in the default read-only allowlist of Plan and Don\'t ask modes.');
    expect(formatted).toContain('Context: Plan and Don\'t ask modes intentionally keep a narrow command surface.');
    expect(formatted).toContain('Try instead:');
    expect(formatted).toContain('Example: `echo \'--- files ---\'`');

    // If fuzzy diagnostics are shown, they must be labeled as heuristic
    expect(formatted).not.toContain('Pattern: Print environment variables');
    expect(formatted).toContain('Closest allowlist hint (heuristic): Print environment variables');
  });

  it('applies sed hint when command is not in print-only mode', () => {
    const config = buildConfig();

    const rejection = getBashRejectionReason('sed s#^#/## file.txt', config);
    expect(rejection).not.toBeNull();
    expect(rejection?.type).toBe('no_safe_pattern');

    const formatted = formatBashRejectionMessage(rejection!, config, 'plan');
    expect(formatted).toContain('Why: Only print-only sed is in the default read-only allowlist of Plan and Don\'t ask modes.');
  });

  it('does not reject sed -n read-only command', () => {
    const config = buildConfig();

    const rejection = getBashRejectionReason("sed -n '1,5p' file.txt", config);
    expect(rejection).toBeNull();
  });
});

describe('mode-switch hints speak the current vocabulary', () => {
  // The mode names in every agent-facing hint come from
  // PERMISSION_MODE_AGENT_LABELS (pinned byte-equal to the en locale by
  // mode-label-source.test.ts) — never an inline literal. Re-inlining an old
  // word ("Ask mode", "Execute mode", "Allow All") goes red here.
  const OLD_VOCABULARY = /Ask mode|Execute mode|Allow All|switch to Ask|Ask\/Execute/;

  it('the bash rejection mode-switch hint names the pinned labels', () => {
    const config = buildConfig();
    const formatted = formatBashRejectionMessage(
      { type: 'control_char', char: '\\n', charCode: 10, explanation: 'newline acts as command separator in bash' },
      config,
      'plan',
    );

    // F1.1050: this arm drove the retired explore, whose escape was "Switch to Manual or Bypass permissions";
    // plan's own escape names the plan label.
    expect(formatted).toContain(
      `ask them to leave ${PERMISSION_MODE_AGENT_LABELS.plan} mode (SHIFT+TAB) to run it.`,
    );
    expect(formatted).not.toMatch(OLD_VOCABULARY);
  });

  it('the dangerous-operator hint is the shared escape, not one of its own', () => {
    // P2.38: this sentence used to end "Run commands separately or switch to
    // Manual mode." — the only escape in the family that named ONE mode, and it
    // was handed to `plan` and `dontAsk` alike. It now ends in the shared,
    // mode-resolved hint like every sibling.
    const config = buildConfig();
    const formatted = formatBashRejectionMessage(
      { type: 'dangerous_operator', operator: '&&', operatorType: 'chain', explanation: 'allows chaining commands' },
      config,
      'plan',
    );

    expect(formatted).toContain(
      `ask them to leave ${PERMISSION_MODE_AGENT_LABELS.plan} mode (SHIFT+TAB) to run it.`,
    );
    expect(formatted).not.toContain(`switch to ${PERMISSION_MODE_AGENT_LABELS.default} mode.`);
    expect(formatted).not.toMatch(OLD_VOCABULARY);
  });

  it('keeps "Run commands separately" for a chain and drops it for a redirect', () => {
    // A redirect has no second command to separate; the advice was noise there.
    const config = buildConfig();
    const chain = formatBashRejectionMessage(
      { type: 'dangerous_operator', operator: '&&', operatorType: 'chain', explanation: 'allows chaining commands' },
      config,
      'plan',
    );
    const redirect = formatBashRejectionMessage(
      { type: 'dangerous_operator', operator: '>', operatorType: 'redirect', explanation: 'redirects output to a file' },
      config,
      'plan',
    );

    expect(chain).toContain('Run commands separately.');
    expect(redirect).not.toContain('Run commands separately');
  });

  it('the flags-before-subcommand suggestion carries no escape of its own', () => {
    // P2.38: this suggestion is EMBEDDED in the no_safe_pattern message, which
    // already ends with one mode-resolved escape. It used to append "or switch
    // to Manual/Bypass permissions mode", so one `plan` refusal of `git -v`
    // carried that AND "Call SubmitPlan…". `generateMismatchSuggestion` has no
    // mode, so the clause is gone rather than threaded.
    const config = buildConfig({
      readOnlyBashPatterns: [
        {
          regex: /^git\s+(status|log)\b/,
          source: '^git\\s+(status|log)\\b',
          comment: 'Git read-only operations',
        },
      ],
      blockedCommandHints: [],
    });

    const rejection = getBashRejectionReason('git -v', config);
    expect(rejection?.type).toBe('no_safe_pattern');

    const formatted = formatBashRejectionMessage(rejection!, config, 'plan');
    expect(formatted).toContain('Run from the target directory.');
    expect(formatted).not.toContain(
      `switch to ${PERMISSION_MODE_AGENT_LABELS.default}/${PERMISSION_MODE_AGENT_LABELS.bypassPermissions} mode.`,
    );
    // The one escape it does carry is plan's, at the end.
    expect(formatted).toContain('Call SubmitPlan');
    expect(formatted).not.toMatch(OLD_VOCABULARY);
  });

  it('plan-mode block reasons carry the pinned labels (F1.1050: this arm drove the retired explore)', () => {
    const expectedHint = `ask them to leave ${PERMISSION_MODE_AGENT_LABELS.plan} mode (`;
    const cases: Array<{ tool: string; input: unknown }> = [
      { tool: 'Bash', input: {} }, // missing command
      { tool: 'Write', input: {} }, // blocked tool, no target path
      { tool: 'mcp__github__create_issue', input: {} }, // MCP write
    ];

    for (const { tool, input } of cases) {
      const result = shouldAllowToolInMode(tool, input, 'plan');
      if (result.allowed) throw new Error(`${tool} unexpectedly allowed in plan mode`);
      expect(result.reason, tool).toContain(expectedHint);
      expect(result.reason, tool).not.toMatch(OLD_VOCABULARY);
    }
  });

  // F1.1050 (DN-272) deleted "the explore-mode write-target hint suggests the pinned Manual and Auto labels": that
  // detailed write-target refusal existed only in the retired explore.
});

// F1.1170 — the SHIPPED hints (`apps/electron/resources/permissions/default.json`) are text the model reads when
// a command is outside the read-only allowlist: a refusal in Don't ask, and in Plan the description the classifier
// or the user's card shows. The two are the only modes that check a command against that list (bypass and the
// interactive write modes are admitted before it). Until this row the hints named the retired Explore mode and
// told the reader to "Switch to Ask mode" — a mode that no longer exists, and a second way out beside the
// mode's own escape the message already ends with (P2.38: one escape per refusal).
const SHIPPED_PERMISSIONS_TEXT = readFileSync(
  join(import.meta.dir, '..', '..', '..', '..', '..', 'apps', 'electron', 'resources', 'permissions', 'default.json'),
  'utf-8',
);
interface ShippedHint { command: string; reason: string; context?: string; whenNotMatching?: string; tryInstead?: string[]; example?: string }
const SHIPPED_PERMISSIONS = JSON.parse(SHIPPED_PERMISSIONS_TEXT) as { version: string; blockedCommandHints: ShippedHint[] };
const RETIRED_MODE_WORDS = /\bExplore\b|Ask mode|Execute mode|Allow All/;
const hintTexts = (hint: ShippedHint): string[] =>
  [hint.reason, hint.context, ...(hint.tryInstead ?? []), hint.example].filter((text): text is string => typeof text === 'string');

describe('F1.1170 · the shipped command hints name the modes they apply to', () => {
  it('no shipped hint names a retired mode', () => {
    const offenders = SHIPPED_PERMISSIONS.blockedCommandHints.flatMap(hint =>
      hintTexts(hint).filter(text => RETIRED_MODE_WORDS.test(text)).map(text => `${hint.command}: ${text}`));
    expect(offenders).toEqual([]);
  });

  it('the shipped printf hint names Plan and Don\'t ask, and the only way out is the mode\'s own', () => {
    const config = buildConfig({
      blockedCommandHints: SHIPPED_PERMISSIONS.blockedCommandHints.map(hint => ({
        ...hint,
        whenNotMatchingRegex: hint.whenNotMatching ? new RegExp(hint.whenNotMatching) : undefined,
      })),
    });
    const rejection = getBashRejectionReason('printf "x"', config);
    expect(rejection?.type).toBe('no_safe_pattern');
    for (const mode of ['plan', 'dontAsk'] as const) {
      const formatted = formatBashRejectionMessage(rejection!, config, mode);
      expect(formatted, mode).toContain(
        `Why: printf is not in the default read-only allowlist, the commands ${PERMISSION_MODE_AGENT_LABELS.plan} and ${PERMISSION_MODE_AGENT_LABELS.dontAsk} modes run without approval.`,
      );
      expect(formatted, mode).not.toMatch(/Switch to/);
      expect(formatted, mode).not.toMatch(RETIRED_MODE_WORDS);
    }
  });
});

// F1.1170 — the install update (`ensureDefaultPermissions`, permissions-config.ts) merges a newer bundle by
// APPENDING hints whose `command::whenNotMatching::reason` key the installed copy lacks, and the model reads the
// FIRST hint for a command — so without a retirement an existing install kept the seed's Explore text forever.
// The four seed hints below are history (identical in every bundle from the seed through `2026-09-23.4`); this
// copy is the independent one `RETIRED_SHIPPED_PATTERNS`' `blockedCommandHints` entry is checked against.
const SEED_REWORDED_HINTS: ShippedHint[] = [
  {
    command: 'printf',
    reason: 'printf is not in the default Explore-mode read-only allowlist.',
    context: 'Explore mode keeps a narrow command surface so harmless-looking shell forms do not accidentally expand capability.',
    tryInstead: [
      'Use `echo` for simple separators and labels.',
      'Switch to Ask mode for this command.',
      'Allowlist printf in permissions.json if your workspace wants it in Explore mode.',
    ],
    example: "echo '--- files ---'",
  },
  {
    command: 'sed',
    reason: 'Only print-only sed is allowed in Explore mode by default.',
    context: 'Default safe pattern is `^sed\\s+-n\\b` (inspection, not in-place transformation).',
    whenNotMatching: '^sed\\s+-n\\b',
    tryInstead: ['Use `sed -n ...` for read-only inspection.', 'Switch to Ask mode for transform commands.'],
    example: "sed -n '1,80p' file.txt",
  },
  {
    command: 'awk',
    reason: 'awk is blocked when the command appears to execute external commands.',
    context: 'Forms like `system(...)`, command-pipe `getline`, or `print | "cmd"` can run arbitrary processes.',
    tryInstead: ['Use awk without execution primitives for read-only text extraction.', 'Switch to Ask mode for advanced scripts.'],
  },
  {
    command: 'xargs',
    reason: 'xargs is not allowlisted in Explore mode because it can execute arbitrary commands from input.',
    tryInstead: ['Use dedicated read-only commands directly.', 'Switch to Ask mode when command execution from piped input is necessary.'],
  },
];
const USER_HINT: ShippedHint = { command: 'mytool', reason: 'mine: mytool writes a cache, so it stays off the allowlist.' };
const PERMISSIONS_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'permissions-config.ts')).href;
/** A child importing the permissions module graph — the migration suites' measured floor. */
const SUBPROCESS_MIGRATION_TIMEOUT_MS = 120_000;

function migrateHintsInChild(installed: unknown): { hints: ShippedHint[]; stderr: string } {
  const tempRoot = mkdtempSync(join(tmpdir(), 'nessy-f11170-bundle-'));
  const tempConfig = mkdtempSync(join(tmpdir(), 'nessy-f11170-config-'));
  try {
    mkdirSync(join(tempRoot, 'resources', 'permissions'), { recursive: true });
    writeFileSync(join(tempRoot, 'resources', 'permissions', 'default.json'), SHIPPED_PERMISSIONS_TEXT, 'utf-8');
    mkdirSync(join(tempConfig, 'permissions'), { recursive: true });
    writeFileSync(join(tempConfig, 'permissions', 'default.json'), JSON.stringify(installed, null, 2), 'utf-8');
    const run = Bun.spawnSync([
      process.execPath,
      '--eval',
      `import { ensureDefaultPermissions } from '${PERMISSIONS_MODULE_PATH}'; ensureDefaultPermissions();`,
    ], {
      cwd: tempRoot,
      env: { ...process.env, NESSY_CONFIG_DIR: tempConfig, NESSY_DEBUG: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = run.stderr.toString();
    if (run.exitCode !== 0) throw new Error(`subprocess failed (exit ${run.exitCode}):\n${stderr}`);
    const merged = JSON.parse(readFileSync(join(tempConfig, 'permissions', 'default.json'), 'utf-8')) as { blockedCommandHints: ShippedHint[] };
    return { hints: merged.blockedCommandHints, stderr };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempConfig, { recursive: true, force: true });
  }
}

describe('F1.1170 · an installed default.json gets the reworded hints on the next launch', () => {
  it('an install carrying the seed hints reads the bundle\'s text first, and keeps the user\'s own hint', () => {
    const reworded = new Set(SEED_REWORDED_HINTS.map(hint => hint.command));
    const installed = {
      ...(JSON.parse(SHIPPED_PERMISSIONS_TEXT) as Record<string, unknown>),
      version: '2026-09-23.4',
      blockedCommandHints: [
        ...SEED_REWORDED_HINTS,
        ...SHIPPED_PERMISSIONS.blockedCommandHints.filter(hint => !reworded.has(hint.command)),
        USER_HINT,
      ],
    };
    const { hints, stderr } = migrateHintsInChild(installed);

    expect(hints.flatMap(hint => hintTexts(hint).filter(text => RETIRED_MODE_WORDS.test(text)))).toEqual([]);
    // The model reads the FIRST hint for a command (`findBlockedCommandHint`), so the first one must be the bundle's.
    for (const shipped of SHIPPED_PERMISSIONS.blockedCommandHints) {
      expect(hints.find(hint => hint.command === shipped.command), shipped.command).toEqual(shipped);
    }
    expect(hints).toContainEqual(USER_HINT);
    const lines = stderr.split('\n').filter(line => line.includes('[Permissions] Retired the shipped command hint'));
    expect(lines).toHaveLength(SEED_REWORDED_HINTS.length);
  }, SUBPROCESS_MIGRATION_TIMEOUT_MS);
});
