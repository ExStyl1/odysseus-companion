/**
 * P6.36 — the selected output style reaches a codex session.
 *
 * Capability ledger L7: Pi and Claude both carry the output style; codex
 * received NONE of it — not the prose, not the per-turn reminder — and the hole
 * was silent. The blocker is real and written down (the app-server owns codex's
 * system prompt, so a byte-identical take is impossible), but the two channels
 * that ARE available were simply never used:
 *
 *  1. `ThreadStartParams.developerInstructions` — additive, measured to leave
 *     codex's own 20,751-char base prompt untouched (`codex-agent.ts`'s
 *     `codexDeveloperInstructions` header, and `codex-instructions-channel-e2e`).
 *     `output-styles.md#how-output-styles-work`, as read 2026-10-17: "Claude
 *     Code sends the active style's instructions with every request."
 *  2. `PromptBuilder.buildOutputStyleReminder` — the per-turn restatement. It
 *     has been wired for every runtime since it was written and was INERT on
 *     codex, because nothing called `setActiveOutputStyle`. (P6.36 quoted a
 *     reminder sentence from `#how-output-styles-work`; the page no longer
 *     carries it, read 2026-10-17.)
 *
 * UB12.63 — a style picked MID-SESSION reaches the thread on the next turn.
 * P6.36 called session scope the page's own rule, quoting a sentence that
 * `output-styles.md#change-your-output-style` no longer has. The page now
 * reads "When you switch styles mid-session, Claude uses the new style starting
 * with your next message", and `prompt-caching.md#changing-output-style` says
 * how: Claude Code "delivers the new style's instructions as a message in the
 * conversation". `developerInstructions` stays thread-scoped (`turn/start`
 * carries no such field at `rust-v0.162.0`), so the switch rides the turn as
 * `core/output-style-switch.ts`'s one-shot notice — the last describe block.
 *
 * WHAT THIS FILE DOES NOT PROVE: that a live app-server puts the appended block
 * on the wire to the model. That measurement is the e2e sibling's
 * (`codex-instructions-channel-e2e.test.ts`), and the channel it proves is the
 * same field this appends to.
 *
 * Hermetic, modelled on `codex-injection-guidance.test.ts`: adapter launcher,
 * app-server subprocess and credential store are faked, and every `mock.module`
 * spreads the real module and is restored in `afterAll`.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as credentialsIndex from '../../credentials/index.ts';
import * as adapterPackage from '@nessy-agent/codex-responses-adapter';
import * as nestorAuth from '@nessy-agent/codex-responses-adapter/nestor-auth';
import * as codexAgentServer from '@nessy-agent/codex-agent-server';
import type { AdapterHandle } from '@nessy-agent/codex-responses-adapter';
import type { BackendConfig } from '../backend/types.ts';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getConfigPath, getOutputStyleId, setOutputStyleId } from '../../config/storage.ts';
import { STORAGE_LAYOUT_VERSION } from '../../config/paths.ts';

interface RecordedRequest { method: string; params: Record<string, unknown> }

let recorded: RecordedRequest[] = [];
/**
 * UB12.63 · what a `turn/start` does in this fake, set by the suite that drives
 * whole turns (it ends the turn the way codex's own `turn/completed` would).
 * `null` everywhere else, so the suites above are unchanged.
 */
let onTurnStart: (() => void) | null = null;

class FakeRuntimeManager {
  spawn(): unknown { return { pid: 6262 }; }
  async kill(): Promise<void> { /* no child to reap */ }
}

class FakeAppServerClient {
  constructor(_child: unknown, _handlers: unknown) { /* no stdio */ }
  async request(method: string, params?: unknown): Promise<unknown> {
    recorded.push({ method, params: (params ?? {}) as Record<string, unknown> });
    if (method === 'thread/start') return { thread: { id: `thread-${recorded.length}` } };
    // UB12.63 · a turn-head config re-fork answers with the same thread shape.
    if (method === 'thread/fork') return { thread: { id: `thread-${recorded.length}` } };
    if (method === 'turn/start') onTurnStart?.();
    return {};
  }
  notify(): void { /* no-op */ }
  close(): void { /* no-op */ }
}

const realCredentials = { ...credentialsIndex };
const realAdapter = { ...adapterPackage };
const realNestorAuth = { ...nestorAuth };
const realCodexAgentServer = { ...codexAgentServer };

mock.module('../../credentials/index.ts', () => ({
  ...realCredentials,
  getCredentialManager: () => ({ getLlmApiKey: async () => null }),
}));
mock.module('@nessy-agent/codex-responses-adapter', () => ({
  ...realAdapter,
  startAdapter: async (): Promise<AdapterHandle> => ({ port: 45997, close: async () => {} }),
}));
/**
 * DA1.29 — this stub covers BOTH readers of the creds file, not just the one
 * a past call graph used. `codex-agent.ts` imports `readNestorCreds` and no
 * longer imports `readNestorJwt` at all (DA1.12), and a spread isolates only
 * the names it lists: the un-stubbed sibling reads the developer's real
 * `~/.nessy/dp_auth_creds.json` (measured by WA-b, now AGENTS.md §Traps).
 * Both are derived from ONE literal so they cannot drift, and neither is
 * reachable on this suite's paths today — which is exactly why it must not
 * depend on that staying true.
 */
mock.module('@nessy-agent/codex-responses-adapter/nestor-auth', () => ({
  ...realNestorAuth,
  readNestorJwt: () => 'jwt-output-style',
  readNestorCreds: () => ({ ok: true, jwt: 'jwt-output-style' }),
}));
mock.module('@nessy-agent/codex-agent-server', () => ({
  ...realCodexAgentServer,
  CodexRuntimeManager: FakeRuntimeManager,
  AppServerClient: FakeAppServerClient,
}));

// The app-global selection lives in `config.json`, so the suite borrows it and
// puts it back — the same save/restore `fork-parent-scope.test.ts` uses. Without
// this the assertions below would read the DEVELOPER'S OWN style, which is the
// rig hazard P2.256 already paid for once.
// `setOutputStyleId` is a NO-OP without a config file and the test config dir
// starts empty, so the file is seeded first — the same two steps
// `fork-parent-scope.test.ts` takes, and the reason its comment gives.
const configPath = getConfigPath();
mkdirSync(dirname(configPath), { recursive: true });
if (!existsSync(configPath)) {
  writeFileSync(
    configPath,
    `{"storageLayoutVersion":${STORAGE_LAYOUT_VERSION},"workspaceRefs":[],"activeWorkspaceId":null}\n`,
  );
}
const previousStyleId = getOutputStyleId();

/** Assert the selection really landed; a silent no-op would make every case vacuous. */
function selectStyle(styleId: string): void {
  expect(setOutputStyleId(styleId)).toBe(true);
}

afterAll(() => {
  setOutputStyleId(previousStyleId);
  mock.module('../../credentials/index.ts', () => realCredentials);
  mock.module('@nessy-agent/codex-responses-adapter', () => realAdapter);
  mock.module('@nessy-agent/codex-responses-adapter/nestor-auth', () => realNestorAuth);
  mock.module('@nessy-agent/codex-agent-server', () => realCodexAgentServer);
});

const { CodexAgent, codexDeveloperInstructions } = await import('../codex-agent.ts');
const { getSafetyAndEngineeringSections, gitAttributionSection, untrustedProjectPromptSection } = await import('../../prompts/system.ts');
const { CODEX_RUNTIME_GUIDANCE } = await import('../../prompts/codex-runtime-guidance.ts');
const { resolveGitAttribution } = await import('../../config/preferences.ts');
const { codexDriver } = await import('../backend/internal/drivers/codex.ts');

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';
const SAFETY_ONLY = getSafetyAndEngineeringSections('Codex', { includeCodingInstructions: false }).trim();
/**
 * P3.251 · what the channel carries when NO style is selected. It used to be
 * `SAFETY_ONLY` alone; since 2026-09-03 the codex-only runtime guidance rides
 * the same field, so the byte-identity assertions below compare against this
 * and the ORDER assertions still compare against `SAFETY_ONLY`. Composed from
 * the exports rather than restated, so a change to any of them travels here.
 *
 * P6.441 (`57ef5a032`) added the THIRD part: the shared git-attribution block,
 * from the same builder Pi and claude use, because codex never calls
 * `getSystemPrompt` and was the one runtime attributing its own way. It rides
 * with the operating guidance and ahead of the style, so it belongs to the
 * unstyled baseline — the two byte-identity controls below went red without it,
 * which is precisely what they exist to do when this channel gains a part.
 */
const UNSTYLED = [SAFETY_ONLY, CODEX_RUNTIME_GUIDANCE, gitAttributionSection(resolveGitAttribution()).trim()]
  .filter(part => part.length > 0)
  .join('\n');
/**
 * F1.791 (cbd4d7a23, 2026-10-09) — the byte-identity baseline for the WIRE in this file's
 * harness. The agent side composes `developerSections` on its own project-trust predicate,
 * bridge-independent, and this harness names an UNTRUSTED project (no `projectTrusted` flag
 * on the config), so the thread also carries the one untrusted-project section after the
 * attribution block. Composed from the export, not restated; the no-arg builder baseline
 * above stays WITHOUT it, which is what keeps the two controls below able to see a part
 * accrete on one side only. Re-derived 2026-10-10 — exactly the red the controls exist
 * to raise when this channel gains a part.
 */
const UNSTYLED_ON_THE_WIRE = `${UNSTYLED}\n${untrustedProjectPromptSection().trim()}`;
/** From the built-in `concise` style, and from nothing else in the prompt. */
const CONCISE_SENTINEL = 'then include only the context needed to act';

function agentConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    providerType: 'codex-runtime',
    model: MODEL,
    isHeadless: true,
    workspace: {
      id: 'ws-codex-output-style',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-codex-output-style',
      workspaceRootPath: '/tmp/ws-codex-output-style',
      sessionRootPath: '/tmp/ws-codex-output-style/sessions',
    } as never,
    session: {
      id: 'session-codex-output-style',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/ws-codex-output-style',
    } as never,
    runtime: codexDriver.buildRuntime({
      context: {
        connection: null,
        provider: 'codex-runtime',
        resolvedModel: MODEL,
        capabilities: { needsHttpPoolServer: false },
      },
      coreConfig: {} as never,
      hostRuntime: {} as never,
      resolvedPaths: { codexBinaryPath: '/fake/codex-app-server' } as never,
    }),
  } as BackendConfig;
}

type PrivateAgent = {
  ensureRuntime: () => Promise<void>;
  activeOutputStyle: () => { prompt: string; label: string; keepCodingInstructions: boolean } | undefined;
};

async function startAgent(): Promise<{ agent: InstanceType<typeof CodexAgent>; priv: PrivateAgent }> {
  recorded = [];
  const agent = new CodexAgent(agentConfig());
  await (agent as unknown as PrivateAgent).ensureRuntime();
  return { agent, priv: agent as unknown as PrivateAgent };
}

function firstThreadStartInstructions(): string {
  const start = recorded.find(entry => entry.method === 'thread/start');
  expect(start).toBeDefined();
  return start!.params.developerInstructions as string;
}

beforeEach(() => {
  recorded = [];
  onTurnStart = null;
});

describe('codexDeveloperInstructions — the style rides the safety block, never ahead of it', () => {
  it('appends the composed style block after the safety guidance', () => {
    const styleBlock = '\n\n## Output Style: Concise\n\nPrefer short, direct answers.\n';
    const composed = codexDeveloperInstructions(styleBlock);

    expect(composed.startsWith(SAFETY_ONLY)).toBe(true);
    expect(composed).toContain('## Output Style: Concise');
    // Order is the invariant, not mere presence: a style is response shaping and
    // must not read as outranking the safety section above it.
    expect(composed.indexOf('Interaction Boundaries')).toBeLessThan(composed.indexOf('## Output Style'));
  });

  it('NEGATIVE CONTROL — no style leaves the string byte-identical to the unstyled channel', () => {
    // P3.251 · was `SAFETY_ONLY`. The control is unchanged in what it protects
    // — a blank style must add NOTHING — and the constant it compares against
    // now includes the codex-only runtime guidance that rides the same field.
    expect(codexDeveloperInstructions()).toBe(UNSTYLED);
    expect(codexDeveloperInstructions('   ')).toBe(UNSTYLED);
  });
});

describe('CodexAgent — the selected style reaches the thread', () => {
  it('carries the style prose on thread/start when one is selected', async () => {
    selectStyle('concise');
    const { agent, priv } = await startAgent();
    try {
      const instructions = firstThreadStartInstructions();
      expect(instructions).toContain('## Output Style: Concise');
      expect(instructions).toContain(CONCISE_SENTINEL);
      // P6.37's safety carve-out travels with it, so a terse codex session keeps
      // its security warnings whole too.
      expect(instructions).toContain('security warnings');
      // The safety half is still there and still first.
      expect(instructions.startsWith(SAFETY_ONLY)).toBe(true);
      // …and the label the per-turn reminder is fed from is the same resolution.
      expect(priv.activeOutputStyle()?.label).toBe('Concise');
    } finally {
      agent.destroy();
    }
  });

  it('NEGATIVE CONTROL — the Default style adds nothing at all', async () => {
    selectStyle('default');
    const { agent, priv } = await startAgent();
    try {
      // Byte-identical, not merely "does not contain Concise": a build that
      // appended an empty `## Output Style: Default` heading would still pass a
      // sentinel check while changing every codex session's prompt bytes.
      // P3.251 · compared against `UNSTYLED`, which is `SAFETY_ONLY` plus the
      // codex-only runtime guidance that now rides the same field.
      // F1.791 · the wire baseline is `UNSTYLED_ON_THE_WIRE`: this harness's
      // project is untrusted, so the trust section rides beside the style-less
      // guidance — with no style selected the field carries exactly that.
      expect(firstThreadStartInstructions()).toBe(UNSTYLED_ON_THE_WIRE);
      // Nothing to remind about either, so the reminder stays absent.
      expect(priv.activeOutputStyle()).toBeUndefined();
    } finally {
      agent.destroy();
    }
  });

  it('BOUNDARY — an unresolvable style id adds nothing and subtracts nothing', async () => {
    selectStyle('custom:this-style-does-not-exist');
    const { agent, priv } = await startAgent();
    try {
      // F1.791 · `UNSTYLED_ON_THE_WIRE`, for the same reason the negative control
      // above reads it: the untrusted-project section rides with or without a style.
      expect(firstThreadStartInstructions()).toBe(UNSTYLED_ON_THE_WIRE);
      expect(priv.activeOutputStyle()).toBeUndefined();
    } finally {
      agent.destroy();
    }
  });
});

/**
 * P6.172 — the residue is on a channel a PACKAGED build actually writes.
 *
 * P6.36 wrote the sentence and sent it to `debug()`, which routes through
 * electron-log with the packaged main process's transports disabled outside
 * debug mode — so for a user on a shipped build it reached nobody, while
 * `output-styles.ts` makes `keep-coding-instructions: false` the DEFAULT for a
 * custom style, i.e. this is the ordinary case and not a corner.
 * `surfaceCodexOperatorNotice` is the one event family the session layer
 * persists; with no turn open it queues for the next one, which is where these
 * assertions read it.
 *
 * The negative controls are the half that stops the fix over-firing: a style
 * that resolved to NOTHING subtracts nothing, and the Default built-in has no
 * residue either.
 */
describe('P6.172 · the keep-coding-instructions residue reaches the operator, not the debug log', () => {
  type NoticeQueue = { pendingServerWarningNotices: string[] };
  const notices = (agent: unknown): string[] =>
    (agent as unknown as NoticeQueue).pendingServerWarningNotices;

  it('surfaces one durable warning naming the style and the setting', async () => {
    selectStyle('concise');
    const { agent } = await startAgent();
    try {
      const residue = notices(agent).filter(line => line.includes('OUTPUT STYLE PARTIALLY APPLIED'));
      expect(residue).toHaveLength(1);
      expect(residue[0]).toContain("'Concise'");
      expect(residue[0]).toContain('keep-coding-instructions=');
      expect(residue[0]).toContain('NOT honoured on this runtime');
    } finally {
      agent.destroy();
    }
  });

  it('says it once per runtime, not once per resolution', async () => {
    selectStyle('concise');
    const { agent, priv } = await startAgent();
    try {
      priv.activeOutputStyle();
      priv.activeOutputStyle();
      expect(notices(agent).filter(line => line.includes('OUTPUT STYLE PARTIALLY APPLIED'))).toHaveLength(1);
    } finally {
      agent.destroy();
    }
  });

  it('NEGATIVE CONTROL — the Default style has no residue to report', async () => {
    selectStyle('default');
    const { agent } = await startAgent();
    try {
      expect(notices(agent).some(line => line.includes('OUTPUT STYLE PARTIALLY APPLIED'))).toBe(false);
    } finally {
      agent.destroy();
    }
  });

  it('NEGATIVE CONTROL — an unresolvable style id subtracts nothing and says nothing', async () => {
    selectStyle('custom:this-style-does-not-exist');
    const { agent } = await startAgent();
    try {
      expect(notices(agent).some(line => line.includes('OUTPUT STYLE PARTIALLY APPLIED'))).toBe(false);
    } finally {
      agent.destroy();
    }
  });
});

/**
 * UB12.63 — a mid-session style switch reaches a codex thread on the next turn.
 *
 * Claude Code's documented delivery (`prompt-caching.md#changing-output-style`:
 * "Claude Code delivers the new style's instructions as a message in the
 * conversation"), through the runtime-neutral `core/output-style-switch.ts`
 * that UB12.21 built for claude. Codex needs it for its own reason:
 * `developerInstructions` is set when a thread opens and `turn/start` has no
 * field that replaces it, so before this row the per-turn reminder named the
 * new style while the thread still carried the old prose.
 *
 * Whole turns through `chatImpl`, so the assertions read the text codex is
 * actually handed (`turn/start`'s `input[0].text`), not a planner's return
 * value. The runtime opens through the real `thread/start` path, which is what
 * seeds the notice state; the negative arm fails if that seeding is lost.
 */
describe('UB12.63 · a mid-session output-style switch reaches the codex thread', () => {
  const NOTICE = 'Active output style:';

  async function turnText(agent: InstanceType<typeof CodexAgent>, message: string): Promise<string> {
    onTurnStart = () => queueMicrotask(() => {
      (agent as unknown as { handleNotification: (m: string, p: unknown) => void })
        .handleNotification('turn/completed', {});
    });
    for await (const _event of (agent as unknown as {
      chatImpl: (m: string) => AsyncGenerator<unknown>;
    }).chatImpl(message)) { /* drain */ }
    const starts = recorded.filter(entry => entry.method === 'turn/start');
    expect(starts.length).toBeGreaterThan(0);
    const input = starts[starts.length - 1]!.params.input as Array<{ text?: string }>;
    return input[0]!.text ?? '';
  }

  it('a switch Default → Concise delivers the Concise block on the next turn, once', async () => {
    selectStyle('default');
    const { agent } = await startAgent();
    try {
      const before = await turnText(agent, 'first message');
      expect(before).not.toContain(NOTICE);
      expect(before).not.toContain(CONCISE_SENTINEL);

      selectStyle('concise');
      const switched = await turnText(agent, 'second message');
      expect(switched).toContain(`${NOTICE} 'Concise'`);
      expect(switched).toContain('## Output Style: Concise');
      expect(switched).toContain(CONCISE_SENTINEL);
      // On the host's band, ahead of the user's own words.
      expect(switched.indexOf(NOTICE)).toBeLessThan(switched.indexOf('second message'));
      // The reminder points at the latest block, which is now the notice and
      // not the thread's developer instructions.
      expect(switched).toContain('in the latest "Output Style:" block you received');

      // Once: the next turn under the same style carries the reminder only.
      const after = await turnText(agent, 'third message');
      expect(after).not.toContain(NOTICE);
      expect(after).toContain("The 'Concise' output style is active");
    } finally {
      agent.destroy();
    }
  });

  it('NEGATIVE CONTROL — a thread opened under a style owes no notice while the style is unchanged', async () => {
    selectStyle('concise');
    const { agent } = await startAgent();
    try {
      // The thread already carries the block in its developer instructions.
      expect(firstThreadStartInstructions()).toContain(CONCISE_SENTINEL);
      for (const message of ['first message', 'second message']) {
        const text = await turnText(agent, message);
        expect(text).not.toContain(NOTICE);
        // The style is live (the reminder names it), so the absence above is
        // about the notice and not about the style failing to resolve.
        expect(text).toContain("The 'Concise' output style is active");
      }
    } finally {
      agent.destroy();
    }
  });
});
