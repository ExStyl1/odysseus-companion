/**
 * P3.114 — image content parts survive the Responses → Chat Completions hop.
 *
 * The fixtures are the EXACT wire shapes codex emits, read from
 * openai/codex @ `rust-v0.148.0` (the tag shipped when this was read):
 *
 *  - `codex-rs/protocol/src/models.rs:1646 local_image_content_items()` turns a
 *    `localImage` attachment into THREE content items — an `input_text` open tag
 *    `<image name=[Image #1] path="…">`, the `input_image`, and an `input_text`
 *    `</image>` close tag. `ContentItem` is `#[serde(tag = "type",
 *    rename_all = "snake_case")]` (:744), so the image is
 *    `{type:"input_image", image_url, detail}` and `detail` defaults to `High`
 *    (`DEFAULT_IMAGE_DETAIL`, :792).
 *  - `impl Serialize for FunctionCallOutputPayload` (:2065) writes
 *    `function_call_output.output` as a bare string OR an array of content
 *    items — the array being how `view_image` returns a picture.
 *
 * Before this suite the flattener kept only parts carrying a string `text`, so
 * the picture vanished BETWEEN codex's own frame tags and the tool-output array
 * was `JSON.stringify`d into the tool message as base64-quoted-as-prose. Every
 * assertion below carries its text control in the SAME request, because the
 * defect this replaces was invisible: text arrived, the image did not.
 *
 * What the gateway does with the translated body is measured, not assumed
 * (2026-08-28, darwin-arm64): a chat `image_url` part is PARSED and refused by
 * name — 400 `Invalid Chat Message Part: Model Does Not Support Image Inputs` —
 * while the identical body with the image part removed returns 200. So the
 * shape below is the shape the endpoint understands, and the loss is now a
 * visible endpoint refusal rather than silence.
 */
import { test, expect, describe } from 'bun:test';
import { toChatRequest } from '../to-chat.ts';
import { startAdapter } from '../server.ts';

const DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** codex's own three-item framing for one attached local image. */
const LOCAL_IMAGE_PARTS = [
  { type: 'input_text', text: '<image name=[Image #1] path="/tmp/shot.png">' },
  { type: 'input_image', image_url: DATA_URI, detail: 'high' },
  { type: 'input_text', text: '</image>' },
];

describe('P3.114 · image parts reach the chat body', () => {
  test('END TO END: a localImage turn leaves the adapter carrying the image, with its text control intact', async () => {
    let sent: Record<string, any> | null = null;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const adapter = await startAdapter({ jwt: 'test-jwt', fetchImpl });
    try {
      const res = await fetch(`http://127.0.0.1:${adapter.port}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'tgpt/qwen35-397b-a17b-fp8',
          stream: false,
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'what is this?' }, ...LOCAL_IMAGE_PARTS] }],
        }),
      });
      expect(res.status).toBe(200);
      await res.text();
    } finally {
      await adapter.close();
    }

    const user = sent!.messages.find((m: any) => m.role === 'user');
    // The image LEFT the adapter (this is the whole row).
    expect(user.content).toContainEqual({ type: 'image_url', image_url: { url: DATA_URI, detail: 'high' } });
    // CONTROL, same request: the text parts arrived, and in codex's order —
    // so a failure above is about the image, not about the request reaching us.
    expect(user.content.map((p: any) => p.type)).toEqual(['text', 'text', 'image_url', 'text']);
    expect(user.content[0]).toEqual({ type: 'text', text: 'what is this?' });
    // NEGATIVE: the frame tags no longer surround an empty hole.
    expect(JSON.stringify(user.content)).not.toContain('<image name=[Image #1] path="/tmp/shot.png"></image>');
  });

  test('a text-only turn keeps the plain-string shape it has always had', () => {
    const chat = toChatRequest({
      model: 'm',
      instructions: 'be nice',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }, { type: 'input_text', text: 'b' }] }],
    });
    expect(chat.messages[0]).toEqual({ role: 'system', content: 'be nice' });
    expect(chat.messages[1]).toEqual({ role: 'user', content: 'ab' });
  });

  test('detail: the three chat values are forwarded, codex-only `original` is not', () => {
    const detailOf = (detail?: string) => {
      const chat = toChatRequest({
        model: 'm',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: DATA_URI, ...(detail ? { detail } : {}) }] }],
      });
      return (chat.messages[0]!.content as any[])[0].image_url;
    };
    expect(detailOf('high')).toEqual({ url: DATA_URI, detail: 'high' });
    expect(detailOf('low')).toEqual({ url: DATA_URI, detail: 'low' });
    // `original` is a codex `ImageDetail` value the chat API does not define, and
    // an unknown enum value is exactly what this gateway 400s on.
    expect(detailOf('original')).toEqual({ url: DATA_URI });
    expect(detailOf(undefined)).toEqual({ url: DATA_URI });
  });

  test('an image in the LEADING system block leaves the block instead of being dropped to keep the merge', () => {
    const chat = toChatRequest({
      model: 'm',
      instructions: 'be nice',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'text-only developer note' }] },
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'look:' }, { type: 'input_image', image_url: DATA_URI }] },
      ],
    });
    // CONTROL: the text-only developer item still merges into the one system message.
    expect(chat.messages[0]).toEqual({ role: 'system', content: 'be nice\n\ntext-only developer note' });
    // The image-carrying one is demoted to `user` (system content must be a string)
    // and keeps its image rather than losing it to the merge.
    expect(chat.messages[1]!.role).toBe('user');
    expect(chat.messages[1]!.content).toEqual([
      { type: 'text', text: 'look:' },
      { type: 'image_url', image_url: { url: DATA_URI } },
    ]);
  });

  test('an audio part is marked, not silently dropped', () => {
    const chat = toChatRequest({
      model: 'm',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_audio', audio_url: 'data:audio/wav;base64,AA==' }] }],
    });
    expect(String(chat.messages[0]!.content)).toContain('[audio attachment omitted');
  });
});

describe('P3.114 · function_call_output content items (the `view_image` path)', () => {
  const outputOf = (output: unknown) => {
    const chat = toChatRequest({
      model: 'm',
      input: [
        { type: 'function_call', call_id: 'c1', name: 'view_image', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output },
      ],
    });
    return chat.messages.find((m) => m.role === 'tool')!.content;
  };

  test('an image content item becomes an image part instead of base64 quoted as prose', () => {
    const content = outputOf([
      { type: 'input_text', text: 'viewed /tmp/shot.png' },
      { type: 'input_image', image_url: DATA_URI, detail: 'high' },
    ]) as any[];
    expect(content).toEqual([
      { type: 'text', text: 'viewed /tmp/shot.png' },
      { type: 'image_url', image_url: { url: DATA_URI, detail: 'high' } },
    ]);
    // NEGATIVE: the whole array is no longer JSON-encoded into the text field.
    expect(typeof content).not.toBe('string');
  });

  test('a text-only content-item array unwraps to its text', () => {
    expect(outputOf([{ type: 'input_text', text: '# hello' }])).toBe('# hello');
  });

  test('CONTROLS: a string output and a non-content-item output keep their historical encoding', () => {
    expect(outputOf('file.txt')).toBe('file.txt');
    // An ordinary structured tool result is not a content-item array — it must
    // still arrive as JSON, which is what every non-image tool relies on.
    expect(outputOf({ ok: true })).toBe('{"ok":true}');
    expect(outputOf([{ ok: true }])).toBe('[{"ok":true}]');
    expect(outputOf([])).toBe('[]');
  });
});
