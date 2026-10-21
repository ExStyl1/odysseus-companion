/**
 * T7 gate: the Claude Code (Nessy Gateway) card builds a `claude-runtime`
 * connection from the SAME shared gateway preset the Pi and Codex cards use —
 * base URL, model catalog and coder default all come from the `nessy-gateway`
 * literals, never re-declared here.
 *
 * The mini/fast-model contract is pinned here too: `ClaudeAgent` seeds
 * `ANTHROPIC_DEFAULT_HAIKU_MODEL` from `getMiniModel(connection)`.
 *
 * **This paragraph used to explain that the resolver had no keyword to match on,
 * because the gateway ids carried none of the small-model words, so it fell
 * through to the LAST catalog entry and the seeding order was load-bearing. That
 * is refuted (P6.1080, 2026-09-11).** The gateway rotated its coder id to
 * `tgpt/deepseek-v4-flash-0731`, which carries one of those words outright, and
 * on the two gateway cards whose keyword list includes it the mini tier resolved
 * to the FLAGSHIP. `findSmallModel` now asks the endpoint's own `fast` alias
 * before any keyword, so the answer no longer depends on either the id's
 * spelling or the seeding order — both of which the gateway owns and changes.
 * The order below is still asserted, because a seed that disagrees with the
 * alias is a bug worth catching, but it is no longer what decides the answer.
 */
import { test, expect, describe } from 'bun:test';
import { getMiniModel, getSummarizationModel, resolveGatewayFastModelId, type LlmConnection } from '@nessy-agent/shared/config';
import {
  claudeGatewayConnectionDefaults,
  codexGatewayConnectionDefaults,
  NESSY_GATEWAY_BASE_URL,
  NESSY_GATEWAY_DEFAULT_MODEL,
  NESSY_GATEWAY_MODELS,
  NESSY_GATEWAY_MODEL_IDS,
} from '../nessy-gateway.ts';

function asConnection(): LlmConnection {
  const d = claudeGatewayConnectionDefaults();
  return {
    slug: 'claude-gateway',
    name: 'Claude Code (Nessy Gateway)',
    providerType: d.providerType,
    authType: d.authType,
    baseUrl: d.baseUrl,
    defaultModel: d.defaultModel,
    models: d.models,
    createdAt: 1,
  };
}

describe('claude connection setup', () => {
  test('claudeGatewayConnectionDefaults yields a claude-runtime Nessy Gateway connection', () => {
    const d = claudeGatewayConnectionDefaults();

    expect(d.providerType).toBe('claude-runtime');
    expect(d.authType).toBe('api_key_with_endpoint');
    expect(d.baseUrl).toBe(NESSY_GATEWAY_BASE_URL);
    expect(d.defaultModel).toBe(NESSY_GATEWAY_DEFAULT_MODEL);
    expect(d.models).toEqual(NESSY_GATEWAY_MODELS);
    // Same gateway coder default the other two cards use. RE-MEASURED
    // 2026-09-11 (P6.1080): the gateway retired `tgpt/qwen35-397b-a17b-fp8`
    // and answers 404 for it, so the literal this line used to carry named a
    // model the card could not talk to. The id behind the `coder` alias is
    // what moved; the alias did not.
    expect(d.defaultModel).toBe('tgpt/deepseek-v4-flash-0731');
  });

  test('shares the gateway preset with the codex card (one set of literals)', () => {
    const claude = claudeGatewayConnectionDefaults();
    const codex = codexGatewayConnectionDefaults();

    expect(claude.baseUrl).toBe(codex.baseUrl);
    expect(claude.defaultModel).toBe(codex.defaultModel);
    expect(claude.models).toEqual(codex.models);
    expect(claude.providerType).not.toBe(codex.providerType);
  });

  test('seeds the fast model LAST so the mini/summarization tier resolves to it', () => {
    const models = claudeGatewayConnectionDefaults().models;

    expect(models[models.length - 1]!.id).toBe(NESSY_GATEWAY_MODEL_IDS[1]);
    expect(getMiniModel(asConnection())).toBe('tgpt/qwen36-35b-a3b-fp8');
    expect(getSummarizationModel(asConnection())).toBe('tgpt/qwen36-35b-a3b-fp8');
  });

  test('the mini model is never the flagship coder model', () => {
    // A regression here is silent and expensive: WebFetch summarization and
    // title generation would run on the flagship model on every turn.
    //
    // It ALMOST happened, and the way it almost happened is why the tier now
    // asks the endpoint instead of guessing. Measured 2026-09-11 (P6.1080) on
    // the live catalogue before the fix: `getMiniModel` answered
    // `tgpt/deepseek-v4-flash-0731` — the flagship — on all three gateway cards,
    // because `findSmallModel`'s keyword list contains "flash" and the new coder
    // id contains it too. This case did not catch it, because on a `claude-runtime`
    // connection the keyword list is `['haiku']` and the miss was masked by the
    // last-in-list fallback landing on the right answer for the wrong reason.
    // Hence the second assertion: the answer must be the model the gateway
    // ALIASES `fast`, not merely "not the default".
    expect(getMiniModel(asConnection())).not.toBe(NESSY_GATEWAY_DEFAULT_MODEL);
    expect(getMiniModel(asConnection())).toBe(resolveGatewayFastModelId(asConnection()));
  });

  test('declares no image support on the seeded catalog (adapter drops images in v1)', () => {
    for (const model of claudeGatewayConnectionDefaults().models) {
      expect(model.supportsImages).toBe(false);
    }
  });
});
