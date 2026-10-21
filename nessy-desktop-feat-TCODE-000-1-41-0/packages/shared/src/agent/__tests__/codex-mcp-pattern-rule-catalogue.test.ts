/**
 * F1.482 (2) (origin WJ-rr-a's F1.378 residue, 2026-09-24) — a whole-server or
 * pattern `mcp__` deny/ask rule is carried by codex's OWN exact-name lists, by
 * enumerating it over the tools codex will be handed.
 *
 * ## The gap
 *
 * F1.378 projects an exact-name rule (`mcp__<server>__<tool>`) into
 * `[mcp_servers.*]` `disabled_tools` / `tools.<name>.approval_mode = "prompt"`,
 * which the shipped binary honours even with auto-review on
 * (`mcp/__tests__/codex-mcp-tool-levers-live.test.ts`). A rule with no tool or
 * with `*` came back unexpressible, because the lists take exact names — so
 * `deny: ['mcp__<server>']` over a tool its server marks `readOnlyHint` ran on
 * codex (codex asks nothing for such a tool, and with auto-review on its reviewer
 * answers first), while Pi removes it.
 *
 * ## The pins
 *
 * - the pure enumeration: a whole-server deny carries every catalogue tool of
 *   that server, the read-only one included; a pattern ask prompts for every
 *   match on both entries; a deny beats an ask; the rule is listed as
 *   `enumerated`, not `unexpressible`;
 * - the matcher agrees with the DSL's own evaluator (`evaluatePermissionDslV1`
 *   as the oracle), rule by rule, name by name;
 * - the agent: `codexMcpRuleCatalogue` reads the session registry and the pool
 *   after its reconcile, the levers carry the pool tool, and a source still
 *   connecting when the wait runs out is SAID;
 * - CONTROL: without a catalogue F1.378 is unchanged, and a policy with no
 *   whole-server/pattern rule builds no catalogue and never waits on the pool.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';
import {
  codexMcpRuleMatchesHostToolName,
  describeCodexMcpRuleCatalogueGap,
  projectCodexMcpPermissionRules,
  type CodexMcpToolCatalogue,
} from '../codex-permission-rule-support.ts';
import { permissionsConfigCache } from '../permissions-config.ts';
import { evaluatePermissionDslV1, type CompiledPermissionDslV1 } from '../pi-harness/permission-dsl.ts';

const WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'wjag-f1482-'));
afterAll(() => { rmSync(WORKSPACE_ROOT, { recursive: true, force: true }); });
beforeEach(() => { permissionsConfigCache.clear(); });

const mcp = (id: string, action: string, server: string, tool?: string, text?: string) => ({
  id, action, ...(text ? { text } : {}),
  matcher: { kind: 'mcp', server, ...(tool === undefined ? {} : { tool }) },
});

/** SIT-11's fixture wire (one write-ish tool, one its server marks read-only) beside a second server. */
const CATALOGUE: CodexMcpToolCatalogue = {
  session: ['mcp__session__automation_update', 'mcp__session__config_validate', 'mcp__session__get_issue_notes'],
  sources: [
    'mcp__plugin_cdp-echo-probe_echo__whoami',
    'mcp__plugin_cdp-echo-probe_echo__status',
    'mcp__linear__get_issue',
    'mcp__linear__save_issue',
  ],
};

describe('F1.482 (2) · a whole-server or pattern rule, enumerated over the catalogue', () => {
  it('a whole-server deny carries every tool of that server — the read-only one included — and nothing else', () => {
    const projection = projectCodexMcpPermissionRules(
      { rules: [mcp('s', 'deny', 'plugin_cdp-echo-probe_echo', undefined, 'mcp__plugin_cdp-echo-probe_echo')] },
      CATALOGUE,
    );
    expect(projection.sources).toEqual({
      disabledTools: ['plugin_cdp-echo-probe_echo__whoami', 'plugin_cdp-echo-probe_echo__status'],
      promptTools: [],
    });
    expect(projection.session).toEqual({ disabledTools: [], promptTools: [] });
    expect(projection.unexpressible).toEqual([]);
    expect(projection.enumerated?.map(rule => rule.text)).toEqual(['mcp__plugin_cdp-echo-probe_echo']);
  });

  it('a pattern ask prompts for every match on BOTH entries, under each entry\'s raw name; a deny beats it', () => {
    const projection = projectCodexMcpPermissionRules({
      rules: [
        mcp('a', 'ask', '*', 'get_*'),
        mcp('d', 'deny', 'linear', 'get_issue'),
        mcp('ws', 'deny', 'session', 'config_*'),
      ],
    }, CATALOGUE);
    expect(projection.session).toEqual({ disabledTools: ['config_validate'], promptTools: ['get_issue_notes'] });
    expect(projection.sources).toEqual({ disabledTools: ['linear__get_issue'], promptTools: [] });
    expect(projection.enumerated?.map(rule => rule.subject)).toEqual(['mcp__*__get_*', 'mcp__session__config_*']);
  });

  it('`mcp__*` (every server) reaches the session tools and the pool alike', () => {
    const projection = projectCodexMcpPermissionRules({ rules: [mcp('all', 'deny', '*')] }, CATALOGUE);
    expect(projection.session.disabledTools).toEqual(['automation_update', 'config_validate', 'get_issue_notes']);
    expect(projection.sources.disabledTools).toHaveLength(CATALOGUE.sources.length);
  });

  it('CONTROL: without a catalogue F1.378 is unchanged — unexpressible, named, no enumerated key', () => {
    const projection = projectCodexMcpPermissionRules({
      rules: [mcp('s', 'deny', 'linear', undefined, 'mcp__linear'), mcp('x', 'deny', 'linear', 'save_issue')],
    });
    expect(projection.sources).toEqual({ disabledTools: ['linear__save_issue'], promptTools: [] });
    expect(projection.unexpressible.map(rule => rule.text ?? rule.subject)).toEqual(['mcp__linear']);
    expect('enumerated' in projection).toBe(false);
  });

  it('the gap sentence speaks only for an INCOMPLETE catalogue with an enumerated rule', () => {
    const enumerated = projectCodexMcpPermissionRules({ rules: [mcp('s', 'deny', 'linear')] }, CATALOGUE).enumerated ?? [];
    expect(describeCodexMcpRuleCatalogueGap(enumerated, CATALOGUE)).toBeUndefined();
    expect(describeCodexMcpRuleCatalogueGap([], { ...CATALOGUE, incomplete: true })).toBeUndefined();
    const sentence = describeCodexMcpRuleCatalogueGap(enumerated, { ...CATALOGUE, incomplete: true }) ?? '';
    expect(sentence).toStartWith('MCP RULES APPLIED TO THE TOOLS LISTED AT START — 1 of your whole-server or pattern');
    expect(sentence).toContain('mcp__linear');
    expect(sentence).toContain('a source was still connecting then');
  });
});

function createConfig(mcpPool?: unknown): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-f1482', name: 'F1.482', rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT, sessionRootPath: join(WORKSPACE_ROOT, 'sessions'),
    } as any,
    session: { id: 'session-f1482', workspaceRootPath: WORKSPACE_ROOT, createdAt: Date.now(), lastUsedAt: Date.now() } as any,
    model: 'codex/test-model',
    isHeadless: true,
    ...(mcpPool ? { mcpPool: mcpPool as never, mcpLeaserId: 'leaser-f1482' } : {}),
  };
}

/** A codex session whose rules are exactly `rules`, published as the capability layer handoff does. */
function agentWith(rules: Record<string, string[]>, mcpPool?: unknown): CodexAgent {
  const agent = new CodexAgent(createConfig(mcpPool));
  agent.onDebug = () => {};
  agent.getPermissionManager().setCapabilityPermissionLayers(
    [{ content: JSON.stringify({ permissions: rules }), scope: 'workspace' }],
    'generation-f1482',
    true,
  );
  return agent;
}

describe('F1.482 (2) · the matcher reads a name the way the DSL\'s own evaluator does', () => {
  const RULES = ['mcp__linear', 'mcp__linear__get_*', 'mcp__lin*__save_issue', 'mcp__*', 'mcp__*__*status', 'mcp__session', 'mcp__plugin_cdp-echo-probe_echo'];
  const NAMES = [...CATALOGUE.session, ...CATALOGUE.sources, 'mcp__linear__nested__tool', 'Bash', 'mcp__'];
  for (const text of RULES) {
    it(`${text}: codexMcpRuleMatchesHostToolName === evaluatePermissionDslV1, for every name`, () => {
      const agent = agentWith({ deny: [text] });
      try {
        const program = (agent as any).codexMcpRuleProgram() as CompiledPermissionDslV1;
        const [rule] = program.rules as unknown as Array<{ matcher: { kind: string; server: string; tool?: string } }>;
        expect(rule?.matcher.kind).toBe('mcp');
        for (const name of NAMES) {
          const oracle = evaluatePermissionDslV1(program, {
            generation: program.generation, semanticId: 'mcp_dynamic', toolName: name, input: {}, cwd: WORKSPACE_ROOT,
          }).action === 'deny';
          expect({ name, matched: codexMcpRuleMatchesHostToolName(rule!.matcher, name) }).toEqual({ name, matched: oracle });
        }
      } finally { agent.destroy(); }
    });
  }
});

/** The two pool reads `codexMcpRuleCatalogue` makes, recorded; `reconciled` decides whether the wait resolves. */
function poolStub(reconciled: boolean) {
  const calls: string[] = [];
  return {
    calls,
    pool: {
      // The one pool call the constructor makes (`registerMcpElicitationHandler`); not recorded.
      registerElicitationHandler: () => () => {},
      whenReconciled: () => { calls.push('whenReconciled'); return reconciled ? Promise.resolve() : new Promise<void>(() => {}); },
      slugsForLeaser: (leaserId: string) => { calls.push(`slugsForLeaser:${leaserId}`); return new Set(['plugin_cdp-echo-probe_echo']); },
      getProxyToolDefs: (slugs?: string[], leaserId?: string) => {
        calls.push(`getProxyToolDefs:${(slugs ?? []).join(',')}:${leaserId}`);
        return [
          { name: 'mcp__plugin_cdp-echo-probe_echo__whoami' },
          { name: 'mcp__plugin_cdp-echo-probe_echo__status', annotations: { readOnlyHint: true } },
        ];
      },
    },
  };
}

describe('F1.482 (2) · CodexAgent lists the pool at runtime build and hands the writer the enumerated rule', () => {
  it('a whole-server deny over a read-only pool tool reaches disabled_tools, and nothing is said', async () => {
    const { pool, calls } = poolStub(true);
    const agent = agentWith({ deny: ['mcp__plugin_cdp-echo-probe_echo'] }, pool);
    try {
      const catalogue = await (agent as any).codexMcpRuleCatalogue() as CodexMcpToolCatalogue;
      expect(calls).toEqual([
        'whenReconciled',
        'slugsForLeaser:leaser-f1482',
        'getProxyToolDefs:plugin_cdp-echo-probe_echo:leaser-f1482',
      ]);
      expect(catalogue.incomplete).toBeUndefined();
      expect(catalogue.session).toContain('mcp__session__automation_update');
      const options = (agent as any).codexMcpRuleProjection(catalogue) as { mcpToolLevers?: unknown };
      expect(options.mcpToolLevers).toEqual({
        sources: {
          disabledTools: ['plugin_cdp-echo-probe_echo__whoami', 'plugin_cdp-echo-probe_echo__status'],
          promptTools: [],
        },
      });
      expect((agent as any).sessionFacts.has('codex-mcp-rules-unprojected')).toBe(false);
    } finally { agent.destroy(); }
  });

  it('a source still connecting when the wait runs out: the tools listed so far are carried, and the gap is SAID', async () => {
    const { pool } = poolStub(false);
    const agent = agentWith({ ask: ['mcp__plugin_cdp-echo-probe_echo__*'] }, pool);
    try {
      const catalogue = await (agent as any).codexMcpRuleCatalogue() as CodexMcpToolCatalogue;
      expect(catalogue.incomplete).toBe(true);
      const options = (agent as any).codexMcpRuleProjection(catalogue) as { mcpToolLevers?: { sources?: unknown } };
      expect(options.mcpToolLevers?.sources).toEqual({
        disabledTools: [],
        promptTools: ['plugin_cdp-echo-probe_echo__whoami', 'plugin_cdp-echo-probe_echo__status'],
      });
      const fact = (agent as any).sessionFacts.get('codex-mcp-rules-unprojected') as string | undefined;
      expect(fact ?? '').toContain('MCP RULES APPLIED TO THE TOOLS LISTED AT START');
      expect(fact ?? '').toContain('mcp__plugin_cdp-echo-probe_echo__*');
    } finally { agent.destroy(); }
  }, 20_000);

  it('CONTROL: exact-name rules only — no catalogue is built and the pool is never waited on', async () => {
    const { pool, calls } = poolStub(false);
    const agent = agentWith({ deny: ['mcp__plugin_cdp-echo-probe_echo__whoami'], ask: ['Bash(git push:*)'] }, pool);
    try {
      expect(await (agent as any).codexMcpRuleCatalogue()).toBeUndefined();
      expect(calls).toEqual([]);
    } finally { agent.destroy(); }
  });

  it('the runtime build asks for the catalogue on the projection\'s own line', () => {
    const source = readFileSync(new URL('../codex-agent.ts', import.meta.url), 'utf-8');
    // F1.1019 · the same projection, recorded on the way for the turn-head re-fork (noteCodexMcpLeverBuild).
    expect(source).toContain('...noteCodexMcpLeverBuild(this, this.codexMcpRuleProjection(await this.codexMcpRuleCatalogue()), codexConfigFollowsCodexWebSearch({ declaredModelProvider })), // F1.378, F1.482 (2)');
    expect(source).not.toContain('...this.codexMcpRuleProjection(), // F1.378');
  });
});
