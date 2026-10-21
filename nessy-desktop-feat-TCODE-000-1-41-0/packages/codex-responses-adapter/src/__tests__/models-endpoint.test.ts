/**
 * O20 — `GET {base_url}/models` is refused, and the refusal carries its reason.
 *
 * These are the CHEAP half of the row's evidence. They pin the route's shape:
 * the status stays 404 (identical to the catch-all it replaces, so no client
 * outcome changes), and the body names the thing that makes serving it
 * impossible without authoring — per-model agent instructions.
 *
 * The EXPENSIVE half — that the shipped binary never asks, with a positive
 * control proving the rig can see the request when it does — is
 * `codex-agent-server/src/__tests__/models-endpoint-live.test.ts`. Neither
 * file is a substitute for the other: this one cannot see the binary, and that
 * one cannot see the body.
 *
 * The reasoning, the four measurements and the three costs opening this seam
 * would incur live on `MODELS_NOT_SERVED` in `server.ts`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { MODELS_NOT_SERVED, startAdapter, type AdapterHandle } from '../server.ts';

let adapter: AdapterHandle | null = null;

afterEach(async () => {
  await adapter?.close();
  adapter = null;
});

async function start(): Promise<string> {
  // `jwt: 'test'` so no arm can reach `~/.nessy/dp_auth_creds.json`, and
  // `fetchImpl` refuses: nothing here may leave the process.
  adapter = await startAdapter({
    jwt: 'test',
    fetchImpl: (() => {
      throw new Error('no arm in this file may reach an upstream');
    }) as unknown as typeof fetch,
  });
  return `http://127.0.0.1:${adapter.port}`;
}

describe('GET /v1/models', () => {
  /**
   * KILLS: a lane that wires a served catalog here without reading the
   * docblock — the status assertion fails the moment the route answers 200.
   */
  test('is refused with 404, and the body says why', async () => {
    const base = await start();
    // The exact URL the binary builds: `{base_url}/models?client_version=…`
    // (`codex-api/src/endpoint/models.rs`, `append_client_version_query`).
    const res = await fetch(`${base}/v1/models?client_version=0.148.0`);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { message?: string; type?: string } };
    expect(body.error?.message).toBe(MODELS_NOT_SERVED);
    expect(body.error?.type).toBe('invalid_request_error');
  });

  /**
   * The message is the whole point of the branch, so pin the two facts a reader
   * needs from it rather than the sentence: WHICH fields codex demands, and that
   * the publisher does not publish them.
   *
   * KILLS: a tidy-up that shortens the message back to "not found".
   */
  test('the reason names the fields codex demands and the publisher that lacks them', () => {
    expect(MODELS_NOT_SERVED).toContain('base_instructions');
    expect(MODELS_NOT_SERVED).toContain('model_messages.instructions_template');
    expect(MODELS_NOT_SERVED).toContain('llm-proxy');
  });

  /**
   * The branch matches on METHOD as well as path. A POST to the same path is
   * not a catalog request and must keep falling through to the catch-all, whose
   * message names the method — otherwise a mis-routed POST would be reported as
   * a deliberate refusal it is not.
   *
   * KILLS: dropping the `req.method === 'GET'` guard.
   */
  test('a POST to the same path still gets the catch-all, not this refusal', async () => {
    const base = await start();
    const res = await fetch(`${base}/v1/models`, { method: 'POST', body: '{}' });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain('not found: POST /v1/models');
    expect(body.error?.message).not.toBe(MODELS_NOT_SERVED);
  });

  /**
   * POSITIVE CONTROL for the route table: the sibling deliberate-404 must still
   * answer in ITS protocol's envelope. `/messages/count_tokens` returns an
   * Anthropic error body, not an OpenAI one, and a new branch placed above it
   * could shadow it silently.
   *
   * KILLS: a `path.endsWith('/models')` match written loosely enough (or placed
   * late enough) to swallow a neighbouring route.
   */
  test('CONTROL: /v1/messages/count_tokens keeps its own Anthropic-shaped 404', async () => {
    const base = await start();
    const res = await fetch(`${base}/v1/messages/count_tokens`, { method: 'POST', body: '{}' });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { message?: string }; type?: string };
    expect(body.type).toBe('error');
    expect(body.error?.message).toContain('count_tokens is not implemented');
  });
});
