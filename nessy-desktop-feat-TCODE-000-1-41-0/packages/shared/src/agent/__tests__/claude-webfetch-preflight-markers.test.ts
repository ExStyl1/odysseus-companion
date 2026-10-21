/**
 * P3.352 (CRU-7) — the four static facts about the WebFetch domain preflight,
 * pinned against the binary that performs it.
 *
 * ## Why this file exists
 *
 * Both the live checklist and `claude-agent.ts` said the egress *"cannot be
 * proven from this tree"*, on the grounds that the logic lives in the native
 * binary rather than in the vendored `sdk.mjs`. The binary IS in this tree — it
 * is what `ensure-claude-sdk-binary-dir.cjs` stages — and it is greppable. So an
 * UNPROVABLE claim was really an unread one, and a release note was corrected on
 * the documentation's word alone when the artefact was available all along.
 *
 * ## What is pinned, read verbatim out of `claudeCodeVersion 2.1.233`
 *
 * **C3.53 re-verified the whole file against the LIFTED bundle on 2026-09-11:
 * green at `claudeCodeVersion 2.1.247` (4 pass, 26 expect() calls), so all four
 * static facts survive the fourteen-patch lift and the block below still
 * describes the binary we ship.** The block is left in its 2.1.233 spelling on
 * purpose — it is a transcript of what was read that day, and the assertions
 * below are on string literals a minifier cannot rename, which is what makes the
 * re-verification meaningful rather than a re-transcription. What C3.53 could
 * NOT do is the other half of its row: the live arm (CRU-7) needs a PACKAGED
 * artefact behind a logging egress proxy (`NESSY_CDP_PROXY_LOG`, optionally
 * `NESSY_CDP_PROXY_BLOCKS_ANTHROPIC=1`), and neither exists on a lane rig — the
 * case blocks with that precondition named, which is a rig gap and not a code
 * gap.
 *
 * ```js
 * class W9o{urls=new DD({maxSize:zgb,ttl:kVs()});domainChecks=new DD({max:128,ttl:300000});…}
 * async function J4d(e,t){
 *   if(t.domainChecks.has(e))return{status:"allowed"};
 *   try{let r=await ri.get(`https://api.anthropic.com/api/web/domain_info?domain=${encodeURIComponent(e)}`,{timeout:Ygb});
 *     if(r.status===200){if(r.data.can_fetch===!0)return t.domainChecks.set(e,!0),{status:"allowed"};return{status:"blocked"}}
 *     return{status:"check_failed",…}}…}
 * // call site:
 * if(!ka().skipWebFetchPreflight)switch((await J4d(b,n)).status){
 *   case"allowed":break;case"blocked":throw new ora(b);case"check_failed":throw new ira(b)}
 * // setting:
 * skipWebFetchPreflight:qt().optional().describe("Skip the WebFetch blocklist check for enterprise environments with restrictive security policies")
 * ```
 *
 * Four consequences, each of which changes what a fix or a probe can be:
 *
 * 1. **The endpoint is a hardcoded absolute URL and the hostname is a QUERY
 *    PARAMETER.** The local adapter cannot intercept it, `ANTHROPIC_BASE_URL`
 *    does not move it, and it is not a header anything could strip.
 * 2. **The only gate is `skipWebFetchPreflight`** — a settings key, not an env
 *    var, so `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` cannot reach it.
 * 3. **The cache is allow-only, 128 entries, five minutes.** A live probe MUST
 *    use a FRESH hostname per run: a cached one produces no egress and reads
 *    exactly like a fix.
 * 4. **The setting's own describe names enterprise environments**, which is the
 *    audience the owner decision is about.
 *
 * ## What is NOT asserted
 *
 * The minified identifiers (`J4d`, `ka`, `ora`). A bump reassigns them and a pin
 * on one fails for a reason nobody needs to act on. Every assertion below is on
 * a STRING LITERAL — a URL, a setting name, a describe sentence, a cache
 * configuration — which a minifier cannot rename.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import { buildClaudeWebFetchPreflightSettings } from '../claude-agent.ts';

const NATIVE_BINARY = (() => {
  const sdkEntry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
  const nodeModules = sdkEntry.slice(0, sdkEntry.lastIndexOf('/@anthropic-ai/'));
  return `${nodeModules}/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`;
})();

/** One `grep -a -q -F` pass; `-q` stops at the first hit. */
const inBinary = (marker: string): boolean =>
  Bun.spawnSync(['grep', '-a', '-q', '-F', '-e', marker, NATIVE_BINARY]).exitCode === 0;

const haveBinary = (): boolean => {
  try {
    return Bun.file(NATIVE_BINARY).size > 0;
  } catch {
    return false;
  }
};

describe('P3.352 — the WebFetch domain preflight, read out of the shipped binary', () => {
  // ~12 s of `grep` over a 300 MB binary. Bun's 5 s default would fail this for
  // the wrong reason; the budget is set against the measured floor.
  it('carries the hardcoded endpoint, the single gate, the allow-only cache and the describe', () => {
    if (!haveBinary()) return; // darwin-arm64 artefact; absent on other hosts.

    // (1) The endpoint, with the hostname as a query parameter.
    expect(inBinary('https://api.anthropic.com/api/web/domain_info?domain=')).toBe(true);
    // (2) The only gate — a settings key, so no env var reaches it.
    expect(inBinary('skipWebFetchPreflight')).toBe(true);
    // (3) The cache: allow-only, 128 entries, 300 000 ms. Asserted in TWO halves
    // around the minified class name rather than through it: this line named the
    // class and the 0.3.233 -> 0.3.247 lift reassigned it, so a pin whose subject
    // had not moved at all went red (P7.1). Both halves score 1 at `2.1.247`.
    expect(inBinary('domainChecks=new ')).toBe(true);
    expect(inBinary('({max:128,ttl:300000})')).toBe(true);
    // (4) The audience the setting names.
    expect(inBinary('Skip the WebFetch blocklist check for enterprise environments with restrictive security policies')).toBe(true);

    // Zero control on the identical instrument: without it a `grep` that
    // matched everything would make all four pass for no reason.
    expect(inBinary('https://api.anthropic.com/api/web/zzNotARealEndpointP3352')).toBe(false);
  }, 120_000);

  it('we DO set the opt-out now — owner sitting 2026-09-05 §2.2 = (C)', () => {
    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    // This assertion was `toBe(false)` — "the setting is DISCUSSED and not SET",
    // written so that a lane could not slip the posture change in without an
    // owner decision. The owner then made it: (C), disable the preflight paired
    // with a host-supplied domain allowlist. The guard is inverted rather than
    // deleted, so the day someone REMOVES the opt-out that is equally loud.
    expect(/skipWebFetchPreflight\s*:\s*true/.test(source)).toBe(true);
    // And it must reach the child through the ONE `Options.settings` seam, not
    // as a second spread that would replace the credential floor silently.
    expect(source.includes('webFetchPreflight: claudeWebFetchPreflight.settings')).toBe(true);
    // A multi-thousand-line source read; budget set against the measured floor
    // rather than left on bun's 5 s default, which a loaded box overruns.
  }, 60_000);

  /**
   * The PAIRING, which is what makes this (C) rather than (B).
   *
   * The page's own sentence is the requirement: "With the check skipped,
   * WebFetch attempts any URL without consulting the blocklist, so pair it with
   * `WebFetch` permission rules if you need to restrict which domains Claude can
   * reach." Nothing new was built for it — an operator's domain lists already
   * reach the child through `managedSettings` — so what this pins is the one
   * case that would otherwise be silent.
   */
  describe('P3.352 (C) — the pairing, and the install that has none', () => {
    it('an operator with a domain list gets the opt-out and no notice', () => {
      const denied = buildClaudeWebFetchPreflightSettings({ deniedDomains: ['evil.test'] });
      expect(denied.settings.skipWebFetchPreflight).toBe(true);
      expect(denied.notices).toEqual([]);

      const allowed = buildClaudeWebFetchPreflightSettings({ allowedDomains: ['corp.test'] });
      expect(allowed.notices).toEqual([]);
    });

    it('an install with NO domain control still gets the opt-out, and is TOLD', () => {
      // The negative/boundary case, and the whole reason this is not option (B)
      // by accident: for such an install the vendor blocklist is gone and the
      // only remaining judge is the session's own permission gate. Silence there
      // would be indistinguishable from a defect.
      for (const empty of [undefined, {}, { allowedDomains: [], deniedDomains: [] }]) {
        const result = buildClaudeWebFetchPreflightSettings(empty);
        expect(result.settings.skipWebFetchPreflight).toBe(true);
        expect(result.notices).toHaveLength(1);
        expect(result.notices[0]).toContain('api.anthropic.com');
        expect(result.notices[0]).toContain('permission gate');
        // Pi and codex run no such preflight at all — the residual difference
        // the row owes a disclosure for, said here in the line itself.
        expect(result.notices[0]).toContain('Pi and Codex');
      }
    });
  });
});
