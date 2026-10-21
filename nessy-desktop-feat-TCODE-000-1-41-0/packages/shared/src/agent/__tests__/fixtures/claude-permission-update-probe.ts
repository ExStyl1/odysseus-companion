/**
 * C3.7 / C3.85 — what the claude runtime does with a `PermissionUpdate` returned
 * from `canUseTool`, per kind and per destination.
 *
 * ## Why this exists
 *
 * `sdk.d.ts` declares six update kinds (`addRules`, `replaceRules`,
 * `removeRules`, `setMode`, `addDirectories`, `removeDirectories`) and five
 * destinations (`userSettings`, `projectSettings`, `localSettings`, `session`,
 * `cliArg`), returnable as `PermissionResult.updatedPermissions` from the
 * callback this fork already implements. A TYPE IS NOT A BEHAVIOUR: ledger rows
 * A62 and G8 both rest on what the runtime does with one, and nobody had asked
 * the binary.
 *
 * ## The rig
 *
 * Offline, on the pattern `claude-transcript-resume-e2e.test.ts` established:
 * the SDK speaks Anthropic Messages to whatever `ANTHROPIC_BASE_URL` names, so
 * the upstream is a scripted loopback stub. No network, no credentials. The stub
 * drives a THREE-REQUEST turn, because a mid-turn grant needs something to hang
 * off:
 *
 *   request 1 (the user prompt)  -> a `Write` tool call inside the cwd, which
 *                                   requires approval in `default` mode and so
 *                                   reaches `canUseTool` — this is where the
 *                                   update is returned;
 *   request 2 (its tool result)  -> a `Read` tool call on a file OUTSIDE the
 *                                   working directory, which requires approval
 *                                   unless a directory grant has landed;
 *   request 3 (its tool result)  -> plain text, ending the turn.
 *
 * The discriminant is therefore not a type check but a COUNT: was `canUseTool`
 * consulted for the second call? If the grant applied to the running turn, the
 * outside read resolves at the allow-rules step and the callback never sees it.
 *
 * ## Why a child process
 *
 * The turn writes into a temp cwd and reads a temp directory outside it, and the
 * SDK's own session readers key on `process.env.CLAUDE_CONFIG_DIR`. Both are
 * process-global concerns in a shared runner; a child is the honest rig, the
 * same reason P3.269's agreement probe is one.
 *
 * ## AGENTS.md: every side effect behind `import.meta.main`
 *
 * A fixture whose module body runs on import kills the runner at import time and
 * reports exit 0 with zero tests executed.
 *
 * Prints one JSON line on stdout; a failure is a non-zero exit with the reason
 * on stderr, so the test never has to interpret silence.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

/** Lives only in the file OUTSIDE the working directory. */
export const OUTSIDE_MARKER = 'OUTSIDE_DIR_MARKER_C37';

/** The five destinations `PermissionUpdateDestination` declares, plus the no-update control. */
export type PermissionUpdateArm =
  | 'none'
  | 'session'
  | 'projectSettings'
  | 'localSettings'
  | 'userSettings'
  | 'cliArg';

/**
 * C3.85 — the six kinds `PermissionUpdate` declares. `addDirectories` is the
 * default because C3.7's question is about it; the other five exist so the
 * destination matrix can ask "who wrote what" of each.
 */
export type PermissionUpdateKind =
  | 'addRules'
  | 'replaceRules'
  | 'removeRules'
  | 'setMode'
  | 'addDirectories'
  | 'removeDirectories';

export interface ClaudePermissionUpdateProbeResult {
  arm: PermissionUpdateArm;
  /** Which of the six kinds was returned (meaningless on the `none` arm). */
  kind: PermissionUpdateKind;
  /** Tool names `canUseTool` was consulted about, in order. */
  canUseToolCalls: string[];
  /**
   * C3.312 — the runtime's OWN `suggestions` for each consultation, in the same
   * order as {@link canUseToolCalls}.
   *
   * The SDK documents this array as the mechanism behind an "always allow"
   * button: *"Suggestions for updating permissions so that the user will not be
   * prompted again for this tool during this session. Typically if presenting
   * the user an option 'always allow' or similar, then this full set of
   * suggestions should be returned as the `updatedPermissions` in the
   * PermissionResult."* C3.278 built the seam that echoes them and C3.279 the
   * boundary that vets them; neither could say WHICH CALLS actually carry any,
   * and a remember button offered for a call with no suggestion would promise
   * what this fork then cannot deliver. So the probe records them.
   *
   * `null` for a consultation where the option was absent altogether, which is a
   * different reading from an empty array.
   */
  offeredSuggestions: (unknown[] | null)[];
  /**
   * Whether the callback was consulted about the OUTSIDE read. `false` with the
   * read still happening is the signature of a grant that applied mid-turn.
   */
  askedAboutTheOutsideRead: boolean;
  /** Whether the outside file's marker reached the model on a later request. */
  outsideReadReachedTheModel: boolean;
  /** How many requests the stub served — 3 means the scripted turn ran whole. */
  requests: number;
  /** The `result` message's subtype, or null if the turn never produced one. */
  resultSubtype: string | null;
  /** Settings files that exist after the turn, and their contents. */
  settingsFiles: Record<string, string>;
  /** Whether any settings file mentions the outside directory. */
  someSettingsFileNamesTheDirectory: boolean;
  /** An error the SDK surfaced for the update itself, if any. */
  threw: string | null;
}

interface StubHandle {
  port: number;
  bodies: string[];
  close: () => Promise<void>;
}

function sse(res: ServerResponse, type: string, data: unknown): void {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * The scripted upstream. Request 1 asks for `Write`, request 2 for `Read` of the
 * outside path, request 3 and beyond answer plain text.
 */
async function startScriptedStub(input: {
  writePath: string;
  outsidePath: string;
}): Promise<StubHandle> {
  const bodies: string[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const path = (req.url ?? '').replace(/\?.*$/, '');
    if (!(req.method === 'POST' && path.endsWith('/messages'))) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `stub: ${path}` } }));
      return;
    }
    bodies.push(Buffer.concat(chunks).toString('utf8'));
    const turn = bodies.length;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    sse(res, 'message_start', { type: 'message_start', message: { id: `msg_stub_${turn}`, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });

    const toolCall = (id: string, name: string, args: unknown): void => {
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } });
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } });
    };

    if (turn === 1) {
      toolCall('toolu_c37_write', 'Write', { file_path: input.writePath, content: 'scratch\n' });
    } else if (turn === 2) {
      toolCall('toolu_c37_read', 'Read', { file_path: input.outsidePath });
    } else {
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'STUB_DONE' } });
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
    }
    sse(res, 'message_stop', { type: 'message_stop' });
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return { port, bodies, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

/** Settings files the SDK could have written, read back as text. */
function collectSettings(cwd: string, configDir: string): Record<string, string> {
  const candidates: Array<[string, string]> = [
    ['cwd/.claude/settings.json', join(cwd, '.claude', 'settings.json')],
    ['cwd/.claude/settings.local.json', join(cwd, '.claude', 'settings.local.json')],
    ['configDir/settings.json', join(configDir, 'settings.json')],
    ['configDir/settings.local.json', join(configDir, 'settings.local.json')],
  ];
  const found: Record<string, string> = {};
  for (const [label, path] of candidates) {
    if (existsSync(path)) found[label] = readFileSync(path, 'utf8');
  }
  // Anything else that turned up directly under `<cwd>/.claude`, so a file we
  // did not think to name is still reported rather than silently missed.
  const dotClaude = join(cwd, '.claude');
  if (existsSync(dotClaude)) {
    for (const entry of readdirSync(dotClaude)) {
      const label = `cwd/.claude/${entry}`;
      if (found[label] === undefined && entry.endsWith('.json')) {
        found[label] = readFileSync(join(dotClaude, entry), 'utf8');
      }
    }
  }
  return found;
}

/**
 * The update returned for one (kind, destination) pair.
 *
 * The values are deliberately harmless and NAMED so a write is identifiable in
 * a settings file: a `Bash(echo c385:*)` rule, `acceptEdits` for `setMode`, and
 * the probe's own outside directory. `removeRules` / `removeDirectories` are
 * asked to remove something that was never added — the question this matrix asks
 * is who performs the write and whether the child accepts the entry, not whether
 * a removal removed anything.
 */
function updateFor(
  kind: PermissionUpdateKind,
  destination: Exclude<PermissionUpdateArm, 'none'>,
  outsideDir: string,
  /**
   * `setMode`'s mode. `acceptEdits` is the matrix default because it is a real
   * widening that is not the extreme one; `bypassPermissions` is the arm the
   * host's own Pi-side boundary refuses outright, so it is askable separately
   * rather than assumed.
   */
  mode = 'acceptEdits',
): Record<string, unknown> {
  switch (kind) {
    case 'addRules':
    case 'replaceRules':
    case 'removeRules':
      return { type: kind, rules: [{ toolName: 'Bash', ruleContent: 'echo c385:*' }], behavior: 'allow', destination };
    case 'setMode':
      return { type: 'setMode', mode, destination };
    default:
      return { type: kind, directories: [outsideDir], destination };
  }
}

export async function runClaudePermissionUpdateProbe(
  arm: PermissionUpdateArm,
  kind: PermissionUpdateKind = 'addDirectories',
  mode = 'acceptEdits',
): Promise<ClaudePermissionUpdateProbeResult> {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-c37-cfg-'));
  // Realpathed on both sides: on macOS `$TMPDIR` is a symlink into
  // `/private/var/...`, and a grant naming the un-realpathed spelling would be
  // compared against the realpathed one.
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-c37-cwd-')));
  const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-c37-outside-')));
  const outsidePath = join(outsideDir, 'secret.txt');
  writeFileSync(outsidePath, `${OUTSIDE_MARKER}\n`);

  delete (process.env as Record<string, unknown>).CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;

  const stub = await startScriptedStub({ writePath: join(cwd, 'scratch.txt'), outsidePath });
  const canUseToolCalls: string[] = [];
  const offeredSuggestions: (unknown[] | null)[] = [];
  let threw: string | null = null;
  let resultSubtype: string | null = null;

  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');

    const update = arm === 'none' ? [] : [updateFor(kind, arm, outsideDir, mode)];

    for await (const message of sdk.query({
      prompt: 'write the scratch file, then read the outside file',
      options: {
        cwd,
        model: MODEL,
        // Nothing from the developer's own machine may reach this run, and
        // `default` is the mode whose approvals this probe is about.
        settingSources: [] as never[],
        permissionMode: 'default' as const,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: configDir,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`,
          ANTHROPIC_API_KEY: 'sk-ant-stub-not-a-real-key',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        canUseTool: async (
          toolName: string,
          input: Record<string, unknown>,
          options?: { suggestions?: unknown[] },
        ) => {
          canUseToolCalls.push(toolName);
          // C3.312 — read off the callback's OWN third argument, never inferred.
          offeredSuggestions.push(Array.isArray(options?.suggestions) ? options.suggestions : null);
          // The update rides on the FIRST consultation only — the one the real
          // product would attach a user's "allow this directory" answer to.
          const attach = canUseToolCalls.length === 1 && update.length > 0;
          return attach
            ? { behavior: 'allow' as const, updatedInput: input, updatedPermissions: update }
            : { behavior: 'allow' as const, updatedInput: input };
        },
      } as never,
    })) {
      const subtype = (message as { subtype?: string }).subtype;
      if (message.type === 'result') { resultSubtype = subtype ?? null; break; }
    }
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  } finally {
    await stub.close();
  }

  const settingsFiles = collectSettings(cwd, configDir);
  return {
    arm,
    kind,
    canUseToolCalls,
    offeredSuggestions,
    askedAboutTheOutsideRead: canUseToolCalls.slice(1).includes('Read'),
    outsideReadReachedTheModel: stub.bodies.slice(2).some(body => body.includes(OUTSIDE_MARKER)),
    requests: stub.bodies.length,
    resultSubtype,
    settingsFiles,
    someSettingsFileNamesTheDirectory: Object.values(settingsFiles).some(body => body.includes(outsideDir)),
    threw,
  };
}

if (import.meta.main) {
  const requested = (process.argv[2] ?? 'session') as PermissionUpdateArm;
  const kind = (process.argv[3] ?? 'addDirectories') as PermissionUpdateKind;
  const mode = process.argv[4] ?? 'acceptEdits';
  runClaudePermissionUpdateProbe(requested, kind, mode)
    .then(result => { process.stdout.write(`${JSON.stringify(result)}\n`); })
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(1);
    });
}
