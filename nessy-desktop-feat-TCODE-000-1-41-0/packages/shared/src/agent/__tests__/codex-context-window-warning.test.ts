/**
 * P6.95 — a codex session that fell back to codex's fabricated 272 000-token
 * window told nobody, and now it tells the operator by name.
 *
 * ## The defect, and why it was invisible
 *
 * `resolveCodexContextWindow` decides whether the writer emits
 * `model_context_window`. With no window on the connection it emits none — and
 * codex does not then run windowless: `model_info_from_slug`
 * (`models-manager/src/model_info.rs`, `rust-v0.150.1`) hands it
 * `context_window: Some(272_000)` for any slug it has no catalogue entry for,
 * which is every gateway id. The meter's denominator, codex's own 95 % usable
 * reserve and — with the limit key withheld — its 90 % compaction trigger are
 * then all derived from a number nobody chose.
 *
 * Claude has had a warning for the identical defect since
 * `buildClaudeContextWindowWarning`; codex never overrode `postInit` at all.
 *
 * ## WHAT EACH TEST KILLS
 *
 *  - "warns when the connection carries no window" dies if the builder stops
 *    firing — the shipped state, where the fallback is silent.
 *  - "says nothing when a window IS declared" is the negative control: it dies
 *    if the builder warns unconditionally, which would train an operator to
 *    ignore the one session that needed it.
 *  - the three degenerate arms die if the builder's predicate drifts from
 *    `resolveCodexContextWindow`'s. They are the ones a hand-written `typeof`
 *    check gets wrong: `0`, a negative and a non-number all make the writer
 *    emit nothing, so all three are fallback sessions.
 *  - "names the model and the assumed window" dies if the message stops
 *    carrying either. Without the model an operator cannot tell WHICH
 *    connection to fix; without the number they cannot tell that the figure
 *    their meter shows is fabricated.
 *  - "the number is the writer's constant, not a copy" dies if someone restates
 *    272 000 in the message. It is read from `CODEX_ASSUMED_CONTEXT_WINDOW`,
 *    which sits beside the source read that established it.
 *  - "postInit carries the warning" dies if the builder exists and nothing calls
 *    it — a diagnostic nothing invokes is the defect wearing a fix, and it is
 *    the exact shape codex was already in.
 *  - "postInit keeps the inherited auth answer" dies if the override changes
 *    `authInjected`, which `SessionManager` reads on every session.
 */
import { describe, expect, it } from 'bun:test';
import { CODEX_ASSUMED_CONTEXT_WINDOW } from '@nessy-agent/codex-responses-adapter/config-writer';
import type { BackendConfig } from '../backend/types.ts';
import { buildCodexContextWindowWarning, CodexAgent } from '../codex-agent.ts';

function createConfig(contextWindow?: unknown): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-codex-window',
      name: 'Codex Window Workspace',
      rootPath: '/tmp/ws-codex-window-root',
      workspaceRootPath: '/tmp/ws-codex-window-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-window',
    } as any,
    session: {
      id: 'session-codex-window',
      workspaceRootPath: '/tmp/ws-codex-window-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'tgpt/qwen35-397b-a17b-fp8',
    isHeadless: true,
    ...(contextWindow === undefined ? {} : { runtime: { contextWindow } as any }),
  } as BackendConfig;
}

describe('P6.95 · the codex window fallback is announced', () => {
  it('warns when the connection carries no window', () => {
    const result = buildCodexContextWindowWarning(undefined, 'tgpt/qwen35-397b-a17b-fp8');
    expect(result.authWarning).toBeDefined();
    // `warning`, not `error`: the session works. `SessionManager` renders an
    // error-level `authWarning` as the row it uses for a session that failed to
    // authenticate, and this one authenticated fine.
    expect(result.authWarningLevel).toBe('warning');
  });

  it('says nothing when a window IS declared', () => {
    expect(buildCodexContextWindowWarning(400_000, 'tgpt/qwen35-397b-a17b-fp8')).toEqual({});
  });

  it('warns on every value the writer refuses to emit', () => {
    // All three make `resolveCodexContextWindow` return `undefined`, so all
    // three are sessions that landed on codex's assumption.
    for (const value of [0, -1, 'big', Number.NaN, null]) {
      const result = buildCodexContextWindowWarning(value, 'some/model');
      expect(result.authWarning).toBeDefined();
    }
  });

  it('names the model and the assumed window', () => {
    const warning = buildCodexContextWindowWarning(undefined, 'tgpt/qwen35-397b-a17b-fp8').authWarning ?? '';
    expect(warning).toContain('tgpt/qwen35-397b-a17b-fp8');
    expect(warning).toContain('272,000');
    // And the remedy, because a warning an operator cannot act on is noise.
    expect(warning).toContain('Set a context window for this model on the connection');
  });

  it('takes the number from the writer\'s constant rather than a copy', () => {
    // The guard that makes the assertion above non-vacuous: if the constant
    // moves upstream, this file follows it instead of pinning a stale literal.
    expect(CODEX_ASSUMED_CONTEXT_WINDOW).toBe(272_000);
    const warning = buildCodexContextWindowWarning(undefined, 'm').authWarning ?? '';
    expect(warning).toContain(CODEX_ASSUMED_CONTEXT_WINDOW.toLocaleString('en-US'));
  });

  it('postInit carries the warning, and keeps the inherited auth answer', async () => {
    const agent = new CodexAgent(createConfig());
    const result = await agent.postInit();
    // `BaseAgent.postInit` answered a bare `{ authInjected: true }` and codex
    // inherited it; the override must not move that half.
    expect(result.authInjected).toBe(true);
    expect(result.authWarning).toContain('272,000');
    expect(result.authWarningLevel).toBe('warning');
  });

  it('postInit stays silent for a session whose connection declared one', async () => {
    const agent = new CodexAgent(createConfig(400_000));
    const result = await agent.postInit();
    expect(result.authInjected).toBe(true);
    expect(result.authWarning).toBeUndefined();
    expect(result.authWarningLevel).toBeUndefined();
  });
});
