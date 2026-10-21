/**
 * The stub Responses provider must put a codex tool's NAMESPACE in the sibling
 * field codex reads it from, never in the name string (P6.670).
 *
 * ## Why this is a wire-shape test and not a spelling test
 *
 * Five spellings were tried before this existed — `spawn_agent`, and the same
 * name joined to `multi_agent_v1` by a dot, a double underscore, a slash and a
 * colon — and all five came back `unsupported call: <the whole string>`. The
 * axis was wrong. Read at `github.com/openai/codex`, tag `rust-v0.148.0`, which
 * is what the binary we ship is built from and which for codex OUTRANKS the
 * published page:
 *
 * - `codex-rs/protocol/src/models.rs` — `enum ResponseItem` is
 *   `#[serde(tag = "type", rename_all = "snake_case")]`, so the discriminator is
 *   `"type": "function_call"`, and the variant declares
 *   `namespace: Option<String>` beside `name`, carrying
 *   `#[serde(default, skip_serializing_if = "Option::is_none")]`.
 * - `codex-rs/core/src/tools/router.rs` — `ToolRouter::build_tool_call` reads
 *   exactly those two fields: `ToolName::new(namespace, name).with_default_namespace()`.
 * - `codex-rs/protocol/src/tool_name.rs` — `ToolName` is
 *   `{ name: String, namespace: Option<String> }` and has NO string parser:
 *   `impl From<&str> for ToolName` calls `plain(name)`, which sets
 *   `namespace: None`. There is no `split` on any delimiter in the type, so no
 *   sixth delimiter could ever have worked.
 *
 * `with_default_namespace()` then stamps `DEFAULT_FUNCTION_NAMESPACE =
 * "functions"` on anything that arrived without one — which is why the default
 * stays UNSET here rather than being given a value: every existing caller emits
 * a top-level tool, and a default namespace would silently move all of them.
 *
 * ## One correction to the row that produced this, measured the same way
 *
 * The row also asked the stub to "declare tools as a namespace container".
 * `LoadableToolSpec` (`codex-rs/tools/src/responses_api.rs`), the
 * `{"type":"namespace","name":…,"tools":[…]}` shape, derives **`Serialize` and
 * not `Deserialize`** — it is what codex puts in its REQUEST. This stub is the
 * provider; that container arrives here, readable verbatim through
 * `onRequestBody`. Nothing to emit on that side.
 *
 * SAFETY: the stub binds an ephemeral port on 127.0.0.1 and is closed in
 * `finally`. No model, no credential, no outbound network.
 */
import { describe, expect, it } from 'bun:test';
import { startStubAdapter, type StubAdapterOptions } from '../stub-server.ts';

/** Drive the stub once and return the `function_call` items it streamed. */
async function functionCallItems(options: StubAdapterOptions): Promise<Record<string, unknown>[]> {
  const handle = await startStubAdapter(options);
  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub', input: [] }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    return body
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
      .map((frame) => frame.item as Record<string, unknown> | undefined)
      .filter((item): item is Record<string, unknown> => item?.type === 'function_call');
  } finally {
    await handle.close();
  }
}

describe('the stub Responses provider and a namespaced codex tool (P6.670)', () => {
  it('emits `namespace` as a sibling of `name`, never joined into it', async () => {
    const items = await functionCallItems({
      toolName: 'spawn_agent',
      toolNamespace: 'multi_agent_v1',
      toolArguments: { prompt: 'hi' },
    });

    // Both frames that carry the item shape: the `added` frame codex reads to
    // open the call, and the `done` frame it reads to dispatch it. A namespace
    // on only one of them is the half-fix this asserts against.
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.name).toBe('spawn_agent');
      expect(item.namespace).toBe('multi_agent_v1');
      // The five spellings that failed, asserted as absences: the name must
      // carry no delimiter at all.
      expect(item.name).not.toContain('multi_agent_v1');
      expect(String(item.name)).not.toMatch(/[.:/]|__/);
    }
  });

  it('omits the key entirely when no namespace is given, matching the Rust default', async () => {
    // `skip_serializing_if = "Option::is_none"` on the wire, and
    // `with_default_namespace()` stamps `functions` on arrival. An explicit
    // `null` would not deserialize into `Option<String>` the way an omitted key
    // does, so absence is the contract — not `null` and not `''`.
    const items = await functionCallItems({ toolName: 'exec_command' });
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.name).toBe('exec_command');
      expect('namespace' in item).toBe(false);
    }
  });

  it('leaves every other field of the item untouched', async () => {
    // The control that says the two cases above are reading a real stream
    // rather than an empty one, and that adding the field moved nothing else.
    const items = await functionCallItems({
      toolName: 'spawn_agent',
      toolNamespace: 'multi_agent_v1',
      toolArguments: { prompt: 'hi' },
    });
    const [added, done] = items;
    expect(added?.status).toBe('in_progress');
    expect(added?.arguments).toBe('');
    expect(done?.status).toBe('completed');
    expect(done?.arguments).toBe(JSON.stringify({ prompt: 'hi' }));
    expect(added?.call_id).toBe(done?.call_id);
  });
});
