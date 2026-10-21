/**
 * P6.366, the LADDER — a codex turn whose model is overloaded or whose server
 * failed retries the next id in the chain instead of ending with the error.
 *
 * This file REPLACES `codex-fallback-chain-inert.test.ts`, which pinned the
 * disclosure the S half landed (`a10da8339`). That notice said the chain "is
 * inert on this runtime", and with the ladder in place the sentence is false —
 * so it is deleted rather than left standing beside its own contradiction. A
 * disclosure is worth keeping only while the thing it discloses is true.
 *
 * ## What is asserted, and why it is the classifier rather than a live turn
 *
 * A codex turn needs a running app-server, so the end-to-end shape is a live
 * case rather than a unit test. What CAN be pinned here is the whole of the
 * decision the ladder makes — which codes switch, which never do, which id comes
 * next, and when the walk stops — and that is the part a reader has to trust.
 * The wiring around it (the `error` notification records the code; `chatImpl`
 * asks for a hop after the drain; `TurnStartParams.model` carries the new id) is
 * asserted structurally against the file's own source, which is how this suite
 * pins the sites it cannot drive.
 *
 * The env route drives the real resolver: `resolveFallbackModelChain` reads
 * `NESSY_FALLBACK_MODEL` ahead of the configured value, so these cases do not
 * depend on what the isolated config directory happens to contain.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';
import { FALLBACK_MODEL_ENV_VAR } from '../../config/fallback-model-chain.ts';

const RUNNING_MODEL = 'codex/test-model';

const source = readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8');

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-p6366',
      name: 'Fallback Chain Workspace',
      rootPath: '/tmp/nessy-p6366-ws',
      workspaceRootPath: '/tmp/nessy-p6366-ws',
      sessionRootPath: '/tmp/nessy-p6366-sessions/ws-p6366',
    } as any,
    session: {
      id: 'session-p6366',
      workspaceRootPath: '/tmp/nessy-p6366-ws',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/nessy-p6366-project',
    } as any,
    model: RUNNING_MODEL,
    isHeadless: true,
  };
}

type Internals = {
  turnTerminalErrorCode: string | null;
  fallbackChainCursor: number;
  nextFallbackModelHop: () => { modelId: string; index: number } | null;
};

function rig(): { agent: CodexAgent; internals: Internals } {
  const agent = new CodexAgent(createConfig());
  agent.onDebug = () => {};
  return { agent, internals: agent as unknown as Internals };
}

// `delete` before assign, never a bare assign: Bun pre-creates slots for some
// names and an assignment to one is invisible to a spread.
function setChain(value: string | undefined): void {
  delete process.env[FALLBACK_MODEL_ENV_VAR];
  if (value !== undefined) process.env[FALLBACK_MODEL_ENV_VAR] = value;
}

afterEach(() => { setChain(undefined) });

describe('P6.366 — which codex failures switch models', () => {
  /**
   * The page's own two: *"When the primary model is overloaded, unavailable, or
   * returns another non-retryable server error, Claude Code can switch to a
   * fallback model instead of failing the request"*
   * (`model-config.md#fallback-model-chains`).
   */
  it.each(['serverOverloaded', 'internalServerError'])('%s switches to the next id', code => {
    setChain('codex/other-model,codex/third-model');
    const { internals } = rig();
    internals.turnTerminalErrorCode = code;

    expect(internals.nextFallbackModelHop()).toEqual({ modelId: 'codex/other-model', index: 0 });
  });

  /**
   * The NEGATIVE half of the same sentence, and it is the longer one:
   * *"Authentication, billing, rate-limit, request-size, and transport errors,
   * and a denial by your organization's policy check, never trigger a switch"*.
   * Every member of `CodexErrorInfo` that is not one of the two above is here,
   * so a new member added to the generated bindings cannot quietly start
   * switching — it will simply be absent from both lists and from this file.
   */
  it.each([
    'usageLimitExceeded', 'sessionBudgetExceeded', 'contextWindowExceeded',
    'unauthorized', 'badRequest', 'cyberPolicy', 'misalignmentPolicyViolation',
    'httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected',
    'responseTooManyFailedAttempts', 'sandboxError', 'threadRollbackFailed',
    'activeTurnNotSteerable', 'other',
  ])('%s never switches', code => {
    setChain('codex/other-model,codex/third-model');
    const { internals } = rig();
    internals.turnTerminalErrorCode = code;

    expect(internals.nextFallbackModelHop()).toBeNull();
  });

  it('a turn that did not end on an error asks for no hop — the control', () => {
    setChain('codex/other-model');
    const { internals } = rig();
    expect(internals.turnTerminalErrorCode).toBeNull();

    expect(internals.nextFallbackModelHop()).toBeNull();
  });
});

describe('P6.366 — how far the walk goes', () => {
  it('resumes at the cursor rather than stopping after one hop', () => {
    setChain('codex/other-model,codex/third-model');
    const { internals } = rig();
    internals.turnTerminalErrorCode = 'serverOverloaded';
    internals.fallbackChainCursor = 0;

    expect(internals.nextFallbackModelHop()).toEqual({ modelId: 'codex/third-model', index: 1 });
  });

  it('stops once the chain is spent', () => {
    setChain('codex/other-model,codex/third-model');
    const { internals } = rig();
    internals.turnTerminalErrorCode = 'serverOverloaded';
    internals.fallbackChainCursor = 1;

    expect(internals.nextFallbackModelHop()).toBeNull();
  });

  it('skips an entry equal to the model already running, per entry', () => {
    // A chain may name the primary in the middle; skipping is per-entry rather
    // than a filter over the whole list, so the walk continues past it.
    setChain(`${RUNNING_MODEL},codex/other-model`);
    const { internals } = rig();
    internals.turnTerminalErrorCode = 'serverOverloaded';

    expect(internals.nextFallbackModelHop()).toEqual({ modelId: 'codex/other-model', index: 1 });
  });

  it('says nothing when the only entry is the model already running', () => {
    setChain(RUNNING_MODEL);
    const { internals } = rig();
    internals.turnTerminalErrorCode = 'serverOverloaded';

    expect(internals.nextFallbackModelHop()).toBeNull();
  });

  it('says nothing when no chain is configured — POSITIVE CONTROL for the two above', () => {
    setChain(undefined);
    const { internals } = rig();
    internals.turnTerminalErrorCode = 'serverOverloaded';

    expect(internals.nextFallbackModelHop()).toBeNull();
  });
});

describe('P6.366 — the wiring the unit cases cannot drive', () => {
  /**
   * Three sites, each read from the file rather than assumed, because a hop
   * resolver nobody calls is exactly the shape of the inert chain this row
   * removed.
   */
  it('records the terminal code, asks for a hop after the drain, and re-enters the turn', () => {
    expect(source).toContain('this.turnTerminalErrorCode = readCodexErrorInfoCode(')
    expect(source).toContain('const hop = this.aborted ? null : this.nextFallbackModelHop();')
    expect(source).toContain('yield* this.chatImpl(message, attachments, options);')
  });

  /**
   * The seam that makes the switch cheap, and the reason no app-server respawn
   * is needed: `TurnStartParams.model` is *"Override the model for this turn and
   * subsequent turns"* (`generated/v2/TurnStartParams.ts`, `rust-v0.148.0`), and
   * the turn request already carries it.
   */
  it('sends the model on every turn, which is what carries the switch', () => {
    expect(source).toContain('model: this._model,')
  });

  /**
   * *"The switch lasts for the current turn only, so your next message tries the
   * primary model first again."* The restore compares against the entry the walk
   * INSTALLED, so a model change from the user's picker mid-turn survives.
   */
  it('restores the primary at the end of the walk, and only what the walk installed', () => {
    expect(source).toContain('if (this.fallbackChainPrimaryModel !== null) {')
    expect(source).toContain('&& this.getModel() !== this.fallbackChainPrimaryModel) {')
    expect(source).toContain('this.setModel(this.fallbackChainPrimaryModel);')
  });

  /**
   * The disclosure the S half landed is GONE, and its absence is asserted rather
   * than left to a reader: a notice saying the chain is inert would now be a
   * false statement standing beside the ladder that disproves it.
   */
  it('no longer claims the chain is inert', () => {
    expect(source).not.toContain('codex-fallback-model-chain-inert')
    expect(source).not.toContain('noteInertFallbackModelChainOnce')
  });
});

/**
 * F1.1224 — the three `CodexErrorInfo` members the ladder had no verdict for at `rust-v0.159.3`
 * (`codex-rs/protocol/src/error.rs`, `to_codex_protocol_error`): `flexUnavailable` is "Flex capacity
 * unavailable." — the model's capacity at the requested service tier, the page's "unavailable", so it
 * switches; `rateLimitExceeded` is "a retryable upstream rate limit received inside the response
 * stream" — the page's rate-limit, never; `tooManyDenials` ends a turn on the reviewer's denials, a
 * policy verdict the next model would meet identically — never.
 */
describe('F1.1224 — the members rust-v0.159.3 added', () => {
  it('flexUnavailable switches to the next id', () => {
    setChain('codex/other-model,codex/third-model');
    const { internals } = rig();
    internals.turnTerminalErrorCode = 'flexUnavailable';
    expect(internals.nextFallbackModelHop()).toEqual({ modelId: 'codex/other-model', index: 0 });
  });

  it.each(['rateLimitExceeded', 'tooManyDenials'])('%s never switches', code => {
    setChain('codex/other-model,codex/third-model');
    const { internals } = rig();
    internals.turnTerminalErrorCode = code;
    expect(internals.nextFallbackModelHop()).toBeNull();
  });
});
