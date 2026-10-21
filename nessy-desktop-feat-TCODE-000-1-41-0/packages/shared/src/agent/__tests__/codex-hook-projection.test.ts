/**
 * P2.414 — the codex half of the owner's hook-projection decision.
 *
 * The decision (2026-08-29) is option 2: project ONLY hooks the host itself
 * authored. A `command` hook written into codex's own `[hooks]` table is
 * executed by codex directly — outside `ProcessSupervisor`, outside
 * plugin-integrity verification, and outside the managed kill switches — so a
 * hook whose content is not ours must never reach it.
 *
 * Three consequences were named, and all three are pinned here:
 *
 *  1. the filter is on AUTHORSHIP and is checked where the plan is
 *     CONSTRUCTED, so an unauthored plan is refused even when its content is
 *     identical to an authored one (the writer half of this lives in
 *     `config-writer-hooks.test.ts`; the row below is the agent's own end of
 *     the same wire);
 *  2. the residual difference is SAID — a codex session states that user and
 *     plugin hooks are not projected there, and why, on the session
 *     diagnostics accessor rather than only on `debug()`, whose transports the
 *     packaged main process disables (P2.280, measured on this same class);
 *  3. revocation is the hook's own problem, not something inherited from the
 *     Pi path — `CodexHostHookRevocation` makes the mint refuse a plan that
 *     claims a runtime kill switch and names nothing that is one.
 *
 * `createRuntime` spawns a real app-server, so the CALL SITE is read as text —
 * the same reason and the same shape as
 * `server-core/.../codex-callback-bridge-host.test.ts`. Each text row carries a
 * positive control, so an emptied or moved file cannot read as a pass.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildCodexConfigToml,
  buildCodexHooksToml,
  mintHostAuthoredCodexHooks,
  CODEX_HOOK_PROJECTION_NOTICE,
  type CodexHostAuthoredHooksPlan,
} from '@nessy-agent/codex-responses-adapter/config-writer';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';

const WORKSPACE_ID = 'ws-hook-projection';
const SESSION_ID = 'session-hook-projection';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: WORKSPACE_ID, name: 'HP', rootPath: '/tmp/hp',
      workspaceRootPath: '/tmp/hp', sessionRootPath: '/tmp/hp-sessions',
    } as never,
    session: {
      id: SESSION_ID, workspaceRootPath: '/tmp/hp',
      createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: '/tmp/hp',
    } as never,
    model: 'codex/test-model',
    isHeadless: true,
  } as BackendConfig;
}

interface Internals {
  hostAuthoredHookProjection: () => { hooks?: CodexHostAuthoredHooksPlan };
  recordUpstreamAuthScheme: (scheme: 'bearer' | 'nestor-token' | 'x-api-key' | 'none') => void;
}

function internals(agent: CodexAgent): Internals {
  return agent as unknown as Internals;
}

const BASE = { codexHome: '/nessy-codex-home', model: 'tgpt/qwen35-397b-a17b-fp8', adapterPort: 4321 } as const;

describe('P2.414 — what a codex session projects', () => {
  it('projects nothing today, and the config stays byte-identical', () => {
    // The load-bearing default. codex fails a config OPEN and WHOLE-FILE, so a
    // capability with no host author must not be able to cost the deny floors,
    // the execpolicy pointer and `[permissions]` of every session that never
    // asked for it. Byte equality, not "contains no [hooks]", because a stray
    // blank line is also a change to a file the signature hash covers.
    const projection = internals(new CodexAgent(createConfig())).hostAuthoredHookProjection();

    expect(projection).toEqual({});
    expect(buildCodexConfigToml({ ...BASE, ...projection })).toBe(buildCodexConfigToml(BASE));
    expect(buildCodexConfigToml({ ...BASE, ...projection })).not.toContain('[hooks');
  });

  it('says what is NOT projected and why, on the accessor a user can reach', () => {
    // Consequence (2). An absent `[hooks]` table reads as "this session has no
    // hooks", which is false twice: the user's and the plugins' hooks exist and
    // they run — host-side — they are simply not handed to codex to execute.
    const agent = new CodexAgent(createConfig());

    expect(agent.getRecentStderr()).not.toContain('[codex-hooks]');
    internals(agent).hostAuthoredHookProjection();

    const said = agent.getRecentStderr();
    expect(said).toContain('NOT projected');
    expect(said).toContain('their content is not ours');
    expect(said).toContain('still run host-side');
  });

  it('the notice does not age out of the per-request ring', () => {
    // `getRecentStderr` is otherwise a bounded log of one line per request. A
    // standing property of the session must answer the same on turn sixty as on
    // turn one, so it is keyed rather than appended — and a respawn restates
    // rather than accumulating a second copy.
    const agent = new CodexAgent(createConfig());
    internals(agent).hostAuthoredHookProjection();
    for (let i = 0; i < 60; i += 1) internals(agent).recordUpstreamAuthScheme('bearer');

    expect(agent.getRecentStderr()).toContain(CODEX_HOOK_PROJECTION_NOTICE);
    // Positive control: the ring really did evict, so the row above is testing
    // stickiness rather than a ring that never filled.
    expect(agent.getRecentStderr().split('\n').filter(line => line.includes('upstream auth')))
      .toHaveLength(50);

    internals(agent).hostAuthoredHookProjection();
    expect(agent.getRecentStderr().split('\n').filter(line => line.includes('[codex-hooks]')))
      .toHaveLength(1);
  });

  it('AUTHORSHIP, not content: the same command is refused unminted and written minted', () => {
    // Consequence (1), on the wire the agent actually uses. The two calls differ
    // in one thing only — who constructed the plan — which is what makes this a
    // filter on authorship rather than on what the command says.
    const command = 'echo hook';
    const unminted = { Stop: [{ hooks: [{ command }] }] } as unknown as CodexHostAuthoredHooksPlan;
    const minted = mintHostAuthoredCodexHooks(
      { origin: 'codex-hook-projection.test.ts', revocation: { kind: 'next-runtime-build' } },
      { Stop: [{ hooks: [{ command }] }] },
    );

    expect(buildCodexHooksToml(unminted).lines).toEqual([]);
    expect(buildCodexHooksToml(unminted).diagnostics.join('\n')).toContain('not host-authored');
    expect(buildCodexHooksToml(minted).lines.join('\n')).toContain(`command = "${command}"`);
    expect(buildCodexConfigToml({ ...BASE, hooks: unminted })).not.toContain('[hooks');
    expect(buildCodexConfigToml({ ...BASE, hooks: minted })).toContain('[[hooks.Stop]]');
  });
});

const codexAgentSource = (): string =>
  readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8');

describe('P2.414 — the spawn side, read as text', () => {
  it('feeds writeCodexConfig from the one host-authored projection', () => {
    // `createRuntime` spawns a real app-server, so the wiring is read rather
    // than executed. What matters is that the ONLY thing that can reach the
    // writer's `hooks` option on this path is the host's own method.
    const source = codexAgentSource();
    // F1.532 (ef264a22f): the spawn passes `codexHome`, without which the floor hook gets no mode file.
    expect(source).toContain('...this.hostAuthoredHookProjection(codexHome),');
    // Positive control: the option literal it rides beside is still written.
    expect(source).toContain('execpolicyDenyPrefixes: this.collectExecpolicyDenyPrefixes(),');
    // And nothing else assembles a hooks option — a second producer is how the
    // authorship boundary would be widened without a new decision. Matched as a
    // property POSITION (line start, then `hooks:`) so prose mentioning the word
    // cannot fail this, and an option literal cannot escape it.
    expect(source.match(/^\s*hooks:/gm) ?? []).toEqual([]);
  });

  it('imports the notice rather than restating it', () => {
    // The sentence is written once, in the layer that owns the rule. A copy here
    // would drift from the one the writer's own test pins.
    const source = codexAgentSource();

    expect(source).toContain('CODEX_HOOK_PROJECTION_NOTICE');
    expect(source).toContain('this.recordSessionFact(\'codex-hooks-projection\', CODEX_HOOK_PROJECTION_NOTICE)');
  });
});
