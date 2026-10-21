/**
 * R1 — our permission decisions must speak the SDK's own vocabulary.
 *
 * Measured before the change (2026-08-16, `grep -a permissionDecision` over the
 * whole of `claude-agent.ts`): zero hits. The allow path returned
 * `{ continue: true }` and named no decision; the trusted-hook ask path
 * returned a top-level `decision: 'ask'`, which is not one of the two
 * deprecated top-level values `hooks.md` still honours for this event
 * ("approve" and "block"), so it named no decision either. Only the deny path
 * already spoke the vocabulary, from `mode-manager.ts`.
 *
 * Both omissions are invisible today because `permissionMode:
 * 'bypassPermissions'` means there is no prompt to skip or to force. R3 removes
 * that bypass, and at that moment an allow carrying no `permissionDecision`
 * falls through to normal permission evaluation — Safe Mode would start
 * prompting on every read-only bash command it had just approved. The negative
 * control below is that regression, written down.
 *
 * What this suite can and cannot prove, stated plainly: the SDK's own
 * interpretation of a hook payload lives in the native `claude` binary
 * (`sdk.mjs` has zero references to `permissionDecision`), so no unit test can
 * execute it. `documentedOutcome` below is a model of `hooks.md`'s sentences,
 * quoted at each rule. It proves that our payload means "skip the prompt"
 * under the documented reading and that the pre-R1 payload did not; it does not
 * prove the binary implements the page. The behaviour half of that belongs to
 * R3's live case.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { HookPermissionDecision } from '@anthropic-ai/claude-agent-sdk';
import { buildClaudePreToolUseContinue, TRUSTED_HOOK_ASK_REASON } from '../claude-agent.ts';
import { blockWithReason, denyToolWithReason } from '../mode-manager.ts';

// ---------------------------------------------------------------------------
// The vocabulary itself, taken from the SDK rather than from string literals.
//
// Compile-time: these three consts are typed `HookPermissionDecision`, so a
// rename or removal in the SDK's union fails `typecheck:shared` here rather
// than shipping a payload the runtime ignores. Every expectation below compares
// against these, never against a bare `'allow'`.
// ---------------------------------------------------------------------------
const ALLOW: HookPermissionDecision = 'allow';
const ASK: HookPermissionDecision = 'ask';
const DENY: HookPermissionDecision = 'deny';
const DEFER: HookPermissionDecision = 'defer';

/** The `HookPermissionDecision` members, read from the installed SDK typings. */
function readSdkPermissionDecisions(): string[] {
  const sdkEntry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
  const typingsPath = `${sdkEntry.slice(0, sdkEntry.lastIndexOf('/'))}/sdk.d.ts`;
  const source = readFileSync(typingsPath, 'utf8');
  const match = source.match(/^export declare type HookPermissionDecision = (.+?);$/m);
  if (!match) throw new Error(`Could not find HookPermissionDecision in ${typingsPath}`);
  return match[1]!.split('|').map(value => value.trim().replace(/^'|'$/g, ''));
}

type PayloadLike = {
  continue?: boolean;
  decision?: string;
  reason?: string;
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
  };
};

const specific = (payload: PayloadLike) => payload.hookSpecificOutput;

// ---------------------------------------------------------------------------
// The payloads this row replaced. Copied from the shape `continueWith` built
// before R1 (claude-agent.ts, allow arm and trusted-hook ask arm), so the
// negative control measures the real before-state and not a straw man.
// ---------------------------------------------------------------------------
const PRE_R1_ALLOW: PayloadLike = { continue: true };
const PRE_R1_ALLOW_WITH_CONTEXT: PayloadLike = {
  continue: true,
  hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'a rule just activated' },
};
const PRE_R1_ASK: PayloadLike = {
  continue: true,
  decision: 'ask',
  reason: 'Approval requested by a trusted PreToolUse hook',
};

// ---------------------------------------------------------------------------
// A model of hooks.md's PreToolUse decision control, built only from these
// sentences. Each rule carries the sentence it comes from.
// ---------------------------------------------------------------------------
type DocumentedOutcome =
  | 'prompt-skipped'
  | 'prompt-forced'
  | 'call-prevented'
  | 'deferred'
  | 'permission-system-decides';

/**
 * "`AskUserQuestion` and `ExitPlanMode` require user interaction and normally
 * block in non-interactive mode with the `-p` flag."
 */
const REQUIRES_USER_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

function documentedOutcome(payloads: readonly PayloadLike[], toolName: string): DocumentedOutcome {
  const decisions: string[] = [];
  for (const payload of payloads) {
    const output = specific(payload);
    // "Unlike other hooks that use a top-level `decision` field, PreToolUse
    // returns its decision inside a `hookSpecificOutput` object."
    if (output?.hookEventName === 'PreToolUse' && typeof output.permissionDecision === 'string') {
      decisions.push(output.permissionDecision);
      continue;
    }
    // "PreToolUse previously used top-level `decision` and `reason` fields, but
    // these are deprecated for this event. … The deprecated values `"approve"`
    // and `"block"` map to `"allow"` and `"deny"` respectively." Those two and
    // no others — which is why a top-level `decision: 'ask'` names nothing.
    if (payload.decision === 'approve') decisions.push(ALLOW);
    else if (payload.decision === 'block') decisions.push(DENY);
  }

  // No decision named at all: the hook has said nothing, and the tool goes to
  // the runtime's normal permission evaluation. Under `bypassPermissions` that
  // is a no-op; without it, it is a prompt in every mode that prompts.
  if (decisions.length === 0) return 'permission-system-decides';

  // "When multiple PreToolUse hooks return different decisions, precedence is
  // `deny` > `defer` > `ask` > `allow`."
  if (decisions.includes(DENY)) return 'call-prevented';
  if (decisions.includes(DEFER)) return 'deferred';
  if (decisions.includes(ASK)) return 'prompt-forced';

  // Only allows remain. "`"allow"` skips the permission prompt, except for
  // tools that require user interaction …" — and for those, "Returning
  // `"allow"` alone is not sufficient …: the hook reads the tool's input from
  // stdin, collects the answer through your own UI, and returns it in
  // `updatedInput`".
  if (REQUIRES_USER_INTERACTION.has(toolName)) {
    const answered = payloads.some(payload => {
      const output = specific(payload);
      return output?.permissionDecision === ALLOW && output.updatedInput !== undefined;
    });
    return answered ? 'prompt-skipped' : 'prompt-forced';
  }
  return 'prompt-skipped';
}

describe('R1: the PreToolUse payload names its decision in the SDK vocabulary', () => {
  const sdkDecisions = readSdkPermissionDecisions();

  it('reads its vocabulary from the SDK union, which still has the four documented members', () => {
    // Drift guard, the same technique R8 used on `SDKMessage`: a rename or a
    // new member fails here by name instead of silently arriving.
    expect(sdkDecisions).toEqual([ALLOW, DENY, ASK, DEFER]);
  });

  it('emits allow, ask and deny as members of that union', () => {
    const allow = buildClaudePreToolUseContinue({})();
    const ask = buildClaudePreToolUseContinue({ hookDecision: 'ask' })();
    const deny = denyToolWithReason('no');

    for (const payload of [allow, ask, deny] as PayloadLike[]) {
      expect(specific(payload)?.hookEventName).toBe('PreToolUse');
      // `'(absent)'` rather than `undefined` so a missing field fails as
      // "the payload named no decision" instead of as a type error.
      expect(sdkDecisions).toContain(specific(payload)?.permissionDecision ?? '(absent)');
    }
    expect(specific(allow as PayloadLike)?.permissionDecision).toBe(ALLOW);
    expect(specific(ask as PayloadLike)?.permissionDecision).toBe(ASK);
    expect(specific(deny as PayloadLike)?.permissionDecision).toBe(DENY);
  });

  it('puts the reason where the SDK reads it, and only where it is shown', () => {
    // "For `"allow"` and `"ask"`, shown to the user but not Claude. For
    // `"deny"`, shown to Claude."
    const askWithReason = buildClaudePreToolUseContinue({
      hookDecision: 'ask',
      hookReason: 'the pre-commit automation wants a look',
    })() as PayloadLike;
    expect(specific(askWithReason)?.permissionDecisionReason).toBe('the pre-commit automation wants a look');

    const askWithoutReason = buildClaudePreToolUseContinue({ hookDecision: 'ask' })() as PayloadLike;
    expect(specific(askWithoutReason)?.permissionDecisionReason).toBe(TRUSTED_HOOK_ASK_REASON);

    // An allow carries no reason: the prompt it skips has no user to show one to.
    const allow = buildClaudePreToolUseContinue({ hookReason: 'unused' })() as PayloadLike;
    expect(specific(allow)?.permissionDecisionReason).toBeUndefined();

    // Deny's reason is the one Claude reads, and it keeps its own channel.
    expect(specific(denyToolWithReason('private key path') as PayloadLike)?.permissionDecisionReason)
      .toBe('private key path');
    expect(specific(blockWithReason('read-only mode') as PayloadLike)?.permissionDecisionReason)
      .toBe('[ERROR] read-only mode');
  });

  it('no longer names a decision in the deprecated top-level field', () => {
    const payloads = [
      buildClaudePreToolUseContinue({})(),
      buildClaudePreToolUseContinue({ hookDecision: 'ask' })(),
      denyToolWithReason('no'),
    ] as PayloadLike[];
    for (const payload of payloads) {
      expect('decision' in payload).toBe(false);
      expect('reason' in payload).toBe(false);
    }
  });
});

describe('R1: the same decisions, only expressed differently', () => {
  it('allows when no trusted hook asked, and when one explicitly allowed', () => {
    expect(specific(buildClaudePreToolUseContinue({})() as PayloadLike)?.permissionDecision).toBe(ALLOW);
    expect(specific(buildClaudePreToolUseContinue({ hookDecision: 'allow' })() as PayloadLike)?.permissionDecision)
      .toBe(ALLOW);
  });

  it('asks when a trusted hook asked, and allows once a Nessy approval satisfied it', () => {
    // The second argument is `hookAskAlreadyApproved`, set only by the prompt
    // arm after the user clicked approve: "One Nessy approval satisfies both
    // the core prompt and a restrictive trusted-hook ask floor for this exact
    // input." That was already true before R1 and stays true.
    const asking = buildClaudePreToolUseContinue({ hookDecision: 'ask' })() as PayloadLike;
    const approved = buildClaudePreToolUseContinue({ hookDecision: 'ask' })(undefined, true) as PayloadLike;
    expect(specific(asking)?.permissionDecision).toBe(ASK);
    expect(specific(approved)?.permissionDecision).toBe(ALLOW);
    expect(specific(approved)?.permissionDecisionReason).toBeUndefined();
  });

  it('keeps continue true and passes the whole rewritten input through', () => {
    // "`updatedInput` … Replaces the entire input object, so include unchanged
    // fields alongside modified ones." The callers hand over the resolved input
    // object, never a patch, so this is a verbatim passthrough.
    const rewritten = { command: 'ls -la', description: 'list', timeout: 5_000 };
    const payload = buildClaudePreToolUseContinue({})(rewritten) as PayloadLike;
    expect(payload.continue).toBe(true);
    expect(specific(payload)?.updatedInput).toEqual(rewritten);
    // Absent when nothing was rewritten — an unchanged call must not be
    // re-described to the runtime.
    expect(specific(buildClaudePreToolUseContinue({})() as PayloadLike)?.updatedInput).toBeUndefined();
  });

  it('keeps the additional-context channel on every arm', () => {
    // Steer messages and path-scoped rule bodies ride this field; before R1 it
    // was the only reason `hookSpecificOutput` existed at all on an allow.
    const context = 'The user just sent a new message while you were working.';
    for (const build of [
      buildClaudePreToolUseContinue({ additionalContext: context }),
      buildClaudePreToolUseContinue({ additionalContext: context, hookDecision: 'ask' }),
    ]) {
      expect(specific(build() as PayloadLike)?.additionalContext).toBe(context);
      expect(specific(build({ command: 'ls' }) as PayloadLike)?.additionalContext).toBe(context);
    }
    expect(specific(buildClaudePreToolUseContinue({})() as PayloadLike)?.additionalContext).toBeUndefined();
  });
});

describe('R1: negative control — the payload this replaced does not skip a prompt', () => {
  it('the pre-R1 allow named no decision, so the permission system still decides', () => {
    // THE ROW'S PROOF. This is the Safe Mode regression R3 would have shipped:
    // our gate has approved a read-only `ls`, and the payload says nothing that
    // would stop the runtime asking the user about it anyway.
    expect(documentedOutcome([PRE_R1_ALLOW], 'Bash')).toBe('permission-system-decides');
    expect(documentedOutcome([PRE_R1_ALLOW], 'Bash')).not.toBe('prompt-skipped');
    // Carrying `additionalContext` did not help: the object existed, the
    // decision was still missing.
    expect(documentedOutcome([PRE_R1_ALLOW_WITH_CONTEXT], 'Bash')).toBe('permission-system-decides');

    // Today's payload, same call, same decision.
    expect(documentedOutcome([buildClaudePreToolUseContinue({})()], 'Bash')).toBe('prompt-skipped');
    expect(documentedOutcome([buildClaudePreToolUseContinue({ additionalContext: 'ctx' })()], 'Bash'))
      .toBe('prompt-skipped');
  });

  it('the pre-R1 ask named no decision either, so it forced no prompt', () => {
    // `decision: 'ask'` is not among the deprecated top-level values, so the
    // trusted hook's restrictive floor reached the runtime as silence.
    expect(documentedOutcome([PRE_R1_ASK], 'Bash')).toBe('permission-system-decides');
    expect(documentedOutcome([buildClaudePreToolUseContinue({ hookDecision: 'ask' })()], 'Bash'))
      .toBe('prompt-forced');
  });

  it('a deny prevents the call, before and after — that path never needed fixing', () => {
    expect(documentedOutcome([denyToolWithReason('nope')], 'Bash')).toBe('call-prevented');
    expect(documentedOutcome([blockWithReason('read-only mode')], 'Bash')).toBe('call-prevented');
  });

  it('reads the decision rather than the shape: four decisions, four outcomes', () => {
    // Guards the model above from degenerating into "anything with a
    // hookSpecificOutput is allowed".
    const shaped = (permissionDecision: string): PayloadLike =>
      ({ continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision } });
    expect([ALLOW, ASK, DENY, DEFER].map(decision => documentedOutcome([shaped(decision)], 'Bash')))
      .toEqual(['prompt-skipped', 'prompt-forced', 'call-prevented', 'deferred']);
    // And an unrelated event's output is not read as a PreToolUse decision.
    expect(documentedOutcome([{ hookSpecificOutput: { hookEventName: 'PostToolUse', permissionDecision: ALLOW } }], 'Bash'))
      .toBe('permission-system-decides');
  });

  it('honours the documented precedence when several hooks answer', () => {
    // "precedence is `deny` > `defer` > `ask` > `allow`". Our own merge keeps a
    // single PreToolUse callback (`mergeClaudeSdkHooks` drops the trusted
    // event), so today only the runtime's other sources can produce a second
    // answer — the ordering is the SDK's, pinned here so a future row that adds
    // a second hook inherits it stated rather than assumed.
    const allow = buildClaudePreToolUseContinue({})();
    const ask = buildClaudePreToolUseContinue({ hookDecision: 'ask' })();
    const deny = denyToolWithReason('no');
    expect(documentedOutcome([allow, deny], 'Bash')).toBe('call-prevented');
    expect(documentedOutcome([allow, ask], 'Bash')).toBe('prompt-forced');
    expect(documentedOutcome([ask, deny], 'Bash')).toBe('call-prevented');
  });

  it('an allow does not skip the prompt for a tool that requires user interaction', () => {
    // The carve-out in the same field table, and the reason R2 exists: routing
    // `canUseTool` is not something a better hook payload can substitute for.
    // "Returning `"allow"` alone is not sufficient for these tools."
    const allow = buildClaudePreToolUseContinue({})();
    expect(documentedOutcome([allow], 'AskUserQuestion')).toBe('prompt-forced');
    expect(documentedOutcome([allow], 'ExitPlanMode')).toBe('prompt-forced');
    const answered = buildClaudePreToolUseContinue({})({ questions: [], answers: { 'Which?': 'A' } });
    expect(documentedOutcome([answered], 'AskUserQuestion')).toBe('prompt-skipped');
  });
});

describe('R1: the hook callback is wired to the builder', () => {
  const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');

  it('binds continueWith to the exported builder', () => {
    // Without this, the suite above would prove a function nothing calls. F1.238 wraps it in the steer delivery.
    expect(source).toContain('const continueWith = this.deliverPendingSteersOn(buildClaudePreToolUseContinue({');
  });

  it('every return in the decision switch is one of the three decision payloads', () => {
    const start = source.indexOf('switch (checkResult.type) {');
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let index = source.indexOf('{', start);
    const open = index;
    for (; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      else if (source[index] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const region = source.slice(open, index + 1);

    const callees = [...region.matchAll(/return\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(match => match[1]);
    expect(callees.length).toBeGreaterThan(0);
    expect([...new Set(callees)].sort())
      .toEqual(['blockWithReason', 'continueWith', 'denyToolWithReason']);

    // Every arm of the result union is still handled here, so a new one cannot
    // be added without choosing a decision for it.
    expect([...region.matchAll(/case '([a-z_]+)'/g)].map(match => match[1])).toEqual([
      'allow', 'modify', 'block', 'source_activation_needed',
      'call_llm_intercept', 'prompt',
    ]);
  });

  it('leaves no top-level ask decision in the code — only in the note explaining it', () => {
    // Comment lines are stripped: the JSDoc on the builder quotes the old
    // shape on purpose, and that quotation is the record of why R1 exists.
    const code = source
      .split('\n')
      .filter(line => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toContain("decision: 'ask'");
    // The stripper is doing something: the note is still in the raw source.
    expect(source).toContain("decision: 'ask'");
  });
});
