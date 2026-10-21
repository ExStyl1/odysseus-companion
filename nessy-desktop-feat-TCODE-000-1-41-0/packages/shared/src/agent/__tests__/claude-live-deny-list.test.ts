/**
 * P6.221 — a mid-session ban keeps the claude child alive.
 *
 * The row's premise was that three hashed flags force a respawn:
 * `allowedTools`, `disallowedTools` and `settingSources`. Measured at HEAD only
 * ONE of them can drift on this fork — `claude-agent.ts` never passes
 * `allowedTools`, and `settingSources` is the constant `['user','project','local']`
 * — so this row moves exactly that one, and the other two stay hashed with the
 * measurement written beside them.
 *
 * `agent-sdk/typescript.md#applyflagsettings` is the contract for the half that
 * replaces the respawn, verbatim: *"Use it when a setting that has no dedicated
 * setter needs to change mid-session, such as tightening `permissions` after the
 * agent reads untrusted input"*, with `permissions` in the *"Applied on the next
 * turn"* group.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  claudeDenyListDrift,
  claudeFlagLayerDeny,
  claudeLiveSessionSignature,
  claudeLiveSettings,
} from '../backend/claude/live-session.ts';
import { CLAUDE_SESSION_DISALLOWED_TOOLS, CLAUDE_TOOL_ALIASES } from '../claude-agent.ts';

type Opts = Parameters<typeof claudeLiveSettings>[0];
const options = (fields: Record<string, unknown>): Opts => fields as unknown as Opts;

describe('P6.221 claude live deny list', () => {
  it('reads the deny list off the options, sorted', () => {
    expect(claudeLiveSettings(options({ disallowedTools: ['Skill', 'Monitor'] })).disallowedTools)
      .toEqual(['Monitor', 'Skill']);
    expect(claudeLiveSettings(options({})).disallowedTools).toEqual([]);
  });

  it('classifies the drift in the three directions that need different answers', () => {
    expect(claudeDenyListDrift(['Monitor'], ['Monitor'])).toBe('same');
    // Sorted at both ends, so a reorder is not a drift at all.
    expect(claudeDenyListDrift(['Monitor', 'Skill'], ['Skill', 'Monitor'])).toBe('same');
    expect(claudeDenyListDrift(['Monitor'], ['Monitor', 'WebSearch'])).toBe('grown');
    expect(claudeDenyListDrift([], ['WebSearch'])).toBe('grown');
    expect(claudeDenyListDrift(['Monitor', 'WebSearch'], ['Monitor'])).toBe('narrowed');
    // A swap is a narrowing too — one name left, and the launch-time
    // `--disallowedTools` flag cannot be unsaid from the flag layer.
    expect(claudeDenyListDrift(['Monitor'], ['WebSearch'])).toBe('narrowed');
  });

  it('no longer respawns for a deny-list change', () => {
    const before = claudeLiveSessionSignature(options({ cwd: '/w', disallowedTools: ['Monitor'] }));
    const after = claudeLiveSessionSignature(
      options({ cwd: '/w', disallowedTools: ['Monitor', 'WebSearch'] }),
    );
    expect(after).toBe(before);
  });

  it('still respawns for the two flags that have no live route', () => {
    const base = { cwd: '/w' };
    expect(claudeLiveSessionSignature(options({ ...base, allowedTools: ['Read'] })))
      .not.toBe(claudeLiveSessionSignature(options({ ...base, allowedTools: ['Read', 'Bash'] })));
    expect(claudeLiveSessionSignature(options({ ...base, settingSources: ['user'] })))
      .not.toBe(claudeLiveSessionSignature(options({ ...base, settingSources: [] })));
  });

  it('sends the WHOLE list, because a second permissions object replaces the first', () => {
    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf-8');
    // The whole list less the alias keys (UA1.20 follow-up, below): every name
    // the flag layer can still carry goes, and the helper's arms pin the rest.
    expect(source).toContain('live.applyFlagSettings({ permissions: { deny: flagDeny } })');
    expect(source).toContain(
      'const flagDeny = claudeFlagLayerDeny(current.disallowedTools, wanted.disallowedTools, CLAUDE_TOOL_ALIASES);',
    );
    // The narrowing arm must keep degrading to the respawn this method's
    // contract promises; reporting it applied is the silent failure.
    expect(source).toContain("if (denyDrift === 'narrowed') {");
  });
});

/**
 * UA1.20 follow-up — an ALIAS key in a settings-layer deny rule also denies its
 * target, so the live flag layer must not carry one.
 *
 * Read in the vendored 2.1.274 bundle (`claude --version` → 2.1.274), NOT on a
 * docs page and NOT measured live: the CLI copies `Options.toolAliases` into
 * `toolPermissionContext.toolAliases`; a deny rule is matched with
 * `proxyExpansion: Hi(rule)` where `function Hi(e){return
 * e.source!=="cliArg"&&e.source!=="toolsNarrowing"}`, and an expanded match
 * tests `Vhe(rule.toolName, toolAliases).includes(toolName)` with `Vhe` →
 * `[name, alias]`. So `Artifact` in `permissions.deny` from `flagSettings`
 * also matches `mcp__session__publish_artifact` and removes the one sanctioned
 * publish path; `Monitor`/`ScheduleWakeup` likewise remove their session twins.
 * The launch-time `--disallowedTools` is `cliArg` — never expanded — and the
 * flag layer cannot retract it, so the alias keys stay banned by it alone.
 */
describe('UA1.20 follow-up: the flag-layer deny carries no alias key', () => {
  const spawned = [...CLAUDE_SESSION_DISALLOWED_TOOLS].sort();
  const aliasKeys = Object.keys(CLAUDE_TOOL_ALIASES);

  it('premise: the spawn-time list carries every alias key', () => {
    // Without this the negative arm below could pass on an empty intersection.
    expect(aliasKeys).toContain('Artifact');
    for (const key of aliasKeys) expect(spawned).toContain(key);
  });

  it('a grown list (WebSearch withheld after a model switch) keeps the new ban and drops every alias key', () => {
    const wanted = [...spawned, 'WebSearch'].sort();
    expect(claudeDenyListDrift(spawned, wanted)).toBe('grown');
    const deny = claudeFlagLayerDeny(spawned, wanted, CLAUDE_TOOL_ALIASES);
    expect(deny).not.toBeNull();
    // Positive: the name that grew, and the alias-free spawn-time bans, are sent.
    expect(deny).toContain('WebSearch');
    expect(deny).toEqual(wanted.filter((name) => !aliasKeys.includes(name)));
    // Negative: no alias key reaches a layer that expands it onto its target.
    for (const key of aliasKeys) expect(deny).not.toContain(key);
  });

  it('a grown list that ADDS an alias key the launch flag lacks answers null (respawn), never a silent drop', () => {
    const current = spawned.filter((name) => name !== 'Artifact');
    expect(claudeFlagLayerDeny(current, spawned, CLAUDE_TOOL_ALIASES)).toBeNull();
  });
});
