/**
 * F1.295 (origin WJ-dd's F1.258 verifier, F1.258-g) — the deferred-tool
 * catalogue and the host gate read ONE verb table.
 *
 * `catalogInput` (`deferred-mcp-tools.ts`) labels each deferred MCP tool
 * `effect=external-read, risk=low` or `external-write, risk=high` in the
 * `mcp__tool_search` output the model reads. It kept its own table — a prefix
 * regex with no `_` boundary that also knew `lookup` — so it called `getIssue` a
 * low-risk read while the gate carded it, and `describe_x`/`status_x` a
 * high-risk write while the gate allowed them. Both now read
 * `shared/src/agent/mcp-tool-name-verbs.ts`.
 *
 * Each arm compares the catalogue's label with the REAL gate's Explore verdict
 * (`runPreToolUseChecks`, the shipped default.json installed) for the same name.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPreToolUseChecks, type PermissionManagerLike } from '../../shared/src/agent/core/pre-tool-use.ts';
import { cleanupModeState, initializeModeState } from '../../shared/src/agent/mode-manager.ts';
import { getAppPermissionsDir, permissionsConfigCache } from '../../shared/src/agent/permissions-config.ts';
import { DEFERRED_MCP_TOOL_SEARCH_NAME, buildDeferredMcpToolSurface } from './deferred-mcp-tools.ts';

const SHIPPED_TEXT = readFileSync(
  join(import.meta.dir, '..', '..', '..', 'apps', 'electron', 'resources', 'permissions', 'default.json'),
  'utf-8',
);
const KEY = { workspaceId: 'ws-f1295', sessionId: 'session-f1295' };
const SERVERS = ['acme', 'dpJira'];

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
};

/** F1.258's measured floor for gate arms, same budget. */
const GATE_BUDGET_MS = 120_000;

let workspace: string;
let appDefaultPath: string;
let priorAppDefault: string | null = null;

beforeAll(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1295-')));
  const dir = getAppPermissionsDir();
  mkdirSync(dir, { recursive: true });
  appDefaultPath = join(dir, 'default.json');
  priorAppDefault = existsSync(appDefaultPath) ? readFileSync(appDefaultPath, 'utf-8') : null;
  writeFileSync(appDefaultPath, SHIPPED_TEXT, 'utf-8');
  permissionsConfigCache.clear();
});

afterAll(() => {
  cleanupModeState(KEY);
  if (priorAppDefault === null) rmSync(appDefaultPath, { force: true });
  else writeFileSync(appDefaultPath, priorAppDefault, 'utf-8');
  permissionsConfigCache.clear();
  rmSync(workspace, { recursive: true, force: true });
});

function planVerdict(toolName: string): 'read' | 'write' {
  cleanupModeState(KEY);
  initializeModeState(KEY, 'plan'); // F1.1050: the read-only mode is plan (explore retired)
  const result = runPreToolUseChecks({
    toolName,
    input: {},
    sessionId: KEY.sessionId,
    sessionKey: KEY,
    permissionMode: 'plan',
    workspaceRootPath: workspace,
    workspaceId: KEY.workspaceId,
    workingDirectory: workspace,
    activeSourceSlugs: SERVERS,
    allSourceSlugs: SERVERS,
    hasSourceActivation: false,
    permissionManager,
  });
  return result.type === 'allow' ? 'read' : 'write';
}

const proxyTool = (name: string) => ({
  name,
  label: name,
  description: `probe ${name}`,
  parameters: { type: 'object', properties: {} },
  async execute() {
    return { content: [{ type: 'text' as const, text: name }], details: {} };
  },
});

/** The catalogue's label for each name, read from the `mcp__tool_search` output the model sees. */
async function catalogueLabels(names: string[]): Promise<Record<string, 'read' | 'write'>> {
  const surface = buildDeferredMcpToolSurface({
    enabled: true,
    proxyTools: names.map(proxyTool) as never,
    loadedToolNames: new Set(),
  });
  const search = surface.tools.find(tool => tool.name === DEFERRED_MCP_TOOL_SEARCH_NAME)!;
  const result = await search.execute('search-f1295', { query: '', limit: 50 }, new AbortController().signal, undefined, {} as never);
  const text = result.content.map(part => ('text' in part ? part.text : '')).join('\n');
  const labels: Record<string, 'read' | 'write'> = {};
  for (const name of names) {
    const line = text.split('\n').find(candidate => candidate.startsWith(`- ${name} [`));
    if (!line) throw new Error(`no catalogue line for ${name}:\n${text}`);
    labels[name] = line.includes('effect=external-read, risk=low') ? 'read' : 'write';
  }
  return labels;
}

describe('F1.295 · the catalogue labels a deferred MCP tool as the gate judges its name', () => {
  it('getIssue, describe_x, status_x, search_issues, lookup_user and get_or_create_user: the label is the plan verdict', async () => {
    const names = [
      'mcp__acme__getIssue',
      'mcp__acme__describe_x',
      'mcp__acme__status_x',
      'mcp__acme__search_issues',
      'mcp__acme__lookup_user',
      'mcp__acme__get_or_create_user',
    ];
    const labels = await catalogueLabels(names);
    expect(labels).toEqual(Object.fromEntries(names.map(name => [name, planVerdict(name)])));
    // The three the row names, spelled out so a regression reads as the defect it was.
    expect([labels['mcp__acme__getIssue'], labels['mcp__acme__describe_x'], labels['mcp__acme__search_issues']])
      .toEqual(['write', 'read', 'read']);
  }, GATE_BUDGET_MS);

  it('the stated residue: a builtin dp read allowed by exact name (F1.288) is labelled write — the conservative side', async () => {
    const name = 'mcp__dpJira__dp_jira_jql_search';
    expect(await catalogueLabels([name])).toEqual({ [name]: 'write' });
    expect(planVerdict(name)).toBe('read');
  }, GATE_BUDGET_MS);
});
