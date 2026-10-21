import { readFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative } from 'node:path';

import type {
  AgentToolResult,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';

import {
  resolveScopedPath,
  type LocalToolExecutionResult,
  type LocalToolOperation,
} from '../../../shared/src/agent/local-tools/index.ts';
import { resolveBashDefaultTimeoutMs } from '../../../shared/src/agent/pi-harness/process-supervisor-port.ts';
import type { SessionKey } from '../../../shared/src/sessions/types.ts';
import type {
  ToolExecutor,
  ToolExecutionPort,
  ToolManifestIdentity,
} from '../../../shared/src/agent/pi-harness/tool-executor.ts';
import {
  createNotebookAwareReadToolDefinition,
  createNotebookEditTool,
} from '../tools/notebook.ts';

/**
 * The builtin tools this host implements and hands to Pi, and the ONE name in
 * Pi's own set that is deliberately not here.
 *
 * P7.8 — `powershell` is REFUSED BY NAME, not missed. Pi 0.84.3 ships a real
 * builtin PowerShell tool: `ToolName` and `allToolNames` go 7 → 8
 * (`@earendil-works/pi-coding-agent`'s `core/tools/index.js`), with
 * `createPowerShellTool` / `createPowerShellToolDefinition` /
 * `createLocalPowerShellOperations` and a matching `ToolsOptions.powershell`.
 * It is OPT-IN: `createCodingToolDefinitions` still returns read/bash/edit/write
 * and nothing here composes from `allToolNames`, so the default set is unchanged
 * and nothing has to be removed to keep today's behaviour.
 *
 * Why not enabled (the balance rule, 2026-09-10): Windows builds are parked, and
 * a SECOND shell tool is not a one-line addition here — it needs a permission
 * mapping of its own (the `bash` rules in `pi-harness/claude-bash-rule.ts` parse
 * POSIX command lines and say nothing about PowerShell), a `tool-surface.json`
 * row, and a model-contract hash. Shipping it without those three would give the
 * model a shell the permission layer cannot reason about, which is the one
 * direction that must never be taken by default. Our Windows sessions keep going
 * through `bash`.
 *
 * This is a recorded refusal so the next reader does not meet it as an absence:
 * enabling it is its own row, and the reason it is not in this array is above
 * rather than nowhere.
 */
export const RUNTIME_BACKED_BUILTIN_TOOL_NAMES = [
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
  'NotebookEdit',
] as const;

type RuntimeBackedBuiltinToolName = typeof RUNTIME_BACKED_BUILTIN_TOOL_NAMES[number];

export interface RuntimeBackedToolOptions {
  toolExecutor?: ToolExecutor;
  sessionKey?: SessionKey;
  manifestIdentity?: ToolManifestIdentity;
}

const READ_PARAMETERS = {
  type: 'object',
  required: ['path'],
  properties: {
    path: {
      type: 'string',
      description: 'Path to the file to read (relative or absolute)',
    },
    offset: {
      type: 'number',
      description: 'Line number to start reading from (1-indexed)',
    },
    limit: {
      type: 'number',
      description: 'Maximum number of lines to read',
    },
  },
};

// COMPOSITION-STABLE TEXT ONLY (live-manifest-contract.test.ts): the manifest
// projection rewrites tool-name mentions per composition, so schema text here
// must never contain a rewritable name ('BashOutput', 'ProcessStop', or 'Bash',
// which becomes unambiguous when the off switch removes bash_background) -
// otherwise the projected hash drifts from the static pin and the live first
// turn fails with a model-contract mismatch.
//
// A model-facing piName is still safe to write - it is a rewrite TARGET, never a
// source - but the session-tool wire-name unification moved every one of them,
// so "safe" no longer means "stable". This text names `mcp__session__ProcessStop`
// (it used to name `mcp__session__process_stop`), and both pins below moved with
// it. A piName spelled here is a pinned copy of another tool's name: when that
// name changes, this text and the two hashes change in the same commit.
//
// The bare `ProcessStop` inside the piName is NOT re-rewritten: the rewrite
// patterns are bounded by `(?<![A-Za-z0-9_])`, and `_` is in that class.
//
// PIN ARITHMETIC: a model-visible schema edit here moves FIVE pinned values, not
// one - `PI_STATIC_MODEL_CONTRACT_HASHES.<tool>` in
// `shared/src/agent/pi-harness/harness-tool-descriptor.ts` plus that tool's four
// values in `__tests__/harness-contract/fixtures/tool-surface.json`
// (`schemaIdentity`, `modelSchemaVersion` and `bindingSchemaVersion`, the three
// live-tool-parameters digests, and `modelContractHash`) - and the subprocess
// bundles then need `bun run electron:build:servers`, because
// live-manifest-contract.test.ts also asserts the BUILT bundle carries the
// current pin. Stop after the first pin and the live first turn dies with
// `Pi execution manifest model contract mismatch for <tool>` - measured by P6.329
// (`d518bcd52`), four red in that suite before the re-pin and 6/6 after.
const BASH_PARAMETERS = {
  type: 'object',
  required: ['command'],
  properties: {
    command: {
      type: 'string',
      description: 'Shell command to execute',
    },
    timeout: {
      type: 'number',
      description: 'Timeout in milliseconds (optional, defaults to 120000; values below 1000 are raised to 1000)',
    },
    run_in_background: {
      type: 'boolean',
      description: 'Start the command as a background task and return its shell_id and output file immediately instead of waiting for exit. Use mcp__session__ProcessStop to stop it.',
    },
    dangerouslyDisableSandbox: {
      type: 'boolean',
      // P6.329 · the INPUT-side seam, and the ONLY half built (controller
      // decision 2026-09-06). This sentence used to say "after a run has already
      // failed for that reason" and left the model to recognise a reason the
      // layer below never states: the OS boundary returns a bare `Operation not
      // permitted`, naming neither the path nor the host it refused. So the
      // instruction presumed a legibility that does not exist, and a model that
      // took it literally would never set the flag.
      //
      // Measured, both arms. On Pi there is no classifier at all — bwrap and
      // Seatbelt return EPERM and nothing decorates it. On codex there IS one and
      // it does not reach us: `classify_filesystem_sandbox_violation` covers
      // filesystem denials only, `SANDBOX_DENIED_KEYWORDS` carries no network
      // needle, and `record_network_sandbox_violation` emits a `tracing::warn!`
      // INSIDE the codex process and never a protocol event.
      //
      // The RESULT-side seam — putting the refused path or host into the tool
      // result — is deliberately NOT built: the sandbox is off by standing owner
      // decision, so it would be code with no live subject. Naming the SHAPE of
      // the failure here costs nothing and is the half that changes what the
      // model is told. Written without a rewritable tool name, per the
      // composition-stability rule at the top of this block.
      description: 'Retry a command that failed because of sandbox restrictions, running it outside the sandbox. Only set this after a run has already failed for that reason, and only when the command cannot work inside the sandbox. The sandbox does not name what it refused: a filesystem denial arrives as a bare "Operation not permitted" (EPERM) with no path in it, and a blocked network call as a connection or name-resolution failure with no host in it. Those, on a command that should have worked, are the reason. The retry goes through the regular permission flow and the host records the decision.',
    },
  },
};

const EDIT_PARAMETERS = {
  type: 'object',
  required: ['path', 'edits'],
  properties: {
    path: {
      type: 'string',
      description: 'Path to the file to edit (relative or absolute)',
    },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        required: ['oldText', 'newText'],
        properties: {
          oldText: {
            type: 'string',
            description: 'Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.',
          },
          newText: {
            type: 'string',
            description: 'Replacement text for this targeted edit.',
          },
        },
        additionalProperties: false,
      },
      description: 'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.',
    },
  },
  additionalProperties: false,
};

const WRITE_PARAMETERS = {
  type: 'object',
  required: ['path', 'content'],
  properties: {
    path: {
      type: 'string',
      description: 'Path to the file to write (relative or absolute)',
    },
    content: {
      type: 'string',
      description: 'Content to write to the file',
    },
  },
};

const GREP_PARAMETERS = {
  type: 'object',
  required: ['pattern'],
  properties: {
    pattern: {
      type: 'string',
      description: 'Search pattern (regex or literal string)',
    },
    path: {
      type: 'string',
      description: 'Directory or file to search (default: current directory)',
    },
    glob: {
      type: 'string',
      description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'",
    },
    ignoreCase: {
      type: 'boolean',
      description: 'Case-insensitive search (default: false)',
    },
    literal: {
      type: 'boolean',
      description: 'Treat pattern as literal string instead of regex (default: false)',
    },
    context: {
      type: 'number',
      description: 'Number of lines to show before and after each match (default: 0)',
    },
    limit: {
      type: 'number',
      description: 'Maximum number of matches to return (default: 100)',
    },
  },
};

const FIND_PARAMETERS = {
  type: 'object',
  required: ['pattern'],
  properties: {
    pattern: {
      type: 'string',
      description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
    },
    path: {
      type: 'string',
      description: 'Directory to search in (default: current directory)',
    },
    limit: {
      type: 'number',
      description: 'Maximum number of results (default: 1000)',
    },
  },
};

const LS_PARAMETERS = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Directory to list (default: current directory)',
    },
    limit: {
      type: 'number',
      description: 'Maximum number of entries to return (default: 500)',
    },
  },
};

const PROMPT_GUIDELINES = {
  read: ['Use read to examine files instead of cat or sed.'],
  edit: [
    'Use edit for precise changes (edits[].oldText must match exactly)',
    'When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls',
    'Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.',
    'Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.',
  ],
  write: ['Use write only for new files or complete rewrites.'],
};

export function buildRuntimeBackedBuiltinToolDefinitions(
  cwd: string,
  options: RuntimeBackedToolOptions = {},
): ToolDefinition<any, any>[] {
  const notebookRead = createNotebookAwareReadToolDefinition(cwd);
  const notebookEdit = createNotebookEditTool(cwd);
  const execute = (
    semanticId: string,
    presentedName: string,
    executionId: string,
    canonicalInput: unknown,
    abortSignal?: AbortSignal,
  ) => executeRuntime(options, {
    executionId,
    semanticId,
    canonicalInput,
    source: 'pi',
    presentedName,
    abortSignal: abortSignal ?? new AbortController().signal,
  });

  return [
    {
      name: 'read',
      label: 'read',
      description: notebookRead.description,
      promptSnippet: 'Use read to read file contents; for .ipynb files, shows notebook cells by index',
      promptGuidelines: PROMPT_GUIDELINES.read,
      parameters: READ_PARAMETERS as any,
      async execute(executionId, params, signal) {
        return toPiResult(await execute('read', 'read', executionId, params, signal));
      },
    },
    {
      name: 'bash',
      label: 'bash',
      description: 'Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.',
      promptSnippet: 'Use bash to execute shell commands (ls, grep, find, etc.)',
      parameters: BASH_PARAMETERS as any,
      async execute(executionId, params, signal) {
        return toPiResult(await execute('bash', 'bash', executionId, params, signal));
      },
    },
    {
      name: 'edit',
      label: 'edit',
      description: 'Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.',
      promptSnippet: 'Use edit to make precise file edits with exact text replacement, including multiple disjoint edits in one call',
      promptGuidelines: PROMPT_GUIDELINES.edit,
      parameters: EDIT_PARAMETERS as any,
      prepareArguments: prepareEditArguments,
      async execute(executionId, params, signal) {
        return toPiResult(await execute('edit', 'edit', executionId, params, signal));
      },
    },
    {
      name: 'write',
      label: 'write',
      description: 'Write content to a file. Creates the file if it doesn\'t exist, overwrites if it does. Automatically creates parent directories.',
      promptSnippet: 'Use write to create or overwrite files',
      promptGuidelines: PROMPT_GUIDELINES.write,
      parameters: WRITE_PARAMETERS as any,
      async execute(executionId, params, signal) {
        return toPiResult(await execute('write', 'write', executionId, params, signal));
      },
    },
    {
      name: 'grep',
      label: 'grep',
      description: 'Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars.',
      promptSnippet: 'Use grep to search file contents for patterns (respects .gitignore)',
      parameters: GREP_PARAMETERS as any,
      async execute(executionId, params, signal) {
        return toPiResult(await execute('grep', 'grep', executionId, params, signal));
      },
    },
    {
      name: 'find',
      label: 'find',
      description: 'Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first).',
      promptSnippet: 'Use find to find files by glob pattern (respects .gitignore)',
      parameters: FIND_PARAMETERS as any,
      async execute(executionId, params, signal) {
        return toPiResult(await execute('find', 'find', executionId, params, signal));
      },
    },
    {
      name: 'ls',
      label: 'ls',
      description: 'List directory contents. Returns entries sorted alphabetically, with \'/\' suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).',
      promptSnippet: 'Use ls to list directory contents',
      parameters: LS_PARAMETERS as any,
      async execute(executionId, params, signal) {
        return toPiResult(await execute('ls', 'ls', executionId, params, signal));
      },
    },
    {
      ...notebookEdit,
      async execute(executionId, params, signal) {
        return toPiResult(await execute('notebook_edit', 'NotebookEdit', executionId, params, signal));
      },
    },
  ];
}

export function buildRuntimeBackedToolExecutionPorts(cwd: string): ToolExecutionPort[] {
  const notebookRead = createNotebookAwareReadToolDefinition(cwd);
  const notebookEdit = createNotebookEditTool(cwd);
  return [
    {
      semanticId: 'read',
      canonicalize: input => strictRecord(input, ['path', 'offset', 'limit'], value => ({
        path: stringArg(value.path, 'path'),
        ...(numberArg(value.offset) === undefined ? {} : { offset: numberArg(value.offset) }),
        ...(numberArg(value.limit) === undefined ? {} : { limit: numberArg(value.limit) }),
      })),
      dispatch: {
        kind: 'select',
        useSemantic: input => extname(String(input.path)).toLowerCase() === '.ipynb',
        toLocalCall: (input, request, signal) => localCall('read', input, request.executionId, signal, {
          kind: 'read_file', path: String(input.path), offset: numberArg(input.offset), limit: numberArg(input.limit),
        }),
        executeSemantic: async (input, context) => agentToLocalResult(await notebookRead.execute(
          'notebook-read', input, context.signal, undefined, undefined as never,
        )),
        mapResult: async (result, input) => agentToLocalResult(await appendReadContinuation(toPiResult(result), cwd, input)),
      },
    },
    // `dangerouslyDisableSandbox` is accepted here so the model can spell it and
    // the HOST sees it on the permission input, where the ask rule
    // `Bash(dangerouslyDisableSandbox:true)` (sandboxing.md:135) is evaluated
    // and the downgrade decision is minted. It is deliberately NOT forwarded
    // into the `bash` operation: `handleProcessStartRequest` rebuilds the host
    // request from an allowlist, so a subprocess-supplied bypass could not be
    // honoured, and the host adds the flag itself keyed by executionId.
    localPort('bash', ['command', 'timeout', 'run_in_background', 'dangerouslyDisableSandbox'], input => ({
      // `env-vars.md#variables` — "`BASH_DEFAULT_TIMEOUT_MS` | Default timeout
      // for long-running bash commands (default: 120000, or 2 minutes)". The
      // fallback is resolved HERE rather than left to the `?? 120_000` one layer
      // down, because this is the only place that still knows the model sent no
      // `timeout` of its own. Unset, it resolves to the same 120000 — so an
      // operator who sets nothing sees no change, and one who sets the variable
      // finally gets what the page promises. The ceiling that bounds a value the
      // model DID send is the host's (`clampSupervisedChildTimeoutMs`), and it is
      // never below this default, so the two cannot fight.
      kind: 'bash', command: stringArg(input.command, 'command'),
      timeout: millisecondTimeout(numberArg(input.timeout)) ?? resolveBashDefaultTimeoutMs(),
      ...(input.run_in_background === true ? { runInBackground: true } : {}),
    }), (result) => ({ ...result, content: result.content || '(no output)' })),
    localPort('edit', ['path', 'file_path', 'edits', 'oldText', 'newText'], input => {
      const prepared = toRecord(prepareEditArguments(input));
      return { kind: 'edit_file', path: pathOrFilePathArg(prepared), edits: parseEdits(prepared.edits) };
    }, (result, input) => {
      if (result.isError) return result;
      const prepared = toRecord(prepareEditArguments(input));
      return { ...result, content: `Successfully replaced ${parseEdits(prepared.edits).length} block(s) in ${pathOrFilePathArg(prepared)}.` };
    }),
    localPort('write', ['path', 'file_path', 'content'], input => ({
      kind: 'write_file', path: pathOrFilePathArg(input), content: stringArg(input.content, 'content'),
    }), (result, input) => result.isError ? result : ({
      ...result,
      content: `Successfully wrote ${stringArg(input.content, 'content').length} bytes to ${pathOrFilePathArg(input)}`,
    })),
    localPort('grep', ['pattern', 'path', 'glob', 'ignoreCase', 'literal', 'context', 'limit'], input => ({
      kind: 'grep', pattern: stringArg(input.pattern, 'pattern'), path: typeof input.path === 'string' ? input.path : '.',
      glob: stringOptional(input.glob), ignoreCase: input.ignoreCase === true, literal: input.literal === true,
      context: numberArg(input.context), limit: numberArg(input.limit),
    }), (result, input) => ({
      ...result,
      content: result.content.length > 0
        ? normalizeGrepOutput(result.content.trimEnd(), cwd, typeof input.path === 'string' ? input.path : '.')
        : 'No matches found',
    })),
    localPort('find', ['pattern', 'path', 'limit'], input => ({
      kind: 'find', pattern: stringArg(input.pattern, 'pattern'), path: typeof input.path === 'string' ? input.path : '.', limit: numberArg(input.limit),
    }), result => ({ ...result, content: result.content || 'No files found matching pattern' })),
    localPort('ls', ['path', 'limit'], input => ({
      kind: 'ls', path: typeof input.path === 'string' ? input.path : '.', limit: numberArg(input.limit),
    }), result => ({ ...result, content: result.content || '(empty directory)' })),
    {
      semanticId: 'notebook_edit',
      canonicalize: input => strictRecord(input, ['notebook_path', 'cell_index', 'source'], value => {
        const cellIndex = value.cell_index;
        if (typeof cellIndex !== 'number' || !Number.isInteger(cellIndex) || cellIndex < 0) {
          throw new Error('NotebookEdit requires a non-negative integer cell_index.');
        }
        return {
          notebook_path: stringArg(value.notebook_path, 'notebook_path'),
          cell_index: cellIndex,
          source: stringArg(value.source, 'source'),
        };
      }),
      dispatch: {
        kind: 'semantic',
        execute: async (input, context) => agentToLocalResult(await notebookEdit.execute(
          'notebook-edit', input, context.signal, undefined, undefined as never,
        )),
      },
    },
  ];
}

async function executeRuntime(
  options: RuntimeBackedToolOptions,
  request: Omit<Parameters<ToolExecutor['execute']>[0], 'sessionKey' | 'manifestIdentity'>,
): Promise<LocalToolExecutionResult> {
  if (!options.toolExecutor || !options.sessionKey || !options.manifestIdentity) {
    throw new Error(`Runtime-backed Pi tool ${request.semanticId} requires the session ToolExecutor`);
  }
  const receipt = await options.toolExecutor.execute({
    ...request,
    sessionKey: options.sessionKey,
    manifestIdentity: options.manifestIdentity,
  });
  return receipt.result;
}

function localPort(
  semanticId: RuntimeBackedBuiltinToolName | 'notebook_edit',
  keys: readonly string[],
  operation: (input: Record<string, unknown>) => LocalToolOperation,
  mapResult?: (result: LocalToolExecutionResult, input: Record<string, unknown>) => LocalToolExecutionResult,
): ToolExecutionPort {
  return {
    semanticId: semanticId === 'NotebookEdit' ? 'notebook_edit' : semanticId,
    canonicalize: input => strictRecord(input, keys),
    dispatch: {
      kind: 'local',
      toLocalCall: (input, request, signal) => localCall(
        semanticId as RuntimeBackedBuiltinToolName,
        input,
        request.executionId,
        signal,
        operation(input),
      ),
      ...(mapResult ? { mapResult } : {}),
    },
  };
}

function localCall(
  toolName: RuntimeBackedBuiltinToolName,
  input: Record<string, unknown>,
  executionId: string,
  signal: AbortSignal,
  operation: LocalToolOperation,
) {
  return {
    id: executionId,
    displayName: toolName,
    operation,
    permission: {
      toolName: runtimePermissionName(toolName),
      input,
      ...(toolName === 'bash' ? { type: 'bash' as const, command: String(input.command ?? '') } : {}),
      ...(toolName === 'edit' || toolName === 'write' ? { type: 'file_write' as const } : {}),
    },
    abortSignal: signal,
  };
}

function runtimePermissionName(toolName: RuntimeBackedBuiltinToolName): string {
  switch (toolName) {
    case 'read':
      return 'Read';
    case 'bash':
      return 'Bash';
    case 'edit':
      return 'Edit';
    case 'write':
      return 'Write';
    case 'NotebookEdit':
      return 'NotebookEdit';
    default:
      return toolName;
  }
}

function toPiResult(result: LocalToolExecutionResult): AgentToolResult<any> {
  if (result.isError) {
    throw new Error(result.error ?? result.content);
  }
  return textResult(result.content, result.structuredContent);
}

function textResult(text: string, details?: Record<string, unknown>): AgentToolResult<any> {
  return {
    content: [{ type: 'text', text }],
    details,
  };
}

async function appendReadContinuation(
  result: AgentToolResult<any>,
  cwd: string,
  input: Record<string, unknown>,
): Promise<AgentToolResult<any>> {
  if (typeof input.path !== 'string' || typeof input.limit !== 'number') {
    return result;
  }
  const content = result.content[0];
  if (!content || content.type !== 'text') {
    return result;
  }

  try {
    const absolutePath = resolveScopedPath(input.path, cwdScope(cwd));
    const allLines = (await readFile(absolutePath, 'utf-8')).split('\n');
    const startLine = typeof input.offset === 'number' ? Math.max(0, Math.floor(input.offset) - 1) : 0;
    const limitedLines = Math.max(0, Math.floor(input.limit));
    const nextOffset = startLine + limitedLines + 1;
    const remaining = allLines.length - (startLine + limitedLines);
    if (remaining > 0) {
      return {
        ...result,
        content: [{
          type: 'text',
          text: `${content.text}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`,
        }],
      };
    }
  } catch {
    return result;
  }

  return result;
}

/**
 * Formatting-only scope over the already-authorized runtime cwd: these helpers
 * re-resolve display paths for output shaping AFTER the LocalToolRuntime made
 * the authoritative scope decision for the call.
 */
function cwdScope(cwd: string) {
  return {
    session: { workspaceId: '', sessionId: '' },
    primaryRoot: cwd,
    cwd,
    additionalRoots: [],
    managedExclusions: [],
    generation: '',
  };
}

function normalizeGrepOutput(text: string, cwd: string, searchPath: string): string {
  const absoluteSearchPath = resolveScopedPath(searchPath, cwdScope(cwd));

  return text
    .split('\n')
    .map(line => normalizeGrepLine(line, cwd, absoluteSearchPath))
    .join('\n');
}

function normalizeGrepLine(line: string, cwd: string, absoluteSearchPath: string): string {
  const match = /^(.+?)([:|-])(\d+)([:|-])(.*)$/.exec(line);
  if (!match) return line;

  const rawPath = match[1] ?? '';
  const firstSeparator = match[2] ?? ':';
  const lineNumber = match[3] ?? '';
  const secondSeparator = match[4] ?? ':';
  const lineText = match[5] ?? '';
  const normalizedPath = normalizePathForSearch(rawPath, cwd, absoluteSearchPath);
  const normalizedText = secondSeparator === ':' && lineText.length > 0 && !lineText.startsWith(' ')
    ? ` ${lineText}`
    : lineText;
  return `${normalizedPath}${firstSeparator}${lineNumber}${secondSeparator}${normalizedText}`;
}

function normalizePathForSearch(rawPath: string, cwd: string, absoluteSearchPath: string): string {
  const withoutDot = rawPath.startsWith('./') ? rawPath.slice(2) : rawPath;
  if (!isAbsolute(withoutDot)) return withoutDot.split(sep()).join('/');

  const fromSearchRoot = relative(absoluteSearchPath, withoutDot);
  if (fromSearchRoot && !fromSearchRoot.startsWith('..') && !isAbsolute(fromSearchRoot)) {
    return fromSearchRoot.split(sep()).join('/');
  }

  const fromCwd = relative(cwd, withoutDot);
  if (fromCwd && !fromCwd.startsWith('..') && !isAbsolute(fromCwd)) {
    return fromCwd.split(sep()).join('/');
  }

  return basename(withoutDot);
}

function prepareEditArguments(input: unknown): unknown {
  if (!input || typeof input !== 'object') {
    return input;
  }
  const args = { ...(input as Record<string, unknown>) };
  if (typeof args.edits === 'string') {
    try {
      const parsed = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
    } catch {
      // Leave validation to execute().
    }
  }
  if (typeof args.oldText !== 'string' || typeof args.newText !== 'string') {
    return args;
  }

  const edits = Array.isArray(args.edits) ? [...args.edits] : [];
  edits.push({ oldText: args.oldText, newText: args.newText });
  const { oldText: _oldText, newText: _newText, ...rest } = args;
  return { ...rest, edits };
}

function parseEdits(value: unknown): Array<{ oldText: string; newText: string }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Edit tool input is invalid. edits must contain at least one replacement.');
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`edits[${index}] must be an object.`);
    }
    const edit = entry as Record<string, unknown>;
    return {
      oldText: stringArg(edit.oldText, `edits[${index}].oldText`),
      newText: stringArg(edit.newText, `edits[${index}].newText`),
    };
  });
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : {};
}

function strictRecord(
  value: unknown,
  keys: readonly string[],
  project: (record: Record<string, unknown>) => Record<string, unknown> = record => record,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool input must be an object.');
  }
  const record = { ...(value as Record<string, unknown>) };
  const allowed = new Set(keys);
  const unexpected = Object.keys(record).filter(key => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected tool input properties: ${unexpected.join(', ')}`);
  }
  return project(record);
}

function agentToLocalResult(result: AgentToolResult<any>): LocalToolExecutionResult {
  const text = result.content
    .filter((content): content is { type: 'text'; text: string } => content.type === 'text')
    .map(content => content.text)
    .join('');
  const details = result.details && typeof result.details === 'object'
    ? result.details as Record<string, unknown>
    : undefined;
  const isError = details?.isError === true;
  return {
    content: text,
    isError,
    ...(isError ? { error: text } : {}),
    ...(details ? { structuredContent: details } : {}),
  };
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Missing string argument: ${name}`);
  }
  return value;
}

function pathOrFilePathArg(input: Record<string, unknown>): string {
  return stringArg(input.path ?? input.file_path, 'path or file_path');
}

function stringOptional(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberArg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The model-facing bash `timeout` is MILLISECONDS — Claude's Bash contract,
 * and what live models actually send (CDP pass 12: `timeout: 3000` meant 3s;
 * the previous seconds interpretation produced a 50-minute deadline, so the
 * R10 auto-background never fired). Sub-1000 values are raised to one second
 * so a stray tiny value cannot create an instant deadline.
 */
function millisecondTimeout(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.max(1000, value);
}

function sep(): string {
  return '/';
}
