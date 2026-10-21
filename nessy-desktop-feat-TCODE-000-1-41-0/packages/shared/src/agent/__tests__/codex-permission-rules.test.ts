/**
 * R6 — a user's permission rule is consulted on the Codex approval path.
 *
 * Measured 2026-08-16, before this: `codex-agent.ts` contained no reference to
 * `runPreToolUseChecks`, `permissionsConfigCache` or `permissionDsl`. Its
 * approval path mapped the runtime's request to a UI card and waited for a
 * human — so a rule honoured on Pi (`pi-agent.ts:4649` evaluates the merged
 * readable policy on its own answer path) and on Claude (their system plus our
 * gate) was ignored here, and the user was asked every time, including for the
 * calls they had explicitly pre-approved.
 *
 * What this file pins:
 *   - one rule, written once, decides the same way on Codex as it does through
 *     the seam Pi consults (the positive case);
 *   - with the rule removed, Codex asks again (the negative control — without
 *     it, "it passes" is compatible with the feature being inert);
 *   - an unmatched request still reaches the human, on every method family;
 *   - the three things R6 must NOT change: the unattended fallback (which since
 *     P6.531 DENIES rather than auto-approves, and since P6.713 answers only
 *     AFTER the rules), the url-scheme gate's position ahead of everything
 *     shown, and the human as the destination for anything the rules do not
 *     actually match.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { MCP_ELICITATION_METHOD, PERMISSIONS_METHOD } from '@nessy-agent/codex-agent-server';
import type { BackendConfig, PermissionCallback } from '../backend/types.ts';
import { CodexAgent, codexApprovalRuleRequests } from '../codex-agent.ts';
import { UNATTENDED_APPROVAL_FALLBACK_ENV_VAR } from '../../config/unattended-approval.ts';
import { permissionsConfigCache } from '../permissions-config.ts';
import { evaluatePermissionDslV1 } from '../pi-harness/permission-dsl.ts';

const WORKSPACE_ROOT = '/tmp/nessy-codex-rules-ws';
const PROJECT_CWD = '/tmp/nessy-codex-rules-project';
const EXEC_METHOD = 'item/commandExecution/requestApproval';
const PATCH_METHOD_V1 = 'applyPatchApproval';
const EXEC_METHOD_V1 = 'execCommandApproval';
const FILE_CHANGE_METHOD = 'item/fileChange/requestApproval';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-rules',
      name: 'Rules Workspace',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: '/tmp/nessy-codex-rules-sessions/ws-rules',
    } as any,
    session: {
      id: 'session-rules',
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
 * A session whose permission rules are exactly `settings` — the same
 * `.claude/settings.json` `permissions` block a user writes once and expects
 * every runtime to honour, published through the capability layer handoff
 * `BaseAgent.buildPinnedCapabilityContext` performs on every turn.
 *
 * `rules: null` publishes NO layer at all, which is the negative control: the
 * identical session with the rule taken away.
 */
function agentWithRules(rules: Record<string, string[]> | null) {
  const agent = new CodexAgent(createConfig());
  const debug: string[] = [];
  const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
  agent.onDebug = (message) => { debug.push(message); };
  agent.onPermissionRequest = (request) => { surfaced.push(request); };
  agent.getPermissionManager().setCapabilityPermissionLayers(
    rules === null ? [] : [{ content: JSON.stringify({ permissions: rules }), scope: 'workspace' }],
    'generation-r6',
    true,
  );
  return { agent, debug, surfaced };
}

/** The compiled policy this session evaluates against — Pi reads the same one. */
function policyFor(agent: CodexAgent) {
  const context = agent.getPermissionManager().getCapabilityPermissionsContext()!;
  return permissionsConfigCache.getMergedConfig(context).permissionDsl;
}

function ask(agent: CodexAgent, method: string, params: unknown) {
  return (agent as any).handleServerRequest(method, params) as Promise<Record<string, unknown>> | Record<string, unknown>;
}

beforeEach(() => {
  permissionsConfigCache.clear();
});

describe('a shell approval is answered by the rule the user already wrote', () => {
  it('auto-accepts a pre-approved command without asking a human', async () => {
    const { agent, surfaced, debug } = agentWithRules({ allow: ['Bash(git status)'] });

    const result = await ask(agent, EXEC_METHOD, { command: 'git status', cwd: PROJECT_CWD });

    expect(result).toEqual({ decision: 'accept' });
    expect(surfaced).toEqual([]);
    expect((agent as any).pendingApprovals.size).toBe(0);
    // Never `acceptForSession`: the rule re-decides on every call, so codex is
    // not asked to remember anything.
    expect(result).not.toMatchObject({ decision: 'acceptForSession' });
    expect(debug.some(line => line.includes('auto-allowed by permission rule'))).toBe(true);
  });

  /**
   * THE NEGATIVE CONTROL. Same session, same command, rule removed — the card
   * comes back. Without this, the assertion above is equally satisfied by an
   * approval path that auto-accepts everything.
   */
  it('asks again the moment the rule is taken away', async () => {
    const { agent, surfaced } = agentWithRules(null);

    const pending = ask(agent, EXEC_METHOD, { command: 'git status', cwd: PROJECT_CWD });

    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]!.command).toBe('git status');
    agent.respondToPermission(surfaced[0]!.requestId, true);
    expect(await pending).toEqual({ decision: 'accept' });
  });

  it('refuses a denied command without asking, and names the rule', async () => {
    const { agent, surfaced, debug } = agentWithRules({ deny: ['Bash(rm -rf *)'] });

    const result = await ask(agent, EXEC_METHOD, { command: 'rm -rf build', cwd: PROJECT_CWD });

    expect(result).toEqual({ decision: 'decline' });
    expect(surfaced).toEqual([]);
    expect(debug.some(line => line.includes('refused by permission rule'))).toBe(true);
  });

  /**
   * P3.12 — THE SHAPE THE COMMAND ACTUALLY ARRIVES IN ON CODEX.
   *
   * T6 live (2026-08-23): with `deny Bash(tail:*)` active, the `Monitor` watch
   * was refused and named its rule, while codex's own shell ran the same
   * command and raised only an ordinary card — with an Always Allow button.
   * The reason is not codex-specific enforcement: `shell_command` takes "Shell
   * script to run in the user's default shell" with `login` defaulting to true,
   * so the command reaches this seam already wrapped in `<shell> -lc '<script>'`
   * (measured against the bundled `codex-app-server`, 2026-08-24), and the
   * Claude prefix matcher did not read the script.
   *
   * Both spellings are the same rule and must reach the same decision — the
   * "one rule, one decision, on every runtime" this file exists to pin.
   */
  it('refuses the same command inside codex\'s own `-lc` shell wrapper', async () => {
    const { agent, surfaced, debug } = agentWithRules({ deny: ['Bash(tail:*)'] });

    const bare = await ask(agent, EXEC_METHOD, { command: 'tail -f /tmp/probe.log', cwd: PROJECT_CWD });
    const wrapped = await ask(agent, EXEC_METHOD, {
      command: `/bin/zsh -lc 'tail -f /tmp/probe.log'`,
      cwd: PROJECT_CWD,
    });

    expect(bare).toEqual({ decision: 'decline' });
    expect(wrapped).toEqual({ decision: 'decline' });
    expect(surfaced).toEqual([]);
    expect(debug.filter(line => line.includes('refused by permission rule')).length).toBe(2);
  });

  /**
   * The negative control for the row above: the wrapper does not make the
   * matcher agreeable, it only makes it honest. A command the rule never named
   * still reaches the human when it is wrapped, exactly as it does bare.
   */
  it('still asks about a wrapped command no rule denies', async () => {
    const { agent, surfaced } = agentWithRules({ deny: ['Bash(tail:*)'] });

    const pending = ask(agent, EXEC_METHOD, {
      command: `/bin/zsh -lc 'echo hello'`,
      cwd: PROJECT_CWD,
    });

    expect(surfaced).toHaveLength(1);
    agent.respondToPermission(surfaced[0]!.requestId, true);
    expect(await pending).toEqual({ decision: 'accept' });
  });

  /**
   * F1.823 (owner, 2026-09-26) REVERSES P3.12's allow asymmetry on this seam:
   * `<shell> -lc` is codex's TRANSPORT on every command, so an allow judges the
   * script the model wrote (`permissions.md#bash-rule-limits`), unwrapped once;
   * `codex-login-shell-rule-projection.test.ts` carries the reasons and controls.
   */
  it('auto-allows a command inside codex\'s own `-lc` transport from an allow rule', async () => {
    const { agent, surfaced } = agentWithRules({ allow: ['Bash(tail:*)'] });

    expect(await ask(agent, EXEC_METHOD, { command: 'tail -f /tmp/probe.log', cwd: PROJECT_CWD }))
      .toEqual({ decision: 'accept' });
    expect(await ask(agent, EXEC_METHOD, { command: `/bin/zsh -lc 'tail -f /tmp/probe.log'`, cwd: PROJECT_CWD }))
      .toEqual({ decision: 'accept' });
    expect(surfaced).toEqual([]);
  });

  /**
   * The row's acceptance: one rule, one decision, on every runtime. The Codex
   * answer above and the request Pi evaluates (`semanticId: 'bash'`,
   * `toolName: 'Bash'`, `input.command`) are the same rule set answering the
   * same tool call — asserted here against the very program the session
   * compiled, not against a copy.
   */
  it('reaches the same verdict as the seam Pi evaluates, from the same program', async () => {
    const { agent } = agentWithRules({ allow: ['Bash(git status)'], deny: ['Bash(rm -rf *)'] });
    const policy = policyFor(agent)!;

    const piShaped = (command: string) => evaluatePermissionDslV1(policy, {
      generation: policy.generation,
      semanticId: 'bash',
      toolName: 'Bash',
      input: { command },
      cwd: PROJECT_CWD,
    }).action;

    expect(piShaped('git status')).toBe('allow');
    expect(piShaped('rm -rf build')).toBe('deny');
    expect(piShaped('npm publish')).toBeUndefined();

    expect(await ask(agent, EXEC_METHOD, { command: 'git status', cwd: PROJECT_CWD })).toEqual({ decision: 'accept' });
    expect(await ask(agent, EXEC_METHOD, { command: 'rm -rf build', cwd: PROJECT_CWD })).toEqual({ decision: 'decline' });
  });

  it('sends an unmatched command to the human even with rules loaded', async () => {
    const { agent, surfaced } = agentWithRules({ allow: ['Bash(git status)'], deny: ['Bash(rm -rf *)'] });

    const pending = ask(agent, EXEC_METHOD, { command: 'npm publish', cwd: PROJECT_CWD });

    expect(surfaced).toHaveLength(1);
    agent.respondToPermission(surfaced[0]!.requestId, false);
    expect(await pending).toEqual({ decision: 'decline' });
  });

  /**
   * An `ask` rule asks. The card IS the ask, so a matching ask rule leaves the
   * path exactly as it was.
   */
  it('leaves an ask rule to the card it already produces', async () => {
    const { agent, surfaced } = agentWithRules({ ask: ['Bash(git push *)'] });

    ask(agent, EXEC_METHOD, { command: 'git push origin main', cwd: PROJECT_CWD });

    expect(surfaced).toHaveLength(1);
  });

  /** The v1 exec family speaks argv and its own decision vocabulary. */
  it('answers the legacy exec approval in the legacy vocabulary', async () => {
    const { agent, surfaced } = agentWithRules({ allow: ['Bash(git status)'], deny: ['Bash(rm -rf *)'] });

    expect(await ask(agent, EXEC_METHOD_V1, { command: ['git', 'status'], cwd: PROJECT_CWD }))
      .toEqual({ decision: 'approved' });
    // P6.1 — the refusal NAMES the rule. This assertion pinned
    // "The user declined this action." until 2026-08-29, which was the defect
    // rather than the contract: no user was asked, a rule refused, and the model
    // was told a human had said no. `rejection` is the only field in either
    // protocol version that can carry a reason at all
    // (`ReviewDecision::Denied { rejection }`, rust-v0.148.0).
    expect(await ask(agent, EXEC_METHOD_V1, { command: ['rm', '-rf', 'build'], cwd: PROJECT_CWD }))
      .toEqual({ decision: { denied: { rejection: 'Denied by permission rule "claude-settings-deny-0" (workspace).' } } });
    expect(surfaced).toEqual([]);
  });

  /**
   * P6.1 — the OTHER refusal a user meets with no card and no explanation.
   * `dontAsk` denies everything no rule pre-approves, by its own contract; until
   * this reason existed the model was told a human had declined, in a mode whose
   * whole premise is that no human is asked.
   *
   * KILLS: forwarding the reason on the rule path only.
   */
  it('a dontAsk refusal says it was the mode, not a person', async () => {
    const { agent, surfaced } = agentWithRules({ allow: ['Bash(git status)'] });
    // Restored in `finally`: the mode outlives this agent (every arm below
    // expects a mode that still shows cards), and leaving it set turns six later
    // assertions into silent refusals.
    agent.setPermissionMode('dontAsk');
    try {
      expect(await ask(agent, EXEC_METHOD_V1, { command: ['npm', 'publish'], cwd: PROJECT_CWD }))
        .toEqual({
          decision: {
            denied: {
              rejection: 'Denied by the dontAsk permission mode: no permission rule pre-approves this, and the mode never prompts.',
            },
          },
        });
      // POSITIVE CONTROL on the same rig and the same mode: what a rule DOES
      // pre-approve still runs, so the arm above is reading the refusal path
      // rather than a mode that refuses everything.
      expect(await ask(agent, EXEC_METHOD_V1, { command: ['git', 'status'], cwd: PROJECT_CWD }))
        .toEqual({ decision: 'approved' });
      expect(surfaced).toEqual([]);
    } finally {
      agent.setPermissionMode('default');
    }
  });
});

/**
 * The rules are written with Claude's RELATIVE anchor (`Edit(src/**)`), which
 * resolves against the request's cwd — the session's working directory, since a
 * v1 patch approval carries none of its own.
 */
describe('a file-change approval is judged per file, where the files are named', () => {
  it('accepts a patch only when every path it touches is allowed', async () => {
    const { agent, surfaced } = agentWithRules({ allow: ['Edit(src/**)'] });

    expect(await ask(agent, PATCH_METHOD_V1, {
      fileChanges: { [`${PROJECT_CWD}/src/a.ts`]: {}, [`${PROJECT_CWD}/src/nested/b.ts`]: {} },
    })).toEqual({ decision: 'approved' });
    expect(surfaced).toEqual([]);

    // One file outside the allow rule is enough to put the whole patch in front
    // of a person.
    ask(agent, PATCH_METHOD_V1, {
      fileChanges: { [`${PROJECT_CWD}/src/a.ts`]: {}, [`${PROJECT_CWD}/secrets.env`]: {} },
    });
    expect(surfaced).toHaveLength(1);
  });

  it('refuses the whole patch when any one file is denied', async () => {
    const { agent, surfaced } = agentWithRules({
      allow: ['Edit(src/**)'],
      deny: ['Edit(src/generated/**)'],
    });

    expect(await ask(agent, PATCH_METHOD_V1, {
      fileChanges: {
        [`${PROJECT_CWD}/src/a.ts`]: {},
        [`${PROJECT_CWD}/src/generated/api.ts`]: {},
      },
    })).toEqual({ decision: { denied: { rejection: 'Denied by permission rule "claude-settings-deny-0" (workspace).' } } });
    expect(surfaced).toEqual([]);
  });
});

/**
 * The limits are the point of the row: "a rule engine that starts answering
 * requests it does not actually match would be worse than not consulting one at
 * all". Each case below carries a rule that would answer if the request were
 * mapped — and the request is deliberately not mapped, so a human still decides.
 */
describe('requests no rule can honestly judge still reach the human', () => {
  it('maps only the approvals that name what a rule is written about', () => {
    // v2 exec carries the command line a `Bash(...)` rule is written against.
    expect(codexApprovalRuleRequests('command', { command: 'git status', cwd: '/w' }, '/fallback'))
      .toEqual([{ toolName: 'Bash', semanticId: 'bash', input: { command: 'git status' }, cwd: '/w' }]);
    // The request's own cwd wins; the session's is the fallback.
    expect(codexApprovalRuleRequests('command', { command: 'git status' }, '/fallback')[0]!.cwd).toBe('/fallback');
    // v1 exec carries argv; joined only when every word survives the join.
    expect(codexApprovalRuleRequests('commandV1', { command: ['git', 'status'], cwd: '/w' }, '/f')[0]!.input)
      .toEqual({ command: 'git status' });
    for (const argv of [['bash', '-c', 'rm -rf /'], ['echo', 'a b'], ['sh', '-c', 'x && y'], [], ['git', 42]]) {
      expect(codexApprovalRuleRequests('commandV1', { command: argv, cwd: '/w' }, '/f')).toEqual([]);
    }
    // v1 patch names its files; one request per file PER NAME since P6.644 —
    // the floor spelled this act `Write` while this path spelled it `Edit`, so
    // an `Edit(...)` deny had no floor subject and a `Write(...)` allow had no
    // rule subject. Both names now, from one constant, in both projections.
    expect(codexApprovalRuleRequests('fileChangeV1', { fileChanges: { '/w/a.ts': {}, '/w/b.ts': {} } }, '/f'))
      .toEqual([
        { toolName: 'Write', semanticId: 'write', input: { file_path: '/w/a.ts' }, cwd: '/f' },
        { toolName: 'Edit', semanticId: 'edit', input: { file_path: '/w/a.ts' }, cwd: '/f' },
        { toolName: 'Write', semanticId: 'write', input: { file_path: '/w/b.ts' }, cwd: '/f' },
        { toolName: 'Edit', semanticId: 'edit', input: { file_path: '/w/b.ts' }, cwd: '/f' },
      ]);
    // The three that carry nothing a rule can judge.
    expect(codexApprovalRuleRequests('fileChange', { grantRoot: '/w/src', itemId: 'i' }, '/f')).toEqual([]);
    expect(codexApprovalRuleRequests('elicitation', { serverName: 'sources', _meta: { tool_title: 'whoami' } }, '/f')).toEqual([]);
    expect(codexApprovalRuleRequests('permissions', { permissions: { network: { enabled: true } }, cwd: '/w' }, '/f')).toEqual([]);
    expect(codexApprovalRuleRequests('command', { command: '   ' }, '/f')).toEqual([]);
  });

  it('shows the card for a v2 file change, which names a grant root and no file', async () => {
    // A rule that allows every path under the project would answer if
    // `grantRoot` were read as the file being written. It is not: the grant
    // root is a directory nobody named as a target.
    const { agent, surfaced } = agentWithRules({ allow: ['Edit(**)'] });

    ask(agent, FILE_CHANGE_METHOD, { grantRoot: `${PROJECT_CWD}/src`, itemId: 'item-1' });

    expect(surfaced).toHaveLength(1);
  });

  it('shows the card for an MCP elicitation, whose wire tool name we do not have', async () => {
    const { agent, surfaced } = agentWithRules({ allow: ['mcp__sources', 'Bash(git status)'] });

    ask(agent, MCP_ELICITATION_METHOD, {
      serverName: 'sources',
      mode: 'openai/form',
      message: 'Approve app tool call?',
      _meta: { tool_title: 'whoami', connector: 'cdp-echo-probe' },
      requestedSchema: { type: 'object', properties: { approval_mode: { enum: ['approve'] } } },
    });

    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]!.toolName).toBe('whoami');
  });

  it('shows the card for a sandbox-widening request, which no rule form speaks about', async () => {
    const { agent, surfaced } = agentWithRules({ allow: ['Bash(git status)'], deny: ['Bash(rm -rf *)'] });

    ask(agent, PERMISSIONS_METHOD, {
      threadId: 't', turnId: 'u', itemId: 'i', startedAtMs: 1,
      cwd: PROJECT_CWD, environmentId: null, reason: 'needs the network',
      permissions: { network: { enabled: true } },
    });

    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]!.toolName).toBe('request_permissions');
  });
});

describe('what R6 must not change', () => {
  it("consults the rules AHEAD of the unattended fallback, so a user's deny outranks the open escape hatch (P6.713)", async () => {
    // The order this case pins was INVERTED until `4ca240769`, and the inversion
    // was the defect P6.713 names: the unattended block returned above
    // `consultPermissionRules`, so its own debug line claimed *no rule and no
    // floor covered the call* about a call a rule covered exactly. Rules first
    // is not a posture — it is what a rule the user wrote is for.
    //
    // Three arms, and the third is what makes the second mean anything:
    //   1. deny rule, hatch CLOSED  -> decline. P6.531's fail-closed default,
    //      matching Pi's fallback and claude's `CAN_USE_TOOL_NO_SURFACE_DENIAL`.
    //   2. deny rule, hatch OPEN    -> decline. The rule wins over the hatch.
    //   3. NO rule,   hatch OPEN    -> accept.  The hatch's own answer, proving
    //      arm 2's decline came from the rule and not from an inert hatch.
    const previous = process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR];
    delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR];
    try {
      const ruled = new CodexAgent(createConfig());
      ruled.getPermissionManager().setCapabilityPermissionLayers(
        [{ content: JSON.stringify({ permissions: { deny: ['Bash(rm -rf *)'] } }), scope: 'workspace' }],
        'generation-r6',
        true,
      );
      // No permission callback on either agent: unattended.
      expect(await ask(ruled, EXEC_METHOD, { command: 'rm -rf build', cwd: PROJECT_CWD }))
        .toEqual({ decision: 'decline' });

      process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR] = 'allow';
      expect(await ask(ruled, EXEC_METHOD, { command: 'rm -rf build', cwd: PROJECT_CWD }))
        .toEqual({ decision: 'decline' });

      const unruled = new CodexAgent(createConfig());
      unruled.getPermissionManager().setCapabilityPermissionLayers([], 'generation-r6', true);
      expect(await ask(unruled, EXEC_METHOD, { command: 'rm -rf build', cwd: PROJECT_CWD }))
        .toEqual({ decision: 'accept' });
    } finally {
      delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR];
      if (previous !== undefined) process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR] = previous;
    }
  });

  it('keeps the url-scheme gate ahead of anything shown or answered', async () => {
    const { agent, surfaced, debug } = agentWithRules({ allow: ['Bash(git status)'] });
    const opened: string[] = [];
    (agent as any).openExternalUrl = async (url: string) => { opened.push(url); };

    expect(await ask(agent, MCP_ELICITATION_METHOD, {
      serverName: 'sources', mode: 'url', message: 'Sign in', url: 'javascript:alert(1)', elicitationId: 'e1',
    })).toEqual({ action: 'decline', content: null });
    expect(surfaced).toEqual([]);
    expect(opened).toEqual([]);
    expect(debug).toEqual(['codex elicitation allow degraded to decline: url-mode refused: not an http(s) url']);
  });

  it('refuses every call under a policy that failed closed, naming its diagnostic (F1.1002)', async () => {
    const { agent, surfaced, debug } = agentWithRules(null);
    // Since F1.831 (`db21edbc0`) only a broken MANAGED document (a `builtin`
    // capability layer maps there) or P2.269's deny/ask cap overflow still
    // marks the whole program invalid; `evaluatePermissionDslV1` then answers
    // `deny` with the sentinel rule id. F1.1002 (option A's managed half): that
    // deny REFUSES here as Pi refuses every call — it was a card until then —
    // and the refusal is the compiler's diagnostic, never the sentinel id.
    // The workspace boundary (dropped whole, still consulted) is the next case.
    agent.getPermissionManager().setCapabilityPermissionLayers(
      [{ content: JSON.stringify({ permissionDsl: { version: 1, rules: 'not-a-list' } }), scope: 'builtin' }],
      'generation-r6',
      true,
    );

    expect(await ask(agent, EXEC_METHOD_V1, { command: ['git', 'status'], cwd: PROJECT_CWD }))
      .toEqual({ decision: { denied: { rejection: 'Permission DSL document is invalid.' } } });

    expect(policyFor(agent)!.invalidSource?.scope).toBe('managed');
    expect(surfaced).toEqual([]);
    expect(debug.some(line => line.startsWith('codex permission rules were not consulted'))).toBe(false);
  });

  it('drops a broken workspace document whole, and the other documents still answer (F1.831)', async () => {
    // `managed-settings.md#keys-that-fail-closed`: "a file whose JSON or
    // top-level shape fails validation is rejected as a whole and reported".
    // `broken` compiles its allow BEFORE the unknown matcher kind fails it, so
    // arm 1 asks again only if that allow went with the document; arm 2 is the
    // same allow in a readable document beside it, and it still answers.
    const allowGit = { id: 'allow-git', action: 'allow', match: { kind: 'bash', executable: 'git' } };
    const broken = JSON.stringify({ permissionDsl: { version: 1, rules: [
      allowGit, { id: 'odd', action: 'allow', match: { kind: 'substring', value: 'git' } },
    ] } });
    const readable = JSON.stringify({ permissionDsl: { version: 1, rules: [allowGit] } });
    const withLayers = (layers: Array<{ content: string; scope: 'global' | 'workspace' }>) => {
      const session = agentWithRules(null);
      session.agent.getPermissionManager().setCapabilityPermissionLayers(layers, 'generation-r6', true);
      return session;
    };

    const alone = withLayers([{ content: broken, scope: 'workspace' }]);
    ask(alone.agent, EXEC_METHOD, { command: 'git status', cwd: PROJECT_CWD });
    expect(policyFor(alone.agent)!.droppedSources?.map(source => source.scope)).toEqual(['workspace']);
    expect(alone.surfaced).toHaveLength(1);
    // Consulted, not collapsed: the drop is announced, it is not a verdict.
    expect(alone.debug.some(line => line.startsWith('codex permission rules were not consulted'))).toBe(false);

    const beside = withLayers([{ content: readable, scope: 'global' }, { content: broken, scope: 'workspace' }]);
    expect(await ask(beside.agent, EXEC_METHOD, { command: 'git status', cwd: PROJECT_CWD }))
      .toEqual({ decision: 'accept' });
    expect(beside.surfaced).toEqual([]);
  });
});

/**
 * THE TWO WIDENINGS THE REVIEW MEASURED, each pinned so it cannot come back.
 *
 * Both were real on the first version of this row, and both are the same
 * mistake: a rule that ANSWERS must never permit what the runtime would have
 * refused anyway. A rule is allowed to save the user a click; it is not allowed
 * to outrank the mode they chose or the floors nobody may cross.
 *
 * These matter more on codex than anywhere else. The standing sandbox-off
 * default emits `danger-full-access` for every mode, so the approval card is
 * the only thing carrying a read-only mode's intent to this runtime.
 */
describe('a rule may not answer what the mode or the floors would refuse', () => {
  it('does not let an allow rule write in a read-only mode', async () => {
    const { agent, surfaced } = agentWithRules({ allow: ['Bash(git commit *)'] });
    (agent as any).setPermissionMode?.('plan');

    const pending = ask(agent, EXEC_METHOD, { command: 'git commit -m x', cwd: PROJECT_CWD });

    // The card is the assertion: the human still decides, because `plan` is
    // how the user said "no writes" and a rule written for another mode does
    // not get to answer on their behalf.
    expect(surfaced).toHaveLength(1);
    void pending;
  });

  it('does not let an allow rule reach a path denied in every mode', async () => {
    const { agent, surfaced, debug } = agentWithRules({ allow: ['Edit(src/**)'] });

    // `mode-types.ts` ships this list as paths that must not be read or written
    // in ANY permission mode. An ordinary allow rule matching the directory
    // must not turn that into a silent yes.
    //
    // THE SHAPE OF "must not" CHANGED AND THIS ASSERTION HAD NOT (`P6.699`,
    // 2026-09-07). `91f09bad5` — "a deniedPaths refusal denies on codex instead
    // of asking the user about it" — made the floor REFUSE outright where it
    // used to raise a card, and did not update this case. So the old
    // `toHaveLength(1)` had been failing on the safest possible behaviour: the
    // measured decision is
    // `{ denied: { rejection: 'Sensitive path blocked: Write attempted to
    // access …/src/deploy/id_rsa.pem (matched deniedPaths pattern …)' } }`, and
    // ZERO cards is the STRONGER outcome, not the missing guard.
    //
    // Which is exactly why the decision is asserted here and not the card count
    // alone: `surfaced` being empty is ambiguous by itself — it is equally what
    // a silent yes looks like — and this file's whole subject is a rule that
    // must not answer for a floor. The sibling case above still expects a card
    // because ITS refusal comes from the MODE, which is the user's own choice
    // and theirs to reconsider at the prompt; a floor is nobody's to override.
    const decision = await ask(agent, PATCH_METHOD_V1, {
      fileChanges: { [`${PROJECT_CWD}/src/deploy/id_rsa.pem`]: {} },
    });

    // READ THE VALUE FIRST, then assert on it — never assert the shape with an
    // asymmetric matcher and then read the same object. Measured on bun 1.3.14
    // while writing this case: `toMatchObject` with an `expect.stringContaining`
    // inside it REPLACES the received property with the matcher, so the next
    // line reads `[object ExpectStringContaining]` (`JSON.stringify` → `{}`)
    // instead of the rejection. `toEqual` with the identical matcher does not,
    // and the same object with a literal expectation is untouched — both
    // controls run. AGENTS.md §Traps carries it.
    const rejection = String((decision as { decision?: { denied?: { rejection?: unknown } } })
      .decision?.denied?.rejection ?? '');
    expect(rejection).toContain('id_rsa.pem');
    expect(rejection).toContain('deniedPaths');
    expect(surfaced).toEqual([]);
    expect(debug.some(line => line.startsWith('codex approval denied by the deniedPaths floor'))).toBe(true);
  });

  it('still answers when the mode and the floors both permit it', async () => {
    // The positive control. Without it, the two cases above are equally
    // satisfied by a guard that refuses to answer anything at all.
    const { agent, surfaced } = agentWithRules({ allow: ['Edit(src/**)'] });
    // Set explicitly. The mode is stored per session key, and every agent in
    // this file shares one — so the read-only case above leaks into here
    // unless this says what it means.
    (agent as any).setPermissionMode?.('default');

    const result = await ask(agent, PATCH_METHOD_V1, {
      fileChanges: { [`${PROJECT_CWD}/src/a.ts`]: {} },
    });

    expect(result).toEqual({ decision: 'approved' });
    expect(surfaced).toEqual([]);
  });
});
