/**
 * Tests for large-response.ts.
 *
 * Covers:
 * - tokenLimitFor: model-aware per-result summarization threshold
 * - guardLargeResult: end-to-end with and without contextWindow
 * - handleLargeResponse: same threshold semantics through the lower-level entry
 * - guardLargeResult: the secret scan runs before anything reaches disk (P6.777)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  TOKEN_LIMIT,
  tokenLimitFor,
  guardLargeResult,
  handleLargeResponse,
  estimateTokens,
  estimateTokensDensityAware,
} from '../large-response.ts';

// ============================================================
// tokenLimitFor — pure function, threshold scaling
// ============================================================

describe('tokenLimitFor', () => {
  test('falls back to default when contextWindow is undefined', () => {
    expect(tokenLimitFor(undefined)).toBe(TOKEN_LIMIT);
    expect(tokenLimitFor(undefined)).toBe(12_000);
  });

  test('falls back to default for zero / negative contextWindow', () => {
    expect(tokenLimitFor(0)).toBe(TOKEN_LIMIT);
    expect(tokenLimitFor(-1)).toBe(TOKEN_LIMIT);
  });

  test('caps at the existing default for large-window models', () => {
    expect(tokenLimitFor(200_000)).toBe(TOKEN_LIMIT);
    expect(tokenLimitFor(1_000_000)).toBe(TOKEN_LIMIT);
  });

  test('scales linearly in the middle range', () => {
    expect(tokenLimitFor(64_000)).toBe(6_400);
    // 128_000 * 0.10 = 12_800 → capped at TOKEN_LIMIT (12_000).
    expect(tokenLimitFor(128_000)).toBe(12_000);
    expect(tokenLimitFor(100_000)).toBe(10_000);
  });

  test('floors at 2_000 for small-window models', () => {
    // 8_000 * 0.10 = 800 → floor to 2_000
    expect(tokenLimitFor(8_000)).toBe(2_000);
    expect(tokenLimitFor(16_000)).toBe(2_000);
  });

  test('floor boundary: contextWindow * 0.10 == floor', () => {
    // 20_000 * 0.10 = 2_000 → exact floor
    expect(tokenLimitFor(20_000)).toBe(2_000);
  });
});

// ============================================================
// guardLargeResult — integration with model-aware threshold
// ============================================================

describe('guardLargeResult contextWindow handling', () => {
  let sessionPath: string;
  // 8_000-token natural-language text (~32_000 chars at ~4 chars/token).
  // Uses real word boundaries so estimateTokensDensityAware does not flag it
  // as base64-dense — the heuristic correctly treats single-char repeats and
  // long unbroken alphanumeric runs as token-dense.
  const eightKTokenText = ('lorem ipsum dolor sit amet ').repeat(1185).slice(0, 32_000);
  // Trivial deterministic summarizer so tests don't reach an LLM.
  const fakeSummarize = async (_prompt: string) => 'mocked summary';

  beforeEach(() => {
    sessionPath = mkdtempSync(join(tmpdir(), 'large-response-'));
  });

  afterEach(() => {
    rmSync(sessionPath, { recursive: true, force: true });
  });

  test('triggers summarization on a 64k-window model (8k > 6.4k)', async () => {
    expect(estimateTokens(eightKTokenText)).toBeGreaterThanOrEqual(7_999);
    expect(estimateTokens(eightKTokenText)).toBeLessThanOrEqual(8_000);
    const result = await guardLargeResult(eightKTokenText, {
      sessionPath,
      toolName: 'test_tool',
      summarize: fakeSummarize,
      contextWindow: 64_000,
    });
    expect(result).not.toBeNull();
    expect(result).toContain('mocked summary');
    // File written to long_responses/.
    expect(existsSync(join(sessionPath, 'long_responses'))).toBe(true);
  });

  test('passes through a 200k-window model (8k < 12k)', async () => {
    const result = await guardLargeResult(eightKTokenText, {
      sessionPath,
      toolName: 'test_tool',
      summarize: fakeSummarize,
      contextWindow: 200_000,
    });
    expect(result).toBeNull();
  });

  test('preserves existing behavior when contextWindow is undefined', async () => {
    // No contextWindow → fixed 12k threshold → 8k passes through.
    const result = await guardLargeResult(eightKTokenText, {
      sessionPath,
      toolName: 'test_tool',
      summarize: fakeSummarize,
    });
    expect(result).toBeNull();
  });

  test('floor still triggers on tiny-window models', async () => {
    // 16k window → 2k threshold → 8k triggers.
    const result = await guardLargeResult(eightKTokenText, {
      sessionPath,
      toolName: 'test_tool',
      summarize: fakeSummarize,
      contextWindow: 16_000,
    });
    expect(result).not.toBeNull();
    expect(result).toContain('mocked summary');
  });

  // An explicit tokenLimit REPLACES the tokenLimitFor(contextWindow)
  // computation — the MCP guard sites pass the documented 25,000-token MCP
  // output limit (`mcp.md:1040`) at a threshold TOKEN_LIMIT alone would
  // persist, and passing a context window must not quietly undo it.
  test('an explicit tokenLimit keeps a ~20k-token result inline that the default persists', async () => {
    // ~20k tokens of natural-language text (~80_000 chars at ~4 chars/token).
    const twentyKTokenText = ('lorem ipsum dolor sit amet ').repeat(2965).slice(0, 80_000);
    expect(estimateTokensDensityAware(twentyKTokenText)).toBeGreaterThan(TOKEN_LIMIT);
    expect(estimateTokensDensityAware(twentyKTokenText)).toBeLessThan(25_000);

    const raised = await guardLargeResult(twentyKTokenText, {
      sessionPath,
      toolName: 'mcp__gh__big',
      summarize: fakeSummarize,
      tokenLimit: 25_000,
      // A context window is present and must NOT lower the explicit limit —
      // tokenLimitFor() would otherwise cap this at 12_000 and persist.
      contextWindow: 200_000,
    });
    expect(raised).toBeNull();
    expect(existsSync(join(sessionPath, 'long_responses'))).toBe(false);

    const defaulted = await guardLargeResult(twentyKTokenText, {
      sessionPath,
      toolName: 'mcp__gh__big',
      summarize: fakeSummarize,
    });
    expect(defaulted).not.toBeNull();
    expect(defaulted).toContain('mocked summary');
    expect(existsSync(join(sessionPath, 'long_responses'))).toBe(true);
  });
});

// ============================================================
// handleLargeResponse — same threshold semantics, lower-level entry
// ============================================================

describe('handleLargeResponse contextWindow handling', () => {
  let sessionPath: string;
  const eightKTokenText = ('lorem ipsum dolor sit amet ').repeat(1185).slice(0, 32_000);
  const fakeSummarize = async (_prompt: string) => 'mocked summary';

  beforeEach(() => {
    sessionPath = mkdtempSync(join(tmpdir(), 'handle-large-response-'));
  });

  afterEach(() => {
    rmSync(sessionPath, { recursive: true, force: true });
  });

  test('returns null below the model-aware threshold (200k window)', async () => {
    const result = await handleLargeResponse({
      text: eightKTokenText,
      sessionPath,
      context: { toolName: 'test_tool' },
      summarize: fakeSummarize,
      contextWindow: 200_000,
    });
    expect(result).toBeNull();
  });

  test('returns a summarized result above the threshold (64k window)', async () => {
    const result = await handleLargeResponse({
      text: eightKTokenText,
      sessionPath,
      context: { toolName: 'test_tool' },
      summarize: fakeSummarize,
      contextWindow: 64_000,
    });
    expect(result).not.toBeNull();
    expect(result?.wasSummarized).toBe(true);
    expect(result?.message).toContain('mocked summary');
    expect(existsSync(result!.filePath)).toBe(true);
    const written = readFileSync(result!.filePath, 'utf-8');
    expect(written).toBe(eightKTokenText);
  });

  test('contextWindow undefined matches pre-change behavior at 8k input', async () => {
    // 8k < TOKEN_LIMIT (12k) → null, identical to pre-change behavior.
    const result = await handleLargeResponse({
      text: eightKTokenText,
      sessionPath,
      context: { toolName: 'test_tool' },
      summarize: fakeSummarize,
    });
    expect(result).toBeNull();
  });
});

// ============================================================
// estimateTokensDensityAware — base64-density correction
// ============================================================

describe('estimateTokensDensityAware', () => {
  test('matches estimateTokens for short inputs', () => {
    const text = 'a'.repeat(10_000);
    expect(estimateTokensDensityAware(text)).toBe(estimateTokens(text));
  });

  test('matches estimateTokens for long natural-language inputs', () => {
    // English-ish text with spaces, punctuation, line breaks — no long
    // unbroken base64 runs, so the heuristic should not fire.
    const sentence = 'The quick brown fox jumps over the lazy dog. ';
    const text = sentence.repeat(800); // ~36KB of normal prose
    expect(estimateTokensDensityAware(text)).toBe(estimateTokens(text));
  });

  test('escalates estimate for base64-heavy text over 20KB', () => {
    // 30KB of unbroken base64 chars — should trip the density correction.
    const base64 = 'A'.repeat(30_000);
    const dense = estimateTokensDensityAware(base64);
    expect(dense).toBeGreaterThan(estimateTokens(base64));
    // 30_000 / 1.5 = 20_000.
    expect(dense).toBe(20_000);
  });

  test('escalates estimate for RFC 2045 MIME base64 (76-char line wrapping)', () => {
    // MIME wraps base64 at 76 chars with \r\n separators. Each line is one
    // 76-char run between separators — well above the 60-char minimum, so
    // density correction must fire on bodies that are mostly such lines.
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) lines.push('X'.repeat(76)); // ~30KB body
    const text = lines.join('\r\n');
    const dense = estimateTokensDensityAware(text);
    expect(dense).toBeGreaterThan(estimateTokens(text));
  });

  test('escalates estimate for PEM-style base64 (64-char line wrapping)', () => {
    // PEM wraps at 64 chars — also above the 60-char minimum.
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) lines.push('X'.repeat(64)); // ~32KB body
    const text = lines.join('\n');
    const dense = estimateTokensDensityAware(text);
    expect(dense).toBeGreaterThan(estimateTokens(text));
  });

  test('does not escalate when base64-like runs are sparse', () => {
    // Sparse short identifiers in mostly natural text — no individual run
    // long enough to count.
    const text =
      ('Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' +
        'See https://example.com/abc123 for details. ').repeat(400);
    expect(estimateTokensDensityAware(text)).toBe(estimateTokens(text));
  });
});

// ============================================================
// Regression: 56KB base64-heavy Read result must spill
// ============================================================

describe('guardLargeResult: base64-heavy regression (poisoned-session repro)', () => {
  let sessionPath: string;
  beforeEach(() => {
    sessionPath = mkdtempSync(join(tmpdir(), 'large-response-base64-'));
  });
  afterEach(() => {
    rmSync(sessionPath, { recursive: true, force: true });
  });

  test('56KB MIME-style base64 body triggers spill on a 200k-window model', async () => {
    // Synthesize a multipart/mixed payload similar to the one that poisoned
    // session 260508-wise-cobble: a few headers + chunked base64 lines.
    const headers =
      'From: sender@example.com\r\n' +
      'To: recipient@example.com\r\n' +
      'Subject: regression fixture\r\n' +
      'MIME-Version: 1.0\r\n' +
      'Content-Type: multipart/mixed; boundary="bdry"\r\n' +
      '\r\n--bdry\r\nContent-Type: application/pdf\r\n' +
      'Content-Transfer-Encoding: base64\r\n\r\n';
    const lines: string[] = [];
    // 700 lines of 76-char base64 ≈ 53KB body, +headers → ~54KB total.
    for (let i = 0; i < 700; i++) {
      lines.push('A'.repeat(76));
    }
    const body = lines.join('\r\n');
    const text = headers + body + '\r\n--bdry--\r\n';
    expect(text.length).toBeGreaterThan(50_000);

    const result = await guardLargeResult(text, {
      sessionPath,
      toolName: 'Read',
      summarize: async () => 'mocked summary',
      contextWindow: 200_000,
    });
    // Must not pass through: this is the exact case that poisoned the session.
    expect(result).not.toBeNull();
  });

  test('reviewer regression: 600 lines × 76-char MIME body must spill', async () => {
    // The exact case the PR review called out: a payload that landed at
    // 600 × 76 chars ≈ 46.9KB of pure MIME-wrapped base64. Pre-fix this
    // produced 0 detected dense chars (run minimum was 100, MIME lines are
    // 76), estimated ~11,719 tokens via chars/4, fell under the 12k
    // threshold, and slipped through into conversation history.
    const lines: string[] = [];
    for (let i = 0; i < 600; i++) {
      lines.push('A'.repeat(76));
    }
    const text = lines.join('\r\n');
    expect(text.length).toBeGreaterThan(45_000);
    expect(text.length).toBeLessThan(50_000);

    // Plain 4-chars/token estimate falls below the post-fix 12k threshold —
    // so without density-aware correction this would still pass through.
    expect(estimateTokens(text)).toBeLessThan(12_000);
    // But density correction must fire and push the estimate over.
    expect(estimateTokensDensityAware(text)).toBeGreaterThanOrEqual(12_000);

    const result = await guardLargeResult(text, {
      sessionPath,
      toolName: 'Read',
      summarize: async () => 'mocked summary',
      contextWindow: 200_000,
    });
    expect(result).not.toBeNull();
  });
});


// ============================================================
// guardLargeResult — the secret scan runs BEFORE anything is written (P6.777)
// ============================================================

/**
 * These cases assert on the ARTIFACT'S OWN BYTES, not on the returned message,
 * because that is the only assertion that can see the defect the row named: the
 * message is the `Full data saved to:` notice either way, and the event adapters
 * scrub that notice, which never held the credential.
 *
 * The token is a synthesised SHAPE and never a real credential — the
 * `gitlab-pat` rule is a prefix-plus-charset matcher, so a run of `A`s satisfies
 * it.
 *
 * One case per shape the five callers pass: a string with an explicit
 * `tokenLimit` (`mcp-pool.ts`, and `LocalToolRuntime.guardResult` for a proxy
 * tool), a Buffer with the default threshold (`sources/api-tools.ts`), and a
 * string with a `contextWindow` (`claude-agent.ts` and the local-tool runtime).
 */
describe('guardLargeResult secret scan', () => {
  let sessionPath: string;
  const syntheticToken = `glpat-${'A'.repeat(24)}`;
  const filler = ('lorem ipsum dolor sit amet ').repeat(1185).slice(0, 32_000);
  const leakyText = `${filler}\ntoken: ${syntheticToken}\n${filler}`;
  const fakeSummarize = async (_prompt: string) => 'mocked summary';

  const artifactNames = (): string[] => {
    const dir = join(sessionPath, 'long_responses');
    return existsSync(dir) ? readdirSync(dir) : [];
  };
  const onlyArtifact = (): string => {
    const names = artifactNames();
    expect(names.length).toBe(1);
    return readFileSync(join(sessionPath, 'long_responses', names[0]!), 'utf-8');
  };

  beforeEach(() => {
    sessionPath = mkdtempSync(join(tmpdir(), 'large-response-secret-'));
  });

  afterEach(() => {
    rmSync(sessionPath, { recursive: true, force: true });
  });

  test('MCP shape (string + tokenLimit): the token is absent from the file on disk', async () => {
    const result = await guardLargeResult(leakyText, {
      sessionPath,
      toolName: 'mcp__server__tool',
      summarize: fakeSummarize,
      tokenLimit: 1_000,
    });
    expect(result).not.toBeNull();
    const saved = onlyArtifact();
    expect(saved).not.toContain(syntheticToken);
    expect(saved).toContain('[REDACTED:gitlab-pat]');
  });

  test('api-tools shape (Buffer, default threshold): the token is absent from the file on disk', async () => {
    const result = await guardLargeResult(Buffer.from(leakyText, 'utf-8'), {
      sessionPath,
      toolName: 'api_example',
      summarize: fakeSummarize,
    });
    expect(result).not.toBeNull();
    const saved = onlyArtifact();
    expect(saved).not.toContain(syntheticToken);
    expect(saved).toContain('[REDACTED:gitlab-pat]');
  });

  test('local-tool / claude shape (string + contextWindow): the token is absent from the file on disk', async () => {
    const result = await guardLargeResult(leakyText, {
      sessionPath,
      toolName: 'Bash',
      summarize: fakeSummarize,
      contextWindow: 16_000,
    });
    expect(result).not.toBeNull();
    const saved = onlyArtifact();
    expect(saved).not.toContain(syntheticToken);
    expect(saved).toContain('[REDACTED:gitlab-pat]');
  });

  test('under the threshold: nothing is written and the caller keeps its own text', async () => {
    const result = await guardLargeResult(`small result with ${syntheticToken}`, {
      sessionPath,
      toolName: 'Bash',
      summarize: fakeSummarize,
    });
    expect(result).toBeNull();
    expect(artifactNames()).toEqual([]);
  });

  test('a clean result is written byte-for-byte and carries no notice', async () => {
    const result = await guardLargeResult(filler, {
      sessionPath,
      toolName: 'Bash',
      summarize: fakeSummarize,
      tokenLimit: 1_000,
    });
    expect(result).not.toBeNull();
    expect(onlyArtifact()).toBe(filler);
    expect(result).not.toContain('[nessy]');
  });

  test('the model is told, count-only, that bytes were removed', async () => {
    const result = await guardLargeResult(leakyText, {
      sessionPath,
      toolName: 'Bash',
      summarize: fakeSummarize,
      tokenLimit: 1_000,
    });
    const message = result ?? '';
    expect(message).toContain('[nessy] 1 credential-shaped value redacted');
    expect(message).toContain('gitlab-pat×1');
    expect(message).not.toContain(syntheticToken);
  });
});
