/**
 * F1.272 (origin WJ-z P-WJ-z-1) — the user's allow/deny rules answer codex's MCP
 * tool-call approval, the way they answer the same call on Pi and claude.
 *
 * ## The premise this row refutes
 *
 * `codexApprovalRuleRequests` returned `[]` for the `elicitation` kind on the
 * premise "an MCP elicitation carries no wire tool name". At `rust-v0.154.0`
 * the MCP tool-call frame (`_meta.codex_approval_kind = "mcp_tool_call"`,
 * `core/src/mcp_tool_call.rs`) names the tool in codex's fixed sentence
 * `Allow the <server> MCP server to run tool "<tool>"?`, and
 * `codexMcpToolCallRowName` (`approval-bridge.ts`, F1.218) reads it. So every
 * default-mode codex pool call was carded whatever the rules said.
 *
 * ## The DSL's missing `sources` shift, and why it does not bite here
 *
 * `permission-dsl.ts`'s `mcp` matcher splits the REQUEST's name on `__` and
 * takes the second segment as the server, with no bridge shift — so a
 * Pi-spelled `mcp__<wire>__*` rule judged against codex's row name
 * `mcp__sources__<wire>__<tool>` would read server `sources` and miss
 * (runtime-switching plan, capability-audit row 3). The projection therefore
 * hands the DSL the HOST's name for the call — the one Pi and claude record,
 * `mcp__<wire>__<tool>` (`base-event-adapter.ts` `buildMcpToolName`) — so the
 * shift happens before the matcher and a rule written once answers on all three
 * runtimes. The consequence, pinned below as a boundary: a rule spelled in
 * codex's ROW form (`mcp__sources__…`) names a server no runtime records and
 * matches nothing here either.
 *
 * Frames are the shape the shipped binary sends
 * (`codex-mcp-tool-approval-modes.test.ts`'s measured frame), driven through the
 * REAL `handleServerRequest`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MCP_ELICITATION_METHOD } from '@nessy-agent/codex-agent-server';
import type { BackendConfig, PermissionCallback } from '../backend/types.ts';
import { CodexAgent, codexApprovalRuleRequests } from '../codex-agent.ts';
import { UNATTENDED_APPROVAL_FALLBACK_ENV_VAR } from '../../config/unattended-approval.ts';
import { permissionsConfigCache } from '../permissions-config.ts';
import type { PermissionMode } from '../mode-types.ts';

const WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'wjhh-f1272-'));
writeFileSync(join(WORKSPACE_ROOT, 'automations.json'), JSON.stringify({
  version: 2,
  automations: {
    SchedulerTick: [
      { id: 'dormant-bypass', name: 'Weekly purge', cron: '0 5 * * 0', permissionMode: 'bypassPermissions', enabled: false, actions: [{ type: 'prompt', prompt: 'old' }] },
      { id: 'tidy', name: 'Tidy', cron: '0 4 * * *', permissionMode: 'acceptEdits', actions: [{ type: 'prompt', prompt: 'old' }] },
    ],
  },
}));
afterAll(() => {
  rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
});
beforeEach(() => {
  permissionsConfigCache.clear();
  delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR];
});
afterEach(() => {
  delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR];
});

/**
 * A hyphen-free source slug ON PURPOSE. The measured frame's wire
 * (`plugin_cdp-echo-probe_echo`) carries hyphens, and a Claude-syntax rule
 * naming a hyphenated server WAS refused by the rule GRAMMAR before any runtime
 * saw it (`claude-permission-rules.ts` `RULE_SHAPE` admitted no `-`, so
 * `mcp__google-drive__search` parsed as `claude_rule.invalid` on Pi and claude
 * too) — a separate, runtime-independent defect, fixed since by F1.367, and
 * not what this file measures.
 */
const WIRE = 'linear';
/** Pi's and claude's name for the pool call below — the host vocabulary. */
const HOST_NAME = `mcp__${WIRE}__whoami`;
/** Codex's row name for the same call — F1.218's card title and the transcript row. */
const CODEX_ROW_NAME = `mcp__sources__${WIRE}__whoami`;

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-f1272',
      name: 'F1.272 Workspace',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: join(WORKSPACE_ROOT, 'sessions'),
    } as any,
    session: {
      id: 'session-f1272',
      workspaceRootPath: WORKSPACE_ROOT,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

/** codex's MCP tool-call approval for one call of `tool` on `server`. */
function frame(server: string, tool: string, toolParams: Record<string, unknown> = {}) {
  return {
    threadId: 'thread-f1272',
    turnId: 'turn-f1272',
    serverName: server,
    mode: 'form',
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      persist: ['session', 'always'],
      tool_params: toolParams,
      tool_params_display: [],
    },
    message: `Allow the ${server} MCP server to run tool "${tool}"?`,
    requestedSchema: { type: 'object', properties: {} },
  };
}

/**
 * A session whose rules are exactly `rules` (the `.claude/settings.json`
 * `permissions` block, published through the capability layer handoff), or no
 * layer at all for `null` — the negative control.
 */
function session(rules: Record<string, string[]> | null, mode: PermissionMode = 'default', attended = true) {
  const agent = new CodexAgent(createConfig());
  const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
  const debug: string[] = [];
  agent.onDebug = (line) => { debug.push(line); };
  if (attended) agent.onPermissionRequest = (request) => { surfaced.push(request); };
  agent.setPermissionMode(mode);
  agent.getPermissionManager().setCapabilityPermissionLayers(
    rules === null ? [] : [{ content: JSON.stringify({ permissions: rules }), scope: 'workspace' }],
    'generation-f1272',
    true,
  );
  const ask = (params: unknown) =>
    (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, params) as
      Record<string, unknown> | Promise<Record<string, unknown>>;
  return { agent, surfaced, debug, ask };
}

const ACCEPT = { action: 'accept', content: {} };
const DECLINE = { action: 'decline', content: null };

describe('F1.272 · the projection names the call in the host vocabulary', () => {
  it('a pool call projects to the name Pi and claude record, with the call\'s own arguments', () => {
    expect(codexApprovalRuleRequests('elicitation', frame('sources', `${WIRE}__whoami`, { who: 'me' }), '/cwd'))
      .toEqual([{ toolName: HOST_NAME, semanticId: 'mcp_dynamic', input: { who: 'me' }, cwd: '/cwd' }]);
  });

  it('a session call keeps claude\'s name and carries Pi\'s as its alias (F1.379: the two runtimes spell it differently)', () => {
    expect(codexApprovalRuleRequests('elicitation', frame('session', 'automation_update', { automationId: 'tidy' }), '/cwd'))
      .toEqual([{ toolName: 'mcp__session__automation_update', semanticId: 'mcp_dynamic', input: { automationId: 'tidy' }, cwd: '/cwd', alias: { toolName: 'automation_update', semanticId: 'automation_update' } }]);
  });

  it('a server\'s own question, a url elicitation and a template sentence still project nothing', () => {
    expect(codexApprovalRuleRequests('elicitation', { serverName: 'sources', _meta: { tool_title: 'whoami' } }, '/cwd')).toEqual([]);
    expect(codexApprovalRuleRequests('elicitation', {
      serverName: 'sources', mode: 'url', message: 'Sign in', url: 'https://example.com', elicitationId: 'e1',
    }, '/cwd')).toEqual([]);
    expect(codexApprovalRuleRequests('elicitation', {
      ...frame('sources', `${WIRE}__whoami`), message: 'Approve app tool call?',
    }, '/cwd')).toEqual([]);
  });
});

describe('F1.272 · a rule written once answers codex\'s MCP tool-call card', () => {
  it('an allow rule accepts a pool call with no card', async () => {
    for (const rule of [HOST_NAME, `mcp__${WIRE}__*`]) {
      const { surfaced, debug, ask } = session({ allow: [rule] });
      const answer = ask(frame('sources', `${WIRE}__whoami`));
      expect(answer).not.toBeInstanceOf(Promise);
      expect(await answer).toEqual(ACCEPT);
      expect(surfaced).toEqual([]);
      expect(debug.some(line => line.includes('auto-allowed by permission rule'))).toBe(true);
    }
  });

  it('a deny rule declines a pool call with no card, and names the rule', async () => {
    const { surfaced, debug, ask } = session({ deny: [`mcp__${WIRE}`] });
    expect(await ask(frame('sources', `${WIRE}__whoami`))).toEqual(DECLINE);
    expect(surfaced).toEqual([]);
    expect(debug.some(line => line.includes('refused by permission rule'))).toBe(true);
  });

  it('a session tool is answered by its own rule, both ways', async () => {
    const allowed = session({ allow: ['mcp__session__automation_update'] });
    expect(await allowed.ask(frame('session', 'automation_update', { automationId: 'tidy', patch: { name: 'Tidier' } })))
      .toEqual(ACCEPT);
    expect(allowed.surfaced).toEqual([]);

    const denied = session({ deny: ['mcp__session__automation_update'] });
    expect(await denied.ask(frame('session', 'automation_update', { automationId: 'tidy', patch: { name: 'Tidier' } })))
      .toEqual(DECLINE);
    expect(denied.surfaced).toEqual([]);
  });

  it('a deny rule outranks bypassPermissions\' yes and the unattended escape hatch, as on Pi', async () => {
    const bypass = session({ deny: [`mcp__${WIRE}`] }, 'bypassPermissions');
    expect(await bypass.ask(frame('sources', `${WIRE}__whoami`))).toEqual(DECLINE);

    process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR] = 'allow';
    const unattended = session({ deny: [`mcp__${WIRE}`] }, 'default', false);
    expect(await unattended.ask(frame('sources', `${WIRE}__whoami`))).toEqual(DECLINE);
  });

  it('dontAsk runs what an allow rule pre-approves and declines the rest, with no card (R13\'s other half)', async () => {
    const allowed = session({ allow: [HOST_NAME] }, 'dontAsk');
    expect(await allowed.ask(frame('sources', `${WIRE}__whoami`))).toEqual(ACCEPT);
    expect(allowed.surfaced).toEqual([]);

    const unmatched = session({ allow: [HOST_NAME] }, 'dontAsk');
    expect(await unmatched.ask(frame('sources', `${WIRE}__whois`))).toEqual(DECLINE);
    expect(unmatched.surfaced).toEqual([]);
  });

  it('an allow rule answers an unattended turn, which the fallback would have refused', async () => {
    const { ask } = session({ allow: [HOST_NAME] }, 'default', false);
    expect(await ask(frame('sources', `${WIRE}__whoami`))).toEqual(ACCEPT);
  });
});

describe('F1.272 · what the rules must NOT change', () => {
  it('NEGATIVE CONTROL: with the rule taken away the card comes back', async () => {
    const { agent, surfaced, ask } = session(null);
    const pending = ask(frame('sources', `${WIRE}__whoami`));
    expect(pending).toBeInstanceOf(Promise);
    expect(surfaced).toHaveLength(1);
    agent.respondToPermission(surfaced[0]!.requestId, true);
    expect(await pending).toEqual(ACCEPT);
  });

  it('BOUNDARY: a rule spelled in codex\'s row form names a server no runtime records, and asks', async () => {
    for (const rule of [CODEX_ROW_NAME, 'mcp__sources__*', 'mcp__sources']) {
      const { surfaced, ask } = session({ allow: [rule] });
      expect(ask(frame('sources', `${WIRE}__whoami`))).toBeInstanceOf(Promise);
      expect(surfaced).toHaveLength(1);
    }
  });

  it('F1.227\'s floor suspends an allow rule — the card still reaches the person — while a deny still refuses', async () => {
    const reenable = { automationId: 'dormant-bypass', patch: { enabled: true } };
    const allowed = session({ allow: ['mcp__session__automation_update'] });
    const pending = allowed.ask(frame('session', 'automation_update', reenable));
    expect(pending).toBeInstanceOf(Promise);
    expect(allowed.surfaced).toHaveLength(1);
    expect(allowed.surfaced[0]!.noAlwaysAllow).toBe(true);
    expect(allowed.surfaced[0]!.description).toContain('"Weekly purge" (dormant-bypass) runs (enabled)');

    const denied = session({ deny: ['mcp__session__automation_update'] });
    expect(await denied.ask(frame('session', 'automation_update', reenable))).toEqual(DECLINE);
  });

  it('an allow rule does not widen a read-only mode: the pool call is REFUSED in plan (F1.374), no card', async () => {
    const { surfaced, ask } = session({ allow: [HOST_NAME] }, 'plan');
    const answer = ask(frame('sources', `${WIRE}__whoami`));
    // Until F1.374 this asked (a card); the mode block now answers first, as on
    // Pi — and the allow rule still cannot turn it into an accept.
    expect(answer).not.toBeInstanceOf(Promise);
    expect(await answer).toEqual(DECLINE);
    expect(surfaced).toEqual([]);
  });

  it('the url-scheme gate still answers a url elicitation ahead of any rule', async () => {
    const { surfaced, ask } = session({ allow: ['mcp__sources', `mcp__${WIRE}`] });
    expect(await ask({
      serverName: 'sources', mode: 'url', message: 'Sign in', url: 'javascript:alert(1)', elicitationId: 'e1',
    })).toEqual(DECLINE);
    expect(surfaced).toEqual([]);
  });
});

/**
 * F1.379 (origin the WJ-hh verifier on F1.272; DECIDED 2026-09-23) — a session
 * tool is judged under Pi's name too.
 *
 * Codex projected `mcp__session__<tool>` with `semanticId: 'mcp_dynamic'`; Pi
 * judges the same call under the binding's `permissionName` (the handler name)
 * and its `descriptorId` (`harness-tool-descriptor.ts` `sessionBinding`). So
 * `deny spawn_session` DECLINED on Pi and CARDED on codex, and an allow written
 * in Pi's spelling never answered codex's card. The projection now carries Pi's
 * pair as an ALIAS of the same call, and the consult reads both names as ONE
 * subject: a deny or an ask under either name wins (deny > ask > allow, the DSL's
 * own order), and an allow under either name answers — so F1.272's
 * `allow mcp__session__<tool>` still holds and Pi's `allow <tool>` now holds too.
 */
describe('F1.379 · a session tool is judged under Pi\'s name as well as the host\'s', () => {
  it('the projection carries Pi\'s handler name and descriptor id beside the host name', () => {
    const [spawn] = codexApprovalRuleRequests('elicitation', frame('session', 'spawn_session', { prompt: 'x' }), '/cwd');
    expect(spawn).toEqual({
      toolName: 'mcp__session__spawn_session', semanticId: 'mcp_dynamic', input: { prompt: 'x' }, cwd: '/cwd',
      alias: { toolName: 'spawn_session', semanticId: 'spawn_session' },
    });
    // A handler name that is NOT its descriptor id: both halves of Pi's pair.
    const [plan] = codexApprovalRuleRequests('elicitation', frame('session', 'SubmitPlan'), '/cwd');
    expect(plan!.alias).toEqual({ toolName: 'SubmitPlan', semanticId: 'submit_plan' });
  });

  it('a pool call carries no alias: Pi already records it under the host name', () => {
    const [pool] = codexApprovalRuleRequests('elicitation', frame('sources', `${WIRE}__whoami`), '/cwd');
    expect(pool!.alias).toBeUndefined();
  });

  it('deny under Pi\'s spelling, and under the host\'s, each DECLINE the codex card', async () => {
    for (const rule of ['spawn_session', 'mcp__session__spawn_session']) {
      const { surfaced, ask } = session({ deny: [rule] });
      expect(await ask(frame('session', 'spawn_session', { prompt: 'x' }))).toEqual(DECLINE);
      expect(surfaced).toEqual([]);
    }
  });

  it('an allow in Pi\'s spelling ACCEPTS, as it does on Pi', async () => {
    const { surfaced, ask } = session({ allow: ['spawn_session'] });
    expect(await ask(frame('session', 'spawn_session', { prompt: 'x' }))).toEqual(ACCEPT);
    expect(surfaced).toEqual([]);
  });

  it('across the two names a deny outranks an allow, and an ask keeps the card', async () => {
    const denied = session({ allow: ['mcp__session__spawn_session'], deny: ['spawn_session'] });
    expect(await denied.ask(frame('session', 'spawn_session', { prompt: 'x' }))).toEqual(DECLINE);

    const asked = session({ allow: ['mcp__session__spawn_session'], ask: ['spawn_session'] });
    expect(asked.ask(frame('session', 'spawn_session', { prompt: 'x' }))).toBeInstanceOf(Promise);
    expect(asked.surfaced).toHaveLength(1);
  });

  it('CONTROL: with no rules the session call still reaches the person', () => {
    const { surfaced, ask } = session(null);
    expect(ask(frame('session', 'spawn_session', { prompt: 'x' }))).toBeInstanceOf(Promise);
    expect(surfaced).toHaveLength(1);
  });
});
