/**
 * P3.251 — the codex prose that reached no runtime, and the two halves of the
 * fix: what is delivered, and what must never come back.
 *
 * ## The measurement
 *
 * `prompts/system.ts` carried four `backendName === 'Codex'` sections emitted by
 * `getSystemPrompt`. Verified at HEAD: `git grep -a` for
 * `getSystemPrompt(`/`getNessyAssistantPrompt(` over `packages` +
 * `apps/electron/src`, tests excluded, returns exactly `claude-agent.ts`
 * (`undefined` backendName), `pi-agent.ts` (`'Nessy Backend'`) and the dev
 * printer — the two real callers ARE found on the same rig, which is the
 * positive control that makes the absence a reading and not a dead grep. So the
 * conditional was never true, and the row's premise that "the other two runtimes
 * have" this guidance is REFUTED: it lived inside the codex conditional, so no
 * runtime had it.
 *
 * ## Why two sections were deleted rather than routed
 *
 *  - `SubmitPlan` is NOT on the codex tool surface: P3.238 drove the real
 *    `session-mcp-server` under `CodexAgent.buildSessionMcpSpec`'s own argv and
 *    got 27 tools without it (controls `advisor_consult`, `Monitor`,
 *    `source_test` present), against 45 with `--external-standalone-only`
 *    dropped.
 *  - "heredocs are blocked by the sandbox" has no enforcer anywhere in this
 *    tree; the only `<<` predicate is `isUnparseableCompoundCommand`, which
 *    decides AUTO-BACKGROUNDING.
 *
 * Three of the source-management table's four tools are in
 * `SESSION_TOOLS_REQUIRING_HOST_CALLBACK` and in neither bridged set, so
 * shipping it verbatim would have named three tools codex cannot call.
 */
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { buildApprovalResponse } from '@nessy-agent/codex-agent-server';
import { codexDataFolderControlTarget, codexDeveloperInstructions } from '../codex-agent.ts';
import { CODEX_RUNTIME_GUIDANCE } from '../../prompts/codex-runtime-guidance.ts';
import { CODEX_POOL_TOOL_NAMESPACE, codexModelToolName } from '../../capabilities/mcp-wire-name.ts';
import { CONFIG_DIR } from '../../config/paths.ts';
import { GUARDED_WORKSPACE_RECORDS } from '../core/pre-tool-use.ts';
import {
  SESSION_TOOLS_REQUIRING_HOST_CALLBACK,
  SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK,
} from '@nessy-agent/session-tools-core';

describe('P3.251 — codex guidance reaches the codex model', () => {
  it('is DELIVERED on the one channel codex reads', () => {
    const delivered = codexDeveloperInstructions();
    expect(delivered).toContain(CODEX_RUNTIME_GUIDANCE);
    // And the safety block still comes first — operating guidance must not read
    // as outranking it.
    expect(delivered.indexOf(CODEX_RUNTIME_GUIDANCE)).toBeGreaterThan(0);
  });

  it('keeps an output style LAST, behind both blocks', () => {
    const delivered = codexDeveloperInstructions('## Output Style: Terse\nBe brief.');
    expect(delivered.indexOf('## Output Style: Terse'))
      .toBeGreaterThan(delivered.indexOf(CODEX_RUNTIME_GUIDANCE));
  });

  /**
   * F1.217 — RE-PINNED. This case asserted `mcp__sources__{slug}__{tool}` and
   * `mcp__session__source_test`, on the premise that codex's model-facing name
   * is the transcript row's. Measured on the shipped binary it is not: codex
   * hands the model the function name inside a server NAMESPACE —
   * `<slug>__<tool>` sanitized for a pool tool (`mcp/__tests__/codex-model-tool-name-live.test.ts`),
   * the bare name for a session tool — and the gateway leg drops the namespace
   * altogether. The two old strings are now the NEGATIVE half.
   */
  it('names the tool-name shape codex actually hands the model, and no other', () => {
    expect(CODEX_RUNTIME_GUIDANCE).toContain('{slug}__{tool}');
    expect(CODEX_RUNTIME_GUIDANCE).toContain(`\`${codexModelToolName('linear', 'list_issues')}\``);
    // The hyphen case is the one the old rule got wrong in the character, not only the prefix.
    expect(codexModelToolName('my-tracker', 'list_issues')).toBe('my_tracker__list_issues');
    expect(CODEX_RUNTIME_GUIDANCE).toContain('`my_tracker__list_issues`');
    expect(CODEX_RUNTIME_GUIDANCE).toContain(`\`${CODEX_POOL_TOOL_NAMESPACE}\` namespace`);
    expect(CODEX_RUNTIME_GUIDANCE).toContain('`mcp__session` namespace');
    expect(CODEX_RUNTIME_GUIDANCE).toContain('for example `source_test`');

    expect(CODEX_RUNTIME_GUIDANCE).not.toContain('mcp__sources__{slug}');
    expect(CODEX_RUNTIME_GUIDANCE).not.toContain('mcp__sources__linear');
    expect(CODEX_RUNTIME_GUIDANCE).not.toContain('mcp__session__source_test');
    // The discovery tool the old block named exists on no server in this tree.
    expect(CODEX_RUNTIME_GUIDANCE).not.toContain('list_tools');
  });

  it('names NO tool codex cannot call — the check, not a copy of the list', () => {
    // The two deleted claims and the three withheld source tools, asserted from
    // the SET rather than from a literal list, so a tool that later becomes
    // reachable stops being flagged without anyone editing this test.
    const unreachable = [...SESSION_TOOLS_REQUIRING_HOST_CALLBACK]
      .filter(name => !SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK.has(name));
    expect(unreachable.length).toBeGreaterThan(0); // the set is not empty
    const named = unreachable.filter(name => CODEX_RUNTIME_GUIDANCE.includes(name));
    expect(named).toEqual([]);
    // Positive control: the guidance DOES name the one source tool codex has,
    // so an empty result above cannot come from an empty guidance string.
    expect(CODEX_RUNTIME_GUIDANCE).toContain('source_test');
    expect(SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has('source_test')).toBe(false);
  });

  it('does not resurrect the two claims measured false on codex', () => {
    expect(CODEX_RUNTIME_GUIDANCE).not.toContain('SubmitPlan');
    expect(CODEX_RUNTIME_GUIDANCE.toLowerCase()).not.toContain('heredoc');
  });
});

/**
 * F1.718 (with F1.779's patch half) — a host refusal on codex reads as the USER's.
 *
 * A v2 file-change decline and an MCP elicitation decline have no field for a
 * reason, so the model is handed codex's fixed words — `patch rejected by user`,
 * `user rejected MCP tool call` (both present once in the shipped
 * `codex-app-server` rust-v0.156.1, sha `38fd9065…`, read 2026-09-26) — even when
 * NESSY refused before any card, e.g. F1.693's data-folder floor, whose named
 * sentence reaches only the debug log. The model then told the user they had
 * declined something they never saw (SIT-l E21). The one channel left is the
 * guidance, so the guidance says it.
 */
describe('F1.718 — the guidance says a codex refusal may be Nessy\'s, not the user\'s', () => {
  const heading = '## Refusals (Codex)';
  const section = CODEX_RUNTIME_GUIDANCE.slice(Math.max(0, CODEX_RUNTIME_GUIDANCE.indexOf(heading)));

  it('names both fixed strings, the data-folder floor in every mode, and only files that floor refuses', () => {
    expect(section.startsWith(heading)).toBe(true);
    expect(section).toContain('"patch rejected by user"');
    expect(section).toContain('"user rejected MCP tool call"');
    expect(section).toContain('data-folder floor');
    expect(section).toContain('every permission mode');
    expect(section).toContain('do not tell the user they declined');
    // Every file the sentence names as protected is one the REAL floor refuses —
    // globally or as a workspace record — so the sentence cannot promise more
    // than the floor does. The count guards against an empty match.
    const named = [...section.matchAll(/`([^`]+)`/g)].map(match => match[1]!);
    expect(named.length).toBeGreaterThanOrEqual(9);
    const unrefused = named.filter(name =>
      codexDataFolderControlTarget(join(CONFIG_DIR, name)) === null
      && codexDataFolderControlTarget(join(CONFIG_DIR, 'workspaces', 'ws-f1718', name)) === null);
    expect(unrefused).toEqual([]);
  });

  it('rests on the wire as it is: v2 patch and MCP declines carry no reason, a v1 patch decline does', () => {
    const why = 'Denied by the data-folder floor (F1.693): probe';
    const v2Patch = buildApprovalResponse('fileChange', { itemId: 'i', threadId: 't', turnId: 'u' }, false, undefined, undefined, why);
    expect(v2Patch).toEqual({ decision: 'decline' });
    const mcp = buildApprovalResponse('elicitation', { mode: 'form', requestedSchema: {} }, false, undefined, undefined, why);
    expect(JSON.stringify(mcp)).not.toContain(why);
    // Control: the builder DOES carry a reason where the wire has a field for one,
    // so the two absences above are the wire's, not a dropped argument.
    const v1Patch = buildApprovalResponse('fileChangeV1', { fileChanges: {} }, false, undefined, undefined, why);
    expect(JSON.stringify(v1Patch)).toContain(why);
    // And the guidance does not promise the model a reason it will never receive.
    expect(section).not.toContain('Denied by');
  });
});

/**
 * F1.779 — the COMMAND half, and where the user changes it.
 *
 * A v2 `commandExecution` decline is `ReviewDecision::denied("rejected by user")`
 * (`app-server/src/bespoke_event_handling.rs`), which `core/src/tools/events.rs`
 * normalizes to `exec command rejected by user` for the exec emitter (both read at
 * `rust-v0.156.1`; the string occurs once in the shipped darwin-arm64
 * `codex-app-server`, sha `38fd9065…`, beside the patch and MCP strings as the
 * positive control, read 2026-09-26). A permission rule, a floor, `dontAsk` and an
 * unattended turn all answer that decline, so the model read a host refusal of a
 * command as the user's too — and nothing told it where the user changes a rule
 * (SIT-l E21/F1.141: the refusal never named Settings > Permissions, the pointer
 * Pi and claude give for `permissions.json`, `core/pre-tool-use.ts`).
 */
describe('F1.779 — a refused command reads as possibly Nessy\'s, and the guidance says where the user changes it', () => {
  const heading = '## Refusals (Codex)';
  const section = CODEX_RUNTIME_GUIDANCE.slice(Math.max(0, CODEX_RUNTIME_GUIDANCE.indexOf(heading)));

  it('names codex\'s fixed command string beside the other two, and the user\'s two levers', () => {
    expect(section.startsWith(heading)).toBe(true);
    expect(section).toContain('"exec command rejected by user"');
    // The pointer is the tree's own sentence for the rules record, not a new surface.
    expect(GUARDED_WORKSPACE_RECORDS.get('permissions.json')).toContain('Settings > Permissions');
    expect(section).toContain('Settings > Permissions');
    expect(section).toContain('permission mode is theirs to switch');
  });

  it('rests on the wire as it is: a v2 command decline carries no reason, a v1 command decline does', () => {
    const why = 'Denied by permission rule "probe" (workspace).';
    const v2Command = buildApprovalResponse('command', { itemId: 'i', threadId: 't', turnId: 'u', command: 'rm -rf build' }, false, undefined, undefined, why);
    expect(v2Command).toEqual({ decision: 'decline' });
    // Control: the builder carries the reason where the v1 wire has a field for it.
    const v1Command = buildApprovalResponse('commandV1', { command: ['rm', '-rf', 'build'] }, false, undefined, undefined, why);
    expect(v1Command).toEqual({ decision: { denied: { rejection: why } } });
  });
});

/**
 * F1.1255 — the spelling the shipped 0.159.3 hands the model for a refused
 * ESCALATED command is neither of the fixed strings above: the final CDP sitting
 * (SIT2-c, 2026-10-01, RC 831fde57f) read `exec_command failed: CreateProcess {
 * message: "Rejected(\"rejected by user\")" }` in the codex rollout for a command
 * the managed policy refused with no card, and the model told the user "the
 * approval was declined". The v2 decline still carries no reason (F1.779 above),
 * so the guidance is the only channel: ANY "rejected by user" text, this spelling
 * included, reads as a possible Nessy refusal with the Settings > Permissions lever.
 */
describe('F1.1255 — any "rejected by user" text, the exec_command Rejected spelling included, reads as possibly Nessy\'s', () => {
  const heading = '## Refusals (Codex)';
  const section = CODEX_RUNTIME_GUIDANCE.slice(Math.max(0, CODEX_RUNTIME_GUIDANCE.indexOf(heading)));

  it('names the exec_command Rejected spelling and widens the rule to any "rejected by user" text', () => {
    expect(section.startsWith(heading)).toBe(true);
    expect(section).toContain('exec_command failed');
    expect(section).toContain('Rejected("rejected by user")');
    expect(section).toContain('any refusal text that says "rejected by user"');
    expect(section).toContain('Settings > Permissions');
  });

  it('BOUNDARY — the three fixed strings stay named, so the widening adds and removes nothing', () => {
    for (const fixed of ['"exec command rejected by user"', '"patch rejected by user"', '"user rejected MCP tool call"']) {
      expect(section).toContain(fixed);
    }
  });
});
