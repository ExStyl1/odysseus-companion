/**
 * C3.270 + C3.275 — does anything on a claude session ever produce a
 * `Notification`, and on which channel?
 *
 * ## The two questions, which are one measurement
 *
 * C3.270 asks whether the HOST needs code: the SDK declares `Notification` in
 * its `HookEvent` union and this fork already registers a matcher for whatever
 * events a user's automations config names (`buildSdkHooksForConfig`,
 * `plugins/hooks-automation.ts`), so a user's `Notification` automation is
 * already wired — IF the child ever calls it. C3.275 asks the producer question
 * from the other side: C3.94's rig never provoked one, and it refused to infer a
 * verdict from silence. Both are answered by one run that provokes and watches.
 *
 * ## Three channels are watched at once, because they are not the same thing
 *
 *  - the child's OWN settings tier — a `Notification` command hook in
 *    `<CLAUDE_CONFIG_DIR>/settings.json`, which writes its stdin to a file. This
 *    is the population the host's plumbing never sees, and the one C3.94 proved
 *    matters for `SessionStart`;
 *  - the SDK CALLBACK — `Options.hooks.Notification`, the exact shape
 *    `buildSdkHooksForConfig` produces. This is the channel a Nessy automation
 *    would ride;
 *  - the MESSAGE stream — `SDKNotificationMessage` (`type: 'system'`,
 *    `subtype: 'notification'`), which is a DIFFERENT surface and which this
 *    fork already consumes (`backend/claude/event-adapter.ts` turns it into an
 *    `info` event). Watched so a "nothing arrived" verdict cannot be an artefact
 *    of looking at the wrong channel.
 *
 * ## The arms
 *
 *  - `permission` — the stub asks for a `Write` inside the cwd, which needs
 *    approval in `default` mode, and the callback holds its answer for two
 *    seconds before allowing. The documented type for this is
 *    `permission_prompt`, *"Claude needs you to approve a tool use"*;
 *  - `idle` — streaming input mode with the input generator held open after the
 *    turn settles, which is what `idle_prompt` describes: *"Claude is done and
 *    waiting for your next prompt"*;
 *  - `control` — the same rig, one plain turn, nothing provoked. Without it a
 *    firing on either arm above could be the session start rather than the
 *    provocation.
 *
 * ## The rig
 *
 * Offline, on the pattern `claude-permission-update-probe.ts` established: the
 * SDK speaks Anthropic Messages to whatever `ANTHROPIC_BASE_URL` names, so the
 * upstream is a scripted loopback stub. No network and NO CREDENTIALS — the
 * gateway's own card is not driven here, deliberately: the question is about the
 * runtime's notification machinery, which a real upstream would not change, and
 * a rig that reads a credential to answer it would be spending a secret for
 * nothing.
 *
 * A CHILD PROCESS, because the SDK's session readers key on
 * `process.env.CLAUDE_CONFIG_DIR` and that is process-global in a shared runner.
 *
 * AGENTS.md: every side effect is behind `import.meta.main`, or a fixture
 * imported by a test kills the runner at import time and reports exit 0 with
 * zero tests executed.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODEL = 'claude-sonnet-4-5';

export type NotificationArm = 'control' | 'permission' | 'idle';

export interface ClaudeNotificationProbeResult {
  arm: NotificationArm;
  /** Payloads the child's OWN settings-tier `Notification` hook wrote, in order. */
  settingsHookPayloads: string[];
  /** `notification_type` of every SDK-callback `Notification` invocation, in order. */
  sdkHookTypes: string[];
  /** Raw inputs the SDK callback received, so an unexpected shape is reported rather than lost. */
  sdkHookInputs: string[];
  /** `key`/`text`/`priority` of every `system`/`notification` message on the stream. */
  notificationMessages: Array<{ key: string; text: string; priority: string }>;
  /** Every OTHER `system` subtype seen, deduplicated — the "were we watching the right channel" control. */
  systemSubtypes: string[];
  /**
   * POSITIVE CONTROL, settings tier: payloads a `SessionStart` command hook
   * declared in the SAME settings file wrote. An absence finding needs a control
   * on the same rig (AGENTS.md), or "nothing fired" cannot be told apart from
   * "hooks do not work here".
   */
  controlSettingsHookPayloads: string[];
  /** POSITIVE CONTROL, SDK callback: events an `Options.hooks` callback received on the same run. */
  controlSdkHookEvents: string[];
  /** Tool names `canUseTool` was consulted about, in order. */
  canUseToolCalls: string[];
  /** How many requests the stub served. */
  requests: number;
  /** The `result` message's subtype, or null if the turn never produced one. */
  resultSubtype: string | null;
  /** The version the child reported about itself, so the reading carries its subject. */
  version: string | null;
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
 * The scripted upstream. On the `permission` arm the first request answers with
 * a `Write` call; every other request answers plain text and ends the turn.
 */
async function startScriptedStub(wantsTool: boolean, writePath: string): Promise<StubHandle> {
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
    if (wantsTool && turn === 1) {
      // `Write` rather than `Bash`: a measured choice. The first run of this rig
      // asked for `Bash(echo c3270)` and `canUseTool` was never consulted at all
      // — the runtime's own safe-command handling answers a read-only `echo`
      // without an approval, so the arm measured the command's harmlessness
      // instead of the notification machinery. `Write` inside the cwd is the
      // call `claude-permission-update-probe.ts` already proved reaches the
      // callback in `default` mode.
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_c3270_write', name: 'Write', input: {} } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: writePath, content: 'c3270\n' }) } });
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } });
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

/**
 * The child's own USER tier. The matcher is OMITTED on purpose: `Notification`
 * matches on `notification_type`, and this probe must not presuppose which type
 * a provocation produces — a matcher naming one would turn "the wrong guess"
 * into "the event never fired".
 */
function writeSettingsTierHook(configDir: string, markerDir: string, controlDir: string): void {
  mkdirSync(markerDir, { recursive: true });
  mkdirSync(controlDir, { recursive: true });
  const script = join(configDir, 'record-notification.sh');
  // The hook's JSON input arrives on stdin; a unique filename per firing keeps
  // several firings from overwriting one another.
  writeFileSync(
    script,
    '#!/bin/sh\ncat > "$1/hook-$$-$(date +%s%N).json"\n',
    { encoding: 'utf8', mode: 0o755 },
  );
  const record = (dir: string) => ({
    hooks: [{ type: 'command', command: `${JSON.stringify(script)} ${JSON.stringify(dir)}` }],
  });
  writeFileSync(
    join(configDir, 'settings.json'),
    JSON.stringify({
      hooks: {
        Notification: [record(markerDir)],
        // The control, in the SAME file and through the SAME script: a
        // `SessionStart` hook fires on every arm, so a run where the control is
        // silent is a broken rig rather than a finding.
        SessionStart: [record(controlDir)],
      },
    }, null, 2),
    'utf8',
  );
}

function readMarkers(markerDir: string): string[] {
  if (!existsSync(markerDir)) return [];
  return readdirSync(markerDir)
    .filter(entry => entry.endsWith('.json'))
    .sort()
    .map(entry => readFileSync(join(markerDir, entry), 'utf8'));
}

export async function runClaudeNotificationProbe(arm: NotificationArm): Promise<ClaudeNotificationProbeResult> {
  const configDir = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-c3270-cfg-')));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-c3270-cwd-')));
  const markerDir = join(configDir, 'notifications');
  const controlDir = join(configDir, 'control-session-start');
  writeSettingsTierHook(configDir, markerDir, controlDir);

  delete (process.env as Record<string, unknown>).CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;

  const stub = await startScriptedStub(arm === 'permission', join(cwd, 'c3270.txt'));
  const result: ClaudeNotificationProbeResult = {
    arm,
    settingsHookPayloads: [],
    sdkHookTypes: [],
    sdkHookInputs: [],
    notificationMessages: [],
    systemSubtypes: [],
    controlSettingsHookPayloads: [],
    controlSdkHookEvents: [],
    canUseToolCalls: [],
    requests: 0,
    resultSubtype: null,
    version: null,
    threw: null,
  };

  // Streaming input mode is what `idle_prompt` needs — a session that is done
  // and still listening. `sdk.d.ts`: `Query.interrupt` is "Only available in
  // streaming input mode", the same distinction.
  // Initialised with a no-op rather than `null`: TypeScript's control-flow
  // analysis does not see the assignment inside the executor, so a nullable
  // binding narrows to `null` and every later call site becomes `never`.
  let releaseInput: () => void = () => {};
  const inputClosed = new Promise<void>(resolve => { releaseInput = resolve; });
  async function* streamingPrompt(): AsyncGenerator<Record<string, unknown>> {
    yield {
      type: 'user',
      message: { role: 'user', content: 'say done' },
      parent_tool_use_id: null,
      session_id: '',
    };
    await inputClosed;
  }

  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const query = sdk.query({
      prompt: (arm === 'idle' ? streamingPrompt() : 'say done') as never,
      options: {
        cwd,
        model: MODEL,
        // The child reads its own tiers — the settings-tier arm's whole point.
        settingSources: ['user', 'project', 'local'],
        permissionMode: 'default' as const,
        hooks: {
          Notification: [{
            hooks: [async (input: Record<string, unknown>) => {
              result.sdkHookInputs.push(JSON.stringify(input));
              const type = input.notification_type;
              result.sdkHookTypes.push(typeof type === 'string' ? type : '<no notification_type>');
              return {};
            }],
          }],
          // The SDK-callback controls, registered in the same object and in the
          // same shape `buildSdkHooksForConfig` produces. TWO of them, because
          // the first run of this rig showed `SessionStart` alone is not a
          // control: it never fired on any arm, while the settings-tier
          // `SessionStart` hook in the same run did — the session has already
          // started by the time a consumer's callbacks are registered. The
          // `PreToolUse` control is the one this fork depends on in production
          // (`runPreToolUseChecks` is reached through exactly this channel), and
          // it fires mid-turn, which is when a `Notification` would.
          SessionStart: [{
            hooks: [async (input: Record<string, unknown>) => {
              result.controlSdkHookEvents.push(String(input.hook_event_name ?? 'SessionStart'));
              return {};
            }],
          }],
          PreToolUse: [{
            hooks: [async (input: Record<string, unknown>) => {
              result.controlSdkHookEvents.push(String(input.hook_event_name ?? 'PreToolUse'));
              return {};
            }],
          }],
        },
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: configDir,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`,
          ANTHROPIC_API_KEY: 'sk-ant-stub-not-a-real-key',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        canUseTool: async (toolName: string, input: Record<string, unknown>) => {
          result.canUseToolCalls.push(toolName);
          // Held, because a notification about a pending approval can only be
          // sent while the approval is pending.
          await new Promise<void>(resolve => setTimeout(resolve, 2000));
          return { behavior: 'allow' as const, updatedInput: input };
        },
      } as never,
    });

    for await (const message of query) {
      const typed = message as { type: string; subtype?: string; claude_code_version?: string; key?: string; text?: string; priority?: string };
      if (typed.type === 'system') {
        if (typed.subtype === 'init') result.version = typed.claude_code_version ?? null;
        if (typed.subtype === 'notification') {
          result.notificationMessages.push({
            key: typed.key ?? '',
            text: typed.text ?? '',
            priority: typed.priority ?? '',
          });
        } else if (typed.subtype && !result.systemSubtypes.includes(typed.subtype)) {
          result.systemSubtypes.push(typed.subtype);
        }
      }
      if (typed.type === 'result') {
        result.resultSubtype = typed.subtype ?? null;
        if (arm !== 'idle') break;
        // The idle arm keeps listening: the turn is settled and the session is
        // still open, which is the state `idle_prompt` describes.
        setTimeout(() => releaseInput(), 10_000);
      }
    }
  } catch (error) {
    result.threw = error instanceof Error ? error.message : String(error);
  } finally {
    releaseInput();
    await stub.close();
  }

  // A hook is a subprocess: give it a bounded moment after the stream ends
  // rather than reading the marker directory the instant the turn settles.
  for (let attempt = 0; attempt < 20 && readMarkers(controlDir).length === 0; attempt++) {
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  }
  result.settingsHookPayloads = readMarkers(markerDir);
  result.controlSettingsHookPayloads = readMarkers(controlDir);
  result.requests = stub.bodies.length;
  return result;
}

if (import.meta.main) {
  const arm = (process.argv[2] ?? 'control') as NotificationArm;
  runClaudeNotificationProbe(arm)
    .then(result => { process.stdout.write(`${JSON.stringify(result)}\n`); })
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(1);
    });
}
