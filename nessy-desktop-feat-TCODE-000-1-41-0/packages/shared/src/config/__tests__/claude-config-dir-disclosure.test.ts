/**
 * C4.23 (L124) — the `CLAUDE_CONFIG_DIR` overwrite is DISCLOSED.
 *
 * The owner took option C on 2026-09-11: keep the per-Workspace overwrite
 * authoritative — honouring an explicitly chosen directory would give the `user`
 * settings scope, and a `permissions` block written there, authority over every
 * project at once — and remove the only thing about it that was actually bad,
 * the silence. A user who set the vendor's own documented spelling got no value,
 * no error and no alternative.
 *
 * So the deliverable is one record on the doctor's existing rejected-layers
 * surface, modelled on the user-scope `env` disclosure beside it: it names the
 * variable, says the value never reaches the runtime, and names
 * `NESSY_CONFIG_DIR` as the spelling that does move the configuration tree.
 *
 * The variable is set and cleared with `delete` first on both paths (AGENTS.md
 * §Traps: a plain assignment can leave a name readable by property and invisible
 * to a spread, and the restore path is where that bites). No real path from the
 * host's environment is written here.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { collectRejectedUserSettingsLayers } from '../storage.ts';
import { REJECTED_LAYER_REASON_MAX } from '../managed-drops.ts';

const NAME = 'CLAUDE_CONFIG_DIR';
/** Never a real directory: the assertion below is that it is NOT echoed. */
const PROBE = '/tmp/c4-23-probe-claude-config-dir';

const previous = process.env[NAME];

function set(value: string | undefined): void {
  delete process.env[NAME];
  if (value !== undefined) process.env[NAME] = value;
}

afterEach(() => { set(previous); });

function disclosure(): { source: string; key: string; reason: string } | undefined {
  return collectRejectedUserSettingsLayers().find(layer => layer.key === NAME);
}

describe('C4.23 — the CLAUDE_CONFIG_DIR overwrite is authoritative AND disclosed', () => {
  it('reports the overwrite, names the working spelling, and never echoes the value', () => {
    set(PROBE);
    const layer = disclosure();
    expect(layer).toBeDefined();
    expect(layer?.reason).toContain('OVERWRITTEN');
    // The actionable half: an operator told only "ignored" has nowhere to go.
    expect(layer?.reason).toContain('NESSY_CONFIG_DIR');
    // A diagnostic that echoed the path would turn a report into a disclosure of
    // the user's own filesystem on a surface that gets pasted into bug reports —
    // the same rule the user-scope `env` record keeps about variable values.
    expect(layer?.reason).not.toContain(PROBE);
    // It must arrive WHOLE: the sentence naming the working spelling is last, so
    // a reason over the cap loses exactly the half worth reading.
    expect(layer!.reason.length).toBeLessThanOrEqual(REJECTED_LAYER_REASON_MAX);
    expect(layer?.reason.endsWith('.')).toBe(true);
    // The record is about the environment, not about `config.json`.
    expect(layer?.source).toBe('process environment');
  });

  it('says nothing when the variable is not set — the control', () => {
    // Without this, a reporter that pushed unconditionally would satisfy the
    // case above and tell every user about a value they never wrote.
    set(undefined);
    expect(disclosure()).toBeUndefined();
    // An empty or whitespace value is not a choice either.
    set('   ');
    expect(disclosure()).toBeUndefined();
  });
});
