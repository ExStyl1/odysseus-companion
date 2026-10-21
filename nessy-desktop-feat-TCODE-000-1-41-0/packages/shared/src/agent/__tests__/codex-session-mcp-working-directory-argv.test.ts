/**
 * D1.372 (F1.75) — the PROJECT scope of `remember`, carried into the one
 * runtime whose `remember` is served by a subprocess.
 *
 * `handleRemember` resolves `scope: "project"` from `ctx.workingDirectory`
 * (`session-tools-core/src/handlers/remember.ts`, `getMemoryPath`), and pi and
 * claude both bind it in process — pi at `getSessionToolContext`, claude at the
 * `getSessionScopedTools(...)` call site, and BOTH spell it
 * `this.config.session?.workingDirectory`. Codex does not: its `remember` runs
 * inside `session-mcp-server`, a child codex spawns from
 * `[mcp_servers.session]`, and no argv carried a working directory there — so
 * the scope was refused BY NAME on every codex call
 * (`remember with scope=project requires workingDirectory in context.`),
 * measured over the real stdio transport by `remember-scopes.test.ts`.
 *
 * So the argv carries it, in `--memory-scope-write`'s shape (F1.119 named that
 * flag as the precedent): a host value the child cannot read, sent as a spawn
 * flag, emitted only when the host has something to say.
 *
 * ## The one thing this file exists to keep true
 *
 * The value is **`this.config.session?.workingDirectory`, NOT
 * `this.workingDirectory`**, and the difference is not cosmetic.
 * `BaseAgent`'s constructor writes
 * `this.workingDirectory = config.session?.workingDirectory ?? config.workspace.workspaceRootPath`,
 * so the protected field is never absent — it falls back to the WORKSPACE root.
 * Passing that would give codex a project memory index at
 * `<workspace>/MEMORY.md` for every session that never chose a project, a file
 * pi and claude never write, and it would do so silently. The session field is
 * absent exactly when there is no project, which is the state both other
 * runtimes refuse in, so "no project directory → refused by name" stays one
 * sentence across all three.
 *
 * The no-directory arm below is therefore the NEGATIVE of the fix as well as
 * its parity control: it is the arm a `this.workingDirectory` spelling fails.
 */
import { describe, expect, it } from 'bun:test';

import { CodexAgent } from '../codex-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

const WORKSPACE_ID = 'ws-workdir-argv';
const SESSION_ID = 'session-workdir-argv';
/** Deliberately NOT a prefix of the project root, so the two can never be confused. */
const WORKSPACE_ROOT = '/tmp/ws-workdir-argv-root';
const PROJECT_ROOT = '/tmp/chosen-project-root';

function createAgent(workingDirectory?: string): any {
  const config: BackendConfig = {
    provider: 'codex-runtime',
    workspace: {
      id: WORKSPACE_ID,
      name: 'Working Directory Argv Workspace',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-workdir-argv',
    } as any,
    session: {
      id: SESSION_ID,
      workspaceRootPath: WORKSPACE_ROOT,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      // Spread rather than assigned, so "this session chose no project" is the
      // field being ABSENT — the state `SessionManager`'s own literal produces
      // from a `ManagedSession` with no `workingDirectory`, and the one a
      // `workingDirectory: undefined` assignment would also produce but less
      // obviously.
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
    runtime: { paths: { sessionServer: '/tmp/session-mcp-server.js', node: '/tmp/node' } },
  } as any;
  return new CodexAgent(config);
}

function valueAfter(args: string[] | undefined, flag: string): string | undefined {
  if (!args) return undefined;
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

describe('D1.372 — the codex session MCP argv carries this session working directory', () => {
  it('a session with a project directory spawns the subprocess with it', () => {
    const args: string[] | undefined = createAgent(PROJECT_ROOT).buildSessionMcpSpec(undefined)?.args;
    expect(valueAfter(args, '--working-directory')).toBe(PROJECT_ROOT);
  });

  it('a session with NO project directory emits nothing, and never the workspace root', () => {
    const args: string[] | undefined = createAgent().buildSessionMcpSpec(undefined)?.args;
    expect(args).not.toContain('--working-directory');
    // THE ARM A `this.workingDirectory` SPELLING FAILS, and the COUNT is what
    // says so. That field falls back to the workspace root in `BaseAgent`'s
    // constructor, so a fix reading it would put this string on the argv a
    // SECOND time — the first is `--workspace-root`'s own legitimate value, so
    // a bare `not.toContain` here would be a needle this corpus cannot help
    // spelling, and it would fail on correct code.
    expect((args ?? []).filter((arg) => arg === WORKSPACE_ROOT)).toHaveLength(1);
    // Positive control on the same instrument: this argv is a real one, so the
    // absence above is an absence rather than an empty array.
    expect(args).toContain('--config-root');
    expect(valueAfter(args, '--session-id')).toBe(SESSION_ID);
  });

  it('an empty working directory is no project, and is not sent as one', () => {
    // `''` is falsy but a `typeof === "string"` guard alone admits it, and
    // `join('', 'MEMORY.md')` is a RELATIVE path — the child would write
    // `MEMORY.md` beside its own cwd. Refused here rather than in the child, so
    // the spawn and the handler agree about what "no project" is.
    const args: string[] | undefined = createAgent('').buildSessionMcpSpec(undefined)?.args;
    expect(args).not.toContain('--working-directory');
    expect(args).toContain('--config-root');
  });

  it('the directory is the SESSION’s own, which is what pi and claude bind', () => {
    // The parity statement, as an assertion rather than a comment: the value on
    // the argv is the one `getSessionScopedTools(...)` is handed on claude and
    // `getSessionToolContext()` passes on pi, and those two differ from the
    // workspace root exactly here.
    const args: string[] | undefined = createAgent(PROJECT_ROOT).buildSessionMcpSpec(undefined)?.args;
    expect(valueAfter(args, '--working-directory')).not.toBe(WORKSPACE_ROOT);
    expect(valueAfter(args, '--workspace-root')).toBe(WORKSPACE_ROOT);
  });
});
