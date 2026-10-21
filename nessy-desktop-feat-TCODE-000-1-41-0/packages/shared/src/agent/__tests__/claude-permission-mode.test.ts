/**
 * R3 — dropping `bypassPermissions`, and the mode table that has to exist first.
 *
 * ## What was measured before the change, 2026-08-16
 *
 * Unbounded `grep -a` over `packages` and `apps` (node_modules, dist and release
 * excluded, tests filtered out afterwards):
 *
 * - `permissionMode: '` in the Claude backend had exactly ONE non-comment hit,
 *   `claude-agent.ts:1995`, and its value was the literal `'bypassPermissions'`,
 *   with `allowDangerouslySkipPermissions: true` on the next line. Every
 *   session, in every one of our seven modes, told the SDK to skip everything.
 * - `toClaudeSdkPermissionMode` / `SdkPermissionMode` / `claudeSdkPermissionMode`
 *   had ZERO hits anywhere in the product: no translation from our vocabulary to
 *   theirs existed, which is why R3 could not land without building one.
 *
 * `claude-runtime-agents.ts` filters an imported AGENT's `permissionMode`
 * against the SDK's six-member set, but that is a per-agent passthrough, not a
 * session translation, and it never saw the user's mode.
 *
 * ## What this suite can and cannot prove
 *
 * The SDK's interpretation of `permissionMode` runs inside the native `claude`
 * binary, so no unit test here can execute it. What is proven: the option we
 * hand over is the one the documented mode table says it should be, the table
 * cannot silently widen, our gate's no-write floor is unchanged by the mapping,
 * and a read-only bash command still reaches the runtime carrying the decision
 * that "skips the permission prompt". The behavioural half — no card in front of
 * a real `git status`, a card in front of a real `git push` under an ask rule —
 * belongs to a live case.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { PermissionMode as ClaudeSdkPermissionMode } from '@anthropic-ai/claude-agent-sdk';
import {
  CLAUDE_SDK_PERMISSION_MODE_ORDER,
  CLAUDE_SDK_PERMISSION_MODE_TABLE,
  buildClaudePermissionModeOptions,
  toClaudeSdkPermissionMode,
} from '../claude-permission-mode.ts';
import { buildClaudePreToolUseContinue, buildClaudeTurnShapeOptions } from '../claude-agent.ts';
import { PERMISSION_MODE_ORDER, type PermissionMode } from '../mode-types.ts';
import { cleanupModeState, initializeModeState } from '../mode-manager.ts';
import { runPreToolUseChecks, type PermissionManagerLike } from '../core/pre-tool-use.ts';
import { parsePermissionsJson, permissionsConfigCache } from '../permissions-config.ts';
import { evaluatePermissionDslV1 } from '../pi-harness/permission-dsl.ts';

const claudeAgentSource = () =>
  readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');

/** The `PermissionMode` members, read from the installed SDK typings. */
function readSdkPermissionModes(): string[] {
  const sdkEntry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
  const source = readFileSync(`${sdkEntry.slice(0, sdkEntry.lastIndexOf('/'))}/sdk.d.ts`, 'utf8');
  const match = source.match(/^export declare type PermissionMode = (.+?);$/m);
  if (!match) throw new Error('Could not find PermissionMode in the installed sdk.d.ts');
  return match[1]!.split('|').map(value => value.trim().replace(/^'|'$/g, ''));
}

// ===========================================================================

describe('R3 — the pin is gone', () => {
  it('the Claude backend no longer hard-codes the bypass', () => {
    // The before-state, written down: two adjacent lines that switched the SDK's
    // permission system off for every session regardless of the user's mode.
    const source = claudeAgentSource();
    expect(source).not.toContain("permissionMode: 'bypassPermissions',");
    expect(source).not.toContain('allowDangerouslySkipPermissions: true,');
    // …and the replacement is the table, applied to the session's own mode.
    expect(source).toContain('buildClaudePermissionModeOptions(getPermissionMode(sessionKey))');
  });

  it('the user\'s own mode is what reaches the SDK', () => {
    for (const mode of PERMISSION_MODE_ORDER) {
      expect(buildClaudePermissionModeOptions(mode).permissionMode)
        .toBe(CLAUDE_SDK_PERMISSION_MODE_TABLE[mode]);
    }
    // The one that used to be everyone's mode is now only the mode it names.
    expect(buildClaudePermissionModeOptions('bypassPermissions').permissionMode)
      .toBe('bypassPermissions');
    expect(buildClaudePermissionModeOptions('default').permissionMode).toBe('default');
  });

  it('`allowDangerouslySkipPermissions` rides with bypass and with nothing else', () => {
    // "Must be set to `true` when using `permissionMode: 'bypassPermissions'`.
    // This is a safety measure to ensure intentional bypassing of permissions."
    // (sdk.d.ts) — so it is not a second knob, and the pin's version said this
    // about six modes that had not asked for it.
    for (const mode of PERMISSION_MODE_ORDER) {
      const options = buildClaudePermissionModeOptions(mode);
      if (options.permissionMode === 'bypassPermissions') {
        expect(options.allowDangerouslySkipPermissions).toBe(true);
      } else {
        expect(options).not.toHaveProperty('allowDangerouslySkipPermissions');
      }
    }
  });
});

describe('R3 — the mode table, one row per mode', () => {
  const EXPECTED: Record<PermissionMode, ClaudeSdkPermissionMode> = {
    dontAsk: 'dontAsk',
    plan: 'default',
    default: 'default',
    acceptEdits: 'acceptEdits',
    auto: 'auto',
    bypassPermissions: 'bypassPermissions',
  };

  it.each(PERMISSION_MODE_ORDER)('%s translates to the mode the docs describe', mode => {
    expect(toClaudeSdkPermissionMode(mode)).toBe(EXPECTED[mode]);
  });

  it('covers every mode we have — no mode falls off the table', () => {
    expect(Object.keys(CLAUDE_SDK_PERMISSION_MODE_TABLE).sort())
      .toEqual([...PERMISSION_MODE_ORDER].sort());
  });

  it('emits only modes the installed SDK actually has', () => {
    // R1's drift pattern: read the union out of the SDK at run time, so a rename
    // or a removal fails HERE, by name, instead of shipping an option the
    // runtime rejects. (F1.1050 retired our own `explore`, so no mode of ours lacks an SDK member.)
    const sdkModes = readSdkPermissionModes();
    for (const mode of PERMISSION_MODE_ORDER) {
      expect(sdkModes).toContain(toClaudeSdkPermissionMode(mode));
    }
    // The ordering list is the invariant's index, so it must stay complete too.
    expect([...CLAUDE_SDK_PERMISSION_MODE_ORDER].sort() as string[]).toEqual([...sdkModes].sort());
  });

  it('THE NO-WIDENING INVARIANT — a stricter mode never maps to a looser one', () => {
    // `PERMISSION_MODE_ORDER` is least-to-most permissive and its positions are
    // the clamp's index; the SDK list mirrors it. A single wrong entry in the
    // table is invisible at the call site, so this is asserted over the whole
    // table rather than per row.
    const rank = (mode: ClaudeSdkPermissionMode) => CLAUDE_SDK_PERMISSION_MODE_ORDER.indexOf(mode);
    for (let i = 0; i < PERMISSION_MODE_ORDER.length; i += 1) {
      for (let j = i + 1; j < PERMISSION_MODE_ORDER.length; j += 1) {
        const stricter = toClaudeSdkPermissionMode(PERMISSION_MODE_ORDER[i]!);
        const looser = toClaudeSdkPermissionMode(PERMISSION_MODE_ORDER[j]!);
        expect(rank(stricter)).toBeLessThanOrEqual(rank(looser));
      }
    }
  });

  it('THE NEGATIVE CONTROL — the invariant catches the widening it exists for', () => {
    // The mistake this guards: giving a read-only mode a mode that approves
    // things. Written out so the assertion above is known to be able to fail.
    const widened: Record<PermissionMode, ClaudeSdkPermissionMode> = {
      ...CLAUDE_SDK_PERMISSION_MODE_TABLE,
      plan: 'acceptEdits',
    };
    const rank = (mode: ClaudeSdkPermissionMode) => CLAUDE_SDK_PERMISSION_MODE_ORDER.indexOf(mode);
    expect(rank(widened.plan)).toBeGreaterThan(rank(widened.default));
  });

  it('`plan` does not become SDK plan mode — that route is recorded REFUTED', () => {
    // Not a style choice. `permissionMode` is one scalar, Claude Code does not
    // enforce plan blocking where bypass is available, `plan` is our no-write
    // floor when a session switches runtime, and Codex has no native plan mode
    // at all. SDK plan would also "route file-edit and shell-write tools to your
    // `canUseTool` callback regardless of allow rules", which would put a card
    // in front of the plan file the agent writes in this very mode.
    expect(toClaudeSdkPermissionMode('plan')).not.toBe('plan');
  });

  // F1.1050 (DN-272): with `explore` gone, every mode of ours has an SDK member of
  // the same name; only `plan` is deliberately NOT mapped by identity (above).
  // The arm that stood here asserted explore's `'default'` landing and its
  // absence from the SDK union, which the retirement made vacuous. (These lines
  // also keep the file's later line numbers where the plan cites them.)
  it('F1.1050: the vocabulary is the SDK\'s own six — our table and the SDK union name the same modes', () => {
    // This test pinned `explore` staying ours on SDK `default`; F1.1050 (DN-272) retired it, so the arm is now
    // the equality it made possible. `plan` still lands on `default` (asserted above), our gate on top.
    expect(Object.keys(CLAUDE_SDK_PERMISSION_MODE_TABLE).sort()).toEqual([...readSdkPermissionModes()].sort());
  });
});

// ===========================================================================
// Safe Mode is the reason the bypass existed. This is the end-to-end check the
// row demanded: our gate's approval of a genuinely read-only command must reach
// the runtime carrying the decision that skips the prompt.
// ===========================================================================

/**
 * The read-only allowlist the product actually ships
 * (`apps/electron/resources/permissions/default.json`), pinned in rather than
 * re-invented. `SAFE_MODE_CONFIG`'s own comment is the reason: "Empty fallbacks
 * — actual patterns loaded from default.json. If default.json is missing, no
 * bash commands will be auto-allowed in Plan or Don't ask." A test that supplied its
 * own two patterns would prove the wiring against a fixture; this proves it
 * against the file a user has on disk.
 */
const shippedReadOnlyDefaults = parsePermissionsJson(
  readFileSync(
    new URL('../../../../../apps/electron/resources/permissions/default.json', import.meta.url),
    'utf8',
  ),
);

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
  getCapabilityPermissionsContext: () => ({
    workspaceRootPath: '/tmp/r3-safe-mode',
    pinnedRevision: 'r3',
    pinnedConfigs: [{ config: shippedReadOnlyDefaults, scope: 'workspace' }],
  }),
};

let gateSequence = 0;
function gate(toolName: string, input: Record<string, unknown>, mode: PermissionMode) {
  gateSequence += 1;
  const sessionKey = { workspaceId: 'r3-safe-mode', sessionId: `r3-safe-mode-${gateSequence}` };
  initializeModeState(sessionKey, mode);
  try {
    return runPreToolUseChecks({
      toolName,
      input,
      sessionId: sessionKey.sessionId,
      sessionKey,
      permissionMode: mode,
      workspaceRootPath: '/tmp/r3-safe-mode',
      permissionManager,
    } as never);
  } finally {
    cleanupModeState(sessionKey);
  }
}

/** The gate's decision, expressed the way the hook expresses it to the SDK. */
function hookPayload(toolName: string, input: Record<string, unknown>, mode: PermissionMode) {
  const outcome = gate(toolName, input, mode);
  if (outcome.type !== 'allow' && outcome.type !== 'modify') return { outcome, payload: undefined };
  const payload = buildClaudePreToolUseContinue({})(
    outcome.type === 'modify' ? outcome.input : undefined,
  );
  return { outcome, payload };
}

describe('R3 — plan and default still run a read-only command with no card', () => {
  const READ_ONLY = ['git status', 'ls -la', 'cat package.json | head -5'];

  it.each(READ_ONLY)('%s is approved and the approval says "skip the prompt"', command => {
    for (const mode of ['plan', 'default'] as PermissionMode[]) {
      const { outcome, payload } = hookPayload('Bash', { command }, mode);
      expect(outcome.type).toBe('allow');
      // `hooks.md`: "`\"allow\"` skips the permission prompt". Without this
      // field — the pre-R1 shape — the same call falls through to normal
      // permission evaluation, and under `default` that is a card per command.
      expect(payload?.hookSpecificOutput?.permissionDecision).toBe('allow');
      expect(payload?.continue).toBe(true);
      // "For `\"allow\"` … shown to the user but not Claude" — a prompt that is
      // being skipped has no user to show a reason to.
      expect(payload?.hookSpecificOutput).not.toHaveProperty('permissionDecisionReason');
    }
  });

  it('THE AST IS WHY THE BYPASS EXISTED — a command that merely starts read-only is not', () => {
    // Their rules match command strings; ours parses the command
    // (`bash-validator.ts`). This is the case a string rule gets wrong, and it
    // is what the mapping must not lose: the same prefix, a different command.
    for (const command of ['git status && rm -rf /tmp/x', 'ls -la > /etc/hosts']) {
      expect(gate('Bash', { command }, 'plan').type).not.toBe('allow');
      expect(gate('Bash', { command }, 'default').type).not.toBe('allow');
    }
  });

  it('the no-write floor of `plan` is our gate, not the mapped mode', () => {
    // It maps to SDK `default` (as the retired explore did), which approves nothing on its own; the refusal
    // has to come from here, and a hook deny "applies even in
    // `bypassPermissions` mode", so no mode can overturn it.
    for (const mode of ['plan'] as PermissionMode[]) {
      const write = gate('Write', { file_path: '/tmp/r3-safe-mode/x.ts', content: 'x' }, mode);
      expect(write.type).toBe('block');
      const shell = gate('Bash', { command: 'rm -rf /tmp/r3-safe-mode' }, mode);
      expect(shell.type).not.toBe('allow');
    }
  });
});

// ===========================================================================
// The reason the owner asked for this row: rules written in Claude's own format
// start taking effect on the Claude runtime.
// ===========================================================================

/** The same verbatim block `claude-project-settings-permissions.test.ts` uses. */
const CLAUDE_SETTINGS = JSON.stringify({
  permissions: {
    allow: ['Bash(npm run *)'],
    ask: ['Bash(git push *)'],
    deny: ['Bash(curl:*)'],
  },
});

/** The decision Pi reaches for one call, through the shared compiled policy. */
function piDecision(command: string) {
  const merged = permissionsConfigCache.getMergedConfig({
    workspaceRootPath: '/nonexistent/r3-rules',
    pinnedRevision: 'gen',
    projectTrusted: true,
    pinnedConfigs: [{ config: parsePermissionsJson(CLAUDE_SETTINGS), scope: 'project' }],
  });
  const program = merged.permissionDsl;
  if (!program) throw new Error('the Claude settings block did not compile');
  return evaluatePermissionDslV1(program, {
    generation: 'gen',
    cwd: '/work/repo',
    toolName: 'Bash',
    semanticId: 'bash',
    input: { command },
  }).action ?? 'none';
}

describe('R3 — one rule, one action, the same outcome on both runtimes', () => {
  it('deny: Pi refuses it, and on Claude no decision of ours can un-refuse it', () => {
    expect(piDecision('curl https://example.test')).toBe('deny');
    // "Hook decisions don't bypass permission rules. Claude Code evaluates deny
    // and ask rules regardless of what a PreToolUse hook returns: a matching
    // deny rule blocks the call" (permissions.md). Our strongest possible
    // decision on this call is `allow`, and the page says it loses — which is
    // the only half of this we own. That the SDK obeys its own page is the live
    // case's job.
    expect(buildClaudePreToolUseContinue({})().hookSpecificOutput?.permissionDecision).toBe('allow');
  });

  it('ask: Pi prompts, and on Claude the same rule now reaches a card', () => {
    expect(piDecision('git push origin main')).toBe('ask');
    // The Claude half is executed in `claude-can-use-tool-approval.test.ts`:
    // an ask rule arrives at `canUseTool` carrying `matchedAskRule`, and a card
    // is raised naming the rule. Until R3 that call was auto-approved (R1's
    // before-state) and then hard-refused (R2's), so this is the row where the
    // user's own rule finally does what they wrote.
  });

  it('allow: Pi runs it, and on Claude nothing of ours forces a prompt', () => {
    expect(piDecision('npm run build')).toBe('allow');
    // Our gate does not know this rule (the compiled Claude DSL is consumed
    // Pi-side), so its own answer for `npm run build` is a prompt — and the
    // SDK's allow rule resolves the call at the allow-rules step, before the
    // callback. What we must not do is deny it, and we do not.
    expect(gate('Bash', { command: 'npm run build' }, 'default').type).toBe('prompt');
  });

  it('the rules reach the SDK at all — the precondition the whole row rests on', () => {
    // "These rules are read when the `project` setting source is enabled … If
    // you set `setting_sources` … include `\"project\"` for them to apply."
    // (agent-sdk/permissions.md). Local and user carry the other two scopes a
    // Claude user writes rules in.
    expect(buildClaudeTurnShapeOptions({ presetAppend: 'x' }).settingSources)
      .toEqual(['user', 'project', 'local']);
  });
});
