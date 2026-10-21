/**
 * P6.344 — a codex turn could not ask the user a clarifying question, and the
 * reason was not codex's.
 *
 * The bridge already RECEIVED `item/tool/requestUserInput` and answered
 * `{ answers: {} }`, reporting on the degrade sink that "this runtime has no
 * question surface". It had one: the host renders the identical card for Pi and
 * for claude, through `ElicitationAskUserBridge` + `onPermissionRequest` /
 * `respondToPermission`. So native-first is satisfied twice over — codex's own
 * protocol carries the request, and the host already owns the card — and nothing
 * new is built here.
 *
 * ## What these cases pin
 *
 * The round trip, the id mapping, and the four ways it must decline WITHOUT
 * throwing. That last one is the load-bearing half: a throw inside a JSON-RPC
 * handler leaves the app-server waiting on a frame it cannot parse, which is
 * strictly worse than a declined question.
 */
import { describe, expect, it } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import type { PermissionRequest } from '@nessy-agent/core/types';
import { CodexAgent } from '../codex-agent.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-codex-ask',
      name: 'Codex Ask Workspace',
      rootPath: '/tmp/ws-codex-ask',
      workspaceRootPath: '/tmp/ws-codex-ask',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-ask',
    } as never,
    session: {
      id: 'session-codex-ask',
      workspaceRootPath: '/tmp/ws-codex-ask',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as never,
    model: 'codex/test-model',
    isHeadless: true,
  } as BackendConfig;
}

const METHOD = 'item/tool/requestUserInput';

function harness(options: { attachUser?: boolean } = {}) {
  const agent = new CodexAgent(createConfig());
  const cards: PermissionRequest[] = [];
  const degraded: string[] = [];
  const internals = agent as unknown as {
    handleServerRequest: (method: string, params: unknown) => unknown;
    onPermissionRequest?: (request: PermissionRequest) => void;
    getPermissionMode: () => string;
    debug: (message: string) => void;
    reportDegradedApproval: (reason: string) => void;
  };
  internals.debug = () => {};
  internals.reportDegradedApproval = reason => { degraded.push(reason); };
  if (options.attachUser !== false) {
    internals.onPermissionRequest = request => { cards.push(request); };
  }
  return { agent, cards, degraded, internals, destroy: () => agent.destroy() };
}

const twoQuestions = {
  threadId: 't', turnId: 'u', itemId: 'i', isBlocking: true, autoResolutionMs: null,
  questions: [
    {
      id: 'q-lang', header: 'Language', question: 'Which language?', isOther: false, isSecret: false,
      options: [{ label: 'TypeScript', description: 'the repo default' }, { label: 'Rust', description: '' }],
    },
    {
      id: 'q-scope', header: 'Scope', question: 'How wide?', isOther: true, isSecret: false,
      options: [{ label: 'This file', description: '' }, { label: 'The package', description: '' }],
    },
  ],
};

describe('P6.344 · codex asks the user, on the card the host already owns', () => {
  it('raises the same card Pi raises and answers by question ID', async () => {
    const h = harness();
    try {
      const answered = h.internals.handleServerRequest(METHOD, twoQuestions) as Promise<any>;

      expect(h.cards).toHaveLength(1);
      const card = h.cards[0]!;
      expect(card.toolName).toBe('ask_user');
      expect(card.type).toBe('ask_user');
      // The id prefix is what a log reads back — a model question filed under
      // `mcp-elicit-…` is a lie the next reader has to unlearn.
      expect(card.requestId.startsWith('codex-ask')).toBe(true);
      // Both questions travel; the legacy single-question projection carries the
      // first, so a downgraded client still renders something sane.
      expect(card.askUser?.questions?.map(q => q.question))
        .toEqual(['Which language?', 'How wide?']);
      expect(card.askUser?.question).toBe('Which language?');
      expect(card.askUser?.allowFreeText).toBe(false);

      h.agent.respondToPermission(card.requestId, true, undefined, {
        askUserAnswer: {
          type: 'batched',
          answers: { 'Which language?': 'TypeScript', 'How wide?': 'The package' },
        },
      });

      // Keyed by codex's question IDs, not by the text the card used.
      expect(await answered).toEqual({
        answers: {
          'q-lang': { answers: ['TypeScript'] },
          'q-scope': { answers: ['The package'] },
        },
      });
    } finally { h.destroy(); }
  });

  it('declines a SECRET question rather than collecting one into the transcript', async () => {
    const h = harness();
    try {
      const answered = await h.internals.handleServerRequest(METHOD, {
        ...twoQuestions,
        questions: [{ ...twoQuestions.questions[0]!, isSecret: true }],
      }) as Record<string, unknown>;
      expect(answered).toEqual({ answers: {} });
      expect(h.cards).toEqual([]);
      expect(h.degraded.join(' ')).toContain('secret');
    } finally { h.destroy(); }
  });

  it('declines with no user attached, and never throws', async () => {
    const h = harness({ attachUser: false });
    try {
      expect(await h.internals.handleServerRequest(METHOD, twoQuestions) as unknown)
        .toEqual({ answers: {} });
      expect(h.degraded.join(' ')).toContain('no user');
    } finally { h.destroy(); }
  });

  it('declines an empty request, and never throws', async () => {
    const h = harness();
    try {
      expect(await h.internals.handleServerRequest(METHOD, { questions: [] }) as unknown)
        .toEqual({ answers: {} });
      expect(await h.internals.handleServerRequest(METHOD, undefined) as unknown)
        .toEqual({ answers: {} });
    } finally { h.destroy(); }
  });

  it('declines rather than throwing when the user refuses the card', async () => {
    const h = harness();
    try {
      const answered = h.internals.handleServerRequest(METHOD, twoQuestions) as Promise<any>;
      h.agent.respondToPermission(h.cards[0]!.requestId, false);
      expect(await answered).toEqual({ answers: {} });
    } finally { h.destroy(); }
  });
});
