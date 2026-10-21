import { describe, expect, it } from 'bun:test';
import { NESSY_GATEWAY_CHAT_BASE_URL } from '../../agent/backend/internal/drivers/upstream-target.ts';
import {
  MIN_PLAUSIBLE_CONTEXT_WINDOW,
  NESTOR_CLI_BASE_PREFIX,
  NESTOR_GATEWAY_CHAT_BASE_URL,
  NESTOR_GATEWAY_MODELS_URL,
  isNestorCliBaseUrl,
  isNestorGatewayCredentialUrl,
  NESTOR_GATEWAY_MODEL_WINDOWS,
  NESTOR_MODEL_SNAPSHOT_META,
  NESTOR_MODEL_SNAPSHOT_WINDOWS,
  nestorGatewayModelWindow,
  sanitizeReportedContextWindow,
} from '../nestor.ts';

describe('sanitizeReportedContextWindow', () => {
  it('accepts a real reported window', () => {
    expect(sanitizeReportedContextWindow(262_000)).toBe(262_000);
    expect(sanitizeReportedContextWindow(MIN_PLAUSIBLE_CONTEXT_WINDOW)).toBe(MIN_PLAUSIBLE_CONTEXT_WINDOW);
    expect(sanitizeReportedContextWindow(131_072.9)).toBe(131_072);
  });

  it('rejects the `1` placeholder rather than treating it as a one-token window', () => {
    // The sentinel that makes this function exist. llm-proxy reports
    // `context_length: 1` for 63 of its 387 rows (measured 2026-08-28) and the Pi
    // SDK's vendored registry carries 207 entries at `contextWindow: 1` (as
    // recorded 2026-08-28), both meaning "not filled in". The counts are dated
    // because the catalogue moves weekly — the earlier `68 of 383` here was a
    // 2026-08-14 reading that had already drifted.
    // Consuming either literally caps a session at a window the model does not
    // have — a WORSE failure than the missing window this whole path fixes,
    // because it is silent and it fires on every uncurated model.
    expect(sanitizeReportedContextWindow(1)).toBeUndefined();
    expect(sanitizeReportedContextWindow(0)).toBeUndefined();
    expect(sanitizeReportedContextWindow(MIN_PLAUSIBLE_CONTEXT_WINDOW - 1)).toBeUndefined();
  });

  it('rejects everything that is not a finite number', () => {
    expect(sanitizeReportedContextWindow(-262_000)).toBeUndefined();
    expect(sanitizeReportedContextWindow(Number.NaN)).toBeUndefined();
    expect(sanitizeReportedContextWindow(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(sanitizeReportedContextWindow('262000')).toBeUndefined();
    expect(sanitizeReportedContextWindow(null)).toBeUndefined();
    expect(sanitizeReportedContextWindow(undefined)).toBeUndefined();
  });
});

describe('NESTOR_GATEWAY_MODEL_WINDOWS', () => {
  it('resolves a disagreement between the hand-confirmed value and the snapshot downward', () => {
    // The hand-written table said 262144 (`max_model_len`); the gateway's own
    // `/cli/models` reports 262000. Nothing in this process can decide which
    // quantity is which, and the two failure directions are not symmetric — an
    // over-stated window runs the session past the real limit before anything
    // compacts, an under-stated one merely compacts early. So: the smaller.
    //
    // The id this case used to name was `tgpt/qwen35-397b-a17b-fp8`; the gateway
    // retired it (P6.1080) and the 2026-09-11 harvest no longer carries it, so
    // the disagreement is demonstrated on the id that still has BOTH halves.
    expect(NESTOR_MODEL_SNAPSHOT_WINDOWS['tgpt/qwen36-35b-a3b-fp8']).toBe(262_000);
    expect(NESTOR_GATEWAY_MODEL_WINDOWS['tgpt/qwen36-35b-a3b-fp8']).toBe(262_000);
    expect(nestorGatewayModelWindow('tgpt/qwen36-35b-a3b-fp8')).toBe(262_000);
  });

  it('covers the id the gateway currently reports as its default — the POSITIVE half of P6.1080', () => {
    // Measured 2026-09-11: `GET /api/v1/cli/models` returns two rows, and the
    // one carrying `is_default: true` (alias `coder`) is this one, at a reported
    // 524000. Before P6.1080 it was in NEITHER table, so the model every gateway
    // connection had already been migrated onto had no fallback window at all:
    // on a failed refresh `claude-agent.ts` would get `undefined`, leave
    // `CLAUDE_CODE_AUTO_COMPACT_WINDOW` unset and never compact.
    expect(nestorGatewayModelWindow('tgpt/deepseek-v4-flash-0731')).toBe(524_000);
  });

  it('keeps a RETIRED id resolvable, and never upward — the NEGATIVE half of P6.1080', () => {
    // The gateway answers 404 for this id now, so the snapshot correctly dropped
    // it. The merge keeps it anyway, because tier two is consulted exactly when
    // the live fetch failed — which is also the only state in which a connection
    // still carries it as `defaultModel`.
    expect(nestorGatewayModelWindow('tgpt/qwen35-397b-a17b-fp8')).toBe(262_000);
    // And at the gateway's own last SERVING limit, not the architectural 262144
    // the curated table holds: with the snapshot half gone the merge would
    // otherwise resolve this id 144 tokens UPWARD, the one direction
    // `mergeSmallerWindow` exists to refuse.
    expect(NESTOR_MODEL_SNAPSHOT_WINDOWS['tgpt/qwen35-397b-a17b-fp8']).toBeUndefined();
    expect(NESTOR_GATEWAY_MODEL_WINDOWS['tgpt/qwen35-397b-a17b-fp8']).toBeLessThan(262_144);
  });

  it('never resolves above either source it was merged from', () => {
    for (const [id, window] of Object.entries(NESTOR_GATEWAY_MODEL_WINDOWS)) {
      const snapshot = NESTOR_MODEL_SNAPSHOT_WINDOWS[id];
      if (snapshot !== undefined) {
        expect(window, `${id} resolved above its snapshot value`).toBeLessThanOrEqual(snapshot);
      }
      expect(window, `${id} resolved to a placeholder`).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_CONTEXT_WINDOW);
    }
  });

  it('covers every snapshot id — a harvested id the merge drops is a fallback nobody can reach', () => {
    for (const id of Object.keys(NESTOR_MODEL_SNAPSHOT_WINDOWS)) {
      expect(NESTOR_GATEWAY_MODEL_WINDOWS[id], `snapshot id ${id} missing from the merged table`)
        .toBeDefined();
    }
  });

  it('answers undefined for an unknown id rather than inventing one', () => {
    expect(nestorGatewayModelWindow('tgpt/never-heard-of-it')).toBeUndefined();
    expect(nestorGatewayModelWindow(undefined)).toBeUndefined();
    expect(nestorGatewayModelWindow('')).toBeUndefined();
  });
});

describe('NESTOR_MODEL_SNAPSHOT_META', () => {
  it('carries its own provenance, because no prose elsewhere is evidence about this file', () => {
    expect(NESTOR_MODEL_SNAPSHOT_META.snapshot).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(NESTOR_MODEL_SNAPSHOT_META.source).toContain('/api/v1/cli/models');
    // Widened off the frozen literal types on purpose: `Object.freeze` on an
    // object literal keeps `rows`/`windows` as literal types, which narrows
    // `toBe`'s parameter to that one number and rejects any computed comparand.
    const windows: number = NESTOR_MODEL_SNAPSHOT_META.windows;
    const rows: number = NESTOR_MODEL_SNAPSHOT_META.rows;
    expect(windows).toBe(Object.keys(NESTOR_MODEL_SNAPSHOT_WINDOWS).length);
    expect(windows).toBeLessThanOrEqual(rows);
  });

  it('records placeholder rejections rather than silently shipping them', () => {
    // A row the harvest rejected must be absent from the table, not zeroed into
    // it — the count and the table have to agree or the meta is decoration.
    const rows: number = NESTOR_MODEL_SNAPSHOT_META.rows;
    const rejected: number = NESTOR_MODEL_SNAPSHOT_META.rejectedAsPlaceholder;
    const windows: number = NESTOR_MODEL_SNAPSHOT_META.windows;
    expect(rows - rejected).toBeGreaterThanOrEqual(windows);
  });
});

/**
 * DA1.10 — the credential boundary, which is NARROWER than the CLI prefix.
 *
 * The prefix predicate keeps its ten non-credential readers; these cases are
 * about the two that decide whether the corporate JWT is attached.
 */
describe('isNestorGatewayCredentialUrl', () => {
  it('accepts the two named endpoints and everything under the chat base', () => {
    expect(isNestorGatewayCredentialUrl(NESTOR_GATEWAY_CHAT_BASE_URL)).toBe(true);
    expect(isNestorGatewayCredentialUrl(`${NESTOR_GATEWAY_CHAT_BASE_URL}/`)).toBe(true);
    expect(isNestorGatewayCredentialUrl(`${NESTOR_GATEWAY_CHAT_BASE_URL}/chat/completions`)).toBe(true);
    // The SDK's own catalogue call under the chat base, and the CLI models URL.
    expect(isNestorGatewayCredentialUrl(`${NESTOR_GATEWAY_CHAT_BASE_URL}/models`)).toBe(true);
    expect(isNestorGatewayCredentialUrl(NESTOR_GATEWAY_MODELS_URL)).toBe(true);
    // A query string names a request, not an endpoint.
    expect(isNestorGatewayCredentialUrl(`${NESTOR_GATEWAY_CHAT_BASE_URL}/chat/completions?stream=1`)).toBe(true);
  });

  it('REFUSES an unknown path under the CLI prefix — the whole point of the row', () => {
    const unknown = `${NESTOR_CLI_BASE_PREFIX}personal/x`;
    // The wide predicate still says yes, which is what the nine other sites read.
    expect(isNestorCliBaseUrl(unknown)).toBe(true);
    // The credential predicate says no. If these two ever agree, the narrowing
    // has been undone.
    expect(isNestorGatewayCredentialUrl(unknown)).toBe(false);
    expect(isNestorGatewayCredentialUrl(`${NESTOR_CLI_BASE_PREFIX}`)).toBe(false);
    // A sibling path whose name merely STARTS with the chat base's last segment.
    expect(isNestorGatewayCredentialUrl(`${NESTOR_GATEWAY_CHAT_BASE_URL}extra/chat`)).toBe(false);
  });

  it('parses rather than substring-matches, so traversal and case cannot smuggle a path in', () => {
    // Resolves to `…/api/v1/cli/personal/x` before the comparison.
    expect(isNestorGatewayCredentialUrl(`${NESTOR_GATEWAY_CHAT_BASE_URL}/../../personal/x`)).toBe(false);
    // Host case is not part of the identity; path case is.
    expect(isNestorGatewayCredentialUrl(
      NESTOR_GATEWAY_MODELS_URL.replace('code-completion-nestor', 'CODE-COMPLETION-NESTOR'),
    )).toBe(true);
    expect(isNestorGatewayCredentialUrl(NESTOR_GATEWAY_MODELS_URL.replace('/models', '/MODELS'))).toBe(false);
    // A look-alike host, and a look-alike that only embeds the real one.
    expect(isNestorGatewayCredentialUrl('https://evil.example/api/v1/cli/openai-like/v1/chat/completions')).toBe(false);
    expect(isNestorGatewayCredentialUrl(
      `https://evil.example/?x=${encodeURIComponent(NESTOR_GATEWAY_CHAT_BASE_URL)}`,
    )).toBe(false);
    // A different port is a different endpoint.
    expect(isNestorGatewayCredentialUrl(
      NESTOR_GATEWAY_MODELS_URL.replace('.tcsbank.ru/', '.tcsbank.ru:8443/'),
    )).toBe(false);
  });

  it('fails closed on anything that is not a URL', () => {
    expect(isNestorGatewayCredentialUrl('not a url')).toBe(false);
    expect(isNestorGatewayCredentialUrl('')).toBe(false);
    expect(isNestorGatewayCredentialUrl('   ')).toBe(false);
    expect(isNestorGatewayCredentialUrl(undefined)).toBe(false);
    expect(isNestorGatewayCredentialUrl(null)).toBe(false);
  });

  it('agrees with the adapter-side derivation of the same URL', () => {
    // Two derivations of one string, pinned equal rather than trusted: this
    // module builds it from `NESTOR_CLI_BASE_PREFIX` because it is a member of
    // the interceptor's staged source closure and cannot import the adapter
    // package; `upstream-target.ts` builds it from the adapter's
    // `NESTOR_CHAT_URL`, which is what the transport actually posts to. If they
    // ever part, classification and transport disagree about which URL is the
    // gateway — the failure the whole-URL boundary exists to prevent.
    expect(NESTOR_GATEWAY_CHAT_BASE_URL).toBe(NESSY_GATEWAY_CHAT_BASE_URL);
  });
});
