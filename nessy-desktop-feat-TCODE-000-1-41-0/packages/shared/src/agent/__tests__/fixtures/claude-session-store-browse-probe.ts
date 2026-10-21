/**
 * C3.74 — what the claude runtime's OWN session store holds after a real turn,
 * and what its own readers give back.
 *
 * ## Why a child process, and not an import
 *
 * The same reason P3.269's agreement probe is a child: the SDK's three session
 * readers (`listSessions`, `getSessionInfo`, `getSessionMessages`) resolve their
 * projects root from `process.env.CLAUDE_CONFIG_DIR` at call time through a
 * value-keyed memoize, which is PROCESS-GLOBAL state. This host points each
 * WORKSPACE's child at its own config dir and keeps none on the host process, so
 * a test that set the variable in the shared runner would be mutating a global
 * every other suite in that process shares.
 *
 * ## Why a real turn rather than a host-written transcript
 *
 * P3.269's probe writes the transcript itself, which is exactly right for the
 * question it asks (do the host's derivation and the SDK's locator agree?) and
 * exactly wrong for this one. The row's own done-means asks for "a control that
 * a session created in THIS BUILD appears there" — so this probe spawns the
 * vendored binary against a loopback Anthropic stub and lets the RUNTIME write
 * its own store. No network, no credentials: the SDK speaks Anthropic Messages
 * to whatever `ANTHROPIC_BASE_URL` names.
 *
 * ## AGENTS.md: every side effect behind `import.meta.main`
 *
 * A fixture whose module body runs on import kills the runner at import time and
 * reports exit 0 with zero tests executed. Unconditional, because that failure
 * mode is invisible in the exit status.
 *
 * Prints one JSON line on stdout; every failure is a non-zero exit with the
 * reason on stderr, so the test never has to interpret silence.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

/** The prompt of the first turn — looked for in the store's read-back. */
export const BROWSE_PROBE_PROMPT = 'remember the marker CLAUDE_STORE_PROBE_42';

export interface ClaudeSessionStoreBrowseProbeResult {
  /** The session id the child reported on its first turn's `system`/`init`. */
  createdSessionId: string | null;
  /** Files under the config dir after that turn, relative to it. */
  storeFiles: string[];
  /** LIST — session ids `listSessions({ dir })` returned. */
  listedSessionIds: string[];
  /** LIST — how many the same call returned with no `dir` at all. */
  listedWithoutDir: number;
  /** READ — `getSessionInfo` for the created id: the id it answered, or null. */
  infoSessionId: string | null;
  /** READ — the summary/title the runtime itself derived for the session. */
  infoSummary: string | null;
  /** READ — message count from `getSessionMessages` for the created id. */
  messageCount: number;
  /** READ — whether the first prompt's marker is recoverable from those messages. */
  messagesCarryThePrompt: boolean;
  /** RE-OPEN — the session id the child reported when resumed by that id. */
  reopenedSessionId: string | null;
  /** RE-OPEN — whether the resumed turn put the earlier prompt back on the wire. */
  reopenedRequestCarriesHistory: boolean;
  /** CONTROL — `getSessionInfo` for an id that was never created. */
  unknownIdInfo: string | null;
  /** Which of the store verbs the vendored SDK declares, by name. */
  declaredVerbs: string[];
}

interface StubHandle {
  port: number;
  bodies: string[];
  close: () => Promise<void>;
}

/** A loopback Anthropic Messages endpoint: record the request, answer a canned stream. */
async function startAnthropicStub(): Promise<StubHandle> {
  const bodies: string[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const path = (req.url ?? '').replace(/\?.*$/, '');
    if (req.method === 'POST' && path.endsWith('/messages')) {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const id = `msg_stub_${bodies.length}`;
      const frame = (type: string, data: unknown) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      frame('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
      frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'STUB_OK' } });
      frame('content_block_stop', { type: 'content_block_stop', index: 0 });
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
      frame('message_stop', { type: 'message_stop' });
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `stub: ${path}` } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return { port, bodies, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

/** Every file under `root`, relative to it. */
function treeOf(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
      else found.push(relative);
    }
  };
  walk(root, '');
  return found.sort();
}

export async function runClaudeSessionStoreBrowseProbe(): Promise<ClaudeSessionStoreBrowseProbeResult> {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-c374-cfg-'));
  // Realpathed: on macOS `$TMPDIR` is a symlink into `/private/var/...` and the
  // SDK realpaths the cwd before deriving its project key, so handing the two
  // sides different spellings would make this probe agree with itself for the
  // wrong reason.
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-c374-cwd-')));

  // `delete` first, then assign — AGENTS.md's Bun env rule, applied
  // unconditionally rather than gated on a name list that cannot be complete.
  delete (process.env as Record<string, unknown>).CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;

  const stub = await startAnthropicStub();
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');

    const options = (): Record<string, unknown> => ({
      cwd,
      model: MODEL,
      // Nothing from the developer's own machine may reach this run.
      settingSources: [] as never[],
      permissionMode: 'bypassPermissions' as const,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`,
        ANTHROPIC_API_KEY: 'sk-ant-stub-not-a-real-key',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    });

    const runTurn = async (prompt: string, extra: Record<string, unknown> = {}): Promise<string | null> => {
      let initSessionId: string | null = null;
      for await (const message of sdk.query({ prompt, options: { ...options(), ...extra } as never })) {
        const id = (message as { session_id?: string }).session_id;
        const subtype = (message as { subtype?: string }).subtype;
        if (message.type === 'system' && subtype === 'init' && id) initSessionId = id;
        if (message.type === 'result') break;
      }
      return initSessionId;
    };

    // 1. CREATE — a session made by this build, which is the row's own control.
    const createdSessionId = await runTurn(BROWSE_PROBE_PROMPT);
    const storeFiles = treeOf(configDir);

    // 2. LIST
    const listed = await sdk.listSessions({ dir: cwd });
    const listedWithoutDir = (await sdk.listSessions()).length;

    // 3. READ
    const info = createdSessionId === null
      ? undefined
      : await sdk.getSessionInfo(createdSessionId, { dir: cwd });
    const messages = createdSessionId === null
      ? []
      : await sdk.getSessionMessages(createdSessionId, { dir: cwd });
    const messagesCarryThePrompt = JSON.stringify(messages).includes('CLAUDE_STORE_PROBE_42');

    // CONTROL — an id that was never created must not read back as a session.
    const unknown = await sdk.getSessionInfo('00000000-0000-4000-8000-000000000000', { dir: cwd });

    // 4. RE-OPEN by id, and check the earlier turn reached the model again.
    const bodiesBefore = stub.bodies.length;
    const reopenedSessionId = createdSessionId === null
      ? null
      : await runTurn('what marker did I give you?', { resume: createdSessionId });
    const reopenedRequestCarriesHistory = stub.bodies
      .slice(bodiesBefore)
      .some(body => body.includes('CLAUDE_STORE_PROBE_42'));

    const declaredVerbs = [
      'listSessions', 'getSessionInfo', 'getSessionMessages',
      'deleteSession', 'renameSession', 'tagSession', 'forkSession',
    ].filter(name => typeof (sdk as unknown as Record<string, unknown>)[name] === 'function');

    return {
      createdSessionId,
      storeFiles,
      listedSessionIds: listed.map(entry => entry.sessionId),
      listedWithoutDir,
      infoSessionId: info?.sessionId ?? null,
      infoSummary: info?.summary ?? null,
      messageCount: messages.length,
      messagesCarryThePrompt,
      reopenedSessionId,
      reopenedRequestCarriesHistory,
      unknownIdInfo: unknown?.sessionId ?? null,
      declaredVerbs,
    };
  } finally {
    await stub.close();
  }
}

if (import.meta.main) {
  runClaudeSessionStoreBrowseProbe()
    .then(result => { process.stdout.write(`${JSON.stringify(result)}\n`); })
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(1);
    });
}
