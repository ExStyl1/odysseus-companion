/**
 * R3's first acceptance criterion — the must-fix R2 handed over.
 *
 * ## The defect, in one paragraph
 *
 * R2 routed the model's own `AskUserQuestion` through `canUseTool` and made
 * every OTHER tool that reaches the callback return `behavior: 'deny'`, with no
 * prompt, because no approval surface was wired to it yet. That was deliberate,
 * fail-closed and documented as temporary — and it was a live behaviour change
 * with two victims:
 *
 * (a) A user writes `"permissions": { "ask": ["Bash(git push:*)"] }` in their
 *     own `.claude/settings.json`. `agent-sdk/permissions.md`: "If an ask rule
 *     matches, the call falls through to your `canUseTool` callback for
 *     confirmation, even in `bypassPermissions` mode." Before R2 the stub
 *     approved it silently; after R2 `git push` became impossible on this
 *     runtime and the user was never asked.
 *
 * (b) A trusted PreToolUse automation returns `decision: 'ask'` on a tool our
 *     own gate allows. R1 turned that into `permissionDecision: 'ask'`, which
 *     "prompts the user to confirm" (`hooks.md`) — and the prompt is this
 *     callback. Same outcome: silently refused where it used to be silently
 *     approved.
 *
 * Neither is acceptable, and neither is fixed by choosing the other default:
 * approving is what R2 removed, refusing is what R2 introduced. The fix is the
 * third thing — ask the person, on the same card the PreToolUse `prompt` branch
 * raises and the Codex approval path uses.
 *
 * ## Both before-states are kept below, verbatim
 *
 * `PRE_R2_CAN_USE_TOOL` (the auto-approving stub) and `PRE_R3_CAN_USE_TOOL`
 * (R2's blanket refusal) are copied from the file as it stood at each commit, so
 * every negative control measures a real before-state rather than a straw man.
 *
 * ## The limit
 *
 * The SDK's side of this — which calls it routes here, and what it does with the
 * answer — runs in the native `claude` binary. What runs here is our whole half:
 * the projection of the SDK's arguments onto the card, the wait, the answer, and
 * every path that must settle rather than hang.
 */
import { describe, expect, it } from 'bun:test';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { AskUserAnswer, AskUserPermissionRequest } from '@nessy-agent/core/types';
import {
  ASK_USER_QUESTION_TOOL,
  CAN_USE_TOOL_DECLINED_DENIAL,
  CAN_USE_TOOL_DONT_ASK_DENIAL,
  CAN_USE_TOOL_NO_SURFACE_DENIAL,
  TRUSTED_HOOK_ASK_REASON,
  buildClaudeCanUseTool,
  claudeToolApprovalRequest,
  type ClaudeToolApprovalAnswer,
  type ClaudeToolApprovalRequest,
} from '../claude-agent.ts';
import type { PermissionMode } from '../mode-types.ts';

// ---------------------------------------------------------------------------
// The two before-states.
// ---------------------------------------------------------------------------

/** ecfbda561 and everything before it: an unconditional yes for every tool. */
const PRE_R2_CAN_USE_TOOL: CanUseTool = async (_toolName, input) =>
  ({ behavior: 'allow' as const, updatedInput: input as Record<string, unknown> });

/** 657efa0d0 (R2): a hard deny for every tool that is not the question tool. */
const PRE_R3_CAN_USE_TOOL: CanUseTool = async (toolName, _input, options) => {
  if (toolName === ASK_USER_QUESTION_TOOL) throw new Error('not the branch under test');
  const why = options.decisionReason ?? options.matchedAskRule?.source;
  return {
    behavior: 'deny',
    message: why ? `refused. Reason given: ${why}` : 'refused.',
  };
};

// ---------------------------------------------------------------------------
// The rig: the real callback, wired to a capturing permission surface the way
// `ClaudeAgent.askToolApproval` wires it to `onPermissionRequest`.
// ---------------------------------------------------------------------------

interface Rig {
  canUseTool: CanUseTool;
  cards: ClaudeToolApprovalRequest[];
  questions: AskUserPermissionRequest[];
  debugLog: string[];
  // P6.951 — `comment` is the note a denial may carry into `deny.message`.
  answer(requestId: string, allowed: boolean, comment?: string): boolean;
  nextCard(): Promise<ClaudeToolApprovalRequest>;
}

function makeRig(options: { mode?: PermissionMode; noPermissionHandler?: boolean; gateApproved?: Set<string> } = {}): Rig {
  const cards: ClaudeToolApprovalRequest[] = [];
  const questions: AskUserPermissionRequest[] = [];
  const debugLog: string[] = [];
  const pending = new Map<string, (answer: ClaudeToolApprovalAnswer) => void>();
  const waiters: ((card: ClaudeToolApprovalRequest) => void)[] = [];
  return {
    cards,
    questions,
    debugLog,
    answer: (requestId, allowed, comment) => {
      const resolve = pending.get(requestId);
      if (!resolve) return false;
      pending.delete(requestId);
      resolve({ allowed, ...(comment ? { comment } : {}) });
      return true;
    },
    nextCard: () => {
      const existing = cards[cards.length - 1];
      if (existing) return Promise.resolve(existing);
      return new Promise(resolve => waiters.push(resolve));
    },
    canUseTool: buildClaudeCanUseTool({
      askUser: async request => {
        questions.push(request);
        const answer: AskUserAnswer = { type: 'option', value: 'first', optionIndex: 0 };
        return answer;
      },
      askPermission: (request, signal) => {
        if (options.noPermissionHandler) {
          return Promise.reject(new Error('claude has no interactive permission handler.'));
        }
        cards.push(request);
        waiters.splice(0).forEach(resolve => resolve(request));
        return new Promise<ClaudeToolApprovalAnswer>(resolve => {
          if (signal?.aborted) return resolve({ allowed: false });
          signal?.addEventListener('abort', () => resolve({ allowed: false }), { once: true });
          pending.set(request.requestId, resolve);
        });
      },
      alreadyApprovedByGate: id => (options.gateApproved ?? new Set<string>()).has(id ?? ''),
      permissionMode: () => options.mode ?? 'default',
      debug: message => debugLog.push(message),
    }),
  };
}

function callOptions(overrides: Partial<Parameters<CanUseTool>[2]> = {}): Parameters<CanUseTool>[2] {
  return {
    signal: new AbortController().signal,
    toolUseID: 'toolu_01',
    requestId: 'req_01',
    ...overrides,
  };
}

/** How the SDK describes a call an `ask` RULE forced. */
const ASK_RULE_OPTIONS = callOptions({
  decisionReason: 'A permission rule requires approval for this tool',
  matchedAskRule: { source: 'projectSettings', toolName: 'Bash', ruleContent: 'git push:*' },
});

const isDeny = (result: PermissionResult | null): result is Extract<PermissionResult, { behavior: 'deny' }> =>
  result?.behavior === 'deny';

// ===========================================================================

describe('R3 — (a) a user\'s own ask rule is asked about, not silently decided', () => {
  it('raises a card and runs the command when the user approves', async () => {
    const rig = makeRig();
    let settled = false;
    const pending = rig.canUseTool('Bash', { command: 'git push origin main' }, ASK_RULE_OPTIONS)
      .then(result => { settled = true; return result; });

    const card = await rig.nextCard();
    await Promise.resolve();
    // It waits. That alone is the fix: both before-states answered instantly.
    expect(settled).toBe(false);
    expect(card.toolName).toBe('Bash');
    expect(card.command).toBe('git push origin main');
    expect(card.type).toBe('bash');
    // The user gets told WHY they are seeing a prompt they have not seen before.
    expect(card.reason).toContain('A permission rule requires approval');
    expect(card.reason).toContain('Bash(git push:*)');
    expect(card.reason).toContain('projectSettings');

    rig.answer(card.requestId, true);
    const result = await pending;
    expect(result?.behavior).toBe('allow');
    // We approve the call; we do not rewrite it.
    expect(result?.behavior === 'allow' && result.updatedInput).toBeUndefined();
  });

  it('refuses it when the user declines, and says who decided', async () => {
    const rig = makeRig();
    const pending = rig.canUseTool('Bash', { command: 'git push --force' }, ASK_RULE_OPTIONS);
    const card = await rig.nextCard();
    rig.answer(card.requestId, false);
    const result = await pending;
    expect(isDeny(result) && result.message).toBe(CAN_USE_TOOL_DECLINED_DENIAL);
  });

  /**
   * P6.951 — `permissions.md#add-a-comment-when-you-answer-a-permission-prompt`:
   * *"**No**: Claude Code sends your comment to Claude as the reason for the
   * denial, and Claude continues working."*
   *
   * Native: `PermissionResult`'s deny branch already carries `message`, and this
   * row only stops it from always being the constant.
   */
  it('sends the user’s note as the denial reason, and keeps the constant when there is none', async () => {
    const rig = makeRig();
    const withNote = rig.canUseTool('Bash', { command: 'git push --force' }, ASK_RULE_OPTIONS);
    const noted = await rig.nextCard();
    rig.answer(noted.requestId, false, '  force-pushing main is never ok here  ');
    const denied = await withNote;
    // REPLACES the constant rather than being appended to it: the page says the
    // comment IS the reason, and boilerplate before it is what a model skips.
    // Trimmed, so a stray space cannot become the whole reason.
    expect(isDeny(denied) && denied.message).toBe('force-pushing main is never ok here');

    // Whitespace-only is not a note. The boundary matters because the card sends
    // `options` only when something was typed, and a space is "something".
    const blankPending = rig.canUseTool('Bash', { command: 'git push --force' }, ASK_RULE_OPTIONS);
    const blankCard = await rig.nextCard();
    rig.answer(blankCard.requestId, false, '   ');
    const blank = await blankPending;
    expect(isDeny(blank) && blank.message).toBe(CAN_USE_TOOL_DECLINED_DENIAL);
  });

  it('never turns an APPROVAL into a message — the Yes half has no channel', async () => {
    // The page's Yes half ("runs the action, then sends your comment to Claude
    // after the result") is a HOST injection: the SDK's allow branch carries no
    // feedback field at all, so a note answered with Yes must change nothing
    // here. That is P6.864's remaining half, and this case is what pins that
    // this row did not quietly half-build it.
    const rig = makeRig();
    const pending = rig.canUseTool('Bash', { command: 'git push origin main' }, ASK_RULE_OPTIONS);
    const card = await rig.nextCard();
    rig.answer(card.requestId, true, 'be careful with this one');
    const result = await pending;
    expect(result?.behavior).toBe('allow');
    expect(Object.keys(result ?? {})).toEqual(['behavior']);
  });

  it('THE TWO NEGATIVE CONTROLS — neither before-state ever put this on screen', async () => {
    const rig = makeRig();
    const input = { command: 'git push origin main' };

    // Before R2: approved on the user's behalf, silently. Their `ask` rule did
    // nothing at all.
    const stubbed = await PRE_R2_CAN_USE_TOOL('Bash', input, ASK_RULE_OPTIONS);
    expect(stubbed?.behavior).toBe('allow');

    // After R2, before R3: refused, silently. `git push` was impossible on this
    // runtime and nothing asked the user about it.
    const refused = await PRE_R3_CAN_USE_TOOL('Bash', input, ASK_RULE_OPTIONS);
    expect(refused?.behavior).toBe('deny');

    // Neither raised a card; both decided for the user, in opposite directions.
    expect(rig.cards).toHaveLength(0);
  });
});

describe('R3 — (b) a trusted automation\'s ask reaches the same card', () => {
  it('an ask a PreToolUse hook forced is prompted, not refused', async () => {
    // R1 emits exactly this text in `permissionDecisionReason` when a trusted
    // automation asks for approval and names no reason of its own, and
    // `hooks.md` says an `ask` "prompts the user to confirm" — this callback is
    // where that prompt lands. Case (b) of the must-fix, and it was named
    // nowhere before R2's review.
    const rig = makeRig();
    const pending = rig.canUseTool(
      'Bash',
      { command: 'npm run deploy' },
      callOptions({ decisionReason: TRUSTED_HOOK_ASK_REASON }),
    );
    const card = await rig.nextCard();
    expect(card.reason).toContain(TRUSTED_HOOK_ASK_REASON);
    rig.answer(card.requestId, true);
    expect((await pending)?.behavior).toBe('allow');

    // The before-state refused a call our own gate had already allowed.
    expect((await PRE_R3_CAN_USE_TOOL('Bash', { command: 'npm run deploy' },
      callOptions({ decisionReason: TRUSTED_HOOK_ASK_REASON })))?.behavior).toBe('deny');
  });
});

describe('R3 — every path settles, because an unsettled one parks the tool forever', () => {
  it('no permission handler at all denies instead of hanging', async () => {
    const rig = makeRig({ noPermissionHandler: true });
    const result = await rig.canUseTool('Bash', { command: 'ls' }, callOptions());
    expect(isDeny(result) && result.message).toContain(CAN_USE_TOOL_NO_SURFACE_DENIAL);
    expect(isDeny(result) && result.message).toContain('no interactive permission handler');
  });

  it('an aborted turn settles the card with a refusal', async () => {
    const rig = makeRig();
    const controller = new AbortController();
    const pending = rig.canUseTool('Write', { file_path: '/tmp/x' },
      callOptions({ signal: controller.signal }));
    await rig.nextCard();
    controller.abort();
    expect((await pending)?.behavior).toBe('deny');
  });

  it('a call that arrives already aborted never raises a card', async () => {
    const rig = makeRig();
    const controller = new AbortController();
    controller.abort();
    const result = await rig.canUseTool('Bash', { command: 'ls' },
      callOptions({ signal: controller.signal }));
    expect(result?.behavior).toBe('deny');
  });

  it('`dontAsk` denies without a card — that mode never prompts', async () => {
    // "In `dontAsk` mode, this step is skipped and the tool is denied"
    // (agent-sdk/permissions.md). The SDK should not route one here at all; the
    // case this covers is the mode moving mid-turn, since the SDK's copy is from
    // process start and ours is read per call.
    const rig = makeRig({ mode: 'dontAsk' });
    const result = await rig.canUseTool('Bash', { command: 'git push' }, ASK_RULE_OPTIONS);
    expect(isDeny(result) && result.message).toBe(CAN_USE_TOOL_DONT_ASK_DENIAL);
    expect(rig.cards).toHaveLength(0);
  });

  it('never returns null on any of these paths', async () => {
    // "Fail-closed: an accidental null means no control_response is sent and the
    // tool stays blocked indefinitely — permission prompts have no park
    // deadline." (sdk.d.ts, on `CanUseTool`'s return type.)
    for (const rig of [makeRig(), makeRig({ mode: 'dontAsk' }), makeRig({ noPermissionHandler: true })]) {
      const pending = rig.canUseTool('Bash', { command: 'ls' }, callOptions());
      await Promise.resolve();
      for (const card of rig.cards) rig.answer(card.requestId, false);
      const result = await pending;
      expect(result).not.toBeNull();
      expect(result?.behavior).toBe('deny');
    }
  });
});

describe('R3 — the question route is untouched', () => {
  it('AskUserQuestion still goes to the question bridge, never to a permission card', async () => {
    const rig = makeRig();
    const result = await rig.canUseTool(
      ASK_USER_QUESTION_TOOL,
      { questions: [{ question: 'q', options: [{ label: 'first' }, { label: 'second' }] }] },
      callOptions(),
    );
    expect(result?.behavior).toBe('allow');
    expect(rig.questions).toHaveLength(1);
    expect(rig.cards).toHaveLength(0);
  });

  it('and it is not diverted by `dontAsk` handling meant for the other branch', async () => {
    // The bridge owns the `dontAsk` refusal for questions (R2), so the guard
    // added here must not shadow it and change the message the model gets.
    const rig = makeRig({ mode: 'dontAsk' });
    await rig.canUseTool(
      ASK_USER_QUESTION_TOOL,
      { questions: [{ question: 'q', options: [{ label: 'first' }] }] },
      callOptions(),
    );
    expect(rig.questions).toHaveLength(1);
  });
});

describe('R3 — the projection onto the card', () => {
  it('prefers the SDK\'s own prompt sentence over one rebuilt from the input', () => {
    // "Full permission prompt sentence rendered by the bridge … Use this as the
    // primary prompt text when present instead of reconstructing from
    // toolName+input." (sdk.d.ts)
    const withTitle = claudeToolApprovalRequest('Read', { file_path: '/x/foo.txt' },
      callOptions({ title: 'Claude wants to read foo.txt', description: 'subtitle' }));
    expect(withTitle.description).toBe('Claude wants to read foo.txt');
    const withoutTitle = claudeToolApprovalRequest('Read', { file_path: '/x/foo.txt' },
      callOptions({ description: 'subtitle' }));
    expect(withoutTitle.description).toBe('subtitle');
    const withNeither = claudeToolApprovalRequest('Bash', { command: 'ls -la' }, callOptions());
    expect(withNeither.description).toBe('Bash: ls -la');
  });

  it('classifies the three kinds the card renders differently', () => {
    expect(claudeToolApprovalRequest('Bash', { command: 'ls' }, callOptions()).type).toBe('bash');
    for (const tool of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']) {
      const card = claudeToolApprovalRequest(tool, { file_path: '/repo/x.ts' }, callOptions());
      expect(card.type).toBe('file_write');
      // The path, not the tool name, is what a person needs to see here.
      expect(card.command).toBe('/repo/x.ts');
    }
    expect(claudeToolApprovalRequest('mcp__github__create_issue', {}, callOptions()).type)
      .toBe('mcp_mutation');
    // A tool with no natural kind carries none rather than a wrong one.
    expect(claudeToolApprovalRequest('WebFetch', {}, callOptions())).not.toHaveProperty('type');
  });

  it('names the subagent that asked instead of showing an anonymous card', () => {
    // Unlike a question — which is denied for subagents, because the docs
    // withhold the tool there — an approval CAN be answered by the user. They
    // just have to know who is asking.
    const card = claudeToolApprovalRequest('Bash', { command: 'rm -rf build' },
      callOptions({ agentID: 'code-reviewer' }));
    expect(card.reason).toContain('code-reviewer');
    // C3.370 — and it has to ride the field the CARD reads, which this case did
    // not assert for a month. R6b measured the gap on the packaged 1.37.0
    // (C5.11 / RS-14): the prompt reached the parent's pane and named nobody,
    // because `reason` is rendered on no permission card and `agentLabel` — the
    // chip that is — had only Pi's `permissionSurfaceRouting` as a producer.
    expect(card.agentLabel).toBe('code-reviewer');
  });

  /**
   * The negative arm, and the one that makes the chip mean something: a
   * main-thread call must carry NO label, or the card grows a permanent "from
   * agent" row naming the session itself.
   */
  it('leaves the label off a main-thread call', () => {
    const card = claudeToolApprovalRequest('Bash', { command: 'ls' }, callOptions());
    expect(card).not.toHaveProperty('agentLabel');
    expect(card.reason ?? '').not.toContain('subagent');
  });

  it('surfaces a blocked path when that is what triggered the prompt', () => {
    const card = claudeToolApprovalRequest('Bash', { command: 'cat /etc/hosts' },
      callOptions({ blockedPath: '/etc/hosts' }));
    expect(card.reason).toContain('/etc/hosts');
    // …and does not repeat itself when the path IS the command shown.
    const write = claudeToolApprovalRequest('Write', { file_path: '/etc/hosts' },
      callOptions({ blockedPath: '/etc/hosts' }));
    expect(write.command).toBe('/etc/hosts');
    expect(write.reason ?? '').not.toContain('Path outside the allowed directories');
  });

  it('keys the card on the SDK\'s control-request id, not the tool-use id', () => {
    // One tool call can raise our own PreToolUse card (`perm-<tool_use_id>`) and
    // this one. Two cards sharing an id is an answer routed to the wrong wait.
    const card = claudeToolApprovalRequest('Bash', { command: 'ls' },
      callOptions({ toolUseID: 'toolu_shared', requestId: 'req_77' }));
    expect(card.requestId).toBe('perm-req_77');
    expect(card.requestId).not.toContain('toolu_shared');
  });

  it('falls back to the tool name when there is no command to show', () => {
    const card = claudeToolApprovalRequest('mcp__linear__create_issue', { title: 'x' }, callOptions());
    expect(card.command).toBe('mcp__linear__create_issue');
    expect(card.description).toBe('mcp__linear__create_issue requires your approval');
  });
});


/**
 * ONE CALL, ONE CARD.
 *
 * The review caught this before it shipped, and it hit exactly the users this
 * row exists for: someone with `"permissions": {"ask": ["Bash(git push:*)"]}`
 * answered TWO cards for one push. `permissions.md` puts our hook at step 1 and
 * the ask-rule check at step 6, and says plainly that "a hook that returns
 * `allow` does not skip the deny and ask rules below" — so a call we prompted
 * for, and the user approved, is re-routed here and asked again.
 *
 * The second card is not extra safety. It is the same question twice, and the
 * user cannot tell it apart from the first.
 */
describe('one call raises one card, not two', () => {
  it('does not ask again for a tool_use_id our own card already approved', async () => {
    const rig = makeRig({ gateApproved: new Set(['toolu_01']) });

    const result = await rig.canUseTool('Bash', { command: 'git push origin main' }, callOptions());

    expect(result).toEqual({ behavior: 'allow' });
    expect(rig.cards).toEqual([]);
  });

  it('still asks for a DIFFERENT call in the same session', async () => {
    // The negative control. Without it, the case above is equally satisfied by
    // a suppression that swallows every card in the session.
    const rig = makeRig({ gateApproved: new Set(['toolu_01']) });

    const pending = rig.canUseTool('Bash', { command: 'rm -rf build' }, callOptions({ toolUseID: 'toolu_02' }));
    const card = await rig.nextCard();

    expect(card.toolName).toBe('Bash');
    rig.answer(card.requestId, true);
    expect(await pending).toEqual({ behavior: 'allow' });
  });
});

/**
 * I2.7 — the two SAFETY flags the CLI mints and the SDK does not hand us.
 *
 * `default_to_no` ("the ask must not be approvable by a single stray
 * keystroke … Hosts rendering approve options should not pre-select approve
 * when set") and `suppress_always_allow_rule` ("the dialog must not offer the
 * persistent 'don't ask again' row for this ask") are fields of
 * `SDKControlPermissionRequest`, the `can_use_tool` control request. They are
 * NOT fields of the options object `canUseTool` receives: `sdk.mjs`'s own
 * `processControlRequest` builds that object as an explicit field list with no
 * spread of the request, so both names are dropped between the wire and us.
 *
 * This is an ABSENCE probe over a vendored artefact, so it carries its controls
 * on the same rig rather than in prose: two names the same literal DOES carry
 * must be non-zero, or a green absence would only mean the file could not be
 * read. It is deliberately a tripwire and not a guard — it goes RED the day the
 * SDK starts projecting either flag, which is the day the row becomes
 * buildable, and `claude-agent.ts`'s `claudeToolApprovalRequest` docblock is
 * where the verdict lives.
 *
 * F1.1213 — IT WENT RED at the 0.3.274 lift, as designed. SDK 0.3.268's
 * changelog: "Added optional `defaultToNo` and `suppressAlwaysAllowRule` hints
 * to `canUseTool` options", and the vendored `sdk.mjs` now builds the options
 * with `defaultToNo:e.request.default_to_no,suppressAlwaysAllowRule:
 * e.request.suppress_always_allow_rule` (both typed on the options in
 * `sdk.d.ts`). So the row is BUILDABLE from here, through the callback rather
 * than around it; F1.1219 reads both onto the card (`claude-card-sdk-rendering-hints.test.ts`).
 * The probe is turned round into a presence pin on the same instrument —
 * it now reddens if the projection is withdrawn — and the type-level arm below
 * keeps pinning that this suite's option fixture does not invent the keys.
 */
describe('I2.7 — the permission ask’s two rendering constraints reach canUseTool since 0.3.268', () => {
  const sdkMjs = new URL(
    '../../../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
    import.meta.url,
  );

  it('projects default_to_no and suppress_always_allow_rule into canUseTool (F1.1213: was absent through 0.3.267)', async () => {
    const source = await Bun.file(sdkMjs).text();

    // POSITIVE CONTROLS, first: two fields the same options literal does carry.
    // Without these a zero below would be "the file is empty", not "the flag is
    // absent" — and both are spelled exactly as the literal spells them.
    expect(source).toContain('blockedPath:e.request.blocked_path');
    expect(source).toContain('matchedAskRule:');

    // The projection itself, spelled as the options literal spells it.
    expect(source).toContain('defaultToNo:e.request.default_to_no');
    expect(source).toContain('suppressAlwaysAllowRule:e.request.suppress_always_allow_rule');
    // Negative control on the identical read: a name the literal does not carry.
    expect(source).not.toContain('nessyNotAProjectedHint:e.request.');
  });

  it('carries neither flag on the options type this fork is built against', () => {
    // The type-level arm, so the pin survives a bundle that stops shipping
    // `sdk.mjs` in a readable form. `callOptions()` is the shape the whole
    // suite drives, and it is `Parameters<CanUseTool>[2]`. Since 0.3.268 both
    // fields are OPTIONAL on that type (F1.1213), so the cast still compiles and
    // this arm now pins only that the fixture does not set them.
    const options = callOptions() as Record<string, unknown>;

    expect(Object.keys(options)).not.toContain('defaultToNo');
    expect(Object.keys(options)).not.toContain('suppressAlwaysAllowRule');
    // Control: a key the same object really does carry.
    expect(Object.keys(options)).toContain('toolUseID');
  });
});
