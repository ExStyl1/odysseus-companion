/**
 * P2.324 — the credential deny is asserted against the SANDBOX, not against the
 * TOML we emit.
 *
 * ## Why this file exists at all
 *
 * `sandbox-regression.test.ts` (the sibling) asserts that
 * `buildCodexConfigToml` emits `"<path>" = "deny"`. That is a statement about
 * our string builder and nothing else. Whether the codex binary HONOURS that
 * line is a separate proposition, and P2.306 (2026-08-28) measured that the two
 * have already diverged once — in our favour, by accident:
 *
 * codex's own permissions page says the older `sandbox_mode` key WINS over the
 * newer `default_permissions` profile system. Verbatim, from the intro of
 * `https://learn.chatgpt.com/docs/permissions` (`developers.openai.com/codex/permissions`
 * 308-redirects there; the sentence sits before the first heading, so no section
 * anchor covers it):
 *
 *   "If `sandbox_mode` appears in any loaded config file, you pass `--sandbox`,
 *   or the selected config profile sets `sandbox_mode`, Codex uses those older
 *   sandbox settings instead of `default_permissions`."
 *
 * and `learn.chatgpt.com/docs/permissions.md#migrate-from-older-sandbox-settings`,
 * verbatim:
 *
 *   "Use one system or the other for a session, not both."
 *
 * **The pinned binary does the opposite of that page.** On `rust-v0.148.0`
 * (`packages/codex-protocol/manifest.json`) the profile governs in BOTH
 * directions of a deliberate disagreement, so our `[permissions.nessy_runtime]`
 * deny is in force even though we also emit `sandbox_mode`. That page is marked
 * "Beta. Permission profiles are under active development and may change." — so
 * **do not read the citation above as authority for our behaviour.** It is
 * quoted here precisely because the binary contradicts it: the control we ship
 * rests on undocumented behaviour, and this file is the alarm that fires if a
 * future pin starts implementing the documented precedence instead.
 *
 * If this file goes red, the first hypothesis is NOT "the test is flaky". It is
 * "the codex pin changed and `credentials.enc` is now readable by agent shell
 * commands". Read `docs/superpowers/specs/2026-08-28-codex-sandbox-enforcement.md`
 * before touching anything here.
 *
 * ## What makes a green here mean something
 *
 * Every enforcement assertion is paired with a control in the same run, because
 * a rig that refuses everything would otherwise pass this file while proving
 * nothing:
 *
 * - `noProfile` — identical config with `deniedReadPaths: []`, so no profile is
 *   emitted at all. The decoy MUST be readable. This is the positive control for
 *   the whole rig (fixtures exist, the command runs, reads outside the workspace
 *   are otherwise allowed).
 * - `deniesUnrelated` — the profile ships, but denies some other path. The decoy
 *   MUST be readable. This discriminates "our deny line did it" from "the
 *   profile parent blocks every outside read", which would make the enforcement
 *   assertions pass for the wrong reason.
 * - `profileAccepted` — each enforcement case first asks the app-server whether
 *   it ACCEPTED `nessy_runtime`, because a rejected profile fails OPEN and is
 *   nearly invisible. See {@link profileAccepted}.
 *
 * ## Scope of what a green proves — narrower than it looks
 *
 * Measured on macOS arm64 (Seatbelt backend) against the pinned binary only.
 * Linux (Landlock) and the Windows sandbox implement precedence per-backend and
 * are NOT covered by a green here. The network half of permission profiles is
 * not probed. Approval escalation is removed as a variable rather than
 * characterised: every server→client request is answered `denied`, because an
 * ACCEPTED escalation can rerun a command unsandboxed and would confound the
 * reading.
 *
 * ## When it does not run
 *
 * The codex binary is a build-time download and is gitignored
 * (`apps/electron/.gitignore`: `resources/bin/codex/`), so CI's Linux container
 * has no binary and these tests SKIP there. Set
 * `NESSY_CODEX_SANDBOX_DETECTOR=required` to turn that skip into a failure —
 * that is the switch to flip on any runner that does stage the binary, so the
 * detector cannot silently stop running.
 */
import { test, expect, describe, afterAll, beforeAll } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodexConfigToml } from '../config-writer.ts';
import { startStubAdapter } from '../stub-server.ts';
import { AppServer } from './app-server-rig.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const BIN = join(
  REPO_ROOT,
  'apps', 'electron', 'resources', 'bin', 'codex',
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server',
);
const HAVE_BIN = existsSync(BIN);

/**
 * Fixtures live under `~/.cache`, NOT under `tmpdir()`, and that is load-bearing.
 *
 * codex's `workspace-write` treats `/tmp` and `TMPDIR` as writable by default
 * (`exclude_slash_tmp`), so a "the sandbox is enforcing" control built on a
 * tmpdir fixture passes with the sandbox off. P2.306's round 1 made exactly that
 * mistake and had to be thrown away. `~/.cache` is outside every default
 * writable root, which is what lets `writeOutsideWorkspace` discriminate.
 */
const ROOT = join(homedir(), '.cache', 'nessy-codex-sandbox-detector');
const WS = join(ROOT, 'ws');
const OUTSIDE_DIR = join(ROOT, 'outside');
const DECOY = join(OUTSIDE_DIR, 'credentials.enc');
const UNRELATED = join(OUTSIDE_DIR, 'unrelated.txt');
const SECRET = 'NESSY-SANDBOX-DETECTOR-SECRET-4c1e';

/**
 * P3.175's `**\/`-anchored half, inside the workspace. Two depths on purpose: `**\/X` must match
 * a file directly under the root as well as one nested, because `**\/` matching
 * ZERO directories is what makes the workspace spelling a faithful subset of "any
 * path ending /X" rather than "any path ending /a/…/X".
 */
const WS_NESTED = join(WS, 'a', 'b', 'c');
const WS_NESTED_ENV = join(WS_NESTED, '.env');
const WS_ROOT_NPMRC = join(WS, '.npmrc');

/**
 * A DISTINCT marker, and the reason is the one this file already learned once.
 *
 * The blocks above search from `ROOT` for {@link SECRET}. Giving these two
 * workspace fixtures that same marker made two PRE-EXISTING tests fail — their
 * `grep -rn` started finding this block's fixtures instead of only the decoy, so
 * a passing assertion turned red for a reason that had nothing to do with what it
 * asserts. Same shape as the `--exclude-dir=homes` finding recorded above: a rig
 * that searches a shared tree finds whatever else is in it.
 */
const WS_SECRET = 'NESSY-SANDBOX-DETECTOR-WORKSPACE-7b02';

/** Per-test budget. Spawning a ~178 MB binary and waiting out `initialize`
 * dominates; the assertions themselves are milliseconds. Generous because this
 * branch runs several lanes at once and timing is not part of any claim here. */
const BUDGET_MS = 180_000;

interface ExecOutcome {
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
}

/** The isolated CODEX_HOME for one variant. */
const homeFor = (name: string): string => join(ROOT, 'homes', name);

/** Boot an app-server against an isolated CODEX_HOME holding exactly `toml`. */
async function boot(name: string, toml: string): Promise<AppServer> {
  const home = homeFor(name);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.toml'), toml);

  const child = spawn(BIN, [], {
    cwd: WS,
    // An isolated CODEX_HOME is what keeps the host's own ~/.codex/config.toml
    // (and any managed profile allowlist) out of the measurement.
    env: { ...process.env, CODEX_HOME: home, COMPANY_LLM_API_KEY: 'loopback' },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  const server = new AppServer(child, { requestTimeoutMs: 120_000 });
  await server.request('initialize', {
    clientInfo: { name: 'nessy-sandbox-detector', title: null, version: '0.0.0' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  server.notify('initialized');
  return server;
}

async function exec(server: AppServer, command: string[]): Promise<ExecOutcome> {
  const r = await server.request('command/exec', { command, cwd: WS, timeoutMs: 15_000 }, 60_000) as {
    exitCode?: number; stdout?: string; stderr?: string;
  };
  return { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * The config under test, built the way `CodexAgent` builds it: by permission
 * MODE plus the T1 master switch, never by hand-writing `sandbox_mode`. Driving
 * the real derivation chain is the point — a detector that hardcoded the
 * emitted keys would not notice the mapping changing underneath it.
 */
function shippedToml(opts: {
  name: string;
  adapterPort: number;
  sandboxGloballyEnabled: boolean;
  deniedReadPaths: readonly string[];
  /** P3.175 — the `deniedPaths` credential floor, in OUR glob grammar. */
  deniedReadPatterns?: readonly string[];
}): string {
  return buildCodexConfigToml({
    codexHome: homeFor(opts.name),
    model: 'tgpt/qwen35-397b-a17b-fp8',
    adapterPort: opts.adapterPort,
    mode: 'default',
    sandboxGloballyEnabled: opts.sandboxGloballyEnabled,
    deniedReadPaths: opts.deniedReadPaths,
    ...(opts.deniedReadPatterns ? { deniedReadPatterns: opts.deniedReadPatterns } : {}),
  });
}

/**
 * Ask the app-server what it made of the profile we handed it.
 *
 * `permissionProfile/list` reports `allowed: false` for a profile the binary
 * REJECTED, and rejection is the dangerous direction: measured 2026-08-28, an
 * `extends` the binary does not support ( `:danger-full-access`, or a typo) is
 * refused with `Invalid configuration; using defaults` on STDERR ONLY — no RPC
 * error — and the whole config.toml is discarded. The credential deny vanishes,
 * while codex's own default `workspace-write` keeps refusing outside writes and
 * network, so from every angle except the credential read the session still
 * LOOKS sandboxed. That is a silent fail-open, and this is the in-band signal
 * for it.
 */
async function profileAccepted(server: AppServer): Promise<boolean | 'unknown'> {
  try {
    const listed = await server.request('permissionProfile/list', {}, 30_000) as {
      data?: { id?: string; allowed?: boolean }[];
    };
    const ours = listed.data?.find((p) => p.id === 'nessy_runtime');
    return ours ? ours.allowed === true : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** One `command/exec` probe of the decoy read, over a freshly booted server. */
async function readDecoyUnder(name: string, toml: string): Promise<ExecOutcome & { profileAccepted: boolean | 'unknown' }> {
  const server = await boot(name, toml);
  try {
    const accepted = await profileAccepted(server);
    const outcome = await exec(server, ['/bin/cat', DECOY]);
    return { ...outcome, profileAccepted: accepted };
  } finally {
    server.kill();
  }
}

beforeAll(() => {
  if (!HAVE_BIN) return;
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(WS, { recursive: true });
  mkdirSync(OUTSIDE_DIR, { recursive: true });
  writeFileSync(DECOY, `${SECRET}\n`);
  writeFileSync(UNRELATED, 'not a secret\n');
  writeFileSync(join(WS, 'README.md'), 'workspace\n');
  mkdirSync(WS_NESTED, { recursive: true });
  writeFileSync(WS_NESTED_ENV, `TOKEN=${WS_SECRET}\n`);
  writeFileSync(WS_ROOT_NPMRC, `//registry.example.com/:_authToken=${WS_SECRET}\n`);
});

afterAll(() => {
  if (!HAVE_BIN) return;
  rmSync(ROOT, { recursive: true, force: true });
});

describe('codex sandbox — the detector is armed', () => {
  test('the pinned codex binary is present, or the skip is deliberate', () => {
    if (HAVE_BIN) {
      expect(HAVE_BIN).toBe(true);
      return;
    }
    const required = process.env.NESSY_CODEX_SANDBOX_DETECTOR === 'required';
    if (required) {
      throw new Error(
        `NESSY_CODEX_SANDBOX_DETECTOR=required but no codex binary at ${BIN}. `
        + 'The credential-deny enforcement detector did NOT run on this host.',
      );
    }
    console.warn(
      `[sandbox-detector] SKIPPED: no codex binary at ${BIN}. `
      + 'Enforcement of the credentials.enc deny was NOT verified in this run. '
      + 'Set NESSY_CODEX_SANDBOX_DETECTOR=required to make this a failure.',
    );
    expect(HAVE_BIN).toBe(false);
  });
});

describe.if(HAVE_BIN)('codex sandbox — the credentials.enc deny is ENFORCED, not merely emitted', () => {
  test('control: with NO profile the decoy IS readable (the rig can read, and reads outside the workspace are otherwise allowed)', async () => {
    const outcome = await readDecoyUnder('control_no_profile', shippedToml({
      name: 'control_no_profile', adapterPort: 1, sandboxGloballyEnabled: false, deniedReadPaths: [],
    }));
    expect(outcome.stdout).toContain(SECRET);
    expect(outcome.exitCode).toBe(0);
  }, BUDGET_MS);

  test('control: with a profile that denies an UNRELATED path the decoy IS readable (so a refusal below is our deny line, not the profile parent)', async () => {
    const outcome = await readDecoyUnder('control_denies_unrelated', shippedToml({
      name: 'control_denies_unrelated', adapterPort: 1, sandboxGloballyEnabled: false, deniedReadPaths: [UNRELATED],
    }));
    expect(outcome.stdout).toContain(SECRET);
    expect(outcome.exitCode).toBe(0);
  }, BUDGET_MS);

  test('SHIPPED DEFAULT (sandbox master switch OFF): the profile is ACCEPTED and the decoy read is REFUSED', async () => {
    const outcome = await readDecoyUnder('shipped_switch_off', shippedToml({
      name: 'shipped_switch_off', adapterPort: 1, sandboxGloballyEnabled: false, deniedReadPaths: [DECOY],
    }));
    // Fail-open guard first: a REJECTED profile silently drops the deny while
    // the session still looks sandboxed from every other angle.
    expect(outcome.profileAccepted).toBe(true);
    expect(outcome.stdout).not.toContain(SECRET);
    expect(outcome.exitCode).not.toBe(0);
  }, BUDGET_MS);

  test('sandbox master switch ON: the profile is ACCEPTED and the decoy read is REFUSED', async () => {
    const outcome = await readDecoyUnder('shipped_switch_on', shippedToml({
      name: 'shipped_switch_on', adapterPort: 1, sandboxGloballyEnabled: true, deniedReadPaths: [DECOY],
    }));
    expect(outcome.profileAccepted).toBe(true);
    expect(outcome.stdout).not.toContain(SECRET);
    expect(outcome.exitCode).not.toBe(0);
  }, BUDGET_MS);
});

/**
 * The second oracle. `command/exec` runs "in the server sandbox without creating
 * a thread or turn" (`packages/codex-protocol/generated/v2/CommandExecParams.ts`),
 * which answers "which config key wins" but not "what does the AGENT get to
 * do". This one runs a real `turn/start` whose model is the in-tree stub
 * Responses adapter, canned to call codex's native `exec_command` with
 * `cat <decoy>`, and reads the answer off the wire the model actually sees: the
 * `function_call_output` carried by the SECOND Responses request.
 */
async function agentTurnLeaksSecret(name: string, deniedReadPaths: readonly string[]): Promise<{
  leaked: boolean; toolOutput: string; requests: number; escalations: string[];
}> {
  const bodies: string[] = [];
  const stub = await startStubAdapter({
    toolName: 'exec_command',
    toolArguments: { cmd: `cat ${DECOY}` },
    onRequestBody: (b) => bodies.push(b),
  });
  let server: AppServer | undefined;
  try {
    server = await boot(name, shippedToml({
      name, adapterPort: stub.port, sandboxGloballyEnabled: false, deniedReadPaths,
    }));
    const started = await server.request('thread/start', {
      cwd: WS, model: 'tgpt/qwen35-397b-a17b-fp8',
    }, 60_000) as { thread?: { id?: string }; threadId?: string };
    const threadId = started.thread?.id ?? started.threadId;
    await server.request('turn/start', {
      threadId, input: [{ type: 'text', text: 'read the file', text_elements: [] }],
    }, 60_000);
    await server.waitForTurn(90_000);
  } finally {
    server?.kill();
    await stub.close();
  }
  const second = bodies[1] ?? '';
  const match = second.match(/"output"\s*:\s*("(?:[^"\\]|\\.)*")/);
  return {
    leaked: second.includes(SECRET),
    toolOutput: match?.[1] ?? '(no function_call_output on the second request)',
    requests: bodies.length,
    // D1.236 — the rig's refusal list, read here for the first time. See the
    // assertions below and `app-server-rig.ts`'s header.
    escalations: [...(server?.serverRequests ?? [])],
  };
}

describe.if(HAVE_BIN)('codex sandbox — a real agent turn never sees the credential', () => {
  test('control: with NO profile the agent DOES receive the secret (the leak detector discriminates)', async () => {
    const result = await agentTurnLeaksSecret('turn_control_no_profile', []);
    expect(result.requests).toBeGreaterThanOrEqual(2);
    expect(result.leaked).toBe(true);
    // D1.236 — see the assertion in the case below; here it is the control's
    // own baseline, on the arm where NOTHING is denied and so nothing could be
    // escalated about.
    expect(result.escalations).toEqual([]);
  }, BUDGET_MS);

  test('SHIPPED DEFAULT: the secret never reaches the model', async () => {
    const result = await agentTurnLeaksSecret('turn_shipped_default', [DECOY]);
    expect(result.requests).toBeGreaterThanOrEqual(2);
    expect(result.leaked).toBe(false);
    expect(result.toolOutput).not.toContain(SECRET);
    // D1.236 — THE READER the rig's `serverRequests` was written for and never
    // had. Every server→client request this rig receives is REFUSED
    // (`{ decision: 'denied' }`), and the reason that refusal is load-bearing is
    // that an ACCEPTED escalation can rerun the command OUTSIDE the sandbox:
    // the turn would then not leak, the case would go green, and the greenness
    // would be about the rig's answer rather than about the sandbox.
    //
    // So the field is not merely documented — it is now asserted, and the
    // expected value is the empty list: on this arm the deny is compiled into
    // the OS wrap (an `excluded_subpath` / `deny file-read*` in the Seatbelt
    // profile), which cannot be escalated to, so codex has nothing to ask
    // about. A non-empty list here would mean the binary started routing this
    // read through an approval — a different mechanism from the one the whole
    // block measures — and the message names what arrived.
    expect(result.escalations).toEqual([]);
  }, BUDGET_MS);
});

/**
 * P3.175 — the half `settings-reference.md` promises and the Claude binary does
 * not deliver: **excluding a denied file from SEARCH RESULTS.**
 *
 * P3.174 measured that on `claude` 2.1.223, with the same settings object that
 * DENIED a `Read` of the decoy in the same run, `Grep` rooted one level above
 * returned the line containing the secret and `Glob` listed the file. That is a
 * tool-mediated deny: the search tool never consults the rule.
 *
 * Codex's deny is not tool-mediated. A profile deny compiles into the OS wrap —
 * on macOS an `excluded_subpath` on the read root, and for glob entries a literal
 * `(deny file-read* (regex …))` in the Seatbelt profile
 * (`codex-rs/sandboxing/src/seatbelt.rs`, `build_seatbelt_unreadable_glob_policy`,
 * `rust-v0.150.1` — and that file gained 242 lines of Seatbelt hardening under
 * the lift, #39599 #39623 #39706, so it is one to re-read by BODY and not only
 * by name) — so it binds
 * every process in the sandbox, `grep` included. This block measures that
 * directly, because "OS-enforced, therefore it must" is reasoning, and the last
 * time this plan reasoned about codex's sandbox the binary did the opposite of
 * its own page (P2.306).
 *
 * Every assertion is paired with a control in the same shape as the block above:
 * with no profile the same `grep` MUST return the line, or a green here proves
 * only that the rig cannot search.
 */
async function execUnder(name: string, toml: string, commands: string[][]): Promise<{
  profileAccepted: boolean | 'unknown';
  outcomes: ExecOutcome[];
}> {
  const server = await boot(name, toml);
  try {
    const accepted = await profileAccepted(server);
    const outcomes: ExecOutcome[] = [];
    for (const command of commands) outcomes.push(await exec(server, command));
    return { profileAccepted: accepted, outcomes };
  } finally {
    server.kill();
  }
}

/**
 * One probe's outcome, by position — failing LOUDLY when the probe did not run.
 *
 * Not a non-null assertion: a missing outcome means a `command/exec` never
 * happened, and a silent `undefined` would turn that into a passing
 * `not.toContain(SECRET)`. An absence assertion whose subject never existed is
 * exactly the shape this file exists to refuse.
 */
function probe(outcomes: readonly ExecOutcome[], index: number): ExecOutcome {
  const outcome = outcomes[index];
  if (!outcome) {
    throw new Error(`probe ${index} did not run (${outcomes.length} outcome(s) recorded)`);
  }
  return outcome;
}

/**
 * `grep -rn` for the secret, `grep -rln` for the file NAME, both rooted TWO
 * levels above the decoy, plus an `ls` of its directory to separate the RESULTS
 * half from the DISCOVERY half.
 *
 * `--exclude-dir=homes` is load-bearing and was found by this file going red:
 * `homes/` holds the per-variant `CODEX_HOME`s, and **codex persists every tool
 * output to its own rollout record** (`<home>/sessions/<date>/rollout-*.jsonl`).
 * The leak CONTROL in the block above deliberately lets a turn read the decoy,
 * so its rollout carries the secret verbatim — a second on-disk copy, written by
 * codex, outside anything our deny governs. Excluding that directory keeps this
 * block measuring the fixture rather than the previous test's exhaust; the
 * durable-rollout fact itself is a finding, not a test artefact.
 */
const SEARCH_PROBES = [
  ['/usr/bin/grep', '-rn', '--exclude-dir=homes', SECRET, ROOT],
  ['/usr/bin/grep', '-rln', '--exclude-dir=homes', SECRET, ROOT],
  ['/bin/ls', '-1', OUTSIDE_DIR],
];

describe.if(HAVE_BIN)('codex sandbox — the SEARCH RESULTS half the Claude binary leaves open', () => {
  test('control: with NO profile a shell grep rooted above the decoy RETURNS THE SECRET', async () => {
    const { outcomes } = await execUnder('search_control_no_profile', shippedToml({
      name: 'search_control_no_profile', adapterPort: 1, sandboxGloballyEnabled: false, deniedReadPaths: [],
    }), SEARCH_PROBES);
    // This is the P3.174 shape reproduced on codex with the protection removed:
    // without it, exactly what leaked out of Claude leaks out of here.
    expect(probe(outcomes, 0).stdout).toContain(SECRET);
    expect(probe(outcomes, 1).stdout).toContain(DECOY);
    expect(probe(outcomes, 2).stdout).toContain('credentials.enc');
  }, BUDGET_MS);

  test('SHIPPED DEFAULT: the same grep returns NOTHING, and the files-mode grep does not list it', async () => {
    const { profileAccepted: accepted, outcomes } = await execUnder('search_shipped_default', shippedToml({
      name: 'search_shipped_default', adapterPort: 1, sandboxGloballyEnabled: false, deniedReadPaths: [DECOY],
    }), SEARCH_PROBES);
    expect(accepted).toBe(true);
    // The RESULTS half — closed. Both output modes.
    expect(probe(outcomes, 0).stdout).not.toContain(SECRET);
    expect(probe(outcomes, 0).stderr).toContain('Operation not permitted');
    expect(probe(outcomes, 1).stdout).not.toContain(DECOY);
    // The DISCOVERY half — still OPEN for a FILE-scoped deny: the name is listed,
    // only the content is refused. Recorded as measured rather than claimed shut;
    // the container-scoped deny below is the shape that closes it.
    expect(probe(outcomes, 2).stdout).toContain('credentials.enc');
  }, BUDGET_MS);
});

/**
 * P3.175 — the floor mirror end to end: OUR pattern grammar in, codex's own
 * home expansion and OS deny out.
 *
 * The pattern is `~/`-anchored on purpose. Nothing in this process expands it:
 * the string `~/.cache/…/outside/**` is container-stripped by
 * `mapDeniedPathsToCodexFilesystemKeys` and handed to codex as `~/.cache/…/outside`,
 * and `AbsolutePathBuf::maybe_expand_home_directory` splices in the home. A green
 * here is therefore also the evidence that P3.108's Windows separator defect
 * cannot arise on this path — there is no pattern string to mis-escape.
 */
const FLOOR_PATTERN = `~/.cache/nessy-codex-sandbox-detector/outside/**`;
const FLOOR_PATTERN_ELSEWHERE = `~/.cache/nessy-codex-sandbox-detector/no-such-dir/**`;

describe.if(HAVE_BIN)('codex sandbox — the deniedPaths floor mirror (P3.175)', () => {
  test('control: a floor pattern pointing ELSEWHERE leaves the decoy readable', async () => {
    const { outcomes } = await execUnder('floor_control_elsewhere', shippedToml({
      name: 'floor_control_elsewhere', adapterPort: 1, sandboxGloballyEnabled: false,
      deniedReadPaths: [], deniedReadPatterns: [FLOOR_PATTERN_ELSEWHERE],
    }), [['/bin/cat', DECOY], ...SEARCH_PROBES]);
    expect(probe(outcomes, 0).stdout).toContain(SECRET);
    expect(probe(outcomes, 1).stdout).toContain(SECRET);
  }, BUDGET_MS);

  test('a `~/`-anchored floor pattern denies the container — content AND name', async () => {
    const { profileAccepted: accepted, outcomes } = await execUnder('floor_mirrored', shippedToml({
      name: 'floor_mirrored', adapterPort: 1, sandboxGloballyEnabled: false,
      // No host deny at all — the profile exists ONLY because the floor mirrored.
      deniedReadPaths: [], deniedReadPatterns: [FLOOR_PATTERN],
    }), [['/bin/cat', DECOY], ...SEARCH_PROBES]);
    expect(accepted).toBe(true);
    expect(probe(outcomes, 0).stdout).not.toContain(SECRET);
    expect(probe(outcomes, 0).exitCode).not.toBe(0);
    // RESULTS half closed…
    expect(probe(outcomes, 1).stdout).not.toContain(SECRET);
    expect(probe(outcomes, 2).stdout).not.toContain(DECOY);
    // …and, because the container spelling denies the DIRECTORY, so is discovery.
    expect(probe(outcomes, 3).stdout).not.toContain('credentials.enc');
    expect(probe(outcomes, 3).exitCode).not.toBe(0);
  }, BUDGET_MS);
});

/**
 * P3.175 — **the `**\/`-anchored half.** The half this row was held at 🟨 for.
 *
 * Part of the shipped floor mirrors as `~/`-anchored keys; the rest is
 * `**\/`-anchored, and its faithful codex spelling is root-anchored, which
 * Windows refuses and Linux makes fatal. So on codex that half reached NO
 * enforcement anywhere — our own gate does not deny independently there, and
 * codex was never told.
 *
 * P6.1063 — this paragraph said *"ten of the nineteen … the other nine"* and
 * the sentence became false while nothing pointed at it: the floor is 13 + 11
 * of 24 since `7b7582387` and `e6296c0f7`. The membership is pinned once, in
 * `config-writer-denied-path-mirror.test.ts`; the partition is described here
 * by its SHAPE so the prose cannot rot again on the next entry.
 *
 * `:workspace_roots` closes them, and the reason it is portable is that it is not
 * a PATH: `compile_filesystem_permission` (`core/src/config/permissions.rs:521-566`,
 * `rust-v0.148.0`) resolves the base key through `parse_special_path` and hands a
 * glob subpath with `deny` access to `compile_scoped_filesystem_pattern`, which
 * returns the symbolic `codex-project-roots://<subpath>`. No platform path parser
 * ever sees it. That is the SOURCE argument; this block is the binary.
 *
 * Controls in the same shape as every other block here — a green without them
 * would prove only that the rig cannot read.
 */
const NINE_PROBES = [
  ['/bin/cat', WS_NESTED_ENV],
  ['/bin/cat', WS_ROOT_NPMRC],
  ['/usr/bin/grep', '-rn', '--exclude-dir=homes', WS_SECRET, WS],
];

describe.if(HAVE_BIN)('codex sandbox — the `**\\/`-anchored floor entries (P3.175)', () => {
  test('control: with NO profile both workspace credentials leak and a grep returns them', async () => {
    const { outcomes } = await execUnder('nine_control_no_profile', shippedToml({
      name: 'nine_control_no_profile', adapterPort: 1, sandboxGloballyEnabled: false,
      deniedReadPaths: [],
    }), NINE_PROBES);
    expect(probe(outcomes, 0).stdout).toContain(WS_SECRET);
    expect(probe(outcomes, 1).stdout).toContain(WS_SECRET);
    expect(probe(outcomes, 2).stdout).toContain(WS_SECRET);
  }, BUDGET_MS);

  test('control: a `**/`-anchored pattern naming a DIFFERENT file leaves both readable', async () => {
    // Discriminates "our glob did it" from "the profile parent blocks the
    // workspace", which would make the assertions below pass for the wrong reason.
    const { profileAccepted: accepted, outcomes } = await execUnder('nine_control_other_name', shippedToml({
      name: 'nine_control_other_name', adapterPort: 1, sandboxGloballyEnabled: false,
      deniedReadPaths: [], deniedReadPatterns: ['**/no-such-credential-name'],
    }), NINE_PROBES);
    expect(accepted).toBe(true);
    expect(probe(outcomes, 0).stdout).toContain(WS_SECRET);
    expect(probe(outcomes, 1).stdout).toContain(WS_SECRET);
  }, BUDGET_MS);

  test('the `**/`-anchored half reaches OS enforcement: content refused at depth 3 AND at depth 0, and grep returns nothing', async () => {
    const { profileAccepted: accepted, outcomes } = await execUnder('nine_mirrored', shippedToml({
      name: 'nine_mirrored', adapterPort: 1, sandboxGloballyEnabled: false,
      // No host deny and no `~/` entry: the profile exists ONLY because the
      // workspace-scoped half mirrored. P3.273 corrected what that covers: the profile is raised by
      // `hasCodexFilesystemPolicy`'s workspace-glob arm in the BUILDER, not by
      // `hasCodexRuntimePathPolicy` (ex-`hasRuntimePathPolicy`) — mutating the
      // latter back to `mapping.keys` alone SURVIVED this whole suite, because
      // its only reader is the schema-drift check. That arm is armed in
      // `config-writer-denied-path-mirror.test.ts` instead.
      deniedReadPaths: [], deniedReadPatterns: ['**/.env', '**/.npmrc'],
    }), NINE_PROBES);
    expect(accepted).toBe(true);
    expect(probe(outcomes, 0).stdout).not.toContain(WS_SECRET);
    expect(probe(outcomes, 0).exitCode).not.toBe(0);
    expect(probe(outcomes, 0).stderr).toContain('Operation not permitted');
    // Depth 0 — `**\/` matching zero directories is what makes this a faithful subset.
    expect(probe(outcomes, 1).stdout).not.toContain(WS_SECRET);
    expect(probe(outcomes, 1).stderr).toContain('Operation not permitted');
    // The RESULTS half, which the Claude binary was measured leaving open (P3.174).
    expect(probe(outcomes, 2).stdout).not.toContain(WS_SECRET);
  }, BUDGET_MS);

  test('the WHOLE shipped floor still produces a profile codex ACCEPTS — a refused key discards everything', async () => {
    // The fail-open this file exists for: one key codex rejects makes
    // `compile_permission_profile` return Err and the app-server answers
    // "Invalid configuration; using defaults" on STDERR ONLY, taking every other
    // deny with it. The WHOLE floor goes in at once here for that reason.
    const shippedFloor: string[] = JSON.parse(readFileSync(
      join(REPO_ROOT, 'apps', 'electron', 'resources', 'permissions', 'default.json'), 'utf8',
    )).deniedPaths;
    // P6.1063 — this was a literal `19` and it rotted the day the floor grew to
    // 24 (`7b7582387`, `e6296c0f7`), failing on a number while the proposition
    // it guards — the whole floor still COMPILES — was never in doubt:
    // `profileAccepted` below proves that directly, and it gets stronger as the
    // floor grows. What the read needs is a positive control that it found the
    // real file rather than an empty array, so the two patterns the probes
    // actually exercise are asserted by NAME, and the size is a floor rather
    // than an equality.
    expect(shippedFloor).toContain('**/.env');
    expect(shippedFloor).toContain('**/.npmrc');
    expect(shippedFloor.length).toBeGreaterThanOrEqual(24);
    const { profileAccepted: accepted, outcomes } = await execUnder('nine_shipped_floor', shippedToml({
      name: 'nine_shipped_floor', adapterPort: 1, sandboxGloballyEnabled: false,
      deniedReadPaths: [DECOY], deniedReadPatterns: shippedFloor,
    }), [...NINE_PROBES, ['/bin/cat', DECOY]]);
    expect(accepted).toBe(true);
    expect(probe(outcomes, 0).stdout).not.toContain(WS_SECRET);
    expect(probe(outcomes, 1).stdout).not.toContain(WS_SECRET);
    // …and the host-owned deny that shares the profile is still in force.
    expect(probe(outcomes, 3).stdout).not.toContain(WS_SECRET);
    expect(probe(outcomes, 3).exitCode).not.toBe(0);
  }, BUDGET_MS);
});
