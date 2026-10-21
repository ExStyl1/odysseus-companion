/**
 * The compaction threshold must leave room for one more turn.
 *
 * Investigated 2026-08-08. Two things the filed premise got wrong, both recorded
 * here because the wrong fix would have been shipped otherwise:
 *
 * 1. The 419k live probe that motivated this did NOT go through a Pi session —
 *    it was a raw HTTP rate-limit probe with the real JWT, so auto-compaction was
 *    never in that path. And a single over-window message cannot be compacted
 *    away in any case: compaction summarises prior history, and there was none.
 * 2. Estimator drift is not the mechanism. `shouldCompact` compares
 *    `calculateContextTokens(assistantMessage.usage)` — the PROVIDER's own
 *    reported count. A local estimate is used only when a response carries no
 *    usage at all (an error reply).
 *
 * The real exposure is arithmetic: the check runs AFTER an assistant message, so
 * the reserve is the entire headroom for everything the next turn adds — and the
 * SDK's 16 384 default is smaller than the 25 000 our own contract permits for a
 * SINGLE MCP tool result. Two numbers set independently, never reconciled.
 */
import { describe, expect, it } from 'bun:test';
import { DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-coding-agent';
import { mcpOutputTokenLimit } from '../../shared/src/config/mcp-output-settings.ts';
import { minimumReserveTokens, resolvePiAutoCompactionSettings } from './auto-compaction-settings.ts';

const GATEWAY_WINDOW = 262_144;
const ENABLED = { enabled: true } as const;

describe('auto-compaction reserve covers one turn', () => {
  it('leaves more headroom than a single permitted MCP tool result', () => {
    // The relationship is the invariant, not the number: raising the tool-result
    // cap must raise the reserve with it, so this stays true after either moves.
    expect(minimumReserveTokens({})).toBeGreaterThan(mcpOutputTokenLimit({}));
  });

  it('is what the SDK default was NOT — that is the defect being fixed', () => {
    expect(DEFAULT_COMPACTION_SETTINGS.reserveTokens).toBeLessThan(mcpOutputTokenLimit({}));
    expect(minimumReserveTokens({})).toBeGreaterThan(DEFAULT_COMPACTION_SETTINGS.reserveTokens);
  });

  it('fires before the gateway window with that headroom intact', () => {
    const resolved = resolvePiAutoCompactionSettings(GATEWAY_WINDOW, ENABLED, {});

    expect(resolved.enabled).toBe(true);
    expect(resolved.thresholdTokens).toBeDefined();
    // A turn that starts at the threshold and adds one maximal tool result must
    // still land inside the window.
    expect(resolved.thresholdTokens! + mcpOutputTokenLimit({})).toBeLessThan(GATEWAY_WINDOW);
    expect(resolved.reserveTokens).toBe(GATEWAY_WINDOW - resolved.thresholdTokens!);
  });

  it('tracks an operator who raises the tool-result cap', () => {
    const raised = { NESSY_MCP_OUTPUT_TOKENS: '60000' };

    expect(minimumReserveTokens(raised)).toBeGreaterThan(60_000);

    const resolved = resolvePiAutoCompactionSettings(GATEWAY_WINDOW, ENABLED, raised);
    expect(resolved.thresholdTokens! + 60_000).toBeLessThan(GATEWAY_WINDOW);
  });

  it('still honours an explicit percentage that asks to compact even earlier', () => {
    const resolved = resolvePiAutoCompactionSettings(
      GATEWAY_WINDOW, { enabled: true, thresholdPercent: 50 }, {},
    );

    expect(resolved.thresholdTokens).toBe(Math.floor(GATEWAY_WINDOW * 0.5));
  });

  it('keeps the headroom intact on every window this app actually ships', () => {
    // The share cap that keeps the floor proportionate on tiny windows can
    // silently swallow it on real ones. A quarter did exactly that: at 100 000 it
    // produced `threshold + tool result == window`, inert but indistinguishable
    // from applied. This is that boundary, pinned.
    for (const window of [100_000, 128_000, 200_000, GATEWAY_WINDOW]) {
      const resolved = resolvePiAutoCompactionSettings(window, ENABLED, {});

      expect(window - resolved.thresholdTokens!).toBe(minimumReserveTokens({}));
      expect(resolved.thresholdTokens! + mcpOutputTokenLimit({})).toBeLessThan(window);
    }
  });

  it('degrades proportionately instead of crippling a small-window model', () => {
    // 33 192 of a 50 000 window is two thirds, which would compact almost
    // immediately — trading an overflow that might not happen for a context loss
    // that certainly would.
    const resolved = resolvePiAutoCompactionSettings(50_000, ENABLED, {});
    const reserve = 50_000 - resolved.thresholdTokens!;

    expect(reserve).toBeLessThan(minimumReserveTokens({}));
    expect(reserve).toBeGreaterThanOrEqual(DEFAULT_COMPACTION_SETTINGS.reserveTokens);
  });

  it('never lowers the reserve below what it was before this fix existed', () => {
    // The share cap alone does exactly that under ~49 152, so a change meant to
    // RAISE the floor would have lowered it on small models — later compaction
    // than the SDK default gave. Found by breaking the share in a control run.
    // A window narrower than the default reserve cannot hold it — the threshold
    // floors at zero and the whole window is the reserve. That is the SDK's own
    // pre-existing arithmetic, not a regression, so the bound is the window there.
    for (const window of [16_000, 32_000, 49_152, 50_000, 100_000, GATEWAY_WINDOW]) {
      const resolved = resolvePiAutoCompactionSettings(window, ENABLED, {});

      expect(window - resolved.thresholdTokens!).toBeGreaterThanOrEqual(
        Math.min(DEFAULT_COMPACTION_SETTINGS.reserveTokens, window),
      );
    }
  });

  it('leaves a model with no known window alone rather than inventing one', () => {
    expect(resolvePiAutoCompactionSettings(undefined, ENABLED, {})).toEqual({ enabled: true });
  });
});
