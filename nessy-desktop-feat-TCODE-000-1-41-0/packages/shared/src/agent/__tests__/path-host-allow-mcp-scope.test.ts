/**
 * F1.377 (origin WJ-hh verifier on F1.272, 2026-09-23) — a `Read`/`Edit` path
 * ALLOW rule and a `WebFetch(domain:)` ALLOW rule answer only their built-in
 * tool families, never an MCP call whose ARGUMENTS happen to carry a
 * path/cwd/url.
 *
 * ## What the page says
 *
 * `permissions.md#read-and-edit`, verbatim: "`Edit` rules apply to all built-in
 * tools that edit files. Claude makes a best-effort attempt to apply `Read`
 * rules to all built-in tools that read files like Grep and Glob". And
 * `permissions.md#mcp`, on the one place the page lets a built-in rule reach an
 * MCP tool at all: "Allow rules don't carry over: Claude Code never applies a
 * `Bash` allow rule to `mcp__workspace__bash`." (both fetched 2026-09-23).
 *
 * ## What the DSL did
 *
 * `permission-dsl.ts`'s `pathGlob`, `path` and `host` matchers read the
 * request's `path`/`file_path`/`cwd`/`workingDirectory`/`url` input with no
 * question about WHICH tool carried it, so once F1.272 routed codex's MCP
 * tool-call approval through the rules, `Read(./src/**)` pre-approved
 * `fs__delete_file{path:'src/a.ts'}` and `Read(./**)` pre-approved
 * `shell__run{command:'rm -rf ~', cwd:'src'}` — on codex through the real
 * `handleServerRequest`, and on Pi through the same evaluator its gate calls
 * with `semanticId: 'mcp_dynamic'`.
 *
 * DECIDED by the controller (2026-09-23): the path/host ALLOW matchers answer
 * only their built-in families, never an `mcp_dynamic` / `mcp__*` request, on
 * Pi and codex alike; deny and ask may still match. The hook `if` filter keeps
 * its documented over-firing (`evaluateClaudeHookIfFilter`'s docblock), pinned
 * below as a boundary.
 *
 * Every rule here is a Claude rule string published through the capability
 * layer handoff — the path both runtimes read (`permissionsConfigCache`).
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { MCP_ELICITATION_METHOD } from '@nessy-agent/codex-agent-server';
import type { BackendConfig, PermissionCallback } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';
import { permissionsConfigCache } from '../permissions-config.ts';
import { evaluatePermissionDslV1 } from '../pi-harness/permission-dsl.ts';
import { evaluateClaudeHookIfFilter } from '../pi-harness/claude-permission-rules.ts';
import { canonicalizeForDecision } from '../session-filesystem-scope.ts';

const WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'wjoo-f1377-'));
afterAll(() => {
  rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
});
beforeEach(() => {
  permissionsConfigCache.clear();
});

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-f1377',
      name: 'F1.377 Workspace',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: join(WORKSPACE_ROOT, 'sessions'),
    } as any,
    session: {
      id: 'session-f1377',
      workspaceRootPath: WORKSPACE_ROOT,
      workingDirectory: WORKSPACE_ROOT,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

/** codex's MCP tool-call approval for one call of `<wire>__<tool>` — the shipped frame's shape (F1.272). */
function frame(tool: string, toolParams: Record<string, unknown>) {
  return {
    threadId: 'thread-f1377',
    turnId: 'turn-f1377',
    serverName: 'sources',
    mode: 'form',
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      persist: ['session', 'always'],
      tool_params: toolParams,
      tool_params_display: [],
    },
    message: `Allow the sources MCP server to run tool "${tool}"?`,
    requestedSchema: { type: 'object', properties: {} },
  };
}

function session(rules: Record<string, string[]>) {
  const agent = new CodexAgent(createConfig());
  const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
  agent.onPermissionRequest = (request) => { surfaced.push(request); };
  agent.setPermissionMode('default');
  agent.getPermissionManager().setCapabilityPermissionLayers(
    [{ content: JSON.stringify({ permissions: rules }), scope: 'workspace' }],
    'generation-f1377',
    true,
  );
  const ask = (params: unknown) =>
    (agent as any).handleServerRequest(MCP_ELICITATION_METHOD, params) as
      Record<string, unknown> | Promise<Record<string, unknown>>;
  return { agent, surfaced, ask };
}

/**
 * Pi's gate, as `pi-agent.ts` builds it: the merged program for the same
 * capability layers, the manifest descriptor's id as `semanticId`, and the
 * binding's `permissionName` as `toolName` (an unknown pool tool's binding name,
 * `harness-manifest.ts`'s synthesized binding).
 */
function piVerdict(rules: Record<string, string[]>, toolName: string, semanticId: string, input: Record<string, unknown>) {
  const { agent } = session(rules);
  const context = agent.getPermissionManager().getCapabilityPermissionsContext?.();
  const policy = permissionsConfigCache.getMergedConfig(context!).permissionDsl;
  expect(policy).toBeDefined();
  return evaluatePermissionDslV1(policy!, {
    generation: policy!.generation,
    semanticId,
    toolName,
    input,
    cwd: WORKSPACE_ROOT,
    canonicalizePath: (value, cwd) => canonicalizeForDecision(resolve(cwd, value)),
  }).action;
}

const ACCEPT = { action: 'accept', content: {} };
const DECLINE = { action: 'decline', content: null };

/** The verifier's three probes, each an allow rule meeting an MCP call it was never written for. */
const PROBES = [
  { label: 'Read(./src/**) + fs__delete_file{path}', rules: { allow: ['Read(./src/**)'] }, tool: 'fs__delete_file', input: { path: 'src/a.ts' } },
  { label: 'Read(./**) + shell__run{cwd}', rules: { allow: ['Read(./**)'] }, tool: 'shell__run', input: { command: 'rm -rf ~', cwd: 'src' } },
  { label: 'WebFetch(domain:example.com) + http__post{url}', rules: { allow: ['WebFetch(domain:example.com)'] }, tool: 'http__post', input: { url: 'https://example.com/upload', body: 'x' } },
  { label: 'Edit(./src/**) + fs__write_file{file_path}', rules: { allow: ['Edit(./src/**)'] }, tool: 'fs__write_file', input: { file_path: 'src/a.ts', content: 'x' } },
] as const;

describe('F1.377 · a path/host ALLOW rule does not pre-approve an MCP call', () => {
  for (const probe of PROBES) {
    it(`codex: ${probe.label} → the card reaches the person`, () => {
      const { surfaced, ask } = session(probe.rules as unknown as Record<string, string[]>);
      const answer = ask(frame(probe.tool, { ...probe.input }));
      expect(answer).toBeInstanceOf(Promise);
      expect(surfaced).toHaveLength(1);
    });

    it(`pi: ${probe.label} → no allow from the rules`, () => {
      expect(piVerdict(probe.rules as unknown as Record<string, string[]>, `mcp__${probe.tool}`, 'mcp_dynamic', { ...probe.input }))
        .toBeUndefined();
    });
  }
});

describe('F1.377 · CONTROLS — what the fix must not change', () => {
  it('an MCP allow rule naming the tool still accepts it with no card (codex) and allows it (pi)', async () => {
    const { surfaced, ask } = session({ allow: ['mcp__fs__delete_file'] });
    expect(await ask(frame('fs__delete_file', { path: 'src/a.ts' }))).toEqual(ACCEPT);
    expect(surfaced).toEqual([]);
    expect(piVerdict({ allow: ['mcp__fs__delete_file'] }, 'mcp__fs__delete_file', 'mcp_dynamic', { path: 'src/a.ts' }))
      .toBe('allow');
  });

  it('a Read DENY on the path still declines the MCP call (codex) and denies it (pi)', async () => {
    const { surfaced, ask } = session({ deny: ['Read(./src/**)'] });
    expect(await ask(frame('fs__delete_file', { path: 'src/a.ts' }))).toEqual(DECLINE);
    expect(surfaced).toEqual([]);
    expect(piVerdict({ deny: ['Read(./src/**)'] }, 'mcp__fs__delete_file', 'mcp_dynamic', { path: 'src/a.ts' }))
      .toBe('deny');
  });

  it('a WebFetch(domain:) ASK still asks for the MCP call on pi', () => {
    expect(piVerdict({ ask: ['WebFetch(domain:example.com)'] }, 'mcp__http__post', 'mcp_dynamic', { url: 'https://example.com/upload' }))
      .toBe('ask');
  });

  it('the built-in families keep their allow: Read on read, Edit on edit, WebFetch on web_fetch', () => {
    expect(piVerdict({ allow: ['Read(./src/**)'] }, 'Read', 'read', { path: 'src/a.ts' })).toBe('allow');
    expect(piVerdict({ allow: ['Edit(./src/**)'] }, 'Edit', 'edit', { path: 'src/a.ts' })).toBe('allow');
    expect(piVerdict({ allow: ['WebFetch(domain:example.com)'] }, 'WebFetch', 'web_fetch', { url: 'https://example.com/x' }))
      .toBe('allow');
  });

  it('an MCP call is recognised by its NAME alone too (a caller whose semanticId is the lowered tool name)', () => {
    // `prerequisite-manager.ts`'s skill-grant check passes `semanticId: toolName.toLowerCase()`.
    expect(piVerdict({ allow: ['Read(./src/**)'] }, 'mcp__fs__delete_file', 'mcp__fs__delete_file', { path: 'src/a.ts' }))
      .toBeUndefined();
  });

  it('BOUNDARY: the hook `if` filter keeps its documented over-firing on an MCP call', () => {
    expect(evaluateClaudeHookIfFilter('Edit(src/**)', {
      toolName: 'mcp__fs__write_file',
      toolInput: { path: 'src/a.ts' },
      cwd: WORKSPACE_ROOT,
    })).toEqual({ run: true, unparseableRule: false });
  });
});

/**
 * F1.463 (origin P-WJ-oo-1, F1.377's residue) — a `Read`/`Edit` path ALLOW and a
 * `WebFetch(domain:)` ALLOW do not answer a SESSION tool either.
 *
 * Pi's session tools reach the DSL under their built-in names (`EnterWorktree` /
 * `enter_worktree`, `spawn_session` / `spawn_session`), not `mcp_dynamic`, so
 * F1.377's MCP skip did not cover them: `Read(./**)` pre-approved
 * `EnterWorktree{path}` and `spawn_session{workingDirectory}` by path. They are the
 * only two of the 61 session tools with a top-level path-like input (measured over
 * `SESSION_TOOL_DEFS`, 2026-09-24). Codex reached the same answer through F1.379's
 * Pi alias, so the two runtimes AGREED — on the loose side.
 *
 * `permissions.md#read-and-edit` scopes Read/Edit rules to built-in tools that
 * read or edit FILES; `tools-reference.md` says an `EnterWorktree` path "prompts
 * for your approval before entering, since it moves the session's working
 * directory and write access to that location" (both fetched 2026-09-24). A read
 * rule handing out a working directory and its write access is the loose
 * direction, so the skip is widened to the session family on both runtimes; deny
 * and ask still match, exactly as for an MCP call.
 */
describe('F1.463 · a path ALLOW rule does not pre-approve a session tool on Pi or codex', () => {
  const PI_SESSION_PROBES = [
    { label: 'Read(./**) + EnterWorktree{path}', rules: { allow: ['Read(./**)'] }, toolName: 'EnterWorktree', semanticId: 'enter_worktree', input: { path: 'wt' } },
    { label: 'Edit(./**) + EnterWorktree{path}', rules: { allow: ['Edit(./**)'] }, toolName: 'EnterWorktree', semanticId: 'enter_worktree', input: { path: 'wt' } },
    { label: 'Read(./**) + spawn_session{workingDirectory}', rules: { allow: ['Read(./**)'] }, toolName: 'spawn_session', semanticId: 'spawn_session', input: { prompt: 'x', workingDirectory: 'sub' } },
  ] as const;

  for (const probe of PI_SESSION_PROBES) {
    it(`pi: ${probe.label} → no allow from the rules`, () => {
      expect(piVerdict(probe.rules as unknown as Record<string, string[]>, probe.toolName, probe.semanticId, { ...probe.input }))
        .toBeUndefined();
    });
  }

  it('codex: Read(./**) + mcp__session__EnterWorktree{path} → the card reaches the person', () => {
    const { surfaced, ask } = session({ allow: ['Read(./**)'] });
    const answer = ask({ ...frame('EnterWorktree', { path: 'wt' }), serverName: 'session', message: 'Allow the session MCP server to run tool "EnterWorktree"?' });
    expect(answer).toBeInstanceOf(Promise);
    expect(surfaced).toHaveLength(1);
  });

  it('CONTROL: a Read DENY still denies EnterWorktree{path} on pi, and a rule naming the tool still allows it', () => {
    expect(piVerdict({ deny: ['Read(./**)'] }, 'EnterWorktree', 'enter_worktree', { path: 'wt' })).toBe('deny');
    expect(piVerdict({ ask: ['Edit(./**)'] }, 'EnterWorktree', 'enter_worktree', { path: 'wt' })).toBe('ask');
    expect(piVerdict({ allow: ['EnterWorktree'] }, 'EnterWorktree', 'enter_worktree', { path: 'wt' })).toBe('allow');
  });
});
