/**
 * R2 — route `canUseTool`, so the model can ask the user a question on Claude.
 *
 * WHAT WAS MEASURED BEFORE THE CHANGE, 2026-08-16, unbounded `grep -a` over
 * `packages` and `apps` with `node_modules`, `dist` and `release` excluded:
 * `canUseTool` had exactly ONE implementation in the whole product,
 * `claude-agent.ts:1991`, and it was
 *
 *   `async (_toolName, input) => ({ behavior: 'allow', updatedInput: input })`
 *
 * with the comment "This callback is NOT called by the SDK because we set
 * `permissionMode: 'bypassPermissions'`". No test anywhere asserted anything
 * about it. `PRE_R2_CAN_USE_TOOL` below is that stub, copied verbatim, so the
 * negative control measures the real before-state rather than a straw man.
 *
 * THE STUB'S COMMENT WAS FALSE ALREADY, which is the part that makes this row
 * urgent rather than preparatory. `permissions.md` § How permissions are
 * evaluated puts three routes AHEAD of the permission-mode step:
 *
 *   "Check `ask` rules from settings.json. If an ask rule matches, the call
 *   falls through to your `canUseTool` callback for confirmation, even in
 *   `bypassPermissions` mode."
 *
 *   "Tools that require user interaction behave the same way: `AskUserQuestion`
 *   and MCP tools whose server sets `_meta[\"anthropic/requiresUserInteraction\"]`
 *   always fall through to the callback, even when an allow rule matches."
 *
 *   "[claude.ai connector] tools your organization has set to `ask` also leave
 *   the flow at this step. Every call falls through to the callback, even in
 *   `bypassPermissions` mode and even when an allow rule matches."
 *
 * and the mode table's own `bypassPermissions` row says the same from the other
 * side: "Tools run without permission prompts, except tools matched by an
 * explicit `ask` rule, connector tools your organization set to `ask`, and tools
 * that require user interaction."
 *
 * `claude-agent.ts` passes `settingSources` with `user` (and `project` + `local` for a trusted
 * project only, F1.768), so a user's own `ask` rule is loaded and reaches this callback — where the
 * stub said yes on their behalf, silently, in every mode.
 *
 * WHAT THIS SUITE CAN AND CANNOT PROVE. It exercises the real route end to end:
 * the SDK input projection, `ElicitationAskUserBridge` (the same class Codex and
 * the MCP elicitation path use — documented batch validation, the
 * `askUserQuestionTimeout` stamp, the `dontAsk` refusal, answer validation,
 * cancel-and-settle), the permission-channel surface, and the answer envelope.
 * What it cannot execute is the SDK's own consumption of that envelope: the
 * `AskUserQuestion` tool runs inside the native `claude` binary. So the field
 * names are asserted against the installed `sdk-tools.d.ts` at run time rather
 * than trusted, and the behavioural half — a real model raising a real question
 * — belongs to a live case.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { AskUserAnswer, AskUserPermissionRequest } from '@nessy-agent/core/types';
import {
  ASK_USER_QUESTION_TOOL,
  CLAUDE_SESSION_DISALLOWED_TOOLS,
  askUserQuestionAnswerEnvelope,
  askUserQuestionPromptBelongsToCanUseTool,
  askUserRequestFromQuestionInput,
  buildClaudeCanUseTool,
  type ClaudeToolApprovalAnswer,
  type ClaudeToolApprovalRequest,
} from '../claude-agent.ts';
import { ElicitationAskUserBridge } from '../elicitation-ask-user.ts';
import { cleanupModeState, initializeModeState } from '../mode-manager.ts';
import { runPreToolUseChecks, type PermissionManagerLike } from '../core/pre-tool-use.ts';
import type { PermissionMode } from '../mode-types.ts';

// ---------------------------------------------------------------------------
// The before-state, copied verbatim from claude-agent.ts as it stood at
// ecfbda561 (R1's commit, the parent of this row).
// ---------------------------------------------------------------------------
const PRE_R2_CAN_USE_TOOL: CanUseTool = async (_toolName, input) => {
  return { behavior: 'allow' as const, updatedInput: input as Record<string, unknown> };
};

// ---------------------------------------------------------------------------
// One realistic `AskUserQuestion` input, shaped from `user-input.md`'s own
// "The structure your callback receives" sample plus a multi-select question.
// ---------------------------------------------------------------------------
const FORMAT_Q = 'How should I format the output?';
const SECTIONS_Q = 'Which sections should I include?';

function questionInput(): Record<string, unknown> {
  return {
    questions: [
      {
        question: FORMAT_Q,
        header: 'Format',
        options: [
          { label: 'Summary', description: 'Brief overview of key points' },
          { label: 'Detailed', description: 'Full explanation with examples', preview: '# Title\n…' },
        ],
        multiSelect: false,
      },
      {
        question: SECTIONS_Q,
        header: 'Sections',
        options: [
          { label: 'Introduction', description: 'Opening context' },
          { label: 'Conclusion', description: 'Final summary' },
        ],
        multiSelect: true,
      },
    ],
  };
}

/** The `options` argument the SDK passes; only the fields we read are varied. */
function callOptions(overrides: Partial<Parameters<CanUseTool>[2]> = {}): Parameters<CanUseTool>[2] {
  return {
    signal: new AbortController().signal,
    toolUseID: 'toolu_01',
    requestId: 'req_01',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A rig that wires the real bridge to a capturing surface, exactly as
// `ClaudeAgent` wires it to `surfaceElicitationDialog`.
// ---------------------------------------------------------------------------
interface Rig {
  canUseTool: CanUseTool;
  bridge: ElicitationAskUserBridge;
  surfaced: { requestId: string; askUser: AskUserPermissionRequest }[];
  /** Approval cards raised by the R3 branch — see `claude-can-use-tool-approval.test.ts`. */
  approvals: ClaudeToolApprovalRequest[];
  /** Settle one approval card, the way `respondToPermission` settles it. */
  answer(requestId: string, allowed: boolean): boolean;
  debugLog: string[];
  /** Wait until a card is on screen, so a test never races the surface. */
  nextCard(): Promise<{ requestId: string; askUser: AskUserPermissionRequest }>;
}

const rigs: Rig[] = [];

function makeRig(options: {
  mode?: PermissionMode;
  timeoutMs?: number;
  surfaceThrows?: string;
  /** No interactive handler at all — the headless shape. */
  noPermissionHandler?: boolean;
} = {}): Rig {
  const surfaced: Rig['surfaced'] = [];
  const approvals: ClaudeToolApprovalRequest[] = [];
  const pendingApprovals = new Map<string, (answer: ClaudeToolApprovalAnswer) => void>();
  const debugLog: string[] = [];
  const waiters: ((card: Rig['surfaced'][number]) => void)[] = [];
  const bridge = new ElicitationAskUserBridge({
    idPrefix: 'claude-ask',
    withdraw: () => {},
    surface: request => {
      if (options.surfaceThrows) throw new Error(options.surfaceThrows);
      surfaced.push(request);
      waiters.splice(0).forEach(resolve => resolve(request));
    },
    permissionMode: () => options.mode ?? 'default',
    timeoutMs: () => options.timeoutMs,
  });
  const rig: Rig = {
    bridge,
    surfaced,
    approvals,
    debugLog,
    answer: (requestId, allowed) => {
      const resolve = pendingApprovals.get(requestId);
      if (!resolve) return false;
      pendingApprovals.delete(requestId);
      resolve({ allowed });
      return true;
    },
    canUseTool: buildClaudeCanUseTool({
      askUser: (request, signal) => bridge.ask(request, signal),
      askPermission: (request, signal) => {
        if (options.noPermissionHandler) {
          return Promise.reject(new Error('claude has no interactive permission handler.'));
        }
        approvals.push(request);
        return new Promise<ClaudeToolApprovalAnswer>(resolve => {
          if (signal?.aborted) return resolve({ allowed: false });
          signal?.addEventListener('abort', () => resolve({ allowed: false }), { once: true });
          pendingApprovals.set(request.requestId, resolve);
        });
      },
      alreadyApprovedByGate: () => false,
      permissionMode: () => options.mode ?? 'default',
      debug: message => debugLog.push(message),
    }),
    nextCard: () => {
      const existing = surfaced[surfaced.length - 1];
      if (existing) return Promise.resolve(existing);
      return new Promise(resolve => waiters.push(resolve));
    },
  };
  rigs.push(rig);
  return rig;
}

afterEach(() => {
  for (const rig of rigs.splice(0)) rig.bridge.cancelAll('test teardown');
});

const isAllow = (result: PermissionResult | null): result is Extract<PermissionResult, { behavior: 'allow' }> =>
  result?.behavior === 'allow';

// ===========================================================================

describe('R2 — the model can ask, and the answer reaches the turn', () => {
  it('routes AskUserQuestion to the user and returns their choice in the documented envelope', async () => {
    const rig = makeRig();
    const input = questionInput();
    const pending = rig.canUseTool(ASK_USER_QUESTION_TOOL, input, callOptions());

    const card = await rig.nextCard();
    // The card carries the whole batch, not a flattened first question: this is
    // the "our types match the SDK envelope field for field" claim, asserted.
    expect(card.askUser.questions).toHaveLength(2);
    expect(card.askUser.questions?.[0]).toEqual({
      question: FORMAT_Q,
      header: 'Format',
      options: [
        { label: 'Summary', description: 'Brief overview of key points' },
        { label: 'Detailed', description: 'Full explanation with examples', preview: '# Title\n…' },
      ],
    });
    expect(card.askUser.questions?.[1]?.multiSelect).toBe(true);
    // Legacy single-question projection, for a client that renders only that.
    expect(card.askUser.question).toBe(FORMAT_Q);
    expect(card.askUser.options).toEqual(['Summary', 'Detailed']);

    const answered = rig.bridge.respond(card.requestId, true, {
      type: 'batched',
      answers: { [FORMAT_Q]: 'Summary', [SECTIONS_Q]: ['Introduction', 'Conclusion'] },
    });
    expect(answered).toBe(true);

    const result = await pending;
    expect(isAllow(result)).toBe(true);
    if (!isAllow(result)) throw new Error('unreachable');
    // "Pass through the original questions array (required for tool processing)"
    expect(result.updatedInput?.questions).toEqual(input.questions);
    // "Object where keys are question text and values are selected labels",
    // multi-select joined because `AskUserQuestionOutput.answers` is typed
    // `{ [k: string]: string }` with "multi-select answers are comma-separated".
    expect(result.updatedInput?.answers).toEqual({
      [FORMAT_Q]: 'Summary',
      [SECTIONS_Q]: 'Introduction, Conclusion',
    });
    expect(result.updatedInput).not.toHaveProperty('response');
  });

  it('THE NEGATIVE CONTROL — the unrouted stub answers the question itself, with nothing', async () => {
    const rig = makeRig();
    const input = questionInput();

    // The before-state: no card, no wait, an immediate "allow" whose payload
    // carries no `answers` key at all. The tool would run with the questions it
    // asked and no answers to any of them, and the user would never see it.
    const stubbed = await PRE_R2_CAN_USE_TOOL(ASK_USER_QUESTION_TOOL, input, callOptions());
    expect(stubbed?.behavior).toBe('allow');
    expect(isAllow(stubbed) ? stubbed.updatedInput : undefined).not.toHaveProperty('answers');
    expect(rig.surfaced).toHaveLength(0);

    // The routed callback cannot do that: it does not settle until a human does.
    let settled = false;
    const pending = rig.canUseTool(ASK_USER_QUESTION_TOOL, input, callOptions())
      .then(result => { settled = true; return result; });
    const card = await rig.nextCard();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(rig.surfaced).toHaveLength(1);

    rig.bridge.respond(card.requestId, true, { type: 'batched', answers: { [FORMAT_Q]: 'Detailed' } });
    const result = await pending;
    expect(isAllow(result) ? result.updatedInput?.answers : undefined).toEqual({ [FORMAT_Q]: 'Detailed' });
  });

  it('a declined card denies rather than allowing an empty answer', async () => {
    const rig = makeRig();
    const pending = rig.canUseTool(ASK_USER_QUESTION_TOOL, questionInput(), callOptions());
    const card = await rig.nextCard();

    rig.bridge.respond(card.requestId, false);

    const result = await pending;
    expect(result?.behavior).toBe('deny');
    expect(result?.behavior === 'deny' && result.message).toContain('The question was not answered');
    // The stub would have allowed this same interaction with an empty payload.
    const stubbed = await PRE_R2_CAN_USE_TOOL(ASK_USER_QUESTION_TOOL, questionInput(), callOptions());
    expect(stubbed?.behavior).toBe('allow');
  });

  it('an answer the user could not have given is refused, not forwarded', async () => {
    const rig = makeRig();
    const pending = rig.canUseTool(ASK_USER_QUESTION_TOOL, questionInput(), callOptions());
    const card = await rig.nextCard();

    // Multi-select array against the single-select question: the bridge's own
    // validation rejects it, so an option the model never offered cannot reach
    // the turn wearing the user's name.
    rig.bridge.respond(card.requestId, true, {
      type: 'batched',
      answers: { [FORMAT_Q]: ['Summary', 'Detailed'] },
    });

    const result = await pending;
    expect(result?.behavior).toBe('deny');
  });

  it('a question that never reached a user denies instead of hanging', async () => {
    const rig = makeRig({ surfaceThrows: 'no interactive permission handler' });
    const result = await rig.canUseTool(ASK_USER_QUESTION_TOOL, questionInput(), callOptions());
    expect(result?.behavior).toBe('deny');
    expect(result?.behavior === 'deny' && result.message).toContain('never reached a user');
  });

  it('dontAsk denies the question without putting a card on screen', async () => {
    const rig = makeRig({ mode: 'dontAsk' });
    const result = await rig.canUseTool(ASK_USER_QUESTION_TOOL, questionInput(), callOptions());
    // "In `dontAsk` mode both cases are denied instead, because that mode never
    // prompts." (permissions.md)
    expect(result?.behavior).toBe('deny');
    expect(rig.surfaced).toHaveLength(0);
  });

  it('a malformed batch is refused by the shared validator, not surfaced', async () => {
    const rig = makeRig();
    const result = await rig.canUseTool(ASK_USER_QUESTION_TOOL, { questions: [] }, callOptions());
    expect(result?.behavior).toBe('deny');
    expect(result?.behavior === 'deny' && result.message).toContain('1-4 questions');
    expect(rig.surfaced).toHaveLength(0);
  });

  it("carries the user's askUserQuestionTimeout onto the card and back into the envelope", async () => {
    const rig = makeRig({ timeoutMs: 60_000 });
    const pending = rig.canUseTool(ASK_USER_QUESTION_TOOL, questionInput(), callOptions());
    const card = await rig.nextCard();
    // The bridge stamps the setting onto the request it surfaces, which is what
    // arms the renderer countdown. Asserted through the real route rather than
    // by handing the envelope a number: the stamp is a MUTATION of the request
    // object, so a defensive copy anywhere on this path would silently unarm it.
    expect(card.askUser.timeoutMs).toBe(60_000);

    rig.bridge.respond(card.requestId, true, {
      type: 'batched',
      answers: { [FORMAT_Q]: 'Summary' },
      autoContinued: true,
    });

    const result = await pending;
    expect(isAllow(result) ? result.updatedInput?.afkTimeoutMs : undefined).toBe(60_000);
    expect(isAllow(result) ? result.updatedInput?.answers : undefined).toEqual({ [FORMAT_Q]: 'Summary' });
  });

  it('an aborted turn settles the pending question instead of leaving it open', async () => {
    const rig = makeRig();
    const controller = new AbortController();
    const pending = rig.canUseTool(
      ASK_USER_QUESTION_TOOL,
      questionInput(),
      callOptions({ signal: controller.signal }),
    );
    await rig.nextCard();
    controller.abort();
    const result = await pending;
    expect(result?.behavior).toBe('deny');
  });
});

describe('R2 — subagents have no surface to ask through', () => {
  it('denies AskUserQuestion raised inside a subagent, and shows no card', async () => {
    const rig = makeRig();
    // "Subagents: `AskUserQuestion` is not currently available in subagents
    // spawned via the Agent tool." (user-input.md) The SDK withholds it today;
    // this is the enforcement point we own, so a vendor change cannot put a card
    // on screen out of a context the user has no frame for.
    const result = await rig.canUseTool(
      ASK_USER_QUESTION_TOOL,
      questionInput(),
      callOptions({ agentID: 'code-reviewer' }),
    );
    expect(result?.behavior).toBe('deny');
    expect(result?.behavior === 'deny' && result.message).toContain('not available to subagents');
    expect(rig.surfaced).toHaveLength(0);
  });

  it('the same call from the main thread is answered — the guard is agentID, not the tool', async () => {
    const rig = makeRig();
    const pending = rig.canUseTool(ASK_USER_QUESTION_TOOL, questionInput(), callOptions());
    const card = await rig.nextCard();
    rig.bridge.respond(card.requestId, true, { type: 'batched', answers: { [FORMAT_Q]: 'Summary' } });
    expect((await pending)?.behavior).toBe('allow');
  });
});

describe('R2 — the unconditional yes does not survive', () => {
  // The hazard R1's review named: `canUseTool` returned allow for EVERY tool,
  // and the three routes that reach it (an explicit `ask` rule, an org-`ask`
  // connector tool, an MCP tool marked `requiresUserInteraction`) are precisely
  // the routes that asked for a human.
  //
  // R2 refused those routes; R3 gives them the real card instead, so what this
  // block still owns is the invariant that survives both: a non-question tool
  // NEVER resolves itself. Whether it ends in a card or a refusal — and that a
  // blanket refusal would have been its own defect — is asserted in
  // `claude-can-use-tool-approval.test.ts`, the row that fixed it.
  const NON_QUESTION_TOOLS = [
    'Bash',
    'Write',
    'ExitPlanMode',
    'mcp__github__create_issue',
    'AskUserQuestionZ', // a near-miss name must not slip through the branch
  ];

  it.each(NON_QUESTION_TOOLS)('does not answer for %s — it waits for a person', async toolName => {
    const rig = makeRig();
    let settled = false;
    const pending = rig.canUseTool(toolName, { command: 'rm -rf /tmp/x' }, callOptions())
      .then(result => { settled = true; return result; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(rig.approvals).toHaveLength(1);
    // No clarifying-question card: this is a permission card, on the other route.
    expect(rig.surfaced).toHaveLength(0);

    rig.answer(rig.approvals[0]!.requestId, false);
    expect((await pending)?.behavior).toBe('deny');

    // The same call under the before-state: approved, silently, with no wait.
    const stubbed = await PRE_R2_CAN_USE_TOOL(toolName, { command: 'rm -rf /tmp/x' }, callOptions());
    expect(stubbed?.behavior).toBe('allow');
  });

  it('never returns null — a null parks the tool forever with no deadline', async () => {
    // The SDK's own warning on the return type: "Fail-closed: an accidental null
    // means no control_response is sent and the tool stays blocked indefinitely
    // — permission prompts have no park deadline." A rig with no handler settles
    // every route without a human, which is what makes the loop finite.
    const rig = makeRig({ noPermissionHandler: true });
    for (const toolName of [...NON_QUESTION_TOOLS, ASK_USER_QUESTION_TOOL]) {
      const result = await rig.canUseTool(toolName, {}, callOptions({ agentID: 'sub' }));
      expect(result).not.toBeNull();
      expect(result?.behavior).toBe('deny');
    }
  });
});

describe('R2 — the answer envelope', () => {
  const request = (): AskUserPermissionRequest => askUserRequestFromQuestionInput(questionInput());

  it('joins a multi-select selection because the SDK types answers as string', () => {
    const envelope = askUserQuestionAnswerEnvelope(
      questionInput(),
      { type: 'batched', answers: { [SECTIONS_Q]: ['Introduction', 'Conclusion'] } },
      request(),
    );
    expect(envelope.answers).toEqual({ [SECTIONS_Q]: 'Introduction, Conclusion' });
  });

  it('passes a freeform reply through `response`, which replaces the answer list', () => {
    const envelope = askUserQuestionAnswerEnvelope(
      questionInput(),
      { type: 'batched', answers: {}, response: 'Neither — start with the schema instead.' },
      request(),
    );
    expect(envelope.response).toBe('Neither — start with the schema instead.');
    expect(envelope.answers).toEqual({});
  });

  it('an auto-continue keeps its selections AND says the user was away', () => {
    const envelope = askUserQuestionAnswerEnvelope(
      questionInput(),
      { type: 'batched', answers: { [FORMAT_Q]: 'Summary' }, autoContinued: true },
      { ...request(), timeoutMs: 60_000 },
    );
    // `afkTimeoutMs` is the SDK's own away channel, so the selection survives.
    // Borrowing `response` — the only route the prose describes — would have
    // discarded it, because `response` replaces the per-question list.
    expect(envelope.afkTimeoutMs).toBe(60_000);
    expect(envelope.answers).toEqual({ [FORMAT_Q]: 'Summary' });
    expect(envelope).not.toHaveProperty('response');
  });

  it('an auto-continue with nothing selected says so rather than answering with silence', () => {
    const envelope = askUserQuestionAnswerEnvelope(
      questionInput(),
      { type: 'batched', answers: {}, autoContinued: true },
      { ...request(), timeoutMs: 60_000 },
    );
    expect(envelope.afkTimeoutMs).toBe(60_000);
    expect(String(envelope.response)).toContain('away from their keyboard');
  });

  it('maps the legacy single-question forms onto the first question, not onto `response`', () => {
    const option: AskUserAnswer = { type: 'option', value: 'Detailed', optionIndex: 1 };
    expect(askUserQuestionAnswerEnvelope(questionInput(), option, request()).answers)
      .toEqual({ [FORMAT_Q]: 'Detailed' });
    // The "Other" box: "Use the user's custom text as the answer value (not the
    // word 'Other')" — a per-question answer, not a card dismissal.
    const free: AskUserAnswer = { type: 'free_text', value: 'As a table' };
    const envelope = askUserQuestionAnswerEnvelope(questionInput(), free, request());
    expect(envelope.answers).toEqual({ [FORMAT_Q]: 'As a table' });
    expect(envelope).not.toHaveProperty('response');
  });

  it('preserves fields of the input it does not understand', () => {
    const input = { ...questionInput(), someFutureField: 42 };
    const envelope = askUserQuestionAnswerEnvelope(
      input,
      { type: 'batched', answers: { [FORMAT_Q]: 'Summary' } },
      request(),
    );
    expect(envelope.someFutureField).toBe(42);
  });
});

describe('R2 — one question, one card', () => {
  // The suppression is only correct if the gate really does classify this tool
  // as interaction-required. Asserted against the gate itself rather than
  // assumed, because the predicate silently stops suppressing anything the day
  // that classification moves — and the symptom would be a second card, not a
  // failure.
  const permissionManager: PermissionManagerLike = {
    isCommandWhitelisted: () => false,
    isDangerousCommand: () => false,
    getBaseCommand: command => command.split(/\s+/)[0] || command,
    extractDomainFromNetworkCommand: () => null,
    isDomainWhitelisted: () => false,
  };
  let sequence = 0;
  const gate = (toolName: string, mode: PermissionMode) => {
    sequence += 1;
    const sessionKey = { workspaceId: 'r2-double-prompt', sessionId: `r2-double-prompt-${sequence}` };
    initializeModeState(sessionKey, mode);
    try {
      return runPreToolUseChecks({
        toolName,
        input: questionInput(),
        sessionId: sessionKey.sessionId,
        sessionKey,
        alreadyApprovedByGate: () => false,
        permissionMode: mode,
        workspaceRootPath: '/tmp/r2-double-prompt',
        permissionManager,
      } as never);
    } finally {
      cleanupModeState(sessionKey);
    }
  };

  it('the shared gate does classify AskUserQuestion as interaction-required', () => {
    const outcome = gate(ASK_USER_QUESTION_TOOL, 'default');
    expect(outcome.type).toBe('prompt');
    expect(outcome.type === 'prompt' && outcome.nonNegotiable).toBe('requiresUserInteraction');
  });

  it('that prompt is deferred to canUseTool instead of raising our own card', () => {
    expect(askUserQuestionPromptBelongsToCanUseTool(ASK_USER_QUESTION_TOOL, gate(ASK_USER_QUESTION_TOOL, 'default')))
      .toBe(true);
  });

  it('bypassPermissions does not exempt it either — the same defer applies', () => {
    // The mode this runtime pinned for every session until R3 removed the pin,
    // and still a mode a user can choose. `permissions.md`'s bypass row keeps
    // "tools that require user interaction" out of the bypass, and so does the
    // gate, so the deferral has to hold there too.
    expect(askUserQuestionPromptBelongsToCanUseTool(
      ASK_USER_QUESTION_TOOL,
      gate(ASK_USER_QUESTION_TOOL, 'bypassPermissions'),
    )).toBe(true);
  });

  it('dontAsk never reaches the deferral — the gate blocks it outright', () => {
    const outcome = gate(ASK_USER_QUESTION_TOOL, 'dontAsk');
    expect(outcome.type).toBe('block');
    expect(askUserQuestionPromptBelongsToCanUseTool(ASK_USER_QUESTION_TOOL, outcome)).toBe(false);
  });

  it('nothing else is deferred — every other prompt still shows its card', () => {
    // Another tool with the same floor: Pi's own ask surface, which must keep
    // its card because nothing downstream will raise it.
    expect(askUserQuestionPromptBelongsToCanUseTool('ask_user', gate('ask_user', 'default'))).toBe(false);
    // The same tool under a different prompt class is not deferred either.
    for (const nonNegotiable of ['askRule', 'protectedPath', 'removalCircuitBreaker', undefined] as const) {
      expect(askUserQuestionPromptBelongsToCanUseTool(ASK_USER_QUESTION_TOOL, {
        type: 'prompt',
        promptType: 'bash',
        description: 'd',
        ...(nonNegotiable ? { nonNegotiable } : {}),
      })).toBe(false);
    }
    // And a non-prompt outcome is never a card in the first place.
    expect(askUserQuestionPromptBelongsToCanUseTool(ASK_USER_QUESTION_TOOL, { type: 'allow' })).toBe(false);
  });
});

describe('R2 — the tool is no longer banned, and drift fails by name', () => {
  it('AskUserQuestion is not in the session tool ban', () => {
    expect(CLAUDE_SESSION_DISALLOWED_TOOLS).not.toContain(ASK_USER_QUESTION_TOOL);
    // The other bans are deliberate and stay; this asserts the row removed one
    // entry rather than emptying the list. `Monitor` joined in T3 — the child's
    // NATIVE one, banned so the only Monitor on a Claude card is ours
    // (`mcp__session__Monitor`), whose start passes T2's host-side gate. Listing
    // the whole set rather than spot-checking is the point: an entry added here
    // silently removes a tool from every Claude session.
    expect([...CLAUDE_SESSION_DISALLOWED_TOOLS]).toEqual([
      'EnterPlanMode',
      'ExitPlanMode',
      // F1.862 — Skill lifted: Claude's own Skill tool serves the skills Claude Code loads.
      'Monitor',
      // P2.512 — the child's native `ScheduleWakeup`. It is the one projected
      // name whose built-in is still on the surface AND whose native arm is a
      // silent no-op; why the other five stay off this list, tool by tool, is
      // recorded on the entry itself and pinned in
      // `claude-native-tool-collisions.test.ts`.
      'ScheduleWakeup',
      // F1.253 (2026-09-23) — the four claude.ai cloud tools, denied on every
      // card; reviewed against `sdk-tools.d.ts` in `claude-cloud-tools-disallowed.test.ts`.
      'Artifact', 'ClaudeDesign', 'Projects', 'RemoteTrigger',
    ]);
  });

  it('the envelope fields exist in the installed SDK tool typings', () => {
    // R1's pattern: read the union/interface out of the SDK at run time so a
    // rename fails HERE, by name, instead of arriving as an envelope the tool
    // quietly ignores. This is what caught `afkTimeoutMs`, which no page
    // mentions, and the `answers: { [k: string]: string }` narrowing that
    // contradicts the page's "pass an array of labels".
    const sdkEntry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
    const typings = readFileSync(
      `${sdkEntry.slice(0, sdkEntry.lastIndexOf('/'))}/sdk-tools.d.ts`,
      'utf8',
    );
    const output = typings.slice(typings.indexOf('export interface AskUserQuestionOutput {'));
    expect(output.startsWith('export interface AskUserQuestionOutput {')).toBe(true);
    const body = output.slice(0, output.indexOf('\nexport interface ', 1));
    for (const field of ['questions:', 'answers:', 'response?:', 'afkTimeoutMs?:']) {
      expect(body).toContain(field);
    }
    expect(body).toContain('[k: string]: string;');
    expect(typings).toContain('export interface AskUserQuestionInput {');
  });

  it('reads header, preview and multiSelect off the SDK input rather than dropping them', () => {
    const parsed = askUserRequestFromQuestionInput(questionInput());
    expect(parsed.questions?.[0]?.header).toBe('Format');
    expect(parsed.questions?.[0]?.options[1]?.preview).toBe('# Title\n…');
    expect(parsed.questions?.[1]?.multiSelect).toBe(true);
    // The documented "Other" flow needs free text on every question card.
    expect(parsed.allowFreeText).toBe(true);
  });
});
