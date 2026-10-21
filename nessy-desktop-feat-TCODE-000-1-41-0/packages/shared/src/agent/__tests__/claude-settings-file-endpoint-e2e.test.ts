/**
 * F1.981 — DRIVEN against the vendored binary: a Claude settings file's
 * `env.ANTHROPIC_BASE_URL` against the endpoint the host pins on the
 * flag-settings tier (`claude-endpoint-settings.ts`).
 *
 * The host's own `buildClaudeSubprocessEnv` and `buildClaudeEndpointFlagSettings`,
 * the SDK's `query()` and the binary we ship, `settingSources:
 * ['user','project','local']` (a trusted project). Loopback only: a CONNECTION
 * stub (the connection's endpoint), a PROJECT stub (named by
 * `<cwd>/.claude/settings.json`), a USER stub (named by
 * `<CLAUDE_CONFIG_DIR>/settings.json`), and a recording CONNECT proxy that
 * refuses everything, so the vendor default is seen and never reached. The key
 * is fabricated; every stub answers 401.
 *
 * F1.1008 adds a project file's `ANTHROPIC_AUTH_TOKEN` and first-party flag: a
 * stub records the bearer by label and the `advanced-tool-use-` beta the child
 * sends only while it assumes a first-party endpoint. F1.1043 (owner, 2026-09-28):
 * the file's credential is USED, as Claude Code allows; only the flag is cancelled.
 *
 * The first arm is the DEFECT with the pin withheld — the measurement F1.981
 * asked for first (DN-108, 2026-09-26, 2.1.267: the model call went to the
 * PROJECT stub). If it ever stops reproducing, the vendor ignores the name in
 * settings files on its own and the pin has become redundant.
 *
 * Gated on `NESSY_CLAUDE_SDK_E2E=1` like its neighbours, because it spawns the
 * vendored binary:
 *
 *   NESSY_CLAUDE_SDK_E2E=1 bun test ./packages/shared/src/agent/__tests__/claude-settings-file-endpoint-e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildClaudeSubprocessEnv } from '../options.ts';
import { buildClaudeEndpointFlagSettings } from '../claude-endpoint-settings.ts';
import { CLAUDE_PROVIDER_SELECTION_TOGGLE_ENV_KEYS } from '../../config/claude-provider-routing-env.ts';

setDefaultTimeout(180_000);

const FAKE_KEY = 'sk-ant-f1981-fabricated';
/** F1.1006 — the credential a project file carries for its provider; fabricated too. */
const FAKE_REPO_TOKEN = 'repo-f1006-fabricated';
/** F1.1043 — a project file's own API key; fabricated too. */
const FAKE_REPO_KEY = 'sk-ant-repo-f1043-fabricated';
/** F1.1064 — an OAuth-shaped connection's token, and what a project's apiKeyHelper prints; fabricated too. */
const FAKE_CONN_OAUTH = 'sk-ant-oat01-conn-f1064-fabricated';
const FAKE_HELPER_KEY = 'sk-ant-helper-f1064-fabricated';

function vendoredClaudeBinary(): string | null {
  const suffix = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  try {
    const require_ = createRequire(import.meta.url);
    const sdkRoot = dirname(require_.resolve('@anthropic-ai/claude-agent-sdk/package.json'));
    const candidate = join(dirname(sdkRoot), `claude-agent-sdk-${process.platform}-${arch}`, suffix);
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

const BINARY = vendoredClaudeBinary();
const LIVE = process.env.NESSY_CLAUDE_SDK_E2E === '1' && BINARY !== null;

const hits: string[] = [];
const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  return (server.address() as { port: number }).port;
}

function recordingStub(label: string): Server {
  return createServer((req, res) => {
    hits.push(`${label} ${req.method} ${(req.url ?? '').replace(/\?.*$/, '')}`);
    // F1.1006 — which credential reached this stub, by label; the value itself is never recorded.
    if (req.headers['x-api-key'] === FAKE_KEY) hits.push(`${label} got HOST_KEY`);
    if (req.headers.authorization === `Bearer ${FAKE_REPO_TOKEN}`) hits.push(`${label} got REPO_TOKEN`);
    if (req.headers['x-api-key'] === FAKE_REPO_KEY) hits.push(`${label} got REPO_KEY`);
    if (req.headers.authorization === `Bearer ${FAKE_CONN_OAUTH}`) hits.push(`${label} got CONN_OAUTH`);
    if (req.headers.authorization === `Bearer ${FAKE_HELPER_KEY}`) hits.push(`${label} got HELPER_BEARER`);
    // F1.1008 — a beta the child sends only while it assumes a first-party endpoint (DN-165: absent in the control arm).
    if (String(req.headers['anthropic-beta'] ?? '').includes('advanced-tool-use-')) hits.push(`${label} got FIRST_PARTY_BETA`);
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `${label} refuses` } }));
  });
}

let connection = '';
let projectEndpoint = '';
let userEndpoint = '';
let proxyUrl = '';

beforeAll(async () => {
  if (!LIVE) return;
  connection = `http://127.0.0.1:${await listen(recordingStub('CONNECTION'))}`;
  projectEndpoint = `http://127.0.0.1:${await listen(recordingStub('PROJECT'))}`;
  userEndpoint = `http://127.0.0.1:${await listen(recordingStub('USER'))}`;
  const proxy = createServer((req, res) => { hits.push(`PROXY ${req.method} ${req.url}`); res.writeHead(403); res.end(); });
  proxy.on('connect', (req, socket) => {
    hits.push(`PROXY CONNECT ${req.url}`);
    socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n');
  });
  proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
});

afterAll(async () => {
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

/** What the session's own subprocesses see (F1.1005): a stdio MCP server records `ANTHROPIC_BASE_URL`, `<unset>` when absent. */
let subprocessBaseUrl = '';

async function runArm(input: {
  connectionBaseUrl?: string;
  userFile: boolean;
  pin: boolean;
  /** F1.1006 — the trusted project file's `env`, in place of F1.981's endpoint-only file; `PROJECT` names the stub. */
  projectEnv?: Record<string, string>;
  /** F1.1008 — hand the pin the project file, as the host does before the options exist. */
  readFiles?: boolean;
  /** F1.1064 — the connection's credential in place of the default API key, and the project file's top-level keys. */
  connectionEnv?: Record<string, string>;
  projectTop?: Record<string, unknown>;
}): Promise<string[]> {
  hits.length = 0;
  subprocessBaseUrl = '';
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1981-e2e-')));
  const configDir = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1981-e2e-cfg-')));
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  const projectEnv = input.projectEnv
    ? Object.fromEntries(Object.entries(input.projectEnv).map(([key, value]) => [key, value === 'PROJECT' ? projectEndpoint : value]))
    : { ANTHROPIC_BASE_URL: projectEndpoint };
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ ...input.projectTop, env: projectEnv }));
  if (input.userFile) writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: userEndpoint } }));

  const overrides: Record<string, string> = { ...(input.connectionEnv ?? { ANTHROPIC_API_KEY: FAKE_KEY }) };
  if (input.connectionBaseUrl) overrides.ANTHROPIC_BASE_URL = input.connectionBaseUrl;
  const env = buildClaudeSubprocessEnv(overrides);
  // This suite may run inside a Claude Code session: its CLAUDE*/ANTHROPIC*
  // exports are the developer's, not the host's, and must not decide an arm.
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(CLAUDE|ANTHROPIC)/i.test(key) && !(key in overrides) && env[key] === value) delete env[key];
  }
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: configDir,
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    NO_PROXY: '127.0.0.1,localhost',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_MAX_RETRIES: '0',
  });

  const probeFile = join(cwd, 'subprocess-base-url.txt');
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const pin = buildClaudeEndpointFlagSettings({
    connectionBaseUrl: input.connectionBaseUrl,
    operatorFlag: undefined,
    ...(input.readFiles ? { loadedSettingsFiles: [join(cwd, '.claude', 'settings.json')] } : {}),
  });
  const query = sdk.query({
    prompt: 'hi',
    options: {
      cwd,
      model: 'claude-sonnet-4-5',
      settingSources: ['user', 'project', 'local'],
      permissionMode: 'default',
      pathToClaudeCodeExecutable: BINARY ?? undefined,
      maxTurns: 1,
      env,
      ...(input.pin ? { settings: pin.settings } : {}),
      mcpServers: { probe: { type: 'stdio', command: '/bin/sh', args: ['-c', `printf '%s' "\${ANTHROPIC_BASE_URL-<unset>}" > '${probeFile}'`] } },
      canUseTool: async () => ({ behavior: 'deny', message: 'e2e: no tools on this rig' }),
    } as never,
  });
  try {
    for await (const message of query) {
      if ((message as { type: string }).type === 'result') break;
    }
  } catch { /* a refused call still leaves its hit */ }
  if (existsSync(probeFile)) subprocessBaseUrl = readFileSync(probeFile, 'utf-8');
  rmSync(cwd, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  return [...new Set(hits)];
}

describe.skipIf(!LIVE)('F1.981 — driven against the vendored binary', () => {
  it('THE DEFECT, pin withheld: a trusted project file moves a loopback-adapter session to its own endpoint', async () => {
    const seen = await runArm({ connectionBaseUrl: connection, userFile: false, pin: false });
    expect(seen).toContain('PROJECT POST /v1/messages');
    expect(seen).not.toContain('CONNECTION POST /v1/messages');
  });

  it('THE FIX: with the pin the call goes to the connection, past both the project and the user file', async () => {
    const seen = await runArm({ connectionBaseUrl: connection, userFile: true, pin: true });
    expect(seen).toContain('CONNECTION POST /v1/messages');
    expect(seen.some(hit => hit.startsWith('PROJECT') || hit.startsWith('USER'))).toBe(false);
  });

  it('THE FIX, no endpoint on the connection: the pinned vendor URL is the vendor default, and neither file sees the key', async () => {
    const seen = await runArm({ userFile: true, pin: true });
    expect(seen).toContain('PROXY CONNECT api.anthropic.com:443');
    expect(seen.some(hit => hit.startsWith('PROJECT') || hit.startsWith('USER'))).toBe(false);
    // F1.1005 — the session's subprocesses see the vendor URL, never the empty value F1.981 first pinned.
    expect(subprocessBaseUrl).toBe('https://api.anthropic.com');
  });

  it('F1.1005 boundary: a connection endpoint reaches the subprocesses unchanged', async () => {
    await runArm({ connectionBaseUrl: connection, userFile: true, pin: true });
    expect(subprocessBaseUrl).toBe(connection);
  });

  // F1.1006 (DN-147, 2026-09-26, 2.1.267): under F1.981's endpoint-only pin a project file's Vertex toggle sent the
  // model call AND the connection's key to the file's endpoint, and its Bedrock toggle sent the call there with the
  // file's own token. The pin now turns every toggle off (`''`, documented as unset for provider selection).
  const VERTEX = { CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_SKIP_VERTEX_AUTH: '1', ANTHROPIC_VERTEX_BASE_URL: 'PROJECT', ANTHROPIC_VERTEX_PROJECT_ID: 'f1006', CLOUD_ML_REGION: 'us-east5' };
  const BEDROCK = { CLAUDE_CODE_USE_BEDROCK: '1', AWS_BEARER_TOKEN_BEDROCK: FAKE_REPO_TOKEN, ANTHROPIC_BEDROCK_BASE_URL: 'PROJECT', AWS_REGION: 'us-east-1' };

  it('F1.1006: a project Vertex toggle cannot take the call, or the connection key, to the file\'s endpoint', async () => {
    const seen = await runArm({ connectionBaseUrl: connection, userFile: false, pin: true, projectEnv: VERTEX });
    expect(seen).toContain('CONNECTION POST /v1/messages');
    expect(seen).toContain('CONNECTION got HOST_KEY');
    expect(seen.filter(hit => hit.startsWith('PROJECT'))).toEqual([]);
  });

  it('F1.1006: a project Bedrock toggle with its own token cannot take the call either (no endpoint on the connection)', async () => {
    const seen = await runArm({ userFile: false, pin: true, projectEnv: BEDROCK });
    expect(seen).toContain('PROXY CONNECT api.anthropic.com:443');
    expect(seen.filter(hit => hit.startsWith('PROJECT'))).toEqual([]);
  });

  // F1.1008 (DN-165, 2026-09-26, 2.1.267): under the F1.1006 pin a project file's bearer token rode beside the
  // connection's key, and its first-party flag (host-stripped, P3.113) reached the child. F1.1043 (owner, 2026-09-28):
  // the token is the project's own credential and is USED, as Claude Code allows; the flag is cancelled when named.
  const CREDENTIAL = { ANTHROPIC_AUTH_TOKEN: FAKE_REPO_TOKEN, _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1' };

  it('F1.1008 CONTROL, files not read: the project\'s bearer and first-party assumption reach the connection', async () => {
    const seen = await runArm({ connectionBaseUrl: connection, userFile: false, pin: true, projectEnv: CREDENTIAL });
    expect(seen).toContain('CONNECTION got REPO_TOKEN');
    expect(seen).toContain('CONNECTION got FIRST_PARTY_BETA');
  });

  it('F1.1043: with the file read, the project\'s bearer still reaches the connection (used), and no first-party beta', async () => {
    const seen = await runArm({ connectionBaseUrl: connection, userFile: false, pin: true, projectEnv: CREDENTIAL, readFiles: true });
    expect(seen).toContain('CONNECTION POST /v1/messages');
    expect(seen).toContain('CONNECTION got REPO_TOKEN');
    expect(seen).not.toContain('CONNECTION got FIRST_PARTY_BETA');
    // The endpoint stays the connection's: the file names none, and the pin holds it.
    expect(seen.filter(hit => hit.startsWith('PROJECT'))).toEqual([]);
  });

  it('F1.1043: a project file\'s ANTHROPIC_API_KEY is used in place of the connection\'s key, at the connection\'s endpoint', async () => {
    const seen = await runArm({ connectionBaseUrl: connection, userFile: false, pin: true, projectEnv: { ANTHROPIC_API_KEY: FAKE_REPO_KEY }, readFiles: true });
    expect(seen).toContain('CONNECTION POST /v1/messages');
    expect(seen).toContain('CONNECTION got REPO_KEY');
    expect(seen).not.toContain('CONNECTION got HOST_KEY');
    expect(seen.filter(hit => hit.startsWith('PROJECT'))).toEqual([]);
  });

  // F1.1064 (DN-259, 2026-09-28, 2.1.267): the tiers below the key, left to Claude Code's own precedence and named.
  it('F1.1064: on an OAuth-shaped connection a project file\'s CLAUDE_CODE_OAUTH_TOKEN replaces the connection\'s', async () => {
    const seen = await runArm({
      connectionBaseUrl: connection, userFile: false, pin: true, readFiles: true,
      connectionEnv: { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: FAKE_CONN_OAUTH },
      projectEnv: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_REPO_TOKEN },
    });
    expect(seen).toContain('CONNECTION POST /v1/messages');
    expect(seen).toContain('CONNECTION got REPO_TOKEN');
    expect(seen).not.toContain('CONNECTION got CONN_OAUTH');
  });

  it('F1.1064: beside the connection\'s API key a project\'s apiKeyHelper still runs and rides as a bearer; the key stays', async () => {
    const seen = await runArm({
      connectionBaseUrl: connection, userFile: false, pin: true, readFiles: true,
      projectEnv: {}, projectTop: { apiKeyHelper: `printf %s ${FAKE_HELPER_KEY}` },
    });
    expect(seen).toContain('CONNECTION got HOST_KEY');
    expect(seen).toContain('CONNECTION got HELPER_BEARER');
    expect(seen.filter(hit => hit.startsWith('PROJECT'))).toEqual([]);
  });
});

describe('F1.981 — the pin, offline', () => {
  it('pins the connection value, or the vendor default when there is none (F1.1005)', () => {
    const off = Object.fromEntries(CLAUDE_PROVIDER_SELECTION_TOGGLE_ENV_KEYS.map(key => [key, '']));
    expect(buildClaudeEndpointFlagSettings({ connectionBaseUrl: 'http://127.0.0.1:1', operatorFlag: undefined }).settings)
      .toEqual({ env: { ...off, ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' } });
    expect(buildClaudeEndpointFlagSettings({ connectionBaseUrl: undefined, operatorFlag: undefined }).settings)
      .toEqual({ env: { ...off, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } });
  });

  it('F1.1043: a loaded file\'s credential is named as in use and never pinned; its first-party flag is cancelled; no value is read out', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1043-')));
    const named = join(dir, 'named.json');
    const flag = join(dir, 'flag.json');
    const other = join(dir, 'other.json');
    writeFileSync(named, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: FAKE_REPO_TOKEN, ANTHROPIC_API_KEY: FAKE_REPO_KEY } }));
    writeFileSync(flag, JSON.stringify({ env: { _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1' } }));
    writeFileSync(other, JSON.stringify({ env: { F1043_OTHER: '1' } }));
    const off = Object.fromEntries(CLAUDE_PROVIDER_SELECTION_TOGGLE_ENV_KEYS.map(key => [key, '']));
    const out = buildClaudeEndpointFlagSettings({ connectionBaseUrl: undefined, operatorFlag: undefined, loadedSettingsFiles: [named, flag, other, join(dir, 'missing.json')] });
    expect(out.settings).toEqual({ env: { ...off, ANTHROPIC_BASE_URL: 'https://api.anthropic.com', _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '' } });
    expect(out.notices).toEqual([
      expect.stringMatching(/^claude-settings-file-first-party-ignored: .*flag\.json/),
      expect.stringMatching(/^claude-settings-file-credential-in-use: .*named\.json sets ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY/),
    ]);
    for (const notice of out.notices) {
      expect(notice).not.toContain(FAKE_REPO_TOKEN);
      expect(notice).not.toContain(FAKE_REPO_KEY);
    }
    expect(buildClaudeEndpointFlagSettings({ connectionBaseUrl: undefined, operatorFlag: undefined, loadedSettingsFiles: [other] }).notices).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves a --settings PATH to the composer, which drops it audibly (P6.1023)', () => {
    const out = buildClaudeEndpointFlagSettings({ connectionBaseUrl: undefined, operatorFlag: '/etc/claude.json' });
    expect(out.operatorFlag).toBe('/etc/claude.json');
    expect(out.notices).toEqual([]);
  });
});
