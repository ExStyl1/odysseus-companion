/**
 * F1.494 (origin WJ-vv P-WJ-vv-1, DECIDED by the controller under the
 * TRANSPARENT rule) — an `automations.json` that did not load says so on the
 * notes surface.
 *
 * A reload refused for an invalid `automations.json` reached only the config
 * watcher's `sessionLog.error`, and the load-time read (`tolerateErrors`) only
 * `console.warn`: the person who edited the file got no surface, while the
 * previous automations kept running (reload) or none ran at all (load),
 * unannounced. The refusal is now a note on `configWarnings`, the array
 * `SessionManager.warnHooksConfigNotes` raises on a session — whose lead-in
 * F1.456 made count-neutral, so one more note needs no second sentence.
 *
 * The note carries the FIRST error only, masked by the tool-result secret
 * table and capped: measured under bun 1.3.14, `JSON.parse` echoes an unquoted
 * identifier verbatim (`Unexpected identifier "<the value>"`), and a validation
 * error echoes a hand-written value (`Invalid timezone: <the value>`), so the
 * first error CAN carry file bytes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AutomationSystem, shownNoteError, withoutJsonParseEcho } from './automation-system.ts';
import { AUTOMATIONS_CONFIG_FILE } from './constants.ts';
import { HOOKS_CONFIG_FILE } from './hooks-config.ts';

const PREVIOUS_IN_EFFECT = '); the previous automations stay in effect';
const NONE_IN_EFFECT = '); no automations from it are in effect';

const valid = (prompts: string[]) => JSON.stringify({
  automations: { LabelAdd: prompts.map(prompt => ({ matcher: 'test', actions: [{ type: 'prompt', prompt }] })) },
});
const structurallyInvalid = JSON.stringify({ automations: { LabelAdd: [{ matcher: 'test', actions: 'not-an-array' }] } });

function automationsNotes(system: AutomationSystem): string[] {
  return system.configWarnings.filter(note => note.startsWith(AUTOMATIONS_CONFIG_FILE));
}

describe('F1.494 — an automations.json that did not load is a note', () => {
  let dir: string;
  let system: AutomationSystem | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'f1494-'));
  });

  afterEach(async () => {
    await system?.dispose();
    system = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (body: string) => writeFileSync(join(dir, AUTOMATIONS_CONFIG_FILE), body);
  const build = () => (system = new AutomationSystem({ workspaceRootPath: dir, workspaceId: 'f1494' }));

  it('valid → structurally invalid: the reload refuses, and exactly one note names automations.json and its first error', () => {
    write(valid(['first']));
    const s = build();
    write(structurallyInvalid);
    const result = s.reloadConfig();
    expect({ success: result.success, applied: s.getConfig()?.automations.LabelAdd?.length }).toEqual({ success: false, applied: 1 });
    expect(automationsNotes(s)).toEqual([`${AUTOMATIONS_CONFIG_FILE} did not load (${result.errors[0]}${PREVIOUS_IN_EFFECT}`]);
    // It is the one note: the hooks side has nothing to say here.
    expect(s.configWarnings).toHaveLength(1);
  });

  it('valid → unparseable JSON: the same one note, carrying the parse error', () => {
    write(valid(['first']));
    const s = build();
    write('{ "automations": ');
    const result = s.reloadConfig();
    expect(result.success).toBe(false);
    const notes = automationsNotes(s);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toBe(`${AUTOMATIONS_CONFIG_FILE} did not load (${result.errors[0]}${PREVIOUS_IN_EFFECT}`);
    expect(notes[0]).toContain('Failed to parse JSON');
  });

  it('CONTROL: valid → valid carries no note', () => {
    write(valid(['first']));
    const s = build();
    write(valid(['first', 'second']));
    expect(s.reloadConfig().success).toBe(true);
    expect(s.configWarnings).toEqual([]);
  });

  it('invalid → valid clears the note', () => {
    write(valid(['first']));
    const s = build();
    write(structurallyInvalid);
    expect(s.reloadConfig().success).toBe(false);
    expect(automationsNotes(s)).toHaveLength(1);
    write(valid(['first', 'second']));
    expect(s.reloadConfig().success).toBe(true);
    expect(s.configWarnings).toEqual([]);
    expect(s.getConfig()?.automations.LabelAdd).toHaveLength(2);
  });

  it('at LOAD (tolerateErrors): an invalid automations.json is one note saying none of it is in effect', () => {
    write(structurallyInvalid);
    const s = build();
    expect(s.getConfig()).toEqual({ automations: {} });
    const notes = automationsNotes(s);
    expect(notes).toHaveLength(1);
    const note = notes[0] ?? '';
    expect(note.startsWith(`${AUTOMATIONS_CONFIG_FILE} did not load (automations.LabelAdd.0.actions: `)).toBe(true);
    expect(note.endsWith(NONE_IN_EFFECT)).toBe(true);
  });

  it('CONTROL at LOAD: a valid automations.json and a missing one carry no note', async () => {
    write(valid(['first']));
    expect(build().configWarnings).toEqual([]);
    await system?.dispose();
    rmSync(join(dir, AUTOMATIONS_CONFIG_FILE));
    expect(build().configWarnings).toEqual([]);
  });

  it('the first error is capped: a 457-character validation error does not reach the note whole', () => {
    write(valid(['first']));
    const s = build();
    write(JSON.stringify({
      automations: { SchedulerTick: [{ cron: '0 9 * * *', timezone: 'Z'.repeat(400), actions: [{ type: 'prompt', prompt: 'hi' }] }] },
    }));
    const result = s.reloadConfig();
    expect(result.success).toBe(false);
    // POSITIVE CONTROL: the error really is long, and really echoes the value.
    const first = result.errors[0] ?? '';
    expect(first.length).toBeGreaterThan(400);
    const note = automationsNotes(s)[0] ?? '';
    const inner = note.slice(`${AUTOMATIONS_CONFIG_FILE} did not load (`.length, note.length - PREVIOUS_IN_EFFECT.length);
    expect(inner.length).toBeLessThanOrEqual(161);
    expect(inner.endsWith('…')).toBe(true);
    expect(first.startsWith(inner.slice(0, -1))).toBe(true);
  });

  it('a token the parse error echoes is kept out of the note', () => {
    const token = `ory_at_${'x'.repeat(24)}`;
    write(valid(['first']));
    const s = build();
    write(`{ "automations": { "LabelAdd": [ { "matcher": "test", "actions": [ { "type": "webhook", "url": "https://example.invalid", "headers": { "Authorization": ${token} } } ] } ] } }`);
    const result = s.reloadConfig();
    expect(result.success).toBe(false);
    // POSITIVE CONTROL: this engine echoes the unquoted value in its message, so
    // the note's handling is what keeps it out — not an absence in the input.
    expect(result.errors[0]).toContain(token);
    const [note] = automationsNotes(s);
    expect(note).not.toContain(token);
    // F1.501: a parse error's echo is DROPPED before the mask runs, so the
    // mask's label no longer appears on this route; the next arm keeps the mask.
    expect(note).toContain('(its value is not shown here)');
  });

  it('a token a VALIDATION error echoes is masked in the note', () => {
    const token = `ory_at_${'x'.repeat(24)}`;
    write(valid(['first']));
    const s = build();
    write(JSON.stringify({
      automations: { SchedulerTick: [{ cron: '0 9 * * *', timezone: token, actions: [{ type: 'prompt', prompt: 'hi' }] }] },
    }));
    const result = s.reloadConfig();
    expect(result.success).toBe(false);
    // POSITIVE CONTROL: the validation error quotes the field's value whole.
    expect(result.errors[0]).toContain(token);
    const [note] = automationsNotes(s);
    expect(note).not.toContain(token);
    expect(note).toContain('[REDACTED:ory-token]');
  });
});

/**
 * P-WJ-ae-1 (F1.494's residue, fixed in place) — F1.229's hook-document note
 * rides the same surface and carried the loader's error UNMASKED and UNCAPPED:
 * measured on the relaunch (`work/wjae/probe-hooks-echo.txt`), an unquoted
 * `ory_at_…` value in `hooks.json` reached `configWarnings` whole while the same
 * value in `automations.json` read `[REDACTED:ory-token]`. One helper now masks
 * and caps both. Red at the parent on the first two arms; the CONTROL was green.
 */
describe('P-WJ-ae-1 — the hook-document note is masked and capped like the automations.json note', () => {
  const HOOK_SUFFIX = ' — this hook document did not load as written, so the hooks it affects will not run until it is fixed (automations.json is not affected)';
  let dir: string;
  let system: AutomationSystem | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'p-wjae-1-'));
  });

  afterEach(async () => {
    await system?.dispose();
    system = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const parseMessage = (body: string): string => {
    try {
      JSON.parse(body);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('the fixture parsed');
  };
  const hookNotes = (body: string): string[] => {
    writeFileSync(join(dir, HOOKS_CONFIG_FILE), body);
    system = new AutomationSystem({ workspaceRootPath: dir, workspaceId: 'p-wjae-1' });
    return system.configWarnings.filter(note => note.startsWith(`${HOOKS_CONFIG_FILE}: `));
  };

  it('a token the parse error echoes is kept out of the hook-document note', () => {
    const token = `ory_at_${'x'.repeat(24)}`;
    const body = `{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": ${token} } ] } ] } }`;
    // POSITIVE CONTROL: this engine echoes the unquoted value, so the note's
    // handling is what keeps it out — not an absence in the input.
    expect(parseMessage(body)).toContain(token);
    const notes = hookNotes(body);
    expect(notes).toHaveLength(1);
    expect(notes[0]).not.toContain(token);
    // F1.501: dropped before the mask; the validation arm below keeps the mask.
    expect(notes[0]).toContain('(its value is not shown here)');
    expect(notes[0]!.endsWith(HOOK_SUFFIX)).toBe(true);
  });

  it('a token a hook document\'s VALIDATION error echoes is masked in the note', () => {
    const token = `ory_at_${'x'.repeat(24)}`;
    const notes = hookNotes(JSON.stringify({
      hooks: { SchedulerTick: [{ cron: '0 9 * * *', timezone: token, actions: [{ type: 'prompt', prompt: 'hi' }] }] },
    }));
    expect(notes).toHaveLength(1);
    expect(notes[0]).not.toContain(token);
    expect(notes[0]).toContain('[REDACTED:ory-token]');
    expect(notes[0]!.endsWith(HOOK_SUFFIX)).toBe(true);
  });

  it('a long hook-document error is capped, and the note still says what it costs', () => {
    // F1.501 moved this arm off the parse route, whose echo is now dropped
    // before the cap could matter: a validation error quotes the value whole.
    const body = JSON.stringify({
      hooks: { SchedulerTick: [{ cron: '0 9 * * *', timezone: 'Z'.repeat(400), actions: [{ type: 'prompt', prompt: 'hi' }] }] },
    });
    const [note = ''] = hookNotes(body);
    // The value is 400 characters; the note carries fewer than 200 of them.
    expect(note).not.toContain('Z'.repeat(200));
    expect(note.endsWith(HOOK_SUFFIX)).toBe(true);
    const inner = note.slice(0, note.length - HOOK_SUFFIX.length);
    expect(inner.startsWith(`${HOOKS_CONFIG_FILE}: `)).toBe(true);
    expect(inner.length).toBeLessThanOrEqual(161);
    expect(inner.endsWith('…')).toBe(true);
  });

  it('CONTROL: an ordinary hook parse error reads exactly as F1.229 wrote it', () => {
    const body = '{ "hooks": ';
    expect(hookNotes(body)).toEqual([`${HOOKS_CONFIG_FILE}: ${parseMessage(body)}${HOOK_SUFFIX}`]);
  });
});

/**
 * F1.501 (origin WJ-ae, 2026-09-24, carried under F1.359) — the residue
 * `shownNoteError` named: a value matching none of the secret table's patterns
 * still reached either note, up to the cap, because a JSON parse error echoes
 * the file. The note now keeps the parser's words and drops the echo; the full
 * error stays on the reload's `errors` and in the logs. Red at `d5ec9426a` on
 * both value arms; the CONTROL arms above (an ordinary parse error, the token
 * mask) were green there and stay green.
 */
describe('F1.501 — a JSON parse error in either note never carries the value it echoes', () => {
  let dir: string;
  let system: AutomationSystem | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'f1501-'));
  });

  afterEach(async () => {
    await system?.dispose();
    system = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const parseMessage = (body: string): string => {
    try {
      JSON.parse(body);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('the fixture parsed');
  };

  it('hooks.json holding { "hooks": plainword } gives a note without plainword', () => {
    const body = '{ "hooks": plainword }';
    // POSITIVE CONTROL: this engine echoes the value, and the secret table has
    // no pattern for it — so only F1.501 can keep it out of the note.
    expect(parseMessage(body)).toContain('plainword');
    writeFileSync(join(dir, HOOKS_CONFIG_FILE), body);
    system = new AutomationSystem({ workspaceRootPath: dir, workspaceId: 'f1501' });
    const notes = system.configWarnings.filter(note => note.startsWith(`${HOOKS_CONFIG_FILE}: `));
    expect(notes).toHaveLength(1);
    expect(notes[0]).not.toContain('plainword');
    // Still a parse error the person can act on: the parser's own words stay.
    expect(notes[0]).toContain('Unexpected');
  });

  it('automations.json the same: the note drops the value, the reload result keeps the whole error', () => {
    writeFileSync(join(dir, AUTOMATIONS_CONFIG_FILE), valid(['first']));
    const s = (system = new AutomationSystem({ workspaceRootPath: dir, workspaceId: 'f1501' }));
    writeFileSync(join(dir, AUTOMATIONS_CONFIG_FILE), '{ "automations": { "LabelAdd": plainword } }');
    const result = s.reloadConfig();
    expect(result.success).toBe(false);
    // The log/result side is untouched — it is where the whole error is read.
    expect(result.errors[0]).toContain('plainword');
    const notes = automationsNotes(s);
    expect(notes).toHaveLength(1);
    expect(notes[0]).not.toContain('plainword');
    expect(notes[0]).toContain('Failed to parse JSON');
  });

  // The desktop's main process parses with V8, not bun; this engine cannot
  // produce V8's messages, so its shapes are pinned on the helper, verbatim as
  // Node 24.4.1 printed them for the same documents (work/wjax/probe-json-messages.js).
  it('V8: the window onto the file is dropped, the token and the source prefix stay', () => {
    const shown = shownNoteError(`${HOOKS_CONFIG_FILE}: Unexpected token 'p', ..." "hooks": plainword "... is not valid JSON`);
    expect(shown).toBe(`${HOOKS_CONFIG_FILE}: Unexpected token 'p' in JSON (the text around it is not shown here)`);
    // A short document is echoed WHOLE, newlines included, and a quote can be the token.
    expect(withoutJsonParseEcho(`Unexpected token ' ', "{ "hooks": tru }" is not valid JSON`)).not.toContain('tru');
    expect(withoutJsonParseEcho(`Unexpected token ''', "{ 'x': plainword }" is not valid JSON`)).not.toContain('plainword');
    expect(withoutJsonParseEcho(`Unexpected token 'N', ..."oks": \n   plainword "... is not valid JSON`)).not.toContain('plainword');
  });

  it('CONTROL: a positional parse error keeps its line and column, and a validation error is untouched', () => {
    const positional = `${HOOKS_CONFIG_FILE}: Expected ',' or '}' after property value in JSON at position 13 (line 1 column 14)`;
    expect(shownNoteError(positional)).toBe(positional);
    expect(shownNoteError(`${HOOKS_CONFIG_FILE}: JSON Parse error: Unexpected EOF`)).toBe(`${HOOKS_CONFIG_FILE}: JSON Parse error: Unexpected EOF`);
    const validation = 'automations.SchedulerTick.0.timezone: Invalid timezone: Europe/Nowhere';
    expect(shownNoteError(validation)).toBe(validation);
  });
});
