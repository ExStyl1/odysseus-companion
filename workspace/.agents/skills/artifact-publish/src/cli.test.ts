import assert from 'node:assert/strict';
import {mkdtemp, readFile, stat, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {DEFAULT_SERVICE_URL, run} from './cli.js';

const dpAuth = {token: async () => 'dp-token'};

test('ships an executable npm bin entrypoint', async () => {
  const entrypoint = new URL('../bin/artifact-publish.js', import.meta.url);
  assert.notEqual((await stat(entrypoint)).mode & 0o111, 0);
});

function output() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: (value: string) => { stdout += value; },
      stderr: (value: string) => { stderr += value; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

test('prints complete help without requiring a file or emoji', async () => {
  for (const argv of [['--help'], ['help']]) {
    const out = output();
    await run(argv, {env: {}, ...out.io});
    assert.match(out.stdout(), /Usage:/);
    assert.match(out.stdout(), /--slug/);
    assert.match(out.stdout(), /download/);
    assert.match(out.stdout(), /delete/);
    assert.match(out.stdout(), /claim/);
    assert.match(out.stdout(), /rename/);
    assert.match(out.stdout(), /skill get/);
    assert.match(out.stdout(), /ARTIFACT_SERVICE_URL/);
    assert.match(out.stdout(), /dp auth login/);
  }
});

test('accepts a current 22-character artifact URL for rename', async () => {
  let requested = '';
  await run(['rename', 'https://example/a/abcdefghijklmnopqrstuv-report', '--title', 'Report'], {
    env: {}, ...dpAuth, ...output().io,
    fetch: async (input) => {
      requested = String(input);
      return new Response(JSON.stringify({url: 'https://example/a/abcdefghijklmnopqrstuv-report'}));
    },
  });
  assert.equal(requested, `${DEFAULT_SERVICE_URL}/api/artifacts/abcdefghijklmnopqrstuv`);
});

test('uses the deployed service URL by default', async () => {
  const seen: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), 'artifact-publish-'));
  const file = join(dir, 'page.md');
  await writeFile(file, '# Hello');
  const out = output();

  await run([file, '--emoji', '🧪'], {
    env: {ARTIFACT_NO_OPEN: '1'},
	...dpAuth,
    fetch: async (input) => {
      seen.push(String(input));
      return new Response(JSON.stringify({id: 'abc', url: 'https://example/a/abc'}), {status: 201});
    },
    ...out.io,
  });

  assert.equal(DEFAULT_SERVICE_URL, 'https://t-artifacts.t-tech.team');
  assert.deepEqual(seen, [`${DEFAULT_SERVICE_URL}/api/artifacts`]);
  assert.match(out.stdout(), /https:\/\/example\/a\/abc/);
});

test('uses a delegated token from ARTIFACT_AUTH_TOKEN without calling dp auth', async () => {
  let authorization = '';
  await run(['list'], {
    env: {ARTIFACT_AUTH_TOKEN: 'delegated-jwt'},
    token: async () => { throw new Error('dp token must not be requested'); },
    login: async () => { throw new Error('dp login must not run'); },
    fetch: async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      return Response.json([]);
    },
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(authorization, 'Bearer delegated-jwt');
});

test('uses T_ARTIFACTS_TOKEN without calling dp auth', async () => {
  let authorization = '';
  await run(['list'], {
    env: {T_ARTIFACTS_TOKEN: 'delegated-jwt'},
    token: async () => { throw new Error('dp token must not be requested'); },
    login: async () => { throw new Error('dp login must not run'); },
    fetch: async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      return Response.json([]);
    },
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(authorization, 'Bearer delegated-jwt');
});

test('does not replace an explicitly configured delegated token after 401', async () => {
  let loginCalled = false;
  await assert.rejects(run(['list'], {
    env: {ARTIFACT_AUTH_TOKEN: 'delegated-jwt'},
    token: async () => 'dp-token',
    login: async () => { loginCalled = true; },
    fetch: async () => new Response(null, {status: 401, statusText: 'Unauthorized'}),
    stdout: () => {},
    stderr: () => {},
  }), /artifact service returned 401/);
  assert.equal(loginCalled, false);
});

test('sends a custom slug when publishing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artifact-publish-'));
  const file = join(dir, 'page.md');
  await writeFile(file, '# Hello');
  let body: unknown;

  await run([file, '--emoji', '🧪', '--slug', 'custom-name'], {
    env: {ARTIFACT_NO_OPEN: '1'},
	...dpAuth,
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({url: 'https://example/a/id-custom-name'}), {status: 201});
    },
    ...output().io,
  });

  assert.deepEqual(body, {
    content: '# Hello',
    content_type: 'markdown',
    emoji: '🧪',
    slug: 'custom-name',
  });
});

test('updates through the env override with bearer edit token', async () => {
  const requests: Array<{url: string; method: string; authorization: string | null}> = [];
  const server = createServer((request, response) => {
    requests.push({url: request.url ?? '', method: request.method ?? '', authorization: request.headers.authorization ?? null});
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({id: 'abcdefghijk', url: 'http://example/a/abcdefghijk'}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const dir = await mkdtemp(join(tmpdir(), 'artifact-publish-'));
  const file = join(dir, 'page.html');
  await writeFile(file, '<h1>Hello</h1>');

  try {
    await run([file, '--emoji', '🧪', '--id-or-url', 'https://t-artifacts.t-tech.team/a/I74r7_SGrNQf0eNLwpF3OQ-page-title', '--edit-token', 'token'], {
      env: {ARTIFACT_SERVICE_URL: `http://127.0.0.1:${address.port}`, ARTIFACT_NO_OPEN: '1'},
      ...output().io,
    });
  } finally {
    server.close();
  }

  assert.deepEqual(requests, [{url: '/api/artifacts/I74r7_SGrNQf0eNLwpF3OQ', method: 'PUT', authorization: 'Bearer token'}]);
});

test('downloads source to the server-suggested filename', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artifact-publish-'));
  const destination = join(dir, 'saved.md');
  let requested = '';
  await run(['download', 'https://t-artifacts.t-tech.team/a/I74r7_SGrNQf0eNLwpF3OQ-page-title', '--output', destination], {
    env: {},
    fetch: async (input) => {
      requested = String(input);
      return new Response('# source', {
        status: 200,
        headers: {'content-disposition': 'attachment; filename="source.md"'},
      });
    },
    ...output().io,
  });
  assert.equal(requested, `${DEFAULT_SERVICE_URL}/api/artifacts/I74r7_SGrNQf0eNLwpF3OQ/content`);
  assert.equal(await readFile(destination, 'utf8'), '# source');
});

test('lists skills from the service', async () => {
  const out = output();
  let requested = '';
  await run(['skill', 'list'], {
    env: {},
    fetch: async (input) => {
      requested = String(input);
      return new Response(JSON.stringify([
        {name: 'core', description: 'Core workflow'},
        {name: 'frontend-design', description: 'Frontend workflow'},
      ]), {status: 200});
    },
    ...out.io,
  });
  assert.equal(requested, `${DEFAULT_SERVICE_URL}/skills`);
  assert.match(out.stdout(), /core/);
  assert.match(out.stdout(), /frontend-design/);
});

test('gets skill content from the configured service', async () => {
  const out = output();
  const source = await readFile(new URL('../skilldata/core.md', import.meta.url), 'utf8');
  let requested = '';
  await run(['skill', 'get', 'core'], {
    env: {ARTIFACT_SERVICE_URL: 'https://artifacts.example'},
    fetch: async (input) => {
      requested = String(input);
      return new Response(source, {status: 200});
    },
    ...out.io,
  });
  const core = out.stdout();
  assert.equal(requested, 'https://artifacts.example/skills/core');
  assert.match(core, /npx -y @loyalty-personalization\/artifact-publish --help/);
  assert.match(core, /--slug/);
  assert.match(core, /--description/);
  assert.match(core, / download /);
  assert.match(core, / delete /);
  assert.match(core, / claim /);
  assert.match(core, /Mermaid support/);
  assert.doesNotMatch(core, /^\s*artifact-publish\s/m);
});

test('reports an unknown skill returned by the service', async () => {
  await assert.rejects(
    run(['skill', 'get', 'unknown'], {
      env: {},
      fetch: async () => new Response('skill not found', {status: 404, statusText: 'Not Found'}),
      ...output().io,
    }),
    /404 Not Found: skill not found/,
  );
});

test('deletes with the edit token', async () => {
  let request: {url: string; method: string; authorization: string | null} | undefined;
  const out = output();
  await run(['delete', 'https://t-artifacts.t-tech.team/a/I74r7_SGrNQf0eNLwpF3OQ-page-title', '--edit-token', 'secret'], {
    env: {},
    fetch: async (input, init) => {
      request = {url: String(input), method: String(init?.method), authorization: new Headers(init?.headers).get('authorization')};
      return new Response(null, {status: 204});
    },
    ...out.io,
  });
  assert.deepEqual(request, {
    url: `${DEFAULT_SERVICE_URL}/api/artifacts/I74r7_SGrNQf0eNLwpF3OQ`,
    method: 'DELETE',
    authorization: 'Bearer secret',
  });
  assert.match(out.stdout(), /deleted/);
});

test('claims a legacy artifact with DP auth and its edit token', async () => {
  const out = output();
  await run(['claim', 'https://t-artifacts.t-tech.team/a/I74r7_SGrNQf0eNLwpF3OQ-page-title', '--edit-token', 'old'], {
    env: {},
	...dpAuth,
    fetch: async (input, init) => {
      assert.equal(String(input), `${DEFAULT_SERVICE_URL}/api/artifacts/I74r7_SGrNQf0eNLwpF3OQ/claim`);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer dp-token');
	  assert.deepEqual(JSON.parse(String(init?.body)), {edit_token: 'old'});
      return new Response(JSON.stringify({url: 'https://example/a/I74r7_SGrNQf0eNLwpF3OQ'}), {status: 200});
    },
    ...out.io,
  });
  assert.match(out.stdout(), /claimed/);
});

test('lists artifacts owned by the current DP identity', async () => {
  const out = output();
  await run(['list'], {
    env: {}, ...dpAuth, ...out.io,
    fetch: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer dp-token');
      return new Response(JSON.stringify([{emoji: '📊', title: 'Report', url: 'https://example/a/id', updated_at: '2026-09-02T00:00:00Z'}]));
    },
  });
  assert.match(out.stdout(), /Report/);
  assert.match(out.stdout(), /https:\/\/example\/a\/id/);
});

test('runs DP login and retries once when the service rejects the current token', async () => {
  const tokens = ['expired', 'fresh'];
  const seen: string[] = [];
  let logins = 0;
  await run(['list'], {
    env: {}, ...output().io,
    token: async () => tokens.shift() ?? 'fresh',
    login: async () => { logins += 1; },
    fetch: async (_input, init) => {
      const authorization = new Headers(init?.headers).get('authorization') ?? '';
      seen.push(authorization);
      return authorization === 'Bearer expired'
        ? new Response(null, {status: 401})
        : Response.json([]);
    },
  });
  assert.equal(logins, 1);
  assert.deepEqual(seen, ['Bearer expired', 'Bearer fresh']);
});

test('runs DP login when no current token is available', async () => {
  let attempts = 0;
  let logins = 0;
  await run(['list'], {
    env: {}, ...output().io,
    token: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('missing token');
      return 'fresh';
    },
    login: async () => { logins += 1; },
    fetch: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fresh');
      return Response.json([]);
    },
  });
  assert.equal(logins, 1);
  assert.equal(attempts, 2);
});

test('does not run DP login for a rejected legacy edit token', async () => {
  let loggedIn = false;
  await assert.rejects(run(['delete', 'abcdefghijklmnopqrstuv', '--edit-token', 'legacy'], {
    env: {}, ...output().io,
    login: async () => { loggedIn = true; },
    fetch: async () => new Response(null, {status: 401}),
  }), /401/);
  assert.equal(loggedIn, false);
});

test('renames an owned artifact', async () => {
  const out = output();
  let requested = '';
  await run(['rename', 'https://t-artifacts.t-tech.team/a/I74r7_SGrNQf0eNLwpF3OQ-page-title', '--title', 'New title'], {
    env: {}, ...dpAuth, ...out.io,
    fetch: async (input, init) => {
      requested = String(input);
      assert.equal(init?.method, 'PATCH');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer dp-token');
      assert.deepEqual(JSON.parse(String(init?.body)), {title: 'New title'});
      return new Response(JSON.stringify({url: 'https://example/a/I74r7_SGrNQf0eNLwpF3OQ'}));
    },
  });
  assert.equal(requested, `${DEFAULT_SERVICE_URL}/api/artifacts/I74r7_SGrNQf0eNLwpF3OQ`);
  assert.match(out.stdout(), /I74r7_SGrNQf0eNLwpF3OQ/);
});

test('keeps a bare current id containing a hyphen intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artifact-publish-'));
  const destination = join(dir, 'saved.html');
  let requested = '';
  await run(['download', 'BCyJMx76oxh-z7fPmpzl7Q', '--output', destination], {
    env: {},
    fetch: async (input) => {
      requested = String(input);
      return new Response('# source', {status: 200});
    },
    ...output().io,
  });
  assert.equal(requested, `${DEFAULT_SERVICE_URL}/api/artifacts/BCyJMx76oxh-z7fPmpzl7Q/content`);
});

test('publish and list omit storage deadlines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artifact-publish-'));
  const file = join(dir, 'report.md');
  await writeFile(file, '# Report');
  const published = output();
  await run([file, '--emoji', '📄', '--id-or-url', 'id'], {
    env: {ARTIFACT_NO_OPEN: '1'}, ...dpAuth, ...published.io,
    fetch: async (_url, init) => {
      assert.equal(init?.method, 'PUT');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.retention_days, undefined);
      return Response.json({url: 'https://example/a/id'});
    },
  });
  assert.equal(published.stdout(), 'https://example/a/id\n');
  assert.doesNotMatch(published.stderr(), /expir|retention/);

  const listed = output();
  await run(['list'], {env: {}, ...dpAuth, ...listed.io, fetch: async () => Response.json([
    {title: 'Report', url: 'https://example/a/id'},
  ])});
  assert.match(listed.stdout(), /https:\/\/example\/a\/id/);
  assert.doesNotMatch(listed.stdout(), /expir|retention/);
});

 test('storage duration options are unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artifact-publish-'));
  const file = join(dir, 'report.md');
  await writeFile(file, '# Report');
  await assert.rejects(run([file, '--emoji', '📄', '--retention-days', '30'], {
    fetch: async () => { throw new Error('must not request'); },
  }), /usage:/);
  await assert.rejects(run(['retention', 'id', '--days', '30'], {
    fetch: async () => { throw new Error('must not request'); },
  }), /usage:/);
});
