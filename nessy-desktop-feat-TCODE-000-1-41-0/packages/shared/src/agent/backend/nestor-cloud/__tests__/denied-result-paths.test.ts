/**
 * **P3.323 — the results half of the `deniedPaths` floor, on the nestor-cloud
 * backend.**
 *
 * `settings-reference.md#permissions-deny` states three promises of the
 * sensitive-files floor, verbatim: *"Claude Code excludes matching files from
 * file discovery and search results, denies reads of them, and blocks the Edit
 * and Write tools on the matching paths."* The second and third are delivered by
 * the REQUEST gate this backend already has. The FIRST is a response-side filter
 * — and `NestorCloudToolExecutor` was the **second** production site that
 * constructs a `LocalToolRuntime`, built without one.
 *
 * The consequence is not hypothetical and it is the whole point of the row: a
 * `search_files` rooted one directory ABOVE a denied file passes the request gate
 * with a perfectly legal `path` argument, and the denied file's line — secret
 * value included — comes back in the result.
 *
 * ## Why every case here is a PAIR
 *
 * A withholding test that only asserts an absence cannot tell a working filter
 * from a rig that produced nothing to withhold. Each case below runs the
 * identical executor twice — once with the filter, once without — and the
 * unfiltered arm asserting the secret IS returned is what makes the filtered
 * arm's absence a finding rather than an artefact.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NestorCloudToolExecutor,
  type NestorCloudToolExecutorOptions,
} from '../tool-executor.ts';
import type { NestorToolCall } from '../event-adapter.ts';

const SECRET_VALUE = 'sk-live-P3323-4f2a';

function workspaceRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'nestor-p3323-')));
}

function testScope(primaryRoot: string) {
  return {
    session: { workspaceId: 'workspace-p3323', sessionId: 'session-p3323' },
    primaryRoot,
    cwd: primaryRoot,
    additionalRoots: [],
    managedExclusions: [],
    generation: 'g-p3323',
  };
}

function call(name: string, args: Record<string, unknown>): NestorToolCall {
  return { id: `call-${name}`, index: 0, name, arguments: JSON.stringify(args) };
}

/**
 * An executor over a scripted `rg` whose output names both files. The command is
 * stubbed rather than run so the case measures the FILTER and not whether
 * ripgrep is installed on the box.
 */
function executorFor(
  root: string,
  ordinary: string,
  secret: string,
  extra: Partial<NestorCloudToolExecutorOptions> = {},
): NestorCloudToolExecutor {
  return new NestorCloudToolExecutor({
    sessionKey: { workspaceId: 'workspace-p3323', sessionId: 'session-p3323' },
    abortSignal: new AbortController().signal,
    filesystemScope: testScope(root),
    // Allowed at the REQUEST gate on purpose: the point of the row is that a
    // legal request can carry a denied file back in its RESULT.
    permissionManager: { evaluateToolCall: () => ({ allowed: true }) },
    runCommand: async () => ({
      stdout: [
        `${ordinary}:4:const token = readToken()`,
        `${secret}:1:API_TOKEN=${SECRET_VALUE}`,
        `${ordinary}:9:log(token)`,
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    }),
    ...extra,
  });
}

function contentOf(result: { content?: string } | { result?: { content?: string } }): string {
  const direct = (result as { content?: string }).content;
  if (typeof direct === 'string') return direct;
  return (result as { result?: { content?: string } }).result?.content ?? JSON.stringify(result);
}

describe('P3.323 — a denied file is excluded from this backend\'s search results', () => {
  it('withholds the denied line, and the same rig WITHOUT the filter returns it', async () => {
    const root = workspaceRoot();
    const ordinary = join(root, 'src', 'app.ts');
    const secret = join(root, 'src', '.env');

    // POSITIVE CONTROL FIRST, so a later absence cannot be an empty rig: this is
    // the pre-row behaviour, and it is what shipped on this backend.
    const unfiltered = await executorFor(root, ordinary, secret)
      .execute(call('search_files', { path: 'src', regex: 'token' }));
    const before = contentOf(unfiltered);
    expect(before).toContain(SECRET_VALUE);
    expect(before).toContain(ordinary);

    const filtered = await executorFor(root, ordinary, secret, {
      filterDeniedResultPaths: paths => Promise.resolve(paths.filter(path => path === secret)),
    }).execute(call('search_files', { path: 'src', regex: 'token' }));
    const after = contentOf(filtered);

    // The secret VALUE is the thing that leaked.
    expect(after).not.toContain(SECRET_VALUE);
    // Naming the path would undo the exclusion the contract asks for.
    expect(after).not.toContain(secret);
    // …and the legitimate rows survive, so this is a filter and not a mute.
    expect(after).toContain(`${ordinary}:4:const token = readToken()`);
    expect(after).toContain(`${ordinary}:9:log(token)`);
  });

  it('the filter is asked for the paths the result names, not for the query', async () => {
    const root = workspaceRoot();
    const ordinary = join(root, 'src', 'app.ts');
    const secret = join(root, 'src', '.env');
    const asked: string[][] = [];

    await executorFor(root, ordinary, secret, {
      filterDeniedResultPaths: (paths) => {
        asked.push([...paths]);
        return Promise.resolve([]);
      },
    }).execute(call('search_files', { path: 'src', regex: 'token' }));

    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual(expect.arrayContaining([ordinary, secret]));
  });

  it('a filter that answers EMPTY withholds nothing — the honest status quo', async () => {
    // The fail-open direction the agent-side predicate takes on a throw. Asserted
    // here so "wired" can never be confused with "withholds unconditionally".
    const root = workspaceRoot();
    const ordinary = join(root, 'src', 'app.ts');
    const secret = join(root, 'src', '.env');

    const result = await executorFor(root, ordinary, secret, {
      filterDeniedResultPaths: () => Promise.resolve([]),
    }).execute(call('search_files', { path: 'src', regex: 'token' }));

    expect(contentOf(result)).toContain(SECRET_VALUE);
  });
});

describe('P3.323 — the agent supplies the filter, and reuses the one matcher', () => {
  const AGENT = fileURLToPath(new URL('../../../nestor-cloud-agent.ts', import.meta.url));

  it('the executor construction passes filterDeniedResultPaths', () => {
    // An option the executor accepts and the agent never passes is exactly the
    // state this row found — the filter existed and withheld nothing in
    // production. The behavioural cases above cannot see that, because they pass
    // it themselves.
    const source = readFileSync(AGENT, 'utf-8');
    expect(source).toContain('filterDeniedResultPaths: paths => Promise.resolve(this.deniedResultPaths(paths))');
  });

  it('the predicate is the SAME read as Pi\'s, not a second matcher', () => {
    // P3.272 refused a second matcher outright, on evidence: four defects shipped
    // out of the one compiler in a single day. `denyPathBlocked` is set by one
    // branch of the private `matchesDeniedPath`, ahead of every mode and rule
    // check, which is what makes the floor a floor.
    const source = readFileSync(AGENT, 'utf-8');
    expect(source).toContain("shouldAllowToolInMode('Read', { file_path: path }, mode, { permissionsContext })");
    expect(source).toContain('verdict.denyPathBlocked === true');
    // The mode is read LIVE rather than pinned, so the call cannot start meaning
    // something else if that ordering changes.
    expect(source).toContain('this.permissionManager.getPermissionMode()');
  });

  it('POSITIVE CONTROL: the wiring detector flags an agent with the option removed', () => {
    const stripped = readFileSync(AGENT, 'utf-8')
      .replace(/^\s*filterDeniedResultPaths: paths => Promise\.resolve\(this\.deniedResultPaths\(paths\)\),$/m, '');
    expect(stripped).not.toContain('filterDeniedResultPaths: paths =>');
  });
});
