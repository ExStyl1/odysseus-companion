/**
 * Task 3.4 gate: config.toml writer.
 *
 * The generated TOML contains the [model_providers.nessy_gateway] block with
 * wire_api="responses" + the loopback base_url, and validates against the real
 * release config-schema.json asset.
 */
import { test, expect, describe } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  autoCompactTokenLimit,
  buildCodexRuntimeConfigOverride,
  buildCodexConfigToml,
  validateConfigAgainstSchema,
  writeCodexConfig,
  CODEX_AGENT_ROLE_DIR,
  codexSandboxConfigForMode,
  CODEX_MODES_KEEPING_ON_REQUEST_UNBOUNDED,
  type CodexThinkingLevel,
  type CodexReasoningEffort,
  type CodexPermissionMode,
  type CodexSandboxMode,
  type CodexApprovalPolicy,
} from '../config-writer.ts';

const ALL_MODES: CodexPermissionMode[] = [
  'dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions',
];

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/codex-responses-adapter/src/__tests__ → packages/codex-protocol/schema
const SCHEMA = join(HERE, '..', '..', '..', 'codex-protocol', 'schema', 'config-schema.json');

describe('config-writer', () => {
  const opts = {
    codexHome: '/tmp/x',
    model: 'tgpt/qwen35-397b-a17b-fp8',
    adapterPort: 54321,
    deniedReadPaths: ['/private/nessy/credentials.enc'],
  } as const;

  test('generated TOML has the nessy_gateway provider block with wire_api=responses + loopback base_url', () => {
    const toml = buildCodexConfigToml(opts);
    expect(toml).toContain('[model_providers.nessy_gateway]');
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain('base_url = "http://127.0.0.1:54321/v1"');
    expect(toml).toContain('env_key = "COMPANY_LLM_API_KEY"');
    expect(toml).toContain('model = "tgpt/qwen35-397b-a17b-fp8"');
    expect(toml).toContain('model_provider = "nessy_gateway"');
    // static Phase-3 approval/sandbox values
    expect(toml).toContain('approval_policy = "on-request"');
    expect(toml).toContain('sandbox_mode = "workspace-write"');
    expect(toml).toContain('default_permissions = "nessy_runtime"');
    expect(toml).toContain('[permissions.nessy_runtime]');
    expect(toml).toContain('extends = ":workspace"');
    expect(toml).toContain('"/private/nessy/credentials.enc" = "deny"');
  });

  test('writes model_context_window only when a window is actually known', () => {
    // F1's rule on the codex side: the synced window is passed through, and an
    // ABSENT one leaves codex on its own default rather than being handed a
    // fabricated number.
    expect(buildCodexConfigToml({ ...opts, contextWindow: 40_960 }))
      .toContain('model_context_window = 40960');
    expect(buildCodexConfigToml(opts)).not.toContain('model_context_window');
    expect(buildCodexConfigToml({ ...opts, contextWindow: 0 })).not.toContain('model_context_window');
    expect(buildCodexConfigToml({ ...opts, contextWindow: Number.NaN })).not.toContain('model_context_window');
  });

  test('pairs the window with an auto-compaction limit below codex’s reserve (F7)', () => {
    // F3 left the limit unwritten for want of a source; F3(b) supplied one, and
    // without the key codex's automatic net never fires — F5 watched five turns
    // reach 91.5% of the window and a sixth push it higher still.
    //
    // The limit is 0.85 of the window, deliberately below the ~5% effective-
    // capacity reserve codex keeps (measured 240 000 -> 228 000 usable), with
    // the remaining tenth of the window left as room for the compaction itself.
    expect(buildCodexConfigToml({ ...opts, contextWindow: 240_000 }))
      .toContain('model_auto_compact_token_limit = 204000');
    expect(buildCodexConfigToml({ ...opts, contextWindow: 272_000 }))
      .toContain('model_auto_compact_token_limit = 231200');

    // Strictly below the measured wall, with real headroom, on both windows.
    for (const [window, wall] of [[240_000, 228_000], [272_000, 258_400]] as const) {
      const limit = autoCompactTokenLimit(window)!;
      expect(limit).toBeLessThan(wall);
      expect(wall - limit).toBeGreaterThanOrEqual(window * 0.09);
    }

    // Same gate as the window: no window, no invented limit.
    expect(buildCodexConfigToml(opts)).not.toContain('model_auto_compact_token_limit');
    expect(buildCodexConfigToml({ ...opts, contextWindow: 0 }))
      .not.toContain('model_auto_compact_token_limit');
    expect(autoCompactTokenLimit(undefined)).toBeUndefined();
    // A window too small to derive a positive limit from emits none rather than
    // a zero, which codex would read as "compact on every turn".
    expect(autoCompactTokenLimit(1)).toBeUndefined();
    expect(buildCodexConfigToml({ ...opts, contextWindow: 1 }))
      .not.toContain('model_auto_compact_token_limit');
  });

  test('config values validate against the release config-schema.json asset', () => {
    expect(() => validateConfigAgainstSchema(opts, SCHEMA)).not.toThrow();
    // `model_context_window` and `model_auto_compact_token_limit` must be real
    // ConfigToml properties, not keys we invented — the writer emits them and
    // codex would ignore an unknown one.
    expect(() => validateConfigAgainstSchema({ ...opts, contextWindow: 40_960 }, SCHEMA)).not.toThrow();
    // an invalid sandbox mode is rejected
    expect(() =>
      validateConfigAgainstSchema({ ...opts, sandboxMode: 'bogus' as never }, SCHEMA),
    ).toThrow();
  });

  // P3.4 — model-driven parallel agents. `features.multi_agent` turns codex's
  // multi-agent tools on explicitly; it is a boolean under the release schema's
  // [features] table and must be written BEFORE [agents] (whose role-name keys
  // would otherwise swallow the assignment).
  test('writes [features] multi_agent = true, before any [agents] block, and it stays schema-valid', () => {
    const toml = buildCodexConfigToml(opts);
    expect(toml).toContain('[features]');
    expect(toml).toContain('multi_agent = true');
    expect(() => validateConfigAgainstSchema(opts, SCHEMA)).not.toThrow();

    // Placement: [features] precedes [agents.<role>] when roles exist.
    const withRole = buildCodexConfigToml({
      ...opts,
      agents: [{
        key: 'plugin:x:researcher',
        name: 'researcher',
        selectedAsUnqualifiedAlias: true,
        description: 'Researches things',
        systemPrompt: 'You research.',
      }],
    });
    const featuresAt = withRole.indexOf('[features]');
    const agentsAt = withRole.indexOf('[agents.');
    expect(featuresAt).toBeGreaterThanOrEqual(0);
    expect(agentsAt).toBeGreaterThanOrEqual(0);
    expect(featuresAt).toBeLessThan(agentsAt);

    // The toggles belong to [features]: nothing UNINTENDED falls into the table.
    // Read the block itself rather than "the next assignment after multi_agent" —
    // P3.116 added a second deliberate key (`view_image`), and the old shape read
    // any sibling as the accident it was written to catch.
    const featuresBody = toml.slice(toml.indexOf('[features]') + '[features]'.length)
    const blockEnd = featuresBody.indexOf('[')
    const block = blockEnd === -1 ? featuresBody : featuresBody.slice(0, blockEnd)
    const assignments = block.split('\n').map(l => l.trim()).filter(l => l.includes('='))
    // P6.533 · the block is now the DECIDED set, and this list is the pin that
    // makes an upstream default flip — or an undeclared addition here — go red
    // rather than silently changing the product. Order is the emit order.
    // P6.726 · `apps` and `remote_plugin` are `false` since the owner's answer
    // on P6.533 — ChatGPT connectors and the PS-backed remote catalog cannot be
    // reached through this product's gateway, and the reason is written at each
    // key in the writer.
    // C3.253 · `plugins = false` joins them, and it is the one key here that is
    // not a posture about a surface: it closes an EGRESS every session start
    // performed (`chatgpt.com` featured-plugin ids + the `github.com/openai/plugins`
    // curated clone into `CODEX_HOME/.tmp/`). Reason at the key in the writer;
    // both arms driven against the shipped binary in
    // `config-writer-plugin-egress-live.test.ts`.
    expect(assignments).toEqual([
      'multi_agent = true', 'view_image = true', 'goals = false',
      'hooks = true', 'unified_exec = true', 'shell_snapshot = true',
      'apps = false', 'fast_mode = true', 'remote_plugin = false',
      'plugins = false', 'write_stdin_approval = true',
    ])
  });

  // P6.533 — the six stable user-facing keys, each pinned by NAME and POLE.
  //
  // The list assertion above catches any change to the block; this one says what
  // the six are FOR, so a reader who deletes one meets the reason rather than an
  // array diff. Every one measured `{stage:"stable", enabled:true,
  // defaultEnabled:true}` on the pinned `darwin-arm64` binary (2026-09-06, load
  // 9.19, 114 features in one page, `zzz_nessy_not_a_real_feature` not listed as
  // the negative control) — so `true` was today's behaviour, declared rather
  // than inherited. P6.726 then took the posture call the note above reserved
  // for the owner: FOUR stay on, `apps` and `remote_plugin` are off.
  test('P6.533/P6.726 — the stable user-facing subset is written explicitly, four ON and two OFF', () => {
    const toml = buildCodexConfigToml(opts)
    const featuresAt = toml.indexOf('[features]')
    expect(featuresAt).toBeGreaterThanOrEqual(0)
    const body = toml.slice(featuresAt + '[features]'.length)
    const end = body.indexOf('[')
    const block = end === -1 ? body : body.slice(0, end)
    for (const key of ['hooks', 'unified_exec', 'shell_snapshot', 'fast_mode', 'write_stdin_approval']) {
      expect(block).toContain(`${key} = true`)
    }
    // P6.726 · and the two the owner turned off, asserted by POLE rather than by
    // absence: a key silently dropped from the block would inherit
    // `defaultEnabled: true` on the binary and read exactly like this test
    // passing.
    // C3.253 · `plugins` joins the OFF side, asserted the same way and for a
    // sharper reason: it is written `false` to close an egress, so a key
    // silently dropped would inherit `default_enabled: true` and re-open
    // `chatgpt.com`/`github.com` on every session start.
    //
    // This line REPLACES a `not.toContain('plugins =')` that stood here until
    // 2026-09-11 — the guard pinning this key's ABSENCE, correct while the
    // subset was six and false the moment the egress behind it was measured.
    // The flip is deliberate and the row that took it names the reading.
    for (const key of ['apps', 'remote_plugin', 'plugins']) {
      expect(block).toContain(`${key} = false`)
    }
    // NEGATIVE: a stable key we deliberately did NOT decide stays out. Writing
    // every one of the 124 was refused; this is the boundary of the subset.
    expect(block).not.toContain('memories =')
  });

  // P6.487 — codex's own goal engine, off explicitly. MEASURED on the pinned
  // binary in BOTH directions (2026-09-06): without this key
  // `experimentalFeature/list` reports `goals` as
  // `{stage:"stable", enabled:true, defaultEnabled:true}`; with it, `enabled`
  // flips to `false` while `defaultEnabled` stays `true`, and the `multi_agent`
  // control is unmoved in the same run. So the key controls the feature, and
  // P2.2's host-side one-goal-per-thread ruling stops depending on nobody
  // calling `thread/goal/set`.
  //
  // WHAT THIS KILLS: dropping the key (codex's own goal engine runs beside the
  // host's again, silently, since an omitted key inherits `defaultEnabled:true`)
  // and writing it `true` (the same, said out loud).
  test('turns codex\'s own goal engine off explicitly in every config shape', () => {
    for (const variant of [
      opts,
      { ...opts, mode: 'plan' as never },
      { ...opts, approvalPolicy: 'never' as never },
      { ...opts, contextWindow: 128_000 },
    ]) {
      const toml = buildCodexConfigToml(variant)
      expect(toml).toContain('goals = false')
      // In [features], and never as a top-level key or swallowed by a later
      // table — the placement trap every other key in this block carries.
      const featuresAt = toml.indexOf('[features]')
      const goalsAt = toml.indexOf('goals = false')
      expect(featuresAt).toBeGreaterThanOrEqual(0)
      expect(goalsAt).toBeGreaterThan(featuresAt)
      const between = toml.slice(featuresAt, goalsAt)
      expect(between.slice('[features]'.length).includes('\n[')).toBe(false)
      // And never the enabling spelling.
      expect(toml).not.toContain('goals = true')
    }
  });

  // P3.116 — codex has NO `read` tool (its handlers read files through `shell`);
  // `view_image` is the one that returns an IMAGE CONTENT ITEM rather than bytes,
  // and it is what makes the runtime-switch handover's named-path pointer
  // (P3.54) readable back on the third runtime. It is `stage:"stable",
  // defaultEnabled:true` on the shipped binary, and until this row we set it
  // NOWHERE — so a future codex release flipping that default would remove the
  // mechanism the design rests on with nothing failing anywhere.
  test('declares [features] view_image = true rather than inheriting codex\'s default', () => {
    // Every codex config we write, in every shape, carries the declaration.
    for (const variant of [
      opts,
      { ...opts, mode: 'plan' as never },
      { ...opts, approvalPolicy: 'never' as never },
      { ...opts, contextWindow: 128_000 },
    ]) {
      const toml = buildCodexConfigToml(variant)
      expect(toml).toContain('view_image = true')
      // In [features], not loose at the top level or swallowed by a later table.
      const featuresAt = toml.indexOf('[features]')
      const viewImageAt = toml.indexOf('view_image = true')
      expect(featuresAt).toBeGreaterThanOrEqual(0)
      expect(viewImageAt).toBeGreaterThan(featuresAt)
      expect(toml.slice(featuresAt, viewImageAt).includes('\n[')).toBe(false)
      expect(() => validateConfigAgainstSchema(variant, SCHEMA)).not.toThrow()
    }
  });

  // The half a declaration cannot cover: an upstream RENAME. codex ignores a
  // renamed `[features]` key (a `configWarning` since `rust-v0.156.1`, silence
  // before — P2.509), so the steering is lost: catch it before spawn instead.
  test('drift-guards the [features] key names it writes', () => {
    const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'))
    for (const key of ['multi_agent', 'view_image']) {
      const mutated = JSON.parse(JSON.stringify(schema))
      delete mutated.properties.features.properties[key]
      const path = join(tmpdir(), `codex-schema-no-${key}-${Date.now()}.json`)
      writeFileSync(path, JSON.stringify(mutated))
      try {
        expect(() => validateConfigAgainstSchema(opts, path))
          .toThrow(`config-schema.json [features] has no property "${key}"`)
      } finally {
        rmSync(path, { force: true })
      }
    }
  });

  // Task 5.1 — [mcp_servers.session]
  //
  // The key was `nessy_session` until the wire-name unification. It is the
  // middle segment of the model-facing name the codex binary mints
  // (`mcp__<key>__<tool>`), so it has to be `session` for a Codex session tool
  // to carry the same wire name Pi and Claude give it.
  test('emits exactly one [mcp_servers.session] with the session-server stdio args', () => {
    const toml = buildCodexConfigToml({
      ...opts,
      sessionMcp: {
        command: '/usr/bin/node',
        args: ['/res/session-mcp-server/index.js', '--session-id', 's1', '--workspace-root', '/ws', '--plans-folder', '/ws/plans', '--external-standalone-only'],
      },
    });
    expect([...toml.matchAll(/^\[mcp_servers\.session\]$/gm)]).toHaveLength(1);
    expect(toml).not.toContain('nessy_session');
    expect(toml).toContain('command = "/usr/bin/node"');
    expect(toml).toContain('--session-id');
    expect(toml).toContain('--workspace-root');
    expect(toml).toContain('--plans-folder');
    expect(toml).toContain('--external-standalone-only');
    // still schema-valid (mcp_servers is a recognized top-level property)
    expect(() => validateConfigAgainstSchema({ ...opts }, SCHEMA)).not.toThrow();
  });

  test('omits the mcp table when no sessionMcp is provided', () => {
    expect(buildCodexConfigToml(opts)).not.toContain('[mcp_servers.session]');
  });

  /**
   * T5 — the row asked for a CONFIRMATION, and this is it: growing the session
   * server's surface from 18 tools to 23 must not introduce a codex-side
   * approval prompt on top of the host gate T2 already runs inside
   * `SessionMonitorService.start`.
   *
   * `RawMcpServerConfig` (`codex-protocol/schema/config-schema.json`) is where a
   * per-server approval would have to live: `default_tools_approval_mode`
   * (`AppToolApproval`, schema default `null`) and a per-tool `tools.<name>
   * .approval_mode`. This writer emits NEITHER — for the 18 today and for the 23
   * after — so every session tool inherits the session's own `approval_policy`
   * and the five new ones are treated exactly like the ones already shipping.
   */
  test('[mcp_servers.session] writes no per-tool approval keys, so the five inherit today\'s behaviour', () => {
    const toml = buildCodexConfigToml({
      ...opts,
      sessionMcp: {
        command: '/usr/bin/node',
        args: [
          '/res/session-mcp-server/index.js',
          '--session-id', 's1',
          '--workspace-root', '/ws',
          '--plans-folder', '/ws/plans',
          '--external-standalone-only',
          '--host-callback-port', '54321',
        ],
      },
    });
    // The bridge port reaches the subprocess verbatim: one argument that both
    // names the channel and proves it exists.
    expect(toml).toContain('--host-callback-port');
    expect(toml).toContain('"54321"');
    // No approval knob of any shape, at the server level or per tool.
    expect(toml).not.toContain('default_tools_approval_mode');
    expect(toml).not.toContain('approval_mode');
    expect(toml).not.toContain('[mcp_servers.session.tools');
    expect(toml).not.toContain('enabled_tools');
    expect(toml).not.toContain('disabled_tools');
    // Positive control: the session's own approval policy IS written, so the
    // absences above are these keys and not an empty file.
    expect(toml).toContain('approval_policy = ');
  });

  test('emits the host-owned source pool as a Codex MCP server only when provided', () => {
    const withPool = {
      ...opts,
      poolMcpUrl: 'http://127.0.0.1:45678/mcp',
    } as const;
    const toml = buildCodexConfigToml(withPool);

    expect(toml).toContain('[mcp_servers.sources]');
    expect(toml).toContain('url = "http://127.0.0.1:45678/mcp"');
    expect(toml).toContain('bearer_token_env_var = "NESSY_CODEX_MCP_POOL_TOKEN"');
    expect(toml).toContain('exclude = ["NESSY_CODEX_MCP_POOL_TOKEN"]');
    expect(() => validateConfigAgainstSchema(withPool, SCHEMA)).not.toThrow();
    const withoutPool = buildCodexConfigToml(opts);
    expect(withoutPool).not.toContain('[mcp_servers.sources]');
    expect(withoutPool).not.toContain('NESSY_CODEX_MCP_POOL_TOKEN');
  });

  // Task 4.2 — permission mode → sandbox/approval (blueprint §12)
  test('codexSandboxConfigForMode maps each Nessy mode', () => {
    expect(codexSandboxConfigForMode('plan')).toEqual({ sandbox_mode: 'read-only', approval_policy: 'on-request' }); // F1.1050: explore's row retired, plan is the read-only row
    expect(codexSandboxConfigForMode('default')).toEqual({ sandbox_mode: 'workspace-write', approval_policy: 'on-request' });
    expect(codexSandboxConfigForMode('bypassPermissions')).toEqual({ sandbox_mode: 'workspace-write', approval_policy: 'on-request' });
  });

  test('mode-driven config.toml validates against the schema for every mode', () => {
    for (const mode of ['plan', 'default', 'bypassPermissions'] as const) {
      const toml = buildCodexConfigToml({ ...opts, mode });
      const { sandbox_mode, approval_policy } = codexSandboxConfigForMode(mode);
      expect(toml).toContain(`sandbox_mode = "${sandbox_mode}"`);
      expect(toml).toContain(`approval_policy = "${approval_policy}"`);
      expect(toml).toContain(`extends = "${sandbox_mode === 'read-only' ? ':read-only' : ':workspace'}"`);
      expect(() => validateConfigAgainstSchema({ ...opts, mode }, SCHEMA)).not.toThrow();
    }
  });

  test('rejects relative or root-wide denied paths', () => {
    expect(() => buildCodexConfigToml({ ...opts, deniedReadPaths: ['relative'] })).toThrow('codex-denied-read-path-not-absolute');
    expect(() => buildCodexConfigToml({ ...opts, deniedReadPaths: ['/'] })).toThrow('codex-denied-read-path-too-broad');
  });

  test('projects selected plugin shell env and writable data into TOML and turn overrides', () => {
    const runtime = {
      ...opts,
      shellEnvironment: {
        CLAUDE_PLUGIN_ROOT: '/private/nessy/plugins/honey',
        CLAUDE_CONFIG_DIR: '/private/nessy/plugin-data/honey',
      },
      writablePaths: ['/private/nessy/plugin-data/honey'],
      mode: 'default' as const,
    };
    const toml = buildCodexConfigToml(runtime);
    expect(toml).toContain('[shell_environment_policy.set]');
    expect(toml).toContain('"CLAUDE_PLUGIN_ROOT" = "/private/nessy/plugins/honey"');
    expect(toml).toContain('"CLAUDE_CONFIG_DIR" = "/private/nessy/plugin-data/honey"');
    expect(toml).toContain('"/private/nessy/plugin-data/honey" = "write"');
    expect(toml).toContain('"/private/nessy/credentials.enc" = "deny"');
    // F1.1075 — the profile's own description names what it holds; the credential floor it named is gone (F1.1057).
    expect(toml).toContain('description = "Nessy runtime: protected folders, managed plugin data and denied paths"');
    expect(toml).not.toContain('credentials policy');
    expect(buildCodexRuntimeConfigOverride(runtime)).toEqual({
      shell_environment_policy: {
        set: {
          CLAUDE_CONFIG_DIR: '/private/nessy/plugin-data/honey',
          CLAUDE_PLUGIN_ROOT: '/private/nessy/plugins/honey',
        },
      },
      default_permissions: 'nessy_runtime',
      permissions: {
        nessy_runtime: {
          description: 'Nessy runtime: protected folders, managed plugin data and denied paths',
          extends: ':workspace',
          filesystem: {
            '/private/nessy/plugin-data/honey': 'write',
            '/private/nessy/credentials.enc': 'deny',
          },
        },
      },
    });
    expect(() => validateConfigAgainstSchema(runtime, SCHEMA)).not.toThrow();
  });

  test('rejects unsafe plugin runtime env and writable path policies', () => {
    expect(() => buildCodexConfigToml({ ...opts, writablePaths: ['relative'] }))
      .toThrow('codex-writable-path-not-absolute');
    expect(() => buildCodexConfigToml({ ...opts, writablePaths: ['/'] }))
      .toThrow('codex-writable-path-too-broad');
    expect(() => buildCodexConfigToml({
      ...opts,
      shellEnvironment: { 'BAD=KEY': 'value' },
    })).toThrow('codex-shell-environment-key-invalid');
    expect(() => buildCodexConfigToml({
      ...opts,
      writablePaths: ['/private/nessy/credentials.enc'],
    })).toThrow('codex-runtime-path-policy-conflict');
  });

  /**
   * P6.31 — `xhigh` and `max` used to be pinned to `high` here, so two of the six
   * levels reached codex indistinguishable from the third. Read at
   * `openai/codex` @ `rust-v0.150.1` (`codex-rs/protocol/src/openai_models.rs`),
   * `ReasoningEffort` has `XHigh` and `Max` as named variants spelled `"xhigh"`
   * and `"max"`, and its `FromStr` errors on the empty string alone.
   */
  test('maps ThinkingLevel to model_reasoning_effort', () => {
    const effortByThinkingLevel: Record<CodexThinkingLevel, CodexReasoningEffort> = {
      // P3.226 · `off` is codex's own `"none"` (`ReasoningEffort::None`,
      // `as_str` → `"none"`), not the real level `minimal` it used to borrow.
      off: 'none',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    } as const;

    for (const [thinkingLevel, effort] of Object.entries(effortByThinkingLevel) as Array<[
      CodexThinkingLevel,
      CodexReasoningEffort,
    ]>) {
      const toml = buildCodexConfigToml({ ...opts, thinkingLevel });
      expect(toml).toContain(`model_reasoning_effort = "${effort}"`);
    }
  });

  test('the top three levels stay distinguishable from each other', () => {
    // The discriminating half of the table above: a map that collapsed the top
    // of the scale again would still satisfy a per-level `toContain`, because
    // `high` is a real value. Six levels must produce six distinct efforts, and
    // nothing above `high` may read as `high`.
    const emitted = (['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map(thinkingLevel => {
      const toml = buildCodexConfigToml({ ...opts, thinkingLevel });
      return /^model_reasoning_effort = "(.+)"$/m.exec(toml)?.[1];
    });

    expect(new Set(emitted).size).toBe(6);
    expect(emitted.filter(effort => effort === 'high')).toHaveLength(1);
  });

  test('an imported agent role carries its own widened effort', () => {
    // The map also feeds every role file, so a role declaring `max` must not be
    // silently demoted while the session it runs under is not.
    const home = join(tmpdir(), `codex-role-effort-${Date.now()}`);
    try {
      writeCodexConfig({
        ...opts,
        codexHome: home,
        agents: [{
          key: 'deep-scan',
          name: 'deep-scan',
          selectedAsUnqualifiedAlias: true,
          description: 'Deep scan worker.',
          systemPrompt: 'Scan deeply.',
          effort: 'max',
        }],
      });
      const roleToml = readFileSync(join(home, CODEX_AGENT_ROLE_DIR, 'deep-scan.toml'), 'utf8');
      expect(roleToml).toContain('model_reasoning_effort = "max"');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * T1 contour (e), 2026-08-12 — `sandboxGloballyEnabled` supersedes blueprint
 * §12's "never map to danger-full-access" FOR THE SANDBOX KNOB ONLY. §12's
 * actual concern — the approval loop staying Nessy-gated — stays: only the OS
 * wrap goes. Category string:
 * `deviation: codex-danger-full-access-when-sandbox-off`.
 */
describe('codexSandboxConfigForMode — the T1 sandboxGloballyEnabled master switch', () => {
  const opts = {
    codexHome: '/tmp/x',
    model: 'tgpt/qwen35-397b-a17b-fp8',
    adapterPort: 54321,
    deniedReadPaths: ['/private/nessy/credentials.enc'],
  } as const;

  test('master off (false): every mode maps to danger-full-access, and to the one policy that is still emittable', () => {
    for (const mode of ALL_MODES) {
      const off = codexSandboxConfigForMode(mode, false);
      expect(off.sandbox_mode).toBe('danger-full-access');
    }
    // R13 + P2.197 chose `untrusted` here, because of the three public policies
    // only it routed an ordinary command to `CodexAgent.handleServerRequest`.
    // P7.2 (2026-09-11) could not keep it: upstream #39630 retired it from the
    // public config at `rust-v0.150.1` and the refusal is FATAL — the shipped
    // binary exits 1 before answering `initialize`. So this assertion moved
    // because the runtime removed the mechanism, not because the posture changed.
    //
    // The replacement was read from `core/src/exec_policy.rs` at the tag rather
    // than picked from the remaining names: under an unrestricted filesystem
    // sandbox — exactly what this branch produces — the decision table answers
    // `Allow` for `Never`, `OnRequest` AND `Granular(_)`, and `Prompt` only for
    // the retired `UnlessTrusted`. `granular` is therefore not a successor.
    // `on-request` is what codex's own error tells an operator to fall back to.
    for (const mode of ALL_MODES) {
      const off = codexSandboxConfigForMode(mode, false);
      expect(off.approval_policy).not.toBe('never');
      expect(off.approval_policy).toBe('on-request');
    }
    expect(codexSandboxConfigForMode('dontAsk', false))
      .toEqual({ sandbox_mode: 'danger-full-access', approval_policy: 'on-request' });
    // P6.61 · THE EXCLUSION IS GONE, asserted by name rather than only through
    // the set. `bypassPermissions` used to keep `on-request` because the codex
    // answer path had no mode answer, so degrading it would have carded every
    // non-read-only command in the one mode whose guidance promises none. It has
    // one now (`CodexAgent.handleServerRequest`, after the rule consult and
    // before the card, gated on NO floor having fired), so the mode routes to us
    // like the other six — for the requests that still reach us at all.
    expect(codexSandboxConfigForMode('bypassPermissions', false))
      .toEqual({ sandbox_mode: 'danger-full-access', approval_policy: 'on-request' });
    expect([...CODEX_MODES_KEEPING_ON_REQUEST_UNBOUNDED]).toEqual([]);
    // The whole point of an empty set, said once: off the switch there is
    // exactly ONE configuration, so no mode can be silently left unrouted again.
    expect(new Set(ALL_MODES.map(mode => codexSandboxConfigForMode(mode, false).approval_policy)))
      .toEqual(new Set(['on-request']));
  });

  /**
   * THE REGRESSION GUARD for the whole of the above, and the one assertion that
   * would have caught the lift's worst finding before a session ever ran.
   *
   * Two halves, because either alone is satisfiable by the wrong thing. The
   * FIRST reads the release `config-schema.json` — the `config.toml` contract,
   * which is what a written `approval_policy` is validated against — and asserts
   * `untrusted` is not among its `AskForApproval` members. The SECOND asserts no
   * emitted TOML carries it, over every mode and both switch positions.
   *
   * The trap this exists for: the WIRE enum
   * (`packages/codex-protocol/generated/v2/AskForApproval.ts`) is byte-identical
   * across the lift and STILL carries `"untrusted"`, because codex kept the
   * variant for its own internal use. A reader who checks the generated bindings
   * — the obvious place — concludes nothing moved, and it is the config schema
   * that says otherwise.
   */
  test('`untrusted` is neither in the release config schema nor in anything we emit', () => {
    const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
    const members = (schema.definitions.AskForApproval.oneOf as Array<{ enum?: string[] }>)
      .flatMap(entry => entry.enum ?? []);
    expect(members).not.toContain('untrusted');
    // Positive control on the same read, so an empty/renamed `oneOf` cannot pass.
    expect(members).toContain('on-request');
    expect(members).toContain('never');

    for (const mode of ALL_MODES) {
      for (const sandboxGloballyEnabled of [true, false]) {
        const toml = buildCodexConfigToml({ ...opts, mode, sandboxGloballyEnabled });
        expect(toml).not.toContain('approval_policy = "untrusted"');
      }
    }
  });

  /**
   * THE PIN, and R13 deliberately does not move it. It covers the switch-ON path
   * only — every assertion passes `true` or nothing — so it is the evidence that
   * R13's change is scoped to the switch-OFF branch and leaves the table itself
   * byte-identical to the pre-T1 mapping, `dontAsk`'s `never` included.
   */
  test('master on (default, and explicit true): byte-identical to the pre-T1 mapping (pin)', () => {
    const expected: Record<CodexPermissionMode, { sandbox_mode: CodexSandboxMode; approval_policy: CodexApprovalPolicy }> = {
      dontAsk: { sandbox_mode: 'read-only', approval_policy: 'never' },
      plan: { sandbox_mode: 'read-only', approval_policy: 'on-request' },
      default: { sandbox_mode: 'workspace-write', approval_policy: 'on-request' },
      acceptEdits: { sandbox_mode: 'workspace-write', approval_policy: 'on-request' },
      auto: { sandbox_mode: 'workspace-write', approval_policy: 'on-request' },
      bypassPermissions: { sandbox_mode: 'workspace-write', approval_policy: 'on-request' },
    };
    for (const mode of ALL_MODES) {
      expect(codexSandboxConfigForMode(mode)).toEqual(expected[mode]);
      expect(codexSandboxConfigForMode(mode, true)).toEqual(expected[mode]);
    }
  });

  test('buildCodexConfigToml emits danger-full-access for every mode when the master switch is off, and still validates', () => {
    for (const mode of ALL_MODES) {
      const withSwitchOff = { ...opts, mode, sandboxGloballyEnabled: false };
      const toml = buildCodexConfigToml(withSwitchOff);
      expect(toml).toContain('sandbox_mode = "danger-full-access"');
      // Read from the SWITCH-OFF mapping, not the switch-on one. Reading the
      // bounded value here is what made this assertion agree with the widening
      // R13 removed. This case is also the one that CAUGHT the retirement of
      // `untrusted`: the schema validation below started throwing
      // "approval_policy \"untrusted\" not in schema AskForApproval enum
      // [on-request,never]" the moment the release `config-schema.json` was
      // re-fetched at `rust-v0.150.1`, which is a milder warning than the
      // binary's own — it exits 1 rather than validating.
      const { approval_policy } = codexSandboxConfigForMode(mode, false);
      expect(toml).toContain(`approval_policy = "${approval_policy}"`);
      expect(() => validateConfigAgainstSchema(withSwitchOff, SCHEMA)).not.toThrow();
    }
  });

  test('buildCodexConfigToml is unaffected when the master switch is left unset (pin)', () => {
    for (const mode of ALL_MODES) {
      expect(buildCodexConfigToml({ ...opts, mode })).toEqual(buildCodexConfigToml({ ...opts, mode, sandboxGloballyEnabled: true }));
    }
  });

  // ---- P3.2 · auto-review (approvals_reviewer / [auto_review].policy) ----

  test('emits approvals_reviewer = "auto_review" only when the setting is on (interactive policy), and validates', () => {
    const on = buildCodexConfigToml({ ...opts, approvalsReviewer: 'auto_review' });
    expect(on).toContain('approvals_reviewer = "auto_review"');
    expect(() => validateConfigAgainstSchema({ ...opts, approvalsReviewer: 'auto_review' }, SCHEMA)).not.toThrow();
    // OFF: nothing when the option is absent (the default caller state).
    const off = buildCodexConfigToml(opts);
    expect(off).not.toContain('approvals_reviewer');
    expect(off).not.toContain('[auto_review]');
  });

  test('emits [auto_review].policy only alongside auto_review, and drops a blank policy', () => {
    const withPolicy = buildCodexConfigToml({ ...opts, approvalsReviewer: 'auto_review', autoReviewPolicy: 'Deny writes outside the repo.' });
    expect(withPolicy).toContain('[auto_review]');
    expect(withPolicy).toContain('policy = "Deny writes outside the repo."');
    expect(() => validateConfigAgainstSchema(
      { ...opts, approvalsReviewer: 'auto_review', autoReviewPolicy: 'Deny writes outside the repo.' }, SCHEMA,
    )).not.toThrow();
    // A policy with no reviewer emits neither the table nor the scalar.
    const policyAlone = buildCodexConfigToml({ ...opts, autoReviewPolicy: 'ignored' });
    expect(policyAlone).not.toContain('[auto_review]');
    expect(policyAlone).not.toContain('approvals_reviewer');
    // A blank/whitespace policy under auto_review emits the scalar but no table.
    const blank = buildCodexConfigToml({ ...opts, approvalsReviewer: 'auto_review', autoReviewPolicy: '   ' });
    expect(blank).toContain('approvals_reviewer = "auto_review"');
    expect(blank).not.toContain('[auto_review]');
  });

  test('eligibility: a `never` approval policy degrades to NOT emitting auto_review', () => {
    // Direct never.
    const never = buildCodexConfigToml({ ...opts, approvalsReviewer: 'auto_review', approvalPolicy: 'never' });
    expect(never).toContain('approval_policy = "never"');
    expect(never).not.toContain('approvals_reviewer');
    // Mode-derived never: `dontAsk` with the sandbox master switch ON → `never`.
    const dontAsk = buildCodexConfigToml({ ...opts, approvalsReviewer: 'auto_review', mode: 'dontAsk', sandboxGloballyEnabled: true });
    expect(dontAsk).not.toContain('approvals_reviewer');
    // Positive control: an interactive mode DOES emit it.
    const def = buildCodexConfigToml({ ...opts, approvalsReviewer: 'auto_review', mode: 'default', sandboxGloballyEnabled: true });
    expect(def).toContain('approvals_reviewer = "auto_review"');
  });

  test('placement: approvals_reviewer is a top-level scalar (before [features]); [auto_review] is a table after it', () => {
    const toml = buildCodexConfigToml({ ...opts, approvalsReviewer: 'auto_review', autoReviewPolicy: 'x' });
    const scalarIdx = toml.indexOf('approvals_reviewer =');
    const featuresIdx = toml.indexOf('[features]');
    const autoReviewIdx = toml.indexOf('[auto_review]');
    expect(scalarIdx).toBeGreaterThan(-1);
    expect(scalarIdx).toBeLessThan(featuresIdx);        // scalar stays in the top block
    expect(autoReviewIdx).toBeGreaterThan(featuresIdx); // the table sits among the tables
  });
});

/**
 * P6.99 — `features.retain_client_developer_messages` is REFUSED by name, and
 * the reason travels with the refusal.
 *
 * The precedent is P3.306 (`4eac7ac8f`): a codex feature key that looks like a
 * mechanism is emitted with its value or refused with its reason, never left as
 * a silent absence — because from outside the two are the same file.
 *
 * Read at `rust-v0.150.1`, `features/src/lib.rs`: `Stage::UnderDevelopment`,
 * `default_enabled: false`, doc "Retain client-authored developer messages
 * across compacted context windows" — and it is NOT in `apply_map`'s fourteen
 * `continue` arms, so writing it would genuinely enable the path rather than be
 * inert like `tool_search`/`codex_git_commit`. Refused on two grounds recorded
 * at the site: upstream calls the code not ready, and codex compacts
 * server-side so we could never see whether the retention happened.
 */
describe('P6.99 tripwire — retain_client_developer_messages stays unwritten, by decision', () => {
  const RETAIN_KEY = 'retain_client_developer_messages';
  /** The same positive controls P3.306's tripwire uses: these ARE emitted. */
  const CONTROLS = ['[features]', 'multi_agent = true', 'view_image = true'] as const;
  const BASE = { codexHome: 'unused-home', model: 'tgpt/qwen35-397b-a17b-fp8', adapterPort: 54321 } as const;

  test('no mode, in either sandbox switch position, emits the key', () => {
    for (const sandboxGloballyEnabled of [true, false]) {
      for (const mode of ALL_MODES) {
        const toml = buildCodexConfigToml({ ...BASE, mode, sandboxGloballyEnabled });
        for (const control of CONTROLS) expect(toml).toContain(control);
        expect(toml, `mode ${mode}`).not.toContain(RETAIN_KEY);
      }
    }
  });

  /**
   * The refusal is RECORDED at the site, not merely an absent key — and the
   * assertion is SLICED to this row's own block, because P3.306's twin measured
   * a file-wide search staying green while the reason had been deleted (its
   * neighbour three paragraphs up says the same words about different keys).
   */
  test('the refusal and its reason live in the P6.99 block itself', async () => {
    const text = await Bun.file(new URL('../config-writer.ts', import.meta.url)).text();
    const start = text.indexOf('// P6.99 ·');
    expect(start, 'no P6.99 comment block in config-writer.ts').toBeGreaterThan(-1);
    const end = text.indexOf('// P3.306 ·', start);
    expect(end, 'the P6.99 block is not followed by the P3.306 one').toBeGreaterThan(start);
    const block = text.slice(start, end);

    // Positive control that the slice is a slice: the neighbour's key must be
    // OUTSIDE it, so a file-wide search could not have produced this pass.
    expect(block).toContain(RETAIN_KEY);
    expect(block).not.toContain('codex_git_commit');

    // The reason, in the three parts that make it a decision rather than a gap.
    expect(block).toContain('Stage::UnderDevelopment');
    expect(block).toContain('not ready for external use');
    expect(block).toContain('EXIT CONDITION');
  });

  /**
   * The key is real and settable — the half that makes the refusal meaningful.
   * If a codex bump removed the property, this row's decision would be about
   * nothing and should be re-read rather than left standing.
   */
  test('the key it refuses is a real property of the pinned release schema', () => {
    const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
    expect(schema.properties.features.properties[RETAIN_KEY]).toEqual({ type: 'boolean' });
    expect(schema.definitions.ConfigProfile.properties.features.properties[RETAIN_KEY])
      .toEqual({ type: 'boolean' });
  });
});
