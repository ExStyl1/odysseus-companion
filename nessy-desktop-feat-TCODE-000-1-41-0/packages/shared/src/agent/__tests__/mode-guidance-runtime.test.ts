/**
 * P3.238 — the `modeGuidance` line is read by the MODEL, and on codex two of its
 * sentences were false.
 *
 * `formatModeGuidance` was runtime-independent, so a codex session was told in
 * `explore` that "file edits and other mutations are blocked" — nothing of ours
 * blocks them there (`runPreToolUseChecks` scores 0 in `codex-agent.ts`, against
 * pi 10 and claude 2, and with the standing sandbox-off default
 * `codexSandboxConfigForMode` emits `danger-full-access`, under which codex's own
 * `assess_patch_safety` auto-approves rather than asking us) — and in both
 * `explore` and `plan` to "call SubmitPlan", which codex never advertises
 * (driven against the real `session-mcp-server`: 27 tools without it under
 * `CodexAgent`'s own argv, 45 tools WITH it when `--external-standalone-only` is
 * dropped).
 *
 * The fix makes the guidance true per runtime; it does not change what the model
 * MAY do. Both halves are pinned below, because the second is the one a later
 * edit is most likely to break by accident: the codex line still forbids edits,
 * it just stops calling the prohibition a block.
 *
 * Every codex assertion here carries its non-codex twin as a positive control on
 * the same call, so an assertion that stopped reaching the guidance at all would
 * fail rather than pass vacuously.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanupModeState, formatSessionState, initializeModeState } from '../mode-manager.ts';
import { PERMISSION_MODE_AGENT_LABELS, PERMISSION_MODE_ORDER } from '../mode-types.ts';
import type { PermissionMode } from '../mode-types.ts';
import type { SessionKey } from '../../sessions/session-key.ts';
import { PromptBuilder } from '../core/prompt-builder.ts';
import { TestAgent, createMockBackendConfig, createMockSession, createMockWorkspace } from './test-utils.ts';

/**
 * The seam under test is `BaseAgent`'s own constructor line, so the probes have
 * to be real `BaseAgent` subclasses: `backendName` is a protected subclass field
 * and the whole point of the thunk is that it is read AFTER construction.
 * `TestAgent` already supplies every abstract member; these add only the name
 * and one accessor.
 */
class PlainTestAgent extends TestAgent {
  volatileSessionStateBlock(): string {
    const block = this.promptBuilder
      .buildVolatileContextParts({ plansFolderPath: '/tmp/plans', dataFolderPath: '/tmp/data' })
      .find(part => part.includes('<session_state>'));
    expect(block).toBeDefined();
    return block!;
  }
}

class CodexNamedTestAgent extends PlainTestAgent {
  protected backendName = 'Codex';
}

const key = (sessionId: string): SessionKey => ({ workspaceId: 'ws-mode-guidance-runtime', sessionId });

/** The one `modeGuidance:` line out of a session-state block. */
function guidanceLine(mode: PermissionMode, backendName?: string): string {
  const k = key(`guidance-${mode}-${backendName ?? 'none'}-${Date.now()}-${Math.random()}`);
  initializeModeState(k, mode);
  try {
    const lines = formatSessionState(k, {
      plansFolderPath: '/tmp/plans',
      dataFolderPath: '/tmp/data',
      ...(backendName ? { backendName } : {}),
    }).split('\n').filter(line => line.startsWith('modeGuidance:'));
    expect(lines).toHaveLength(1);
    return lines[0]!;
  } finally {
    cleanupModeState(k);
  }
}

describe('P3.238 · modeGuidance on codex says only what codex can back', () => {
  // F1.1050 (DN-272) deleted this describe's two explore arms ("explore no longer calls file edits blocked" and
  // "explore names an exit that exists") with the retired mode; plan's own pair of pins follows.
  it('plan drops both the block claim and SubmitPlan, and keeps the plan persona', () => {
    const codex = guidanceLine('plan', 'Codex');
    const control = guidanceLine('plan');

    expect(control).toContain('file changes are blocked');
    expect(control).toContain('call SubmitPlan when it is ready to proceed');
    expect(codex).not.toContain('blocked');
    expect(codex).not.toContain('call SubmitPlan');
    expect(codex).toContain('there is no SubmitPlan tool here');

    // Planning is not doing — the persona is the half that was never wrong.
    expect(codex).toContain('Planning is not doing');
    expect(codex).toContain('refines the plan rather than ending plan mode');
    expect(codex).toContain('The deliverable is the plan itself');
  });

  it('both codex lines say WHY, in the same words the composer tells the user', () => {
    // `chat.permissionModeRuntimeNote.codex`: "On Codex the runtime decides
    // which actions to raise — Nessy checks each raised action against its own
    // limits and rules before it runs." (That quote carried an "except in
    // Bypass" tail until P6.572 removed it; the footer's Bypass half is pinned
    // by the two cases at the end of this file, not by this one, which is about
    // the FIRST sentence — the one the model's own explore/plan lines mirror.)
    // TRANSPARENT: the runtime-specific clause is visible in the prompt we build,
    // not an undocumented silence the model has to infer from a failed edit.
    //
    // P3.328: this assertion pinned "Nessy does not check each action before it
    // runs" until P2.197 made it false — codex raises everything under
    // `untrusted` and the host answers each raised action with its floors and
    // rules first. The pin now names the corrected clause, and the NEGATIVE pin
    // below is what keeps the old sentence from coming back on any line.
    for (const mode of ['plan'] as const) {
      const codex = guidanceLine(mode, 'Codex');
      expect(codex).toContain('the runtime decides which actions to raise');
      expect(codex).toContain('Nessy checks each raised action against its own limits and rules before it runs');
      expect(guidanceLine(mode)).not.toContain('Nessy checks each raised action');
    }
    for (const mode of PERMISSION_MODE_ORDER) {
      for (const backendName of [undefined, 'Codex'] as const) {
        expect(guidanceLine(mode, backendName), `${mode}/${backendName ?? 'runtime-independent'}`)
          .not.toContain('Nessy does not check each action before it runs');
      }
    }
  });

  it('every mode still emits exactly one line opening with its pinned label, codex included', () => {
    // `guidanceLine` already asserts the one-line invariant; this adds the label.
    for (const mode of PERMISSION_MODE_ORDER) {
      for (const backendName of [undefined, 'Codex'] as const) {
        expect(guidanceLine(mode, backendName))
          .toStartWith(`modeGuidance: ${PERMISSION_MODE_AGENT_LABELS[mode]} mode — `);
      }
    }
  });

  it('the other four modes are byte-identical on codex — no silent widening', () => {
    // `default` and `acceptEdits` promise a prompt codex does not guarantee
    // either. That is a wider statement than this row, so it is recorded as its
    // own row rather than smuggled in here; this test is what will fail if
    // someone smuggles it in.
    //
    // `auto` LEFT this set at P6.201, and it left it through its own row rather
    // than by accident — which is exactly the event this assertion exists to
    // catch. What diverges there is not the prompt guarantee this test guards
    // (codex's line says nothing new about what prompts) but what a RUN of
    // denials does afterwards: on codex the breaker only reports, and the
    // shipped line said nothing at all. Its own assertions are in the P6.201
    // block below, and the count in this title moved with it.
    for (const mode of PERMISSION_MODE_ORDER) {
      if (mode === 'plan' || mode === 'auto') continue;
      expect(guidanceLine(mode, 'Codex')).toBe(guidanceLine(mode));
    }
  });

  it('only Codex diverges — every other backend name keeps the shipped wording', () => {
    // Scoped to `explore` and `plan`, which is P3.238's pair. P6.201's `auto`
    // clause diverges on THREE runtimes deliberately, so it is asserted there.
    for (const backendName of ['Claude', 'Nessy Backend', 'Nestor Cloud', 'Test']) {
      for (const mode of ['plan'] as const) {
        expect(guidanceLine(mode, backendName)).toBe(guidanceLine(mode));
      }
    }
  });
});

describe('P3.238 · the seam carries the runtime name from the agent to the block', () => {
  function builderFor(sessionId: string): PromptBuilder {
    return new PromptBuilder({
      workspace: createMockWorkspace(),
      session: createMockSession({ id: sessionId }),
      isHeadless: true,
    });
  }

  function stateBlock(b: PromptBuilder): string {
    const block = b.buildVolatileContextParts({ plansFolderPath: '/tmp/plans', dataFolderPath: '/tmp/data' })
      .find(part => part.includes('<session_state>'));
    expect(block).toBeDefined();
    return block!;
  }

  it('plan through the builder: a registered Codex provider changes the line, an unregistered builder does not', () => {
    const sessionId = `seam-plan-${Date.now()}`;
    const k: SessionKey = { workspaceId: 'test-workspace-id', sessionId };
    initializeModeState(k, 'plan'); // F1.1050: this rig drove the retired explore
    try {
      const withCodex = builderFor(sessionId);
      withCodex.setBackendNameProvider(() => 'Codex');
      // Same session, same mode state — so any difference between the two blocks
      // can only have come from the runtime name.
      const bare = builderFor(sessionId);

      const codexBlock = stateBlock(withCodex);
      const bareBlock = stateBlock(bare);

      expect(bareBlock).toContain('file changes are blocked');
      expect(bareBlock).toContain('call SubmitPlan');
      expect(codexBlock).toContain('there is no SubmitPlan tool here');
      expect(codexBlock).not.toContain('call SubmitPlan');
      expect(codexBlock).not.toContain('blocked');
    } finally {
      cleanupModeState(k);
    }
  });

  it('a provider that throws costs the turn the runtime clause, never the session-state block', () => {
    // Fails OPEN by design: the block also carries plansFolderPath, the mode name
    // and the one-shot mode-change signal, and losing all of that to a bad thunk
    // would be strictly worse than losing one clause.
    const sessionId = `seam-throw-${Date.now()}`;
    const k: SessionKey = { workspaceId: 'test-workspace-id', sessionId };
    initializeModeState(k, 'plan');
    try {
      const b = builderFor(sessionId);
      b.setBackendNameProvider(() => { throw new Error('no runtime'); });
      const block = stateBlock(b);
      expect(block).toContain('modeGuidance: Plan mode \u2014 read-only planning.');
      expect(block).toContain('plansFolderPath: /tmp/plans');
    } finally {
      cleanupModeState(k);
    }
  });

  it('BaseAgent registers the provider itself, so no backend has to remember to', () => {
    // The registration is one line in the BaseAgent constructor and nothing else
    // calls it; if it is dropped, every runtime silently reverts to the
    // runtime-independent wording and nothing else in this file notices.
    const sessionId = `seam-agent-${Date.now()}`;
    const k: SessionKey = { workspaceId: 'test-workspace-id', sessionId };
    initializeModeState(k, 'plan');
    try {
      const codexBlock = new CodexNamedTestAgent(createMockBackendConfig({
        session: createMockSession({ id: sessionId }),
      })).volatileSessionStateBlock();
      // Positive control on the same rig: an agent whose backendName is not
      // 'Codex' still reaches the guidance through the same seam, and keeps the
      // shipped wording.
      const plainBlock = new PlainTestAgent(createMockBackendConfig({
        session: createMockSession({ id: sessionId }),
      })).volatileSessionStateBlock();

      expect(codexBlock).toContain('there is no SubmitPlan tool here');
      expect(codexBlock).not.toContain('call SubmitPlan');
      expect(plainBlock).toContain('call SubmitPlan');
      expect(plainBlock).toContain('file changes are blocked');
    } finally {
      cleanupModeState(k);
    }
  });
});

// ============================================================
// P6.69 — the composer's own sentences, pinned the way this file pins the
// model's.
//
// The block above pins what the MODEL is told on codex. This one pins what the
// USER is told, in the very file that decides those strings, because that file
// is where the sentence outlived its subject: `composer-permission-modes.ts`
// carried *"Codex — nothing of ours sees the call first. Measured 2026-08-16:
// `grep -ac runPreToolUseChecks … → 0"* for two landed measurements after it
// stopped being the whole truth. P2.140 extracted the non-negotiable floors and
// P2.197 made `untrusted` raise the calls, so every action codex DOES raise is
// scored by the shared floor seam, by the `deniedPaths` refusal (P6.62) and by
// the user's own rules before it runs.
//
// Shaped like the assertions above rather than as a bare `not.toContain`: each
// half carries the positive control that proves the assertion reached the text
// it thinks it did, and the survivor is asserted as a PARTITION — the pre-tool
// gate really is absent AND the floor seam really is present, in the same file,
// in the same run. An absence alone would also pass the day someone deletes the
// floors.
// ============================================================
describe('P6.69 · the composer tells the user what codex actually does', () => {
  const repoFile = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(`../../../../../${relative}`, import.meta.url)), 'utf8');

  const composer = repoFile('apps/electron/src/renderer/lib/composer-permission-modes.ts');
  const codexAgent = repoFile('packages/shared/src/agent/codex-agent.ts');

  /** The refuted sentence, in the exact shape the module carried it. */
  const REFUTED_BULLET = 'Codex — nothing of ours sees the call first. Measured 2026-08-16';

  it('the module was really read (control for every assertion below)', () => {
    expect(composer.length).toBeGreaterThan(4000);
    expect(composer).toContain('RUNTIME_PERMISSION_MODE_CLAUSE_KEYS');
    expect(composer).toContain('RUNTIME_PERMISSION_MODE_FOOTER_KEYS');
  });

  it('the refuted bullet is gone, and so is the sentence that read as "nothing of ours inspects the call"', () => {
    expect(composer).not.toContain(REFUTED_BULLET);
    expect(composer).not.toContain('nothing of ours inspects the call first either');
    // The correction is present rather than merely the falsehood absent.
    expect(composer).toContain('everything codex raises');
    expect(composer).toContain('findNonNegotiableFloors');
  });

  it('the survivor and the refuter are asserted TOGETHER — the partition, not an absence', () => {
    // Survivor: there is still no PRE-tool gate on codex. Asserted as "no call
    // site", not as a grep count: at HEAD the file contains the identifier
    // exactly once and that one occurrence is a comment saying the call sites
    // are zero, so a count pin would read as a regression.
    const preToolUseLines = codexAgent.split('\n').filter(line => line.includes('runPreToolUseChecks'));
    expect(preToolUseLines.length).toBeGreaterThan(0);
    for (const line of preToolUseLines) expect(line.trimStart()).toStartWith('*');
    // Refuter: the shared floor seam IS wired here, so the old bullet cannot be
    // restored by deleting the floors and leaving the sentence.
    expect(codexAgent).toContain('findNonNegotiableFloors');
    expect(codexAgent).toContain('firstNonNegotiableFloor');
    expect(codexAgent).toContain('floorVerdict');
    // Positive control on the same file, so a rename that emptied it fails.
    expect(codexAgent).toContain('consultPermissionRules');
  });

  it('bypassPermissions keeps no clause of its own, because the FOOTER is what names Bypass', () => {
    const start = composer.indexOf("'codex-runtime': {");
    expect(start).toBeGreaterThan(-1);
    const block = composer.slice(start, composer.indexOf('\n  },', start));
    expect(block).toContain('dontAsk:');
    expect(block).toContain('plan:');
    // The four modes whose clause would only repeat the footer.
    for (const mode of ['bypassPermissions', 'acceptEdits', 'auto']) {
      expect(block, `${mode} must not gain a clause of its own`).not.toContain(`${mode}:`);
    }
    const en: Record<string, string> = JSON.parse(repoFile('packages/shared/src/i18n/locales/en.json'));
    const note = en['chat.permissionModeRuntimeNote.codex']!;
    // The invariant is that the FOOTER carries Bypass, which is the whole reason
    // the clause map above may leave `bypassPermissions` out. It used to be
    // pinned by the footer's *"except in Bypass"* tail; P6.572 (`526f6983a`)
    // removed that tail deliberately, because since P6.61 emptied
    // `CODEX_MODES_KEEPING_ON_REQUEST_UNBOUNDED` it claimed LESS protection than
    // the session has — in Bypass only the human approval card is skipped, while
    // the safety floors and a deny rule still refuse. Pinned on the two halves
    // the replacement states, so a footer that stops naming Bypass at all still
    // fails and a rewording that keeps both halves does not.
    expect(note).toContain('Bypass');
    expect(note).toContain('the safety floors and your deny rules still refuse');
    // The retired tail asserted absent beside its successor, so a revert to the
    // sentence P6.572 corrected cannot pass by satisfying only the half above.
    expect(note).not.toContain('except in Bypass');
  });

  /**
   * W13-i PR-1 — the footer said Bypass "skips the approval card ONLY" and then
   * named TWO refusers, where an unattended codex turn has three.
   *
   * Measured at HEAD in `codex-agent.ts`'s `handleServerRequest`: the
   * `if (!surfaceToUser && !deniesWithoutAsking)` branch is EVERY mode but
   * `dontAsk` — `bypassPermissions` included — so with nobody attending, the
   * mode's own answer is never reached. With no floor and no rule covering the
   * call, `resolveUnattendedApprovalFallback` decides, and its default is
   * `deny` (P6.531, Q-den 68 = A + C: deny by default plus an operator escape
   * hatch). So the card is skipped and the call is refused anyway — the third
   * refuser, and the one that stops the pipeline.
   *
   * Pinned as a SUCCESSOR rather than as a `not.toContain` of the retired
   * sentence: the retired words are the correct half of the replacement, and a
   * stale-NAME guard fires on the very commit that fixes the thing it guards
   * (AGENTS.md §Traps). The setting's name is READ OUT of the module rather
   * than retyped, so renaming the constant fails this test instead of leaving
   * the copy pinning a name the product no longer has.
   */
  it('the footer names the third refuser an unattended codex turn meets, and the setting that opens it', () => {
    const fallbackSource = repoFile('packages/shared/src/config/unattended-approval.ts');
    const settingKey = /UNATTENDED_APPROVAL_FALLBACK_SETTING_KEY = '([^']+)'/.exec(fallbackSource)?.[1];
    const fallbackDefault = /UNATTENDED_APPROVAL_FALLBACK_DEFAULT: UnattendedApprovalFallback = '([^']+)'/
      .exec(fallbackSource)?.[1];
    // The clause is only true while the default refuses; if the default ever
    // flips to `allow`, this test is the thing that says the copy must move.
    expect({ settingKey, fallbackDefault }).toEqual({
      settingKey: 'unattendedApprovalFallback',
      fallbackDefault: 'deny',
    });
    // And it belongs on the CODEX footer because codex is the one runtime that
    // consults the fallback — its single non-test caller in the tree.
    expect(codexAgent).toContain('resolveUnattendedApprovalFallback');

    for (const locale of ['en', 'ru'] as const) {
      const messages: Record<string, string> = JSON.parse(
        repoFile(`packages/shared/src/i18n/locales/${locale}.json`),
      );
      const footer = messages['chat.permissionModeRuntimeNote.codex']!;
      // Both locales, because a clause present in one language and missing in
      // the other is the same over-promise for whoever reads the other one.
      expect(footer, `${locale} must name the escape hatch by its own key`).toContain(settingKey!);
      expect(footer, `${locale} must name the value that opens it`).toContain('allow');
      // The half P6.572 wrote is kept, not replaced — the new clause is an
      // addition to the list of refusers, so both must be present together.
      expect(footer, `${locale} must still name Bypass`).toContain(locale === 'en' ? 'Bypass' : messages['mode.bypassPermissions']!); // F1.1249: ru names the mode by its picker label
    }
  });
});

/**
 * P6.201 — the three auto-mode denial breakers do not agree, so the difference
 * is DECLARED rather than levelled. Each assertion names the property the row
 * lists (scope, effect) rather than a phrase, so a rewording that keeps the
 * meaning does not fail and a rewording that loses it does.
 */
describe('P6.201 · what a run of denials does under Auto is stated per runtime', () => {
  it('Pi names the effect that actually changes the mode — and the session scope', () => {
    const pi = guidanceLine('auto', 'Nessy Backend')
    expect(pi).toContain('three in a row, or twenty in the session')
    expect(pi).toContain('drops to Manual')
  })

  it('codex says its breaker only REPORTS, and that the mode does not change', () => {
    const codex = guidanceLine('auto', 'Codex')
    expect(codex).toContain('never acted on')
    expect(codex).toContain('does not change')
    // The row's closure is explicitly NOT lifting Pi's counters onto codex, so
    // Pi's thresholds must not appear here.
    expect(codex).not.toContain('twenty in the session')
  })

  it('claude states the ABSENCE — the declaration a user switching runtimes needs most', () => {
    const claude = guidanceLine('auto', 'Claude')
    expect(claude).toContain('Nothing counts repeated denials')
    expect(claude).not.toContain('twenty in the session')
  })

  it('the three are genuinely different sentences, not one string reached three ways', () => {
    const lines = new Set([
      guidanceLine('auto', 'Nessy Backend'),
      guidanceLine('auto', 'Codex'),
      guidanceLine('auto', 'Claude'),
    ])
    expect(lines.size).toBe(3)
  })

  it('CONTROL — no other mode grew a breaker clause, on any runtime', () => {
    for (const backend of ['Nessy Backend', 'Codex', 'Claude']) {
      for (const mode of ['default', 'acceptEdits', 'bypassPermissions'] as const) {
        expect(guidanceLine(mode, backend), `${backend} ${mode}`)
          .not.toContain('repeated denials')
      }
    }
  })

  it('CONTROL — the runtime-independent line is Pi\'s, because Pi is our own harness', () => {
    // `backendName` absent is the non-PromptBuilder caller. Falling to the codex
    // or claude wording there would tell a Pi session that nothing counts.
    expect(guidanceLine('auto')).toBe(guidanceLine('auto', 'Nessy Backend'))
  })
})

/**
 * F1.375 (origin the WJ-hh verifier on F1.234) — on codex a read-only mode's
 * refusal of a session-configuration or source write tool reaches the model as
 * codex's own fixed sentence *"user rejected MCP tool call"*: the elicitation
 * response has no reason channel (`parse_mcp_tool_approval_elicitation_response`,
 * `core/src/mcp_tool_call.rs`, re-read at `rust-v0.156.1` — a `Decline` is
 * `ReviewDecision::denied("user rejected MCP tool call")` and nothing else). So
 * the model believes the USER refused and never learns the mode did. The line it
 * reads every turn says so instead — without the word "blocked", which the
 * P3.238 pins above keep off both codex lines.
 */
describe('F1.375 · codex plan names the mode as the source of a session-tool refusal', () => {
  it('plan on codex carries the clause, naming codex\'s own refusal sentence', () => {
    for (const mode of ['plan'] as const) {
      const codex = guidanceLine(mode, 'Codex')
      expect(codex, mode).toContain('Session-configuration tools (automations, sources, preferences, labels) and the write tools of connected sources are refused in this mode')
      expect(codex, mode).toContain('"user rejected MCP tool call"')
      expect(codex, mode).toContain('that refusal comes from this mode, not from the user')
      expect(codex, mode).not.toContain('blocked')
    }
  })

  it('CONTROL — default on codex, and every non-codex plan line, carry no such clause', () => {
    expect(guidanceLine('default', 'Codex')).not.toContain('user rejected MCP tool call')
    for (const mode of ['plan'] as const) {
      for (const backendName of [undefined, 'Claude', 'Nessy Backend'] as const) {
        expect(guidanceLine(mode, backendName), `${mode}/${backendName ?? 'runtime-independent'}`)
          .not.toContain('user rejected MCP tool call')
      }
    }
  })
})

describe('F1.1051 · plan guidance names the writes plan mode admits', () => {
  // F1.1050 gave plan the retired explore's session data-folder write (mode-manager's
  // `shouldAllowToolInMode`, beside F1.725's .md plan file); the model reads its mode from
  // this line, so the line has to say it.
  it('plan names its plan file and the session data folder as the writes it keeps', () => {
    const plan = guidanceLine('plan');

    expect(plan).toContain('file changes are blocked, except a .md plan under plansFolderPath and any file under dataFolderPath');
    expect(plan).toContain('call SubmitPlan when it is ready to proceed');
  });

  it('BOUNDARY: codex plan (read-only sandbox) and every other mode claim no such write', () => {
    // CODEX_PERMISSION_MODE_TABLE gives codex plan `read-only`, which takes the scoped writes away.
    expect(guidanceLine('plan', 'Codex')).not.toContain('any file under dataFolderPath');
    for (const mode of PERMISSION_MODE_ORDER.filter(candidate => candidate !== 'plan')) {
      expect(guidanceLine(mode)).not.toContain('any file under dataFolderPath');
    }
  });
});
