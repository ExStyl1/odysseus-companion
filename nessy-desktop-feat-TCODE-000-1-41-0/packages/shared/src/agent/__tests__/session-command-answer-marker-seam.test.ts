/**
 * D1.245 · a session command's ANSWER is marked at the seam, so the host can
 * keep it beside the question.
 *
 * ## The defect, measured before the decision
 *
 * On the packaged 1.39.0 (`RS-46`) `/help` and `/status` rendered in the chat
 * pane and produced NO row in `getSessionMessages`, while the user's own line
 * persisted — so scrolling back showed the question and nothing after it, which
 * reads as a command that did nothing rather than as an answer that was not
 * kept. D1.209 stated the opposite posture and named exactly what would change
 * it: a marker this seam sends plus one clause in `SessionManager`'s
 * `case 'info'`, *"and a marker nothing reads is the inert-field defect this
 * repo has shipped once, so neither half lands alone"*.
 *
 * This file is the SEAM half. The host half — that the clause appends a durable
 * row for a marked event and for nothing else — is
 * `packages/server-core/src/sessions/__tests__/session-command-answer-persistence.test.ts`,
 * and the two landed in one commit for the reason quoted above.
 *
 * ## The control is the case that matters
 *
 * Marking every seam `info` would satisfy a positive-only test just as well and
 * would put an unsolicited, falsifiable notice into the transcript — which is
 * the direction `SessionManager.recordSessionInfoEntry`'s posture rule exists
 * to prevent. So `/clear`'s answer, a seam `info` on the same code path that
 * reports a state CHANGE rather than answering a question, is asserted UNMARKED.
 *
 * Rig: `session-command-help-seam.test.ts`'s, and for its reason — the arms
 * live in `BaseAgent`, so a `TestAgent` double would pass by construction. The
 * REAL `PiAgent` is instantiated and only `chatImpl` is replaced, by a recorder
 * that throws: a regression that routes any of these back into a backend fails
 * loudly instead of silently prompting a model.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';
import { PiAgent } from '../pi-agent.ts';
import type { BaseAgent } from '../base-agent.ts';
import {
  collectEvents,
  createMockBackendConfig,
  createMockCapabilityTurnRuntime,
  createMockSession,
  createMockWorkspace,
} from './test-utils.ts';

const WORKSPACE_ID = 'ws-d1245-answer-marker';

let sessionCounter = 0;

function harness(): { agent: BaseAgent; reachedChatImpl: string[] } {
  sessionCounter += 1;
  const root = mkdtempSync(join(tmpdir(), 'nessy-d1245-'));
  const config = createMockBackendConfig({
    provider: 'pi',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: createMockWorkspace({
      id: WORKSPACE_ID,
      workspaceRootPath: root,
      sessionRootPath: join(root, 'sessions'),
    }),
    session: createMockSession({
      id: `session-d1245-${sessionCounter}`,
      workingDirectory: root,
    }),
  } as Partial<BackendConfig>);
  const agent = new PiAgent(config) as unknown as BaseAgent;
  const reachedChatImpl: string[] = [];
  (agent as unknown as { chatImpl: (message: string) => AsyncGenerator<AgentEvent> }).chatImpl =
    async function* (message: string) {
      reachedChatImpl.push(message);
      throw new Error(`chatImpl must not run: ${message}`);
    };
  agent.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime({
    workspaceId: WORKSPACE_ID,
    sessionId: agent['config'].session!.id,
  }));
  return { agent, reachedChatImpl };
}

type InfoEvent = Extract<AgentEvent, { type: 'info' }>;

async function infos(command: string): Promise<InfoEvent[]> {
  const { agent, reachedChatImpl } = harness();
  const events = await collectEvents(agent.chat(command));
  // The same discriminator every seam suite uses: an answer that reached a
  // backend is a different defect and must not read as a passing case here.
  expect(reachedChatImpl).toEqual([]);
  return events.filter((event): event is InfoEvent => event.type === 'info');
}

describe('D1.245 · the six READ answers carry the marker', () => {
  // The four seam reads plus the two the row names. `/diff` runs git in a fresh
  // temp directory and answers "not a repository", which is still an ANSWER and
  // is the arm's ordinary path here.
  for (const command of ['/help', '/status', '/quota', '/mcp', '/diff', '/hooks']) {
    it(`${command} is marked as an answer`, async () => {
      const answered = await infos(command);
      expect(answered.length).toBeGreaterThan(0);
      // EVERY info the arm yields, not merely the first: `/quota` answers
      // through a sub-generator whose per-runtime overrides never set the field
      // themselves, and a marker applied to only the first event would leave a
      // multi-event answer half-kept.
      expect(answered.map(event => event.answersSessionCommand === true))
        .toEqual(answered.map(() => true));
      expect(answered.every(event => event.message.length > 0)).toBe(true);
    });
  }
});

describe('D1.245 · the control — a seam info that is not an answer stays unmarked', () => {
  it('/clear reports a state CHANGE and is not marked', async () => {
    const answered = await infos('/clear');
    expect(answered.length).toBeGreaterThan(0);
    // Marking every seam `info` would pass the six cases above and would also
    // put unsolicited, falsifiable notices into the transcript. `/clear`'s
    // sentence is the nearest neighbour on the same path, so it is the control.
    //
    // D1.279 stamped the three OTHER mutating commands and deliberately left
    // this one, so the control is now load-bearing twice over: the reason is
    // mechanical, not a judgement about the sentence. `SessionManager` empties
    // `managed.messages` at the COMPLETION of a `/clear` turn, so a row the
    // clause appended would be erased by the turn that created it.
    expect(answered.some(event => event.answersSessionCommand === true)).toBe(false);
  });
});

/**
 * D1.279 · the three MUTATING commands whose answers were HALF-kept.
 *
 * D1.245 left `/config`, `/advisor` and `/approve` unstamped on the worry that
 * some of them already reached the durable channel through
 * `SessionManager.recordSessionInfoEntry` — measured, none of them does; that is
 * a `SessionManager` method and these arms run inside the agent. What they had
 * was the `level: 'warning'` arm of `case 'info'`, which sits AHEAD of the
 * `answersSessionCommand` clause and persists a warning with its level. So
 * `/advisor`'s refusals were kept and its plain statuses were not, and
 * `/approve`'s codex success was kept while every other runtime's explanation of
 * why the command does not apply was dropped.
 *
 * The cases below assert the marker on EVERY info a command yields, for the
 * reason the six READS do: an answer that arrives as several events must not be
 * half-kept, which is the exact defect being closed.
 */
describe('D1.279 · a confirmation of a mutation is kept beside its question', () => {
  for (const command of ['/config', '/advisor', '/approve']) {
    it(`${command} is marked as an answer`, async () => {
      const answered = await infos(command);
      expect(answered.length).toBeGreaterThan(0);
      expect(answered.map(event => event.answersSessionCommand === true))
        .toEqual(answered.map(() => true));
      expect(answered.every(event => event.message.length > 0)).toBe(true);
    });
  }

  it('a WRITE form is marked too, not only the read form', async () => {
    // `/config` is a listing with no key, a read with a key, and a write with a
    // value. The write is the arm the row is really about — a confirmation of a
    // mutation — and it is the one a read-only test would never reach.
    const answered = await infos('/config memory=false');
    expect(answered.length).toBeGreaterThan(0);
    expect(answered.every(event => event.answersSessionCommand === true)).toBe(true);
  });

  it('the seam, not the sub-generator: /advisor on is marked as well as bare /advisor', async () => {
    // `describeAdvisor` has seven arms across two levels and none of them knows
    // it is answering a typed command; `approveGuardianDenial` is OVERRIDDEN by
    // codex. Marking at the seam is what makes an override impossible to forget.
    const answered = await infos('/advisor on');
    expect(answered.length).toBeGreaterThan(0);
    expect(answered.every(event => event.answersSessionCommand === true)).toBe(true);
  });
});
