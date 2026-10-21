/**
 * C3.285 (the build C3.12 asked for) — a permission rule codex's own approval
 * path cannot consult is NAMED, instead of silently matching nothing.
 *
 * At HEAD before this row: `codexApprovalRuleRequests` projects three tool names
 * and two input fields and returns `[]` for every other approval kind, each for a
 * stated reason. The narrowness is right; the silence was the defect — P6.214
 * measured it as a SILENT-LOOSER switch verdict on ledger A51/A52.
 *
 * WHAT EACH TEST KILLS:
 *  - the TOTALITY arm dies the day the projection gains a fourth tool name or a
 *    third input field, because it drives `codexApprovalRuleRequests` over every
 *    member of `ApprovalKind` and compares the union it emits against the two
 *    constants the classifier reads. Two lists restating one function's decision
 *    is exactly the drift this repo keeps measuring, so it is asserted rather
 *    than assumed.
 *  - the three classification arms die if a class stops being reported.
 *  - the NEGATIVE arms are the positive controls: a classifier that reported
 *    every rule would satisfy the three arms above just as well, so a `Bash`
 *    rule, a `file_path` parameter rule and a path rule must all come back
 *    bound — and the two matchers that stay unclaimed after C3.298
 *    (`powershell`, `cdPath`) must not be reported either.
 *  - C3.298's arm dies if `host` stops being claimed: the command/file
 *    projection carries no `url`/`host` field, and no host-run tool on a codex
 *    session reaches the rule gate. Its `mcp` twin was FLIPPED by F1.272 — the
 *    MCP tool-call approval is projected now (`codexMcpToolCallRuleRequests`),
 *    so an `mcp` rule is consulted and reporting it would be the lie; the arm
 *    that replaces it dies if the classifier starts claiming it again. The two
 *    matchers C3.298 left unclaimed are unclaimed for OPPOSITE reasons, one
 *    consulted and one not a tool-call matcher at all.
 *  - F1.272's family arm dies if an MCP tool-call request stops carrying the
 *    host's `mcp__` name or the call's own arguments.
 *  - the sentence arm dies if the diagnostic stops naming the rules or the
 *    vocabulary, which is the whole of what a user can act on.
 */
import { describe, expect, it } from 'bun:test';
import type { ApprovalKind } from '@nessy-agent/codex-agent-server';
import { codexApprovalRuleRequests } from '../codex-agent.ts';
import {
  CODEX_APPROVAL_RULE_INPUT_FIELDS,
  CODEX_APPROVAL_RULE_TOOL_NAMES,
  classifyCodexUnboundPermissionRules,
  describeCodexUnboundPermissionRules,
  type CodexRuleSubjectInput,
} from '../codex-permission-rule-support.ts';

const CWD = '/tmp/c3285-project';

/** Every approval kind, spelled here so a new member fails to compile. */
const APPROVAL_KINDS: readonly ApprovalKind[] = [
  'command',
  'fileChange',
  'elicitation',
  'permissions',
  'commandV1',
  'fileChangeV1',
];

/**
 * Params rich enough that every kind which CAN project a command/file request
 * does. `elicitation` is a server's own question here ON PURPOSE: codex's MCP
 * tool-call frame projects an `mcp__` name instead (F1.272), outside this
 * vocabulary, and its family has its own arm below.
 */
const PARAMS_FOR: Readonly<Record<ApprovalKind, unknown>> = {
  command: { command: 'npm test', cwd: CWD },
  fileChange: { threadId: 't', turnId: 'u', itemId: 'i', startedAtMs: 1, grantRoot: CWD },
  elicitation: { serverName: 'sources', _meta: { tool_title: 'Search' } },
  permissions: { reason: 'network' },
  commandV1: { command: ['npm', 'test'], cwd: CWD },
  fileChangeV1: { fileChanges: { [`${CWD}/src/a.ts`]: {} }, cwd: CWD },
};

const program = (
  ...rules: CodexRuleSubjectInput['rules'][number][]
): CodexRuleSubjectInput => ({ rules });

describe('C3.285 · the vocabulary the classifier reads is the one the projection emits', () => {
  it('emits exactly the three tool names and the two input fields, over every approval kind', () => {
    const names = new Set<string>();
    const fields = new Set<string>();
    for (const kind of APPROVAL_KINDS) {
      for (const request of codexApprovalRuleRequests(kind, PARAMS_FOR[kind], CWD)) {
        names.add(request.toolName);
        for (const field of Object.keys(request.input)) fields.add(field);
      }
    }
    // Positive control: a projection that emitted nothing at all would satisfy a
    // subset assertion, so the union is compared whole.
    expect([...names].sort()).toEqual([...CODEX_APPROVAL_RULE_TOOL_NAMES].sort());
    expect([...fields].sort()).toEqual([...CODEX_APPROVAL_RULE_INPUT_FIELDS].sort());
  });
});

describe('F1.272 · the MCP tool-call family, which the command/file vocabulary above does not cover', () => {
  it('an MCP tool-call approval projects an mcp__ name in the host spelling, carrying the call\'s own arguments', () => {
    const requests = codexApprovalRuleRequests('elicitation', {
      serverName: 'sources',
      mode: 'form',
      message: 'Allow the sources MCP server to run tool "linear__create_issue"?',
      _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: { title: 'x', url: 'https://example.com' } },
    }, CWD);
    expect(requests.map(request => [request.toolName, Object.keys(request.input).sort()]))
      .toEqual([['mcp__linear__create_issue', ['title', 'url']]]);
  });
});

describe('C3.285 · the three classes C3.12 named', () => {
  it('reports a parameter rule naming a field the approvals never carry', () => {
    const unbound = classifyCodexUnboundPermissionRules(
      program({ id: 'p-1', text: 'Grep(pattern=secret)', matcher: { kind: 'parameter', name: 'pattern' } }),
    );
    expect(unbound.map(rule => [rule.ruleId, rule.reason, rule.subject]))
      .toEqual([['p-1', 'parameter-field', 'pattern']]);
  });

  it('reports every Agent rule, because a codex subagent runs inside the app-server', () => {
    const unbound = classifyCodexUnboundPermissionRules(
      program({ id: 'a-1', text: 'Agent(reviewer)', matcher: { kind: 'agent', agent: 'reviewer' } }),
    );
    expect(unbound.map(rule => [rule.ruleId, rule.reason, rule.subject]))
      .toEqual([['a-1', 'agent-rule', 'Agent(reviewer)']]);
  });

  it('reports a tool rule naming anything but the three projected names', () => {
    const unbound = classifyCodexUnboundPermissionRules(
      program({ id: 't-1', text: 'Read', matcher: { kind: 'tool', semanticId: 'read' } }),
    );
    expect(unbound.map(rule => [rule.ruleId, rule.reason, rule.subject]))
      .toEqual([['t-1', 'tool-name', 'read']]);
  });
});

describe('C3.285 · what the classifier must NOT report', () => {
  it('leaves a rule whose subject the projection does carry', () => {
    expect(classifyCodexUnboundPermissionRules(program(
      { id: 'b-1', matcher: { kind: 'tool', semanticId: 'bash' } },
      { id: 'w-1', matcher: { kind: 'tool', semanticId: 'write' } },
      { id: 'e-1', matcher: { kind: 'tool', semanticId: 'edit' } },
      { id: 'c-1', matcher: { kind: 'parameter', name: 'command' } },
      { id: 'f-1', matcher: { kind: 'parameter', name: 'file_path' } },
    ))).toEqual([]);
  });

  it('leaves the matchers that really are consulted, or that judge no tool call at all', () => {
    // C3.298, measured per kind rather than as one line about four names.
    // `powershell`: the `command`/`commandV1` projection emits `toolName: 'Bash'`
    // and `permission-dsl.ts`'s `carriesBashCommand` accepts exactly that, so a
    // PowerShell rule really is consulted when codex asks to run a command.
    // `cdPath`: `permission-dsl.ts` answers `case 'cdPath': return false` for
    // every tool call on every runtime — its evaluator is the `/cd` the user
    // types — so it is not a codex question in either direction.
    expect(classifyCodexUnboundPermissionRules(program(
      { id: 'ps-1', matcher: { kind: 'powershell' } },
      { id: 'cd-1', matcher: { kind: 'cdPath' } },
      { id: 'pg-1', matcher: { kind: 'pathGlob' } },
      { id: 'pa-1', matcher: { kind: 'path' } },
      { id: 'sh-1', matcher: { kind: 'bash' } },
    ))).toEqual([]);
  });

  it('C3.298 · reports a Host rule, which has no field to read on this projection', () => {
    expect(classifyCodexUnboundPermissionRules(program(
      { id: 'h-1', text: 'WebFetch(domain:example.com)', matcher: { kind: 'host', host: 'example.com' } },
    ))).toEqual([
      { ruleId: 'h-1', reason: 'matcher-kind', text: 'WebFetch(domain:example.com)', subject: 'Host(example.com)' },
    ]);
  });

  it('F1.272 · leaves an MCP rule, which codex\'s MCP tool-call approval now consults', () => {
    // Was C3.298's "reports an MCP rule" until F1.272 projected the approval
    // codex raises for an MCP tool call; the Host twin above stays claimed.
    expect(classifyCodexUnboundPermissionRules(program(
      { id: 'm-1', matcher: { kind: 'mcp', server: 'linear' } },
      { id: 'm-2', matcher: { kind: 'mcp', server: 'linear', tool: 'create_issue' } },
    ))).toEqual([]);
  });

  it('answers for a session with no policy at all', () => {
    expect(classifyCodexUnboundPermissionRules(undefined)).toEqual([]);
    expect(describeCodexUnboundPermissionRules([])).toBeUndefined();
  });
});

describe('C3.285 · the sentence the operator reads', () => {
  it('names the rules, the vocabulary and the limit of the claim', () => {
    const unbound = classifyCodexUnboundPermissionRules(program(
      { id: 'a-1', text: 'Agent(reviewer)', matcher: { kind: 'agent', agent: 'reviewer' } },
      { id: 'p-1', text: 'Grep(pattern=secret)', matcher: { kind: 'parameter', name: 'pattern' } },
    ));
    const line = describeCodexUnboundPermissionRules(unbound);
    expect(line).toBeDefined();
    // The author's OWN rule text, which is the string they can search for.
    expect(line).toContain('Agent(reviewer)');
    expect(line).toContain('Grep(pattern=secret)');
    expect(line).toContain('2 of your rules');
    for (const name of CODEX_APPROVAL_RULE_TOOL_NAMES) expect(line).toContain(name);
    // The limit of the claim travels WITH it: a user must not read this as "my
    // rules do nothing on codex". C3.298 corrected WHICH limit is true — the
    // sentence used to promise that the rules still applied to the tools this
    // host runs itself, and the measurement refuted that premise, so the
    // surviving promise is the other runtimes and the `/cd` gate.
    expect(line).toContain('still hold on the other runtimes this session can be switched to');
    expect(line).not.toContain('still apply to the tools this host runs itself');
    // F1.272 · and where they DO come back: an MCP tool call is judged.
    expect(line).toContain('When codex asks to run an MCP tool');
    expect(line).toContain('codex does not ask for a tool its server marks read-only');
    expect(line).not.toContain('They do NOT come back for the session tools');
  });

  it('stops listing after six and says how many more there are', () => {
    const unbound = classifyCodexUnboundPermissionRules(program(
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `a-${index}`,
        text: `Agent(role-${index})`,
        matcher: { kind: 'agent' as const, agent: `role-${index}` },
      })),
    ));
    const line = describeCodexUnboundPermissionRules(unbound)!;
    expect(line).toContain('8 of your rules');
    expect(line).toContain('Agent(role-5)');
    expect(line).not.toContain('Agent(role-6)');
    expect(line).toContain('and 2 more');
  });

  it('falls back to the subject when the layer carried no rule text', () => {
    const line = describeCodexUnboundPermissionRules(
      classifyCodexUnboundPermissionRules(program({ id: 't-1', matcher: { kind: 'tool', semanticId: 'read' } })),
    )!;
    expect(line).toContain('read');
  });
});

describe('C3.285 · the session says so on the facts channel, not through debug()', () => {
  const source = Bun.file(new URL('../codex-agent.ts', import.meta.url)).text();

  it('records the diagnostic where a standing property of the session belongs', async () => {
    const text = await source;
    expect(text).toContain('this.noteUnboundPermissionRules()');
    expect(text).toContain("this.recordSessionFact('codex-unbound-permission-rules', line)");
    // And CLEARS it when the policy no longer has an unbound rule, so a fixed
    // policy does not leave a stale fact behind for the rest of the session.
    expect(text).toContain("this.sessionFacts.delete('codex-unbound-permission-rules')");
  });
});
