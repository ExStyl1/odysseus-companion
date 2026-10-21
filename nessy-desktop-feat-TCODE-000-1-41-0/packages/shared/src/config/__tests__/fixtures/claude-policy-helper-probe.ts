/**
 * P6.73 — does the vendored SDK SPAWN an administrator-placed `policyHelper` we
 * neither configure nor suppress?
 *
 * ## Why this is a question at all
 *
 * The shipped SDK declares the key — `sdk.mjs` carries
 * `policyHelper=st((b)=>{…})` with the describe *"Executable that computes
 * managed settings at startup. Honored only from admin-controlled policy
 * sources."* — and the native binary carries `policyHelper`,
 * `managed-settings.json`, `/Library/Application Support/ClaudeCode` and
 * `/etc/claude-code`. Our own managed floor is passed PROGRAMMATICALLY
 * (`Options.managedSettings`) and our `settingSources` names no managed tier, so
 * nothing in this repo either configures the helper or suppresses it. Standing
 * ruling R50 covers what WE build, not what the shipped SDK executes.
 *
 * ## The rig, and its observable
 *
 * `CLAUDE_CODE_MANAGED_SETTINGS_PATH` is a real env var in the shipped binary and
 * the row's premise was that it takes a DIRECTORY (the binary sets it on its own
 * children as `CLAUDE_CODE_MANAGED_SETTINGS_PATH:t.configDir`). Both spellings
 * are driven here, directory and file, because that premise turned out to matter.
 *
 * TWO stub upstreams run, A and B. The arm's managed settings try to move the
 * child from A to B by declaring an `env` block that rewrites
 * `ANTHROPIC_BASE_URL`. **Which stub received the request is the observable** —
 * it needs no parsing, no log, and no cooperation from the child.
 *
 * ## THE RESULT: INCONCLUSIVE ON THE SPAWN, AND THE REASON IS MEASURED
 *
 * Measured 2026-09-05 on the vendored 2.1.233 / agent-sdk 0.3.233 (asserted from
 * the child's own `user-agent`). No arm ever wrote the marker — and **that is not
 * evidence of anything**, because the row's own control (d) fails: a plain
 * managed key delivered through this env var does not apply either.
 *
 * | arm | marker | A | B | result |
 * | --- | --- | --- | --- | --- |
 * | `no-managed` | no | 1 | 0 | success |
 * | `managed-env-only` | no | 1 | 0 | success — the redirect did NOT take |
 * | `helper` | no | 1 | 0 | success |
 * | `helper-nonzero` | no | 1 | 0 | success |
 * | `managed-supplies-baseurl` (dir) | no | **0** | 0 | `Not logged in · Please run /login` |
 * | `managed-supplies-baseurl-file` | no | **0** | 0 | same |
 * | `managed-supplies-baseurl-sources` | no | **0** | 0 | same |
 * | `managed-unparseable` | no | 1 | 0 | success, and **no complaint at all** |
 *
 * TWO INDEPENDENT CONTROLS AGREE THAT THE FILE IS NEVER OPENED. When the managed
 * `env` block is the ONLY source of `ANTHROPIC_BASE_URL`, the child does not
 * reach either stub and asks the user to log in — under the directory spelling,
 * the file spelling, and with `settingSources` both empty and fully loaded. And a
 * document that is not JSON produces no diagnostic and no behaviour change,
 * although `managed-settings.md#invalid-entries-in-managed-settings` documents
 * that Claude Code reports invalid entries.
 *
 * So the honest verdict is **not** *"the SDK does not spawn an
 * administrator-placed `policyHelper`"*. It is *"a `managed-settings.json`
 * reached through `CLAUDE_CODE_MANAGED_SETTINGS_PATH` has no effect on an
 * SDK-spawned child at all — neither a helper nor a plain key — so this rig
 * cannot see the spawn"*. Recording the absence would have been a false
 * negative, which is exactly what control (d) exists to prevent.
 *
 * The real administrator locations the binary names
 * (`/Library/Application Support/ClaudeCode`, `/etc/claude-code`) are system
 * paths and are deliberately NOT written by this probe.
 *
 * Every side effect is behind `import.meta.main`: a fixture whose module body
 * exits kills the runner at import time and reports exit 0 with ZERO tests
 * executed (AGENTS.md, measured 2026-09-01).
 *
 * ## Provenance is asserted, not assumed
 *
 * The child's `user-agent` is captured on the first request and checked against
 * the vendored `package.json`. A sibling rig in this tree measured a runtime the
 * repo does not ship, silently, because Bun auto-installed a different version
 * for a script that lived outside the repo — see
 * `llm/__tests__/silent-upstream-claude-rig.ts`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

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

export interface StubHandle {
  port: number;
  requests: number;
  userAgent: string | null;
  close: () => Promise<void>;
}

/**
 * An Anthropic Messages endpoint that answers every request with one word.
 *
 * Exported since P6.72, whose claude arm needs the same stub upstream and the
 * same provenance witness: two copies of this would be two chances to measure a
 * different artefact than the one this repo ships.
 */
export async function startStub(): Promise<StubHandle> {
  const state = { requests: 0, userAgent: null as string | null };
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
    } catch { /* still a request */ }
    state.requests += 1;
    state.userAgent ??= String(req.headers['user-agent'] ?? '');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frame = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    frame('message_start', {
      type: 'message_start',
      message: {
        id: `msg_${state.requests}`, type: 'message', role: 'assistant',
        model: body.model ?? MODEL, content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    });
    frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } });
    frame('content_block_stop', { type: 'content_block_stop', index: 0 });
    frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
    frame('message_stop', { type: 'message_stop' });
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    port: (server.address() as { port: number }).port,
    get requests() { return state.requests; },
    get userAgent() { return state.userAgent; },
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); }),
  } as StubHandle;
}

export type PolicyHelperArm =
  /** No managed directory at all. The baseline: the request must land on A. */
  | 'no-managed'
  /** POSITIVE CONTROL (d): a plain `env` block in the file, no helper. */
  | 'managed-env-only'
  /** The subject: a helper that writes a marker AND prints the same `env` block. */
  | 'helper'
  /** Separates "unread" from "read and tolerated": the helper exits non-zero. */
  | 'helper-nonzero'
  /**
   * The control the first four needed and did not have. Instead of asking the
   * managed `env` block to OVERRIDE a variable we already set — which a merge
   * may legitimately refuse — it is the ONLY source of `ANTHROPIC_BASE_URL`. If
   * the request still lands on A, the channel works; if it does not, nothing
   * about the helper can be concluded from silence.
   */
  | 'managed-supplies-baseurl'
  /** The same, with the env var naming the FILE rather than its directory. */
  | 'managed-supplies-baseurl-file'
  /** The same as the directory form, but with the three setting sources loaded. */
  | 'managed-supplies-baseurl-sources'
  /** The helper, under whichever delivery the control above proves. */
  | 'helper-supplies-baseurl'
  /**
   * The LAST-RESORT control on whether the file is READ at all: a document that
   * is not JSON. `managed-settings.md#invalid-entries-in-managed-settings` is a
   * documented behaviour, so a child that reads this file has something to say
   * about it. Silence identical to the baseline means the path is never opened.
   */
  | 'managed-unparseable';

export interface PolicyHelperOutcome {
  arm: PolicyHelperArm;
  /** Did the helper run? The marker file is the only thing that can say so. */
  markerWritten: boolean;
  /** The helper's own record of the argv/env it was handed, when it ran. */
  markerContent: string | null;
  /** Requests that reached the ORIGINAL upstream. */
  requestsA: number;
  /** Requests that reached the REDIRECT target the policy tried to install. */
  requestsB: number;
  ended: 'result' | 'throw';
  detail: string;
  userAgent: string | null;
}

const SUPPLIES_BASE_URL = new Set<PolicyHelperArm>([
  'managed-supplies-baseurl', 'managed-supplies-baseurl-file',
  'managed-supplies-baseurl-sources', 'helper-supplies-baseurl',
]);

export async function runPolicyHelperArm(arm: PolicyHelperArm): Promise<PolicyHelperOutcome> {
  const stubA = await startStub();
  const stubB = await startStub();
  const managedDir = realpathSync(mkdtempSync(join(tmpdir(), 'p6073-managed-')));
  const configDir = mkdtempSync(join(tmpdir(), 'p6073-cfg-'));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'p6073-cwd-')));
  const marker = join(managedDir, 'helper-ran.marker');

  // The policy the arm tries to install: move the child from A to B.
  const redirect = { env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${stubB.port}` } };

  // For the `supplies` arms the managed block is the ONLY source of the base
  // URL, and it points at A rather than redirecting to B.
  const supplies = {
    env: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${stubA.port}`,
      ANTHROPIC_API_KEY: 'not-needed',
    },
  };
  const settingsFile = join(managedDir, 'managed-settings.json');

  if (SUPPLIES_BASE_URL.has(arm)) {
    if (arm === 'helper-supplies-baseurl') {
      const helper = join(managedDir, 'policy-helper.sh');
      writeFileSync(
        helper,
        '#!/bin/sh\n'
        + `printf 'argv=%s cwd=%s settings_path=%s\\n' "$*" "$PWD" "$CLAUDE_CODE_MANAGED_SETTINGS_PATH" > ${JSON.stringify(marker)}\n`
        + `printf '%s' ${JSON.stringify(JSON.stringify(supplies))}\n`
        + 'exit 0\n',
      );
      chmodSync(helper, 0o755);
      writeFileSync(settingsFile, JSON.stringify({ policyHelper: helper }));
    } else {
      writeFileSync(settingsFile, JSON.stringify(supplies));
    }
  } else if (arm === 'managed-unparseable') {
    writeFileSync(settingsFile, '{ this is definitely not json');
  } else if (arm !== 'no-managed') {
    if (arm === 'managed-env-only') {
      writeFileSync(settingsFile, JSON.stringify(redirect));
    } else {
      const helper = join(managedDir, 'policy-helper.sh');
      writeFileSync(
        helper,
        '#!/bin/sh\n'
        // The marker records WHAT the helper was handed, so a spawn is not just a
        // yes/no — argv and the two env names that would say who called it.
        + `printf 'argv=%s cwd=%s settings_path=%s\\n' "$*" "$PWD" "$CLAUDE_CODE_MANAGED_SETTINGS_PATH" > ${JSON.stringify(marker)}\n`
        + `printf '%s' ${JSON.stringify(JSON.stringify(redirect))}\n`
        + (arm === 'helper-nonzero' ? 'exit 3\n' : 'exit 0\n'),
      );
      chmodSync(helper, 0o755);
      writeFileSync(settingsFile, JSON.stringify({ policyHelper: helper }));
    }
  }

  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC|API_)/i.test(key)),
  ) as Record<string, string>;

  let ended: PolicyHelperOutcome['ended'] = 'result';
  let detail = '';
  const query = sdk.query({
    prompt: 'say hello',
    options: {
      cwd,
      model: MODEL,
      settingSources: arm === 'managed-supplies-baseurl-sources' ? ['user', 'project', 'local'] : [],
      permissionMode: 'default',
      pathToClaudeCodeExecutable: vendoredClaudeBinary() ?? undefined,
      env: {
        ...inherited,
        CLAUDE_CONFIG_DIR: configDir,
        ...(SUPPLIES_BASE_URL.has(arm)
          ? {}
          : { ANTHROPIC_BASE_URL: `http://127.0.0.1:${stubA.port}`, ANTHROPIC_API_KEY: 'not-needed' }),
        CLAUDE_CODE_OAUTH_TOKEN: '',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ...(arm === 'no-managed'
          ? {}
          : {
              CLAUDE_CODE_MANAGED_SETTINGS_PATH:
                arm === 'managed-supplies-baseurl-file' ? settingsFile : managedDir,
            }),
      },
    } as never,
  });

  try {
    for await (const message of query) {
      const typed = message as { type: string; subtype?: string; result?: unknown; is_error?: boolean };
      if (typed.type === 'result') {
        detail = JSON.stringify({
          subtype: typed.subtype, is_error: typed.is_error,
          result: String(typed.result ?? '').slice(0, 200),
        });
        break;
      }
    }
  } catch (error) {
    ended = 'throw';
    detail = String(error).slice(0, 400);
  }

  const outcome: PolicyHelperOutcome = {
    arm,
    markerWritten: existsSync(marker),
    markerContent: existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null,
    requestsA: stubA.requests,
    requestsB: stubB.requests,
    ended,
    detail,
    userAgent: stubA.userAgent ?? stubB.userAgent,
  };
  try {
    await (query as unknown as { interrupt?: () => Promise<void> }).interrupt?.();
  } catch { /* the verdict is already taken */ }
  await stubA.close();
  await stubB.close();
  return outcome;
}

if (import.meta.main) {
  const arm = (process.argv[2] ?? 'no-managed') as PolicyHelperArm;
  console.log(JSON.stringify(await runPolicyHelperArm(arm)));
  process.exit(0);
}
