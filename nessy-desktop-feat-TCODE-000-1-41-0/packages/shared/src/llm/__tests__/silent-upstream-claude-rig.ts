/**
 * P6.114 — the rig: a real claude-runtime turn against an upstream that sends
 * SSE headers, one event, and then holds the socket open and SILENT.
 *
 * ## Why a fixture and not a helper inside the test
 *
 * Every side effect here sits behind `import.meta.main` so that importing this
 * module from a test cannot start a server or spawn a child. A fixture whose
 * body ends in a process exit kills the runner at IMPORT time and reports exit 0
 * with ZERO tests executed — a green run that ran nothing (AGENTS.md, measured
 * 2026-09-01). Run one arm directly with `bun <this file> <armName>`.
 *
 * ## PROVENANCE IS ASSERTED, NOT ASSUMED — this cost a whole wrong measurement
 *
 * The first version of this rig lived in a scratch directory OUTSIDE the repo.
 * Bun resolved `@anthropic-ai/claude-agent-sdk` by walking up from the SCRIPT's
 * own directory, found nothing, and auto-installed **0.3.238** out of its global
 * cache. Every arm ran, every arm produced a number, and the numbers described a
 * runtime this tree does not ship. Nothing failed; the run simply measured
 * something else — the same shape as the `node_modules`-symlink trap AGENTS.md
 * records for throwaway worktrees.
 *
 * It was invisible until the stub started logging the child's own `user-agent`,
 * which reads `claude-cli/<cli> (external, sdk-ts, agent-sdk/<sdk>)`. That header
 * is the ONLY witness in the loop that names the artefact, so {@link runArm}
 * captures it and the suite asserts it against the vendored `package.json`
 * before it trusts a single duration. An `env -i` parent did not fix it and was
 * never going to: the cause was module resolution, not environment.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, existsSync, realpathSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

/** A model name is required by the SDK; the stub answers whatever it is handed. */
const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

/** The native binary we VENDOR, so a run measures what we ship. */
export function vendoredClaudeBinary(): string | null {
  const suffix = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const pkg = `claude-agent-sdk-${process.platform}-${arch}`;
  try {
    const require_ = createRequire(import.meta.url);
    const sdkRoot = dirname(require_.resolve('@anthropic-ai/claude-agent-sdk/package.json'));
    const candidate = join(dirname(sdkRoot), pkg, suffix);
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/** `{ sdk, cli }` as the vendored package DECLARES them — the expected provenance. */
export function vendoredVersions(): { sdk: string; cli: string } | null {
  try {
    const require_ = createRequire(import.meta.url);
    const manifest = JSON.parse(
      readFileSync(require_.resolve('@anthropic-ai/claude-agent-sdk/package.json'), 'utf8'),
    ) as { version?: string; claudeCodeVersion?: string };
    if (!manifest.version || !manifest.claudeCodeVersion) return null;
    return { sdk: manifest.version, cli: manifest.claudeCodeVersion };
  } catch {
    return null;
  }
}

interface StubHandle {
  port: number;
  requests: number;
  held: number;
  /** The child's own `user-agent` on its first request — the provenance witness. */
  userAgent: string | null;
  close: () => Promise<void>;
}

/**
 * `hold` — SSE headers, `message_start`, one text delta, then silence with the
 * socket OPEN and never ended. `close` — the same prefix followed by a normal
 * completion, which is the POSITIVE CONTROL that the rig can finish a turn at all.
 */
async function startStub(mode: 'hold' | 'close' | 'headers-hold'): Promise<StubHandle> {
  const state = { requests: 0, held: 0, userAgent: null as string | null };
  const openResponses: ServerResponse[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const path = (req.url ?? '').replace(/\?.*$/, '');
    if (req.method !== 'POST' || !path.endsWith('/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `stub: ${path}` } }));
      return;
    }
    let body: { model?: string } = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body;
    } catch { /* a malformed body is still a request; the count is the signal */ }
    state.requests += 1;
    state.userAgent ??= String(req.headers['user-agent'] ?? '');
    if (mode === 'headers-hold') {
      // THE DISCRIMINATOR: no status line, no headers, ever. If a lever ends
      // THIS turn but not the `hold` one, the lever reaches the child and covers
      // time-to-headers only — which is the `openai`-client shape this repo
      // already documents for Pi. If it ends neither, the lever is not read.
      state.held += 1;
      openResponses.push(res);
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frame = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    frame('message_start', {
      type: 'message_start',
      message: {
        id: `msg_stub_${state.requests}`, type: 'message', role: 'assistant',
        model: body.model ?? MODEL, content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    });
    frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'thinking' } });
    if (mode === 'close') {
      frame('content_block_stop', { type: 'content_block_stop', index: 0 });
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
      frame('message_stop', { type: 'message_stop' });
      res.end();
      return;
    }
    // THE SUBJECT: bytes have flowed, the response is unfinished, and this
    // handler returns without writing or ending. The socket stays open.
    state.held += 1;
    openResponses.push(res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    port: (server.address() as { port: number }).port,
    get requests() { return state.requests; },
    get held() { return state.held; },
    get userAgent() { return state.userAgent; },
    close: () => new Promise<void>(resolve => {
      for (const held of openResponses) held.destroy();
      server.close(() => resolve());
    }),
  } as StubHandle;
}

export interface ArmResult {
  arm: string;
  /** Wall-clock to the turn ending, or `null` when the budget ran out first. */
  endedAfterMs: number | null;
  ended: 'result' | 'throw' | 'budget-exhausted';
  detail: string;
  requests: number;
  held: number;
  /** From the `system/init` message — what the CHILD says it is. */
  version: string | null;
  /** From the first upstream request — what the CLIENT says it is. */
  userAgent: string | null;
}

export async function runArm(
  arm: string,
  stubMode: 'hold' | 'close' | 'headers-hold',
  extraEnv: Record<string, string>,
  budgetMs: number,
): Promise<ArmResult> {
  const stub = await startStub(stubMode);
  const configDir = mkdtempSync(join(tmpdir(), 'p6114-cfg-'));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'p6114-cwd-')));
  const sdk = await import('@anthropic-ai/claude-agent-sdk');

  // Every CLAUDE*/ANTHROPIC*/API_* key is dropped before this arm's own
  // overrides go on: the run may itself sit inside a Claude Code session, whose
  // env would otherwise set feature flags on the child. (It does NOT protect
  // against the resolution trap in the docblock — only the asserted user-agent
  // does.)
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC|API_)/i.test(key)),
  ) as Record<string, string>;

  const started = Date.now();
  let ended: ArmResult['ended'] = 'budget-exhausted';
  let detail = '';
  let version: string | null = null;

  const query = sdk.query({
    prompt: 'say hello',
    options: {
      cwd,
      model: MODEL,
      settingSources: [],
      permissionMode: 'default',
      pathToClaudeCodeExecutable: vendoredClaudeBinary() ?? undefined,
      env: {
        ...inherited,
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`,
        ANTHROPIC_API_KEY: 'not-needed',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ...extraEnv,
      },
    } as never,
  });

  const drain = (async () => {
    try {
      for await (const message of query) {
        const typed = message as { type: string; subtype?: string; result?: unknown; is_error?: boolean; claude_code_version?: string };
        if (typed.type === 'system' && typed.subtype === 'init') version = typed.claude_code_version ?? null;
        if (typed.type === 'result') {
          ended = 'result';
          detail = JSON.stringify({
            subtype: typed.subtype,
            is_error: typed.is_error,
            result: String(typed.result ?? '').slice(0, 300),
          });
          return;
        }
      }
      ended = 'result';
      detail = 'stream ended with no result message';
    } catch (error) {
      ended = 'throw';
      detail = String(error).slice(0, 500);
    }
  })();

  await Promise.race([drain, new Promise<void>(resolve => setTimeout(resolve, budgetMs))]);
  const result: ArmResult = {
    arm,
    endedAfterMs: ended === 'budget-exhausted' ? null : Date.now() - started,
    ended,
    detail,
    requests: stub.requests,
    held: stub.held,
    version,
    userAgent: stub.userAgent,
  };
  try {
    await (query as unknown as { interrupt?: () => Promise<void> }).interrupt?.();
  } catch { /* the child may already be gone; the arm's verdict is already taken */ }
  await stub.close();
  return result;
}

/** Named arms, so a manual run and the suite drive the same definitions. */
export const ARMS = {
  /** POSITIVE CONTROL: the same stub closing normally must complete the turn. */
  control_close: (budgetMs = 120_000) => runArm('control_close', 'close', {}, budgetMs),
  /** POSITIVE CONTROL that the rig can observe a native abort at all. */
  timeout_8s: (budgetMs = 90_000) => runArm('timeout_8s', 'hold', { API_TIMEOUT_MS: '8000' }, budgetMs),
  /** The same, given room for the undocumented 600 s ceiling to fire instead. */
  timeout_8s_long: (budgetMs = 700_000) => runArm('timeout_8s_long', 'hold', { API_TIMEOUT_MS: '8000' }, budgetMs),
  /** Bounded observation of the DEFAULT. */
  default_bounded: (budgetMs = 60_000) => runArm('default_bounded', 'hold', {}, budgetMs),
  /** The full default arm — the honest hypothesis was ~600 s. */
  default_full: (budgetMs = 780_000) => runArm('default_full', 'hold', {}, budgetMs),
  /** The byte watchdog forced ON, with its own deadline set small. */
  watchdog_on: (budgetMs = 120_000) => runArm(
    'watchdog_on', 'hold',
    { CLAUDE_ENABLE_BYTE_WATCHDOG: '1', CLAUDE_STREAM_IDLE_TIMEOUT_MS: '10000' },
    budgetMs,
  ),
  /** DISCRIMINATOR: does `API_TIMEOUT_MS` reach the child at all? */
  headers_hold_8s: (budgetMs = 90_000) => runArm('headers_hold_8s', 'headers-hold', { API_TIMEOUT_MS: '8000' }, budgetMs),
  /** Its own control: the same stub with no lever set. */
  headers_hold_default: (budgetMs = 90_000) => runArm('headers_hold_default', 'headers-hold', {}, budgetMs),
  /** `API_FORCE_IDLE_TIMEOUT`, the other lever named in the transport predicate. */
  force_idle_timeout: (budgetMs = 120_000) => runArm(
    'force_idle_timeout', 'hold',
    { API_TIMEOUT_MS: '8000', API_FORCE_IDLE_TIMEOUT: '1' },
    budgetMs,
  ),
} satisfies Record<string, (budgetMs?: number) => Promise<ArmResult>>;

if (import.meta.main) {
  const name = process.argv[2] ?? 'control_close';
  const arm = (ARMS as Record<string, ((budgetMs?: number) => Promise<ArmResult>) | undefined>)[name];
  if (!arm) {
    console.error(`unknown arm ${name}; have ${Object.keys(ARMS).join(', ')}`);
    process.exit(2);
  }
  const budget = process.argv[3] ? Number(process.argv[3]) : undefined;
  console.log(JSON.stringify(await arm(budget)));
  process.exit(0);
}
