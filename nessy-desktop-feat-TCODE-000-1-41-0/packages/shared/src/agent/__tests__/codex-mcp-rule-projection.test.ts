/**
 * F1.378 (origin the WJ-hh verifier on F1.272; DECIDED 2026-09-23, native-first)
 * — the user's `mcp__` deny/ask rules are projected into codex's OWN per-server
 * levers, and a rule no lever can carry is SAID.
 *
 * ## The gap
 *
 * F1.272 made codex's MCP tool-call approval consult these rules, but only when
 * codex asks. At `rust-v0.154.0` codex asks nothing for a tool its server
 * annotates `readOnlyHint: true` (`core/src/mcp_tool_call.rs`
 * `requires_mcp_tool_approval`), and F1.272 had also stopped claiming `mcp`
 * rules in `classifyCodexUnboundPermissionRules` — so `deny: ['mcp__x__y']` on
 * such a tool was consulted nowhere on codex, while Pi refuses it, and nothing
 * said so (`describeCodexUnboundPermissionRules([])` is `undefined`).
 *
 * ## The pins
 *
 * - the pure projection (`projectCodexMcpPermissionRules`): deny → the entry's
 *   `disabledTools`, ask → `promptTools`, allow → nothing; `session` rules on
 *   `[mcp_servers.session]` under the bare tool name, every other server's on
 *   the pool entry under `<wire>__<tool>`; a whole-server or `*` rule is
 *   UNEXPRESSIBLE and named by the facts sentence;
 * - the agent half (`CodexAgent.codexMcpRuleProjection`): the SAME merged
 *   policy the rule consult evaluates reaches the writer's `mcpToolLevers`, and
 *   the facts sentence lands on the session-facts channel;
 * - CONTROL: a policy with no MCP rules projects nothing and records no fact.
 *
 * The writer's emission is `codex-responses-adapter`'s
 * `config-writer-mcp-tool-levers.test.ts`; the binary's reading of the two keys
 * is `mcp/__tests__/codex-mcp-tool-levers-live.test.ts`.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';
import {
  describeCodexUnprojectedMcpRules,
  projectCodexMcpPermissionRules,
} from '../codex-permission-rule-support.ts';
import { permissionsConfigCache } from '../permissions-config.ts';
import { buildCodexConfigToml, type CodexConfigOptions } from '@nessy-agent/codex-responses-adapter/config-writer';

const WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'wjrr-f1378-'));
afterAll(() => { rmSync(WORKSPACE_ROOT, { recursive: true, force: true }); });
beforeEach(() => { permissionsConfigCache.clear(); });

const mcp = (id: string, action: string, server: string, tool?: string, text?: string) => ({
  id, action, ...(text ? { text } : {}),
  matcher: { kind: 'mcp', server, ...(tool === undefined ? {} : { tool }) },
});

describe('F1.378 · projectCodexMcpPermissionRules', () => {
  it('deny → disabled_tools and ask → prompt, per entry, under the raw names codex filters by', () => {
    const projection = projectCodexMcpPermissionRules({
      rules: [
        mcp('r1', 'deny', 'session', 'automation_update'),
        mcp('r2', 'ask', 'session', 'config_validate'),
        mcp('r3', 'deny', 'plugin_cdp-echo-probe_echo', 'whoami'),
        mcp('r4', 'ask', 'linear', 'get_issue'),
        mcp('r5', 'allow', 'linear', 'list_issues'),
      ],
    });
    expect(projection.session).toEqual({ disabledTools: ['automation_update'], promptTools: ['config_validate'] });
    expect(projection.sources).toEqual({
      disabledTools: ['plugin_cdp-echo-probe_echo__whoami'],
      promptTools: ['linear__get_issue'],
    });
    expect(projection.unexpressible).toEqual([]);
  });

  it('a deny wins over an ask on the same tool, as in the DSL', () => {
    const projection = projectCodexMcpPermissionRules({
      rules: [mcp('a', 'ask', 'linear', 'save'), mcp('d', 'deny', 'linear', 'save')],
    });
    expect(projection.sources).toEqual({ disabledTools: ['linear__save'], promptTools: [] });
  });

  it('a whole-server rule and a pattern are unexpressible, named in the facts sentence, and project nothing', () => {
    const projection = projectCodexMcpPermissionRules({
      rules: [
        mcp('s', 'deny', 'linear', undefined, 'mcp__linear'),
        mcp('w', 'ask', 'linear', 'get_*'),
        mcp('ws', 'deny', 'lin*', 'x'),
      ],
    });
    expect(projection.sources).toEqual({ disabledTools: [], promptTools: [] });
    expect(projection.unexpressible.map(rule => rule.text ?? rule.subject))
      .toEqual(['mcp__linear', 'mcp__linear__get_*', 'mcp__lin*__x']);
    const sentence = describeCodexUnprojectedMcpRules(projection.unexpressible) ?? '';
    expect(sentence).toStartWith('MCP RULES CODEX CANNOT CARRY ITSELF — 3 of your mcp__ deny/ask rules');
    expect(sentence).toContain('mcp__linear, mcp__linear__get_*, mcp__lin*__x');
  });

  it('CONTROL: a program with no MCP deny/ask rule projects nothing and says nothing', () => {
    const projection = projectCodexMcpPermissionRules({
      rules: [
        mcp('allow', 'allow', 'linear', 'whoami'),
        { id: 'bash', action: 'deny', matcher: { kind: 'bashPattern' } },
      ],
    });
    expect(projection).toEqual({
      session: { disabledTools: [], promptTools: [] },
      sources: { disabledTools: [], promptTools: [] },
      unexpressible: [],
    });
    expect(describeCodexUnprojectedMcpRules(projection.unexpressible)).toBeUndefined();
    expect(projectCodexMcpPermissionRules(undefined).unexpressible).toEqual([]);
  });
});

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-f1378', name: 'F1.378', rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT, sessionRootPath: join(WORKSPACE_ROOT, 'sessions'),
    } as any,
    session: { id: 'session-f1378', workspaceRootPath: WORKSPACE_ROOT, createdAt: Date.now(), lastUsedAt: Date.now() } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

/** A codex session whose rules are exactly `rules`, published as the capability layer handoff does. */
function agentWith(rules: Record<string, string[]>): CodexAgent {
  const agent = new CodexAgent(createConfig());
  agent.onDebug = () => {};
  agent.getPermissionManager().setCapabilityPermissionLayers(
    [{ content: JSON.stringify({ permissions: rules }), scope: 'workspace' }],
    'generation-f1378',
    true,
  );
  return agent;
}

describe('F1.378 · CodexAgent hands the writer the SAME merged policy the rule consult evaluates', () => {
  it('the user\'s mcp__ deny/ask rules reach mcpToolLevers, and an unexpressible one is a session fact', () => {
    const agent = agentWith({
      deny: ['mcp__linear__whoami', 'mcp__session__automation_update', 'mcp__github'],
      ask: ['mcp__linear__get_issue'],
      allow: ['mcp__linear__list_issues'],
    });
    try {
      const options = (agent as any).codexMcpRuleProjection() as { mcpToolLevers?: unknown };
      expect(options.mcpToolLevers).toEqual({
        session: { disabledTools: ['automation_update'], promptTools: [] },
        sources: { disabledTools: ['linear__whoami'], promptTools: ['linear__get_issue'] },
      });
      const fact = (agent as any).sessionFacts.get('codex-mcp-rules-unprojected') as string | undefined;
      expect(fact ?? '').toContain('mcp__github');
    } finally { agent.destroy(); }
  });

  it('CONTROL: a policy with no MCP rules hands the writer nothing and records no fact', () => {
    const agent = agentWith({ deny: ['Bash(rm -rf:*)'], allow: ['Read'] });
    try {
      expect((agent as any).codexMcpRuleProjection()).toEqual({});
      expect((agent as any).sessionFacts.has('codex-mcp-rules-unprojected')).toBe(false);
    } finally { agent.destroy(); }
  });
});

/**
 * F1.1061 (origin DN-241, F1.1049's residue) — a whole-tool deny of web search
 * removes BOTH searches a codex session can be handed: the app's `web_search`
 * (codex never asks about it — its server marks it read-only — so only the
 * `disabled_tools` lever holds) and codex's own hosted search, which the writer
 * switches off on the ChatGPT (Codex) card. Measured on the shipped
 * `codex-app-server` (rust-v0.156.1, scratch CODEX_HOME, loopback stub): the
 * card's first Responses request carries `{"type":"web_search"}` by default
 * (Cached; Live under full access) and none with `web_search = "disabled"`,
 * under both profiles.
 */
const tool = (id: string, action: string, semanticId: string) => ({ id, action, matcher: { kind: 'tool', semanticId } });

describe('F1.1061 · a whole-tool WebSearch deny', () => {
  it('lands on the session entry as the app\'s search withheld plus the flag for codex\'s own, under either name', () => {
    for (const name of ['WebSearch', 'web_search', 'Web*']) {
      const projection = projectCodexMcpPermissionRules({ rules: [tool('w', 'deny', name), mcp('m', 'deny', 'session', 'web_search')] });
      expect(projection.session).toEqual({ disabledTools: ['web_search'], promptTools: [], webSearchDenied: true });
      expect(projection.sources).toEqual({ disabledTools: [], promptTools: [] });
    }
  });

  it('CONTROL: an allow or an ask of WebSearch, and a deny of another tool, project nothing', () => {
    const projection = projectCodexMcpPermissionRules({
      rules: [tool('a', 'allow', 'WebSearch'), tool('k', 'ask', 'WebSearch'), tool('f', 'deny', 'WebFetch')],
    });
    expect(projection.session).toEqual({ disabledTools: [], promptTools: [] });
    expect('webSearchDenied' in projection.session).toBe(false);
  });

  it('the user\'s deny: [\'WebSearch\'] reaches the writer through CodexAgent and switches codex\'s own search off on the card', () => {
    const agent = agentWith({ deny: ['WebSearch'] });
    try {
      const options = (agent as any).codexMcpRuleProjection() as Pick<CodexConfigOptions, 'mcpToolLevers'>;
      expect(options.mcpToolLevers?.session).toEqual({ disabledTools: ['web_search'], promptTools: [], webSearchDenied: true });
      const card = Bun.TOML.parse(buildCodexConfigToml({
        codexHome: join(WORKSPACE_ROOT, 'codex-home'), model: 'gpt-6-astra', declaredModelProvider: 'openai', ...options,
      })) as { web_search?: unknown; mcp_servers?: { session?: unknown } };
      expect(card.web_search).toBe('disabled');
    } finally { agent.destroy(); }
  });

  it('CONTROL: with no such rule the card writes no web_search key (codex\'s own default)', () => {
    const agent = agentWith({ deny: ['WebFetch'] });
    try {
      const options = (agent as any).codexMcpRuleProjection() as Pick<CodexConfigOptions, 'mcpToolLevers'>;
      expect(options).toEqual({});
      const card = Bun.TOML.parse(buildCodexConfigToml({
        codexHome: join(WORKSPACE_ROOT, 'codex-home'), model: 'gpt-6-astra', declaredModelProvider: 'openai', ...options,
      })) as Record<string, unknown>;
      expect('web_search' in card).toBe(false);
    } finally { agent.destroy(); }
  });
});
