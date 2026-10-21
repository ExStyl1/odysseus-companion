/**
 * P6.263 — the runtime publishes a `capabilities` array and, until this row, the
 * ONLY thing in this tree reading it was a test fixture.
 *
 * The spec was corrected once, and the correction is what this file pins:
 * landing the CAPTURE alone would have recreated P6.411's defect (a record with
 * no reader). So the chain has three links and each has a case here — the
 * claude child's `system/init` array, the per-runtime reader every backend
 * answers, and the headless `system/init` frame a CI job reads.
 *
 * Two invariants matter more than the plumbing:
 *
 *  - **Unknown values are KEPT.** `sdk.d.ts`: *"Open set — ignore unknown values;
 *    check each capability for exactly the behavior you use."* Ignoring is the
 *    CONSUMER's job; filtering here would hide a name a later reader
 *    understands, and it would make the array a claim about our vocabulary
 *    rather than about the child's.
 *  - **`[]` is an answer, never an omission.** Pi and codex advertise none, and
 *    `capabilities` is always present on the view for exactly that reason: a
 *    surface that shows nothing leaves a reader unable to tell "advertises none"
 *    from "nobody asked".
 */
import { describe, expect, it } from 'bun:test';
import { buildHeadlessInitView } from '../../capabilities/views.ts';
import type { EffectiveCapabilitySnapshot } from '../../capabilities/resolver.ts';
import type { BackendConfig } from '../backend/types.ts';
import { ClaudeAgent } from '../claude-agent.ts';

const WORKSPACE_ROOT = '/tmp/nessy-p6263';

let counter = 0;

function agentConfig(): BackendConfig {
  counter += 1;
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-p6263',
      name: 'P6.263',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: {
      id: `session-p6263-${counter}`,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: WORKSPACE_ROOT,
    } as never,
  } as BackendConfig;
}

/**
 * Feed one raw `system/init` through the production capture, exactly as the live
 * reader does. Called with no slot open on purpose: that is the respawn case,
 * and the capture sits ABOVE `routeLiveMessage`'s slot guard for it.
 */
function feedInit(agent: unknown, capabilities: unknown): void {
  (agent as { captureAdvertisedProtocolCapabilities(message: unknown): void })
    .captureAdvertisedProtocolCapabilities({ type: 'system', subtype: 'init', session_id: 'sdk-1', capabilities });
}

const emptySnapshot = {
  installedPlugins: [],
  entries: [],
  diagnostics: [],
} as unknown as EffectiveCapabilitySnapshot;

describe('P6.263 · the protocol-capability channel', () => {
  it('a runtime that publishes nothing answers an EMPTY LIST, not undefined', () => {
    // The base default every backend but claude keeps — pi and codex publish no
    // such array at all, and this is what lets a surface say "advertises none".
    const agent = new ClaudeAgent(agentConfig());
    expect(agent.protocolCapabilities()).toEqual([]);
  });

  it('captures the claude child’s array off the init frame we already read', () => {
    const agent = new ClaudeAgent(agentConfig());

    feedInit(agent, ['interrupt_receipt_v1', 'queued_notifications']);

    expect([...agent.protocolCapabilities()]).toEqual(['interrupt_receipt_v1', 'queued_notifications']);
  });

  it('KEEPS an unknown capability and changes nothing about behaviour', () => {
    const agent = new ClaudeAgent(agentConfig());

    feedInit(agent, ['some_capability_from_a_newer_cli', 'interrupt_receipt_v1']);

    const advertised = [...agent.protocolCapabilities()];
    expect(advertised).toContain('some_capability_from_a_newer_cli');
    // And the known one is still found beside it, which is the whole point of
    // "check each capability for exactly the behavior you use".
    expect(advertised).toContain('interrupt_receipt_v1');
  });

  it('a frame with no array, or a malformed one, leaves the answer honest', () => {
    const agent = new ClaudeAgent(agentConfig());
    feedInit(agent, undefined);
    expect(agent.protocolCapabilities()).toEqual([]);

    // A non-array is not "the child has none": it is a frame we could not read,
    // so the previous answer stands rather than being erased.
    feedInit(agent, ['interrupt_receipt_v1']);
    feedInit(agent, 'interrupt_receipt_v1');
    expect([...agent.protocolCapabilities()]).toEqual(['interrupt_receipt_v1']);

    // Non-string entries are dropped; the strings around them survive.
    feedInit(agent, [1, null, 'queued_notifications', '']);
    expect([...agent.protocolCapabilities()]).toEqual(['queued_notifications']);
  });

  it('the headless init frame carries the list, and carries [] rather than omitting it', () => {
    const withNone = buildHeadlessInitView(emptySnapshot);
    expect(withNone.capabilities).toEqual([]);
    // Present, not omitted — unlike `plugin_errors`/`mcp_server_errors`, whose
    // omission the page makes the contract.
    expect('capabilities' in withNone).toBe(true);

    const withSome = buildHeadlessInitView(emptySnapshot, undefined, ['interrupt_receipt_v1']);
    expect(withSome.capabilities).toEqual(['interrupt_receipt_v1']);
  });
});
