/**
 * DA2.2 half A — the verdict the pool filter reads is minted at backend
 * construction, from the SAME endpoint the DA2.6 disclosure names.
 *
 * ## Why this is a source-text pin and not a constructed backend
 *
 * `createBackendFromResolvedContext` ends in `createBackend(config)`, which
 * instantiates a real provider class; standing a test past that seam costs the
 * whole claude/codex module graph and proves nothing extra, because the thing
 * under assertion is ONE assignment in a config literal. The same instrument is
 * used one directory up by `agent/__tests__/model-target-disclosure-sink.test.ts`
 * (DA2.15) against the same function, for the same reason.
 *
 * The BEHAVIOUR of the verdict — which targets withhold, which do not, and what
 * survives — is covered where it belongs: the predicate's own suite
 * (`internal/drivers/external-model-mcp-whitelist.test.ts`) and the pool filter
 * driven end to end through the real `BaseAgent.setSourceServers`
 * (`mcp/__tests__/external-model-mcp-withholding.test.ts`).
 *
 * ## The invariant that matters
 *
 * The disclosure and the withholding must be derived from ONE reading of "which
 * endpoint is this session pointed at". Two derivations is how a user is told
 * about one target while servers are withheld for another — and the anthropic
 * default (`api.anthropic.com`, stored on no connection) is exactly the branch a
 * second derivation would get wrong. Arm 2 is what goes red if someone inlines
 * that expression again.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FACTORY = join(import.meta.dir, '..', 'factory.ts');
const UPSTREAM_TARGET = join(import.meta.dir, '..', 'internal', 'drivers', 'upstream-target.ts');

/** The body of `createBackendFromResolvedContext`, and nothing else in the file. */
function resolvedContextFactoryBody(): string {
  const source = readFileSync(FACTORY, 'utf-8');
  const start = source.indexOf('export function createBackendFromResolvedContext');
  const end = source.indexOf('export function initializeBackendHostRuntime');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/**
 * F1.110 - the body of `modelTargetBaseUrlForConnection`, which is where the
 * three-term derivation LIVES since the endpoint half of the verdict gained a
 * second reader (`PiAgent.updateRuntimeConfig`).
 */
function endpointDerivationBody(): string {
  const source = readFileSync(UPSTREAM_TARGET, 'utf-8');
  const start = source.indexOf('export function modelTargetBaseUrlForConnection');
  expect(start).toBeGreaterThan(-1);
  // The function's PARAMETER type is an inline object, so its `}` closes a line
  // that continues (`}): string | undefined {`). Only the body's own closing
  // brace is followed by a newline, which is what makes this slice the BODY and
  // not the signature — the first draft of this helper stopped at the parameter.
  const end = source.indexOf('\n}\n', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('DA2.2 · the model-target verdict on the backend config', () => {
  it('BackendConfig declares the field, optional and documented as fail-open', () => {
    const types = readFileSync(join(import.meta.dir, '..', 'types.ts'), 'utf-8');
    expect(types).toContain('modelTarget?: ModelTargetVerdict;');
  });

  it('the factory puts a classified verdict on the config it hands createBackend', () => {
    const body = resolvedContextFactoryBody();
    // D1.221 widened the call with `providerType`, so the pin reads the ARGUMENTS
    // rather than one formatted line — a source-text assertion that breaks on a
    // line wrap teaches its next reader to delete it.
    const call = body.slice(body.indexOf('modelTarget: classifyModelTarget('));
    const args = call.slice(0, call.indexOf('}),'));
    expect(args).toContain('baseUrl: modelTargetBaseUrl,');
    expect(args).toContain('model: context.resolvedModel,');
    expect(args).toContain('providerType: context.connection?.providerType,');
  });

  /**
   * D1.221 — the endpoint-less arm is fail-closed, so the DISCLOSURE has to be
   * given the same `providerType` the verdict is. Told one thing and withheld
   * another is the failure this file exists to prevent.
   */
  it('the disclosure and the verdict read ONE providerType as well as one endpoint', () => {
    const body = resolvedContextFactoryBody();
    const call = body.slice(body.indexOf('noteModelTargetToolEgress({'));
    expect(call.slice(0, call.indexOf('});'))).toContain('providerType: context.connection?.providerType,');
  });

  /**
   * F1.110 MOVED the derivation and this arm MOVED WITH IT, strictly tighter.
   *
   * The invariant is unchanged - ONE reading of "which endpoint is this session
   * pointed at", shared by the disclosure and the verdict - but the derivation
   * now lives in `modelTargetBaseUrlForConnection` because a THIRD reader
   * appeared: `PiAgent.updateRuntimeConfig`, where an endpoint edited
   * mid-session has to be re-classified. So the factory is now asserted to spell
   * NEITHER named default (0, not 1), which is a stronger claim than before:
   * previously a copy inside the factory was legal as long as there was one, and
   * now the only legal spelling is the shared function's.
   */
  it('the disclosure and the verdict read ONE derivation of the endpoint', () => {
    const body = resolvedContextFactoryBody();
    // Derived once, in one statement...
    expect(body.split('const modelTargetBaseUrl').length - 1).toBe(1);
    expect(body).toContain('const modelTargetBaseUrl = modelTargetBaseUrlForConnection({');
    // ...and NOWHERE does the factory spell a default endpoint of its own. A
    // second copy here is the defect this arm is for, and it no longer has a
    // legal single copy to hide behind.
    expect(body.split("'https://api.anthropic.com'").length - 1).toBe(0);
    expect(body.split("'https://chatgpt.com/backend-api'").length - 1).toBe(0);
    // ...and the disclosure is handed that identifier rather than re-deriving.
    const call = body.slice(body.indexOf('noteModelTargetToolEgress({'));
    expect(call.slice(0, call.indexOf('});'))).toContain('baseUrl: modelTargetBaseUrl,');
  });

  /**
   * F1.110 - the other end of the move: the shared function is the ONE place
   * either default is spelled, over the whole classifier module.
   */
  it('the shared derivation is the only place a provider default is named', () => {
    const source = readFileSync(UPSTREAM_TARGET, 'utf-8');
    expect(source.split("'https://api.anthropic.com'").length - 1).toBe(1);
    expect(source.split("'https://chatgpt.com/backend-api'").length - 1).toBe(1);
    const derivation = endpointDerivationBody();
    expect(derivation).toContain("'https://api.anthropic.com'");
    expect(derivation).toContain("'https://chatgpt.com/backend-api'");
  });

  /**
   * D1.191 — the SECOND named provider default, pinned in the same derivation.
   *
   * The positive: the ChatGPT Plus card's endpoint is resolved where the
   * anthropic one is, so the disclosure and the withholding cannot disagree
   * about it either. The negative is the arm above, which still requires
   * exactly ONE `const modelTargetBaseUrl` — a second derivation added for this
   * card would fail there rather than here.
   *
   * The value is Pi's own `DEFAULT_CODEX_BASE_URL`, not a host we chose, and the
   * discriminator is `piAuthProvider` rather than `providerType`, because the
   * Nessy gateway card is `pi` too and carries a real endpoint of its own.
   */
  it('resolves the ChatGPT subscription default in that same one derivation', () => {
    // Read where the derivation lives since F1.110; the factory's own body is
    // asserted to carry no copy of it by the arm above.
    const derivation = endpointDerivationBody();
    expect(derivation).toContain("piAuthProvider === 'openai-codex'");
    expect(derivation).toContain("'https://chatgpt.com/backend-api'");
    expect(derivation).not.toContain("providerType === 'pi'");
    // And the factory really reaches it, so this is not a test of a dead branch.
    expect(resolvedContextFactoryBody()).toContain('piAuthProvider: context.connection?.piAuthProvider,');
  });
});
