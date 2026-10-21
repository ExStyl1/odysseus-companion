/**
 * P2.292 — WHICH session commands are per-backend, measured against all four
 * backends rather than assumed.
 *
 * The row this file closes proposed a 4×5 matrix: four backends × the five
 * command kinds `BaseAgent.chat` does NOT claim (`compact`, `subtask`, `btw`,
 * `recap`, `heapdump`), on the premise that all five are legitimately answered
 * per backend. **The measurement refutes the five.** Reading the four
 * `chatImpl`s and the two host guards gives:
 *
 * | kind       | Pi | Claude | Codex | Nestor Cloud | genuinely per-backend? |
 * | ---------- | -- | ------ | ----- | ------------ | ---------------------- |
 * | `compact`  | ✅ | ✅     | ✅    | ❌           | YES — three mechanisms |
 * | `subtask`  | ✅ | ❌     | ❌    | ❌           | YES — one mechanism    |
 * | `btw`      | ✅ | ❌     | ❌    | ❌           | **NO**                 |
 * | `recap`    | ✅ | ❌     | ❌    | ❌           | **NO**                 |
 * | `heapdump` | ✅ | ❌     | ❌    | ❌           | **NO**                 |
 *
 * `compact` and `subtask` really are per-backend: each runtime compacts through
 * its own mechanism (`PiAgent.requestCompact`, Claude's `SDK_SLASH_COMMANDS`
 * branch, codex's `thread/compact/start`) and only Pi can fork a conversation.
 *
 * P2.298/P2.299 then closed the four ❌ cells in those two rows — the ones this
 * file measured and could not fill without the backend sources. They are NOT
 * closed by giving the missing runtimes a mechanism (there is none to give) but
 * by an honest refusal at the seam, gated on a base-default-plus-override
 * predicate: `canForkConversation()` and `canCompactContext()`, both `false` in
 * `BaseAgent`. So the ❌ cells now mean "answered at the seam with a refusal"
 * rather than "sent to the model as prose", and the residue block below is where
 * the difference is asserted.
 *
 * The bottom three are NOT. They are answered HOST-side and out-of-band — the
 * renderer routes the typed forms (`typedOutOfBandCommandSubmission`) and
 * `SessionManager.sendMessage` throws on all three before a turn exists — so
 * NO runtime should ever see them, and `PiAgent.runSessionCommand`'s own arms
 * say exactly that in three comments ("a backstop for direct callers", "the
 * same defensive backstop as `/clear` above"). Pi carrying that backstop and
 * the other three not carrying it is the P2.278/`P3.25` defect shape one layer
 * down: a command answered on one runtime and sent to the MODEL on three.
 *
 * So the guard is shaped to the measurement, not to the 4×5 symmetry: the three
 * out-of-band kinds move to the `BaseAgent.chat` seam, where ONE arm covers
 * every backend exactly as `/clear`, `/quota`, `/advisor` and `/approve` already
 * do, and the fall-through into `chatImpl` is left carrying only the two kinds
 * that are genuinely per-backend. The wording is lifted VERBATIM from Pi's arms,
 * so Pi's user-visible answer is byte-identical before and after.
 *
 * The residue is pinned too (last describe block). It read "`/compact` and
 * `/subtask` must still reach `chatImpl` on EVERY backend" until P2.298/P2.299,
 * which is what the two ❌ cells in the table above were: the command reached a
 * `chatImpl` with no arm for it and went on to the model. Now the pin is the
 * table itself — each kind reaches `chatImpl` on exactly the runtimes that hold
 * a mechanism for it, and is refused at the seam on the rest. The honest-refusal
 * half lives in `session-command-runtime-capability-seam.test.ts`.
 *
 * ## Rig note (P2.278, and it bit this file's author too)
 *
 * `base-agent.ts` initialises i18next process-wide from the `/approve` and
 * `/advisor` arms, so a per-command assertion in this seam can pass merely
 * because a neighbour ran first. The three arms added here deliberately emit
 * PLAIN LITERALS (Pi's own strings) and never call `t()`, so they cannot depend
 * on that ordering — but the assertions below still check the message is a
 * non-empty string, and this file was run BOTH whole and filtered by name
 * (`-t btw`, `-t recap`, `-t heapdump`) to prove the results are not a
 * neighbour's side effect.
 *
 * ## Why all four backend CLASSES and not one BaseAgent double
 *
 * The arm lives in `BaseAgent`, so a `TestAgent` would pass by construction and
 * prove nothing about the runtimes the defect was measured on. Each case
 * instantiates the REAL backend class and replaces only `chatImpl` with a
 * generator that throws — the same discriminator `session-command-seam.test.ts`
 * uses for `/clear`, `/quota`, `/advisor` and `/approve`. No transport is
 * faked, because a seam-answered command never reaches one; a regression that
 * routes any of the three back into a backend fails loudly here instead of
 * silently prompting the model.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';
import { ClaudeAgent } from '../claude-agent.ts';
import { CodexAgent } from '../codex-agent.ts';
import { NestorCloudAgent } from '../nestor-cloud-agent.ts';
import { PiAgent } from '../pi-agent.ts';
import type { BaseAgent } from '../base-agent.ts';
import {
  collectEvents,
  createMockBackendConfig,
  createMockCapabilityTurnRuntime,
  createMockSession,
  createMockWorkspace,
} from './test-utils.ts';

const WORKSPACE_ID = 'ws-p2292-out-of-band';

let sessionCounter = 0;

function backendConfig(provider: BackendConfig['provider']): BackendConfig {
  sessionCounter += 1;
  const root = mkdtempSync(join(tmpdir(), 'nessy-p2292-'));
  return createMockBackendConfig({
    provider,
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: createMockWorkspace({
      id: WORKSPACE_ID,
      workspaceRootPath: root,
      sessionRootPath: join(root, 'sessions'),
    }),
    session: createMockSession({
      id: `session-p2292-${sessionCounter}`,
      workingDirectory: root,
    }),
  } as Partial<BackendConfig>);
}

/**
 * The four production backends, by CLASS. `git grep 'extends BaseAgent'` finds
 * exactly these four plus the `TestAgent` double — so this list is the whole
 * population, and a fifth runtime added without an entry here leaves its column
 * of the matrix unmeasured.
 */
const BACKENDS: ReadonlyArray<{ name: string; make: () => BaseAgent }> = [
  { name: 'Pi', make: () => new PiAgent(backendConfig('pi')) as unknown as BaseAgent },
  { name: 'Claude', make: () => new ClaudeAgent(backendConfig('anthropic')) as unknown as BaseAgent },
  { name: 'Codex', make: () => new CodexAgent(backendConfig('codex-runtime')) as unknown as BaseAgent },
  {
    name: 'Nestor Cloud',
    make: () => new NestorCloudAgent(backendConfig('nestor-cloud-agent')) as unknown as BaseAgent,
  },
];

/** The three kinds the measurement moved OFF the per-backend fall-through. */
const OUT_OF_BAND: ReadonlyArray<{ kind: string; typed: string; mentions: string }> = [
  { kind: 'btw', typed: '/btw what was that config file?', mentions: '/btw' },
  { kind: 'recap', typed: '/recap', mentions: '/recap' },
  { kind: 'heapdump', typed: '/heapdump', mentions: '/heapdump' },
];

interface Harness {
  agent: BaseAgent;
  /** Every message that reached `chatImpl`, in order. */
  reachedChatImpl: string[];
}

/**
 * A real backend whose `chatImpl` is replaced by a recorder. Two modes:
 * `'throw'` for the seam cases (a command that reaches a backend is a failure,
 * and must fail loudly rather than hang on an absent transport) and `'record'`
 * for the residue cases, where reaching `chatImpl` is the expected outcome.
 */
function harness(make: () => BaseAgent, mode: 'throw' | 'record'): Harness {
  const agent = make();
  const reachedChatImpl: string[] = [];
  (agent as unknown as { chatImpl: (message: string) => AsyncGenerator<AgentEvent> }).chatImpl =
    async function* (message: string) {
      reachedChatImpl.push(message);
      if (mode === 'throw') throw new Error(`chatImpl must not run: ${message}`);
      yield { type: 'complete' } as AgentEvent;
    };
  agent.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime({
    workspaceId: WORKSPACE_ID,
    sessionId: agent['config'].session!.id,
  }));
  return { agent, reachedChatImpl };
}

function infoMessages(events: AgentEvent[]): string[] {
  return events
    .filter((event): event is Extract<AgentEvent, { type: 'info' }> => event.type === 'info')
    .map(event => event.message);
}

describe('P2.292 · the three out-of-band commands answer at the seam on EVERY backend', () => {
  for (const backend of BACKENDS) {
    for (const command of OUT_OF_BAND) {
      it(`answers ${command.typed.split(' ')[0]} at the seam on ${backend.name}`, async () => {
        const { agent, reachedChatImpl } = harness(backend.make, 'throw');
        try {
          const events = await collectEvents(agent.chat(command.typed));

          // The whole invariant: no backend is entered, so no runtime can
          // differ, and the model never sees the command on any of them.
          expect(reachedChatImpl).toEqual([]);
          expect(events.map(event => event.type)).toEqual(['info', 'complete']);

          const [message] = infoMessages(events);
          // The i18n guard in reverse: these arms must NOT be `t()` calls, or a
          // filtered run would emit `undefined` here and an empty info line is
          // indistinguishable from a command that did nothing.
          expect(typeof message).toBe('string');
          expect(message!.length).toBeGreaterThan(0);
          expect(message).toContain(`/${command.kind}`);
          // `SessionManager` keys `compaction_complete` off this prefix.
          expect(message!.startsWith('Compacted')).toBe(false);
        } finally {
          agent.destroy();
        }
      });
    }
  }
});

describe('P2.292 · the seam arm is not a swallower', () => {
  /**
   * The boundary case. `parseSessionCommand` is whole-message, so prose that
   * merely mentions one of the three is a prompt — and it must still reach the
   * backend. Without this, an arm written as a prefix test would silently eat
   * every question about the commands.
   */
  for (const backend of BACKENDS) {
    it(`still sends prose that merely mentions the commands to ${backend.name}`, async () => {
      const { agent, reachedChatImpl } = harness(backend.make, 'record');
      try {
        await collectEvents(agent.chat('remind me what /recap and /heapdump do'));
        // `/recap the meeting` carries an argument, and `/recap` takes none —
        // so it is prose too, not a usage error swallowed by the arm.
        await collectEvents(agent.chat('/recap the meeting'));
        await collectEvents(agent.chat('/heapdump now'));

        expect(reachedChatImpl.length).toBe(3);
      } finally {
        agent.destroy();
      }
    });
  }
});

/**
 * THE MATRIX, as an assertion. The two per-backend kinds reach `chatImpl` on
 * exactly the runtimes that hold a mechanism for them — Pi compacts and forks,
 * Claude and codex compact only, the remote agent does neither — and the seam
 * refuses them everywhere else instead of letting them fall out to the model.
 *
 * Transcribed on purpose, unlike everything else in this suite: this table IS
 * the acceptance criterion of P2.292/P2.298/P2.299, so it must fail when the
 * behaviour moves, including when the move is an improvement. A backend that
 * gains a fork adds `/subtask` to its row IN THE SAME COMMIT as the
 * `canForkConversation()` override; a sixth `ParsedSessionCommand` kind claimed
 * by no arm lands in the fall-through and shows up as an extra entry here.
 */
const REACHES_CHAT_IMPL: Readonly<Record<string, readonly string[]>> = {
  Pi: ['/compact keep the decisions', '/subtask draft the tests'],
  Claude: ['/compact keep the decisions'],
  Codex: ['/compact keep the decisions'],
  'Nestor Cloud': [],
};

describe('P2.292 · the fall-through carries the per-backend kinds the backend can serve', () => {
  for (const backend of BACKENDS) {
    it(`routes exactly ${REACHES_CHAT_IMPL[backend.name]!.length} of the two into chatImpl on ${backend.name}`, async () => {
      const { agent, reachedChatImpl } = harness(backend.make, 'record');
      try {
        await collectEvents(agent.chat('/compact keep the decisions'));
        await collectEvents(agent.chat('/subtask draft the tests'));

        // BARE, not composed: the seam's own contract for a session command.
        expect(reachedChatImpl).toEqual([...REACHES_CHAT_IMPL[backend.name]!]);
      } finally {
        agent.destroy();
      }
    });
  }

  it('the four rows are the four backends, and the table is not vacuous', () => {
    // A row deleted (or a backend added without one) must fail here rather than
    // quietly narrowing the matrix — `REACHES_CHAT_IMPL[name]` would be
    // `undefined` and the loop above would throw on `.length`, which reads as a
    // crash rather than as a finding.
    expect(Object.keys(REACHES_CHAT_IMPL).sort()).toEqual(BACKENDS.map(b => b.name).sort());
    // Both directions are represented: at least one backend serves a command
    // and at least one is refused, so neither half can go green by vacuum.
    const sizes = Object.values(REACHES_CHAT_IMPL).map(kinds => kinds.length);
    expect(Math.max(...sizes)).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBe(0);
  });
});
