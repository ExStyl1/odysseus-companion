/**
 * F1.320 — the Pi child's AWS names for a Bedrock IAM connection come from the
 * CONNECTION, never half from the connection and half from the host's shell.
 *
 * Since F1.242 an `iam` credential is not stored in Pi's credential store: it
 * rides on the child's environment (`buildAwsEnv` writes AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN at spawn). But `buildPiSubprocessEnv`
 * starts from a spread of the host's own environment, and two inherited names
 * then change what pi-ai does with the connection's keys (vendored pi-ai 0.84,
 * `dist/api/bedrock-converse-stream.js`):
 *
 * - `AWS_SESSION_TOKEN` — `getConfiguredBedrockCredentials` pairs whatever
 *   session token the env carries with the access key; a stale one from the
 *   shell beside the connection's long-lived key is a pairing AWS rejects.
 * - `AWS_BEARER_TOKEN_BEDROCK` — read BEFORE any IAM key (`bearerToken =
 *   options.bearerToken || options.apiKey || AWS_BEARER_TOKEN_BEDROCK`), so an
 *   inherited bearer silently outranks the connection the user configured.
 *
 * So for an IAM connection the session token is set-or-DELETED and the bearer
 * is deleted — the same "absent means absent" rule `applyRotatedAwsEnv` already
 * applies on rotation (`packages/pi-agent-server/src/bedrock-env-rotation.ts`).
 * A connection that is NOT iam (an ambient-chain Bedrock user, or any other
 * provider) keeps the inherited names: they may be exactly its credential.
 *
 * `processEnv` is a plain object here, so no case depends on the machine's own
 * AWS environment, and none mutates `process.env` (AGENTS.md's Bun env-spread
 * trap: assigning a pre-slotted name leaves it invisible to a spread).
 *
 * The last arm pins the rule at the SDK itself, so it survives F1.255's Pi
 * lift: a real Bun child is spawned with EXACTLY the env `buildPiSubprocessEnv`
 * built, runs vendored pi-ai's own Bedrock `stream()` against a loopback
 * endpoint, and the arm reads the credential the SDK SENT (the `authorization`
 * scheme and key id, and `x-amz-security-token`). Measured 2026-09-24 without
 * the fix: the inherited bearer went out (`Bearer shell-bearer`) and the IAM
 * key never did. A pi-ai that changes which names it reads moves this arm, not
 * a copy of its precedence written here.
 */
import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { buildPiSubprocessEnv, PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

const INHERITED = { AWS_SESSION_TOKEN: 'stale-shell-session-token', AWS_BEARER_TOKEN_BEDROCK: 'shell-bearer' };

function childEnv(processEnv: NodeJS.ProcessEnv, awsEnv: Record<string, string>): NodeJS.ProcessEnv {
  return buildPiSubprocessEnv({ processEnv, proxyEnv: {}, awsEnv, sessionId: 'f1320-session', debug: false });
}

/** The env the REAL `buildAwsEnv` writes for an iam credential, so the rule is keyed off what production emits. */
function awsEnvFor(credential: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }): Record<string, string> {
  const config: BackendConfig = {
    provider: 'pi',
    workspace: {
      id: 'ws-f1320', name: 'F1.320', rootPath: '/tmp/nessy-f1320', workspaceRootPath: '/tmp/nessy-f1320',
      sessionRootPath: '/tmp/nessy-f1320-sessions/ws-f1320',
    },
    session: { id: 'session-f1320', workspaceRootPath: '/tmp/nessy-f1320', createdAt: 0, lastUsedAt: 0 },
    isHeadless: true,
  } as unknown as BackendConfig;
  const agent = new PiAgent(config);
  try {
    const build = (agent as unknown as {
      buildAwsEnv(piAuth: unknown, runtime: { piAuthProvider?: string }): Record<string, string>;
    }).buildAwsEnv.bind(agent);
    return build(
      { provider: 'amazon-bedrock', credential: { type: 'iam', region: 'eu-west-1', ...credential } },
      { piAuthProvider: 'amazon-bedrock' },
    );
  } finally {
    agent.destroy();
  }
}

describe('F1.320 — an IAM connection does not inherit the shell\'s AWS session or bearer token', () => {
  it('without a session token of its own: neither inherited name reaches the child', () => {
    const awsEnv = awsEnvFor({ accessKeyId: 'AKIA-CONNECTION', secretAccessKey: 'connection-secret' });
    expect(awsEnv.AWS_ACCESS_KEY_ID).toBe('AKIA-CONNECTION');
    const env = childEnv({ ...INHERITED, PATH: '/usr/bin' }, awsEnv);
    expect(env.AWS_ACCESS_KEY_ID).toBe('AKIA-CONNECTION');
    expect('AWS_SESSION_TOKEN' in env).toBe(false);
    expect('AWS_BEARER_TOKEN_BEDROCK' in env).toBe(false);
    expect(env.PATH).toBe('/usr/bin');
  });

  it('with a session token of its own: the connection\'s token is the one the child carries', () => {
    const awsEnv = awsEnvFor({ accessKeyId: 'ASIA-CONNECTION', secretAccessKey: 'connection-secret', sessionToken: 'connection-session-token' });
    const env = childEnv({ ...INHERITED }, awsEnv);
    expect(env.AWS_SESSION_TOKEN).toBe('connection-session-token');
    expect('AWS_BEARER_TOKEN_BEDROCK' in env).toBe(false);
  });

  it('CONTROL — a non-iam spawn keeps both inherited names (they may BE its credential)', () => {
    // An ambient-chain Bedrock connection: `buildAwsEnv` writes the transport default and no key.
    const ambient = childEnv({ ...INHERITED }, { AWS_BEDROCK_FORCE_HTTP1: '1' });
    expect(ambient.AWS_SESSION_TOKEN).toBe(INHERITED.AWS_SESSION_TOKEN);
    expect(ambient.AWS_BEARER_TOKEN_BEDROCK).toBe(INHERITED.AWS_BEARER_TOKEN_BEDROCK);
    // Any other provider: no AWS env at all.
    const other = childEnv({ ...INHERITED }, {});
    expect(other.AWS_SESSION_TOKEN).toBe(INHERITED.AWS_SESSION_TOKEN);
    expect(other.AWS_BEARER_TOKEN_BEDROCK).toBe(INHERITED.AWS_BEARER_TOKEN_BEDROCK);
  });

  it('CONTROL — the host\'s own environment object is not mutated', () => {
    const processEnv = { ...INHERITED };
    childEnv(processEnv, awsEnvFor({ accessKeyId: 'AKIA-CONNECTION', secretAccessKey: 'connection-secret' }));
    expect(processEnv).toEqual(INHERITED);
  });
});

/** Vendored pi-ai's Bedrock stream, resolved from THIS package (AGENTS.md: a rig must not resolve another tree). */
const BEDROCK_STREAM_MODULE = Bun.resolveSync('@earendil-works/pi-ai/api/bedrock-converse-stream', import.meta.dir);

/** The child's whole program: one Bedrock turn through pi-ai, credentials read from its own env only. */
const CHILD_PROGRAM = [
  'const { stream } = await import(process.env.F1320_PI_AI_BEDROCK);',
  "const model = { id: 'anthropic.claude-3-haiku-20240307-v1:0', name: 'f1320', api: 'bedrock-converse-stream',",
  "  provider: 'amazon-bedrock', baseUrl: process.env.F1320_ENDPOINT, reasoning: false, input: ['text'],",
  '  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 10 };',
  "await stream(model, { systemPrompt: 's', messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }, {}).result();",
].join('\n');

interface SentCredential { scheme: string; keyId?: string; bearer?: string; securityToken?: string }

/** Spawn a Bun child with `env` as its WHOLE environment and read what pi-ai sent to a loopback Bedrock. */
async function sentCredential(env: NodeJS.ProcessEnv): Promise<SentCredential> {
  const seen: SentCredential[] = [];
  const server = createServer((req, res) => {
    const auth = String(req.headers.authorization ?? '');
    const token = req.headers['x-amz-security-token'];
    const keyId = /Credential=([^/]+)\//.exec(auth)?.[1];
    seen.push({
      scheme: auth.split(' ')[0] ?? '',
      ...(keyId ? { keyId } : {}),
      ...(auth.startsWith('Bearer ') ? { bearer: auth.slice('Bearer '.length) } : {}),
      ...(typeof token === 'string' ? { securityToken: token } : {}),
    });
    res.writeHead(400, { 'content-type': 'application/json', 'x-amzn-errortype': 'ValidationException' });
    res.end(JSON.stringify({ message: 'f1320 probe' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const port = (server.address() as { port: number }).port;
    const childEnvironment: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) if (typeof value === 'string') childEnvironment[name] = value;
    childEnvironment.F1320_PI_AI_BEDROCK = BEDROCK_STREAM_MODULE;
    childEnvironment.F1320_ENDPOINT = `http://127.0.0.1:${port}`;
    // Async spawn: a spawnSync would block the loop this server answers on (AGENTS.md).
    const child = spawn(process.execPath, ['-e', CHILD_PROGRAM], { cwd: tmpdir(), env: childEnvironment });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    await new Promise((resolve) => child.on('close', resolve));
    if (seen.length !== 1) throw new Error(`expected ONE Bedrock request, saw ${seen.length}; child said: ${output.slice(0, 400)}`);
    return seen[0]!;
  } finally {
    server.close();
  }
}

describe('F1.320 at the Pi SDK boundary — the credential vendored pi-ai SENDS from the child env', () => {
  it('iam: SigV4 with the connection key and no inherited token or bearer; with its own token: that token; ambient: the inherited bearer (CONTROL)', async () => {
    expect(BEDROCK_STREAM_MODULE.startsWith(new URL('../../../../../', import.meta.url).pathname)).toBe(true);
    const PATH = '/usr/bin:/bin';
    const [iam, iamWithToken, ambient] = await Promise.all([
      sentCredential(childEnv({ ...INHERITED, PATH }, awsEnvFor({ accessKeyId: 'AKIA-CONNECTION', secretAccessKey: 'connection-secret' }))),
      sentCredential(childEnv({ ...INHERITED, PATH }, awsEnvFor({
        accessKeyId: 'ASIA-CONNECTION', secretAccessKey: 'connection-secret', sessionToken: 'connection-session-token',
      }))),
      // An ambient-chain Bedrock connection: `buildAwsEnv` writes the transport default and no key.
      sentCredential(childEnv({ ...INHERITED, PATH }, { AWS_BEDROCK_FORCE_HTTP1: '1' })),
    ]);
    expect(iam).toEqual({ scheme: 'AWS4-HMAC-SHA256', keyId: 'AKIA-CONNECTION' });
    expect(iamWithToken).toEqual({ scheme: 'AWS4-HMAC-SHA256', keyId: 'ASIA-CONNECTION', securityToken: 'connection-session-token' });
    expect(ambient).toEqual({ scheme: 'Bearer', bearer: INHERITED.AWS_BEARER_TOKEN_BEDROCK });
  }, 180_000);
});

/**
 * F1.465 — an inherited `AWS_BEDROCK_SKIP_AUTH=1`.
 *
 * Vendored pi-ai 0.84 (`dist/api/bedrock-converse-stream.js`) reads it from the
 * child env before any credential: set, it signs every request with
 * `dummy-access-key` and never sends the configured keys (it exists for proxies
 * that need no authentication). Measured by WJ-pp-b (2026-09-24): an IAM
 * connection spawned from a shell carrying it sent `Credential=dummy-access-key`,
 * so the connection the user configured was never used.
 *
 * DECIDED (WJ-au, 2026-09-24, the transparent-and-simple rule — no page speaks
 * to it): the same rule F1.320 applies to the other two inherited companions.
 * A connection that carries its own IAM keys is the explicit choice, so the
 * inherited flag is dropped for it; an ambient-chain connection keeps the flag,
 * because for it the shell's setting IS the configuration (the CONTROL arms).
 *
 * The SDK control carries the flag ALONE. Measured at HEAD the same day: with
 * the inherited bearer beside it, an ambient connection sent `Bearer
 * shell-bearer` despite the flag (the bearer is read below pi-ai as well), so
 * the flag's own effect — SigV4 with `dummy-access-key` — shows only without it.
 */
describe('F1.465 — an IAM connection does not inherit the shell\'s AWS_BEDROCK_SKIP_AUTH', () => {
  const SKIP = { ...INHERITED, AWS_BEDROCK_SKIP_AUTH: '1' };

  it('the child env of an IAM connection has no skip flag; an ambient connection keeps it (CONTROL)', () => {
    const iam = childEnv({ ...SKIP }, awsEnvFor({ accessKeyId: 'AKIA-CONNECTION', secretAccessKey: 'connection-secret' }));
    expect('AWS_BEDROCK_SKIP_AUTH' in iam).toBe(false);
    const ambient = childEnv({ ...SKIP }, { AWS_BEDROCK_FORCE_HTTP1: '1' });
    expect(ambient.AWS_BEDROCK_SKIP_AUTH).toBe('1');
  });

  it('at the SDK: the IAM connection signs with its own key; the ambient connection keeps the deliberate skip (CONTROL)', async () => {
    const PATH = '/usr/bin:/bin';
    const [iam, ambient] = await Promise.all([
      sentCredential(childEnv({ ...SKIP, PATH }, awsEnvFor({ accessKeyId: 'AKIA-CONNECTION', secretAccessKey: 'connection-secret' }))),
      sentCredential(childEnv({ AWS_BEDROCK_SKIP_AUTH: '1', PATH }, { AWS_BEDROCK_FORCE_HTTP1: '1' })),
    ]);
    expect({ iam, ambient }).toEqual({
      iam: { scheme: 'AWS4-HMAC-SHA256', keyId: 'AKIA-CONNECTION' },
      ambient: { scheme: 'AWS4-HMAC-SHA256', keyId: 'dummy-access-key' },
    });
  }, 180_000);
});
