/**
 * P6.14 — pins for codex's own inline `[hooks]` table.
 *
 * ## What this suite can and cannot settle
 *
 * It settles SHAPE: which keys are written, in which case, under which table
 * header, and what this writer refuses to emit. The claim it cannot make is
 * "the binary accepts this" — a string assertion never could, and codex fails a
 * config OPEN and WHOLE-FILE, so being wrong costs `[permissions]`, the
 * execpolicy pointer and every deny floor at once, reported only as a
 * `configWarning` nobody was reading before P3.81.
 *
 * That half is MEASURED instead, and it is no longer measured HERE: the three
 * arms live in the sibling `config-writer-hooks-live.test.ts`, which boots the
 * shipped `codex-app-server` and skips loudly where the binary is absent. They
 * were prose in this header until 2026-09-11, dated 2026-08-29 against a binary
 * two tags behind the one we ship, which is exactly the decay an executable arm
 * does not have. What they establish, re-driven on `codex-app-server 0.150.1`
 * and unchanged from the 2026-08-29 reading:
 *
 *  - the table below boots with **no `configWarning`**, while one bad appended
 *    line on the same file produces "Invalid configuration; using defaults.";
 *  - `hooks/list` returns every entry with each field round-tripped —
 *    `matcher`, `timeoutSec: 12` (written under the `timeout` key), `async`,
 *    `statusMessage`, `source: "user"`, `enabled: true`, `warnings: []`,
 *    `errors: []`;
 *  - without a `[hooks.state]` entry each hook is `trustStatus: "untrusted"`;
 *    with the one this writer emits it is `"trusted"`, same binary, no warning.
 *
 * The schema half below is the standing guard: `validateConfigAgainstSchema`
 * checks every key we emit against the release `config-schema.json`, so a codex
 * rename fails here rather than in a user's session.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCodexConfigToml,
  buildCodexHooksToml,
  mintHostAuthoredCodexHooks,
  writeCodexConfig,
  validateConfigAgainstSchema,
  CODEX_HOOK_EVENTS,
  CODEX_HOOK_PROJECTION_NOTICE,
  type CodexConfigOptions,
  type CodexHostAuthoredHooksPlan,
  type CodexHooksPlan,
} from '../config-writer.ts';

const HERE = import.meta.dir;
const SCHEMA = join(HERE, '..', '..', '..', 'codex-protocol', 'schema', 'config-schema.json');
const BASE: CodexConfigOptions = {
  codexHome: '/nessy-codex-home',
  model: 'tgpt/qwen35-397b-a17b-fp8',
  adapterPort: 54321,
};

/**
 * P2.414 — the ONE door. Every plan in this suite goes through the mint,
 * because that is the only thing the writer projects: authorship is checked
 * where a plan is CONSTRUCTED, so a test that skipped this would be describing
 * a writer production does not have.
 *
 * The mint deliberately does not validate CONTENT, which is why the
 * blank-command / bad-timeout / unknown-event cases below still read the same:
 * host-authored garbage is still garbage, and the per-handler refusals are
 * unchanged.
 */
const hostAuthored = (plan: CodexHooksPlan): CodexHostAuthoredHooksPlan =>
  mintHostAuthoredCodexHooks(
    { origin: 'config-writer-hooks.test.ts', revocation: { kind: 'next-runtime-build' } },
    plan,
  );

const PLAN_SOURCE: CodexHooksPlan = {
  PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'echo guard', timeoutSec: 12, statusMessage: 'checking' }] }],
  PostToolUse: [{ hooks: [{ command: 'echo after', async: true }] }],
};
const PLAN = hostAuthored(PLAN_SOURCE);

describe('buildCodexHooksToml', () => {
  test('writes array-of-tables with the matcher between the group and its handlers', () => {
    // The ordering bug this pins is silent and total: after
    // `[[hooks.X.hooks]]` opens, a bare `matcher =` lands on the HANDLER, so
    // codex sees a matcher-less group carrying an unknown handler field — the
    // hook then runs on every tool call instead of the matched one.
    const { lines, diagnostics } = buildCodexHooksToml(PLAN);
    const toml = lines.join('\n');

    expect(diagnostics).toEqual([]);
    expect(toml.indexOf('[[hooks.PreToolUse]]')).toBeLessThan(toml.indexOf('matcher = "Bash"'));
    expect(toml.indexOf('matcher = "Bash"')).toBeLessThan(toml.indexOf('[[hooks.PreToolUse.hooks]]'));
    expect(toml).toContain('type = "command"');
    expect(toml).toContain('command = "echo guard"');
    expect(toml).toContain('async = true');
    expect(toml).toContain('statusMessage = "checking"');
  });

  test('the timeout key is `timeout`, never the wire spelling `timeoutSec`', () => {
    // The two generated artifacts genuinely disagree and both are right:
    // `config-schema.json`'s HookHandlerConfig (TOML) says `timeout`, the
    // generated `ConfiguredHookHandler` (wire) says `timeoutSec`. Writing the
    // wire spelling is an unknown key — the timeout silently reverts to
    // codex's own default, which the live probe measured at 600 s.
    const toml = buildCodexHooksToml(PLAN).lines.join('\n');

    expect(toml).toContain('timeout = 12');
    expect(toml).not.toContain('timeoutSec');
  });

  test('emits nothing at all for an absent plan', () => {
    // The default that keeps this capability free. codex fails a config OPEN
    // and WHOLE-FILE, so a session that passes no plan must be byte-identical
    // to one written before this option existed.
    expect(buildCodexHooksToml(undefined)).toEqual({ lines: [], diagnostics: [] });
    expect(buildCodexHooksToml(hostAuthored({}))).toEqual({ lines: [], diagnostics: [] });
    expect(buildCodexConfigToml(BASE)).not.toContain('[hooks');
  });

  test('rejects a control-bearing command rather than escaping it, and says so', () => {
    // `tomlString` would escape a newline to `\\n` and the file would parse —
    // which is exactly the danger. codex hands `command` to a shell, so a
    // newline inside it is a second command its author never wrote.
    const { lines, diagnostics } = buildCodexHooksToml(hostAuthored({
      PreToolUse: [{ hooks: [{ command: 'echo ok\nrm -rf .' }] }],
    }));

    expect(lines).toEqual([]);
    expect(diagnostics.join('\n')).toContain('control character');
    expect(diagnostics.join('\n')).toContain('a second command');
  });

  test('drops a blank command, a bad timeout and an unknown event — each with its own line', () => {
    // Fail-closed, one handler at a time: the rest of the table still writes.
    // A silent drop here is the advertised-but-dead shape P6.13 exists to stop.
    const { lines, diagnostics } = buildCodexHooksToml(hostAuthored({
      PreToolUse: [{ hooks: [{ command: '   ' }] }],
      PostToolUse: [{ hooks: [{ command: 'echo x', timeoutSec: 1.5 }] }],
      Stop: [{ hooks: [{ command: 'echo survives' }] }],
      NotAnEvent: [{ hooks: [{ command: 'echo nope' }] }],
    } as unknown as CodexHooksPlan));

    expect(diagnostics.join('\n')).toContain('handler has no command');
    expect(diagnostics.join('\n')).toContain('not a non-negative integer');
    // The count comes from the constant, not from a literal: this line was
    // written as "codex's 11 hook events" and went red at the 2026-09-11 lift
    // for the one reason a drift guard must never go red — the thing it guards
    // became MORE correct. What the case is actually for is that an unrecognised
    // key is refused BY NAME, which is the half a literal was hiding.
    expect(diagnostics.join('\n')).toContain(
      `Codex hook not projected for NotAnEvent: not one of codex's ${CODEX_HOOK_EVENTS.length} hook events`,
    );
    // One line per FACT. A group whose handlers were each rejected must not add
    // a second, contentless group-level line on top of them — that is the noise
    // that trains a reader to skim past these, which is how the next real one
    // gets missed. An EMPTY group is a different fact and still reports.
    expect(diagnostics.filter(line => line.includes('PreToolUse'))).toHaveLength(1);
    expect(buildCodexHooksToml(hostAuthored({ Stop: [{ hooks: [] }] })).diagnostics.join('\n'))
      .toContain('no handler at all');
    const toml = lines.join('\n');
    expect(toml).toContain('[[hooks.Stop]]');
    expect(toml).not.toContain('NotAnEvent');
    expect(toml).not.toContain('echo nope');
  });

  test('the trust table is written with a QUOTED key, because codex keys carry `/` and `.`', () => {
    // An unquoted `a.b.c` key opens nested tables instead of naming one hook,
    // and codex's key is a filesystem path plus `:<event>:<group>:<handler>`.
    // Measured: with this entry the same hook goes `untrusted` -> `trusted`.
    const toml = buildCodexHooksToml(hostAuthored({
      ...PLAN_SOURCE,
      state: { '/tmp/h/config.toml:pre_tool_use:0:0': 'sha256:abc' },
    })).lines.join('\n');

    expect(toml).toContain('[hooks.state."/tmp/h/config.toml:pre_tool_use:0:0"]');
    expect(toml).toContain('trusted_hash = "sha256:abc"');
    expect(toml).toContain('enabled = true');
  });

  test('a trust entry with no hash is refused, not written empty', () => {
    // An empty `trusted_hash` is a claim of trust backed by nothing.
    const { lines, diagnostics } = buildCodexHooksToml(hostAuthored({ state: { 'k': '  ' } }));

    expect(lines).toEqual([]);
    expect(diagnostics.join('\n')).toContain('no usable hash');
  });

  test('the same plan always produces the same bytes', () => {
    // `codexThreadConfigSignature` hashes this file's output, so a key-order
    // dependent emission would respawn the codex runtime for no reason.
    const shuffled: CodexHooksPlan = {
      state: { b: 'sha256:2', a: 'sha256:1' },
      PostToolUse: PLAN_SOURCE.PostToolUse,
      PreToolUse: PLAN_SOURCE.PreToolUse,
    };

    expect(buildCodexHooksToml(hostAuthored(shuffled)).lines).toEqual(
      buildCodexHooksToml(hostAuthored({ ...PLAN_SOURCE, state: { a: 'sha256:1', b: 'sha256:2' } })).lines,
    );
  });
});

describe('the hooks table inside a whole config', () => {
  test('sits after every bare assignment and before `[agents]`', () => {
    // Array-of-tables placement is load-bearing twice over: a bare key emitted
    // after `[[hooks.X.hooks]]` lands inside the handler, and `[agents]` must
    // stay last because every key under it is a role name.
    const toml = buildCodexConfigToml({
      ...BASE,
      hooks: PLAN,
      agents: [{
        key: 'r',
        name: 'reviewer',
        selectedAsUnqualifiedAlias: true,
        description: 'reviews',
        systemPrompt: 'Review carefully.',
      }],
    });
    const firstHook = toml.indexOf('[[hooks.');
    const firstAgent = toml.indexOf('[agents.');

    expect(firstHook).toBeGreaterThan(-1);
    expect(firstAgent).toBeGreaterThan(firstHook);
    // Nothing bare after the table: every later line is a header, a key inside
    // one, a comment or blank.
    for (const line of toml.slice(firstHook).split('\n')) {
      if (!line.trim() || line.startsWith('[') || line.startsWith('#')) continue;
      expect(line).toMatch(/^[A-Za-z_]+ = /);
    }
  });

  test('validates every emitted key against the release config-schema.json', () => {
    // The drift guard this surface needs most: `HooksToml` is keyed by event
    // NAME, and a key it has no field for is dropped in silence.
    expect(() => validateConfigAgainstSchema({ ...BASE, hooks: PLAN }, SCHEMA)).not.toThrow();
    expect(() => validateConfigAgainstSchema(BASE, SCHEMA)).not.toThrow();

    const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
    for (const event of CODEX_HOOK_EVENTS) {
      expect(schema.definitions.HooksToml.properties).toHaveProperty(event);
    }
    // And the OTHER direction, which this test lacked until the 2026-09-11 lift.
    // A subset tie only catches a key we emit that codex has dropped; it stayed
    // green right through codex ADDING one (`Interrupt`, upstream #40511) and
    // said nothing, so the writer would have gone on refusing a key the binary
    // understands. `state` is the single HooksToml property that is not an
    // event — it is the trust table, and a list that swallowed it would emit
    // `[[hooks.state]]`.
    expect(
      Object.keys(schema.definitions.HooksToml.properties).filter((key: string) => key !== 'state').sort(),
    ).toEqual([...CODEX_HOOK_EVENTS].sort() as string[]);
    expect([...CODEX_HOOK_EVENTS] as string[]).not.toContain('state');
    // The negative that proves the guard reads the schema rather than a copy of
    // this list: a renamed event must fail rather than emit a dead key.
    const renamed = join(mkdtempSync(join(tmpdir(), 'p614-schema-')), 'config-schema.json');
    delete schema.definitions.HooksToml.properties.PreToolUse;
    Bun.write(renamed, JSON.stringify(schema));
    expect(() => validateConfigAgainstSchema({ ...BASE, hooks: PLAN }, renamed))
      .toThrow('config-schema.json HooksToml has no property "PreToolUse"');
    rmSync(renamed, { force: true });
  });

  test('writeCodexConfig reports every refused hook exactly once', () => {
    // Same cadence as the role, denied-path and egress diagnostics: a hook this
    // writer refused is a hook its author believes is running, and only this
    // line says otherwise.
    const home = mkdtempSync(join(tmpdir(), 'p614-home-'));
    const messages: string[] = [];
    try {
      const path = writeCodexConfig({
        ...BASE,
        codexHome: home,
        hooks: hostAuthored({ PreToolUse: [{ hooks: [{ command: '' }] }], Stop: [{ hooks: [{ command: 'echo ok' }] }] }),
        onDiagnostic: message => messages.push(message),
      });

      expect(messages.filter(m => m.startsWith('Codex hook not projected'))).toHaveLength(1);
      expect(readFileSync(path, 'utf8')).toContain('[[hooks.Stop]]');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('P2.414 — the projection filter is AUTHORSHIP, checked at construction', () => {
  test('a plan the host did not mint is refused WHOLE, and the line says why', () => {
    // The owner's decision in one assertion: a user- or plugin-authored hook is
    // not projected, whatever it contains. It is refused whole rather than
    // handler-by-handler because a non-host plan is not a plan with a bad entry
    // in it — salvaging the tame-looking parts is exactly the widening the
    // decision forbids.
    //
    // The cast is the point: the compile-time brand already stops this call, so
    // the only way to reach the runtime gate is to defeat the type — which is
    // precisely what a determined caller would do.
    const raw = { Stop: [{ hooks: [{ command: 'echo user-authored' }] }] } as unknown as CodexHostAuthoredHooksPlan;
    const { lines, diagnostics } = buildCodexHooksToml(raw);

    expect(lines).toEqual([]);
    expect(diagnostics.join('\n')).toContain('not host-authored');
    expect(diagnostics.join('\n')).toContain('stay host-side');
    // Same command, minted: projected. The difference is authorship and nothing
    // else, which is what makes this a filter on authorship rather than content.
    expect(buildCodexHooksToml(hostAuthored({ Stop: [{ hooks: [{ command: 'echo user-authored' }] }] })).lines.join('\n'))
      .toContain('command = "echo user-authored"');
  });

  test('a minted plan edited afterwards is no longer host-authored', () => {
    // Consequence (1): "a host hook whose command was later edited by anything
    // else is no longer host-authored". Two mechanisms carry it and there is no
    // third: the mint deep-freezes, so an in-place edit THROWS, and any copy is
    // a different object the registry has never seen.
    const minted = hostAuthored({ Stop: [{ hooks: [{ command: 'echo ours' }] }] });

    expect(() => {
      (minted.Stop as { hooks: { command: string }[] }[])[0]!.hooks[0]!.command = 'echo theirs';
    }).toThrow();

    // A spread copy carrying one changed command is a DIFFERENT object, so it
    // is not in the registry at all — the commonest way this would really be
    // widened by accident.
    const copied = { ...minted, Stop: [{ hooks: [{ command: 'echo theirs' }] }] } as unknown as CodexHostAuthoredHooksPlan;
    expect(buildCodexHooksToml(copied).lines).toEqual([]);
    expect(buildCodexHooksToml(copied).diagnostics.join('\n')).toContain('not host-authored');
  });

  test('an in-command revocation claim with nothing behind it is refused', () => {
    // Consequence (3): a projected hook is outside ProcessSupervisor, outside
    // plugin-integrity verification and outside the managed kill switches. A
    // claim that it can be stopped at runtime, naming nothing that stops it, is
    // worse than admitting there is no such switch.
    const claimed = mintHostAuthoredCodexHooks(
      { origin: 'a-lane-that-did-not-build-it', revocation: { kind: 'in-command', evidence: '  ' } },
      { Stop: [{ hooks: [{ command: 'echo ours' }] }] },
    );
    const { lines, diagnostics } = buildCodexHooksToml(claimed);

    expect(lines).toEqual([]);
    expect(diagnostics.join('\n')).toContain('a-lane-that-did-not-build-it');
    expect(diagnostics.join('\n')).toContain('names nothing that revokes it');

    // Evidence supplied: projected, because the switch now exists to point at.
    const evidenced = mintHostAuthoredCodexHooks(
      { origin: 'a-lane-that-did', revocation: { kind: 'in-command', evidence: 'the guard file the host writes into CODEX_HOME' } },
      { Stop: [{ hooks: [{ command: 'echo ours' }] }] },
    );
    expect(buildCodexHooksToml(evidenced).lines.join('\n')).toContain('[[hooks.Stop]]');
  });

  test('writeCodexConfig writes no [hooks] table for a plan it did not author', () => {
    // The whole-file consequence: an unauthored plan must cost the config
    // NOTHING, not even an empty header — codex fails a config open and
    // whole-file, and the deny floors beside it are the thing at risk.
    const home = mkdtempSync(join(tmpdir(), 'p2414-home-'));
    const messages: string[] = [];
    try {
      const path = writeCodexConfig({
        ...BASE,
        codexHome: home,
        hooks: { Stop: [{ hooks: [{ command: 'echo not-ours' }] }] } as unknown as CodexHostAuthoredHooksPlan,
        onDiagnostic: message => messages.push(message),
      });

      const toml = readFileSync(path, 'utf8');
      expect(toml).not.toContain('[hooks');
      expect(toml).not.toContain('echo not-ours');
      expect(messages.filter(m => m.includes('not host-authored'))).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the notice names both halves: what is not projected, and why', () => {
    // Consequence (2). An empty table reads as "no hooks"; this sentence is
    // what stops that reading, so its two halves are pinned rather than left to
    // a later edit that trims the reason as redundant.
    expect(CODEX_HOOK_PROJECTION_NOTICE).toContain('NOT projected');
    expect(CODEX_HOOK_PROJECTION_NOTICE).toContain('their content is not ours');
    expect(CODEX_HOOK_PROJECTION_NOTICE).toContain('still run host-side');
  });
});

/**
 * P6.1068 — the `mcp_tool` handler kind, pinned so its REASON cannot rot.
 *
 * `buildCodexHooksToml`'s §"Why `command` only" used to say an emitted
 * `mcp_tool` handler would never run. That was true of the binary shipped on
 * 2026-08-29 and false at `rust-v0.150.1`: upstream #39296 landed a dispatch
 * arm (`codex-rs/hooks/src/engine/dispatcher.rs`, `ConfiguredHandlerKind::McpTool`
 * -> `run_mcp_tool`). The replacement reason is three facts about the VARIANT's
 * own fields, which is what this test exists for: a prose reason beside a
 * generated artifact ages silently, and this one already did once.
 *
 * Both directions on purpose. A subset tie is what let `Interrupt` arrive
 * unnoticed in the sibling test above, and the fact that would most change this
 * decision is codex ADDING a field — a way to hand the handler the whole hook
 * event, or an `async` of its own.
 */
describe('P6.1068 — `mcp_tool` is RUN by codex, and the fields are why it is still not projected', () => {
  const variants = (): Array<{ properties: Record<string, unknown>; required?: string[] }> =>
    JSON.parse(readFileSync(SCHEMA, 'utf8')).definitions.HookHandlerConfig.oneOf;

  const variantNamed = (type: string): { properties: Record<string, unknown>; required?: string[] } => {
    const found = variants().find(v => {
      const t = v.properties.type as { enum?: string[] } | undefined;
      return t?.enum?.length === 1 && t.enum[0] === type;
    });
    if (!found) throw new Error(`config-schema.json HookHandlerConfig has no "${type}" variant`);
    return found;
  };

  test('the four kinds are still four, and `mcp_tool` still takes server+tool+template', () => {
    // The denominator, read from the release schema rather than counted in a
    // sentence. `ConfiguredHookHandler` (the WIRE shape) declares the same four.
    expect(
      variants()
        .map(v => ((v.properties.type as { enum: string[] }).enum[0]))
        .sort(),
    ).toEqual(['agent', 'command', 'mcp_tool', 'prompt']);

    const mcp = variantNamed('mcp_tool');
    // FACT (1) — what it receives. `input` is an argument TEMPLATE expanded by
    // `expand_mcp_argument_template` against the hook event; a missing field
    // FAILS the hook. There is deliberately no assertion that some
    // "payload"/"event" field is absent by name — the honest guard is that the
    // property set is exactly these five, so ANY new field fails here and gets
    // read.
    expect(Object.keys(mcp.properties).sort())
      .toEqual(['input', 'server', 'statusMessage', 'timeout', 'tool', 'type']);
    expect([...(mcp.required ?? [])].sort()).toEqual(['server', 'tool', 'type']);
  });

  test('`async` and `additionalContextLimit` are command-only, which a projection would silently drop', () => {
    // FACT (3). `discovery.rs`'s `McpTool` arm sets
    // `additional_context_limit: None` unconditionally, and `async` is not a
    // field of the variant at all — so this is the schema agreeing with the
    // source, not a second reading of the same file.
    const command = Object.keys(variantNamed('command').properties);
    const mcp = Object.keys(variantNamed('mcp_tool').properties);
    for (const control of ['async', 'additionalContextLimit', 'command', 'commandWindows']) {
      expect(command).toContain(control);
      expect(mcp).not.toContain(control);
    }
    // The positive control that proves the two lists are read from different
    // variants rather than from one: `timeout` and `statusMessage` are in BOTH.
    for (const shared of ['timeout', 'statusMessage']) {
      expect(command).toContain(shared);
      expect(mcp).toContain(shared);
    }
  });

  test('a matcher naming an MCP tool is projected exactly as a native one is: `type = "command"`', () => {
    // The pair the row asked for, in the shape production actually has. The
    // host authors no hooks at all today, so there is nothing to project as
    // `mcp_tool`; what IS assertable is that the matcher text never changes the
    // handler kind — an `mcp__server__tool` matcher goes out as a command hook
    // like any other, and no `type` line in this writer's output is anything
    // else.
    const { lines, diagnostics } = buildCodexHooksToml(
      hostAuthored({
        PreToolUse: [
          { matcher: 'mcp__session__Monitor', hooks: [{ command: 'echo mcp-matcher' }] },
          { matcher: 'Bash', hooks: [{ command: 'echo native-matcher' }] },
        ],
      }),
    );

    expect(diagnostics).toEqual([]);
    const typeLines = lines.filter(line => line.startsWith('type = '));
    expect(typeLines).toEqual(['type = "command"', 'type = "command"']);
    expect(lines).toContain('matcher = "mcp__session__Monitor"');
    expect(lines.join('\n')).not.toContain('mcp_tool');
  });

  /**
   * D1.112 — the WIRE type as a SECOND instrument, and the reopen condition
   * named so a future lane meets it instead of re-deriving it.
   *
   * The three cases above all read `config-schema.json`. The comment on the
   * first of them asserts that `ConfiguredHookHandler`, the generated WIRE
   * shape, "declares the same four" — and nothing checked it. The two artifacts
   * are regenerated by different paths out of the same Rust types, so agreement
   * is evidence and disagreement would be the loudest possible signal that one
   * of them is stale.
   *
   * What this pins is the REOPEN CONDITION for the `mcp_tool` posture, which is
   * a single fact in two spellings: the variant carries NO way to hand the
   * handler the hook event and NO channel for a decision back. Re-driven at
   * `rust-v0.154.0` on 2026-09-17 against the source
   * (`hooks/src/engine/mcp_runner.rs`): `run_mcp_tool` maps its result to
   * `(Some(0), output, None)` on success and `(None, String::new(),
   * Some(error))` on failure, so a FAILED call yields empty stdout and no exit
   * status — a `PreToolUse` deny projected this way would fail OPEN, which is
   * the reason the posture is recommended against rather than merely priced.
   * The day codex adds a payload field or a decision field to this variant,
   * this case fails and the recommendation should be re-read.
   */
  test('D1.112 — the generated WIRE variant agrees with the schema, and carries no payload or decision field', () => {
    const wire = readFileSync(
      join(HERE, '..', '..', '..', 'codex-protocol', 'generated', 'v2', 'ConfiguredHookHandler.ts'),
      'utf8',
    );
    // Sliced variant-to-variant, NOT to the first `}`: `input`'s own
    // `{ [key in string]?: JsonValue }` closes a brace inside this variant, so a
    // first-brace slice silently drops `timeoutSec` and `statusMessage` and every
    // absence below would then pass for the wrong reason.
    const mcpStart = wire.indexOf('{ "type": "mcp_tool"');
    const mcpEnd = wire.indexOf('{ "type": "prompt"', mcpStart);
    expect(mcpStart).toBeGreaterThan(-1);
    expect(mcpEnd).toBeGreaterThan(mcpStart);
    const mcpFields = wire.slice(mcpStart, mcpEnd);
    expect(mcpFields).toContain('server: string');
    expect(mcpFields).toContain('tool: string');
    expect(mcpFields).toContain('timeoutSec: bigint | null');
    expect(mcpFields).toContain('statusMessage: string | null');
    // The only carrier is the argument TEMPLATE, keyed and typed as JSON.
    expect(mcpFields).toContain('input: {');
    // The reopen condition, in both spellings. A field handing over the event,
    // or any channel for a decision back, would change the answer.
    for (const absent of ['async', 'additionalContextLimit', 'exitCode', 'decision', 'payload', 'event']) {
      expect(mcpFields).not.toContain(absent);
    }
    // POSITIVE CONTROL on the same instrument, so the absences above cannot pass
    // against a slice that came back empty or against the wrong variant: the
    // COMMAND variant carries the two controls this one drops.
    const commandVariant = wire.slice(wire.indexOf('{ "type": "command"'), mcpStart);
    expect(commandVariant).toContain('async: boolean');
    expect(commandVariant).toContain('additionalContextLimit: number | null');
    // And the four kinds are four in this artifact too.
    expect([...wire.matchAll(/\{ "type": "(\w+)"/g)].map(m => m[1]).sort())
      .toEqual(['agent', 'command', 'mcp_tool', 'prompt']);
  });
});
