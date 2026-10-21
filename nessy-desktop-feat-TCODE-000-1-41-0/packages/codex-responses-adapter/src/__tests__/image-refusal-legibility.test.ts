/**
 * P3.127 / P3.138 — the codex half of the legibility pin.
 *
 * THE CONDITION THE 2026-08-28 OWNER RULING DEPENDS ON. *"Carry the modality
 * faithfully, let the ENDPOINT refuse"* replaces our guess about a model's
 * modality with the endpoint's own answer — and that only holds while the
 * endpoint's answer REACHES the user as something they can act on. If a future
 * path folds the gateway's named 400 into a generic failure, the ruling silently
 * becomes the silent-loss defect it replaced.
 *
 * That condition was pinned on `claude-runtime` alone
 * (`shared/src/config/__tests__/model-supports-images.test.ts`, at the
 * `mapClaudeSdkAssistantError` swallow point). Codex's path is a DIFFERENT
 * swallow point and was off-limits to that lane: the gateway has no Responses
 * API, so this loopback adapter IS the codex path, and every codex config we
 * write points at it (`model_provider = "nessy_gateway"`, unconditional in
 * `buildCodexConfigToml`). The gateway's refusal therefore reaches codex only if
 * THIS file passes it through.
 *
 * The refusal, measured live on the Nessy gateway 2026-08-28 (darwin-arm64):
 * `400 Invalid Chat Message Part: Model Does Not Support Image Inputs`, on both
 * served models, both roles, stream and non-stream, `data:` and `https:` URLs,
 * with the identical body minus the image part returning 200.
 *
 * Every case below carries its own positive control, because the defect this
 * guards against is invisible by construction: a swallowed refusal and a
 * delivered one both end the turn.
 */
import { test, expect, describe } from 'bun:test';
import { startAdapter } from '../server.ts';
import { classifyError } from '../errors.ts';

/** The gateway's own words, verbatim. */
const REFUSAL = 'Invalid Chat Message Part: Model Does Not Support Image Inputs';

/** The shape the gateway answers with: an OpenAI-style error envelope, 400. */
const refusalBody = JSON.stringify({
  error: { message: REFUSAL, type: 'invalid_request_error', code: null },
});

const DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** codex's own three-item framing for one attached local image (P3.114). */
const IMAGE_TURN = [
  {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: '<image name=[Image #1] path="/tmp/shot.png">' },
      { type: 'input_image', image_url: DATA_URI, detail: 'high' },
      { type: 'input_text', text: '</image>' },
      { type: 'input_text', text: 'what is in this screenshot?' },
    ],
  },
];

async function postResponses(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('P3.127 · the gateway\'s image refusal stays legible on the codex path', () => {
  for (const stream of [false, true]) {
    test(`a named 400 reaches the caller verbatim (stream=${stream})`, async () => {
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        return new Response(refusalBody, { status: 400, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch;

      const rungs: number[] = [];
      const adapter = await startAdapter({ jwt: 'j', fetchImpl, onRetryRung: r => rungs.push(r) });
      try {
        const res = await postResponses(adapter.port, { model: 'm', input: IMAGE_TURN, stream });

        // (1) The STATUS is the endpoint's own class, not a generic 502. A 502
        //     reads as "the gateway is down" and sends the user to the wrong
        //     diagnosis entirely.
        expect(res.status).toBe(400);

        // (2) The REASON survives, verbatim. This is the whole ruling: the user
        //     must be able to read WHY, not merely that something failed.
        const json = (await res.json()) as { error?: { message?: string; code?: string | null } };
        expect(json.error?.message).toContain(REFUSAL);

        // (3) The upstream status is carried alongside it rather than invented.
        expect(json.error?.code).toBe('400');

        // (4) NOT RETRIED. The tool-parser ladder advances only on the gateway's
        //     flaky `"model is required"` 400; a capability refusal is terminal,
        //     and re-sending an image three times to be refused three times is
        //     latency spent on a foregone answer.
        expect(calls).toBe(1);
        expect(rungs).toEqual([0]);
      } finally {
        await adapter.close();
      }
    });
  }

  // THE POSITIVE CONTROL, on the same rig: the identical request against a
  // gateway that accepts the image returns 200 and no error at all. Without it
  // "the refusal is legible" could be satisfied by a rig that fails everything.
  test('positive control: the same image turn succeeds when the endpoint accepts it', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'a cat' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const adapter = await startAdapter({ jwt: 'j', fetchImpl });
    try {
      const res = await postResponses(adapter.port, { model: 'm', input: IMAGE_TURN, stream: false });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { error?: unknown; output: Array<{ type: string }> };
      expect(json.error).toBeUndefined();
      expect(json.output.some(o => o.type === 'message')).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  // The message is forwarded as a 500-char prefix of the gateway body. A refusal
  // the gateway names at the HEAD of its envelope survives that; pinned so the
  // bound is a known property rather than a surprise, and so shrinking it below
  // a realistic envelope is a test failure rather than a quiet truncation.
  test('the 500-char forward window keeps a head-named refusal intact', async () => {
    const padded = JSON.stringify({
      error: { message: REFUSAL, type: 'invalid_request_error', detail: 'x'.repeat(4000) },
    });
    expect(padded.length).toBeGreaterThan(500);

    const fetchImpl = (async () => new Response(padded, { status: 400 })) as unknown as typeof fetch;
    const adapter = await startAdapter({ jwt: 'j', fetchImpl });
    try {
      const res = await postResponses(adapter.port, { model: 'm', input: IMAGE_TURN, stream: false });
      const json = (await res.json()) as { error?: { message?: string } };
      expect(json.error?.message).toContain(REFUSAL);
    } finally {
      await adapter.close();
    }
  });
});

/**
 * The other way a refusal stops being legible: it arrives, and is RE-TOLD as a
 * different story. `classifyError`'s keyword tables run over the upstream text,
 * and a modality refusal that matched `context_length_exceeded` would reach
 * codex as a context-window problem — which routes the user to `/compact`, an
 * action that cannot help and hides the real cause.
 */
describe('P3.127 · a modality refusal is not re-told as some other failure', () => {
  test('classifies as invalid_request_error, keeping the endpoint\'s own words', () => {
    const classified = classifyError(400, 'invalid_request_error', REFUSAL);
    expect(classified.message).toBe(REFUSAL);
    expect(classified.code).toBe('invalid_request_error');
  });

  test('is not classified as a context-window, quota, or rate-limit story', () => {
    const classified = classifyError(400, 'invalid_request_error', REFUSAL);
    for (const wrong of ['context_length_exceeded', 'insufficient_quota', 'rate_limit_exceeded', 'server_is_overloaded']) {
      expect(classified.code).not.toBe(wrong);
    }
    expect(classified.type).not.toBe('rate_limit_error');

    // Control on the same call: the tables DO fire when the text warrants it, so
    // the negatives above are a property of this message, not a dead classifier.
    expect(classifyError(400, 'invalid_request_error', 'maximum context length is 4096 tokens').code)
      .toBe('context_length_exceeded');
    expect(classifyError(429, 'api_error', 'rate limit reached').code).toBe('rate_limit_exceeded');
  });
});
