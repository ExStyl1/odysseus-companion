/**
 * P3.269 (7) — `_sdkSlashCommands` vs `Query.supportedCommands()`.
 *
 * The row filed the adapter's own roster as a duplicate of the SDK getter and
 * asked for a retire-and-verify. **Measured at 0.3.233, the retirement would
 * DELETE a feature, and the SDK's own typing is what says so:**
 *
 *   *"Fire-and-forget push of the full slash-command list after a mid-session
 *   change … Clients should REPLACE their cached command list with this payload;
 *   `supportedCommands()` tracks the latest push, so a re-fetch returns the same
 *   fresh list."*
 *
 * The roster is not a second copy of that list — it is the PREVIOUS state the
 * `commands_changed` diff subtracts from. `supportedCommands()` returns the list
 * the push just delivered, so a diff computed against it is empty by
 * construction and the "New commands available: /x" notice never fires again.
 * The bundle agrees: `async supportedCommands(){let{commands:e}=await
 * this.initialization;return this.latestCommands??e}`.
 *
 * So what lands is the half the row said mattered — the AGREEMENT: after every
 * push the host's cache is exactly what a `supportedCommands()` re-fetch would
 * return. That is the property a bump could silently break (a payload shape
 * change, a push the adapter stops handling), and it is what makes the roster a
 * legitimate stand-in rather than a fork of the truth.
 *
 * Two reads this comparison surfaced are NOT pinned here because nothing
 * consumes them yet; they are filed as mapping rows instead:
 * `system/init.terminal_slash_commands` (0 host reads — the documented "phone
 * and remote UIs should hide these" subset), and the `description` /
 * `argumentHint` / `aliases` of each `SlashCommand`, which the roster narrows
 * to a name.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ClaudeEventAdapter, type ClaudeAdapterCallbacks } from '../backend/claude/event-adapter.ts';

function callbacks(): ClaudeAdapterCallbacks {
  return {
    onDebug: undefined,
    mapSDKError: async () => ({
      type: 'typed_error' as const,
      error: { code: 'unknown_error', title: 't', message: 'm', details: [], actions: [], canRetry: false },
    }),
  } as ClaudeAdapterCallbacks;
}

const push = (names: string[]): any => ({
  type: 'system',
  subtype: 'commands_changed',
  commands: names.map(name => ({ name, description: `${name} does a thing`, argumentHint: '<arg>' })),
  uuid: 'u',
  session_id: 's',
});

function sdkText(): { bundle: string; typings: string } {
  const resolved = require.resolve('@anthropic-ai/claude-agent-sdk');
  return {
    bundle: readFileSync(resolved, 'utf8'),
    typings: readFileSync(resolved.replace(/sdk\.mjs$/, 'sdk.d.ts'), 'utf8'),
  };
}

describe('P3.269 — the host roster and supportedCommands() carry the same list', () => {
  it('after every push the cache IS what a re-fetch would return', async () => {
    const adapter = new ClaudeEventAdapter(callbacks());
    adapter.startTurn();
    await adapter.adapt({
      type: 'system', subtype: 'init', tools: [], slash_commands: ['help', 'cost'], uuid: 'u', session_id: 's',
    } as any);
    expect(adapter.sdkSlashCommands).toEqual(['help', 'cost']);

    // `supportedCommands()` would now return exactly this payload's names.
    await adapter.adapt(push(['help', 'cost', 'deploy']));
    expect(adapter.sdkSlashCommands).toEqual(['help', 'cost', 'deploy']);

    // Including a REMOVAL, which is the direction a cache that only ever grows
    // would get wrong while still looking correct on every additive test.
    await adapter.adapt(push(['help']));
    expect(adapter.sdkSlashCommands).toEqual(['help']);
  });

  it('THE REFUTATION — the diff needs the PRIOR state, which the getter does not hold', async () => {
    const adapter = new ClaudeEventAdapter(callbacks());
    adapter.startTurn();
    await adapter.adapt({
      type: 'system', subtype: 'init', tools: [], slash_commands: ['help'], uuid: 'u', session_id: 's',
    } as any);

    // With the prior state: the new command is announced.
    const announced = await adapter.adapt(push(['help', 'deploy']));
    expect(announced).toHaveLength(1);
    expect((announced[0] as any).message).toContain('/deploy');

    // Sourcing the baseline from the SDK instead would compare the pushed list
    // against itself. Simulated by feeding the same payload twice: the second
    // pass sees the state the getter would have returned, and announces nothing.
    expect(await adapter.adapt(push(['help', 'deploy']))).toEqual([]);
  });

  it('the SDK text that makes both claims, quoted rather than argued', () => {
    const { bundle, typings } = sdkText();
    // Why a re-fetch cannot be the baseline.
    expect(typings).toContain('supportedCommands() tracks the latest push');
    expect(bundle).toContain('async supportedCommands(){let{commands:e}=await this.initialization;return this.latestCommands??e}');
    // The two unread reads the comparison surfaced, pinned as EXISTING so the
    // mapping rows that name them cannot go stale silently.
    expect(typings).toContain('terminal_slash_commands');
    expect(typings).toContain('Alternate names that resolve to this command');
  });

  it('one of the two is now read, and the other still is not', () => {
    // An absence claim over the host's own source, with the field it DOES read
    // as the positive control on the same rig.
    //
    // P6.406 closed the SlashCommand half: `argumentHint` and `aliases` are
    // retained beside the name. `terminal_slash_commands` is UNCHANGED and
    // stays pinned as unread — it is the documented "phone and remote UIs
    // should hide these" subset and this desktop has no such surface, so
    // reading it would be a field with no consumer.
    const adapterSource = readFileSync(new URL('../backend/claude/event-adapter.ts', import.meta.url), 'utf8');
    expect(adapterSource).toContain('msg.slash_commands');
    // Guard the READ, not the identifier. A bare-substring absence guard cannot
    // tell code from the prose beside it, and it fires exactly when the thing it
    // guards has been made clearer: `d0a228ea0` added a docblock line naming
    // `terminal_slash_commands` to say why the field is NOT read, and this case
    // went red over the sentence explaining its own subject. Found by C3.380's
    // lift gate (2026-09-13) as a red already standing at HEAD; the repair is
    // AGENTS.md §Traps' own prescription for this shape.
    expect(adapterSource.includes('msg.terminal_slash_commands')).toBe(false);
    expect(adapterSource.includes('argumentHint')).toBe(true);
  });

  it('P6.406 — the push keeps its hint and aliases, and drops the SDK empties', async () => {
    const adapter = new ClaudeEventAdapter(callbacks());
    adapter.startTurn();
    await adapter.adapt({
      type: 'system', subtype: 'init', tools: [], slash_commands: ['help'], uuid: 'u', session_id: 's',
    } as any);
    // `system/init` sends bare names, so there is nothing richer to record and
    // the details view says so rather than inventing empty entries.
    expect(adapter.sdkSlashCommandDetails).toEqual([]);

    await adapter.adapt({
      type: 'system',
      subtype: 'commands_changed',
      commands: [
        { name: 'usage', description: 'token spend', argumentHint: '<window>', aliases: ['cost', 'stats'] },
        // The SDK types description/argumentHint as REQUIRED strings, so a
        // command with neither arrives as two empty strings. An empty string
        // is not a hint: carried through, a surface would draw a blank bracket.
        { name: 'help', description: '', argumentHint: '' },
      ],
      uuid: 'u',
      session_id: 's',
    } as any);

    expect(adapter.sdkSlashCommandDetails).toEqual([
      { name: 'usage', description: 'token spend', argumentHint: '<window>', aliases: ['cost', 'stats'] },
      { name: 'help' },
    ]);
    // The two views are written from one payload and cannot describe different
    // sets — the property that makes the details a view rather than a second
    // source.
    expect(adapter.sdkSlashCommandDetails.map(command => command.name)).toEqual(adapter.sdkSlashCommands);
  });
});
