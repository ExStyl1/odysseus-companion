/**
 * P6.790 (P6.342 split a) — `mcpServers` entries are TWO shapes, and only one
 * of them used to survive the read.
 *
 * `sub-agents.md#scope-mcp-servers-to-a-subagent`: *"Each entry in the list is
 * either an inline server definition or a string referencing an MCP server
 * already configured in your session"*, illustrated by a list mixing the two.
 *
 * MEASURED AT HEAD before this row, on the page's own example:
 *   - markdown: `mcpServerKeys: ["playwright:"]` — a server name with a trailing
 *     colon, resolving to nothing — and the `- github` reference AFTER the
 *     inline entry gone entirely, with NO diagnostic;
 *   - config.json: `Invalid orchestratorAgents[0].mcpServers[0]: expected
 *     non-empty string`, which skips the WHOLE agent definition, not just its
 *     servers.
 *
 * So the reference form the parity row records as working was lost by the mere
 * presence of an inline sibling. These cases pin both halves.
 */

import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadAgentDefinitions,
  readUserAgentDefinitions,
  type AgentDefinition,
  type AgentDefinitionLoadFailure,
} from '../definitions.ts';

function withWorkspace<T>(run: (path: string) => T): T {
  const workspace = mkdtempSync(join(tmpdir(), 'agent-mcp-parse-'));
  try {
    return run(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function loadMarkdown(body: string): {
  definitions: ReturnType<typeof readUserAgentDefinitions>;
  failures: AgentDefinitionLoadFailure[];
} {
  return withWorkspace(workspace => {
    writeFileSync(join(workspace, 'probe.md'), body, 'utf-8');
    const failures: AgentDefinitionLoadFailure[] = [];
    const definitions = readUserAgentDefinitions(workspace, failure => failures.push(failure));
    return { definitions, failures };
  });
}

function loadJson(entry: Record<string, unknown>): {
  definitions: ReturnType<typeof readUserAgentDefinitions>;
  failures: AgentDefinitionLoadFailure[];
} {
  return withWorkspace(workspace => {
    writeFileSync(
      join(workspace, 'config.json'),
      JSON.stringify({ orchestratorAgents: [entry] }),
      'utf-8',
    );
    const failures: AgentDefinitionLoadFailure[] = [];
    const definitions = readUserAgentDefinitions(workspace, failure => failures.push(failure));
    return { definitions, failures };
  });
}

describe('agent mcpServers: the inline form parses (P6.790)', () => {
  it('reads the documented example — and keeps the reference that follows it', () => {
    const { definitions, failures } = loadMarkdown([
      '---',
      'name: browser-tester',
      'description: Tests features in a real browser using Playwright',
      'mcpServers:',
      '  - playwright:',
      '      type: stdio',
      '      command: npx',
      '      args: ["-y", "@playwright/mcp@latest"]',
      '  - github',
      '---',
      'Use the Playwright tools.',
    ].join('\n'));

    expect(failures).toEqual([]);
    expect(definitions).toHaveLength(1);
    const definition = definitions[0]!;
    // The half that was silently DESTROYED: the inline body, keyed by server name.
    expect(definition.mcpServerInline).toEqual({
      playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    });
    // The half that was silently LOST: a reference listed after an inline entry.
    expect(definition.mcpServerKeys).toEqual(['github']);
  });

  it('reads a nested mapping and a `.mcp.json` remote entry', () => {
    const { definitions, failures } = loadMarkdown([
      '---',
      'name: remote-tester',
      'description: Uses a remote server',
      'mcpServers:',
      '  - docs:',
      '      type: http',
      '      url: https://example.invalid/mcp',
      '      headers:',
      '        X-Trace: on',
      '---',
      'Body.',
    ].join('\n'));

    expect(failures).toEqual([]);
    expect(definitions[0]!.mcpServerInline).toEqual({
      docs: { type: 'http', url: 'https://example.invalid/mcp', headers: { 'X-Trace': 'on' } },
    });
    expect(definitions[0]!.mcpServerKeys).toBeUndefined();
  });

  it('CONTROL — a list of plain references is byte-identical to before', () => {
    const { definitions, failures } = loadMarkdown([
      '---',
      'name: plain',
      'description: References only',
      'mcpServers:',
      '  - github',
      '  - linear',
      '---',
      'Body.',
    ].join('\n'));

    expect(failures).toEqual([]);
    expect(definitions[0]!.mcpServerKeys).toEqual(['github', 'linear']);
    // Absent, not an empty object: an agent naming no inline server must be
    // indistinguishable from one written before this field existed.
    expect(definitions[0]!.mcpServerInline).toBeUndefined();
    expect('mcpServerInline' in definitions[0]!).toBe(false);
  });

  it('CONTROL — a colon INSIDE a name is still one reference string', () => {
    // The mapping only opens on a dash item that is a bare key with nothing
    // after the colon. A qualified reference keeps its colon and stays a string,
    // which is what stops this reading from swallowing plugin-scoped names.
    const { definitions } = loadMarkdown([
      '---',
      'name: qualified',
      'description: Qualified reference',
      'mcpServers:',
      '  - plugin:linear',
      '---',
      'Body.',
    ].join('\n'));

    expect(definitions[0]!.mcpServerKeys).toEqual(['plugin:linear']);
    expect(definitions[0]!.mcpServerInline).toBeUndefined();
  });

  it('CONTROL — a trailing colon with NO body keeps the exact string HEAD produced', () => {
    // The boundary that keeps this a WIDENING rather than a reinterpretation: a
    // mapping opens only when an indented body actually follows. `- github:`
    // alone still yields the string it always did, so no shape that already
    // reached a caller changes meaning.
    const { definitions } = loadMarkdown([
      '---',
      'name: bodyless',
      'description: Bodyless',
      'mcpServers:',
      '  - github:',
      '---',
      'Body.',
    ].join('\n'));

    expect(definitions[0]!.mcpServerKeys).toEqual(['github:']);
    expect(definitions[0]!.mcpServerInline).toBeUndefined();
  });

  it('the config.json path takes the inline form too, instead of skipping the agent', () => {
    const { definitions, failures } = loadJson({
      name: 'json-tester',
      description: 'From config.json',
      systemPrompt: 'Body.',
      mcpServers: [{ playwright: { type: 'stdio', command: 'npx' } }, 'github'],
    });

    expect(failures).toEqual([]);
    expect(definitions).toHaveLength(1);
    expect(definitions[0]!.mcpServerInline).toEqual({ playwright: { type: 'stdio', command: 'npx' } });
    expect(definitions[0]!.mcpServerKeys).toEqual(['github']);
  });

  it('NEGATIVE — a malformed inline entry is still refused BY NAME', () => {
    // The point of the row is not "accept anything". An entry whose value is not
    // a server definition is an author asking for a server and getting none, so
    // it must fail loudly rather than run the agent without it.
    const { definitions, failures } = loadJson({
      name: 'broken',
      description: 'Broken',
      systemPrompt: 'Body.',
      mcpServers: [{ playwright: 'npx' }],
    });

    expect(definitions).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toContain('mcpServers[0].playwright');
    expect(failures[0]!.reason).toContain('expected an inline server definition');
  });
});

/**
 * P6.792 (P6.342 split c) — the folder-trust verdict for the inline half.
 *
 * `sub-agents.md`, the explicit `<span id="inline-server-trust" />` anchor:
 * *"Claude Code loads an inline server from an agent file in your project's
 * `.claude/agents/` directory, or in an `--add-dir` directory's
 * `.claude/agents/`, only after you [trust the folder the agent file came
 * from]."* The definition carries `provenance` (`key@generation`) and no path,
 * so the verdict has to travel WITH the map or the question is unanswerable
 * downstream.
 */
describe('the inline half carries its folder-trust verdict', () => {
  function inlineRuntimeDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
    return {
      name: 'db-admin',
      description: 'From the host snapshot',
      systemPrompt: 'Body.',
      toolset: 'read-only',
      tools: ['read'],
      tier: 'worker',
      mcpServerKeys: ['github'],
      mcpServerInline: { playwright: { type: 'stdio', command: 'npx' } },
      ...overrides,
    } as AgentDefinition;
  }

  it('stamps the verdict on a workspace definition, whose scope the page exempts', () => {
    withWorkspace(workspaceRootPath => {
      writeFileSync(join(workspaceRootPath, 'db-admin.md'), [
        '---',
        'name: db-admin',
        'description: Database administration',
        'mcpServers:',
        '  - playwright:',
        '      type: stdio',
        '      command: npx',
        '  - github',
        '---',
        'Body.',
      ].join('\n'));

      const definition = loadAgentDefinitions({ workspaceRootPath })
        .find(def => def.name === 'db-admin')!;

      expect(definition.mcpServerInline).toEqual({ playwright: { type: 'stdio', command: 'npx' } });
      expect(definition.mcpServerInlineTrusted).toBe(true);
      // The reference half is never gated — one of the two kinds the page loads
      // "without checking trust for the folder the agent file came from".
      expect(definition.mcpServerKeys).toEqual(['github']);
    });
  });

  it('NEGATIVE — a host snapshot carrying a map and no verdict loses the map', () => {
    // The one branch where absence is reachable: `...runtimeDefinition` spreads
    // whatever the descriptor carried, so a producer that never asked the trust
    // question would otherwise smuggle a startable server through. Absence
    // means untrusted; guessing the other way starts a server nobody approved.
    const definition = loadAgentDefinitions({ runtimeDefinitions: [inlineRuntimeDefinition()] })
      .find(def => def.name === 'db-admin')!;

    expect(definition.mcpServerInline).toBeUndefined();
    expect('mcpServerInline' in definition).toBe(false);
    expect(definition.mcpServerInlineTrusted).toBeUndefined();
    // Dropped, not fatal: "Claude Code skips every inline server in that agent
    // file" and the agent itself still runs, with its references intact.
    expect(definition.mcpServerKeys).toEqual(['github']);
  });

  it('CONTROL — the same snapshot WITH the verdict keeps the map', () => {
    const definition = loadAgentDefinitions({
      runtimeDefinitions: [inlineRuntimeDefinition({ mcpServerInlineTrusted: true })],
    }).find(def => def.name === 'db-admin')!;

    expect(definition.mcpServerInline).toEqual({ playwright: { type: 'stdio', command: 'npx' } });
    expect(definition.mcpServerInlineTrusted).toBe(true);
  });
});
