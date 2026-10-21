import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createWriteToolDefinition,
  type AgentToolResult,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

import {
  buildRuntimeBackedBuiltinToolDefinitions,
  buildRuntimeBackedToolExecutionPorts,
  RUNTIME_BACKED_BUILTIN_TOOL_NAMES,
} from './runtime-backed-tools.ts';
import {
  createNotebookAwareReadToolDefinition,
  createNotebookEditTool,
} from '../tools/notebook.ts';
import { createToolExecutor } from '../../../shared/src/agent/pi-harness/tool-executor.ts';
import { LocalToolRuntime } from '../../../shared/src/agent/local-tools/runtime.ts';
import type { LocalToolRuntimeOptions } from '../../../shared/src/agent/local-tools/types.ts';
import type { SessionFilesystemScope } from '../../../shared/src/agent/session-filesystem-scope.ts';
import {
  createFileCheckpoint,
  finalizeFileCheckpoint,
  listFileCheckpoints,
  revertFileCheckpoint,
} from '../../../shared/src/sessions/file-checkpoints.ts';

const sessionKey = { workspaceId: 'workspace-1', sessionId: 'session-1' };
const manifestIdentity = { generation: 'generation-1', manifestHash: 'hash-1', responseEpoch: 1 };

// The Pi SDK's builtin `grep` shells out to ripgrep via ensureTool('rg'), which
// resolves rg from PATH (or the SDK's tool cache) and otherwise downloads it
// from GitHub. On the closed CI runner image rg is absent from PATH and the
// download is network-blocked, so the SDK grep throws "ripgrep (rg) is not
// available and could not be downloaded". Bundling rg into the CI image is a
// supply-chain/CI-image change owned by the reviewer, so the parity test that
// executes the SDK grep is presence-guarded on rg here. Every other test in
// this file exercises read/write/edit/bash/find/ls only (find is driven by a
// custom git-ls-files glob, not fd), so none of them need rg. Bun.which mirrors
// the SDK's system-PATH lookup — the dominant availability signal.
const hasRipgrep = Bun.which('rg') !== null;

function executionTools(
  cwd: string,
  options: {
    runCommand?: (command: string, cwd: string, options?: { timeout?: number; signal?: AbortSignal }) => Promise<{
      stdout: string; stderr: string; exitCode: number;
    }>;
    approve?: (input: Record<string, unknown>) => Record<string, unknown>;
    checkpointSessionPath?: string;
    filesystemScope?: SessionFilesystemScope;
    requestOutsideRootApproval?: LocalToolRuntimeOptions['requestOutsideRootApproval'];
  } = {},
): ToolDefinition<any, any>[] {
  const ports = buildRuntimeBackedToolExecutionPorts(cwd);
  const checkpointIntents = new Map<string, { adapter: 'file'; toolName: string }>();
  const pendingCheckpoints = new Map<string, string>();
  const persistAuthorizedCheckpoint = async (executionId: string, authorizedTarget: string) => {
    if (!options.checkpointSessionPath) return;
    const existing = pendingCheckpoints.get(executionId);
    if (existing) return existing;
    const intent = checkpointIntents.get(executionId);
    if (!intent) return;
    const [checkpoint] = await createFileCheckpoint({
      sessionPath: options.checkpointSessionPath,
      adapter: intent.adapter,
      toolName: intent.toolName,
      toolCallId: executionId,
      input: {},
      authorizedTarget,
    });
    if (checkpoint) pendingCheckpoints.set(executionId, checkpoint.id);
    return checkpoint?.id;
  };
  const runtime = new LocalToolRuntime({
    filesystemScope: options.filesystemScope ?? {
      session: { workspaceId: 'workspace-test', sessionId: 'session-test' },
      primaryRoot: cwd,
      cwd,
      additionalRoots: [],
      managedExclusions: [],
      generation: 'g-test',
    },
    requestOutsideRootApproval: options.requestOutsideRootApproval,
    onFileMutationAuthorized: async ({ call, canonicalPath }) => {
      await persistAuthorizedCheckpoint(call.id, canonicalPath);
    },
    permissionManager: { evaluateToolCall: () => { throw new Error('legacy permission gate used'); } },
    runCommand: options.runCommand,
  });
  const portBySemanticId = new Map(ports.map(port => [port.semanticId, port]));
  const toolExecutor = createToolExecutor({
    runtime,
    ports,
    authority: { sessionKey, manifestIdentity, getCurrentResponseEpoch: () => 1 },
    permissionBridge: async (_request, input) => ({
      allowed: true,
      decisionId: 'approved',
      canonicalInput: options.approve?.(input) ?? input,
    }),
    ...(options.checkpointSessionPath ? {
      beforeDispatch: async (request, descriptor, input) => {
        if (!descriptor.checkpointAdapter) return;
        checkpointIntents.set(request.executionId, {
          adapter: descriptor.checkpointAdapter,
          toolName: request.presentedName,
        });
        const port = portBySemanticId.get(request.semanticId);
        if (!port) throw new Error(`Missing checkpoint execution port: ${request.semanticId}`);
        const dispatch = port.dispatch;
        const runtimeWillAuthorize = dispatch.kind === 'local'
          || (dispatch.kind === 'select' && !dispatch.useSemantic(input));
        if (runtimeWillAuthorize) return;
        const target = input.file_path ?? input.notebook_path ?? input.path;
        if (typeof target !== 'string' || target.trim().length === 0) return;
        const authorizedTarget = await runtime.authorizePath(target, 'write');
        const checkpointId = await persistAuthorizedCheckpoint(request.executionId, authorizedTarget);
        return checkpointId ? { checkpointId } : undefined;
      },
      afterDispatch: async (request, _descriptor, _input, outcome) => {
        checkpointIntents.delete(request.executionId);
        const checkpointId = pendingCheckpoints.get(request.executionId);
        if (!checkpointId) return;
        pendingCheckpoints.delete(request.executionId);
        await finalizeFileCheckpoint({
          sessionPath: options.checkpointSessionPath!,
          checkpointId,
          succeeded: Boolean(outcome.result && !outcome.result.isError),
        });
      },
    } : {}),
  });
  return buildRuntimeBackedBuiltinToolDefinitions(cwd, { toolExecutor, sessionKey, manifestIdentity });
}

async function makeWorkspace(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'nessy-runtime-backed-pi-')));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function currentPiBuiltins(cwd: string): ToolDefinition<any, any>[] {
  return [
    createNotebookAwareReadToolDefinition(cwd),
    createBashToolDefinition(cwd),
    createEditToolDefinition(cwd),
    createWriteToolDefinition(cwd),
    createGrepToolDefinition(cwd),
    createFindToolDefinition(cwd, {
      operations: {
        exists: async path => {
          try {
            await stat(path);
            return true;
          } catch {
            return false;
          }
        },
        glob: async (pattern, searchPath, options) => {
          const proc = Bun.spawn(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], {
            cwd: searchPath,
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const output = await new Response(proc.stdout).text();
          if (await proc.exited !== 0) return [];
          const matcher = new Bun.Glob(pattern);
          return output
            .split(/\r?\n/)
            .filter(path => path && (matcher.match(path) || matcher.match(basename(path))))
            .slice(0, options.limit)
            .map(path => join(searchPath, path));
        },
      },
    }),
    createLsToolDefinition(cwd),
    createNotebookEditTool(cwd),
  ];
}

function byName(tools: ToolDefinition<any, any>[]): Map<string, ToolDefinition<any, any>> {
  return new Map(tools.map(tool => [tool.name, tool]));
}

function schemaShape(tool: ToolDefinition<any, any>): {
  required: unknown;
  additionalProperties: unknown;
  propertyKeys: string[];
} {
  const parameters = tool.parameters as {
    required?: unknown;
    additionalProperties?: unknown;
    properties?: Record<string, unknown>;
  };
  return {
    required: parameters.required,
    additionalProperties: parameters.additionalProperties,
    propertyKeys: Object.keys(parameters.properties ?? {}),
  };
}

async function executeText(
  tool: ToolDefinition<any, any>,
  params: Record<string, unknown>,
): Promise<string> {
  const result = await tool.execute(`${tool.name}-call`, params, new AbortController().signal, undefined, {} as never);
  return textFromResult(result);
}

function textFromResult(result: AgentToolResult<any>): string {
  return result.content
    .filter((content): content is { type: 'text'; text: string } => content.type === 'text')
    .map(content => content.text)
    .join('');
}

async function initGitRepo(cwd: string): Promise<void> {
  const proc = Bun.spawn(['git', 'init'], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await proc.exited;
}

describe('runtime-backed Pi builtins', () => {
  test('dispatches repeated operations through the injected executor and one runtime identity', async () => {
    const calls: unknown[] = [];
    const runtime = {
      executeAuthorized: async (call: unknown) => {
        calls.push(call);
        return { content: 'runtime-result', isError: false };
      },
    };
    const toolExecutor = createToolExecutor({
      runtime,
      ports: buildRuntimeBackedToolExecutionPorts('/workspace'),
      authority: {
        sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' },
        manifestIdentity: { generation: 'generation-1', manifestHash: 'hash-1', responseEpoch: 1 },
        getCurrentResponseEpoch: () => 1,
      },
      permissionBridge: async (_request, canonicalInput) => ({
        allowed: true,
        decisionId: 'runtime-backed-test-allow',
        canonicalInput,
      }),
    });
    const tools = byName(buildRuntimeBackedBuiltinToolDefinitions('/workspace', {
      toolExecutor, sessionKey, manifestIdentity,
    }));

    await tools.get('read')!.execute('read-1', { path: 'one.txt' }, new AbortController().signal, undefined, {} as never);
    await tools.get('read')!.execute('read-2', { path: 'two.txt' }, new AbortController().signal, undefined, {} as never);

    expect(calls).toHaveLength(2);
    expect(calls.map(call => (call as { operation: { path: string } }).operation.path)).toEqual(['one.txt', 'two.txt']);
    expect('runtime' in toolExecutor).toBe(false);
  });

  test('rejects invalid NotebookEdit cell_index before permission or dispatch', async () => {
    let permissions = 0;
    let dispatches = 0;
    const toolExecutor = createToolExecutor({
      runtime: {
        executeAuthorized: async () => {
          dispatches += 1;
          return { content: 'unexpected', isError: false };
        },
      },
      ports: buildRuntimeBackedToolExecutionPorts('/workspace'),
      authority: { sessionKey, manifestIdentity, getCurrentResponseEpoch: () => 1 },
      permissionBridge: async (_request, input) => {
        permissions += 1;
        return { allowed: true, decisionId: 'approved', canonicalInput: input };
      },
    });
    const tool = byName(buildRuntimeBackedBuiltinToolDefinitions('/workspace', {
      toolExecutor, sessionKey, manifestIdentity,
    })).get('NotebookEdit')!;

    await expect(tool.execute('invalid-notebook', {
      notebook_path: 'book.ipynb', cell_index: -1, source: 'x',
    }, new AbortController().signal, undefined, {} as never)).rejects.toThrow(/non-negative integer/);
    expect(permissions).toBe(0);
    expect(dispatches).toBe(0);
  });

  test('match current Pi SDK builtin names and schema shape', async () => {
    const cwd = await makeWorkspace();
    const current = byName(currentPiBuiltins(cwd));
    const runtimeBacked = buildRuntimeBackedBuiltinToolDefinitions(cwd);

    expect(runtimeBacked.map(tool => tool.name)).toEqual([...RUNTIME_BACKED_BUILTIN_TOOL_NAMES]);
    for (const tool of runtimeBacked) {
      const currentTool = current.get(tool.name);
      expect(currentTool).toBeDefined();
      const ours = schemaShape(tool);
      const sdk = schemaShape(currentTool!);
      // Pi 0.84 stopped declaring `additionalProperties` on its own builtin
      // tool schemas — 0.80.3 pinned it to `false`, and read/bash/edit/write/
      // grep/ls now all leave it undefined (measured 2026-08-20 against the
      // installed dist; `NotebookEdit`'s counterpart is Nessy-owned and still
      // pins `false`). Our `edit` schema keeps `false` DELIBERATELY: the
      // runtime-backed builtins validate their own input and an unknown key is
      // a model mistake we reject rather than forward. So a declared upstream
      // value must still match exactly, and where upstream declares none, ours
      // may be equal-or-stricter — never looser.
      if (sdk.additionalProperties !== undefined) {
        expect(ours.additionalProperties, `${tool.name} additionalProperties`)
          .toEqual(sdk.additionalProperties);
      } else {
        expect([undefined, false] as unknown[], `${tool.name} additionalProperties`)
          .toContain(ours.additionalProperties);
      }
      const oursComparable = { required: ours.required, propertyKeys: ours.propertyKeys };
      const sdkComparable = { required: sdk.required, propertyKeys: sdk.propertyKeys };
      if (tool.name === 'bash') {
        // R10 (doc-verification § R10): `run_in_background` is OUR documented
        // extension over the SDK builtin, and `dangerouslyDisableSandbox` is the
        // documented sandbox escape hatch (sandboxing.md:135) the model spells
        // on a retry; everything else must still match.
        expect(ours.propertyKeys).toEqual([...sdk.propertyKeys, 'run_in_background', 'dangerouslyDisableSandbox']);
        expect({ ...oursComparable, propertyKeys: sdk.propertyKeys }).toEqual(sdkComparable);
      } else {
        expect(oursComparable, tool.name).toEqual(sdkComparable);
      }
    }
  });

  test('P6.329 - the sandbox escape hatch names the SHAPE of the denial it is a retry for', async () => {
    // The row: a sandbox denial reaches the model as a bare `Operation not
    // permitted`. The old text said "after a run has already failed for that
    // reason" and left the model to recognise a reason nothing states - the OS
    // boundary names neither the path nor the host it refused, Pi has no
    // classifier at all, and codex's `classify_filesystem_sandbox_violation`
    // never leaves the codex process. So a model that took the instruction
    // literally would never set the flag.
    const cwd = await makeWorkspace();
    const bash = byName(buildRuntimeBackedBuiltinToolDefinitions(cwd)).get('bash');
    const text = String(
      (bash!.parameters as { properties: Record<string, { description?: string }> })
        .properties.dangerouslyDisableSandbox?.description ?? '',
    );

    // Positive: both denial shapes are named, because they are the only two
    // signals the model actually receives.
    expect(text).toContain('Operation not permitted');
    expect(text).toContain('EPERM');
    expect(text).toMatch(/no path in it/);
    expect(text).toMatch(/no host in it/);

    // Boundary: it still says the flag is for a RETRY of an already-failed run,
    // not a way to opt out of the sandbox up front.
    expect(text).toMatch(/already failed/);

    // Negative, and the expensive one if it regresses: this schema is a PINNED
    // model contract (`PI_STATIC_MODEL_CONTRACT_HASHES.bash`), and the manifest
    // projection rewrites tool-name mentions per composition - so a rewritable
    // name in here makes the pin composition-dependent and the live first turn
    // dies with "Pi execution manifest model contract mismatch". Cheap local
    // guard for the end-to-end one in `live-manifest-contract.test.ts`.
    for (const rewritable of ['BashOutput', 'ProcessStop', 'stopTask', 'Monitor']) {
      expect(text, `${rewritable} is rewritable and must not appear here`).not.toContain(rewritable);
    }
    expect(text).not.toMatch(/(?<![A-Za-z0-9_])Bash(?![A-Za-z0-9_])/);
  });

  test('prompt snippets name each tool and preserve operation intent', async () => {
    const cwd = await makeWorkspace();
    const intentByName = new Map<string, string>([
      ['read', 'file'],
      ['bash', 'command'],
      ['edit', 'replacement'],
      ['write', 'file'],
      ['grep', 'search'],
      ['find', 'glob'],
      ['ls', 'directory'],
      ['NotebookEdit', '.ipynb'],
    ]);

    for (const tool of buildRuntimeBackedBuiltinToolDefinitions(cwd)) {
      expect(tool.promptSnippet).toContain(tool.name);
      expect(tool.promptSnippet?.toLowerCase()).toContain(intentByName.get(tool.name)?.toLowerCase());
    }
  });

  test('execute read, write, edit, bash, and NotebookEdit through the runtime-backed surface', async () => {
    const cwd = await makeWorkspace();
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src', 'read.txt'), 'one\ntwo\nthree\n', 'utf-8');
    await writeFile(join(cwd, 'src', 'edit.txt'), 'alpha beta gamma', 'utf-8');
    await writeFile(join(cwd, 'notebook.ipynb'), JSON.stringify({
      cells: [{ cell_type: 'code', source: ['old()\n'], outputs: [] }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }), 'utf-8');

    const bashCalls: Array<{ command: string; cwd: string; timeout?: number }> = [];
    const tools = byName(executionTools(cwd, {
      runCommand: async (command, runCwd, options) => {
        bashCalls.push({ command, cwd: runCwd, timeout: options?.timeout });
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      },
    }));

    await expect(executeText(tools.get('read')!, {
      path: 'src/read.txt',
      offset: 2,
      limit: 1,
    })).resolves.toBe('two\n\n[2 more lines in file. Use offset=3 to continue.]');

    await expect(executeText(tools.get('write')!, {
      path: 'src/new.txt',
      content: 'hello',
    })).resolves.toBe('Successfully wrote 5 bytes to src/new.txt');
    await expect(readFile(join(cwd, 'src', 'new.txt'), 'utf-8')).resolves.toBe('hello');

    // P6.558 — read-before-write. Every fixture below puts its file on disk
    // behind the runtime's back, so the session has not seen it and a mutation
    // is refused. These reads are the fixtures catching up with the rule; the
    // assertions they precede are unchanged.
    await executeText(tools.get('read')!, { path: 'src/edit.txt' });
    await expect(executeText(tools.get('edit')!, {
      path: 'src/edit.txt',
      edits: [
        { oldText: 'alpha', newText: 'gamma' },
        { oldText: 'gamma', newText: 'delta' },
      ],
    })).resolves.toBe('Successfully replaced 2 block(s) in src/edit.txt.');
    await expect(readFile(join(cwd, 'src', 'edit.txt'), 'utf-8')).resolves.toBe('gamma beta delta');

    // The model-facing timeout is MILLISECONDS (Claude's Bash contract; the
    // live model sends e.g. 3000 meaning 3s). Sub-1000 values are raised to
    // one second instead of producing an instant deadline.
    await expect(executeText(tools.get('bash')!, {
      command: 'printf ok',
      timeout: 3000,
    })).resolves.toBe('ok');
    await expect(executeText(tools.get('bash')!, {
      command: 'printf ok',
      timeout: 2,
    })).resolves.toBe('ok');
    expect(bashCalls).toEqual([
      { command: 'printf ok', cwd, timeout: 3000 },
      { command: 'printf ok', cwd, timeout: 1000 },
    ]);

    // P6.558, and the page is emphatic about this one:
    // `tools-reference.md#write-tool-behavior` — "Jupyter notebooks, and files
    // Claude has read only partially with a `PARTIAL view` notice, require the
    // read on every model."
    await executeText(tools.get('read')!, { path: 'notebook.ipynb' });
    await expect(executeText(tools.get('NotebookEdit')!, {
      notebook_path: 'notebook.ipynb',
      cell_index: 0,
      source: 'new()\n',
    })).resolves.toBe('Updated cell 0 in notebook.ipynb.');
    const notebook = JSON.parse(await readFile(join(cwd, 'notebook.ipynb'), 'utf-8')) as {
      cells: Array<{ source: string[] }>;
    };
    expect(notebook.cells[0]?.source).toEqual(['new()\n']);
  });

  test('creates and finalizes checkpoints on the actual Pi write/edit/notebook dispatch path', async () => {
    const cwd = await makeWorkspace();
    const sessionPath = join(cwd, '.session');
    await mkdir(sessionPath, { recursive: true });
    await writeFile(join(cwd, 'edit.txt'), 'alpha beta gamma', 'utf-8');
    await writeFile(join(cwd, 'notebook.ipynb'), JSON.stringify({
      cells: [{ cell_type: 'code', source: ['old()\n'], outputs: [] }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }), 'utf-8');
    const tools = byName(executionTools(cwd, { checkpointSessionPath: sessionPath }));

    await executeText(tools.get('write')!, { path: 'new.txt', content: 'created' });
    // P6.558 — the two fixtures placed on disk behind the runtime's back need a
    // read before they can be mutated. A read mints no checkpoint, so the
    // checkpoint assertions below are untouched.
    await executeText(tools.get('read')!, { path: 'edit.txt' });
    await executeText(tools.get('edit')!, {
      path: 'edit.txt',
      edits: [
        { oldText: 'alpha', newText: 'one' },
        { oldText: 'gamma', newText: 'three' },
      ],
    });
    await executeText(tools.get('read')!, { path: 'notebook.ipynb' });
    await executeText(tools.get('NotebookEdit')!, {
      notebook_path: 'notebook.ipynb', cell_index: 0, source: 'new()\n',
    });

    const checkpoints = await listFileCheckpoints(sessionPath);
    expect(checkpoints.map(entry => entry.toolName)).toEqual(['write', 'edit', 'NotebookEdit']);
    expect(checkpoints.every(entry => entry.outcome === 'applied' && !entry.conflict)).toBe(true);
    expect(checkpoints.every(entry => entry.preimageDigest === undefined || /^[0-9a-f]{64}$/.test(entry.preimageDigest))).toBe(true);

    const notebookCheckpoint = checkpoints.find(entry => entry.toolName === 'NotebookEdit')!;
    expect(await revertFileCheckpoint({ sessionPath, checkpointId: notebookCheckpoint.id }))
      .toMatchObject({ success: true, restored: true });
    const notebook = JSON.parse(await readFile(join(cwd, 'notebook.ipynb'), 'utf-8')) as { cells: Array<{ source: string[] }> };
    expect(notebook.cells[0]?.source).toEqual(['old()\n']);
  });

  test('does not create checkpoint storage before denied write-path admission', async () => {
    const cases: Array<{
      name: string;
      prepare(cwd: string): Promise<{
        target: string;
        secretPath: string;
        filesystemScope: SessionFilesystemScope;
      }>;
    }> = [
      {
        name: 'outside root',
        async prepare(cwd) {
          const outside = await makeWorkspace();
          const secretPath = join(outside, 'secret.txt');
          await writeFile(secretPath, 'secret', 'utf-8');
          return {
            target: secretPath,
            secretPath,
            filesystemScope: {
              session: { workspaceId: 'workspace-test', sessionId: 'session-test' },
              primaryRoot: cwd,
              cwd,
              additionalRoots: [],
              managedExclusions: [],
              generation: 'g-test',
            },
          };
        },
      },
      {
        name: 'symlink escape',
        async prepare(cwd) {
          const outside = await makeWorkspace();
          const secretPath = join(outside, 'secret.txt');
          const target = join(cwd, 'linked-secret.txt');
          await writeFile(secretPath, 'secret', 'utf-8');
          await symlink(secretPath, target);
          return {
            target,
            secretPath,
            filesystemScope: {
              session: { workspaceId: 'workspace-test', sessionId: 'session-test' },
              primaryRoot: cwd,
              cwd,
              additionalRoots: [],
              managedExclusions: [],
              generation: 'g-test',
            },
          };
        },
      },
      {
        name: 'managed root',
        async prepare(cwd) {
          const managedRoot = await makeWorkspace();
          const secretPath = join(managedRoot, 'secret.txt');
          await writeFile(secretPath, 'secret', 'utf-8');
          return {
            target: secretPath,
            secretPath,
            filesystemScope: {
              session: { workspaceId: 'workspace-test', sessionId: 'session-test' },
              primaryRoot: cwd,
              cwd,
              additionalRoots: [],
              managedExclusions: [managedRoot],
              generation: 'g-test',
            },
          };
        },
      },
    ];

    for (const deniedCase of cases) {
      const cwd = await makeWorkspace();
      const sessionPath = join(cwd, '.session');
      await mkdir(sessionPath, { recursive: true });
      const prepared = await deniedCase.prepare(cwd);
      const write = byName(executionTools(cwd, {
        checkpointSessionPath: sessionPath,
        filesystemScope: prepared.filesystemScope,
      })).get('write')!;

      await expect(executeText(write, {
        path: prepared.target,
        content: 'leaked',
      })).rejects.toThrow();
      expect(await readFile(prepared.secretPath, 'utf-8')).toBe('secret');
      expect(
        await pathExists(join(sessionPath, 'file_checkpoints')),
        deniedCase.name,
      ).toBe(false);
    }
  });

  test('checkpoints and mutates an outside target after one request-scoped admission', async () => {
    const cwd = await makeWorkspace();
    const outside = await makeWorkspace();
    const sessionPath = join(cwd, '.session');
    const target = join(outside, 'approved.txt');
    await mkdir(sessionPath, { recursive: true });
    await writeFile(target, 'before', 'utf-8');
    const approvals: string[] = [];
    const tools = byName(executionTools(cwd, {
      checkpointSessionPath: sessionPath,
      requestOutsideRootApproval: async canonicalTarget => {
        approvals.push(canonicalTarget);
        return {
          canonicalRoot: outside,
          access: 'write',
          receiptId: 'approved-once',
          expires: 'request',
        };
      },
    }));
    const write = tools.get('write')!;

    // P6.558 — an overwrite of an existing file the session has not seen is
    // refused, so the read comes first. It costs a SECOND admission here
    // precisely because this receipt is request-scoped, which is the subject of
    // the test and is asserted below rather than smoothed over.
    await executeText(tools.get('read')!, { path: target });
    await expect(executeText(write, {
      path: target,
      content: 'after',
    })).resolves.toBe(`Successfully wrote 5 bytes to ${target}`);
    expect(approvals).toEqual([target, target]);
    expect(await readFile(target, 'utf-8')).toBe('after');
    const checkpoints = await listFileCheckpoints(sessionPath);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      filePath: target,
      existed: true,
      outcome: 'applied',
    });
  });

  test('write accepts approval-modified file_path fallback without adding it to the schema', async () => {
    const cwd = await makeWorkspace();
    const wrapped = byName(executionTools(cwd, { approve: () => ({
      file_path: 'approved.txt', content: 'ok',
    }) })).get('write')!;

    expect(schemaShape(wrapped)).toEqual({
      required: ['path', 'content'],
      additionalProperties: undefined,
      propertyKeys: ['path', 'content'],
    });
    await expect(executeText(wrapped, {
      path: 'draft.txt',
      content: 'draft',
    })).resolves.toBe('Successfully wrote 2 bytes to approved.txt');
    await expect(readFile(join(cwd, 'approved.txt'), 'utf-8')).resolves.toBe('ok');
  });

  test('edit accepts approval-modified file_path fallback and applies edits', async () => {
    const cwd = await makeWorkspace();
    await writeFile(join(cwd, 'approved.txt'), 'alpha beta gamma', 'utf-8');
    // The approval rewrite is scoped to the EDIT call now that P6.558 makes the
    // fixture read `approved.txt` first: an unconditional stub would rewrite the
    // read's input into `{file_path, edits}` too, which is not a read at all.
    const tools = byName(executionTools(cwd, { approve: input => ('edits' in (input as object) ? {
      file_path: 'approved.txt', edits: [{ oldText: 'beta', newText: 'BETA' }],
    } : input) }));
    const wrapped = tools.get('edit')!;

    await executeText(tools.get('read')!, { path: 'approved.txt' });
    await expect(executeText(wrapped, {
      path: 'draft.txt',
      edits: [{ oldText: 'draft', newText: 'ignored' }],
    })).resolves.toBe('Successfully replaced 1 block(s) in approved.txt.');
    await expect(readFile(join(cwd, 'approved.txt'), 'utf-8')).resolves.toBe('alpha BETA gamma');
  });

  test.skipIf(!hasRipgrep)('match current Pi SDK grep, find, and ls behavior on fixtures including .gitignore', async () => {
    const cwd = await makeWorkspace();
    await initGitRepo(cwd);
    await mkdir(join(cwd, 'src'), { recursive: true });
    await mkdir(join(cwd, 'ignored-dir'), { recursive: true });
    await writeFile(join(cwd, '.gitignore'), 'ignored.txt\nignored-dir/\n', 'utf-8');
    await writeFile(join(cwd, 'src', 'alpha.ts'), 'needle alpha\n', 'utf-8');
    await writeFile(join(cwd, 'src', 'beta.txt'), 'needle beta\n', 'utf-8');
    await writeFile(join(cwd, 'ignored.txt'), 'needle ignored\n', 'utf-8');
    await writeFile(join(cwd, 'ignored-dir', 'hidden.ts'), 'needle hidden\n', 'utf-8');

    const current = byName(currentPiBuiltins(cwd));
    const runtimeBacked = byName(executionTools(cwd));

    const grepParams = { pattern: 'needle', path: '.', limit: 10 };
    const currentGrep = await executeText(current.get('grep')!, grepParams);
    const runtimeGrep = await executeText(runtimeBacked.get('grep')!, grepParams);
    expect(runtimeGrep.split('\n').sort()).toEqual(currentGrep.split('\n').sort());
    expect(runtimeGrep).toContain('src/alpha.ts:1: needle alpha');
    expect(runtimeGrep).not.toContain('ignored');

    const findParams = { pattern: '*.ts', path: '.', limit: 10 };
    await expect(executeText(runtimeBacked.get('find')!, findParams))
      .resolves.toBe(await executeText(current.get('find')!, findParams));
    await expect(executeText(runtimeBacked.get('find')!, findParams))
      .resolves.toBe('src/alpha.ts');

    const lsParams = { path: '.', limit: 10 };
    await expect(executeText(runtimeBacked.get('ls')!, lsParams))
      .resolves.toBe(await executeText(current.get('ls')!, lsParams));
  }, 20000);
});
