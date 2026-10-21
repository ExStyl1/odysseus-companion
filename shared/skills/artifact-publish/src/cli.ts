import {execFile, spawn} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
import {extname} from 'node:path';
import {pathToFileURL} from 'node:url';

export const DEFAULT_SERVICE_URL = 'https://t-artifacts.t-tech.team';

type Environment = Record<string, string | undefined>;
type Fetch = typeof globalThis.fetch;

export interface Runtime {
  env?: Environment;
  fetch?: Fetch;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  open?: (url: string) => Promise<void>;
  token?: () => Promise<string>;
  login?: () => Promise<void>;
}

interface Config {
  serviceUrl: string;
  noOpen: boolean;
}

interface PublishOptions {
  file: string;
  title?: string;
  emoji?: string;
  description?: string;
  slug?: string;
  idOrUrl?: string;
  editToken?: string;
}

const help = `Usage:
  npx -y @loyalty-personalization/artifact-publish <file> --emoji EMOJI [options]
  npx -y @loyalty-personalization/artifact-publish download <id-or-url> [--output FILE]
  npx -y @loyalty-personalization/artifact-publish list
  npx -y @loyalty-personalization/artifact-publish rename <id-or-url> --title TITLE
  npx -y @loyalty-personalization/artifact-publish delete <id-or-url> [--edit-token TOKEN]
  npx -y @loyalty-personalization/artifact-publish claim <id-or-url> --edit-token TOKEN
  npx -y @loyalty-personalization/artifact-publish skill list
  npx -y @loyalty-personalization/artifact-publish skill get <name>...

Publish and update options:
  --emoji EMOJI         Required artifact emoji
  --title TITLE         Display title
  --description DESC    Short artifact description
  --slug SLUG           Custom URL slug
  --id-or-url VALUE     Existing artifact ID or URL to update
  --edit-token TOKEN    Legacy token for update, delete or claim

Other options:
  --output FILE         Download destination
  -h, --help            Show this help

Environment:
  ARTIFACT_SERVICE_URL  Service URL (default: https://t-artifacts.t-tech.team)
  ARTIFACT_AUTH_TOKEN  Explicit Bearer token, takes priority over dp auth
  T_ARTIFACTS_TOKEN     Alias for ARTIFACT_AUTH_TOKEN
  ARTIFACT_NO_OPEN      Do not open the published artifact in a browser

Authentication:
  Uses ARTIFACT_AUTH_TOKEN or T_ARTIFACTS_TOKEN when set, otherwise dp auth print-token. A missing
  or rejected DP session starts dp auth login and retries the request once.
`;

async function dpToken(): Promise<string> {
  return new Promise((resolve, reject) => execFile('dp', ['auth', 'print-token'], {timeout: 20_000, maxBuffer: 1024 * 1024}, (error, stdout) => {
    const token = stdout.trim();
    if (error || !token) {
      reject(new Error('cannot get DP token, run dp auth login and try again'));
      return;
    }
    resolve(token);
  }));
}

async function dpLogin(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('dp', ['auth', 'login'], {stdio: 'inherit'});
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`dp auth login exited with code ${code ?? 'unknown'}`)));
  });
}

function config(env: Environment): Config {
  return {
    serviceUrl: (env.ARTIFACT_SERVICE_URL || DEFAULT_SERVICE_URL).replace(/\/+$/, ''),
    noOpen: Object.hasOwn(env, 'ARTIFACT_NO_OPEN'),
  };
}

function extractId(value = ''): string {
  if (!value) return '';
  let id = value;
  try {
    if (value.includes('://')) id = new URL(value).pathname.replace(/\/+$/, '').split('/').at(-1) ?? '';
  } catch {
    return value;
  }
  const currentIDLength = 22;
  if (id.length > currentIDLength && id[currentIDLength] === '-') return id.slice(0, currentIDLength);
  if (id.length === currentIDLength) return id;

  const legacyIDLength = 11;
  return id.length > legacyIDLength && id[legacyIDLength] === '-' ? id.slice(0, legacyIDLength) : id;
}

function contentType(path: string): 'html' | 'markdown' {
  const extension = extname(path).toLowerCase();
  if (extension === '.md') return 'markdown';
  if (extension === '.html' || extension === '.htm') return 'html';
  throw new Error(`unsupported file extension for ${path}: expected .html, .htm or .md`);
}

function parseFlags(args: string[], valueFlags: Set<string>): {positional: string[]; flags: Map<string, string>} {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (valueFlags.has(arg)) {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      flags.set(arg, value);
      index += 1;
    } else {
      positional.push(arg);
    }
  }
  return {positional, flags};
}

async function responseError(response: Response): Promise<never> {
  const body = (await response.text()).trim();
  throw new Error(`artifact service returned ${response.status} ${response.statusText}: ${body}`);
}

async function request(fetcher: Fetch, url: string, init?: RequestInit, expected = [200]): Promise<Response> {
  const response = await fetcher(url, {...init, signal: AbortSignal.timeout(30_000)});
  if (!expected.includes(response.status)) await responseError(response);
  return response;
}

type AuthRuntime = Required<Pick<Runtime, 'fetch' | 'stderr' | 'token' | 'login'>> & {authToken?: string};

async function authenticatedRequest(
  runtime: AuthRuntime,
  url: string,
  init: RequestInit,
  expected = [200],
  explicitToken?: string,
): Promise<Response> {
  let loggedIn = false;
  let token = explicitToken;
  if (!token) {
    try {
      token = runtime.authToken ?? await runtime.token();
    } catch {
      runtime.stderr('DP session is missing, starting dp auth login\n');
      await runtime.login();
      loggedIn = true;
      token = await runtime.token();
    }
  }

  const send = (value: string) => runtime.fetch(url, {
    ...init,
    headers: {...init.headers, authorization: `Bearer ${value}`},
    signal: AbortSignal.timeout(30_000),
  });
  let response = await send(token);
  if (response.status === 401 && !explicitToken && !runtime.authToken && !loggedIn) {
    runtime.stderr('DP session was rejected, starting dp auth login\n');
    await runtime.login();
    token = await runtime.token();
    response = await send(token);
  }
  if (!expected.includes(response.status)) await responseError(response);
  return response;
}

async function publish(args: string[], runtime: Required<Pick<Runtime, 'fetch' | 'stdout' | 'stderr' | 'open' | 'token' | 'login'>> & {env: Environment}): Promise<void> {
  const parsed = parseFlags(args, new Set(['--title', '--emoji', '--description', '--slug', '--id-or-url', '--edit-token']));
  if (parsed.positional.length !== 1) throw new Error('usage: artifact-publish <file> --emoji EMOJI [--title TITLE] [--description DESC] [--slug SLUG] [--id-or-url ID_OR_URL] [--edit-token EDIT_TOKEN]');
  const options: PublishOptions = {
    file: parsed.positional[0],
    title: parsed.flags.get('--title'),
    emoji: parsed.flags.get('--emoji'),
    description: parsed.flags.get('--description'),
    slug: parsed.flags.get('--slug'),
    idOrUrl: parsed.flags.get('--id-or-url'),
    editToken: parsed.flags.get('--edit-token'),
  };
  if (!options.emoji) throw new Error('--emoji is required: missing required flag');
  const id = extractId(options.idOrUrl);
  const cfg = config(runtime.env);
  const response = await authenticatedRequest(runtime, `${cfg.serviceUrl}/api/artifacts${id ? `/${id}` : ''}`, {
    method: id ? 'PUT' : 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      content: await readFile(options.file, 'utf8'),
      content_type: contentType(options.file),
      ...(options.title ? {title: options.title} : {}),
      emoji: options.emoji,
      ...(options.description ? {description: options.description} : {}),
      ...(options.slug ? {slug: options.slug} : {}),
    }),
  }, [200, 201], options.editToken);
  const result = await response.json() as {url: string};
  runtime.stdout(`${result.url}\n`);
  runtime.stderr("tip: for polished content, run npx -y @loyalty-personalization/artifact-publish skill get design or skill get dataviz\n");
  if (!cfg.noOpen) {
    try { await runtime.open(result.url); } catch (error) { runtime.stderr(`artifact-publish: failed to open browser: ${String(error)}\n`); }
  }
}

async function remove(args: string[], runtime: Required<Pick<Runtime, 'fetch' | 'stdout' | 'stderr' | 'token' | 'login'>> & {env: Environment}): Promise<void> {
  const parsed = parseFlags(args, new Set(['--edit-token']));
  if (parsed.positional.length !== 1) throw new Error('usage: artifact-publish delete <id-or-url> [--edit-token EDIT_TOKEN]');
  const id = extractId(parsed.positional[0]);
  if (!id) throw new Error('id or url is required');
  await authenticatedRequest(runtime, `${config(runtime.env).serviceUrl}/api/artifacts/${id}`, {method: 'DELETE'}, [204], parsed.flags.get('--edit-token'));
  runtime.stdout(`artifact ${parsed.positional[0]} deleted\n`);
}

async function download(args: string[], runtime: Required<Pick<Runtime, 'fetch' | 'stdout'>> & {env: Environment}): Promise<void> {
  const parsed = parseFlags(args, new Set(['--output']));
  if (parsed.positional.length !== 1) throw new Error('usage: artifact-publish download <id-or-url> [--output FILE]');
  const id = extractId(parsed.positional[0]);
  if (!id) throw new Error('id or url is required');
  const response = await request(runtime.fetch, `${config(runtime.env).serviceUrl}/api/artifacts/${id}/content`);
  const disposition = response.headers.get('content-disposition') ?? '';
  const suggested = /filename="?([^";]+)"?/i.exec(disposition)?.[1]
    ?? `artifact-${id}${response.headers.get('content-type')?.includes('markdown') ? '.md' : '.html'}`;
  const destination = parsed.flags.get('--output') ?? suggested;
  await writeFile(destination, Buffer.from(await response.arrayBuffer()), {mode: 0o600});
  runtime.stdout(`${destination}\n`);
}

async function claim(args: string[], runtime: Required<Pick<Runtime, 'fetch' | 'stdout' | 'stderr' | 'token' | 'login'>> & {env: Environment}): Promise<void> {
	const parsed = parseFlags(args, new Set(['--edit-token']));
	if (parsed.positional.length !== 1) throw new Error('usage: artifact-publish claim <id-or-url> --edit-token EDIT_TOKEN');
	const id = extractId(parsed.positional[0]);
	if (!id) throw new Error('claim: id or url is required');
	const editToken = parsed.flags.get('--edit-token');
	if (!editToken) throw new Error('edit token is required');
  const response = await authenticatedRequest(runtime, `${config(runtime.env).serviceUrl}/api/artifacts/${id}/claim`, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({edit_token: editToken}),
  });
  const result = await response.json() as {url: string};
  runtime.stdout(`claimed ${result.url}\n`);
}

async function list(runtime: Required<Pick<Runtime, 'fetch' | 'stdout' | 'stderr' | 'token' | 'login'>> & {env: Environment}): Promise<void> {
  const response = await authenticatedRequest(runtime, `${config(runtime.env).serviceUrl}/api/artifacts/mine`, {});
  const items = await response.json() as Array<{url: string; emoji: string; title: string; updated_at: string}>;
  if (items.length === 0) return runtime.stdout('no artifacts\n');
  for (const item of items) runtime.stdout(`${item.emoji || '📄'} ${item.title}\n${item.url}\n`);
}

async function rename(args: string[], runtime: Required<Pick<Runtime, 'fetch' | 'stdout' | 'stderr' | 'token' | 'login'>> & {env: Environment}): Promise<void> {
  const parsed = parseFlags(args, new Set(['--title']));
  if (parsed.positional.length !== 1) throw new Error('usage: artifact-publish rename <id-or-url> --title TITLE');
  const id = extractId(parsed.positional[0]);
  const title = parsed.flags.get('--title')?.trim();
  if (!id || !title) throw new Error('rename requires an id or URL and a non-empty title');
  const response = await authenticatedRequest(runtime, `${config(runtime.env).serviceUrl}/api/artifacts/${id}`, {
    method: 'PATCH', headers: {'content-type': 'application/json'},
    body: JSON.stringify({title}),
  });
  const result = await response.json() as {url: string};
  runtime.stdout(`${result.url}\n`);
}

async function skill(args: string[], runtime: Required<Pick<Runtime, 'fetch' | 'stdout'>> & {env: Environment}): Promise<void> {
  const serviceUrl = config(runtime.env).serviceUrl;
  if (args[0] === 'list' && args.length === 1) {
    const response = await request(runtime.fetch, `${serviceUrl}/skills`);
    const skills = await response.json() as Array<{name: string; description: string}>;
    for (const item of skills) runtime.stdout(`${item.name.padEnd(16)} ${item.description}\n`);
    return;
  }
  if (args[0] === 'get' && args.length > 1) {
    for (const name of args.slice(1)) {
      const response = await request(runtime.fetch, `${serviceUrl}/skills/${encodeURIComponent(name)}`);
      runtime.stdout(await response.text());
    }
    return;
  }
  throw new Error('usage: artifact-publish skill <list|get> [name...]');
}

async function openBrowser(url: string): Promise<void> {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  await new Promise<void>((resolve, reject) => execFile(command, args, {timeout: 5_000}, (error) => error ? reject(error) : resolve()));
}

export async function run(argv: string[], overrides: Runtime = {}): Promise<void> {
  const env = overrides.env ?? process.env;
  const runtime = {
    env,
    fetch: overrides.fetch ?? globalThis.fetch,
    stdout: overrides.stdout ?? ((value: string) => process.stdout.write(value)),
    stderr: overrides.stderr ?? ((value: string) => process.stderr.write(value)),
    open: overrides.open ?? openBrowser,
    authToken: env.ARTIFACT_AUTH_TOKEN?.trim() || env.T_ARTIFACTS_TOKEN?.trim() || undefined,
    token: overrides.token ?? dpToken,
    login: overrides.login ?? dpLogin,
  };
  const [command, ...args] = argv;
  if (command === '--help' || command === '-h' || command === 'help') return runtime.stdout(help);
  if (command === 'skill') return skill(args, runtime);
  if (command === 'delete') return remove(args, runtime);
	if (command === 'claim') return claim(args, runtime);
	if (command === 'list' && args.length === 0) return list(runtime);
	if (command === 'rename') return rename(args, runtime);
  if (command === 'download') return download(args, runtime);
  return publish(argv, runtime);
}

export async function main(): Promise<void> {
  try {
    await run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`artifact-publish: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
