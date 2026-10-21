/**
 * T2 · the fail-safe, as `ClaudeAgent` implements it.
 *
 * `docs/superpowers/plans/2026-08-20-cross-runtime-history-carry.md`, T2 and R1.
 *
 * The invariant is one sentence: **a switch into Claude delivers either the
 * rebuilt transcript or the text handoff, never both, and never neither.** It
 * is enforced by two halves that live on this class, and each half is a
 * separate way to get it wrong:
 *
 * - `shouldSuppressTextHandoff` decides, at the TOP of a turn, whether a
 *   rebuild is really in force. Answering `true` when it is not loses the
 *   history outright; answering `false` when it is doubles it.
 * - `confirmRebuiltTranscriptResume` decides, when the child reports `init`,
 *   whether the rebuild TOOK. Marking too eagerly disarms a handoff that never
 *   arrived.
 *
 * **The detector in the second half was wrong once, and the mistake is worth
 * knowing about here too**: it compared the reported `session_id` against the
 * minted anchor, which measurement showed is identical on success AND on a
 * resume whose file does not exist. `claude-transcript-resume-e2e.test.ts`
 * carries that measurement; this file pins the behaviour that came out of it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAgent } from '../claude-agent.ts';
import { workspaceClaudeConfigDir } from '../options.ts';
import {
  buildClaudeTranscriptRecords,
  claudeTranscriptPath,
  mintClaudeSdkSessionId,
  writeClaudeTranscript,
} from '../claude-transcript-rebuild.ts';
import type { BackendConfig, RuntimeHandoffDelivery, RuntimeHandoffPayload } from '../backend/types.ts';

const WORKSPACE_ID = 'ws-claude-transcript-arm';
let workspaceRoot: string;
let configDir: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'claude-arm-ws-'));
  mkdirSync(join(workspaceRoot, 'sessions'), { recursive: true });
  configDir = workspaceClaudeConfigDir(WORKSPACE_ID)!;
});
afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(join(configDir, 'projects'), { recursive: true, force: true });
});

const agents: ClaudeAgent[] = [];
afterEach(() => {
  for (const agent of agents.splice(0)) { try { agent.destroy(); } catch { /* nothing to tear down */ } }
  rmSync(join(configDir, 'projects'), { recursive: true, force: true });
});

/** Deliveries the agent reported, so the "never both" invariant is observable. */
let deliveries: RuntimeHandoffDelivery[] = [];

function makeAgent(sdkSessionId: string | null): ClaudeAgent {
  deliveries = [];
  const config = {
    provider: 'anthropic',
    providerType: 'claude-runtime',
    connectionSlug: 'claude-shared',
    model: 'tgpt/qwen35-397b-a17b-fp8',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: WORKSPACE_ID,
      name: 'Arm Workspace',
      rootPath: workspaceRoot,
      workspaceRootPath: workspaceRoot,
      sessionRootPath: join(workspaceRoot, 'sessions'),
    } as never,
    session: {
      id: 'session-claude-arm',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: workspaceRoot,
      ...(sdkSessionId ? { sdkSessionId } : {}),
    } as never,
    markRuntimeHandoffApplied: (delivery: RuntimeHandoffDelivery = 'text') => { deliveries.push(delivery); },
  } as unknown as BackendConfig;
  const agent = new ClaudeAgent(config);
  agents.push(agent);
  return agent;
}

type Arm = {
  shouldSuppressTextHandoff: (handoff: RuntimeHandoffPayload) => boolean;
  confirmRebuiltTranscriptResume: (reported: string) => void;
  pendingRuntimeHandoff: RuntimeHandoffPayload | null;
};
const arm = (agent: ClaudeAgent): Arm => agent as unknown as Arm;

const handoff = (plan?: RuntimeHandoffPayload['plan']): RuntimeHandoffPayload => ({
  from: 'pi',
  messages: [{ type: 'user', content: 'add a retry' }],
  ...(plan ? { plan } : {}),
});

/** Write a real transcript at the path the agent's own resolver will look at. */
function plantTranscript(sdkSessionId: string): string {
  const filePath = claudeTranscriptPath({ configDir, cwd: workspaceRoot, sdkSessionId });
  writeClaudeTranscript(filePath, buildClaudeTranscriptRecords({
    history: [{ kind: 'message', role: 'user', content: 'carried', timestamp: 1_760_000_000_000 }],
    cwd: workspaceRoot,
    sdkSessionId,
    model: 'tgpt/qwen35-397b-a17b-fp8',
    version: '2.1.223',
  }));
  return filePath;
}

describe('shouldSuppressTextHandoff — a rebuild is in force only when it really is', () => {
  it('suppresses the text handoff when the plan is native AND the transcript is on disk', () => {
    const sdkSessionId = mintClaudeSdkSessionId();
    plantTranscript(sdkSessionId);
    expect(arm(makeAgent(sdkSessionId)).shouldSuppressTextHandoff(handoff('native'))).toBe(true);
  });

  /**
   * The plan gate. The decision is the SWITCH's, never the agent's: the modal
   * has already promised the user one of three things, and a runtime that
   * re-derived its own bounds could deliver something the user was not shown.
   */
  it('refuses on any plan but native, even with the transcript sitting there', () => {
    const sdkSessionId = mintClaudeSdkSessionId();
    plantTranscript(sdkSessionId);
    for (const plan of ['text', 'anchor', undefined] as const) {
      expect(arm(makeAgent(sdkSessionId)).shouldSuppressTextHandoff(handoff(plan))).toBe(false);
    }
  });

  /**
   * **R1's crash-mid-switch case.** The teardown is irreversible and the write
   * happens after it, so the next start can find an armed handoff, a set anchor
   * and no file. Answering `false` here is what delivers the text handoff on
   * that very turn instead of losing the conversation.
   */
  it('refuses when the anchor is set but the transcript never landed', () => {
    expect(arm(makeAgent(mintClaudeSdkSessionId())).shouldSuppressTextHandoff(handoff('native'))).toBe(false);
  });

  /**
   * A zero-byte file is the half-written case, and it must read as ABSENT —
   * the SDK's own transcript locator stats each candidate and skips any whose
   * size is zero, so suppressing the text handoff for it would suppress it for
   * a resume that cannot happen.
   */
  it('refuses on a zero-byte transcript, exactly as the SDK skips one', () => {
    const sdkSessionId = mintClaudeSdkSessionId();
    const filePath = claudeTranscriptPath({ configDir, cwd: workspaceRoot, sdkSessionId });
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, '');
    expect(arm(makeAgent(sdkSessionId)).shouldSuppressTextHandoff(handoff('native'))).toBe(false);
    // POSITIVE CONTROL — the same path with real content is taken, so the
    // refusal above is the emptiness and not the path.
    plantTranscript(sdkSessionId);
    expect(arm(makeAgent(sdkSessionId)).shouldSuppressTextHandoff(handoff('native'))).toBe(true);
  });

  it('refuses when there is no anchor at all — which is the state after a resume-failure recovery', () => {
    expect(arm(makeAgent(null)).shouldSuppressTextHandoff(handoff('native'))).toBe(false);
  });

  /**
   * The path the agent probes must be the one the SPAWN will use, or the
   * existence check answers about a directory the subprocess never runs in.
   * A transcript written under a DIFFERENT cwd is therefore invisible.
   */
  it('probes the path its own spawn cwd resolves to, not some other one', () => {
    const sdkSessionId = mintClaudeSdkSessionId();
    const elsewhere = mkdtempSync(join(tmpdir(), 'claude-arm-elsewhere-'));
    writeClaudeTranscript(
      claudeTranscriptPath({ configDir, cwd: elsewhere, sdkSessionId }),
      buildClaudeTranscriptRecords({
        history: [{ kind: 'message', role: 'user', content: 'wrong place' }],
        cwd: elsewhere,
        sdkSessionId,
        version: '2.1.223',
      }),
    );
    expect(arm(makeAgent(sdkSessionId)).shouldSuppressTextHandoff(handoff('native'))).toBe(false);
    rmSync(elsewhere, { recursive: true, force: true });
  });
});

describe('confirmRebuiltTranscriptResume — the read-back arm', () => {
  it('marks `native-transcript` when the child reaches init on the anchor we rebuilt', () => {
    const sdkSessionId = mintClaudeSdkSessionId();
    plantTranscript(sdkSessionId);
    const agent = makeAgent(sdkSessionId);
    expect(arm(agent).shouldSuppressTextHandoff(handoff('native'))).toBe(true);
    arm(agent).pendingRuntimeHandoff = handoff('native');

    arm(agent).confirmRebuiltTranscriptResume(sdkSessionId);

    expect(deliveries).toEqual(['native-transcript']);
    expect(arm(agent).pendingRuntimeHandoff).toBeNull();
  });

  it('marks nothing when the child reports a different conversation', () => {
    const sdkSessionId = mintClaudeSdkSessionId();
    plantTranscript(sdkSessionId);
    const agent = makeAgent(sdkSessionId);
    arm(agent).shouldSuppressTextHandoff(handoff('native'));

    arm(agent).confirmRebuiltTranscriptResume(mintClaudeSdkSessionId());

    // Nothing marked → `runtimeHandoffFrom` stays armed in the SessionManager
    // and the text handoff delivers on the next pass. Never both, and never
    // neither.
    expect(deliveries).toEqual([]);
  });

  /**
   * The turn that never suppressed anything must not be able to mark a native
   * delivery — otherwise a text handoff and a native one could both report,
   * which is the exact thing R1's invariant forbids.
   */
  it('marks nothing on a turn that did not suppress the text handoff', () => {
    const agent = makeAgent(mintClaudeSdkSessionId());
    expect(arm(agent).shouldSuppressTextHandoff(handoff('text'))).toBe(false);
    arm(agent).confirmRebuiltTranscriptResume('anything-at-all');
    expect(deliveries).toEqual([]);
  });

  /** One arming, one delivery: a second init in the same session cannot re-mark. */
  it('is one-shot per suppressed turn', () => {
    const sdkSessionId = mintClaudeSdkSessionId();
    plantTranscript(sdkSessionId);
    const agent = makeAgent(sdkSessionId);
    arm(agent).shouldSuppressTextHandoff(handoff('native'));

    arm(agent).confirmRebuiltTranscriptResume(sdkSessionId);
    arm(agent).confirmRebuiltTranscriptResume(sdkSessionId);

    expect(deliveries).toEqual(['native-transcript']);
  });
});
