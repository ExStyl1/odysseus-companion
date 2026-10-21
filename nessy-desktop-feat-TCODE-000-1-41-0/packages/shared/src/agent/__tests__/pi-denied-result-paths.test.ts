/**
 * P3.272 — the search-results half of the sensitive-files floor runs on Pi.
 *
 * `settings-reference.md#exclude-sensitive-files`, verbatim: *"Claude Code
 * excludes matching files from file discovery and search results, denies reads
 * of them, and blocks the Edit and Write tools on the matching paths."* The
 * request gate delivers the second and third promises. The FIRST is about the
 * RESPONSE, and `ea0085113` built the response-side filter with no production
 * caller: codex closes this half natively (P3.175, OS-enforced), the shipped
 * 2.1.223 does NOT deliver its own published clause (P3.174, measured — `Read`
 * of a denied `.env` was refused while `Grep` rooted one level above returned its
 * line WITH the secret), so Pi is the one runtime where the host must run it.
 *
 * ## What is real here and what is stubbed
 *
 * Real: the files, ripgrep, `LocalToolRuntime.grep`, `denied-result-filter.ts`,
 * and the host's answer — `PiAgent.handleDeniedResultPathsRequest` driven through
 * `dispatchSubprocessMessage`, i.e. the same switch a subprocess line reaches,
 * answering from the same `shouldAllowToolInMode` deny branch production uses.
 * Stubbed: only the pipe between them, because these two halves live in two
 * processes.
 *
 * The POSITIVE CONTROL is the whole point and is asserted first: the same run
 * with no filter returns the secret's line, so a green filtered run is evidence
 * of withholding rather than evidence of a search that found nothing (a missing
 * `rg` would otherwise read as a pass).
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BackendConfig } from '../backend/types.ts';
import { LocalToolRuntime, deniedResultsWithheldNotice, type LocalToolCall, type LocalToolOperation } from '../local-tools/index.ts';
import { PiAgent } from '../pi-agent.ts';
import { rgPath } from '@vscode/ripgrep';

/**
 * The repo's vendored ripgrep, since this host may have none on PATH — resolved
 * through the PACKAGE's own contract rather than through a path it no longer
 * produces (D1.440, measured 2026-09-20).
 *
 * `node_modules/@vscode/ripgrep/bin/` was right for the version that downloaded
 * its binary in a postinstall. At 1.18.0 that package declares NO `scripts` at
 * all and its `files` list is `lib/`, `LICENSE`, `README.md`: the binary now
 * ships in a per-platform OPTIONAL dependency, `@vscode/ripgrep-<platform>-<arch>`,
 * and `lib/index.js` exports the resolved path as `rgPath`. A `bin/rg` under the
 * parent package on a developer machine is a LEFTOVER of the older layout, which
 * is exactly why this suite passed here and failed on a fresh checkout.
 *
 * It cost the first chunked CI run all three of this describe's cases — the
 * CONTROL included, so every "withheld" assertion below was vacuous rather than
 * merely red — with the tool's own refusal ("This tool requires `rg`…") as the
 * received value. The remedy tried first, `bun pm trust @vscode/ripgrep` in the
 * install job, cannot work for the same reason: with no scripts to run, bun
 * answers "already trusted, don't have scripts to run, or don't exist" and exits
 * 1, which failed the whole pipeline at install.
 */
const RIPGREP_BIN_DIR = dirname(rgPath);

// `shouldAllowToolInMode` pulls a heavy module graph; bun's 5s default sits
// close to its resting cost on a cold graph, and this file also spawns ripgrep.
setDefaultTimeout(30_000);

let workspace: string;
/** The secret, ONE DIRECTORY BELOW the root the search is rooted at. */
let secret: string;
let ordinary: string;

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'pi-denied-results-')));
  mkdirSync(join(workspace, 'config'), { recursive: true });
  mkdirSync(join(workspace, 'src'), { recursive: true });
  // `*-service-account.json` rather than `.env`, and the reason is measurable:
  // ripgrep skips hidden files unless asked, so a dotfile secret never appears in
  // a `grep` result at all and the CONTROL below would pass for the wrong reason.
  // Both entries are on the same floor (`secure-deployment.md`'s exclusion table);
  // this one is the shape that actually reaches a search result.
  secret = join(workspace, 'config', 'deploy-service-account.json');
  ordinary = join(workspace, 'src', 'app.ts');
  writeFileSync(secret, '{ "private_key_token": "sk-live-4f2a" }\n');
  writeFileSync(ordinary, 'const token = readToken()\n');
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function agentConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-denied-results',
      name: 'Test Workspace',
      rootPath: workspace,
      workspaceRootPath: workspace,
      sessionRootPath: join(workspace, 'sessions'),
    },
    session: {
      id: 'session-denied-results',
      workspaceRootPath: workspace,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: workspace,
    },
    model: 'pi/test-model',
    isHeadless: true,
  } as unknown as BackendConfig;
}

/**
 * One host answer, obtained the way the subprocess obtains it: a
 * `denied_paths_request` into the real message switch, the reply read off
 * `send`. `mangle` corrupts the reply to pin the refusal direction.
 */
function askHost(
  paths: readonly string[],
  mangle?: (reply: Record<string, unknown>) => Record<string, unknown>,
): { denied: string[]; replies: Array<Record<string, unknown>> } {
  const agent = new PiAgent(agentConfig());
  const internals = agent as unknown as Record<string, any>;
  const replies: Array<Record<string, unknown>> = [];
  internals.send = (message: Record<string, unknown>) => {
    replies.push(mangle ? mangle(message) : message);
  };
  try {
    internals.dispatchSubprocessMessage('denied_paths_request', { requestId: 'req-1', paths: [...paths] });
  } finally {
    agent.destroy();
  }
  const reply = replies[0];
  const denied = Array.isArray(reply?.denied)
    ? (reply.denied as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : [];
  return { denied, replies };
}

function runtimeFor(filter?: (paths: readonly string[]) => Promise<readonly string[]> | readonly string[]) {
  return new LocalToolRuntime({
    filesystemScope: {
      session: { workspaceId: 'ws-denied-results', sessionId: 'session-denied-results' },
      primaryRoot: workspace,
      cwd: workspace,
      additionalRoots: [],
      managedExclusions: [],
      generation: 'g-denied-results',
    },
    permissionManager: { evaluateToolCall: () => ({ allowed: true }) },
    guardLargeResults: false,
    ...(filter ? { filterDeniedResultPaths: filter } : {}),
    // Real ripgrep, so the rows being filtered are rows a real search produced.
    // The vendored `@vscode/ripgrep` binary is put on PATH: this sandbox has no
    // system `rg`, and a missing binary here degrades into a diagnostic string
    // that would satisfy every `not.toContain` below. The CONTROL case is what
    // makes that failure loud instead.
    runCommand: async (command: string, cwd: string) => {
      const child = Bun.spawn(['sh', '-c', command], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, PATH: `${RIPGREP_BIN_DIR}:${process.env.PATH ?? ''}` },
      });
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { stdout, stderr, exitCode: await child.exited };
    },
  } as never);
}

function grepCall(): LocalToolCall {
  const operation: LocalToolOperation = { kind: 'grep', pattern: 'token', path: '.', literal: true, ignoreCase: true };
  return { id: 'call-p3272', displayName: 'Grep', operation, permission: { toolName: 'Grep', input: {} } };
}

describe('P3.272 — the host answers which result paths the deniedPaths floor withholds', () => {
  it('denies the sensitive file and leaves its neighbour alone', () => {
    const { denied } = askHost([secret, ordinary]);
    // POSITIVE: the floor's own `**/.env` entry, reached through the same
    // `denyPathBlocked` branch `SessionManager` and `codex-agent` read.
    expect(denied).toContain(secret);
    // NEGATIVE: a batch answered by denying everything would withhold every
    // result of every search, which is worse than the gap this row closes.
    expect(denied).not.toContain(ordinary);
  });

  it('answers the empty set for an empty or malformed batch instead of staying silent', () => {
    // A batch that goes unanswered suspends the search that asked for it.
    expect(askHost([]).replies).toHaveLength(1);
    expect(askHost([]).denied).toEqual([]);

    const agent = new PiAgent(agentConfig());
    const internals = agent as unknown as Record<string, any>;
    const replies: Array<Record<string, unknown>> = [];
    internals.send = (message: Record<string, unknown>) => { replies.push(message); };
    internals.dispatchSubprocessMessage('denied_paths_request', { requestId: 'req-2', paths: 'not-an-array' });
    agent.destroy();
    expect(replies).toHaveLength(1);
    expect(replies[0]?.type).toBe('denied_paths_response');
    expect(replies[0]?.denied).toEqual([]);
  });
});

describe('P3.272 — a real search rooted above the secret stops returning it', () => {
  it('CONTROL: with no filter wired, the secret\'s line comes back — the pre-row behaviour', async () => {
    const result = await runtimeFor().execute(grepCall());
    // If this fails, ripgrep is missing or the rig found nothing, and every
    // "withheld" assertion below would be vacuous.
    expect(result.content).toContain('sk-live-4f2a');
    expect(result.content).toContain('const token = readToken()');
  });

  it('withholds the denied file\'s line, keeps the rest, and says something was withheld', async () => {
    const asked: string[][] = [];
    const result = await runtimeFor(paths => {
      asked.push([...paths]);
      return askHost(paths).denied;
    }).execute(grepCall());

    // The secret VALUE is what leaked before the wiring.
    expect(result.content).not.toContain('sk-live-4f2a');
    // Neither the path nor its basename is named: naming it would undo the
    // exclusion the contract asks for.
    expect(result.content).not.toContain(secret);
    // The legitimate match survives — this is not a search that returned nothing.
    expect(result.content).toContain('const token = readToken()');
    // Honest, not silent: a shorter result set with no explanation teaches the
    // reader the file does not exist.
    expect(result.content).toContain(deniedResultsWithheldNotice(1));
    // The host was really consulted, with the secret among the candidates.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(secret);
  });

  it('a host that answers the empty set withholds nothing and adds no notice', async () => {
    // The refusal direction, end to end: a failed or unanswered batch degrades
    // to today's behaviour rather than to an empty result set.
    const result = await runtimeFor(() => []).execute(grepCall());
    expect(result.content).toContain('sk-live-4f2a');
    expect(result.content).not.toContain('withheld');
  });
});
