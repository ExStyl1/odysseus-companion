/**
 * F1.545 (origin WJ-au P-WJau-1) — an ambient-chain Bedrock connection whose
 * shell sets `AWS_BEDROCK_SKIP_AUTH=1` must not send the shell's Bedrock bearer.
 *
 * Vendored pi-ai (0.84.4, and 0.85.1 after F1.255's lift; `dist/api/bedrock-converse-stream.js`) states the flag's
 * meaning in its own code: "Support proxies that don't need authentication" —
 * with it set, pi-ai signs with `dummy-access-key` and computes
 * `useBearerToken = bearerToken !== undefined && !skipAuth`, i.e. it refuses its
 * OWN bearer. But the AWS SDK beneath it reads `AWS_BEARER_TOKEN_BEDROCK` from the
 * process environment again, on its own, and sends it: measured by WJ-au on
 * 2026-09-24 (F1.465's run), an ambient connection whose shell carried both
 * names sent `Bearer shell-bearer` — a real Bedrock credential, to an endpoint
 * the user declared needs none.
 *
 * DECIDED (WJ-bd, 2026-09-24, the transparent-and-simple rule — no page speaks
 * to it, and pi-ai's own code is the nearest statement of intent): the host makes
 * pi-ai's rule hold at the layer below it. When the Pi child's environment says
 * skip-auth, the bearer the HOST'S SHELL carried is not handed to the child. An
 * explicit bearer (the connection's own `envOverrides`) is not touched, and
 * without the flag the inherited bearer passes through: for an ambient
 * connection it may BE the credential (the CONTROL arms).
 *
 * The SDK arm drives vendored pi-ai in a real Bun child with exactly the env
 * `buildPiSubprocessEnv` built, and reads the credential it SENT (F1.320's
 * instrument, `pi-bedrock-inherited-aws-env.test.ts`), so a pi-ai or AWS SDK
 * lift re-measures the rule instead of trusting this docblock.
 */
import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { buildPiSubprocessEnv } from '../pi-agent.ts';

const AMBIENT_AWS_ENV = { AWS_BEDROCK_FORCE_HTTP1: '1' }; // what `buildAwsEnv` writes for an ambient-chain connection
const SHELL = { AWS_BEDROCK_SKIP_AUTH: '1', AWS_BEARER_TOKEN_BEDROCK: 'shell-bearer', PATH: '/usr/bin:/bin' };

function childEnv(processEnv: NodeJS.ProcessEnv, envOverrides?: Record<string, string>): NodeJS.ProcessEnv {
  return buildPiSubprocessEnv({ processEnv, proxyEnv: {}, envOverrides, awsEnv: AMBIENT_AWS_ENV, sessionId: 'f1545-session', debug: false });
}

const BEDROCK_STREAM_MODULE = Bun.resolveSync('@earendil-works/pi-ai/api/bedrock-converse-stream', import.meta.dir);
const CHILD_PROGRAM = [
  'const { stream } = await import(process.env.F1545_PI_AI_BEDROCK);',
  "const model = { id: 'anthropic.claude-3-haiku-20240307-v1:0', name: 'f1545', api: 'bedrock-converse-stream',",
  "  provider: 'amazon-bedrock', baseUrl: process.env.F1545_ENDPOINT, reasoning: false, input: ['text'],",
  '  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 10 };',
  "await stream(model, { systemPrompt: 's', messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }, {}).result();",
].join('\n');

interface SentCredential { scheme: string; keyId?: string; bearer?: string }

async function sentCredential(env: NodeJS.ProcessEnv): Promise<SentCredential> {
  const seen: SentCredential[] = [];
  const server = createServer((req, res) => {
    const auth = String(req.headers.authorization ?? '');
    const keyId = /Credential=([^/]+)\//.exec(auth)?.[1];
    seen.push({
      scheme: auth.split(' ')[0] ?? '',
      ...(keyId ? { keyId } : {}),
      ...(auth.startsWith('Bearer ') ? { bearer: auth.slice('Bearer '.length) } : {}),
    });
    res.writeHead(400, { 'content-type': 'application/json', 'x-amzn-errortype': 'ValidationException' });
    res.end(JSON.stringify({ message: 'f1545 probe' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const port = (server.address() as { port: number }).port;
    const childEnvironment: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) if (typeof value === 'string') childEnvironment[name] = value;
    childEnvironment.F1545_PI_AI_BEDROCK = BEDROCK_STREAM_MODULE;
    childEnvironment.F1545_ENDPOINT = `http://127.0.0.1:${port}`;
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

describe('F1.545 — the shell\'s skip-auth flag keeps the shell\'s Bedrock bearer out of the Pi child', () => {
  it('env: skip-auth + an inherited bearer → no bearer; the flag itself is kept', () => {
    const env = childEnv({ ...SHELL });
    expect(env.AWS_BEDROCK_SKIP_AUTH).toBe('1');
    expect('AWS_BEARER_TOKEN_BEDROCK' in env).toBe(false);
  });

  it('CONTROL — without the flag the inherited bearer passes (it may BE the ambient credential); an explicit override bearer is never touched', () => {
    const { AWS_BEDROCK_SKIP_AUTH: _flag, ...noFlag } = SHELL;
    expect(childEnv({ ...noFlag }).AWS_BEARER_TOKEN_BEDROCK).toBe('shell-bearer');
    expect(childEnv({ ...SHELL }, { AWS_BEARER_TOKEN_BEDROCK: 'connection-bearer' }).AWS_BEARER_TOKEN_BEDROCK).toBe('connection-bearer');
  });

  it('CONTROL — the host\'s own environment object is not mutated', () => {
    const processEnv = { ...SHELL };
    childEnv(processEnv);
    expect(processEnv).toEqual(SHELL);
  });

  it('at the SDK: skip-auth + inherited bearer signs with the dummy key; the bearer alone still goes out (CONTROL)', async () => {
    expect(BEDROCK_STREAM_MODULE.startsWith(new URL('../../../../../', import.meta.url).pathname)).toBe(true);
    const { AWS_BEDROCK_SKIP_AUTH: _flag, ...noFlag } = SHELL;
    const [skipped, bearerOnly] = await Promise.all([
      sentCredential(childEnv({ ...SHELL })),
      sentCredential(childEnv({ ...noFlag })),
    ]);
    expect({ skipped, bearerOnly }).toEqual({
      skipped: { scheme: 'AWS4-HMAC-SHA256', keyId: 'dummy-access-key' },
      bearerOnly: { scheme: 'Bearer', bearer: 'shell-bearer' },
    });
  }, 180_000);
});
