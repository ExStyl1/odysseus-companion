import { describe, expect, it } from 'bun:test';
import { minimumReserveTokens, resolvePiAutoCompactionSettings } from './auto-compaction-settings.ts';

// 2026-08-08: the baseline reserve is no longer Pi 0.80.3's 16 384. It is now
// `minimumReserveTokens()` — the floor that keeps the headroom larger than ONE
// permitted MCP tool result (25 000 by contract), because the threshold check
// runs AFTER an assistant message and the reserve is all the room the next turn
// has. These expectations moved with that decision; they were not loosened, and
// `auto-compaction-reserve.test.ts` pins the relationship that motivates it.
const RESERVE = minimumReserveTokens({});

describe('resolvePiAutoCompactionSettings', () => {
  it('uses the one-turn reserve floor when no threshold override narrows it', () => {
    expect(resolvePiAutoCompactionSettings(200_000, { enabled: true }, {})).toEqual({
      enabled: true,
      reserveTokens: RESERVE,
      thresholdTokens: 200_000 - RESERVE,
    });
  });

  it('lowers by percentage and ignores a percentage above the floor', () => {
    expect(resolvePiAutoCompactionSettings(200_000, {
      enabled: true,
      thresholdPercent: 50,
    }, {})).toMatchObject({ reserveTokens: 100_000, thresholdTokens: 100_000 });
    // 100% asks for no narrowing at all, so the floor still governs — a
    // percentage may only compact EARLIER, never later than the one-turn reserve.
    expect(resolvePiAutoCompactionSettings(200_000, {
      enabled: true,
      thresholdPercent: 100,
    }, {})).toMatchObject({ reserveTokens: RESERVE, thresholdTokens: 200_000 - RESERVE });
  });

  it('treats the window override as capacity capped at the real model window', () => {
    // A narrower configured window shrinks capacity, and the reserve is still
    // measured against the REAL model window, so it grows by the difference.
    //
    // Explicit numbers, not a re-derivation of the formula: capacity 100 000 is
    // just wide enough to carry the one-turn floor (33 192) uncapped, so the
    // threshold sits at 66 808 — and measured against the real 200 000 window
    // that same threshold reads back as a 133 192 reserve.
    expect(resolvePiAutoCompactionSettings(200_000, {
      enabled: true,
      contextWindow: 100_000,
    }, {})).toMatchObject({
      reserveTokens: 133_192,
      thresholdTokens: 66_808,
    });
    // A configured window WIDER than the model cannot raise capacity above it.
    expect(resolvePiAutoCompactionSettings(200_000, {
      enabled: true,
      contextWindow: 300_000,
    }, {})).toMatchObject({ reserveTokens: RESERVE, thresholdTokens: 200_000 - RESERVE });
  });
});
