/**
 * P6.33 — turning auto memory off, and having memory actually stop loading.
 *
 * `getMemoryEnabled()` is the whole gate on Pi. On a claude-runtime session it
 * gated only OUR prompt block: the SDK subprocess went on loading its own auto
 * memory directory at session start, so a user who turned memory off still had
 * memory in context by a path we neither controlled nor reported. One switch,
 * two meanings, and no diagnostic either way.
 *
 * ## The evidence the fix rests on, and which side it came from
 *
 * The AGENTS.md membership rule says the vendored bundle is the denominator when
 * asking what EXISTS. Here both sides agree, so the guard is not a bet on either
 * one — it is written down which is which:
 *
 * THE SHIPPED BINARY (`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, the
 * native CLI behind the vendored SDK 0.3.223 / claudeCodeVersion 2.1.223). Its
 * gate, `strings -a` with positive control `claudeMdExcludes` 3 and negative
 * control `nessyNotARealSdkKey` 0:
 *
 * ```js
 * function Nm(){ … let e=process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
 *   if(tr(e))return!1;                 // truthy → memory off
 *   if(ud(e))return!0;                 // "0"    → memory FORCED on
 *   … let t=eo(); if(t.autoMemoryEnabled!==void 0)return t.autoMemoryEnabled;
 *   return!0 }
 * ```
 *
 * THE PAGE, agreeing exactly. `env-vars.md#variables`, this variable's row: "Set
 * to `1` to disable auto memory. Set to `0` to force auto memory on even when
 * `--bare` mode or `autoMemoryEnabled: false` would otherwise disable it. When
 * disabled, Claude does not create or load auto memory files."
 * `memory.md#enable-or-disable-auto-memory`: "To disable auto memory via
 * environment variable, set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`."
 * `settings-reference.md#automemoryenabled`: the variable "takes precedence over
 * this key for one session, in either direction".
 *
 * ## What the second half of this suite guards, and why it is not symmetry
 *
 * The obvious implementation writes `'0'` when memory is on. That would be a
 * NEW defect wearing the shape of a fix: `'0'` does not mean "permitted", it
 * FORCES memory on over the user's own `autoMemoryEnabled: false`, over `--bare`
 * and over safe mode, and the binary confirms it — `ud(e)` returns before the
 * settings read. Our toggle being on means "we do not stop memory", so the SDK's
 * own resolution must be left alone.
 */
import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import * as configStorage from '../../config/storage.ts';

// `mock.module` is process-global and bun runs every file in one process, so the
// seam delegates to the real module outside this suite's own fixture and
// `afterAll` puts the untouched module back. Restoring from the imported
// namespace would restore the MOCK, so the snapshot is taken first.
const realStorage = { ...configStorage };

let memoryEnabled: boolean | Error = true;

mock.module('../../config/storage.ts', () => ({
  ...realStorage,
  getMemoryEnabled: () => {
    if (memoryEnabled instanceof Error) throw memoryEnabled;
    return memoryEnabled;
  },
}));

afterAll(() => {
  mock.module('../../config/storage.ts', () => realStorage);
});

const { buildClaudeSubprocessEnv } = await import('../options.ts');

const VARIABLE = 'CLAUDE_CODE_DISABLE_AUTO_MEMORY';

const priorAmbient = process.env[VARIABLE];

afterEach(() => {
  memoryEnabled = true;
  if (priorAmbient === undefined) delete process.env[VARIABLE];
  else process.env[VARIABLE] = priorAmbient;
});

describe('memory off reaches the SDK, not just our own prompt block', () => {
  it('sets the documented off switch when the toggle is off', () => {
    memoryEnabled = false;
    expect(buildClaudeSubprocessEnv()[VARIABLE]).toBe('1');
  });

  it('outranks an ambient `0`, which would otherwise force the child\'s memory back on', () => {
    memoryEnabled = false;
    process.env[VARIABLE] = '0';
    expect(buildClaudeSubprocessEnv()[VARIABLE]).toBe('1');
  });

  it('outranks a per-session override too — the toggle is the user\'s decision', () => {
    memoryEnabled = false;
    expect(buildClaudeSubprocessEnv({ [VARIABLE]: '0' })[VARIABLE]).toBe('1');
  });
});

describe('memory on writes nothing, because `0` is not the opposite of `1`', () => {
  it('leaves the variable unset so the SDK resolves env, then setting, then its default', () => {
    memoryEnabled = true;
    delete process.env[VARIABLE];
    expect(buildClaudeSubprocessEnv()[VARIABLE]).toBeUndefined();
  });

  it('does not overwrite a value the operator set', () => {
    memoryEnabled = true;
    process.env[VARIABLE] = '1';
    // An operator who disabled auto memory in their own environment has already
    // decided; our toggle being on is not a licence to re-enable it.
    expect(buildClaudeSubprocessEnv()[VARIABLE]).toBe('1');
  });
});

describe('a config that cannot be read decides nothing', () => {
  it('leaves the variable unset rather than failing the spawn', () => {
    memoryEnabled = new Error('UnsupportedStorageLayoutError');
    delete process.env[VARIABLE];
    expect(() => buildClaudeSubprocessEnv()).not.toThrow();
    expect(buildClaudeSubprocessEnv()[VARIABLE]).toBeUndefined();
  });
});

describe('the neighbouring knobs still land — this is one call, not four', () => {
  it('keeps the cron suppression and the retry ceiling', () => {
    memoryEnabled = false;
    const env = buildClaudeSubprocessEnv();
    expect(env.CLAUDE_CODE_DISABLE_CRON).toBe('1');
    expect(env.CLAUDE_CODE_MAX_RETRIES).toBeDefined();
  });
});

/**
 * P6.390 — the chat's own scope, on top of the app-wide switch.
 *
 * `settings-reference.md#automemoryenabled`: the variable "takes precedence over
 * this key for one session, in either direction". That is why the override is
 * resolved INSIDE the applier rather than folded into `envOverrides` by a
 * caller: the direction a caller cannot express is the chat that keeps memory ON
 * while the app-wide switch is off — writing nothing there would leave the
 * applier free to close it again.
 */
describe('P6.390 · the per-chat override, in either direction', () => {
  it('closes memory for one chat while the app-wide switch stays on', () => {
    memoryEnabled = true;
    delete process.env[VARIABLE];
    expect(buildClaudeSubprocessEnv(undefined, { read: false })[VARIABLE]).toBe('1');
    expect(buildClaudeSubprocessEnv(undefined, { write: false })[VARIABLE]).toBe('1');
  });

  it('lets one chat keep memory while the app-wide switch is off', () => {
    memoryEnabled = false;
    delete process.env[VARIABLE];
    // Still NOTHING rather than `0`: writing `0` would force memory on over the
    // user's own `autoMemoryEnabled: false`, over `--bare` and over safe mode.
    // Absence is what "we do not stop it" looks like.
    expect(buildClaudeSubprocessEnv(undefined, { read: true, write: true })[VARIABLE]).toBeUndefined();
  });

  it('an axis the chat left unset follows the app-wide switch', () => {
    memoryEnabled = false;
    delete process.env[VARIABLE];
    expect(buildClaudeSubprocessEnv(undefined, { read: true })[VARIABLE]).toBe('1');
    memoryEnabled = true;
    expect(buildClaudeSubprocessEnv(undefined, {})[VARIABLE]).toBeUndefined();
  });

  it('CONTROL: no override at all is byte-identical to before this row', () => {
    memoryEnabled = true;
    delete process.env[VARIABLE];
    expect(buildClaudeSubprocessEnv()[VARIABLE]).toBeUndefined();
    memoryEnabled = false;
    expect(buildClaudeSubprocessEnv()[VARIABLE]).toBe('1');
  });
});
