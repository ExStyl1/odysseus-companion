/**
 * P6.114 / P6.115 — what ends a claude turn when the upstream holds the socket
 * open and silent, and the predicate three places in this tree quoted backwards.
 *
 * ## The two halves, and why they are one file
 *
 * P6.114 asked for a RUN rather than a bundle read. P6.115 asked for the record
 * correction, and its second half was GATED on that run's answer. The run
 * happened; both halves are recorded here, and the assertions below are what
 * keeps them from drifting apart.
 *
 * ## THE RUN, measured 2026-09-05 against the vendored 2.1.233 / agent-sdk 0.3.233
 *
 * Rig: `silent-upstream-claude-rig.ts` — a real `sdk.query` against a stub that
 * sends SSE headers, `message_start`, one text delta, and then holds the socket
 * OPEN and silent. Load quoted per the standing rule; the box sat at 10-12
 * throughout.
 *
 * | arm | levers | budget | outcome |
 * | --- | --- | --- | --- |
 * | `control_close` | — | 120 s | **completed in 1.0 s**, `subtype: success` |
 * | `default_bounded` | — | 60 s | nothing ended it |
 * | `timeout_8s` | `API_TIMEOUT_MS=8000` | 90 s | nothing ended it |
 * | `force_idle_timeout` | `API_TIMEOUT_MS=8000` + `API_FORCE_IDLE_TIMEOUT=1` | 120 s | nothing ended it |
 * | `watchdog_on` | `CLAUDE_ENABLE_BYTE_WATCHDOG=1` + `CLAUDE_STREAM_IDLE_TIMEOUT_MS=10000` | 120 s | nothing ended it |
 * | `default_full` | — | 780 s | **ended at 544 907 ms**, `API Error: The operation timed out.`, 2 held attempts |
 *
 * Two further arms settle what the first six could not, using a stub that never
 * sends HEADERS at all: with `API_TIMEOUT_MS=8000` the child made **7** attempts
 * in 90 s, and with no lever set it made **1**. So `API_TIMEOUT_MS` IS read by
 * the child and DOES fire — before headers. It simply does not bound the body
 * once bytes have flowed, which is the same shape this repo already documents
 * for the `openai` client on Pi's route (`stream-idle.ts`).
 *
 * **Verdict for ledger F7/claude: `partial ʰ`.** Something ends it, with a named
 * error — but at roughly nine minutes, and none of the three documented levers on
 * this route shortens it.
 *
 * ## THE PREDICATE, and the direction three places had backwards
 *
 * The SDK's byte watchdog is the mechanism designed for exactly this, and it
 * cannot be turned on here. Read verbatim out of the vendored binary:
 *
 * ```js
 * function <watchdogApplies>(e){if(!<watchdogEnabled>())return!1;return <providerOk>(e)&&<providerOk>(<currentProvider>())}
 * function <watchdogEnabled>(){if(<isFalsy>(process.env.CLAUDE_ENABLE_BYTE_WATCHDOG))return!1;if(<isTruthy>(process.env.CLAUDE_ENABLE_BYTE_WATCHDOG))return!0;return <flag>("tengu_stream_watchdog_default_on",!0)}
 * function <providerOk>(e){return <firstPartyOrAws>(e)||e==="bedrock"&&<bedrockOptIn>()}
 * function <firstPartyOrAws>(e){return e==="firstParty"&&<isFirstPartyBaseUrl>()||e==="anthropicAws"&&!process.env.ANTHROPIC_AWS_BASE_URL}
 * function <isFirstPartyBaseUrl>(){if(V._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL)return!0;return <baseUrlIsAnthropic>()}
 * function <baseUrlIsAnthropic>(){let e=process.env.ANTHROPIC_BASE_URL;if(!e)return!0;return <hostIsAnthropic>(e)}
 * function <hostIsAnthropic>(e){try{let t=new URL(e).host;return["api.anthropic.com"].includes(t)}catch{return!1}}
 * ```
 *
 * The provider test is true for `firstParty` only when the first-party test is —
 * i.e. when the base URL IS
 * `api.anthropic.com`. Every Nessy claude session points `ANTHROPIC_BASE_URL` at
 * a loopback adapter and strips `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`, so
 * the first-party test is false and the arming predicate returns false. **The watchdog is off on every session
 * this product creates**, and forcing `CLAUDE_ENABLE_BYTE_WATCHDOG=1` only makes
 * the enable-gate true while the arming predicate stays false — which the `watchdog_on` arm above
 * confirms behaviourally, not just by reading.
 *
 * Two comments said the opposite ("for a NON-first-party base URL — which every
 * Nessy Claude session is") and a third, `O6` in the out-of-scope register, was
 * built on that ground. All three are corrected; `config/claude-provider-routing-env.ts`
 * already quoted the same first-party / base-URL / host-list chain CORRECTLY, which is the positive
 * control proving the refutation was on disk before either wrong comment was
 * written.
 *
 * ## What is NOT asserted, and why the names below are only three
 *
 * Minified identifiers are not a contract, and this row has now watched that
 * happen twice. The comments it corrected cited three names, two of which scored
 * zero in the bundle of the day and the third of which had come to name a path
 * helper with nothing to do with a stream deadline. Then the `0.3.233` ->
 * `0.3.247` lift (P7.1) reassigned every name in the pins written to replace
 * them — the pins went red while the behaviour was untouched. So the assertions
 * below name NO identifier at all: they are string literals, env-var names and a
 * statsig gate name, cut around the minified parts, and the transcription in the
 * comment spells roles in `<angle brackets>`.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { vendoredClaudeBinary, vendoredVersions, ARMS } from './silent-upstream-claude-rig.ts';

const BINARY = vendoredClaudeBinary();
const VERSIONS = vendoredVersions();

const inBinary = (needle: string): boolean =>
  Bun.spawnSync(['grep', '-a', '-q', '-F', '-e', needle, BINARY!]).exitCode === 0;

const repoFile = (relative: string): string =>
  fileURLToPath(new URL(`../../../../../${relative}`, import.meta.url));

describe('P6.115 · the arming predicate, read out of the shipped binary', () => {
  it.skipIf(BINARY === null || !existsSync(BINARY))(
    'arms the byte watchdog for a FIRST-party base URL only',
    () => {
      // P7.1 — every needle here used to carry a MINIFIED NAME, and the
      // `0.3.233` -> `0.3.247` lift reassigned all of them: the pins went red
      // while not one of the behaviours they describe had moved. Re-cut around
      // the names, on byte sequences a minifier cannot rewrite — an env var, a
      // statsig gate name, a literal host list — each measured at `2.1.247` with
      // the count in the comment beside it.
      //
      // The gate an operator can reach: it can only turn the watchdog OFF here,
      // because the arming test below it never passes on our route. (1 hit each.)
      expect(inBinary('(process.env.CLAUDE_ENABLE_BYTE_WATCHDOG))return!0;return')).toBe(true);
      expect(inBinary('tengu_stream_watchdog_default_on",!0)')).toBe(true);
      // THE DIRECTION. `firstParty` AND the first-party test, never the negation
      // of either: the AWS half's tail is unique (1 hit) and pins the whole
      // predicate's shape.
      expect(inBinary('e==="firstParty"&&')).toBe(true);
      expect(inBinary('&&!process.env.ANTHROPIC_AWS_BASE_URL}')).toBe(true);
      // And what the first-party test means: the host is literally
      // api.anthropic.com. The assume-flag short-circuit is 1 hit; the host list
      // is 1.
      expect(inBinary('._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL)return!0;return')).toBe(true);
      expect(inBinary('return["api.anthropic.com"].includes(t)')).toBe(true);

      // ZERO CONTROL on the identical instrument: without it a grep that matched
      // everything would make all six pass for no reason.
      expect(inBinary('e!=="firstParty"&&zzNotRealP6115')).toBe(false);
    },
    180_000,
  );

  it('the three in-tree statements now quote that direction, and one always did', () => {
    // THE POSITIVE CONTROL, and it is the sharpest fact in this row: the
    // refutation was already on disk, quoted correctly, in a third file, before
    // either wrong comment was written.
    const routing = readFileSync(repoFile('packages/shared/src/config/claude-provider-routing-env.ts'), 'utf8');
    expect(routing).toContain('return["api.anthropic.com"].includes(t)');

    // The two that had it backwards. The pin is on the CLAIM, not on the phrase:
    // both files deliberately still SAY "NON-first-party base URL" while
    // recording what they used to get wrong, and a pin on that phrase would
    // forbid keeping the correction legible. The discriminator is the second
    // clause — the one that asserted our own route is the covered one.
    for (const path of [
      'packages/codex-responses-adapter/src/server.ts',
      'packages/shared/src/llm/stream-idle.ts',
    ]) {
      const source = readFileSync(repoFile(path), 'utf8');
      for (const claim of ['which this loopback always is', 'which every Nessy Claude session is']) {
        expect(source, `${path} still claims our route is what arms the watchdog`).not.toContain(claim);
      }
      // …and each now carries the predicate verbatim, so the direction is on the
      // page rather than in a summary of it.
      expect(source, `${path} does not quote the predicate it depends on`)
        .toContain('["api.anthropic.com"].includes(t)');
    }

    // O6's ground, in the register itself — and it is pinned on the SAME content
    // anchor as the two source files above, which is what P6.1054 landed. Until
    // then this asserted a minified identifier: it passed only because it read
    // the register's own prose rather than the bundle, where the `0.3.247` lift
    // had reassigned the name out of existence. The register now spells roles in
    // angle brackets and carries the host list verbatim, so the three statements
    // are bound to one byte sequence a minifier cannot rewrite.
    const register = readFileSync(repoFile('docs/superpowers/specs/2026-08-28-out-of-scope-register.md'), 'utf8');
    const o6 = register.split('\n').find(line => line.startsWith('| O6 '));
    expect(o6, 'O6 is gone from the register').toBeDefined();
    expect(o6!, 'O6 still certifies a watchdog that is off')
      .toContain('["api.anthropic.com"].includes(t)');
  });
});

/**
 * The RUN half. Spawning a real child is not a CI gate — it is a recorded local
 * run, the same posture as the sibling `claude-*-e2e` suites — so it is opt-in
 * through `NESSY_CLAUDE_SDK_E2E=1`.
 */
const E2E = process.env.NESSY_CLAUDE_SDK_E2E === '1' && BINARY !== null && VERSIONS !== null;

describe('P6.114 · a real turn against an upstream that holds the socket open', () => {
  it.skipIf(!E2E)('completes normally when the stub closes — and measures what we ship', async () => {
    const outcome = await ARMS.control_close();
    // PROVENANCE FIRST, before any duration is believed. A sibling rig measured
    // agent-sdk 0.3.238 for a whole session because it lived outside the repo.
    expect(outcome.userAgent).toContain(`claude-cli/${VERSIONS!.cli}`);
    expect(outcome.userAgent).toContain(`agent-sdk/${VERSIONS!.sdk}`);
    expect(outcome.ended).toBe('result');
    expect(outcome.detail).toContain('"is_error":false');
  }, 180_000);

  it.skipIf(!E2E)('is NOT ended by anything inside a minute when the upstream goes silent', async () => {
    const outcome = await ARMS.default_bounded();
    expect(outcome.held).toBe(1);
    expect(outcome.ended).toBe('budget-exhausted');
  }, 180_000);

  /**
   * The one that turns a bundle read into a behaviour. Forcing the operator gate
   * on cannot arm the watchdog, because the arming predicate's second test — the
   * provider/base-URL one — never passes on a loopback base URL.
   */
  it.skipIf(!E2E)('cannot be rescued by forcing CLAUDE_ENABLE_BYTE_WATCHDOG on', async () => {
    const outcome = await ARMS.watchdog_on();
    expect(outcome.held).toBe(1);
    expect(outcome.ended).toBe('budget-exhausted');
  }, 240_000);

  /**
   * `API_TIMEOUT_MS` IS read — it simply does not bound the BODY. Without this
   * pair the arm above reads as "the variable never reached the child", which is
   * a different defect with a different fix.
   */
  it.skipIf(!E2E)('reads API_TIMEOUT_MS before headers, and not after', async () => {
    const bounded = await ARMS.headers_hold_8s();
    const control = await ARMS.headers_hold_default();
    expect(bounded.requests).toBeGreaterThan(control.requests);
    expect(control.requests).toBe(1);
  }, 240_000);
});
