/**
 * **P3.147 / P3.105, MEASURED — handing our floor to the SDK's own
 * `permissions.deny` closed the READ half and, from 2.1.223 to 2.1.247, did NOT
 * close the SEARCH-RESULTS half. At 2.1.251 the vendor closed it: driven
 * 2026-09-13 on C3.380's lift, all four exclusion facts inverted in one bump.
 * The refutation is kept as an INVERTED assertion, not deleted — see
 * §"THE DIVERGENCE IS REPAIRED BY THE VENDOR" below for the driven numbers and
 * for what this does and does not settle.**
 *
 * `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`, rows P3.147 and
 * P3.105.
 *
 * ## What the page promises, and what the binary does
 *
 * `settings-reference.md#exclude-sensitive-files` states three things of
 * `permissions.deny`, verbatim: *"Claude Code excludes matching files from file
 * discovery and search results, denies reads of them, and blocks the Edit and
 * Write tools on the matching paths."* P3.147 reasoned that handing our floor to
 * that key would therefore cover the RESULTS half "for free" — the half P3.105
 * could not implement from outside the binary.
 *
 * **Measured on the vendored `claude` 2.1.223 (darwin-arm64), it does not.**
 * With `Read(//**\/.env)` and `Edit(//**\/.env)` in `settings.permissions.deny`,
 * in ONE run:
 *
 * | Call | Outcome |
 * | --- | --- |
 * | `Read` the denied file | **DENIED** — *"File is in a directory that is denied by your permission settings."* |
 * | `Grep` rooted one level above it, `output_mode: content` | **returns the file's line, secret value included** |
 * | `Grep` same, `output_mode: files_with_matches` | **lists the file** |
 * | `Glob` `**\/*` rooted the same way | **lists the file** |
 *
 * So the second clause of that sentence holds and the FIRST clause — both
 * "file discovery" and "search results" — does not, at least for the `Grep` and
 * `Glob` tools reached through the SDK. This is the same asymmetry P3.105 named
 * on our own gate: the deny is enforced on the REQUEST and not on the RESPONSE.
 *
 * ## Why the denial is a control and not a confound
 *
 * The `Read` denial is what makes the two absences findings. It fires in the
 * SAME run, from the SAME `settings` object, against the SAME file — so the
 * settings reached the child, the rule compiled, and the rule matches that path.
 * An "the option was ignored" explanation is excluded by construction. The
 * `plain.txt` hits are the second control: the search genuinely ran and returned
 * something, so an empty result cannot be mistaken for enforcement.
 *
 * ## What this file is for
 *
 * Two things, and the second is why it is committed rather than thrown away.
 *
 * 1. It pins the READ half, which the mirror genuinely adds: a second,
 *    independent enforcement point inside the binary. That is worth having on
 *    its own — four separate defects in our own matcher shipped in a single day
 *    (P3.104, P3.108, P3.146, P3.150), and a mirror that does not share their
 *    code does not share their bugs.
 * 2. It pins the REFUTATION. If a future SDK bump starts filtering search
 *    results, THIS FILE GOES RED, and that red is good news: it means P3.105 can
 *    close natively and the honest limitation sentence P3.110 tracks can come
 *    out of the three doc paragraphs that carry it.
 *
 *    **That red arrived on 2026-09-13 at 2.1.251 and this paragraph is its
 *    receipt.** The assertion is inverted rather than removed, so the file now
 *    pins the REPAIR the same way it pinned the refutation. The paragraphs the
 *    sentence above points at are NOT rewritten by the lift lane: they are prose
 *    about what this product promises, they are not this lane's zone, and the
 *    correct text depends on the switch verdict for the host filter (kept). The
 *    lift hands them back with the measurement rather than editing them from a
 *    version number.
 *
 * ## The rig
 *
 * A fixture tree with two files carrying the same marker:
 *
 *   <root>/nested/.env         ← matched by the floor's `**\/.env` entry
 *   <root>/nested/plain.txt    ← matched by nothing
 *
 * The stub upstream answers each tool-carrying request with the next call in a
 * fixed script; the search is rooted at `<root>`, which is NOT itself denied, so
 * the calls are not refused and the question is only what comes back. `Grep`
 * and `Glob` are NOT in the binary's default tool set — measured: the first
 * attempt came back *"No such tool available: Grep"* — so they are requested
 * explicitly through `allowedTools`, which is also why `canUseTool` is not used
 * here (the SDK warns `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` for bare allowlist
 * entries).
 *
 * The binary is PINNED to the one we vendor and the env is scrubbed of every
 * `CLAUDE*`/`ANTHROPIC*` key first: a probe launched from inside a Claude Code
 * session inherits `CLAUDE_CODE_EXECPATH` and would otherwise measure a
 * different binary than the app ships. Same discipline as
 * `claude-auto-mode-classifier-e2e.test.ts`, whose stub this reuses.
 *
 * **Gated on `NESSY_CLAUDE_SDK_E2E=1`** — the native binary is a 272 MB
 * optional dependency, so a committed test that spawns it is a recorded local
 * run, not a CI gate.
 *
 *   NESSY_CLAUDE_SDK_E2E=1 bun test packages/shared/src/agent/__tests__/claude-denied-path-search-results-e2e.test.ts
 */
import { describe, expect, setDefaultTimeout, test } from 'bun:test';

import { bracedRegion } from '../../testing/source-regions.ts';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapDeniedPathsToClaudeRules } from '../claude-denied-path-rules.ts';
import { rewriteClaudeSearchOutput } from '../claude-search-result-filter.ts';

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

/** Unique enough that a hit cannot come from anywhere but the fixture. */
// P7.1, 2026-09-10 — the budget belongs to the FILE. The first test in this
// file pays the whole module graph: the manifest-readability CONTROL, which
// does nothing but parse one `package.json`, took 14.8 s against bun's 5 s
// default and failed as a timeout with no assertion failure. The gated arms
// already carry their own explicit 120 s budgets; this covers the ungated ones.
setDefaultTimeout(60_000);

const MARKER = 'NESSY_P3147_CREDENTIAL_MARKER_9f2c';

/**
 * The subset of the shipped floor this measurement needs. `**\/.env` is the
 * entry that covers the fixture, and it is the one whose translation is least
 * obvious (ours is filesystem-wide, so it becomes `//**\/.env`, not `**\/.env`).
 */
const FLOOR_SUBSET = ['**/.env', '**/.env.*'];

/** Path to the native binary we VENDOR, so the run measures what we ship. */
function vendoredClaudeBinary(): string | null {
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

const BINARY = vendoredClaudeBinary();
const ENABLED = process.env.NESSY_CLAUDE_SDK_E2E === '1' && BINARY !== null;

interface StubHandle {
  port: number;
  close: () => Promise<void>;
}

/** The scripted calls, in order. Each is issued on one tool-carrying request. */
function scriptedCalls(searchRoot: string): Array<{ name: string; input: Record<string, unknown> }> {
  return [
    { name: 'Grep', input: { pattern: MARKER, path: searchRoot, output_mode: 'content' } },
    { name: 'Grep', input: { pattern: MARKER, path: searchRoot, output_mode: 'files_with_matches' } },
    { name: 'Glob', input: { pattern: '**/*', path: searchRoot } },
    { name: 'Read', input: { file_path: join(searchRoot, 'nested', '.env') } },
  ];
}

/**
 * A loopback Anthropic Messages endpoint that walks the AGENT through
 * {@link scriptedCalls} one `tool_use` at a time, then ends the turn.
 */
async function startStub(searchRoot: string): Promise<StubHandle> {
  const calls = scriptedCalls(searchRoot);
  let step = 0;
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const path = (req.url ?? '').replace(/\?.*$/, '');
    if (req.method !== 'POST' || !path.endsWith('/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `stub: ${path}` } }));
      return;
    }
    let body: { model?: string; tools?: unknown[] } = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body;
    } catch { /* a malformed body is still a request */ }
    const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frame = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    frame('message_start', { type: 'message_start', message: { id: `msg_stub_${step}`, type: 'message', role: 'assistant', model: body.model ?? MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    if (toolCount > 0 && step < calls.length) {
      const call = calls[step]!;
      const useId = `toolu_${step}`;
      step += 1;
      frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: useId, name: call.name, input: {} } });
      frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } });
      frame('content_block_stop', { type: 'content_block_stop', index: 0 });
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } });
    } else {
      frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } });
      frame('content_block_stop', { type: 'content_block_stop', index: 0 });
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
    }
    frame('message_stop', { type: 'message_stop' });
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

/** The fixture: two files, one marker, one of them covered by the floor. */
function buildFixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-p3147-fixture-')));
  mkdirSync(join(root, 'nested'), { recursive: true });
  writeFileSync(join(root, 'nested', '.env'), `SECRET_TOKEN=${MARKER}\n`, 'utf8');
  writeFileSync(join(root, 'nested', 'plain.txt'), `harmless=${MARKER}\n`, 'utf8');
  return root;
}

interface ArmOutcome {
  /** One entry per scripted call, in order, as text. */
  results: string[];
  version: string | null;
}

/**
 * P6.63 — the host filter under measurement, as the runtime reaches it.
 *
 * The DENY DECISION here is a test-local predicate rather than the host's one
 * matcher, and deliberately: `shouldAllowToolInMode` needs a live permissions
 * context and a mode manager, neither of which a `sdk.query` arm has. What this
 * arm measures is the SEAM and the REWRITE — whether the binary asks our
 * `PostToolUse` hook at all, whether it accepts an `updatedToolOutput` of our
 * shape, and whether the denied line actually stops reaching the model. That
 * the production hook asks the ONE matcher is asserted separately, as a source
 * probe, in `claude-search-result-filter.test.ts`.
 */
const testFloorFilter = (paths: readonly string[]): readonly string[] =>
  paths.filter(path => /(^|[\\/])\.env$/.test(path));

/** Drive one turn with or without the mirrored floor, and with or without the host filter. */
async function runArm(mirrorFloor: boolean, hostFilter = false): Promise<ArmOutcome> {
  const searchRoot = buildFixture();
  const stub = await startStub(searchRoot);
  const configDir = mkdtempSync(join(tmpdir(), 'claude-p3147-cfg-'));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'claude-p3147-cwd-')));
  const sdk = await import('@anthropic-ai/claude-agent-sdk');

  const outcome: ArmOutcome = { results: [], version: null };

  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC)/i.test(key)),
  ) as Record<string, string>;

  const deny = mapDeniedPathsToClaudeRules(FLOOR_SUBSET).rules;

  const query = sdk.query({
    prompt: `search for ${MARKER}`,
    options: {
      cwd,
      model: MODEL,
      settingSources: [],
      permissionMode: 'default',
      pathToClaudeCodeExecutable: BINARY ?? undefined,
      // Grep/Glob are not in the binary's default tool set — the SDK typings say
      // so ("List Grep/Glob here or in `allowedTools` to get them") and the first
      // run of this rig confirmed it with "No such tool available: Grep".
      allowedTools: ['Grep', 'Glob', 'Read', 'Bash'],
      // The additional directory is what lets the tools reach the fixture at
      // all; without it the search root is outside every working directory and
      // every arm would come back empty for a reason that is not the floor.
      additionalDirectories: [searchRoot],
      ...(mirrorFloor ? { settings: { permissions: { deny: [...deny] } } } : {}),
      // P6.63 — the same hook shape `ClaudeAgent` installs, built from the same
      // module, so this arm measures the shipped rewrite rather than a copy.
      ...(hostFilter ? {
        hooks: {
          PostToolUse: [{ hooks: [async (input: unknown) => {
            const post = input as { tool_name?: string; tool_input?: { path?: string }; tool_response?: unknown };
            const rewrite = await rewriteClaudeSearchOutput({
              toolName: post.tool_name ?? '',
              toolResponse: post.tool_response,
              searchRoot: post.tool_input?.path ?? searchRoot,
              filter: testFloorFilter,
            });
            if (rewrite.kind !== 'rewritten') return { continue: true };
            return {
              continue: true,
              hookSpecificOutput: {
                hookEventName: 'PostToolUse',
                updatedToolOutput: rewrite.output,
                additionalContext: rewrite.notice,
              },
            };
          }] }],
        },
      } : {}),
      env: {
        ...inherited,
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`,
        ANTHROPIC_API_KEY: 'not-needed',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    } as never,
  });

  try {
    for await (const message of query) {
      const typed = message as {
        type: string;
        subtype?: string;
        claude_code_version?: string;
        message?: { content?: Array<{ type?: string; content?: unknown }> };
      };
      if (typed.type === 'system' && typed.subtype === 'init') outcome.version = typed.claude_code_version ?? null;
      if (typed.type === 'user' && Array.isArray(typed.message?.content)) {
        for (const block of typed.message.content) {
          if (block?.type === 'tool_result') outcome.results.push(JSON.stringify(block.content));
        }
      }
      if (typed.type === 'result') break;
    }
  } finally {
    await stub.close();
  }

  return outcome;
}

/** `[grepContent, grepFiles, glob, read]`, named so an assertion reads. */
function named(outcome: ArmOutcome): Record<'grepContent' | 'grepFiles' | 'glob' | 'read', string> {
  const [grepContent = '', grepFiles = '', glob = '', read = ''] = outcome.results;
  return { grepContent, grepFiles, glob, read };
}

describe.skipIf(!ENABLED)('P3.147 — the floor on the SDK deny surface, vendored binary', () => {
  test('CONTROL: with nothing handed over, every call succeeds and the secret is readable', async () => {
    const arm = named(await runArm(/*mirrorFloor*/ false));
    // The rig must be able to produce the exposure, or the treated arm's
    // absences prove nothing.
    expect(arm.grepContent).toContain('plain.txt');
    expect(arm.grepContent).toContain('.env');
    expect(arm.grepContent).toContain(MARKER);
    expect(arm.glob).toContain('.env');
    // And the read half is genuinely open before the mirror.
    expect(arm.read).not.toContain('denied by your permission settings');
  }, 120_000);

  test('the READ half closes — this is what the mirror buys, and the run\'s control', async () => {
    const arm = named(await runArm(/*mirrorFloor*/ true));
    expect(arm.read).toContain('denied by your permission settings');
    // Everything below is a finding only because this line passed: the settings
    // reached the child and the compiled rule matches that exact path.
  }, 120_000);

  test('the SEARCH-RESULTS half: WHAT THE BINARY DOES, as one comparable shape', async () => {
    const arm = named(await runArm(/*mirrorFloor*/ true));
    expect({
      // Controls first: the settings reached the child (the Read really is
      // refused) and the search really ran (the undenied file came back), so
      // neither an absence nor a presence below can be an empty result set.
      readRefused: arm.read.includes('denied by your permission settings'),
      searchRan: arm.grepContent.includes('plain.txt'),
      // The clause under measurement, four ways. `SECRET_TOKEN` is the
      // discriminating needle — the MARKER is in `plain.txt` too, so it proves
      // nothing on its own.
      grepContentNamesEnv: arm.grepContent.includes('.env'),
      grepContentLeaksSecret: arm.grepContent.includes('SECRET_TOKEN'),
      grepFilesNamesEnv: arm.grepFiles.includes('.env'),
      globNamesEnv: arm.glob.includes('.env'),
    }).toEqual({
      readRefused: true,
      searchRan: true,
      grepContentNamesEnv: false,
      grepContentLeaksSecret: false,
      grepFilesNamesEnv: false,
      globNamesEnv: false,
    });
  }, 120_000);

  /**
   * P6.63 — the same three assertions, INVERTED, with the host filter installed.
   *
   * Written while the vendor did NOT perform the first clause: this test is the
   * host doing the vendor's clause on the runtime's own `PostToolUse`
   * `updatedToolOutput` seam (P3.340: the seam "EXISTS and is deliberately
   * unused"). Since 2.1.251 the binary performs it too (see the header block),
   * so the arm above and this one now agree — and that AGREEMENT is the reason
   * to keep this one rather than to delete it: it is the only proof that the
   * rewrite we send is still ACCEPTED by the binary, and the rewrite fails OPEN.
   * Retiring the host filter is a switch verdict for the owner, not a lift's
   * decision; while it stands, this arm is what would notice the vendor taking
   * the behaviour away again.
   *
   * The rewrite fails OPEN — `hooks.md#posttooluse-decision-control`, "a value
   * that doesn't match the tool's output schema is ignored and the original
   * output is used" — so this arm is the only thing that can prove the shape we
   * send is accepted. A unit test cannot: it would pass just as happily against
   * a payload the binary silently discards.
   */
  test('P6.63 — with the host filter installed, the denied file leaves the RESULTS too', async () => {
    const arm = named(await runArm(/*mirrorFloor*/ true, /*hostFilter*/ true));

    // Control 1, unchanged from the arm above: the settings still reached the
    // child and the compiled rule still matches that exact path.
    expect(arm.read).toContain('denied by your permission settings');

    // Control 2: the searches genuinely ran and returned the undenied file, so
    // the absences below are enforcement rather than an empty result set.
    expect(arm.grepContent).toContain('plain.txt');
    expect(arm.grepContent).toContain(MARKER);
    expect(arm.grepFiles).toContain('plain.txt');
    expect(arm.glob).toContain('plain.txt');

    // The three inversions. `.env` is the denied entry; the marker still
    // appears above (from plain.txt), so its absence here would be no proof —
    // the file's own name and its SECRET_TOKEN line are what must be gone.
    expect(arm.grepContent).not.toContain('.env');
    expect(arm.grepContent).not.toContain('SECRET_TOKEN');
    expect(arm.grepFiles).not.toContain('.env');
    expect(arm.glob).not.toContain('.env');
  }, 120_000);
});

// ============================================================
// P3.174 · THE DIVERGENCE PIN, AND THE ONLY PART OF IT THAT ALWAYS RUNS.
//
// Everything above is gated on `NESSY_CLAUDE_SDK_E2E=1`, because it spawns a
// 272 MB native binary. That gate is right for the measurement and WRONG for the
// alarm: a divergence nobody re-measures is a divergence nobody notices closing.
// The row says so — *"it must be re-measured on any SDK bump, because a fix
// upstream silently changes what we owe"* — and on a default run the block above
// contributes ZERO executed tests, which is indistinguishable from a green.
//
// So the tripwire is separated from the measurement and costs one file read.
// When it goes red, nothing is broken: the bundle moved, and the gated block
// above has to be run by hand before any of the three rows it governs (P3.105,
// P3.147, P3.110) may be re-stated.
//
// This is a VENDOR divergence, recorded rather than filed as our bug. The page
// is `settings-reference.md#exclude-sensitive-files` and its promise is three
// clauses in one sentence, verbatim:
//
//   "Claude Code excludes matching files from file discovery and search results,
//    denies reads of them, and blocks the Edit and Write tools on the matching
//    paths."
//
// Measured on 2.1.223: clauses two and three hold, clause one does not — neither
// its "file discovery" half nor its "search results" half. Same shape as the
// auto-mode availability gate: the page is stricter than the binary.
//
// RE-MEASURED on 2.1.233 by S0-3 (2026-09-03), which is the bump the pin below
// was written in anticipation of. The divergence REPRODUCES: the gated arm ran
// against the new binary and every behavioural assertion in this file passed
// unchanged, so ten patch versions did not repair the first clause. The pin is
// therefore moved rather than merely bumped.
//
// RE-MEASURED AGAIN on 2.1.247 by P7.1 (2026-09-10), the same way and for the
// same reason. `NESSY_CLAUDE_SDK_E2E=1` against the newly vendored binary: 8
// tests, 0 skipped, all four gated arms green — the control's exposure, the READ
// half closing, the SEARCH-RESULTS half NOT closing, and P6.63's inverted arm
// with the host filter installed. (The same file run ungated reports `4 skip`,
// which is the control that the four really executed.) So fourteen more patch
// versions did not repair the first clause either, and the pin moves on a driven
// run rather than on a text substitution.
//
// THE DIVERGENCE IS REPAIRED BY THE VENDOR. Measured 2026-09-13 on the 2.1.251
// C3.380 lifted to, driven exactly as the two runs above were
// (`NESSY_CLAUDE_SDK_E2E=1`, 8 tests, 0 skipped). With the floor mirrored and NO
// host filter, every one of the four exclusion facts inverted in one bump:
//
//   readRefused            true   (control — the settings reached the child)
//   searchRan              true   (control — `plain.txt` came back)
//   grepContentNamesEnv    true -> FALSE
//   grepContentLeaksSecret true -> FALSE
//   grepFilesNamesEnv      true -> FALSE
//   globNamesEnv           true -> FALSE
//
// So clause one of `settings-reference.md#exclude-sensitive-files` — "excludes
// matching files from file discovery and search results" — is now PERFORMED,
// and the page and the binary agree for the first time since 2.1.223. The
// assertion is INVERTED rather than deleted: a regression that re-opens the leak
// fails here, which is the property the refutation was worth.
//
// Two independent readings put the repair in this release rather than somewhere
// in the fourteen versions before it, and they corroborate each other:
// `claude-bundle-version-triggers.test.ts`'s A49 entry fires at exactly 2.1.251
// on `errors.md#refusing-after-a-symlink-changed` — "Before v2.1.251, Claude
// Code re-checked a path's resolution only for file writes" — which is the same
// READ-and-SEARCH surface. 2.1.251 is where path enforcement reached those paths.
//
// THE SWITCH VERDICT, TAKEN — D1.163. The host filter P6.63 installs (the
// `PostToolUse` `updatedToolOutput` rewrite) is now belt-and-braces on claude,
// and the lift lane left the question open as a proposed row. That row is
// D1.163 and its answer is KEEP, under the delegated owner criterion that a
// `[product]` posture is stated and the default kept. The three reasons are in
// `claude-search-result-filter.ts`'s own docblock; the one that belongs HERE is
// the third — the vendor's repair is ONE reading on ONE version, and this file's
// version tripwire below is what makes it fall due again at the next bump.
// `hostFilterStillInstalled` is the arm that keeps the decision honest: it needs
// no credentials and no gate, so a silent retirement reddens on every run
// instead of on a sitting nobody has scheduled.
// ============================================================

/**
 * The vendored SDK the refutation was measured against. Both fields, see below.
 * 0.3.251 / 2.1.251 → 0.3.267 / 2.1.267 by F1.255 (2026-09-24), after the gated
 * arms were driven on the lifted bundle (`NESSY_CLAUDE_SDK_E2E=1`).
 *
 * 0.3.267 / 2.1.267 → 0.3.274 / 2.1.274 by F1.1213 (2026-10-01), again after the
 * gated arms were driven on the lifted bundle (`NESSY_CLAUDE_SDK_E2E=1`).
 *
 * 0.3.274 / 2.1.274 → 0.3.280 / 2.1.280 by UA12.211 (2026-10-10), the same way:
 * the gated arms were driven on the lifted bundle and every behavioural
 * assertion held; the only reds were the version equalities themselves (11
 * driven reds across the four e2e files, all `Expected "…274" / Received
 * "…280"`).
 */
const MEASURED_SDK_VERSION = '0.3.280';
const MEASURED_CLAUDE_CODE_VERSION = '2.1.280';

/** The floor entry the measurement rests on, and the rule it must still produce. */
const MEASURED_FLOOR_ENTRY = '**/.env';

function vendoredSdkManifest(): { version?: string; claudeCodeVersion?: string } {
  return JSON.parse(readFileSync(
    fileURLToPath(new URL(
      '../../../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json',
      import.meta.url,
    )),
    'utf8',
  )) as { version?: string; claudeCodeVersion?: string };
}

describe('D1.163 · the belt-and-braces filter is KEPT, and a silent retirement reddens here', () => {
  /**
   * The decision is KEEP (see the block above and
   * `claude-search-result-filter.ts`'s docblock). Its risk is not that someone
   * argues with it — it is that the filter stops being INSTALLED without anyone
   * arguing at all: the rewrite fails open, so a call site deleted in a refactor
   * produces no error, no diagnostic and no failing test. Every other pin in
   * this file is either gated behind `NESSY_CLAUDE_SDK_E2E=1` or is about the
   * vendored version, so none of them would notice.
   *
   * A SOURCE-TEXT window rather than a render: reaching the real call site means
   * spawning an SDK child, which is the gated arm; the honest instrument for
   * "does the wiring still exist" is the wiring. Anchored on the call and
   * bounded, per the reason the sibling worktree suite records — a `toMatch`
   * over a whole 12 000-line file prints all of it on failure.
   */
  test('the PostToolUse path still calls the rewrite, and still feeds it the denied-path floor', () => {
    const agent = readFileSync(
      fileURLToPath(new URL('../claude-agent.ts', import.meta.url)),
      'utf8',
    );

    const at = agent.indexOf('await rewriteClaudeSearchOutput({');
    expect(
      at,
      'the claude PostToolUse search-result rewrite is gone — if that is deliberate, '
      + 'D1.163 is being reversed and its three reasons need answering first',
    ).toBeGreaterThan(-1);

    // D1.111 — the call's own ARGUMENT object: the anchor ends in `({`, so the
    // region is exactly the four fields this claim is about.
    const window = bracedRegion(agent, at);
    // The filter argument is the half that carries the FLOOR. A rewrite wired to
    // something else would keep this call and withhold nothing.
    expect(window).toContain('this.deniedSearchResultPaths(paths)');
    // BOUNDARY CONTROL: the first branch below the call.
    expect(window).not.toContain("rewrite.kind === 'unchanged'");
    // And the import, so the call cannot be satisfied by a local shim.
    expect(agent).toContain("import { rewriteClaudeSearchOutput } from './claude-search-result-filter.ts';");
  });

  /** NEGATIVE CONTROL: the window instrument can fail, so its pass means something. */
  test('CONTROL — the region really is the call and stops at its closing brace', () => {
    const agent = readFileSync(
      fileURLToPath(new URL('../claude-agent.ts', import.meta.url)),
      'utf8',
    );
    const at = agent.indexOf('await rewriteClaudeSearchOutput({');
    expect(at).toBeGreaterThan(-1);
    const window = bracedRegion(agent, at);
    // D1.111 — and the NEEDLE changed with the bound, because the old one could
    // not fail. This case asserted `not.toContain('zzzNotACallSite')`, a name
    // that occurs NOWHERE in `claude-agent.ts`: it is outside the region however
    // far the region runs, so it passed identically before and after any bound
    // bug and proved only that a string had been read. `check-braced-region-controls.ts`
    // says so in those words, and it said so about this line. The needle is now
    // the first branch BELOW the call — inside the file, outside the region, and
    // swallowed the moment the bound runs away.
    expect(window).not.toContain("rewrite.kind === 'unchanged'");
    // …and the positive half, so a region that lost its text fails here rather
    // than passing the negative vacuously.
    expect(window).toContain('toolName: post.tool_name');
  });
});

describe('P3.174 · the search-results exclusion the vendor documented and, since 2.1.251, performs', () => {
  test('control: the vendored SDK manifest is readable and declares BOTH version fields', () => {
    // Without this, a missing or renamed field would make the two assertions
    // below compare `undefined` to a string — which fails, but for the wrong
    // reason and with a message that sends the reader after the wrong bug.
    const manifest = vendoredSdkManifest();
    expect(typeof manifest.version).toBe('string');
    expect(typeof manifest.claudeCodeVersion).toBe('string');
  });

  test('still the bundle the 2026-09-13 re-measurement was taken against — re-run the gated e2e if this is red', () => {
    // Two fields, not one: the npm version and the bundled CLI version move
    // independently. Pinning only one leaves the other free to change the
    // measured subject silently. (P3.223 landed that bump; both fields moved
    // together this time, which is not a guarantee about the next one.)
    const manifest = vendoredSdkManifest();
    expect(
      manifest.version,
      'the vendored @anthropic-ai/claude-agent-sdk moved; re-run '
      + 'NESSY_CLAUDE_SDK_E2E=1 bun test packages/shared/src/agent/__tests__/claude-denied-path-search-results-e2e.test.ts '
      + 'before re-stating P3.105, P3.147 or P3.110',
    ).toBe(MEASURED_SDK_VERSION);
    expect(manifest.claudeCodeVersion).toBe(MEASURED_CLAUDE_CODE_VERSION);
  });

  test('DIVERGENCE: the measurement\'s premise is still what the mirror produces', () => {
    // The gated run proved the binary returns the secret DESPITE a compiled deny
    // rule matching that exact path. That finding is only about the binary while
    // the rule is still produced: if the translator stopped emitting `Read`/`Edit`
    // for `**\/.env`, the same run would go quiet for OUR reason and the vendor
    // divergence would look repaired. Ungated, so it holds on every run.
    const mapping = mapDeniedPathsToClaudeRules([MEASURED_FLOOR_ENTRY]);
    expect(mapping.rules).toContain('Read(//**/.env)');
    expect(mapping.rules).toContain('Edit(//**/.env)');
    expect(mapping.rejected).toEqual([]);
  });

  test('all THREE clauses of the page sentence now hold, and the first one only since 2.1.251', () => {
    // Recorded as an assertion rather than only as prose so the three clauses
    // cannot be paraphrased apart over time. The page sentence is quoted in this
    // file's header; these are the three verdicts, taken against 2.1.223,
    // reproduced unchanged against 2.1.233 and 2.1.247, and the FIRST one
    // flipped by the vendor at 2.1.251 (driven 2026-09-13, C3.380 — the
    // measurement is in this file's header block).
    const verdicts = {
      'excludes matching files from file discovery and search results': 'HOLDS since 2.1.251',
      'denies reads of them': 'HOLDS',
      'blocks the Edit and Write tools on the matching paths': 'HOLDS',
    } as const;
    // No clause is refuted any more — asserted as a count so that re-refuting
    // one cannot pass by being written differently.
    expect(Object.values(verdicts).filter(v => v.startsWith('REFUTED'))).toHaveLength(0);
    expect(verdicts['excludes matching files from file discovery and search results'])
      .toBe('HOLDS since 2.1.251');
  });
});
