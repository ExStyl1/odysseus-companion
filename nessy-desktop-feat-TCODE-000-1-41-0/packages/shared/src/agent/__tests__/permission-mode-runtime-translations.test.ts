/**
 * R5 — one mode vocabulary, three honest translations.
 *
 * ## The decision this suite guards
 *
 * The user sees ONE set of permission modes on every runtime (owner decision
 * 2026-08-16). A per-runtime vocabulary was rejected because a mode states user
 * INTENT — "ask me first", "go ahead" — which does not depend on which runtime
 * is underneath it, and because changing the words under a user who switches
 * runtime mid-session exports exactly the friction the plan says we absorb.
 *
 * So there are three translations, and each has ONE place:
 *
 * | runtime | the place | the shape |
 * | --- | --- | --- |
 * | Pi | `core/pre-tool-use.ts` | identity — the vocabulary IS Pi's; the gate is the translation |
 * | Claude | `claude-permission-mode.ts` | `CLAUDE_SDK_PERMISSION_MODE_TABLE` plus the same gate as a PreToolUse hook |
 * | Codex | `codex-responses-adapter/config-writer.ts` | `CODEX_PERMISSION_MODE_TABLE`, two knobs, plus our approval answer |
 *
 * This file is the cross-runtime half: one row per mode covering all three, the
 * no-widening invariant per runtime, the duplicate-table drift checks, and the
 * measured record of where a runtime cannot express a mode. The Claude column's
 * own detail (the SDK union read from the installed typings, the REFUTED plan
 * route, Safe Mode end-to-end) lives in `claude-permission-mode.test.ts` and is
 * deliberately not repeated here.
 *
 * ## What this suite can and cannot prove
 *
 * Neither the `claude` native binary nor the `codex-app-server` binary runs
 * here, so what is proven is that the OPTION each runtime is handed is the one
 * its table says, that the tables cannot silently widen, and that the two
 * hand-copied duplicates in the codex leaf still agree with the shared
 * originals they name. What each runtime then does with that option belongs to
 * a live case.
 */
import { afterAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { PERMISSIONS_METHOD } from '@nessy-agent/codex-agent-server';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CODEX_MODES_KEEPING_ON_REQUEST_UNBOUNDED,
  CODEX_PERMISSION_MODE_ORDER,
  CODEX_PERMISSION_MODE_TABLE,
  buildCodexConfigToml,
  clampCodexPermissionMode,
  codexSandboxConfigForMode,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
} from '@nessy-agent/codex-responses-adapter/config-writer';
import {
  CLAUDE_SDK_PERMISSION_MODE_ORDER,
  CLAUDE_SDK_PERMISSION_MODE_TABLE,
  toClaudeSdkPermissionMode,
  type ClaudeSdkPermissionMode,
} from '../claude-permission-mode.ts';
import {
  PERMISSION_MODE_ORDER,
  clampPermissionModeToParent,
  type PermissionMode,
} from '../mode-types.ts';
import { cleanupModeState, initializeModeState, shouldAllowToolInMode } from '../mode-manager.ts';
import { runPreToolUseChecks, type PermissionManagerLike } from '../core/pre-tool-use.ts';
import { parsePermissionsJson, permissionsConfigCache } from '../permissions-config.ts';
import { UNATTENDED_APPROVAL_FALLBACK_ENV_VAR } from '../../config/unattended-approval.ts';
import { CodexAgent } from '../codex-agent.ts';

// P2.254: `shouldAllowToolInMode('Bash', …)` reaches `getDeniedPathViolation` ->
// `extractPowerShellWriteTarget`, which spawns `powershell-parser.ps1` once per
// call on a host with a real PowerShell (P2.241 owns the ungated spawn itself).
// One spawn is 0.69-0.88s idle, and the four-modes case below makes several, so
// bun's 5s default sits BELOW this file's resting cost — measured as an 8.7s
// "timed out after 5000ms" on `Bash: the four modes get the identical answer`.
// Until this defect was fixed those calls never spawned: the validator THREW.
// Same value and reason as `packages/shared/tests/mode-manager.test.ts`.
setDefaultTimeout(30_000);

// ===========================================================================
// The Pi harness. Same shape as `claude-permission-mode.test.ts`'s, and for the
// same reason: the read-only allowlist is the one the product ships rather than
// two patterns invented here.
// ===========================================================================

const shippedReadOnlyDefaults = parsePermissionsJson(
  readFileSync(
    new URL('../../../../../apps/electron/resources/permissions/default.json', import.meta.url),
    'utf8',
  ),
);

/**
 * A REAL directory, not a made-up path. `isPathWithinDirectory` resolves the
 * nearest existing ancestor with `realpathSync` before deciding containment —
 * the anti-symlink-escape rule — so a plans folder that does not exist on disk
 * can never contain anything, and a test that used one would report "explore
 * refuses a plans write" while measuring the missing directory.
 */
const WORKSPACE_ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-r5-')));
const PLANS_FOLDER = join(WORKSPACE_ROOT, 'plans');
mkdirSync(PLANS_FOLDER, { recursive: true });
afterAll(() => rmSync(WORKSPACE_ROOT, { recursive: true, force: true }));

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
  getCapabilityPermissionsContext: () => ({
    workspaceRootPath: WORKSPACE_ROOT,
    pinnedRevision: 'r5',
    pinnedConfigs: [{ config: shippedReadOnlyDefaults, scope: 'workspace' }],
  }),
};

let gateSequence = 0;

/** The Pi translation: the mode goes in, the gate's decision comes out. */
function piDecision(
  toolName: string,
  input: Record<string, unknown>,
  mode: PermissionMode,
  extra?: { plansFolderPath?: string },
): string {
  gateSequence += 1;
  const sessionKey = { workspaceId: 'r5', sessionId: `r5-${gateSequence}` };
  initializeModeState(sessionKey, mode);
  try {
    return runPreToolUseChecks({
      toolName,
      input,
      sessionId: sessionKey.sessionId,
      sessionKey,
      permissionMode: mode,
      workspaceRootPath: WORKSPACE_ROOT,
      permissionManager,
      ...extra,
    } as never).type;
  } finally {
    cleanupModeState(sessionKey);
  }
}

/** A write inside the workspace — the probe every mode has an opinion about. */
const WRITE_PROBE = ['Write', { file_path: `${WORKSPACE_ROOT}/probe.ts`, content: 'x' }] as const;

// ===========================================================================
// One row per mode, all three runtimes.
// ===========================================================================

interface RuntimeRow {
  /** Pi: the decision the gate reaches for a workspace write. */
  pi: string;
  /**
   * Claude: the SDK `permissionMode` we hand the query. Typed against the SDK's
   * own union, so a vendor rename breaks compilation here rather than shipping
   * an option the runtime rejects.
   */
  claude: ClaudeSdkPermissionMode;
  /** Codex: the two knobs written into `config.toml`, master switch on. */
  codex: { sandbox_mode: CodexSandboxMode; approval_policy: CodexApprovalPolicy };
}

/**
 * The whole vocabulary, translated. Written out per mode rather than derived,
 * because a derived expectation restates the implementation and cannot catch it
 * being wrong.
 */
const TRANSLATIONS: Record<PermissionMode, RuntimeRow> = {
  dontAsk: {
    pi: 'block',
    claude: 'dontAsk',
    codex: { sandbox_mode: 'read-only', approval_policy: 'never' },
  },
  plan: {
    pi: 'block',
    claude: 'default',
    codex: { sandbox_mode: 'read-only', approval_policy: 'on-request' },
  },
  default: {
    pi: 'prompt',
    claude: 'default',
    codex: { sandbox_mode: 'workspace-write', approval_policy: 'on-request' },
  },
  acceptEdits: {
    pi: 'allow',
    claude: 'acceptEdits',
    codex: { sandbox_mode: 'workspace-write', approval_policy: 'on-request' },
  },
  auto: {
    pi: 'allow',
    claude: 'auto',
    codex: { sandbox_mode: 'workspace-write', approval_policy: 'on-request' },
  },
  bypassPermissions: {
    pi: 'allow',
    claude: 'bypassPermissions',
    codex: { sandbox_mode: 'workspace-write', approval_policy: 'on-request' },
  },
};

describe('R5 — every mode, on every runtime, has an asserted translation', () => {
  it.each(PERMISSION_MODE_ORDER)('%s translates on all three runtimes', mode => {
    const expected = TRANSLATIONS[mode];
    expect(piDecision(WRITE_PROBE[0], { ...WRITE_PROBE[1] }, mode)).toBe(expected.pi);
    expect(toClaudeSdkPermissionMode(mode)).toBe(expected.claude);
    expect(codexSandboxConfigForMode(mode)).toEqual(expected.codex);
  });

  it('all three tables key off the ONE vocabulary — no mode falls off any of them', () => {
    const vocabulary = [...PERMISSION_MODE_ORDER].sort();
    expect(Object.keys(TRANSLATIONS).sort()).toEqual(vocabulary);
    expect(Object.keys(CLAUDE_SDK_PERMISSION_MODE_TABLE).sort()).toEqual(vocabulary);
    expect(Object.keys(CODEX_PERMISSION_MODE_TABLE).sort()).toEqual(vocabulary);
  });
});

// ===========================================================================
// The duplicated codex leaf. `config-writer.ts` re-declares the mode union, the
// strictness order and the clamp so the adapter stays dep-free — and until R5
// exported them, nothing compared any of the three against the originals they
// name. A reorder there is a silent widening with no type error, which is what
// the file's own comment has always said.
// ===========================================================================

describe('R5 — the codex duplicates still agree with the shared originals', () => {
  it('CODEX_PERMISSION_MODE_ORDER is PERMISSION_MODE_ORDER, element for element', () => {
    // Element-for-element, not set equality: the POSITIONS are the clamp's
    // index, so two swapped entries are the defect and a sorted compare misses
    // it entirely.
    expect([...CODEX_PERMISSION_MODE_ORDER]).toEqual([...PERMISSION_MODE_ORDER]);
  });

  it('clampCodexPermissionMode answers exactly as clampPermissionModeToParent, all 36 pairs', () => {
    for (const requested of PERMISSION_MODE_ORDER) {
      for (const parent of PERMISSION_MODE_ORDER) {
        expect(clampCodexPermissionMode(requested, parent))
          .toBe(clampPermissionModeToParent(requested, parent));
      }
    }
  });

  it('THE NEGATIVE CONTROL — the pair check catches the drift it exists for', () => {
    // F1.1050 (DN-272) replaced this control. It pinned the plan-parent /
    // explore-child special case (the one pair a pure rank compare got wrong);
    // with `explore` retired every pair is totally ordered and both clamps are
    // the rank compare alone. The drift the pair check still exists for is a
    // REORDERED duplicate: swap two neighbours in a copy of the order and the
    // 36-pair comparison above must disagree somewhere.
    const swapped: PermissionMode[] = ['dontAsk', 'default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions'];
    const clampBy = (order: PermissionMode[]) => (requested: PermissionMode, parent: PermissionMode) =>
      order.indexOf(requested) <= order.indexOf(parent) ? requested : parent;
    expect(clampBy(swapped)('default', 'plan')).toBe('default');
    expect(clampPermissionModeToParent('default', 'plan')).toBe('plan');
    expect(clampCodexPermissionMode('default', 'plan')).toBe('plan');
    // And the retired mode left both orders: six entries, no `explore`.
    expect(PERMISSION_MODE_ORDER).toEqual(['dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions']);
  });
});

// ===========================================================================
// No mode silently widens, per runtime.
// ===========================================================================

/**
 * Codex permissiveness, ranked jointly rather than per knob, because the two
 * knobs are not independent — and the direction of the dependency FLIPS with
 * the sandbox, which is the whole reason this helper is not two lookups.
 *
 * Under a bounding sandbox (`read-only`, `workspace-write`), `never` is the
 * STRICTER policy: it removes the escalation channel, and an escalation channel
 * can only ADD capability, since a human may approve more than the sandbox
 * allows by itself.
 *
 * Under `danger-full-access` there is nothing left to escalate PAST, and the
 * relationship inverts: `on-request` still routes the call to a human (and, via
 * `CodexAgent.handleServerRequest`, to R6's rule-aware answer), while `never`
 * means codex raises no approval request at all — so nothing whatsoever stands
 * between the model and the machine. `never` is then the LOOSEST value, not the
 * strictest.
 *
 * `config-writer.ts`'s own comment states the same dependency in the production
 * file ("`never` is only safe because `read-only` bounds it"). Ranking it
 * unconditionally is what let the invariant below pass over the one real
 * widening in the surface; R13 fixed the widening, and `R5-KNOWN-WIDENING`
 * below now asserts its ABSENCE.
 *
 * `untrusted` used to be ranked for `danger-full-access` only, because that was
 * the only place R13 emitted it, and the release schema's own `AskForApproval`
 * descriptions ordered the three there without a guess. It is GONE from the
 * ranking, and not because the ranking changed its mind: upstream #39630 retired
 * the value from the public config at `rust-v0.150.1`, the shipped binary now
 * exits 1 rather than start a session that names it, and `CodexApprovalPolicy`
 * no longer admits it — so a branch for it would not compile.
 *
 * What survives is the ordering rule and the two values it still ranks. With no
 * sandbox, more asking is strictly less capability reaching the machine
 * unanswered, so on-request < never. Under a bounding sandbox the channel is the
 * sandbox itself, so never=0 < on-request=1. `granular` still throws everywhere,
 * because ranking it WOULD be a guess — codex's own decision table makes it
 * identical to `on-request` for an unmatched command and different for a matched
 * one, and this suite ranks configurations rather than commands.
 */
const CODEX_SANDBOX_RANK: Record<CodexSandboxMode, number> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
};

function codexEscalationRank(
  approvalPolicy: CodexApprovalPolicy,
  sandboxMode: CodexSandboxMode,
): number {
  const unbounded = sandboxMode === 'danger-full-access';
  // Bounded: never=0 (no escalation channel) < on-request=1.
  // Unbounded: on-request=1 < never=2 (nothing asks at all).
  if (approvalPolicy === 'never') return unbounded ? 2 : 0;
  if (approvalPolicy === 'on-request') return 1;
  throw new Error(`codex approval_policy "${approvalPolicy}" has no ranked meaning here`);
}

function codexRank(mode: PermissionMode, sandboxGloballyEnabled: boolean): number {
  const { sandbox_mode, approval_policy } = codexSandboxConfigForMode(mode, sandboxGloballyEnabled);
  return CODEX_SANDBOX_RANK[sandbox_mode] * 10 + codexEscalationRank(approval_policy, sandbox_mode);
}

describe('R5 — THE NO-WIDENING INVARIANT, on each runtime', () => {
  it('codex: a stricter mode never gets a looser config — every pair, both switch positions', () => {
    // R13 removed the one exclusion this loop used to carry (`dontAsk` with the
    // master switch OFF). It now runs over all 15 pairs (21 before F1.1050) in both positions with
    // nothing skipped, which is the assertion the row was closed on.
    for (const sandboxGloballyEnabled of [true, false]) {
      for (let i = 0; i < PERMISSION_MODE_ORDER.length; i += 1) {
        for (let j = i + 1; j < PERMISSION_MODE_ORDER.length; j += 1) {
          const stricter = codexRank(PERMISSION_MODE_ORDER[i]!, sandboxGloballyEnabled);
          const looser = codexRank(PERMISSION_MODE_ORDER[j]!, sandboxGloballyEnabled);
          expect(stricter).toBeLessThanOrEqual(looser);
        }
      }
    }
  });

  /**
   * R5-KNOWN-WIDENING — kept under its original name, inverted by R13.
   *
   * ## What it used to assert, and why the name survives
   *
   * R5 wrote this as a CHARACTERIZATION test: it asserted the defect as it
   * existed, so the widening was measured and visible instead of hidden behind a
   * rank that could not see it, and so that fixing it would turn the test red
   * and force the record to be rewritten rather than quietly diverging. That is
   * what happened, and this is the rewrite.
   *
   * The defect it characterized: `SANDBOX_ENABLED_DEFAULT` is `false` (standing
   * owner decision 2026-08-12/13), and with the switch off
   * `codexSandboxConfigForMode` lifted the sandbox to `danger-full-access` while
   * carrying `approval_policy` through unchanged. For `dontAsk` that policy was
   * `never`, producing the only mode on any runtime with NO sandbox and NO
   * approval channel: codex raised no request, so
   * `CodexAgent.handleServerRequest` never fired and R6's rule-aware answer
   * never ran. `dontAsk` means "never prompt; run what the rules pre-approve,
   * deny the rest" on Pi and Claude; on codex it meant allow-everything, while
   * `mode.dontAskFullDesc` told the user it "denies everything else".
   *
   * ## What it asserts now
   *
   * That the widening is gone: with the switch off, `dontAsk` no longer emits
   * `never`, so it cannot rank looser than every other mode. The old
   * before-state is written out as a value and asserted to be what the function
   * no longer returns — a defect that can only come back by turning this red.
   *
   * The VALUE it emits instead moved at `rust-v0.150.1` (P7.2): R13 chose
   * `untrusted` because it was the one policy that routed an ordinary command to
   * us, and upstream #39630 retired it — fatally, the binary exits 1 rather than
   * start. Read from `core/src/exec_policy.rs` at that tag, no remaining public
   * value routes an unmatched command under an unrestricted sandbox, so what
   * this case can still assert is the ABSENCE of the widening and not the
   * presence of a channel. The channel's loss is reported to the operator
   * instead (`CODEX_UNBOUNDED_APPROVAL_NOTICE`) and filed as a posture row.
   */
  it('R5-KNOWN-WIDENING, FIXED (R13): dontAsk on codex is never LOOSER, and since P6.61 it TIES every mode with the switch off', () => {
    const BEFORE_R13 = { sandbox_mode: 'danger-full-access', approval_policy: 'never' } as const;
    const dontAsk = codexSandboxConfigForMode('dontAsk', false);
    expect(dontAsk).not.toEqual(BEFORE_R13);
    expect(dontAsk).toEqual({ sandbox_mode: 'danger-full-access', approval_policy: 'on-request' });

    // The property that matters is not the literal: it is that NO mode is left
    // without an approval channel once the sandbox is gone. `never` is the
    // absence of that channel, so no mode may emit it here.
    for (const mode of PERMISSION_MODE_ORDER) {
      expect(codexSandboxConfigForMode(mode, false).approval_policy).not.toBe('never');
    }

    // Stated as the rank sees it, in both directions. Switch OFF: the strictest
    // mode in the vocabulary scores stricter than or EQUAL TO every other mode,
    // where it used to score looser than all six.
    //
    // P2.197 (2026-09-03) turned five of those six strict inequalities into
    // equalities, deliberately: an unbounded `on-request` was measured to send
    // no approval request at all, so it degraded to whatever R13 gave `dontAsk`.
    // Since P7.2 that is `on-request` for every mode, so the equality is now
    // total. The one direction this assertion must still forbid is unchanged —
    // `dontAsk` may never be LOOSER — and it is the loop below.
    const unboundedRank = codexRank('dontAsk', false);
    for (const mode of PERMISSION_MODE_ORDER) {
      if (mode === 'dontAsk') continue;
      expect(unboundedRank).toBeLessThanOrEqual(codexRank(mode, false));
    }

    // P6.61 (`45b47c723`) took the SIXTH inequality with it. `bypassPermissions`
    // was `CODEX_MODES_KEEPING_ON_REQUEST_UNBOUNDED`'s last and only member —
    // excluded because an unbounded `on-request` was the only way it could keep
    // its "nothing prompts" promise. It no longer needs to buy that promise from
    // the config file: `codex-agent.ts` answers the mode YES itself, after the
    // rule consult and after every non-negotiable floor has had its chance, so
    // the mode keeps its sentence AND its floors run. With the set empty, NO
    // codex mode keeps `on-request` unbounded and `dontAsk` ties all six others
    // rather than being strictly stricter than one of them.
    //
    // Both halves are asserted, because either alone can pass for the wrong
    // reason: the tie is the behaviour, the empty set is the cause, and a mode
    // rejoining that set has to turn this red rather than quietly restoring an
    // unbounded policy.
    expect(unboundedRank).toBe(codexRank('bypassPermissions', false));
    expect([...CODEX_MODES_KEEPING_ON_REQUEST_UNBOUNDED]).toEqual([]);

    // What separates `dontAsk` from the five it now shares a config with is no
    // longer the approval policy: it is the OTHER half of the mode's contract,
    // `CodexAgent.handleServerRequest` denying what no permission rule
    // pre-approves. Asserted here so the equality above cannot be read as the
    // mode losing its meaning.
    expect(codexSandboxConfigForMode('dontAsk', false)).toEqual(
      codexSandboxConfigForMode('default', false),
    );

    // Switch ON is untouched by R13 — the pair is coherent there and always was,
    // and this is the control proving the fix is scoped to the switch-off path
    // rather than a rewrite of the table. The adapter's own pre-T1 pin
    // (`config-writer.test.ts`, "byte-identical to the pre-T1 mapping") covers
    // the same ground over all seven modes.
    expect(codexSandboxConfigForMode('dontAsk', true)).toEqual({
      sandbox_mode: 'read-only',
      approval_policy: 'never',
    });
    const boundedRank = codexRank('dontAsk', true);
    for (const mode of PERMISSION_MODE_ORDER) {
      if (mode === 'dontAsk') continue;
      expect(boundedRank).toBeLessThan(codexRank(mode, true));
    }
  });

  it('THE NEGATIVE CONTROL — the codex invariant catches the widening it exists for', () => {
    // The mistake: a mode getting a config looser than a LESS strict mode's —
    // here `plan` (index 1) handed danger-full-access with nothing asking while
    // `default` (index 2) keeps workspace-write with its ask: F1.1050 moved this control from the
    // retired `explore` onto `plan`, the mode that now sits below `default`.
    // Written out so the assertion above is known to be able to fail.
    //
    // The limit of an order-based invariant, stated rather than left implied:
    // it catches INVERSIONS against `PERMISSION_MODE_ORDER`, not a row that is
    // looser than its own meaning at a position the order still permits.
    // Widening `plan` to `workspace-write` is caught by the per-mode row and by
    // the equivalence classes below — measured 2026-08-16, three tests red.
    const widened: Record<PermissionMode, { sandbox_mode: CodexSandboxMode; approval_policy: CodexApprovalPolicy }> = {
      ...CODEX_PERMISSION_MODE_TABLE,
      plan: { sandbox_mode: 'danger-full-access', approval_policy: 'never' },
    };
    const rank = (mode: PermissionMode) =>
      CODEX_SANDBOX_RANK[widened[mode].sandbox_mode] * 10 +
      codexEscalationRank(widened[mode].approval_policy, widened[mode].sandbox_mode);
    expect(rank('plan')).toBeGreaterThan(rank('default'));
  });

  it('codex emits only approval policies this ranking covers, in the position it covers them', () => {
    for (const mode of PERMISSION_MODE_ORDER) {
      for (const sandboxGloballyEnabled of [true, false]) {
        const { approval_policy, sandbox_mode } = codexSandboxConfigForMode(mode, sandboxGloballyEnabled);
        // `codexEscalationRank` throws on any (policy, sandbox) combination it
        // has no measured meaning for — `granular` anywhere, and `untrusted`
        // under a bounding sandbox — so reaching a number IS the assertion that
        // the emitted pair is one this ranking knows how to weigh.
        expect(typeof codexEscalationRank(approval_policy, sandbox_mode)).toBe('number');
      }
    }
  });

  it('pi: the gate never gets looser as the mode gets stricter', () => {
    // Pi's translation is identity, so the invariant is about the gate itself:
    // block < prompt < allow along `PERMISSION_MODE_ORDER`, which is the same
    // least-to-most-permissive index `clampPermissionModeToParent` uses.
    const rank: Record<string, number> = { block: 0, deny: 0, prompt: 1, modify: 2, allow: 2 };
    const decisions = PERMISSION_MODE_ORDER.map(mode => {
      const decision = piDecision(WRITE_PROBE[0], { ...WRITE_PROBE[1] }, mode);
      const value = rank[decision];
      if (value === undefined) throw new Error(`unranked gate decision "${decision}"`);
      return value;
    });
    for (let i = 1; i < decisions.length; i += 1) {
      expect(decisions[i]!).toBeGreaterThanOrEqual(decisions[i - 1]!);
    }
  });

  it('claude: asserted in claude-permission-mode.test.ts against the SDK\'s own union', () => {
    // Not repeated here — that suite reads `PermissionMode` out of the installed
    // `sdk.d.ts` at run time so a vendor rename fails by name. What belongs in
    // the cross-runtime file is that the order it ranks against still exists and
    // still covers every mode the table emits.
    for (const mode of PERMISSION_MODE_ORDER) {
      expect(CLAUDE_SDK_PERMISSION_MODE_ORDER).toContain(toClaudeSdkPermissionMode(mode));
    }
  });
});

// ===========================================================================
// Where codex cannot express a mode. Measured, and recorded rather than
// approximated — the plan's own instruction for this case.
// ===========================================================================

/** The modes that share a codex config with at least one other mode. */
function codexEquivalenceClasses(sandboxGloballyEnabled: boolean): PermissionMode[][] {
  const byConfig = new Map<string, PermissionMode[]>();
  for (const mode of PERMISSION_MODE_ORDER) {
    const key = JSON.stringify(codexSandboxConfigForMode(mode, sandboxGloballyEnabled));
    byConfig.set(key, [...(byConfig.get(key) ?? []), mode]);
  }
  return [...byConfig.values()];
}

const COLLAPSING_FOUR: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'bypassPermissions'];

describe('R5 — the codex collapse, measured', () => {
  it('master switch ON: three configs for six modes, and the classes are these', () => {
    expect(codexEquivalenceClasses(true)).toEqual([
      ['dontAsk'],
      ['plan'],
      ['default', 'acceptEdits', 'auto', 'bypassPermissions'],
    ]);
  });

  it('master switch OFF (the shipped default): ONE config for six modes since P6.61, the difference having moved into the host', () => {
    // Owner decision 2026-08-12 — `deviation:
    // codex-danger-full-access-when-sandbox-off`. Every mode's sandbox goes, and
    // the approval policy is the only thing left separating the classes.
    //
    // It was two classes, then two DIFFERENT classes (P2.197, 2026-09-03), and
    // since P6.61 (`45b47c723`) it is ONE. Driving the shipped binary measured
    // that an unbounded `on-request` sends no approval request at all — the same
    // "no sandbox and no approval channel" R13 fixed for `never` — so it
    // degrades to the same value `never` does. P2.197 excluded
    // `bypassPermissions` from that
    // degradation because the unbounded policy was the only way that mode could
    // keep its "nothing prompts" sentence; P6.61 gave it a better one, an answer
    // from `codex-agent.ts` issued after the rule consult and after every
    // non-negotiable floor, so the exclusion became unnecessary and
    // `CODEX_MODES_KEEPING_ON_REQUEST_UNBOUNDED` is empty.
    //
    // **So the collapse this suite measures is now TOTAL with the switch off,
    // and that is not the loss it looks like.** The config file no longer
    // separates the seven modes; the separation moved to the host, where it is
    // observable and where the floors run. Read this expectation together with
    // `codex-permission-floors.test.ts` — the file P6.61 added — which is what
    // pins the difference that used to live in this line.
    expect(codexEquivalenceClasses(false)).toEqual([
      ['dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'],
    ]);
  });

  it('the two classes fail in OPPOSITE directions, and that is the whole point', () => {
    // `plan` sits on the STRICTER end: read-only, which is what `plan` means —
    // but it grants a scoped write on Pi that read-only cannot express: its own
    // `.md` plan file in the plans folder (F1.725, `627363f22`: plan mode
    // "writes a plan, but does not edit your source") and, since F1.1050 folded
    // the retired `explore` into it, the session data folder. F1.1050 (DN-272)
    // deleted this test's explore arms (explore's whole-plans-folder write left
    // with it). Losing a capability is the safe direction, and it is still a loss.
    const plansFolderPath = PLANS_FOLDER;
    const planFile = { file_path: join(plansFolderPath, 'p.md'), content: 'x' };
    expect(piDecision('Write', planFile, 'plan', { plansFolderPath })).toBe('allow');
    // The negative arms: plan's grant is the plan FILE, not the folder and not
    // the workspace. A non-`.md` file in the same folder and a source file in
    // the workspace both still block in plan.
    const nonPlanFile = { file_path: join(plansFolderPath, 'p.ts'), content: 'x' };
    expect(piDecision('Write', nonPlanFile, 'plan', { plansFolderPath })).toBe('block');
    expect(piDecision(WRITE_PROBE[0], { ...WRITE_PROBE[1] }, 'plan', { plansFolderPath })).toBe('block');
    expect(codexSandboxConfigForMode('plan').sandbox_mode).toBe('read-only');

    // The four collapse onto the LOOSER end: `workspace-write` lets codex write
    // inside the workspace with no approval at all, so `default` — "ask me
    // first" — writes without asking, while Pi prompts for the same call.
    expect(codexSandboxConfigForMode('default').sandbox_mode).toBe('workspace-write');
    expect(codexSandboxConfigForMode('bypassPermissions').sandbox_mode).toBe('workspace-write');
    expect(piDecision(WRITE_PROBE[0], { ...WRITE_PROBE[1] }, 'default')).toBe('prompt');
    expect(piDecision(WRITE_PROBE[0], { ...WRITE_PROBE[1] }, 'bypassPermissions')).toBe('allow');
  });

  it('THE NEGATIVE CONTROL — remove the translation and all six collapse to one config', () => {
    // `buildCodexConfigToml` derives the two knobs from `mode`. Drop that one
    // field on the way in — the translation removed, everything else identical —
    // and the seven modes produce one file instead of three, which is what "the
    // translation is doing nothing" looks like. Without this the classes above
    // could be measuring the builder rather than the table.
    const base = { codexHome: '/tmp/x', model: 'm', adapterPort: 1 } as const;
    const withoutTranslation = new Set(
      PERMISSION_MODE_ORDER.map(mode => {
        const { mode: _removed, ...untranslated } = { ...base, mode };
        return buildCodexConfigToml(untranslated);
      }),
    );
    expect(withoutTranslation.size).toBe(1);
    expect([...withoutTranslation][0]).toContain('sandbox_mode = "workspace-write"');
    expect([...withoutTranslation][0]).toContain('approval_policy = "on-request"');

    const withTranslation = new Set(
      PERMISSION_MODE_ORDER.map(mode => buildCodexConfigToml({ ...base, mode })),
    );
    expect(withTranslation.size).toBe(3);
  });
});

// ===========================================================================
// The claim R5 was written to assert — and the measurement that refutes it.
// ===========================================================================

describe('R5 — REFUTED: our answer does not distinguish the four either', () => {
  /**
   * The premise this row was written on: the four modes share a codex config
   * because "on Codex the difference is carried by OUR answer to its approval
   * requests, not by its configuration".
   *
   * The codex answer path is `CodexAgent.handleServerRequest`: an approval
   * arrives, `consultPermissionRules` may answer it from the user's rules, and
   * anything else becomes a card for a human.
   *
   * MEASURED 2026-08-16, and the bound of each check is stated because a
   * bounded search proves nothing outside its bound:
   *
   * - `grep -a -c runPreToolUseChecks packages/shared/src/agent/codex-agent.ts`
   *   → 0. The shared gate, which is what distinguishes these four modes on Pi
   *   and (through R1's hook) on Claude, is not on the codex path at all.
   * - `grep -a -c getPermissionMode packages/shared/src/agent/codex-agent.ts`
   *   → 7, of which `grep -a -c 'this.getPermissionMode()'` → 5 are calls: three
   *   feed `buildCodexConfigToml` / `buildCodexRuntimeConfigOverride` (the
   *   CONFIG column, asserted above), one is the setter, and one is the
   *   `shouldAllowToolInMode` call inside `consultPermissionRules`. The two
   *   remaining hits are the `getPermissionModeDiagnostics` import and its
   *   debug-log call, neither of which decides anything. So that one call is the
   *   only mode-sensitive step in our answer. (Both counts are written out
   *   because the earlier note recorded "five hits" for a command that returns
   *   seven — a bound that does not reproduce is how a record starts being
   *   distrusted wholesale.)
   * - `grep -a respondToPermission` over `packages/server-core/src` and
   *   `packages/shared/src/sessions` → no production site answers a card by
   *   mode; the card is raised and answered identically in every mode.
   *
   * So if the four modes are distinguished by our answer at all, they are
   * distinguished by `shouldAllowToolInMode`.
   *
   * They are not. This is the tripwire: the day someone makes them differ, this
   * goes red and the record above has to be rewritten rather than quietly
   * drifting. The fix belongs on the answer path (`codex-agent.ts`), which is
   * outside R5's zone.
   */
  const PROBES: Array<[string, Record<string, unknown>]> = [
    ['Bash', { command: 'rm -rf /tmp/r5-probe' }],
    ['Bash', { command: 'ls -la' }],
    ['Edit', { file_path: `${WORKSPACE_ROOT}/a.ts` }],
    ['Write', { file_path: `${WORKSPACE_ROOT}/b.ts` }],
    ['WebFetch', { url: 'https://example.test' }],
  ];

  it.each(PROBES)('%s: the four modes get the identical answer', (toolName, input) => {
    const answers = new Set(
      COLLAPSING_FOUR.map(mode => JSON.stringify(shouldAllowToolInMode(toolName, input, mode))),
    );
    expect(answers.size).toBe(1);
  });

  it('THE POSITIVE CONTROL — the same probe DOES separate a mode outside the four', () => {
    // Without this, "all four answers are equal" could just mean the probe
    // cannot see a difference at all.
    const four = JSON.stringify(shouldAllowToolInMode('Write', { file_path: `${WORKSPACE_ROOT}/b.ts` }, 'default'));
    const outside = JSON.stringify(shouldAllowToolInMode('Write', { file_path: `${WORKSPACE_ROOT}/b.ts` }, 'plan'));
    expect(outside).not.toBe(four);
  });

  it('and Pi, on the same vocabulary, separates all four', () => {
    // The gap is codex's, not the vocabulary's: the same four modes reach three
    // distinct decisions on Pi (`bypassPermissions` and `acceptEdits` both
    // allow this write, which is what those two modes mean), so there IS a
    // difference for a runtime to carry.
    const decisions = COLLAPSING_FOUR.map(mode => piDecision(WRITE_PROBE[0], { ...WRITE_PROBE[1] }, mode));
    expect(new Set(decisions).size).toBeGreaterThan(1);
    expect(decisions[0]).toBe('prompt');
  });
});

// ===========================================================================
// R13 — the OTHER half of the codex translation: our answer.
//
// The table above is only one knob-pair; this file's own header calls the codex
// translation "`CODEX_PERMISSION_MODE_TABLE`, two knobs, PLUS our approval
// answer", and `dontAsk` is the mode where the answer carries the whole
// meaning. The config change alone cannot deliver the mode: it only decides
// whether codex asks us. What the mode MEANS is what we reply.
// ===========================================================================

/**
 * One codex agent whose permission rules are exactly `rules` and whose mode is
 * set EXPLICITLY.
 *
 * Both halves of that sentence are load-bearing. Permission mode is stored per
 * SESSION KEY, and R6's own suite leaked state between cases because every agent
 * in the file shared one key — so each agent here gets a fresh session id AND
 * says its mode out loud, and neither alone is treated as sufficient.
 */
let codexAgentSequence = 0;
function codexAgentInMode(mode: PermissionMode, rules: Record<string, string[]> | null) {
  codexAgentSequence += 1;
  const workspaceRootPath = WORKSPACE_ROOT;
  const agent = new CodexAgent({
    provider: 'codex-runtime',
    workspace: {
      id: `r13-ws-${codexAgentSequence}`,
      name: 'R13 Workspace',
      rootPath: workspaceRootPath,
      workspaceRootPath,
      sessionRootPath: join(WORKSPACE_ROOT, 'sessions'),
    } as never,
    session: {
      id: `r13-session-${codexAgentSequence}`,
      workspaceRootPath,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: workspaceRootPath,
    } as never,
    model: 'codex/test-model',
    isHeadless: true,
  } as never);
  const surfaced: unknown[] = [];
  agent.onPermissionRequest = (request) => { surfaced.push(request); };
  agent.getPermissionManager().setCapabilityPermissionLayers(
    rules === null ? [] : [{ content: JSON.stringify({ permissions: rules }), scope: 'workspace' }],
    `generation-r13-${codexAgentSequence}`,
    true,
  );
  agent.setPermissionMode(mode);
  return { agent, surfaced };
}

const EXEC_METHOD = 'item/commandExecution/requestApproval';

/** The approval `handleServerRequest` would answer, asked directly. */
function codexAnswer(agent: CodexAgent, method: string, params: unknown) {
  return (agent as unknown as {
    handleServerRequest(m: string, p: unknown): Promise<Record<string, unknown>> | Record<string, unknown>;
  }).handleServerRequest(method, params);
}

describe('R13 — dontAsk on codex denies what no rule pre-approves, and never asks', () => {
  beforeEach(() => { permissionsConfigCache.clear(); });

  it('the config half: switch-off dontAsk now emits a policy that routes to us', () => {
    // Named for what it asserts. It does NOT hold the before-state value —
    // `R5-KNOWN-WIDENING, FIXED` writes that literal out and asserts we no
    // longer produce it; deleting that sibling would lose the only pin on it.
    //
    // Why the config half is a prerequisite rather than the fix: until R13 the
    // switch-off pair was `danger-full-access`/`never`, and `never` is "Never
    // ask the user to approve commands" (release `config-schema.json`,
    // AskForApproval), so no COMMAND approval request existed for the cases
    // below to answer — that answer path was not wrong, it was NOT RUNNING.
    // (Elicitation is not gated by `approval_policy` and reached us in both
    // switch positions; see the note in `CodexAgent.handleServerRequest`.)
    expect(codexSandboxConfigForMode('dontAsk', false).approval_policy).toBe('on-request');
  });

  it('denies an unmatched command without putting a card on screen', async () => {
    const { agent, surfaced } = codexAgentInMode('dontAsk', { allow: ['Bash(git status)'] });

    const answer = await codexAnswer(agent, EXEC_METHOD, { command: 'npm publish', cwd: WORKSPACE_ROOT });

    expect(answer).toEqual({ decision: 'decline' });
    // "Never prompt" is half the contract and the half that was already honoured.
    expect(surfaced).toEqual([]);
    expect((agent as unknown as { pendingApprovals: Map<string, unknown> }).pendingApprovals.size).toBe(0);
  });

  it('THE POSITIVE CONTROL — a rule that pre-approves still allows, or the mode is useless rather than safe', async () => {
    // This is the failure R6's first attempt made and had to correct: a guard
    // strict enough to refuse everything turns "run what the rules pre-approve"
    // into a dead clause. `shouldAllowToolInMode('Bash', {command:'git status'},
    // 'dontAsk')` answers `allowed: false` with NO floor flag — measured — which
    // is exactly the band a rule is allowed to answer in.
    const { agent, surfaced } = codexAgentInMode('dontAsk', { allow: ['Bash(git status)'] });

    const answer = await codexAnswer(agent, EXEC_METHOD, { command: 'git status', cwd: WORKSPACE_ROOT });

    expect(answer).toEqual({ decision: 'accept' });
    expect(surfaced).toEqual([]);
  });

  it('THE NEGATIVE CONTROL — the identical call in another mode DOES raise a card', () => {
    // Without this, "no card appeared" is equally satisfied by a rig that cannot
    // produce a card at all. Same command, same rules, `default` instead.
    const { agent, surfaced } = codexAgentInMode('default', { allow: ['Bash(git status)'] });

    void codexAnswer(agent, EXEC_METHOD, { command: 'npm publish', cwd: WORKSPACE_ROOT });

    expect(surfaced).toHaveLength(1);
  });

  it('a rule DENY still refuses under dontAsk, and so does a request no rule can judge', async () => {
    const { agent, surfaced } = codexAgentInMode('dontAsk', { deny: ['Bash(rm -rf *)'] });

    expect(await codexAnswer(agent, EXEC_METHOD, { command: 'rm -rf build', cwd: WORKSPACE_ROOT }))
      .toEqual({ decision: 'decline' });
    // A sandbox-widening request carries no rule vocabulary at all
    // (`codexApprovalRuleRequests` returns `[]`), so in every other mode it goes
    // to a human. Under dontAsk there is no human to go to, and "deny the rest"
    // is what the mode says to do with it.
    expect(await codexAnswer(agent, PERMISSIONS_METHOD, {
      threadId: 't', turnId: 'u', itemId: 'i', startedAtMs: 1,
      cwd: WORKSPACE_ROOT, environmentId: null, reason: 'needs the network',
      permissions: { network: { enabled: true } },
    })).toEqual({ permissions: {}, scope: 'turn' });
    expect(surfaced).toEqual([]);
  });

  it('unattended dontAsk keeps its own answer instead of the headless auto-approve', async () => {
    // The headless fallback exists so an unattended turn completes — correct
    // for every mode that needs a human it does not have. `dontAsk` already
    // states what to do when nobody can be asked, so borrowing that yes would
    // have re-created the widening one layer down. Since P6.531 the yes is
    // behind the operator escape hatch and the shipped default is `deny`, which
    // is why the control below has to open the hatch to have a yes to refuse.
    const { agent } = codexAgentInMode('dontAsk', null);
    agent.onPermissionRequest = null;

    expect(await codexAnswer(agent, EXEC_METHOD, { command: 'rm -rf build', cwd: WORKSPACE_ROOT }))
      .toEqual({ decision: 'decline' });

    // The control: the same unattended agent in `default` DOES take the
    // fallback's answer, so what changed is the mode and not the fallback.
    //
    // P6.1063 — this control used to assert a bare `accept` and had been red
    // since P6.531, which turned the unattended fallback's shipped default from
    // `allow` into `deny`. The number in the assertion was right when it was
    // written and the proposition it guards never moved: `dontAsk` answers for
    // ITSELF rather than borrowing the fallback. What broke is that with the
    // fallback also refusing, both arms decline and the control discriminates
    // nothing — it would pass on a rig where `dontAsk` had no answer at all.
    //
    // So the control now OPENS the operator escape hatch for the `default` arm
    // (`codex-approval-attendance-matrix.test.ts` drives the same lever, and
    // `rm -rf build` reaches neither a floor nor a rule here — measured: it is
    // `null` out of `findNonNegotiableFloors`). `default` then accepts and
    // `dontAsk` above still declines with the hatch shut, which is the
    // separation this case exists for: the yes is reachable, and `dontAsk` does
    // not reach for it.
    process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR] = 'allow';
    try {
      const other = codexAgentInMode('default', null);
      other.agent.onPermissionRequest = null;
      expect(await codexAnswer(other.agent, EXEC_METHOD, { command: 'rm -rf build', cwd: WORKSPACE_ROOT }))
        .toEqual({ decision: 'accept' });

      // …and the hatch does NOT reach `dontAsk`, which is the half a shared
      // `decline` could never have shown.
      const stillDontAsk = codexAgentInMode('dontAsk', null);
      stillDontAsk.agent.onPermissionRequest = null;
      expect(await codexAnswer(stillDontAsk.agent, EXEC_METHOD, {
        command: 'rm -rf build', cwd: WORKSPACE_ROOT,
      })).toEqual({ decision: 'decline' });
    } finally {
      delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR];
    }
  });
});
