/**
 * P6.166 — codex's own `[memories]` table, and the host off-switch that now
 * reaches it.
 *
 * ## The gap
 *
 * `getMemoryEnabled()` is the ONE host switch. Pi honours it on its own path,
 * claude got `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` at P6.33, and codex honoured
 * nothing: `[memories]` appeared in three docblock lines of `codex-agent.ts` and
 * in zero emitted keys. So a user who turned memory off and switched a session
 * to codex silently got it back on — the setting-silently-reversed shape that is
 * this fork's largest defect class.
 *
 * ## MEASURED ON THE SHIPPED BINARY BEFORE ANY OF IT WAS WRITTEN
 *
 * `codex-app-server` at `rust-v0.148.0` (the `darwin-arm64` artefact this repo
 * ships), isolated `CODEX_HOME`, the `startStubAdapter` loopback Responses
 * provider that `codex-inject-items-e2e.test.ts` uses, one real `turn/start` per
 * arm, then `state_5.sqlite` read directly with `sqlite3`:
 *
 * | `[memories]`      | `threads.memory_mode` | developer prompt        |
 * | ----------------- | --------------------- | ----------------------- |
 * | absent (control)  | `enabled`             | 20 751 chars, no memory |
 * | both keys `false` | **`disabled`**        | 20 751 chars, no memory |
 *
 * That reproduces the schema's own sentence exactly — "When `false`, newly
 * created threads are stored with `memory_mode = \"disabled\"` in the state DB"
 * — and the live column default read out of the same file is
 * `memory_mode TEXT NOT NULL DEFAULT 'enabled'`, which is what makes the control
 * arm the meaningful half of the pair. So the fallback the row allowed for (a
 * switch-cost row, if codex ignored the keys) is NOT taken: codex honours them.
 *
 * **`use_memories` is unobservable on that rig and is recorded as such rather
 * than claimed.** Its sentence is "When `false`, skip injecting memory usage
 * instructions into developer prompts", and the prompt was byte-identical at
 * 20 751 characters in both arms with no memory text in either — a fresh
 * `CODEX_HOME` has no memories to instruct about, so the key had nothing to
 * remove. It is written anyway, for the reason at the option's docblock.
 *
 * ## WHAT EACH TEST KILLS
 *
 *  - "writes both keys when the host switch is off" dies if the emission is
 *    removed — the shipped state.
 *  - "writes NOTHING when memory is on" is the direction that matters as much:
 *    writing our `true` would re-assert a default we did not choose, on a
 *    subsystem whose defaults are codex's.
 *  - "an undeclared switch writes nothing" covers the throw path — a switch we
 *    could not read decides nothing.
 *  - the PLACEMENT test dies on the trap this writer has recorded twice: a bare
 *    key emitted after a table header lands inside that table.
 *  - the schema-guard tests die if the keys are renamed upstream, which would
 *    otherwise be SILENT on this binary and would take the user's off-switch
 *    with it.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCodexConfigToml,
  validateConfigAgainstSchema,
  type CodexConfigOptions,
} from '../config-writer.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(HERE, '..', '..', '..', 'codex-protocol', 'schema', 'config-schema.json');
const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

function opts(over: Partial<CodexConfigOptions> = {}): CodexConfigOptions {
  return { codexHome: '/tmp/codex-home', model: MODEL, adapterPort: 54321, mode: 'default', ...over };
}

describe('P6.166 · the host auto-memory switch reaches codex', () => {
  test('writes both keys when the host switch is off', () => {
    const toml = buildCodexConfigToml(opts({ memoriesEnabled: false }));
    expect(toml).toContain('[memories]');
    expect(toml).toContain('generate_memories = false');
    expect(toml).toContain('use_memories = false');
    // It parses — a table emitted in the wrong place is not a syntax error, it
    // is a DIFFERENT config, so this is necessary and not sufficient.
    expect(Bun.TOML.parse(toml)).toHaveProperty('memories');
  });

  test('writes NOTHING when memory is on', () => {
    // `true` is not the opposite of `false` here: an absent table means codex's
    // own defaults, and writing our `true` would re-assert a default we did not
    // choose.
    const toml = buildCodexConfigToml(opts({ memoriesEnabled: true }));
    expect(toml).not.toContain('[memories]');
    // POSITIVE CONTROL that a config was built at all.
    expect(toml).toContain(`model = "${MODEL}"`);
  });

  test('writes nothing when the switch was never declared', () => {
    // The throw path in `CodexAgent.codexMemoriesOption` lands here: a switch we
    // could not read decides nothing, exactly as it decides nothing for claude.
    expect(buildCodexConfigToml(opts())).not.toContain('[memories]');
  });

  test('the keys sit inside their own table, not after the next header', () => {
    const toml = buildCodexConfigToml(opts({
      memoriesEnabled: false,
      sessionMcp: { command: '/bin/node', args: ['server.js'] },
      poolMcpUrl: 'http://127.0.0.1:45999/mcp',
    }));
    const at = toml.indexOf('[memories]');
    expect(at).toBeGreaterThan(-1);
    const after = toml.slice(at + '[memories]'.length);
    const nextAt = after.search(/^\[/m);
    const between = nextAt === -1 ? after : after.slice(0, nextAt);
    expect(between).toContain('generate_memories = false');
    expect(between).toContain('use_memories = false');
    // And the parse agrees the keys belong to this table rather than to a
    // neighbour that swallowed them.
    const parsed = Bun.TOML.parse(toml) as { memories?: Record<string, unknown> };
    expect(parsed.memories).toEqual({ generate_memories: false, use_memories: false });
  });

  test('every bare top-level key still parses as top-level beside it', () => {
    // The trap this writer records twice: anything BARE emitted after a table
    // header lands inside that table. `model` is bare and comes first, so a
    // `[memories]` emitted too early would swallow whatever followed it.
    const parsed = Bun.TOML.parse(
      buildCodexConfigToml(opts({ memoriesEnabled: false })),
    ) as Record<string, unknown>;
    expect(parsed.model).toBe(MODEL);
    expect(parsed.model_provider).toBe('nessy_gateway');
  });

  test('the schema guard accepts the config we write', () => {
    expect(() => validateConfigAgainstSchema(opts({ memoriesEnabled: false }), SCHEMA)).not.toThrow();
  });

  test('the schema guard refuses a build whose keys upstream renamed', () => {
    // A rename is SILENT on this binary — an unknown key is simply ignored — so
    // this guard is the only detector, and the off-switch would otherwise stop
    // reaching codex without a sign. The rename is simulated by handing the
    // guard a schema with the property removed, which is what a rename looks
    // like from this side.
    const renamed = JSON.parse(readFileSync(SCHEMA, 'utf8'));
    delete renamed.definitions.MemoriesToml.properties.generate_memories;
    const renamedPath = join(tmpdir(), `codex-memories-schema-${process.pid}.json`);
    writeFileSync(renamedPath, JSON.stringify(renamed));
    try {
      expect(() => validateConfigAgainstSchema(opts({ memoriesEnabled: false }), renamedPath))
        .toThrow(/generate_memories/);
      // The guard only fires when we WRITE the table: an on-switch build must
      // pass against the renamed schema too, or the guard is unconditional.
      expect(() => validateConfigAgainstSchema(opts(), renamedPath)).not.toThrow();
    } finally {
      rmSync(renamedPath, { force: true });
    }
    // NEGATIVE CONTROL: the unmodified schema does not throw, so the assertion
    // above is about the rename and not about the probe.
    expect(() => validateConfigAgainstSchema(opts({ memoriesEnabled: false }), SCHEMA)).not.toThrow();
  });

  test('the pinned schema still declares both keys with their measured meanings', () => {
    const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
    const props = schema.definitions.MemoriesToml.properties as Record<string, { type?: string; description?: string }>;
    expect(props.generate_memories?.type).toBe('boolean');
    expect(props.use_memories?.type).toBe('boolean');
    // The sentences the measurement reproduced, quoted from the schema itself so
    // a reworded upstream meaning is visible here rather than assumed away.
    expect(props.generate_memories?.description).toContain('memory_mode = "disabled"');
    expect(props.use_memories?.description).toContain('developer prompts');
    // A key that cannot exist — without it, "the schema has what we asked for"
    // would also be true of a probe that answered yes to everything.
    expect(props.nessy_not_a_memory_key).toBeUndefined();
  });
});
