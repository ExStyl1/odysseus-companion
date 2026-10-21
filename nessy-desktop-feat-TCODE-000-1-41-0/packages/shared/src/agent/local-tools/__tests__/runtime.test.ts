import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LocalToolPermissionGate,
  LocalToolRuntime,
  resolveScopedPath,
  type LocalToolCall,
  type LocalToolRuntimeOptions,
} from '../index.ts';

async function makeWorkspace(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'nessy-local-tools-')));
}

function makeCall(overrides: Partial<LocalToolCall> = {}): LocalToolCall {
  return {
    id: 'call-1',
    displayName: 'Read',
    operation: { kind: 'read_file', path: 'README.md' },
    permission: {
      toolName: 'Read',
      input: { file_path: 'README.md' },
    },
    ...overrides,
  };
}

function testScope(primaryRoot: string, cwd = primaryRoot) {
  return {
    session: { workspaceId: 'ws-test', sessionId: 'session-test' },
    primaryRoot,
    cwd,
    additionalRoots: [],
    managedExclusions: [],
    generation: 'g-test',
  };
}

function makeRuntime(options: Partial<LocalToolRuntimeOptions> & {
  workspaceRootPath: string;
  workingDirectory?: string;
}): LocalToolRuntime {
  const { workspaceRootPath, workingDirectory, ...rest } = options;
  return new LocalToolRuntime({
    filesystemScope: testScope(workspaceRootPath, workingDirectory ?? workspaceRootPath),
    permissionManager: rest.permissionManager ?? {
      evaluateToolCall: () => ({ allowed: true }),
    },
    ...rest,
  });
}

describe('local tool path scope', () => {
  test('resumes the suspended call after an approved outside-root request', async () => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    await writeFile(join(outside, 'external.txt'), 'external content');

    const approvals: Array<{ target: string; access: string }> = [];
    const scope = testScope(workspace);
    const runtime = new LocalToolRuntime({
      filesystemScope: scope,
      permissionManager: { evaluateToolCall: () => ({ allowed: true }) },
      requestOutsideRootApproval: async (target, access) => {
        approvals.push({ target, access });
        return { canonicalRoot: outside, access: 'read', receiptId: 'r-1', expires: 'session' };
      },
    });

    const first = await runtime.execute(makeCall({
      operation: { kind: 'read_file', path: join(outside, 'external.txt') },
      permission: { toolName: 'Read', input: { file_path: join(outside, 'external.txt') } },
    }));
    expect(first.isError).toBeFalsy();
    expect(first.content).toContain('external content');
    expect(approvals).toEqual([{ target: join(outside, 'external.txt'), access: 'read' }]);
    // Session-lifetime receipt joined the live scope: no second approval.
    const second = await runtime.execute(makeCall({
      operation: { kind: 'read_file', path: join(outside, 'external.txt') },
      permission: { toolName: 'Read', input: { file_path: join(outside, 'external.txt') } },
    }));
    expect(second.isError).toBeFalsy();
    expect(approvals).toHaveLength(1);
    expect(scope.additionalRoots).toHaveLength(1);
  });

  test('denied outside-root approval fails the call with no side effect', async () => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    const scope = testScope(workspace);
    const runtime = new LocalToolRuntime({
      filesystemScope: scope,
      permissionManager: { evaluateToolCall: () => ({ allowed: true }) },
      requestOutsideRootApproval: async () => null,
    });

    const denied = await runtime.execute(makeCall({
      operation: { kind: 'write_file', path: join(outside, 'evil.txt'), content: 'x' },
      permission: { toolName: 'Write', input: { file_path: join(outside, 'evil.txt') } },
    }));
    expect(denied.isError).toBe(true);
    expect(denied.error).toContain('outside the session filesystem scope');
    expect(scope.additionalRoots).toHaveLength(0);
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(outside, 'evil.txt'))).toBe(false);
  });

  test('rejects workspace path escapes', async () => {
    const workspace = await makeWorkspace();

    expect(() => resolveScopedPath('../outside.txt', testScope(workspace)))
      .toThrow('Path is outside the session filesystem scope');
  });

  test('resolves relative paths from the working directory', async () => {
    const workspace = await makeWorkspace();
    const workingDirectory = join(workspace, 'nested');

    expect(resolveScopedPath('file.txt', testScope(workspace, workingDirectory)))
      .toBe(join(workingDirectory, 'file.txt'));
  });
});

describe('local tool permission gate', () => {
  test('authorized execution skips the legacy gate without owning descriptor checkpoints', async () => {
    const workspace = await makeWorkspace();
    const sessionPath = join(workspace, '.nessy-session');
    await mkdir(sessionPath, { recursive: true });
    let legacyDecisions = 0;
    const runtime = makeRuntime({
      workspaceRootPath: workspace,
      sessionPath,
      permissionManager: {
        evaluateToolCall: () => {
          legacyDecisions += 1;
          return { allowed: true };
        },
      },
    });

    const result = await runtime.executeAuthorized(makeCall({
      id: 'authorized-write',
      displayName: 'Write',
      operation: { kind: 'write_file', path: 'authorized.txt', content: 'ok' },
      permission: { toolName: 'Write', input: { file_path: 'authorized.txt' } },
    }));

    expect(result.isError).toBe(false);
    expect(legacyDecisions).toBe(0);
  });

  test('allows and blocks permission manager decisions', async () => {
    const allowedGate = new LocalToolPermissionGate({
      permissionManager: {
        evaluateToolCall: () => ({ allowed: true }),
      },
    });
    await expect(allowedGate.check(makeCall())).resolves.toEqual({ allowed: true });

    const blockedGate = new LocalToolPermissionGate({
      permissionManager: {
        evaluateToolCall: () => ({ allowed: false, reason: 'blocked by policy' }),
      },
    });
    await expect(blockedGate.check(makeCall())).resolves.toEqual({
      allowed: false,
      reason: 'blocked by policy',
    });
  });

  test('requests approval and accepts permission responses', async () => {
    const requests: unknown[] = [];
    const gate = new LocalToolPermissionGate({
      permissionManager: {
        evaluateToolCall: () => ({
          allowed: true,
          requiresPermission: true,
          description: 'Approve command',
        }),
      },
      onPermissionRequest: (request) => requests.push(request),
    });

    const pending = gate.check(makeCall({
      id: 'approval',
      permissionRequestId: 'request-1',
      permission: {
        toolName: 'Bash',
        input: { command: 'echo hi' },
        type: 'bash',
        command: 'echo hi',
      },
    }));

    expect(requests).toEqual([{
      requestId: 'request-1',
      toolName: 'Bash',
      command: 'echo hi',
      description: 'Approve command',
      type: 'bash',
    }]);

    gate.respondToPermission('request-1', true);
    await expect(pending).resolves.toEqual({ allowed: true });
  });

  test('requests approval and denies permission responses', async () => {
    const gate = new LocalToolPermissionGate({
      permissionManager: {
        evaluateToolCall: () => ({
          allowed: true,
          requiresPermission: true,
        }),
      },
      onPermissionRequest: () => {},
    });

    const pending = gate.check(makeCall({
      id: 'denied',
      permissionRequestId: 'request-2',
    }));

    gate.respondToPermission('request-2', false);
    await expect(pending).resolves.toEqual({
      allowed: false,
      reason: 'Permission denied',
    });
  });
});

describe('LocalToolRuntime operations', () => {
  test('reads, writes, and replaces the first occurrence only', async () => {
    const workspace = await makeWorkspace();
    const runtime = makeRuntime({ workspaceRootPath: workspace });

    const writeResult = await runtime.execute(makeCall({
      id: 'write',
      displayName: 'Write',
      operation: { kind: 'write_file', path: 'notes.txt', content: 'one two one' },
      permission: { toolName: 'Write', input: { file_path: 'notes.txt' } },
    }));
    expect(writeResult.isError).toBe(false);

    const readResult = await runtime.execute(makeCall({
      operation: { kind: 'read_file', path: 'notes.txt' },
    }));
    expect(readResult.content).toBe('one two one');

    const replaceResult = await runtime.execute(makeCall({
      id: 'replace',
      displayName: 'Edit',
      operation: { kind: 'replace_in_file', path: 'notes.txt', oldString: 'one', newString: 'three' },
      permission: { toolName: 'Edit', input: { file_path: 'notes.txt' } },
    }));
    expect(replaceResult.isError).toBe(false);
    expect(await readFile(join(workspace, 'notes.txt'), 'utf-8')).toBe('three two one');
  });

  test('applies edit_file edits against the original file and leaves invalid edits unchanged', async () => {
    const workspace = await makeWorkspace();
    const path = join(workspace, 'edit.txt');
    await writeFile(path, 'alpha beta gamma', 'utf-8');
    const runtime = makeRuntime({ workspaceRootPath: workspace });

    // P6.558 — the fixture puts the file on disk BEHIND the runtime's back, so
    // the session has not seen it and read-before-write refuses the edit. This
    // read is the fixture catching up with the rule, not a change of subject:
    // the assertions below are still about edit application and ordering.
    await runtime.execute(makeCall({ operation: { kind: 'read_file', path: 'edit.txt' } }));

    const editResult = await runtime.execute(makeCall({
      id: 'edit',
      displayName: 'Edit',
      operation: {
        kind: 'edit_file',
        path: 'edit.txt',
        edits: [
          { oldText: 'alpha', newText: 'gamma' },
          { oldText: 'gamma', newText: 'delta' },
        ],
      },
      permission: { toolName: 'Edit', input: { file_path: 'edit.txt' } },
    }));

    expect(editResult.isError).toBe(false);
    expect(await readFile(path, 'utf-8')).toBe('gamma beta delta');

    const invalidResult = await runtime.execute(makeCall({
      id: 'invalid-edit',
      displayName: 'Edit',
      operation: {
        kind: 'edit_file',
        path: 'edit.txt',
        edits: [{ oldText: 'a', newText: 'x' }],
      },
      permission: { toolName: 'Edit', input: { file_path: 'edit.txt' } },
    }));

    expect(invalidResult.isError).toBe(true);
    expect(invalidResult.error).toContain('Expected exactly one match');
    expect(await readFile(path, 'utf-8')).toBe('gamma beta delta');
  });

  test('returns missing string argument errors', async () => {
    const workspace = await makeWorkspace();
    const runtime = makeRuntime({ workspaceRootPath: workspace });

    const result = await runtime.execute(makeCall({
      operation: { kind: 'write_file', path: undefined, content: 'x' } as never,
      permission: { toolName: 'Write', input: {} },
    }));

    expect(result).toMatchObject({
      isError: true,
      error: 'Missing string argument: path',
    });
  });

  test('lists files recursively in sorted order', async () => {
    const workspace = await makeWorkspace();
    await mkdir(join(workspace, 'z'), { recursive: true });
    await mkdir(join(workspace, 'a'), { recursive: true });
    await writeFile(join(workspace, 'z', 'b.txt'), 'b', 'utf-8');
    await writeFile(join(workspace, 'a', 'c.txt'), 'c', 'utf-8');
    const runtime = makeRuntime({ workspaceRootPath: workspace });

    const result = await runtime.execute(makeCall({
      operation: { kind: 'list_files', recursive: true },
    }));

    expect(result.content.split('\n')).toEqual(['a', 'a/c.txt', 'z', 'z/b.txt']);
  });

  test('uses rg fixed-string search through the injected runner', async () => {
    const workspace = await makeWorkspace();
    const calls: Array<{ command: string; cwd: string }> = [];
    const runtime = makeRuntime({
      workspaceRootPath: workspace,
      runCommand: async (command, cwd) => {
        calls.push({ command, cwd });
        return { stdout: 'file.txt:1:needle', stderr: '', exitCode: 0 };
      },
    });

    const result = await runtime.execute(makeCall({
      operation: { kind: 'search_files', pattern: 'needle', path: 'src' },
    }));

    expect(result.content).toBe('file.txt:1:needle');
    expect(calls).toEqual([{
      command: `rg --line-number --fixed-strings 'needle' '${join(workspace, 'src')}'`,
      cwd: workspace,
    }]);
  });

  test('supports Pi-style grep, find, and ls options', async () => {
    const workspace = await makeWorkspace();
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, 'src', 'alpha.ts'), 'alpha', 'utf-8');
    await writeFile(join(workspace, 'src', 'beta.test.ts'), 'beta', 'utf-8');
    const commands: string[] = [];
    const runtime = makeRuntime({
      workspaceRootPath: workspace,
      runCommand: async (command) => {
        commands.push(command);
        if (command.includes("'--files'")) {
          return {
            stdout: [
              join(workspace, 'src', 'alpha.ts'),
              join(workspace, 'src', 'beta.test.ts'),
              join(workspace, 'src', 'third.ts'),
            ].join('\n'),
            stderr: '',
            exitCode: 0,
          };
        }
        return {
          stdout: ['src/alpha.ts:1:Alpha', 'src/beta.test.ts:1:alpha', 'src/third.ts:1:alpha'].join('\n'),
          stderr: '',
          exitCode: 0,
        };
      },
    });

    const grepResult = await runtime.execute(makeCall({
      operation: {
        kind: 'grep',
        pattern: 'alpha',
        path: 'src',
        glob: '*.ts',
        ignoreCase: true,
        literal: true,
        context: 2,
        limit: 2,
      },
    }));
    expect(grepResult.content.split('\n')).toEqual(['src/alpha.ts:1:Alpha', 'src/beta.test.ts:1:alpha']);
    expect(commands[0]).toContain("'--ignore-case'");
    expect(commands[0]).toContain("'--fixed-strings'");
    expect(commands[0]).toContain("'--context'");
    expect(commands[0]).toContain("'*.ts'");

    const findResult = await runtime.execute(makeCall({
      operation: { kind: 'find', pattern: '*.ts', path: 'src', limit: 1 },
    }));
    expect(findResult.content).toBe('alpha.ts');
    expect(commands[1]).toContain("'--files'");
    expect(commands[1]).toContain("'--hidden'");
    expect(commands[1]).toContain("'!**/.git/**'");

    const lsResult = await runtime.execute(makeCall({
      operation: { kind: 'ls', path: 'src', limit: 1 },
    }));
    expect(lsResult.content).toBe('alpha.ts');
  });

  test('scopes bash cwd and forwards timeout to the injected runner', async () => {
    const workspace = await makeWorkspace();
    const controller = new AbortController();
    const calls: Array<{ command: string; cwd: string; timeout?: number; signal?: AbortSignal }> = [];
    const runtime = makeRuntime({
      workspaceRootPath: workspace,
      runCommand: async (command, cwd, options) => {
        calls.push({ command, cwd, timeout: options?.timeout, signal: options?.signal });
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      },
    });

    const result = await runtime.execute(makeCall({
      abortSignal: controller.signal,
      operation: { kind: 'bash', command: 'pwd', cwd: '.', timeout: 1234 },
      permission: { toolName: 'Bash', input: { command: 'pwd' }, type: 'bash', command: 'pwd' },
    }));

    expect(result.content).toBe('ok');
    expect(calls).toEqual([{ command: 'pwd', cwd: workspace, timeout: 1234, signal: controller.signal }]);

    const escaped = await runtime.execute(makeCall({
      operation: { kind: 'bash', command: 'pwd', cwd: '..' },
      permission: { toolName: 'Bash', input: { command: 'pwd' }, type: 'bash', command: 'pwd' },
    }));
    expect(escaped.isError).toBe(true);
    expect(escaped.error).toContain('Path is outside the session filesystem scope');
  });

  test('rejects unknown MCP proxies and passes structured content through', async () => {
    const workspace = await makeWorkspace();
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const runtime = makeRuntime({
      workspaceRootPath: workspace,
      mcpPool: {
        isProxyTool: proxyName => proxyName === 'known_proxy',
        callTool: async (_name, _args, signal) => {
          receivedSignal = signal;
          return {
          content: 'mcp output',
          structuredContent: { ok: true },
          };
        },
      },
    });

    const unknown = await runtime.execute(makeCall({
      operation: { kind: 'mcp', proxyName: 'missing_proxy', args: {} },
      permission: { toolName: 'missing_proxy', input: {}, type: 'mcp_mutation' },
    }));
    expect(unknown).toMatchObject({
      isError: true,
      error: 'Unknown MCP proxy tool: missing_proxy',
    });

    const known = await runtime.execute(makeCall({
      abortSignal: controller.signal,
      operation: { kind: 'mcp', proxyName: 'known_proxy', args: { value: 1 } },
      permission: { toolName: 'known_proxy', input: { value: 1 }, type: 'mcp_mutation' },
    }));
    expect(known).toMatchObject({
      content: 'mcp output',
      isError: false,
      structuredContent: { ok: true },
    });
    expect(receivedSignal).toBe(controller.signal);
  });

  test('replaces large local results when guardLargeResult handles them', async () => {
    const workspace = await makeWorkspace();
    const sessionPath = join(workspace, '.nessy-session');
    await mkdir(sessionPath, { recursive: true });
    const hugeOutput = Array.from({ length: 9000 }, (_, index) => `line ${index}`).join('\n');
    const runtime = makeRuntime({
      workspaceRootPath: workspace,
      sessionPath,
      contextWindow: 1,
      summarizeLargeResult: async () => 'short summary',
      runCommand: async () => ({ stdout: hugeOutput, stderr: '', exitCode: 0 }),
    });

    const result = await runtime.execute(makeCall({
      displayName: 'Bash',
      operation: { kind: 'bash', command: 'generate' },
      permission: { toolName: 'Bash', input: { command: 'generate' }, type: 'bash', command: 'generate' },
    }));

    expect(result.isError).toBe(false);
    expect(result.content).toContain('[Large response');
    expect(result.content).toContain('Full data saved to:');
    expect(result.content).toContain('short summary');
    expect(result.content).not.toBe(hugeOutput);
  });

  test('can retain runtime checkpoints while delegating large-result ownership', async () => {
    const workspace = await makeWorkspace();
    const sessionPath = join(workspace, '.nessy-session');
    await mkdir(sessionPath, { recursive: true });
    const hugeOutput = 'x'.repeat(80_000);
    const runtime = makeRuntime({
      workspaceRootPath: workspace,
      sessionPath,
      guardLargeResults: false,
      contextWindow: 1,
      summarizeLargeResult: async () => 'must not run',
      runCommand: async () => ({ stdout: hugeOutput, stderr: '', exitCode: 0 }),
    });

    const result = await runtime.executeAuthorized(makeCall({
      displayName: 'Bash',
      operation: { kind: 'bash', command: 'generate' },
      permission: { toolName: 'Bash', input: { command: 'generate' }, type: 'bash', command: 'generate' },
    }));

    expect(result.content).toBe(hugeOutput);
  });

  test('routes every command-backed operation through the supervised metadata seam', async () => {
    const workspace = await makeWorkspace();
    const calls: Array<{ semanticId?: string; isolationProfile?: string }> = [];
    const runtime = makeRuntime({
      workspaceRootPath: workspace,
      runCommand: async (_command, _cwd, options) => {
        calls.push({ semanticId: options?.semanticId, isolationProfile: options?.isolationProfile });
        return { stdout: '', stderr: '', exitCode: 0, isolationProfile: `${options?.isolationProfile}:test` };
      },
    });
    for (const operation of [
      { kind: 'search_files', pattern: 'x' },
      { kind: 'grep', pattern: 'x' },
      { kind: 'find', pattern: 'x' },
      { kind: 'bash', command: 'true' },
    ] as const) {
      await runtime.executeAuthorized(makeCall({
        operation,
        permission: { toolName: operation.kind, input: {} },
      }));
    }
    expect(calls).toEqual([
      { semanticId: 'read', isolationProfile: 'read-only' },
      { semanticId: 'grep', isolationProfile: 'read-only' },
      { semanticId: 'find', isolationProfile: 'read-only' },
      // Owner decision 2026-07-28: shell commands run networked (identical
      // writable root to `workspace`, network dimension open). R19 is the
      // parked row that would narrow egress again.
      { semanticId: 'bash', isolationProfile: 'networked' },
    ]);
  });

  test('keeps rg no-match results successful while preserving supervised isolation', async () => {
    const workspace = await makeWorkspace();
    const runtime = makeRuntime({
      workspaceRootPath: workspace,
      runCommand: async () => ({ stdout: '', stderr: '', exitCode: 1, isolationProfile: 'read-only:test' }),
    });
    for (const operation of [
      { kind: 'search_files', pattern: 'missing' },
      { kind: 'grep', pattern: 'missing' },
      { kind: 'find', pattern: 'missing' },
    ] as const) {
      const execution = await runtime.executeAuthorized(makeCall({ operation, permission: { toolName: operation.kind, input: {} } }));
      expect(execution).toMatchObject({ content: '', isError: false, isolationProfile: 'read-only:test' });
    }
  });

  // P3.149. All three of these shell out to ripgrep and none of them checked it
  // was there. Measured before the guard, on a host with no `rg` on PATH:
  // `grep`/`search_files` returned isError:false carrying `/bin/sh: rg: command
  // not found` as their CONTENT, and `find` returned isError:false with an EMPTY
  // body — the error line was discarded by its own glob filter, so a missing
  // binary was indistinguishable from "no matching files". The stderr and exit
  // code below are the shape measured from `/bin/sh -c "rg …"` on that host, not
  // an invented one.
  test('names ripgrep when it is missing instead of reporting a shell error as content', async () => {
    const workspace = await makeWorkspace();
    const runtime = makeRuntime({
      workspaceRootPath: workspace,
      runCommand: async () => ({ stdout: '', stderr: '/bin/sh: rg: command not found\n', exitCode: 127 }),
    });
    for (const operation of [
      { kind: 'search_files', pattern: 'anything' },
      { kind: 'grep', pattern: 'anything' },
      { kind: 'find', pattern: '*' },
    ] as const) {
      const execution = await runtime.executeAuthorized(makeCall({ operation, permission: { toolName: operation.kind, input: {} } }));
      // The diagnosis is an ERROR, not a result. This is the assertion that
      // `find` failed hardest before the guard: it returned content '' with
      // isError false, a confident and wrong "no files match".
      expect(execution.isError).toBe(true);
      expect(execution.content).not.toBe('');
      // It names the tool, the package this repo vendors it from, and the
      // underlying failure — a diagnosis nobody can act on is not a diagnosis.
      expect(execution.content).toContain('rg');
      expect(execution.content).toContain('@vscode/ripgrep');
      expect(execution.content).toContain('exit 127');
    }
  });

  // The test above cannot tell the two detection branches apart: its fixture
  // carries BOTH exit 127 and a matching stderr, so either one alone satisfies
  // it — a mutant that killed the exit-code branch survived it. This isolates
  // the exit code, and the case is real rather than contrived: a runner that
  // resolves the binary itself, or a sandbox that reports only the status,
  // hands back the code with no shell message attached.
  test('names ripgrep on exit 127 alone, with no shell message to match on', async () => {
    const workspace = await makeWorkspace();
    const runtime = makeRuntime({
      workspaceRootPath: workspace,
      runCommand: async () => ({ stdout: '', stderr: '', exitCode: 127 }),
    });
    const execution = await runtime.executeAuthorized(makeCall({
      operation: { kind: 'grep', pattern: 'anything' },
      permission: { toolName: 'grep', input: {} },
    }));
    expect(execution.isError).toBe(true);
    expect(execution.content).toContain('@vscode/ripgrep');
  });

  test('does not mistake ripgrep\'s own error exit for a missing binary', async () => {
    const workspace = await makeWorkspace();
    // Exit 2 is how `rg` reports a bad pattern: the binary IS present. Reporting
    // this as "ripgrep is not available" would send the reader to install a tool
    // they already have. Exit 1 (no match) is pinned by the test above.
    const runtime = makeRuntime({
      workspaceRootPath: workspace,
      runCommand: async () => ({ stdout: '', stderr: 'regex parse error\n', exitCode: 2 }),
    });
    const execution = await runtime.executeAuthorized(makeCall({
      operation: { kind: 'grep', pattern: '[' },
      permission: { toolName: 'grep', input: {} },
    }));
    expect(execution.content).not.toContain('@vscode/ripgrep');
    expect(execution.content).toContain('regex parse error');
  });

  test('requires the tool name before reading a non-127 failure as a missing binary', async () => {
    const workspace = await makeWorkspace();
    // The non-127 branch is deliberately narrow: "ENOENT" alone is not enough,
    // because a command can fail with ENOENT over one of its own arguments while
    // the binary is present. Without the tool-name requirement this would be
    // misreported as missing ripgrep.
    const runtime = makeRuntime({
      workspaceRootPath: workspace,
      runCommand: async () => ({ stdout: '', stderr: "ENOENT: no such file or directory, open 'nope.txt'\n", exitCode: 2 }),
    });
    const execution = await runtime.executeAuthorized(makeCall({
      operation: { kind: 'grep', pattern: 'x' },
      permission: { toolName: 'grep', input: {} },
    }));
    expect(execution.content).not.toContain('@vscode/ripgrep');
  });
});
