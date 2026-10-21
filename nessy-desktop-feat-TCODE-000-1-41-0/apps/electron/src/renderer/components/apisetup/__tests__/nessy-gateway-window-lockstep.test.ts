/**
 * P3.79 — the gateway window, pinned across the three places that seed it.
 *
 * The row found two sites carrying a number typed by hand where a measured one
 * exists: `pi-agent-server`'s custom-endpoint fabrication and the electron
 * `nessy-gateway` preset, the latter seeding `262_144` — 144 tokens ABOVE the
 * gateway's own reported `262000`. An over-stated window is the failure that is
 * silent: the session runs past the real limit before anything compacts.
 *
 * The preset is asserted THROUGH ITS OWN MODULE rather than by re-reading the
 * table, so this fails if the preset ever goes back to a literal.
 *
 * It lives HERE, beside the preset, rather than in `shared`: a test under
 * `packages/shared` that imports this renderer module drags the module into
 * shared's tsc program, where `@config/*` is not a path alias, and
 * `typecheck:shared` goes red on an import that is perfectly valid in the app
 * that owns it.
 */
import { describe, expect, it } from 'bun:test';
import {
  MIN_PLAUSIBLE_CONTEXT_WINDOW,
  NESTOR_GATEWAY_MODEL_WINDOWS,
  nestorGatewayModelWindow,
} from '@config/nestor-gateway-windows';
import {
  NESTOR_GATEWAY_CHAT_BASE_URL,
  NESTOR_GATEWAY_MODEL_WINDOWS as TABLE_AT_ITS_HOME,
} from '../../../../../../../packages/shared/src/auth/nestor.ts';
import {
  isNessyGatewayBaseUrl,
  NESSY_GATEWAY_BASE_URL,
  NESSY_GATEWAY_CONTEXT_WINDOW,
  NESSY_GATEWAY_MODELS,
  NESSY_GATEWAY_MODEL_IDS,
} from '../nessy-gateway.ts';

describe('the @config door onto the gateway window table', () => {
  it('re-exports the table itself, not a copy of it', () => {
    // A copy would drift; identity cannot. This is the whole justification for
    // the module existing.
    expect(NESTOR_GATEWAY_MODEL_WINDOWS).toBe(TABLE_AT_ITS_HOME);
  });

  it('carries at least one window, and none of them a placeholder', () => {
    // The preset's fallback is `Math.min(...Object.values(table))`, which is
    // `Infinity` on an empty table — so non-emptiness is load-bearing, not
    // decorative. And `1` means "not filled in" in both catalogues this repo
    // reads; a placeholder reaching the seed would cap a session at nothing.
    const windows = Object.values(NESTOR_GATEWAY_MODEL_WINDOWS);
    expect(windows.length).toBeGreaterThan(0);
    for (const window of windows) {
      expect(window).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_CONTEXT_WINDOW);
    }
  });
});

describe('the electron nessy-gateway preset', () => {
  it('seeds every preset model from the measured table', () => {
    expect(NESSY_GATEWAY_MODELS.length).toBe(NESSY_GATEWAY_MODEL_IDS.length);
    for (const model of NESSY_GATEWAY_MODELS) {
      const measured = nestorGatewayModelWindow(model.id);
      expect(measured, `the table does not cover preset model ${model.id}`).toBeGreaterThan(0);
      expect(model.contextWindow, `preset window drifted for ${model.id}`).toBe(measured!);
    }
  });

  it('never seeds a window ABOVE the one the gateway reports', () => {
    // The direction that matters. An under-stated seed only compacts early and
    // is replaced by the hourly refresh; an over-stated one is the original bug.
    const largest = Math.max(...Object.values(NESTOR_GATEWAY_MODEL_WINDOWS));
    for (const model of NESSY_GATEWAY_MODELS) {
      expect(model.contextWindow).toBeLessThanOrEqual(largest);
    }
    expect(NESSY_GATEWAY_CONTEXT_WINDOW).toBeLessThanOrEqual(largest);
  });

  it('exports the default model\'s window under the legacy constant name', () => {
    // `ApiKeyInput.tsx` and two test files read this name; it has to keep
    // meaning "the window of the model the card selects by default".
    expect(NESSY_GATEWAY_CONTEXT_WINDOW).toBe(nestorGatewayModelWindow(NESSY_GATEWAY_MODEL_IDS[0])!);
  });
});

/**
 * DA1.28 — the same lockstep argument, applied to the card's base URL.
 *
 * It was the FOURTH hand-written copy of a URL three modules derive, and it
 * agreed with them by coincidence. The renderer now imports the derivation, so
 * the identity below is what the module MEANS rather than a coincidence worth
 * asserting — and the literal beside it is the half with teeth.
 */
describe('the one-click card base URL', () => {
  it('IS the shared derivation, not a copy of it', () => {
    // Identity, for the same reason the table above is asserted with `toBe`: a
    // copy can drift and identity cannot.
    expect(NESSY_GATEWAY_BASE_URL).toBe(NESTOR_GATEWAY_CHAT_BASE_URL);
  });

  it('still spells the URL every shipped card was created with', () => {
    // The teeth. Now that the renderer reads a DERIVED value, a change to
    // `NESTOR_CLI_BASE_PREFIX` would move the base URL of every new card
    // silently — and `isNessyGatewayConnection` matches a stored connection's
    // `baseUrl` WHOLE, so every card a user already has would stop being
    // recognised as a gateway one: no `Nestor-Token`, the Edit form unlocked on
    // a corporate connection, the credential predicate answering false. A
    // literal here is not duplication; it is the migration alarm.
    expect(NESSY_GATEWAY_BASE_URL).toBe(
      'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
    );
  });

  it('is accepted by the predicate the Edit form and the transport share', () => {
    // DA1.31 closed the triangle without a second import. `isNessyGatewayBaseUrl`
    // IS the driver's own (`agent/backend/internal/drivers/upstream-target.ts`),
    // which compares against a constant derived from the ADAPTER's
    // NESTOR_CHAT_URL — a different derivation from the one the constant above
    // comes from. So this one line asserts that the two derivations still agree,
    // using only names this renderer module already exports.
    //
    // (It is also pinned at home, in
    // `packages/shared/src/auth/__tests__/nestor.test.ts`.
    // Restating it here is cheap now that production imports the driver anyway,
    // and this is the assertion that fails in the RENDERER if they part.)
    expect(isNessyGatewayBaseUrl(NESSY_GATEWAY_BASE_URL)).toBe(true);
    // The negative arm, so the case cannot pass on a predicate that says yes to
    // everything.
    expect(isNessyGatewayBaseUrl(`${NESSY_GATEWAY_BASE_URL}/personal`)).toBe(false);
  });
});
