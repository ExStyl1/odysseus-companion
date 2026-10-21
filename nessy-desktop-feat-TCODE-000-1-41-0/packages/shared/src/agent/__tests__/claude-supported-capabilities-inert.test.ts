import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildClaudeRuntimeAliasModelEnv } from '../claude-agent.ts';

/**
 * P6.367's claude half — **REFUTED at HEAD, and this file is the refutation plus
 * its trigger.**
 *
 * The row asked for the `_SUPPORTED_CAPABILITIES` family to be projected from a
 * connection's model declaration into the claude child, on a native clause that
 * read *"the `_SUPPORTED_CAPABILITIES` family is native (35 occurrences in the
 * vendored binary) for pinned/third-party ids and we project none of it."* The
 * count was right at the bundle it was taken against — 35 in the vendored
 * `claude` at `2.1.233`, control `zzznonsensecontrolzzz` 0. Re-measured
 * 2026-09-12 on the vendored `2.1.247` (C3.252), with the instrument named on
 * both sides because they disagree on a minified artefact (C3.294): **3 lines
 * (`grep -acF`) / 20 occurrences (`grep -aoF … | wc -l`)**, control 0/0 — and
 * **"third-party" is still the load-bearing word, which is the point the count
 * never carried.**
 *
 * ## The measurement, from the binary rather than from the page alone
 *
 * The resolver, first read out of the vendored `claude` at `2.1.233`:
 *
 * ```
 * function GS_(e,t){ if(py())return;
 *   for(let r of WS_){ let n=process.env[r.modelEnvVar]?.trim(),
 *     o=process.env[r.capabilitiesEnvVar];
 *     if(!n||o===void 0)continue; if(e!==n.toLowerCase())continue;
 *     return o.toLowerCase().split(",").map(i=>i.trim()).includes(t) } return }
 * ```
 *
 * Re-read at `2.1.247` by its own `capabilitiesEnvVar` anchor (never by those
 * letters — every one of them moved): the body is unchanged clause for clause,
 * as `function NM(e,t){if(St())return;for(let n of FM){…}}`, and the gate is
 * still `function ve(e=d()){return e==="firstParty"||w(e)||e==="gateway"}` over
 * `function w(e=d()){return e==="anthropicAws"||e==="anthropicGoogleCloud"}`.
 * The lift added ONE thing and it does not touch this verdict: the resolver is
 * now reached through a memoising wrapper that caches per `model:capability` in
 * `providerCache.capabilityOverrides`. A cache in front of a function that
 * returns before reading anything still returns before reading anything.
 *
 * A bare `return` is *"falls back to built-in detection based on the model ID"*,
 * the page's own wording. And the gate is
 * `function py(e=Jn()){return e==="firstParty"||M7(e)||e==="gateway"}`, with
 * `M7` covering `anthropicAws`/`anthropicGoogleCloud`. **This fork strips every
 * provider-selection toggle from the claude child** (`CLAUDE_SDK_STRIPPED_ENV_KEYS`,
 * and the reason is recorded there), so the child resolves as `firstParty` and
 * the resolver returns before reading a capability variable at all — and a
 * `gateway` shape, the other thing this fork could plausibly look like, is in
 * the same short-circuit.
 *
 * `model-config.md#customize-pinned-model-display-and-capabilities` (anchor
 * verified on the rendered page) says it from the outside, and the sentence is
 * worth reading twice for which two variables it exempts: *"These variables take
 * effect on third-party providers such as Amazon Bedrock, Google Cloud's Agent
 * Platform, and Microsoft Foundry. The `_NAME` and `_DESCRIPTION` variables also
 * take effect when `ANTHROPIC_BASE_URL` points to an LLM gateway. They have no
 * effect when connecting directly to `api.anthropic.com`."*
 * `_SUPPORTED_CAPABILITIES` is not in the gateway sentence, and the binary
 * agrees by listing `"gateway"` in `py`.
 *
 * ## The half that ALMOST works, which is what makes this worth a file
 *
 * The resolver's second requirement — `process.env[modelEnvVar]` set and equal
 * to the model id, over `ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL` and
 * `ANTHROPIC_CUSTOM_MODEL_OPTION` — **is already satisfied here.** P6.160's
 * {@link buildClaudeRuntimeAliasModelEnv} pins opus, sonnet and fable to the
 * session's own model, and both spawn paths write the haiku one. So a lane
 * building the projection would find the keying already in place, add the
 * companion variable beside a variable that is demonstrably read, ship a diff
 * that looks complete — and change nothing at all, on every session this fork
 * ships. That is the failure mode AGENTS.md names: being wrong in a way that
 * looks obviously right.
 *
 * ## What DID close the row's real mechanism
 *
 * The host's own capability declaration reaching the runtime that can act on it:
 * the `connection.models` mappers whitelist by NAME, and `supportsThinking` was
 * dropped by both — `backend/internal/drivers/pi.ts` (construction, `f0f82dae2`)
 * and `SessionManager.ts` (live refresh). Both are widened now, and the third
 * case below is the control that keeps this refutation from reading as "nothing
 * was owed".
 *
 * ## The trigger
 *
 * Asserted from OUR side rather than by grepping a 300 MB binary on every run.
 * The day a lane writes a capability list, this goes red and the gate has to be
 * re-measured against whatever bundle ships then — which is the only honest way
 * to spend a refutation resting on a vendored binary the plan lifts at
 * close-out.
 */

const source = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const CHILD_ENV_SOURCES = [
  '../claude-agent.ts',
  '../options.ts',
  '../../config/claude-provider-routing-env.ts',
] as const;

describe('P6.367 — the _SUPPORTED_CAPABILITIES projection is inert here, and stays unbuilt', () => {
  it('writes no capability list into the claude child, because the provider gate would discard it', () => {
    const files = CHILD_ENV_SOURCES.map(source).join('\n');
    // A `_NAME` or `_DESCRIPTION` projection would be a DIFFERENT decision: the
    // page grants those two an effect on a gateway base URL and grants this one
    // none. This assertion is about the capability suffix alone.
    expect(files).not.toContain('SUPPORTED_CAPABILITIES');
  });

  it('DOES pin the model env vars the list would be keyed to, so the gate is the only block', () => {
    // The sharp half. If this ever became false the refutation would have two
    // legs instead of one, and the next reader would have to know which one they
    // were standing on.
    const env = buildClaudeRuntimeAliasModelEnv({
      opus: 'gateway/some-model',
      sonnet: 'gateway/some-model',
      fable: 'gateway/some-model',
    });
    expect(env).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'gateway/some-model',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'gateway/some-model',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'gateway/some-model',
    });
    // And the boundary the same builder documents: an alias with no served
    // model writes nothing, so an unpinned family cannot key anything either.
    expect(buildClaudeRuntimeAliasModelEnv({})).toEqual({});
  });

  it('carries the declaration through the seam that DOES work — the model whitelist', () => {
    // The positive control for the refutation: the row is not "nothing was
    // owed", it is "the owed thing is elsewhere". Both `connection.models`
    // mappers must name `supportsThinking`, or a capability an operator declared
    // is dropped in silence between the connection and the subprocess.
    const sessionManager = readFileSync(
      fileURLToPath(new URL('../../../../server-core/src/sessions/SessionManager.ts', import.meta.url)),
      'utf8',
    );
    expect(sessionManager).toContain('supportsThinking');
    expect(source('../backend/internal/drivers/pi.ts')).toContain('supportsThinking');
  });
});
