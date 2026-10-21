/**
 * P6.478 / ledger L11 — a pasted vendor skill spelling used to resolve to
 * nothing and say nothing, on all three runtimes.
 *
 * Owner decision Q6 (2026-09-05): **option B — detect and tell, do not
 * resolve.** Option C, accepting `/plugin:skill`, `$skill-name` and `@skill` as
 * ALIASES, stays refused, so this suite's first job is to prove no second
 * invocation syntax was minted: the marker stays `[skill:<reference>]` and the
 * vendor spellings still resolve to nothing.
 *
 * Its second job is the byte-stability invariant the block sits inside. The
 * listing lives in Pi's cached system prefix (#862), so the new text must not
 * depend on the turn, the model or the session — a hint that varied would
 * re-stamp the prefix and invalidate the history behind it.
 */
import { describe, expect, it } from 'bun:test';

import { TestAgent, createMockBackendConfig } from '../../__tests__/test-utils.ts';
import { parseMentions } from '../../../mentions/index.ts';
import type { RuntimeSkillHandle } from '../../../capabilities/views.ts';

function skillHandle(logicalName: string, description: string): RuntimeSkillHandle {
  return {
    key: `skill:ws:${logicalName}`,
    logicalName,
    description,
    selectedAsUnqualifiedAlias: true,
    resource: {
      source: 'workspace',
      scope: { kind: 'workspace', workspaceId: 'test-workspace-id' },
      resourceId: logicalName,
      absolutePath: `/abs/skills/${logicalName}`,
      revision: 'r1',
      contentHash: 'a'.repeat(64),
    },
  };
}

function listingWith(skills: RuntimeSkillHandle[]): string | undefined {
  const builder = new TestAgent(createMockBackendConfig()).getPromptBuilder();
  builder.setRuntimeSkills(skills);
  return builder.buildSkillListingPart();
}

describe('P6.478 · the vendor skill spellings are named, not resolved', () => {
  it('names all three vendor spellings beside the one marker this host uses', () => {
    const listing = listingWith([skillHandle('triage-finding', 'Triage a security finding')])!;

    expect(listing).toContain('<available_skills>');
    // The host's own marker, unchanged — this is the vocabulary that resolves.
    expect(listing).toContain('[skill:triage-finding]');
    // Claude, Codex and ChatGPT, each spelled as its own vendor spells it.
    expect(listing).toContain('/plugin:name');
    expect(listing).toContain('$name');
    expect(listing).toContain('@name');
    // Option B, in the two clauses that distinguish it from option C: none of
    // them resolves, and the model answers rather than treating it as unknown.
    expect(listing).toContain('none of those resolves here');
    expect(listing).toContain('do not treat it as an unknown command');
  });

  it('mints no second syntax: a vendor spelling still parses to nothing', () => {
    // The refusal of option C, measured rather than asserted in prose. The
    // resolver sees a vendor spelling as ordinary text — no skill, and not even
    // an INVALID skill mention, because it is not a `[skill:…]` mention at all.
    const available = ['triage-finding'];
    for (const text of [
      'Use $triage-finding to look at this',
      'Use /plugin:triage-finding to look at this',
      'Use @triage-finding to look at this',
    ]) {
      const parsed = parseMentions(text, available, []);
      expect(parsed.skills).toEqual([]);
      expect(parsed.invalidSkills).toEqual([]);
    }
    // CONTROL: the host marker does resolve, on the same input shape.
    expect(parseMentions('Use [skill:triage-finding] here', available, []).skills)
      .toEqual(['triage-finding']);
  });

  it('the hint is byte-stable, so it is safe inside the cached system prefix', () => {
    // #862: the listing is folded into Pi's cached system prefix, so the same
    // skills must produce the same bytes every time. The negative controls the
    // decision names — `$VAR`, `@user`, a path — are ALSO inputs this block
    // never sees, which is the other half of why it cannot vary: it is built
    // from the skill set alone.
    const skills = [skillHandle('deploy', 'Deploy the app')];
    expect(listingWith(skills)).toBe(listingWith(skills)!);
  });

  it('says nothing when there is no skill to name', () => {
    // The hint is conditioned on a LISTED skill; with none listed the whole
    // block is absent, so a `$VAR` or an `@user` in a prompt meets no text
    // about skills at all.
    expect(listingWith([])).toBeUndefined();
  });
});
