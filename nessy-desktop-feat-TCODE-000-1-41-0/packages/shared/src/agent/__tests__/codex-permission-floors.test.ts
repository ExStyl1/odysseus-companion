/**
 * P2.140 / P2.123 — the non-negotiable floors run on the CODEX approval path,
 * and they are the SAME code that runs on Pi.
 *
 * ## What was measured before this existed (2026-08-25, production path)
 *
 * `runPreToolUseChecks` occurred ZERO times in `codex-agent.ts`, with pi 6 and
 * claude 1 as the positive controls, so none of the `nonNegotiable` floors
 * executed on codex. Driven through the real `CodexAgent.handleServerRequest`,
 * an `item/commandExecution/requestApproval` for `rm -rf ~`:
 *   - with `allow: ['Bash(rm:*)']` active → `{decision:'accept'}`, NO card;
 *   - headless (no permission callback) → `{decision:'accept'}`;
 *   - otherwise → a card whose Always Allow was accepted and answered
 *     `{decision:'acceptForSession'}`.
 * The same rule on Pi cannot clear the same floor. One rule, two meanings.
 *
 * ## What each test here kills
 *
 * Named per test, because a count of green tests is not evidence: a suite whose
 * assertions are all satisfiable by the reverted code proves nothing. Every
 * assertion below was checked to FAIL against the pre-fix behaviour, and the
 * negative controls exist so that "it passes" is not also satisfied by a gate
 * that refuses everything.
 *
 * SAFETY: every dangerous string here is DATA handed to a matcher and to an
 * in-memory approval bridge. Nothing in this file spawns a process, and nothing
 * touches a real home directory or the filesystem root.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import type { BackendConfig, PermissionCallback } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';
import { permissionsConfigCache } from '../permissions-config.ts';
import { findNonNegotiableFloors, firstNonNegotiableFloor } from '../core/pre-tool-use.ts';
import type { PermissionMode } from '../mode-types.ts';
import { UNATTENDED_APPROVAL_FALLBACK_ENV_VAR } from '../../config/unattended-approval.ts';

const WORKSPACE_ROOT = '/tmp/nessy-codex-floors-ws';
const PROJECT_CWD = '/tmp/nessy-codex-floors-project';
const EXEC_METHOD = 'item/commandExecution/requestApproval';
const EXEC_METHOD_V1 = 'execCommandApproval';
const PATCH_METHOD_V1 = 'applyPatchApproval';

/**
 * Built by `join` rather than written as a literal so no line of this file is
 * itself a runnable removal, and so a careless copy-paste out of it does not
 * become one.
 */
const HOME_RM = ['rm', '-rf', '~'].join(' ');
const ROOT_RM = ['rm', '-rf', '/'].join(' ');
/** The spelling codex actually sends: `shell_command` wraps every script. */
const WRAPPED_HOME_RM = `/bin/zsh -lc '${HOME_RM}'`;
const BENIGN = 'git status';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-floors',
      name: 'Floors Workspace',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: '/tmp/nessy-codex-floors-sessions/ws-floors',
    } as any,
    session: {
      id: 'session-floors',
      workspaceRootPath: WORKSPACE_ROOT,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: PROJECT_CWD,
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

/** A session whose permission rules are exactly `rules`; `null` publishes none. */
function agentWith(rules: Record<string, string[]> | null, mode?: PermissionMode) {
  const agent = new CodexAgent(createConfig());
  const debug: string[] = [];
  const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
  agent.onDebug = (message) => { debug.push(message); };
  agent.onPermissionRequest = (request) => { surfaced.push(request); };
  agent.getPermissionManager().setCapabilityPermissionLayers(
    rules === null ? [] : [{ content: JSON.stringify({ permissions: rules }), scope: 'workspace' }],
    'generation-p2140',
    true,
  );
  if (mode) agent.setPermissionMode(mode);
  return { agent, debug, surfaced };
}

/**
 * P6.531 · run one body with the unattended escape hatch at a chosen value.
 *
 * `delete` first and on the restore path too: assigning over a name Bun
 * pre-created a slot for leaves it readable by property and INVISIBLE to
 * `Object.keys` and to every spread (AGENTS.md §Traps). Unconditional, because
 * the restore has the same hazard as the set.
 */
async function withUnattendedFallback(value: string | undefined, body: () => Promise<void>): Promise<void> {
  const previous = process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR];
  delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR];
  if (value !== undefined) process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR] = value;
  try {
    await body();
  } finally {
    delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR];
    if (previous !== undefined) process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR] = previous;
  }
}

/** A headless session: no permission callback at all. */
function headlessAgent(mode?: PermissionMode) {
  const agent = new CodexAgent(createConfig());
  const debug: string[] = [];
  agent.onDebug = (message) => { debug.push(message); };
  if (mode) agent.setPermissionMode(mode);
  return { agent, debug };
}

const ask = (agent: CodexAgent, method: string, params: unknown) =>
  (agent as any).handleServerRequest(method, params) as Promise<Record<string, unknown>> | Record<string, unknown>;

beforeEach(() => {
  permissionsConfigCache.clear();
});

describe('an allow rule cannot clear a floor on codex (P2.123, the measured violation)', () => {
  /**
   * KILLS: removing the floor gate from `handleServerRequest`, and removing the
   * floor arm from `consultPermissionRules`. This is the exact before-state
   * measurement — `{decision:'accept'}` with `surfaced.length === 0` — so it
   * cannot pass against the reverted code.
   */
  it('does not auto-approve a home wipe that an allow rule matches', async () => {
    const { agent, surfaced, debug } = agentWith({ allow: ['Bash(rm:*)'] });

    const pending = ask(agent, EXEC_METHOD, { command: HOME_RM, cwd: PROJECT_CWD });

    expect(surfaced).toHaveLength(1);
    expect(debug.some(line => line.includes('auto-allowed by permission rule'))).toBe(false);
    expect(debug.some(line => line.includes('the removalCircuitBreaker floor is non-negotiable'))).toBe(true);
    agent.respondToPermission(surfaced[0]!.requestId, true);
    expect(await pending).toEqual({ decision: 'accept' });
  });

  /**
   * THE NEGATIVE CONTROL for the test above. The identical allow rule on a
   * command with no floor still auto-approves with no card — without this, the
   * assertion above is equally satisfied by a gate that suspended R6 entirely.
   */
  it('still auto-approves the same rule on a command with no floor', async () => {
    const { agent, surfaced, debug } = agentWith({ allow: [`Bash(${BENIGN})`] });

    const result = await ask(agent, EXEC_METHOD, { command: BENIGN, cwd: PROJECT_CWD });

    expect(result).toEqual({ decision: 'accept' });
    expect(surfaced).toEqual([]);
    expect(debug.some(line => line.includes('auto-allowed by permission rule'))).toBe(true);
  });

  /**
   * KILLS: moving the floor gate BELOW the rule consult's deny arm, or making a
   * floor swallow a deny. A rule making the answer stricter is always allowed to
   * — that is the may-only-tighten rule's other direction — so a deny on a floor
   * command still short-circuits without a card.
   */
  it('lets a deny rule still refuse a floor command without a card', async () => {
    const { agent, surfaced } = agentWith({ deny: ['Bash(rm:*)'] });

    const result = await ask(agent, EXEC_METHOD, { command: HOME_RM, cwd: PROJECT_CWD });

    expect(result).toEqual({ decision: 'decline' });
    expect(surfaced).toEqual([]);
  });

  /**
   * KILLS: reading `codexApprovalRuleRequests` for the floor instead of
   * `codexApprovalFloorSubjects`. The v1 argv `['bash','-lc','rm -rf ~']` fails
   * `SHELL_SAFE_ARGV_WORD` on its third word, so the ALLOW projection yields
   * `[]` — a floor built on it sees nothing in exactly the class it exists for.
   *
   * THE FIRST VERSION OF THIS TEST WAS VACUOUS and the re-break caught it: it
   * asserted only that a card was surfaced, which is ALSO what the broken code
   * does (the narrow projection returns `[]`, no rule matches, and the request
   * falls through to the same card). The mutation survived all 16 tests. The
   * observable that actually separates the two is what the floor CHANGES about
   * the card — `noAlwaysAllow`, and the floor's own debug line — so that is what
   * is asserted now, plus the headless arm, where a seen floor declines and an
   * unseen one auto-approves.
   */
  it('sees the script inside a v1 argv whose words the allow projection refuses', async () => {
    const { agent, surfaced } = agentWith({ allow: ['Bash(bash:*)'] });

    const pending = ask(agent, EXEC_METHOD_V1, { command: ['bash', '-lc', HOME_RM], cwd: PROJECT_CWD });

    expect(surfaced).toHaveLength(1);
    // Not merely "a card appeared" — a card the floor OWNS. `noAlwaysAllow` is
    // the discriminator, and the debug channel deliberately is NOT: with the
    // narrow projection the allow rule does not match either, so
    // `consultPermissionRules` returns before it can log anything and the debug
    // line is absent in BOTH the fixed and the broken code.
    expect(surfaced[0]!.noAlwaysAllow).toBe(true);
    expect(surfaced[0]!.description).toContain('removes');
    agent.respondToPermission(surfaced[0]!.requestId, true);
    await pending;
  });

  /**
   * The same mutation seen from the headless arm, where the two behaviours are
   * opposite answers rather than two flavours of the same card: a floor the
   * projection can see declines, and one it cannot see is auto-approved.
   *
   * KILLS: the same narrow-projection mutation, independently of the card
   * assertions above — one mutation must not be able to hide behind one test.
   */
  it('declines the same v1 argv headless', async () => {
    const { agent } = headlessAgent();

    // v1's refusal is a nested object, not the v2 string enum.
    const result = await ask(agent, EXEC_METHOD_V1, { command: ['bash', '-lc', HOME_RM], cwd: PROJECT_CWD });
    expect((result as Record<string, unknown>).decision).toHaveProperty('denied');
  });

  /**
   * NEGATIVE CONTROL for both of the above: a v1 argv with no floor in it still
   * gets the ordinary treatment, so the two tests are not satisfied by a floor
   * that fires on every v1 request.
   */
  it('leaves an ordinary v1 argv alone (P6.531: with the escape hatch open)', async () => {
    // P6.531 flipped the unattended default to DENY, so this control now needs
    // the operator escape hatch to stay a control: without it, "the floor
    // declines" above would be equally satisfied by a fallback that declines
    // everything. With the hatch at `allow` the pre-P6.531 behaviour is exactly
    // what is asserted here, which is what makes the pair meaningful.
    const { agent } = headlessAgent();

    await withUnattendedFallback('allow', async () => {
      expect(await ask(agent, EXEC_METHOD_V1, { command: ['git', 'status'], cwd: PROJECT_CWD }))
        .toEqual({ decision: 'approved' });
    });
  });
});

describe('a floor outranks the headless yes (P2.140)', () => {
  /**
   * KILLS: leaving the headless auto-approve above the floor gate — which is
   * where it was. Unattended `{decision:'accept'}` for a home wipe was the
   * measured before-state.
   */
  it('refuses a home wipe with nobody to ask', async () => {
    const { agent, debug } = headlessAgent();

    const result = await ask(agent, EXEC_METHOD, { command: HOME_RM, cwd: PROJECT_CWD });

    expect(result).toEqual({ decision: 'decline' });
    expect(debug.some(line => line.includes('refused headless by the removalCircuitBreaker floor'))).toBe(true);
  });

  /**
   * NEGATIVE CONTROL, and P6.531 moved where it lives.
   *
   * Before P6.531 the unattended fallback said yes to everything a floor did
   * not catch, so "a benign command is approved" was the control proving the
   * floor gate does not simply refuse everything. P6.531 made the DEFAULT deny
   * — matching Pi and claude — so the control now runs with the operator escape
   * hatch open, which is the only configuration in which the old assertion is
   * still the right one.
   */
  it('still auto-approves a benign command with nobody to ask when the escape hatch is open', async () => {
    const { agent } = headlessAgent();

    await withUnattendedFallback('allow', async () => {
      expect(await ask(agent, EXEC_METHOD, { command: BENIGN, cwd: PROJECT_CWD }))
        .toEqual({ decision: 'accept' });
    });
  });

  /**
   * P6.531 — the row itself. Q-den 68 = A + C.
   *
   * KILLS: reverting the unattended fallback to a yes. Before this row codex
   * approved an uncovered call with nobody to ask while Pi and claude both
   * refused, so the ABSENCE OF A HUMAN widened what could run on exactly one
   * runtime — and nothing said so.
   */
  it('refuses a benign command with nobody to ask, at the shipped default', async () => {
    const { agent, debug } = headlessAgent();

    await withUnattendedFallback(undefined, async () => {
      expect(await ask(agent, EXEC_METHOD, { command: BENIGN, cwd: PROJECT_CWD }))
        .toEqual({ decision: 'decline' });
    });
    expect(debug.some(line => line.includes('refused headless: no rule and no floor covered'))).toBe(true);
  });

  it('an unrecognised escape-hatch value reads as DENY, not as allow', async () => {
    // A typo in a restriction must not silently open it — the opposite of the
    // tolerant-parse rule the rest of that package follows for preferences.
    const { agent } = headlessAgent();

    await withUnattendedFallback('yes-please', async () => {
      expect(await ask(agent, EXEC_METHOD, { command: BENIGN, cwd: PROJECT_CWD }))
        .toEqual({ decision: 'decline' });
    });
  });

  /**
   * KILLS: a floor gate that only covers the un-wrapped spelling. Codex's
   * `shell_command` wraps EVERY command as `<shell> -lc '<script>'`, so the
   * wrapped form is the one that actually arrives.
   */
  it('refuses the wrapped spelling codex actually sends', async () => {
    const { agent } = headlessAgent();

    expect(await ask(agent, EXEC_METHOD, { command: WRAPPED_HOME_RM, cwd: PROJECT_CWD }))
      .toEqual({ decision: 'decline' });
  });
});

describe('a floor prompt has no don\'t-ask-again on codex (P2.140)', () => {
  /**
   * KILLS: passing `alwaysAllow` through for a floor request. Before this, the
   * card's Always Allow was accepted and answered `acceptForSession`, which asks
   * CODEX to remember the decision — after which our gate never sees the call
   * again.
   */
  it('answers a one-shot accept and never acceptForSession', async () => {
    const { agent, surfaced, debug } = agentWith(null);

    const pending = ask(agent, EXEC_METHOD, { command: HOME_RM, cwd: PROJECT_CWD });
    expect(surfaced).toHaveLength(1);
    agent.respondToPermission(surfaced[0]!.requestId, true, true);

    expect(await pending).toEqual({ decision: 'accept' });
    expect(debug.some(line => line.includes('Always Allow refused by the removalCircuitBreaker floor'))).toBe(true);
  });

  /**
   * NEGATIVE CONTROL: Always Allow still works on a command with no floor —
   * without this, the test above is satisfied by dropping `alwaysAllow` always.
   */
  it('still honours Always Allow on a command with no floor', async () => {
    const { agent, surfaced } = agentWith(null);

    const pending = ask(agent, EXEC_METHOD, { command: BENIGN, cwd: PROJECT_CWD });
    agent.respondToPermission(surfaced[0]!.requestId, true, true);

    expect(await pending).toEqual({ decision: 'acceptForSession' });
  });

  /**
   * KILLS: leaving the card's Always Allow button visible while silently
   * refusing the persistence — a refusal the user cannot see is worse than the
   * button being absent.
   */
  it('hides the Always Allow button on a floor card and shows it otherwise', () => {
    const floored = agentWith(null);
    void ask(floored.agent, EXEC_METHOD, { command: HOME_RM, cwd: PROJECT_CWD });
    expect(floored.surfaced[0]!.noAlwaysAllow).toBe(true);
    expect(floored.surfaced[0]!.description).toContain('removes');

    const ordinary = agentWith(null);
    void ask(ordinary.agent, EXEC_METHOD, { command: BENIGN, cwd: PROJECT_CWD });
    expect(ordinary.surfaced[0]!.noAlwaysAllow).toBeUndefined();
  });
});

describe('the floor is the same code that stops the command on Pi (P2.140)', () => {
  /**
   * KILLS: a codex-shaped re-implementation of the floors. The seam's whole
   * value is that ONE matcher decides for every runtime; this asserts identity
   * of the verdict, not merely that both refuse.
   */
  it('reaches the identical verdict the shared evaluator gives the pipeline', () => {
    for (const command of [HOME_RM, ROOT_RM, WRAPPED_HOME_RM]) {
      const shared = firstNonNegotiableFloor(
        findNonNegotiableFloors('Bash', { command }, 'default'),
      );
      expect(shared).not.toBeNull();
      const agent = new CodexAgent(createConfig());
      expect((agent as any).floorVerdict('command', { command, cwd: PROJECT_CWD })).toEqual(shared);
    }
  });

  /** NEGATIVE CONTROL: both agree there is no floor on a benign command. */
  it('agrees with the shared evaluator that a benign command has no floor', () => {
    expect(firstNonNegotiableFloor(findNonNegotiableFloors('Bash', { command: BENIGN }, 'default'))).toBeNull();
    const agent = new CodexAgent(createConfig());
    expect((agent as any).floorVerdict('command', { command: BENIGN, cwd: PROJECT_CWD })).toBeNull();
  });

  /**
   * KILLS: `if (mode === 'bypassPermissions') return null` — or any other mode
   * carve-out — added to the removal breaker. `permission-modes.md`'s
   * bypassPermissions row for a critical-path removal is "Asks you to approve
   * it", so no mode may drop this to nothing.
   */
  it('keeps the removal breaker in every permission mode', () => {
    const modes: PermissionMode[] = [
      'default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions',
    ];
    for (const mode of modes) {
      const verdict = firstNonNegotiableFloor(findNonNegotiableFloors('Bash', { command: HOME_RM }, mode));
      expect(verdict, `mode ${mode} lost the breaker`).not.toBeNull();
      expect(verdict!.floor).toBe('removalCircuitBreaker');
    }
  });

  /**
   * KILLS: an `allow` escape hatch added to the floor evaluator. The predicate
   * this pins is the STRUCTURAL half of may-only-tighten: consulting a floor can
   * cost an approval and can never buy one, so no input may produce an
   * authorizing outcome.
   */
  it('never produces an outcome that authorizes a call', () => {
    const subjects: Array<[string, Record<string, unknown>]> = [
      ['Bash', { command: HOME_RM }],
      ['Bash', { command: ROOT_RM }],
      ['Bash', { command: BENIGN }],
      ['Write', { file_path: '.claude/settings.json' }],
      ['Write', { file_path: 'src/index.ts' }],
      ['Read', { file_path: '.claude/settings.json' }],
    ];
    for (const mode of ['default', 'dontAsk', 'bypassPermissions'] as PermissionMode[]) {
      for (const [toolName, input] of subjects) {
        const verdict = firstNonNegotiableFloor(findNonNegotiableFloors(toolName, input, mode));
        if (verdict === null) continue;
        expect(['deny', 'prompt']).toContain(verdict.outcome);
      }
    }
  });
});

describe('the protected-path floor reaches a codex patch approval (P2.140)', () => {
  /**
   * KILLS: dropping `fileChangeV1` from the floor projection. The v1
   * `applyPatchApproval` names its files, so the protected-path floor is
   * expressible there — and a write to `.claude/` is "never auto-approved".
   */
  it('prompts for a protected-path write a v1 patch approval names', async () => {
    const { agent, surfaced } = agentWith({ allow: ['Edit(.claude/**)'] });

    const pending = ask(agent, PATCH_METHOD_V1, {
      fileChanges: { '.claude/settings.json': { add: {} } },
      cwd: PROJECT_CWD,
    });

    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]!.noAlwaysAllow).toBe(true);
    agent.respondToPermission(surfaced[0]!.requestId, true);
    await pending;
  });

  /** NEGATIVE CONTROL: an ordinary source path under the same rule still allows. */
  it('still auto-approves an ordinary path under the same rule', async () => {
    const { agent, surfaced } = agentWith({ allow: ['Edit(src/**)'] });

    const result = await ask(agent, PATCH_METHOD_V1, {
      fileChanges: { 'src/index.ts': { add: {} } },
      cwd: PROJECT_CWD,
    });

    // v1's own response vocabulary: `approved`, not the v2 `accept`.
    expect(result).toEqual({ decision: 'approved' });
    expect(surfaced).toEqual([]);
  });
});

/**
 * P6.61 — `bypassPermissions` gets its MODE ANSWER, and its two unconditional
 * floors start running.
 *
 * ## The state this replaces
 *
 * With the sandbox master switch off, P2.197 degraded `on-request` to
 * `untrusted` for six of seven modes so that codex routes calls to us at all —
 * an unbounded `on-request` sends NO approval request for a call the model does
 * not itself escalate, so no floor can run. `bypassPermissions` was excluded,
 * because `handleServerRequest` had no way to answer from the MODE: it would
 * have carded every non-read-only command in the one mode whose own guidance
 * says *"full autonomy, no approval prompts; everything runs freely"*. The
 * stated cost was that the removal circuit breaker and the `Remove-Item` ladder
 * never ran there — which is the loosest configuration this product ships.
 *
 * ## WHAT EACH TEST KILLS
 *
 *  - "runs with no card" dies if the mode answer is removed. That is the
 *    shipped-today behaviour under `on-request` (no request at all) AND what
 *    degrading without an answer would have produced (a card) — the assertion
 *    distinguishes both from the fix, because it demands `accept` AND zero
 *    cards.
 *  - "the removal circuit breaker still reaches a person" dies if the mode
 *    answer is placed above the floor gate or stops testing for a floor. This
 *    is the whole point of the row: `bypassPermissions` may skip the card, it
 *    may not skip the floor.
 *  - "the Remove-Item ladder still denies without asking" dies the same way for
 *    the `deny` outcome, which must refuse in EVERY mode.
 *  - "a deny rule still refuses" dies if the mode answer is placed above the
 *    rule consult. Refusing is never a widening, and a user who wrote a deny
 *    rule did not stop meaning it by choosing this mode.
 *  - the `default`-mode control dies if the answer stops being keyed on the
 *    mode and starts auto-approving everything, which would be a silent global
 *    widening wearing this row's shape.
 */
describe('P6.61 · the bypassPermissions mode answer, and the floors it does not skip', () => {
  it('runs an ordinary command with no approval card at all', async () => {
    const { agent, surfaced, debug } = agentWith(null, 'bypassPermissions');

    const result = await ask(agent, EXEC_METHOD, { command: BENIGN, cwd: PROJECT_CWD });

    expect(result).toEqual({ decision: 'accept' });
    expect(surfaced).toEqual([]);
    expect(debug.some(line => line.includes('auto-allowed by the bypassPermissions mode'))).toBe(true);
  });

  /**
   * THE CONTROL that the answer is keyed on the mode. The identical call in
   * `default` with no rule still reaches a person — without this, "no card"
   * above is equally satisfied by a path that approves everything.
   */
  it('still cards the same command in default mode', () => {
    const { agent, surfaced } = agentWith(null, 'default');
    void ask(agent, EXEC_METHOD, { command: BENIGN, cwd: PROJECT_CWD });
    expect(surfaced).toHaveLength(1);
  });

  it('the removal circuit breaker still reaches a person in bypassPermissions', async () => {
    const { agent, surfaced, debug } = agentWith(null, 'bypassPermissions');

    const pending = ask(agent, EXEC_METHOD, { command: HOME_RM, cwd: PROJECT_CWD });

    // A `prompt` floor's contract is that it must reach a person and cannot be
    // remembered. The mode does not outrank it.
    expect(surfaced).toHaveLength(1);
    expect(debug.some(line => line.includes('auto-allowed by the bypassPermissions mode'))).toBe(false);
    agent.respondToPermission(surfaced[0]!.requestId, true);
    expect(await pending).toEqual({ decision: 'accept' });
  });

  it('the root form reaches a person too', () => {
    const { agent, surfaced } = agentWith(null, 'bypassPermissions');
    void ask(agent, EXEC_METHOD, { command: ROOT_RM, cwd: PROJECT_CWD });
    expect(surfaced).toHaveLength(1);
  });

  it('the wrapped spelling codex actually sends reaches a person as well', () => {
    const { agent, surfaced } = agentWith(null, 'bypassPermissions');
    void ask(agent, EXEC_METHOD, { command: WRAPPED_HOME_RM, cwd: PROJECT_CWD });
    expect(surfaced).toHaveLength(1);
  });

  /**
   * The `deny` rung, which refuses "in every mode, without asking you" — so
   * this is the one arm where `bypassPermissions` gets neither the card nor the
   * command. It is the rung the row names as needing a stubbed arm: PowerShell
   * is not drivable on the darwin rig, so what is driven is the ladder's own
   * matcher through the real approval path, not a live `Remove-Item`.
   */
  it('the Remove-Item ladder still denies without asking in bypassPermissions', async () => {
    const { agent, surfaced, debug } = agentWith(null, 'bypassPermissions');

    const result = await ask(agent, EXEC_METHOD, {
      command: ['Remove-Item', '-Recurse', '-Force', '*'].join(' '),
      cwd: PROJECT_CWD,
    });

    expect(result).toEqual(expect.objectContaining({ decision: 'decline' }));
    expect(surfaced).toEqual([]);
    expect(debug.some(line => line.includes('denied by the removeItemLadder floor'))).toBe(true);
  });

  it('a user deny rule still refuses in bypassPermissions, with no card', async () => {
    const { agent, surfaced } = agentWith({ deny: [`Bash(${BENIGN})`] }, 'bypassPermissions');

    const result = await ask(agent, EXEC_METHOD, { command: BENIGN, cwd: PROJECT_CWD });

    expect(result).toEqual(expect.objectContaining({ decision: 'decline' }));
    expect(surfaced).toEqual([]);
  });
});

/**
 * P6.62 — the `deniedPaths` floor answers on codex instead of asking.
 *
 * ## The state this replaces
 *
 * `shouldAllowToolInMode` carries the deny-path verdict and, on this runtime,
 * was consulted in exactly ONE place: inside `consultPermissionRules`, AFTER a
 * user rule had already matched. So the floor worked for a user who happened to
 * have a rule covering the same call, and for everyone else a
 * `cat ~/.aws/credentials` produced an ordinary approval CARD — the outcome Pi
 * and claude both refuse outright. The credential floor on codex rested entirely
 * on the OS sandbox profile, which P3.308 measured failing to BUILD (rather than
 * to deny) on a root-anchored entry.
 *
 * ## WHAT EACH TEST KILLS
 *
 *  - "refuses a denied path with no card" dies if the check is removed. It is
 *    the exact before-state — a card, `surfaced.length === 1` — so it cannot
 *    pass against the reverted code.
 *  - "still cards an ordinary workspace file" is the POSITIVE CONTROL in the
 *    same rig: without it, "refused" above is equally satisfied by a gate that
 *    denies every command.
 *  - "outranks the bypassPermissions answer" dies if the check is placed below
 *    P6.61's mode answer. `mode-types.ts` documents these paths as must not be
 *    read or written in ANY permission mode.
 *  - "outranks the headless yes" dies if it is placed below the unattended
 *    fallback — the situation a floor is least able to tolerate an approval in.
 *    P6.1073: it can only die that way with the ESCAPE HATCH OPEN. Since P6.531
 *    the fallback's own answer is a refusal, so at the shipped default the case
 *    would pass against a build with no `deniedPaths` gate at all; the arm below
 *    it pins the shipped default separately, and both name the floor's own debug
 *    line rather than the bare verdict.
 *  - "sees a v1 patch's files" dies if the subject projection narrows to shell
 *    commands only.
 *  - the SHARED-SEAM control dies the day someone closes this gap by adding a
 *    fifth floor to `findNonNegotiableFloors`, which would move Pi and claude
 *    to fix something only codex had.
 */
describe('P6.62 · the deniedPaths floor refuses on codex without a card', () => {
  const DENIED_READ = ['cat', '~/.aws/credentials'].join(' ');
  const ORDINARY_READ = ['cat', `${PROJECT_CWD}/README.md`].join(' ');

  it('refuses a denied path with no approval card offered', async () => {
    const { agent, surfaced, debug } = agentWith(null, 'default');

    const result = await ask(agent, EXEC_METHOD, { command: DENIED_READ, cwd: PROJECT_CWD });

    expect(result).toEqual(expect.objectContaining({ decision: 'decline' }));
    expect(surfaced).toEqual([]);
    expect(debug.some(line => line.includes('denied by the deniedPaths floor'))).toBe(true);
  });

  it('still cards an ordinary workspace file in the same run', () => {
    const { agent, surfaced } = agentWith(null, 'default');
    void ask(agent, EXEC_METHOD, { command: ORDINARY_READ, cwd: PROJECT_CWD });
    expect(surfaced).toHaveLength(1);
  });

  it('outranks the bypassPermissions mode answer', async () => {
    const { agent, surfaced } = agentWith(null, 'bypassPermissions');

    const result = await ask(agent, EXEC_METHOD, { command: DENIED_READ, cwd: PROJECT_CWD });

    expect(result).toEqual(expect.objectContaining({ decision: 'decline' }));
    expect(surfaced).toEqual([]);
  });

  it('outranks the headless yes', async () => {
    // P6.1073 — THE HATCH IS OPENED HERE, and that is what keeps this case a
    // test of the ORDERING rather than of nothing.
    //
    // P6.531 turned the unattended fallback itself into a refusal, so at the
    // shipped default this call and every other uncovered one decline: the
    // assertion below then passes on a rig where the `deniedPaths` gate never
    // ran at all, which is exactly the discrimination the case exists to make.
    // With the hatch open there IS a headless yes again, and the floor still
    // outranks it — asserted on the DEBUG LINE too, so "declined" cannot be
    // satisfied by the fallback having answered instead of the floor.
    const { agent, debug } = headlessAgent('default');
    await withUnattendedFallback('allow', async () => {
      const result = await ask(agent, EXEC_METHOD, { command: DENIED_READ, cwd: PROJECT_CWD });
      expect(result).toEqual(expect.objectContaining({ decision: 'decline' }));
      expect(debug.some(line => line.includes('denied by the deniedPaths floor'))).toBe(true);
      expect(debug.some(line => line.includes('refused headless: no rule and no floor covered'))).toBe(false);

      // THE POSITIVE CONTROL that the yes is reachable in this very rig: the
      // ordinary read, same session, same open hatch, IS approved. Without it
      // the case above is equally satisfied by a hatch that never opens.
      const { agent: ordinary } = headlessAgent('default');
      expect(await ask(ordinary, EXEC_METHOD, { command: ORDINARY_READ, cwd: PROJECT_CWD }))
        .toEqual({ decision: 'accept' });
    });
  });

  /**
   * And the shipped default, which is what a user actually meets: the same
   * denied path with the hatch SHUT is still refused, and still by the floor —
   * the fallback's own refusal is never reached. P6.1073's finding is that this
   * arm and the one above were the same test until the hatch was opened.
   */
  it('still refuses the denied path at the shipped default, and by the floor', async () => {
    const { agent, debug } = headlessAgent('default');
    const result = await ask(agent, EXEC_METHOD, { command: DENIED_READ, cwd: PROJECT_CWD });
    expect(result).toEqual(expect.objectContaining({ decision: 'decline' }));
    expect(debug.some(line => line.includes('denied by the deniedPaths floor'))).toBe(true);
  });

  it('sees the files a v1 patch approval names', async () => {
    const { agent, surfaced } = agentWith(null, 'default');

    const result = await ask(agent, PATCH_METHOD_V1, {
      fileChanges: { [`${PROJECT_CWD}/.env`]: { add: { content: 'SECRET=1' } } },
    });

    // The v1 patch family's refusal shape is richer than the exec family's, and
    // it CARRIES THE REASON to the model — asserted rather than paraphrased,
    // because "denied" without a reason is what P6.1 was about.
    expect(result).toEqual({
      decision: {
        denied: {
          rejection:
            'Sensitive path blocked: Write attempted to access '
            + `${PROJECT_CWD}/.env (matched deniedPaths pattern **/.env).`,
        },
      },
    });
    expect(surfaced).toEqual([]);
  });

  it('still cards an ordinary patch target', () => {
    const { agent, surfaced } = agentWith(null, 'default');
    void ask(agent, PATCH_METHOD_V1, {
      fileChanges: { [`${PROJECT_CWD}/src/index.ts`]: { add: { content: 'export {}' } } },
    });
    expect(surfaced).toHaveLength(1);
  });

  /**
   * THE SHARED-SEAM CONTROL, and it is the reason this row was raised from S to
   * M. The obvious place to put a deny-path floor is
   * `findNonNegotiableFloors` — and that function is SHARED, so a fifth floor
   * there would change Pi and claude to close a gap only codex had. This asserts
   * the shared evaluator is untouched: it still knows exactly its four floors,
   * and a denied path is not one of them on any runtime.
   */
  it('leaves the SHARED four-floor evaluator exactly as it was', () => {
    const matches = findNonNegotiableFloors('Bash', { command: DENIED_READ }, 'default');
    // The shared seam says NOTHING about a denied path — this is a codex-side
    // answer, not a fifth shared floor.
    expect(firstNonNegotiableFloor(matches)).toBeNull();
    // And the four it does know are still the four. Read off the returned shape
    // rather than restated, so a fifth key added upstream reddens here.
    expect(Object.keys(findNonNegotiableFloors('Bash', { command: HOME_RM }, 'default')).sort())
      .toEqual(['protectedPathWrite', 'removalCircuitBreaker', 'removeItemLadderDeny', 'shellEvalConstruct']);
  });
});

/**
 * UB12.65 (CRITICAL) — a user's `deniedPaths` entry refuses a RELATIVE token in a codex approval.
 *
 * ## What was measured before this existed (2026-10-17, the real `handleServerRequest`)
 *
 * A workspace layer `deniedPaths: [<secret>/**]` and a codex command frame `cat ../../secret/a.txt` with its `cwd`:
 * `accept` with NO card in bypassPermissions (v2, v1 and the `zsh -lc` wrapped spelling), under an allow rule
 * `Bash(cat:*)` in default and dontAsk, and headless with the escape hatch open; a card in default/acceptEdits/auto.
 * The absolute spelling of the same file was refused in every one of those (the controls). `deniedPathVerdict` asked
 * `shouldAllowToolInMode` with no base, so the floor judged the relative token lexically — the hole UB12.60 closed
 * for Pi and claude. It now passes the frame's `cwd` (else the session's working directory) as `deniedPathBase`.
 *
 * ## What each test kills
 *
 *  - the bypass, allow-rule and v1 arms die if the base is dropped again (each answered `accept` at the pre-fix HEAD);
 *  - the no-`cwd` arm dies if the session-working-directory fallback is dropped;
 *  - the OPEN arm is the negative: the same climb to a folder no entry names still runs, so the fix adds a base and
 *    not a refusal; the frame-cwd arm pins that the base is where codex runs the command, not the session folder.
 */
describe('UB12.65 · a relative token reaches the deniedPaths floor on codex', () => {
  const SECRET = '/tmp/nessy-codex-floors-ub1265-secret';
  const FRAME_CWD = `${PROJECT_CWD}/sub`;
  /** From FRAME_CWD: `/tmp/nessy-codex-floors-project/sub` → `/tmp/nessy-codex-floors-ub1265-secret/a.txt`. */
  const REL_DENIED = '../../nessy-codex-floors-ub1265-secret/a.txt';
  const REL_OPEN = '../../nessy-codex-floors-ub1265-public/a.txt';

  /** Two layers: the Nessy-shaped deny entry, and (when given) a Claude-shaped rule document beside it. */
  function deniedAgent(mode: PermissionMode, rules?: Record<string, string[]>) {
    const agent = new CodexAgent(createConfig());
    const debug: string[] = [];
    const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
    agent.onDebug = (message) => { debug.push(message); };
    agent.onPermissionRequest = (request) => { surfaced.push(request); };
    agent.getPermissionManager().setCapabilityPermissionLayers([
      { content: JSON.stringify({ deniedPaths: [`${SECRET}/**`] }), scope: 'workspace' },
      ...(rules ? [{ content: JSON.stringify({ permissions: rules }), scope: 'workspace' as const }] : []),
    ], 'generation-ub1265', true);
    agent.setPermissionMode(mode);
    return { agent, debug, surfaced };
  }
  const refusedByFloor = (debug: string[]) => debug.some(line => line.includes('denied by the deniedPaths floor'));

  it('CONTROL: the absolute spelling is refused in bypassPermissions (the instrument sees the entry)', async () => {
    const { agent, surfaced, debug } = deniedAgent('bypassPermissions');
    const result = await ask(agent, EXEC_METHOD, { command: `cat ${SECRET}/a.txt`, cwd: FRAME_CWD });
    expect(result).toEqual(expect.objectContaining({ decision: 'decline' }));
    expect(surfaced).toEqual([]);
    expect(refusedByFloor(debug)).toBe(true);
  });

  it('refuses the relative spelling in bypassPermissions, with no card', async () => {
    const { agent, surfaced, debug } = deniedAgent('bypassPermissions');
    const result = await ask(agent, EXEC_METHOD, { command: `cat ${REL_DENIED}`, cwd: FRAME_CWD });
    expect(result).toEqual(expect.objectContaining({ decision: 'decline' }));
    expect(surfaced).toEqual([]);
    expect(refusedByFloor(debug)).toBe(true);
  });

  it('refuses it under an allow rule that covers the command', async () => {
    const { agent, surfaced, debug } = deniedAgent('default', { allow: ['Bash(cat:*)'] });
    const result = await ask(agent, EXEC_METHOD, { command: `cat ${REL_DENIED}`, cwd: FRAME_CWD });
    expect(result).toEqual(expect.objectContaining({ decision: 'decline' }));
    expect(surfaced).toEqual([]);
    expect(refusedByFloor(debug)).toBe(true);
  });

  it('refuses it on the v1 exec frame, whose argv carries the script in one word', async () => {
    const { agent, surfaced, debug } = deniedAgent('bypassPermissions');
    const result = await ask(agent, EXEC_METHOD_V1, { command: ['bash', '-lc', `cat ${REL_DENIED}`], cwd: FRAME_CWD });
    expect(result).toEqual(expect.objectContaining({ decision: expect.objectContaining({ denied: expect.anything() }) }));
    expect(surfaced).toEqual([]);
    expect(refusedByFloor(debug)).toBe(true);
  });

  it('a frame with no cwd resolves at the session working directory', async () => {
    const { agent, surfaced, debug } = deniedAgent('bypassPermissions');
    // From PROJECT_CWD (`createConfig`'s working directory) one climb reaches the same secret.
    const result = await ask(agent, EXEC_METHOD, { command: 'cat ../nessy-codex-floors-ub1265-secret/a.txt' });
    expect(result).toEqual(expect.objectContaining({ decision: 'decline' }));
    expect(surfaced).toEqual([]);
    expect(refusedByFloor(debug)).toBe(true);
  });

  it('OPEN: the same climb to a folder no entry names still runs in bypassPermissions', async () => {
    const { agent, surfaced, debug } = deniedAgent('bypassPermissions');
    const result = await ask(agent, EXEC_METHOD, { command: `cat ${REL_OPEN}`, cwd: FRAME_CWD });
    expect(result).toEqual({ decision: 'accept' });
    expect(surfaced).toEqual([]);
    expect(refusedByFloor(debug)).toBe(false);
  });

  it('OPEN: the base is the frame cwd, not the session folder — a climb that reaches the secret only from there runs', async () => {
    const { agent, debug } = deniedAgent('bypassPermissions');
    // From FRAME_CWD this lands at `/tmp/nessy-codex-floors-project/nessy-codex-floors-ub1265-secret/a.txt`, outside the entry.
    const result = await ask(agent, EXEC_METHOD, { command: 'cat ../nessy-codex-floors-ub1265-secret/a.txt', cwd: FRAME_CWD });
    expect(result).toEqual({ decision: 'accept' });
    expect(refusedByFloor(debug)).toBe(false);
  });
});
