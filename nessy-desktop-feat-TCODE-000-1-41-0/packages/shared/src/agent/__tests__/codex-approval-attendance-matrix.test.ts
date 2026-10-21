/**
 * P6.698 — the mode × ATTENDANCE matrix on codex's approval path.
 *
 * The row's controller decision was *"build the mode×attendance matrix FIRST
 * (which host mode + attended/unattended selects which variant), then select
 * [codex's granular `AskForApproval`] from the source's own enum, then one live
 * measurement"*. This file is the first step, and it is what makes the second
 * step answerable without the third: the matrix shows that on an unattended
 * session ONE mode still reaches the user's own permission rules, which is
 * exactly what codex's granular variant would take away.
 *
 * ## Why a matrix rather than more cases beside the existing suites
 *
 * `codex-permission-rules.test.ts` and `codex-permission-floors.test.ts` each
 * pin one layer deeply. Neither answers *"for this mode, with nobody watching,
 * WHICH layer decides?"* — and that question has no single home in the code
 * either: attendance is `this.onPermissionRequest`, the mode is
 * `getPermissionMode()`, and the two are read fourteen lines apart in
 * `handleServerRequest`. A table is the only shape in which the asymmetry below
 * is visible at all.
 *
 * ## What it pins, and the row it produced
 *
 * As first written this file pinned an ASYMMETRY: with nobody to ask, every mode
 * except `dontAsk` answered from the unattended fallback **before** the rule
 * consult, so a user's own `allow:` rule did not reach an unattended turn while
 * the same rule on the same call was honoured in `dontAsk` and in every attended
 * mode. That became **P6.713**, and the controller's decision was that the
 * ordering is not a posture: rules first, then the fallback for what no rule
 * covers, because a rule the user wrote is precisely the instruction a turn with
 * nobody watching should run on. `codex-agent.ts` now consults the rules above
 * the headless block, and the rows below are the flipped expectation — every
 * mode whose own classification lets a rule answer honours it unattended, and
 * the fallback decides only the calls no rule covers.
 *
 * The `explore`/`plan` cells did NOT flip, and that is the property that shows
 * the move widened nothing: their read-only allowlist suppresses the rule's
 * ALLOW inside the consult, so with nobody to card the call they fall through to
 * the same fallback as before.
 *
 * A THIRD layer turned up while building it and is pinned too: `explore` and
 * `plan` run a read-only allowlist INSIDE the rule consult
 * (`shouldAllowToolInMode`), so a rule's ALLOW is suppressed there and the call
 * goes to the card even with a human present. So "which layer decides" has three
 * inputs, not two, and only the table shows all three at once.
 *
 * ## And it is why the granular variant is not selected
 *
 * `AskForApproval::Granular` with a `false` field makes codex *"automatically
 * reject[…] instead of shown to the user"* — read at `rust-v0.148.0`, and
 * `codex-rs/core/src/safety.rs` folds it into the same `rejects_sandbox_approval`
 * predicate as `never`. `approval_policy` is session-level, so selecting it for
 * an unattended session takes the request away from the `dontAsk` row below —
 * the one mode whose whole operating model is running what the rules
 * pre-approve. `codex-agent.ts` carries the full verdict at the fallback site.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import type { BackendConfig, PermissionCallback } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';
import { UNATTENDED_APPROVAL_FALLBACK_ENV_VAR } from '../../config/unattended-approval.ts';
import { permissionsConfigCache } from '../permissions-config.ts';
import type { PermissionMode } from '../mode-types.ts';

const WORKSPACE_ROOT = '/tmp/nessy-codex-attendance-ws';
const PROJECT_CWD = '/tmp/nessy-codex-attendance-project';
const EXEC_METHOD = 'item/commandExecution/requestApproval';

/** Covered by the session's one `allow:` rule. Benign, so no floor can claim it. */
const RULE_ALLOWED = 'git status';
/** Covered by no rule and by no floor — the call the fallback exists for. */
const UNCOVERED = 'git log --oneline -1';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-attendance',
      name: 'Attendance Workspace',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: '/tmp/nessy-codex-attendance-sessions/ws-attendance',
    } as any,
    session: {
      id: 'session-attendance',
      workspaceRootPath: WORKSPACE_ROOT,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: PROJECT_CWD,
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

/**
 * One cell of the matrix: a session in `mode`, with or without a human to ask,
 * carrying exactly one `allow:` rule.
 *
 * ATTENDANCE IS `onPermissionRequest` AND NOTHING ELSE — that is the whole
 * definition on this path (`const surfaceToUser = this.onPermissionRequest`), so
 * the unattended arm leaves it unset rather than simulating headlessness some
 * other way.
 */
function cell(
  mode: PermissionMode,
  attended: boolean,
  permissions: Record<string, string[]> = { allow: [`Bash(${RULE_ALLOWED})`] },
) {
  const agent = new CodexAgent(createConfig());
  const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
  agent.onDebug = () => {};
  if (attended) agent.onPermissionRequest = (request) => { surfaced.push(request); };
  agent.setPermissionMode(mode);
  agent.getPermissionManager().setCapabilityPermissionLayers(
    [{ content: JSON.stringify({ permissions }), scope: 'workspace' }],
    'generation-p6698',
    true,
  );
  return { agent, surfaced };
}

function ask(agent: CodexAgent, command: string) {
  return (agent as any).handleServerRequest(EXEC_METHOD, { command, cwd: PROJECT_CWD }) as
    Promise<Record<string, unknown>> | Record<string, unknown>;
}

const MODES: readonly PermissionMode[] = [
  'dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions',
];

beforeEach(() => {
  permissionsConfigCache.clear();
  // The shipped default is `deny`; an inherited env value would silently make
  // every unattended row below assert the other arm.
  delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR];
});

describe('P6.698 — mode × attendance on the codex approval path', () => {
  /**
   * ATTENDED, and the control for everything below: with a human present the
   * rule answers wherever the MODE lets it, so the unattended rows cannot be
   * explained by the rule never matching.
   *
   * The two exceptions are a third layer the matrix turned up and are correct:
   * `explore` and `plan` run a read-only allowlist inside
   * `consultPermissionRules` (`shouldAllowToolInMode`), which suppresses the
   * rule's ALLOW and sends the call to the card. Measured, not assumed — the
   * debug line is *"did not answer: Bash command `git status` is not in the
   * read-only allowlist"*. A card is not an answer, so those two are asserted on
   * the SURFACE rather than on a resolved promise, which is also why the promise
   * is deliberately left pending.
   */
  it('a rule-allowed call is accepted wherever the mode lets the rule answer', async () => {
    const answering: readonly PermissionMode[] =
      ['dontAsk', 'default', 'acceptEdits', 'auto', 'bypassPermissions'];
    for (const mode of answering) {
      const { agent, surfaced } = cell(mode, true);
      expect(await ask(agent, RULE_ALLOWED), mode).toEqual({ decision: 'accept' });
      // The rule answered; nothing was shown.
      expect(surfaced, mode).toEqual([]);
    }

    for (const mode of ['plan'] as const) {
      const { agent, surfaced } = cell(mode, true);
      void ask(agent, RULE_ALLOWED);
      await Promise.resolve();
      expect(surfaced, mode).toHaveLength(1);
    }
  });

  /**
   * UNATTENDED — P6.713's first arm, and the flipped row. The rule consult now
   * runs above the headless block, so the SAME rule that answers with a human
   * present answers with nobody present: the attended test above and this one
   * agree mode for mode, which is the property the row asked for.
   *
   * `explore` and `plan` still decline, and that is not the old defect
   * surviving: their read-only allowlist suppresses the ALLOW inside the consult
   * (the attended run shows a card there instead of an accept), so unattended
   * they legitimately reach the fallback with no rule answer to carry.
   */
  it('with nobody to ask, the SAME rule-allowed call is honoured wherever the mode lets the rule answer', async () => {
    const answers: Record<string, unknown> = {};
    for (const mode of MODES) {
      const { agent } = cell(mode, false);
      answers[mode] = await ask(agent, RULE_ALLOWED);
    }

    expect(answers).toEqual({
      dontAsk: { decision: 'accept' },
      default: { decision: 'accept' },
      acceptEdits: { decision: 'accept' },
      auto: { decision: 'accept' },
      bypassPermissions: { decision: 'accept' },
      // The read-only allowlist refuses the rule its ALLOW, so nothing answered
      // and the shipped `unattendedApprovalFallback` default (`deny`, P6.531)
      // decides — the same two cells that show a CARD when attended.
      plan: { decision: 'decline' },
    });
  });

  /**
   * UNATTENDED — P6.713's second arm. A `deny:` rule refuses on its own, in
   * every mode, and the operator escape hatch does NOT override it: the hatch
   * answers what no rule covered, which is the whole of what it is for. Before
   * P6.713 the hatch approved this call without the rule ever being read.
   */
  it('with nobody to ask, a deny rule refuses even with the escape hatch open', async () => {
    const denied = { deny: [`Bash(${RULE_ALLOWED})`] };
    for (const mode of MODES) {
      const { agent } = cell(mode, false, denied);
      expect(await ask(agent, RULE_ALLOWED), mode).toEqual({ decision: 'decline' });
    }

    process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR] = 'allow';
    try {
      for (const mode of MODES) {
        const { agent } = cell(mode, false, denied);
        expect(await ask(agent, RULE_ALLOWED), `${mode} with the hatch open`)
          .toEqual({ decision: 'decline' });
      }
    } finally {
      delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR];
    }
  });

  /**
   * The operator escape hatch, and P6.713's CONTROL: it still answers, and it
   * still answers only for a call NO rule covers. That is what separates "the
   * fallback decides what the rules left open" (now) from "the fallback decides
   * instead of the rules" (before) — the arm above shows the same six modes
   * refusing a rule-DENIED call with this same hatch open.
   */
  it('the escape hatch still answers the six for a call no rule covers', async () => {
    process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR] = 'allow';
    try {
      for (const mode of MODES.filter(m => m !== 'dontAsk')) {
        const { agent } = cell(mode, false);
        // A command NO rule covers is approved — only possible if the fallback
        // answered, since the rule layer has nothing to say about it.
        expect(await ask(agent, UNCOVERED), mode).toEqual({ decision: 'accept' });
      }
      // dontAsk still refuses it: it never borrows the fallback's answer, and no
      // rule pre-approves this command.
      const { agent } = cell('dontAsk', false);
      expect(await ask(agent, UNCOVERED)).toEqual({ decision: 'decline' });
    } finally {
      delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR];
    }
  });

  /**
   * The NEGATIVE CONTROL for the matrix as a whole: an uncovered call at the
   * shipped default is refused everywhere, attended or not — so no row above is
   * explained by "this session approves everything" or "this session refuses
   * everything".
   *
   * Attended is the interesting half: there the call is SHOWN rather than
   * answered, so the promise is left pending on purpose and what is asserted is
   * the card.
   */
  it('an uncovered call is shown when attended and refused when not', async () => {
    const { agent: attendedAgent, surfaced } = cell('default', true);
    void ask(attendedAgent, UNCOVERED);
    await Promise.resolve();
    expect(surfaced).toHaveLength(1);

    const { agent: unattendedAgent } = cell('default', false);
    expect(await ask(unattendedAgent, UNCOVERED)).toEqual({ decision: 'decline' });
  });
});
