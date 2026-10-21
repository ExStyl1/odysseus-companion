/**
 * Codex applies a model change IN PLACE (T1), and since P6.365 it does so on
 * codex's own per-turn override rather than by forking the thread.
 *
 * Two pure contracts, both of which the recreate path used to hide:
 *
 * 1. `codexThreadConfigSignature` — what makes a thread's CONFIG LAYER stale.
 *    The model was in here on a premise this row measured and refuted ("codex
 *    fixes a thread's model at `thread/start` and `turn/start` carries no
 *    model"): `TurnStartParams.model` is declared in the pinned schema as
 *    "Override the model for this turn and subsequent turns". So a model change
 *    is no longer config drift, and no longer costs a `thread/fork`.
 * 2. `codexUpdateIsModelOnly` — which runtime updates a LIVE codex agent may
 *    absorb. Only a model change; the adapter, its credential and the managed
 *    `CODEX_HOME` are established once in `createRuntime`.
 *
 * The endpoint comparison is over the DERIVED upstream, not the raw base URL:
 * `SessionManager` sends the connection's own `baseUrl` on every refresh, and
 * for a gateway card that string maps to `{ kind: 'nestor' }`, whose pinned
 * base URL is `undefined`. Comparing the raw string against the pinned one
 * declined every gateway model change — i.e. the whole feature, on the primary
 * card.
 */
import { describe, expect, it } from 'bun:test';
import { codexThreadConfigSignature, codexUpdateIsModelOnly } from '../codex-agent.ts';
import { NESSY_GATEWAY_CHAT_BASE_URL } from '../backend/internal/drivers/upstream-target.ts';

const CONFIG = { sandbox_mode: 'workspace-write' } as const;

describe('codexThreadConfigSignature', () => {
  it('drifts when the config layer changes — the part that cannot ride a turn', () => {
    // `config.toml` is read when the app-server STARTS and `TurnStartParams` has
    // no member for the sandbox/approval layer, so this is still what the fork
    // exists for.
    const a = codexThreadConfigSignature(CONFIG);
    const b = codexThreadConfigSignature({ sandbox_mode: 'danger-full-access' });
    expect(a).not.toBe(b);
  });

  it('is stable for the same config', () => {
    expect(codexThreadConfigSignature(CONFIG)).toBe(codexThreadConfigSignature(CONFIG));
  });

  it('P6.365 · takes NO model, so a model change is not config drift', () => {
    // The signature that a fork is decided on must not see the model at all —
    // that is the whole of "a model change produces no `thread/fork`". Pinned as
    // an ARITY as well as a value, because the wrong shape here is what put the
    // model in on a refuted premise the first time.
    expect(codexThreadConfigSignature.length).toBe(1);
    expect(codexThreadConfigSignature(CONFIG)).not.toContain('gpt-5.3-codex');
  });
});

describe('codexUpdateIsModelOnly', () => {
  const current = {
    providerType: 'codex-runtime' as const,
    authType: 'bearer_token' as const,
    baseUrl: undefined,
  };

  it('accepts a bare model change', () => {
    expect(codexUpdateIsModelOnly({ model: 'gpt-5.3-codex-mini' }, current)).toBe(true);
  });

  it('accepts a model change alongside an unchanged runtime block', () => {
    expect(codexUpdateIsModelOnly(
      { model: 'gpt-5.3-codex-mini', providerType: 'codex-runtime', authType: 'bearer_token', runtime: {} },
      current,
    )).toBe(true);
  });

  it('treats the gateway base URL as the pinned nestor upstream', () => {
    expect(codexUpdateIsModelOnly(
      { model: 'gpt-5.3-codex-mini', runtime: { baseUrl: NESSY_GATEWAY_CHAT_BASE_URL } },
      current,
    )).toBe(true);
  });

  it('declines an endpoint change — a fresh adapter and CODEX_HOME are required', () => {
    expect(codexUpdateIsModelOnly(
      { model: 'gpt-5.3-codex', runtime: { baseUrl: 'https://example.invalid/v1' } },
      current,
    )).toBe(false);
  });

  it('declines a providerType change', () => {
    expect(codexUpdateIsModelOnly({ model: 'gpt-5.3-codex', providerType: 'pi' }, current)).toBe(false);
  });

  it('declines an authType change', () => {
    expect(codexUpdateIsModelOnly({ model: 'gpt-5.3-codex', authType: 'api_key' }, current)).toBe(false);
  });
});
