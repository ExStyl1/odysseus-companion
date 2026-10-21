/**
 * P3.81 — the assertion the row exists to add: **a CODEX_HOME this repo builds
 * must produce NO `configWarning` from the shipped binary.**
 *
 * ## Why an assertion and not a code path
 *
 * The rules file `writeCodexConfig` projects into `CODEX_HOME/rules/nessy.rules`
 * carries two things at once: P2.141b's `decision="forbidden"` floors and P3.1's
 * durable Always-Allow grants. codex fails that file OPEN and WHOLE-FILE — one
 * bad line drops every rule in it, both families together — and the only signal
 * is a `configWarning`. Nothing in this repo read it before this row.
 *
 * The user-visible half of that loss is the grants ("Always Allow stopped
 * working"); the invisible half is the floors. So the gate is not "does our
 * writer produce a string we like" — the existing unit tests already pin the
 * string — but "does the BINARY accept the file we actually wrote". Only a real
 * boot can answer that, and the escaping in `execpolicyString` (quotes,
 * backslashes, control characters) is exactly the sort of thing a string
 * assertion cannot judge.
 *
 * ## The rig
 *
 * Bundled `codex-app-server` for the host platform, spawned through the real
 * `CodexRuntimeManager` (SHA gate included) and driven with the real
 * `AppServerClient`, against homes built by the real `writeCodexConfig`.
 * Measured 2026-08-28 on **darwin-arm64** (Apple M1 Pro; md5
 * `eb2144664b1c4eb0697b69b4b242b737`) and on **darwin-x64 under Rosetta**;
 * **win32 not executed** (plan row P3.62).
 *
 * ## The window, and the trap it is built around
 *
 * A timeout tuned on a fast platform manufactures an absence on a slow one — a
 * 5 s probe for this very warning read a false "no warning" under Rosetta until
 * it was raised to 25 s. So the clean arm does NOT carry a constant. The
 * positive control runs FIRST, on the same binary in the same process, and the
 * latency IT observes sets the clean arm's window at 25x, floored. Measured
 * control latency was 92 ms (arm64) and 260 ms (x64/Rosetta), and on both
 * platforms the warning arrived in the same flush as the `initialize` response —
 * it is emitted at server start, before `initialized` is even sent. The clean
 * arm additionally waits past its own `initialize` response before the window
 * opens, so the wait is "boot completed, plus 25x the delay this rig actually
 * shows", not a number from somewhere else.
 *
 * If the control ever stops firing, the control case fails and the clean case
 * refuses to run — an absence here is never reported without its control.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeCodexConfig,
  CODEX_API_KEY_ENV,
  CODEX_RULES_DIR,
  CODEX_RULES_FILE,
} from '@nessy-agent/codex-responses-adapter/config-writer';
import { AppServerClient } from '../app-server-client.ts';
import { CodexRuntimeManager } from '../runtime-manager.ts';
import { CODEX_CONFIG_WARNING_METHOD } from '../config-warning.ts';
import { hostCodexPlatformDir } from '../manifest-verifier.ts';

/** Four levels up from `src/__tests__` is the repo root. */
const PLATFORM_DIR = hostCodexPlatformDir();
const BUNDLED_CODEX = join(
  import.meta.dir, '..', '..', '..', '..',
  'apps', 'electron', 'resources', 'bin', 'codex', PLATFORM_DIR,
  process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server',
);

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

/**
 * The prefixes the clean arm projects. Deliberately not all tame: the last two
 * carry a quote, a backslash and a raw newline, which `execpolicyString` escapes
 * as a doubled backslash, an escaped quote, and a u000a code escape. Whether
 * that escaping satisfies the starlark parser is precisely the claim only a real
 * boot can settle, and getting it wrong loses the deny floors, not just the grant
 * that carried the character.
 */
const ALLOW_PREFIXES = [
  ['git', 'status'],
  ['npm', 'run', 'build'],
  ['echo', 'a "b" \\ c'],
  ['echo', 'x\ny'],
];
const DENY_PREFIXES = [['rm', '-rf'], ['sh', '-c']];
/**
 * P6.1's two additions, here because this is the only rig that can settle them:
 * `decision="prompt"` and the `justification=` keyword the deny and prompt lines
 * now carry. Both are read from `execpolicy/src/decision.rs` and
 * `execpolicy/src/parser.rs` at `rust-v0.150.1` — the tag shipped when this was
 * read —
 * and a source read is not proof that THIS artifact parses the line. An empty
 * justification is a hard parse error ("justification cannot be empty"), so the
 * clean arm is what stands between a projected middle tier and a rules file that
 * silently drops every deny floor beside it.
 *
 * P6.1's finish makes this arm strictly stronger without touching it: the
 * justification is now built PER RULE from the tokens beside it, so the last
 * entry's quote and backslash are escaped TWICE on the same line — once in the
 * `pattern=` list and once inside `justification=` — and the line also carries a
 * colon and several spaces the constant version never had. Whether the starlark
 * parser accepts that is the same kind of claim only a real boot can settle.
 */
const PROMPT_PREFIXES = [['git', 'push'], ['echo', 'p "q" \\ r']];

const scratch: string[] = [];
function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Build the home the product builds, minus the parts that need live ports. */
function buildHome(): string {
  const home = scratchDir('p381-home-');
  writeCodexConfig({
    codexHome: home,
    model: MODEL,
    adapterPort: 54321,
    deniedReadPaths: [join(home, 'credentials.enc')],
    execpolicyAllowPrefixes: ALLOW_PREFIXES,
    execpolicyDenyPrefixes: DENY_PREFIXES,
    execpolicyPromptPrefixes: PROMPT_PREFIXES,
  });
  return home;
}

interface BootResult {
  /** `configWarning` notifications, with ms from spawn. */
  warnings: Array<{ ms: number; params: unknown }>;
  /** Only OUR classifier lines — `[app-server stderr]` chunks are excluded. */
  classified: string[];
}

/**
 * Boot the real binary on `home`, then listen for `windowMs` past `initialize`.
 *
 * Notifications are counted off `onNotification` and the classifier lines off
 * `onDiagnostic`, so one boot exercises both halves of the change at once.
 */
async function boot(home: string, windowMs: number): Promise<BootResult> {
  const workspace = scratchDir('p381-ws-');
  const manager = new CodexRuntimeManager();
  const warnings: BootResult['warnings'] = [];
  const classified: string[] = [];
  const child = manager.spawn({
    binaryPath: BUNDLED_CODEX,
    cwd: workspace,
    codexHome: home,
    env: { [CODEX_API_KEY_ENV]: 'loopback' },
    platformDir: PLATFORM_DIR,
  });
  // AFTER `spawn`, deliberately. `spawn` runs the pre-spawn SHA gate, which
  // reads and hashes ~180 MB; timing from before it folds OUR cost into a
  // latency the clean arm then multiplies by 25. Measured: doing that took the
  // pair from ~16 s to 64 s while telling us nothing about the binary's boot.
  const spawnedAt = Date.now();
  const client = new AppServerClient(child, {
    onDiagnostic: (message) => {
      if (message.startsWith('[codex configWarning]')) classified.push(message);
    },
    onNotification: (method, params) => {
      if (method === CODEX_CONFIG_WARNING_METHOD) warnings.push({ ms: Date.now() - spawnedAt, params });
    },
  });
  try {
    await client.request(
      'initialize',
      {
        clientInfo: { name: 'nessy-p381-gate', title: null, version: '0.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
      { timeoutMs: 60_000 },
    );
    client.notify('initialized');
    await new Promise<void>(resolve => setTimeout(resolve, windowMs));
  } finally {
    client.close();
    await manager.kill();
  }
  return { warnings, classified };
}

/** Set by the positive control; the clean arm refuses to run without it. */
let controlLatencyMs: number | null = null;

describe.skipIf(!existsSync(BUNDLED_CODEX))(
  'the projected CODEX_HOME, against the shipped codex-app-server',
  () => {
    /**
     * POSITIVE CONTROL, and it runs first on purpose.
     *
     * It validates the INSTRUMENT — that this rig can see a `configWarning` at
     * all, and that our classifier names the consequence when it does. It does
     * not validate the premise; the clean arm does that.
     *
     * KILLS: a rig that never receives notifications (wrong handler, wrong
     * method name, a client closed too early), and any regression that stops
     * `describeCodexConfigWarning` from recognising the real payload.
     */
    test('POSITIVE CONTROL: one bad line in the projected rules file is reported, loudly', async () => {
      const home = buildHome();
      const rulesPath = join(home, CODEX_RULES_DIR, CODEX_RULES_FILE);
      const projected = readFileSync(rulesPath, 'utf8');
      // `forbidden | prompt | allow` are the three the binary accepts
      // (`execpolicy/src/decision.rs`, rust-v0.150.1). A fourth is a parse error
      // that takes the whole file with it.
      writeFileSync(rulesPath, `${projected}prefix_rule(pattern=["ls"], decision="nonsense")\n`, 'utf8');

      const result = await boot(home, 5_000);

      expect(result.warnings.length).toBeGreaterThanOrEqual(1);
      controlLatencyMs = result.warnings[0]!.ms;
      const params = result.warnings[0]!.params as { summary?: string; path?: string };
      expect(String(params.summary)).toContain('rules');
      expect(String(params.path)).toContain(`${CODEX_RULES_DIR}/${CODEX_RULES_FILE}`);
      // The half a "Always Allow broke" reading would miss.
      expect(result.classified).toHaveLength(1);
      expect(result.classified[0]).toContain('EXECPOLICY RULES DID NOT LOAD');
      expect(result.classified[0]).toContain('NO projected non-negotiable deny rules');
    }, 120_000);

    /**
     * THE ROW'S ASSERTION. The home we actually build, booted for a window this
     * rig's own control latency sets, must produce nothing on this channel.
     *
     * KILLS: any change to `buildCodexExecpolicyRules`, `execpolicyString` or the
     * config writer that emits a line the binary refuses — which would silently
     * drop every deny floor and every durable grant for the session.
     */
    test('a clean projected home produces NO configWarning at all', async () => {
      expect(controlLatencyMs).not.toBeNull();
      // 25x the delay THIS rig showed, floored at 3 s. Under Rosetta the control
      // is slower, so this window grows with it rather than being tuned once on
      // the fast machine and manufacturing an absence on the slow one.
      const window = Math.max(3_000, controlLatencyMs! * 25);
      // The number that sets this arm's bound belongs in its own output.
      console.log(`[P3.81] control latency ${controlLatencyMs} ms -> clean window ${window} ms`);

      const result = await boot(buildHome(), window);

      expect(result.warnings.map(w => JSON.stringify(w.params))).toEqual([]);
      expect(result.classified).toEqual([]);
    }, 120_000);
  },
);
