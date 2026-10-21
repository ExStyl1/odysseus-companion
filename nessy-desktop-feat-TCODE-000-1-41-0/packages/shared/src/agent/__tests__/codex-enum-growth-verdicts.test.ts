/**
 * I2.23 — four codex enums grew at `rust-v0.150.1`, and the row's premise that
 * *"each has a reader that exhausts the union"* is REFUTED at HEAD: none of the
 * four has a host reader at all.
 *
 * ## What was measured, 2026-09-17, at `rust-v0.154.0`
 *
 * Re-read 2026-09-24 at `rust-v0.156.1` (F1.255's lift, F1.592): all four unions
 * and the four absences unchanged. The describe below names no tag, because a
 * tag in a title is stale from the next lift on while the pins keep reading.
 *
 * Re-read 2026-10-01 at `rust-v0.159.3` (F1.1215's lift): `PlanType` grew
 * `"promax"`, and it has no host reader either (`git grep -F promax` outside the
 * generated package: nothing), so the pin and the needles take it and the
 * verdict stands. The other three unions are unchanged.
 *
 * | enum | grew by | host readers |
 * | --- | --- | --- |
 * | `v2/SubAgentActivityKind` | `"completed"` | none |
 * | `InternalSessionSource` | `"guardian"` | none |
 * | `PlanType` | `"edu_plus"`, `"edu_pro"` | none |
 * | `AuthMode` | `"bedrockAccessKeys"` | none |
 *
 * So there is no arm to widen and nothing exhausts a union — the honest outcome
 * is a recorded verdict plus a gate that goes red the day a reader appears, and
 * a drift tie so that the NEXT growth is not silent either.
 *
 * ## The one that is unreachable rather than merely unread — `AuthMode`
 *
 * This is the enum `A3.3` points at for codex ("which credential authorized
 * this session"), and the answer is structural rather than a matter of wiring.
 * `GetAuthStatusResponse` is `{ authMethod: AuthMode | null, authToken,
 * requiresOpenaiAuth }`, and `CodexAgent.describeQuota`'s docblock carries the
 * measurement on the shipped binary: `getAuthStatus` answered
 * `{ authMethod: null, authToken: null, requiresOpenaiAuth: false }`. A session
 * of this fork authenticates against our own loopback Responses adapter with a
 * synthetic key under `[model_providers.nessy_gateway]`, and `writeCodexConfig`
 * writes no `auth.json` into the per-session `CODEX_HOME` at all — so there is
 * no codex ACCOUNT for `authMethod` to name, under any configuration. Reading
 * the field would mint a null, not an answer. `bedrockAccessKeys` is therefore
 * one of eight members none of which this fork can ever receive; the Bedrock
 * card it sounds like is a DECLARED connection of ours
 * (`codex-bedrock-card.test.ts`, P6.532) and has nothing to do with this wire
 * enum.
 *
 * ## Why an absence probe and not a comment
 *
 * AGENTS.md §Traps: an absence probe declares its unit to the gate, so the null
 * stops being a sentence somebody has to believe. The POSITIVE CONTROL is in
 * the gate too and is self-proving rather than a number that drifts: every
 * needle below must hit inside `packages/codex-protocol/` — it is an enum
 * member, so it is there by construction — and hit nowhere else. A needle that
 * stops matching inside the package means the enum moved, which is the other
 * thing worth being told.
 *
 * Needles are chosen to be free of the substring trap: `AuthMode` itself is
 * rejected as a needle because `config-writer.ts` quotes Rust's
 * `DomainAuthMode` in a comment, and `interacted` / `completed` / `guardian`
 * are ordinary English this tree is full of. The members below are distinctive
 * strings.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'bun:test';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..');
const GENERATED = join(REPO_ROOT, 'packages', 'codex-protocol', 'generated');

/**
 * D1.440, 2026-09-20 — THIS FILE, and it is the reason the absence case was red
 * from the commit that wrote it (the CI run that first completed, 126374378,
 * reported it; every one of the seven needles fails the same way and bun stops
 * at the first). The census greps `packages apps scripts` for a literal, and
 * every needle is spelled here, in `NEEDLES` and in the pin above it — so the
 * probe reads ITSELF as the host reader it exists to say does not exist.
 *
 * The docblock's *"needles are chosen to be free of the substring trap"* was
 * about OTHER files; a probe is the one file a census can never be protected
 * from by choosing better needles.
 *
 * Derived from `import.meta`, never written out, so a rename cannot leave a
 * stale literal that silently stops excluding anything. The positive control is
 * untouched: it looks INSIDE `packages/codex-protocol/`, where this file is not.
 */
const SELF = relative(REPO_ROOT, import.meta.path);

/** The union members of one generated ts-rs enum, read as SOURCE TEXT. */
function members(relativePath: string): string[] {
  const source = readFileSync(join(GENERATED, relativePath), 'utf8');
  const declaration = source.split('export type ')[1] ?? '';
  return [...declaration.matchAll(/"([^"]+)"/g)].map(match => match[1]!);
}

/**
 * Tracked files containing `needle` literally, as paths relative to the repo root.
 *
 * F1.1215 — ONE `git grep` for every needle, memoised, instead of one per needle
 * per case. The eighth needle (`promax`) took the per-needle form past bun's 5 s
 * default: about 0.45 s a call at load average 22, nine calls in CONTROL. `-o`
 * prints `path:match`, so each line is attributed to the needle it ends with.
 */
let census: Map<string, string[]> | null = null;
function filesContaining(needle: string): string[] {
  census ??= runCensus([...new Set(NEEDLES.map(([, n]) => n))]);
  const files = census.get(needle);
  if (!files) throw new Error(`"${needle}" is not a census needle`);
  return files;
}

function runCensus(needles: readonly string[]): Map<string, string[]> {
  const found = new Map<string, Set<string>>(needles.map(needle => [needle, new Set<string>()]));
  // `-a` and never `-I` (AGENTS.md §Traps: the last of the pair wins); `-F`
  // because every needle here is a literal. Exit 1 means "no match", which is
  // an answer rather than a failure.
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-aoF', ...needles.flatMap(needle => ['-e', needle]), '--', 'packages', 'apps', 'scripts'], {
      cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    out = '';
  }
  for (const line of out.split('\n')) {
    for (const needle of needles) {
      if (line.endsWith(`:${needle}`)) found.get(needle)!.add(line.slice(0, -needle.length - 1));
    }
  }
  return new Map([...found].map(([needle, files]) => [needle, [...files]]));
}

const NEEDLES: ReadonlyArray<readonly [enumName: string, needle: string]> = [
  ['SubAgentActivityKind', 'SubAgentActivityKind'],
  ['InternalSessionSource', 'memory_consolidation'],
  ['PlanType', 'prolite'],
  ['PlanType', 'edu_plus'],
  ['PlanType', 'edu_pro'],
  ['PlanType', 'promax'],
  ['AuthMode', 'agentIdentity'],
  ['AuthMode', 'bedrockAccessKeys'],
];

describe('I2.23 — the four grown enums, pinned at the tag codex-protocol/manifest.json vendors', () => {
  it('pins each union, so the NEXT growth is not silent either', () => {
    expect(members(join('v2', 'SubAgentActivityKind.ts')))
      .toEqual(['started', 'interacted', 'interrupted', 'completed']);
    expect(members('InternalSessionSource.ts'))
      .toEqual(['memory_consolidation', 'guardian']);
    expect(members('PlanType.ts')).toEqual([
      'free', 'go', 'plus', 'pro', 'prolite', 'promax', 'team',
      'self_serve_business_prolite', 'self_serve_business_usage_based', 'business',
      'ent26', 'enterprise_cbp_automation', 'enterprise_cbp_usage_based', 'enterprise',
      'edu', 'edu_plus', 'edu_pro', 'unknown',
    ]);
    expect(members('AuthMode.ts')).toEqual([
      'apikey', 'chatgpt', 'chatgptAuthTokens', 'headers', 'agentIdentity',
      'personalAccessToken', 'bedrockApiKey', 'bedrockAccessKeys',
    ]);
  });

  it('CONTROL — every needle hits inside packages/codex-protocol, so the probe can see', () => {
    for (const [enumName, needle] of NEEDLES) {
      const inside = filesContaining(needle).filter(path => path.startsWith('packages/codex-protocol/'));
      expect(inside.length, `${enumName}: "${needle}" vanished from the generated package`).toBeGreaterThan(0);
    }
    // And the self-match `SELF` excludes is REAL, so that exclusion cannot
    // decay into a silent no-op the day this file stops spelling its needles.
    expect(filesContaining('SubAgentActivityKind')).toContain(SELF);
  });

  it('ABSENCE — and hits nowhere else: none of the four has a host reader', () => {
    for (const [enumName, needle] of NEEDLES) {
      const outside = filesContaining(needle)
        .filter(path => !path.startsWith('packages/codex-protocol/') && path !== SELF);
      // Naming the files is the whole value of the red: a reader that appears
      // needs a verdict (read it, or record why not), and this case is where a
      // lane is told so.
      expect(outside, `${enumName}: "${needle}" now has a reader — give it a verdict`).toEqual([]);
    }
  });
});
