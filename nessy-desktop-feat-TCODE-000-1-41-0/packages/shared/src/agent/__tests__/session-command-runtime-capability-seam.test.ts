/**
 * P2.298 (`/subtask`) and P2.299 (`/compact`) — the last two cells of the
 * session-command matrix P2.292 measured, and the two that needed a backend
 * file rather than a seam arm.
 *
 * ## They share a fix shape and they are NOT the same defect
 *
 * `/subtask` is **offered everywhere, implemented once**. The composer never
 * excludes it and only `PiAgent.requestSubtaskFork` exists, so on Claude, codex
 * and the remote agent the command fell out of `chatImpl` and reached the model
 * as prose. So the runtimes that cannot serve it say so, in the arm below.
 *
 * **P3.71 corrects the second half of that sentence, which used to read
 * "withdrawing the affordance would be the WEAKER answer".** It cited
 * `sub-agents.md#fork-the-current-conversation` — "You can start a fork yourself
 * with `/subtask` followed by a task, whether or not fork mode is on" — and read
 * it as a reason to keep the MENU ROW everywhere. Two things were wrong with
 * that. The doc sentence is about the TYPED form, which nothing here withdraws:
 * `/subtask <task>` still reaches this seam on every runtime. And the same Note,
 * one paragraph up on the same page, is upstream's own precedent for the
 * opposite: "When [agent view is turned off](/docs/en/agent-view#turn-off-agent-view),
 * `/subtask` isn't available and `/fork` starts the forked subagent instead" —
 * upstream takes the row out when the mechanism behind it is off rather than
 * leaving it there to refuse. The menu row is a PREFILL that types `/subtask `
 * and submits nothing, so withdrawing it removes no capability at all. The
 * refusal below is unchanged and still load-bearing (a queued replay, a stale
 * renderer catalog and a typed id all reach it); what changed is that a user can
 * no longer be led to it by the menu. `FORK_CONVERSATION_SUPPORT` is the record
 * the composer reads, and the row below ties it to this override.
 *
 * `/compact` is **declared unavailable and reachable anyway**. The declaration
 * already exists for the remote agent (`composer-capabilities.ts`
 * `compact: { manual: false, structured: false }`) and the renderer HONOURS it:
 * `slash-command-actions.ts` refuses a menu dispatch when
 * `contextUsageCapability.compact.manual === false`. But a TYPED `/compact`
 * never passes the menu — `typedOutOfBandCommandSubmission` returns null for it
 * "because they ride the normal message path" — so the user was told the
 * capability was unavailable in one channel and silently given a model's guess
 * in the other. The declaration is right; the seam is the second place it has to
 * be enforced. Nothing here removes or duplicates it.
 *
 * ## Why a predicate and not a `describeQuota`-style generator
 *
 * `describeQuota()` is a generator the capable backend overrides WHOLE, because
 * a quota read is answerable at the seam. Neither of these is: Pi's fork is an
 * RPC to a subprocess that `chatImpl` has just ensured is up, and all three
 * compaction mechanisms live inside a live turn. So the override answers a
 * narrower question — "can this runtime serve it at all" — and a `true` lets the
 * command through to `chatImpl` UNCHANGED. That is why Pi's, Claude's and
 * codex's behaviour is byte-identical before and after, and only the four cells
 * that had no mechanism change.
 *
 * Both predicates are `false` in `BaseAgent`, in `canDispatchWorkflowCommands`'s
 * shape and for its recorded reason: the failure mode of the other default is
 * SILENT — a bare `/compact` on a new backend goes to the model and reads as an
 * ordinary prompt — while the failure mode of this one is a visible refusal of a
 * command the backend could have served, which the biconditional below catches
 * anyway.
 *
 * ## Rig note
 *
 * `base-agent.ts` initialises i18next process-wide from the `/approve` and
 * `/advisor` arms, so a per-command assertion here can pass merely because a
 * neighbour ran first (P2.278 measured exactly that). Both arms added by these
 * rows emit PLAIN LITERALS and never call `t()`, so they cannot have that
 * failure mode — and this file was run BOTH whole and filtered by name to prove
 * the results are not a neighbour's side effect.
 *
 * The four REAL backend classes are instantiated, not a `TestAgent` double: the
 * arm lives in `BaseAgent`, so a double would pass by construction and prove
 * nothing about the runtimes the defect was measured on. Only `chatImpl` is
 * replaced — the same discriminator `session-command-seam.test.ts` and
 * `session-command-out-of-band-seam.test.ts` use.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';
import { ClaudeAgent } from '../claude-agent.ts';
import { CodexAgent } from '../codex-agent.ts';
import { NestorCloudAgent } from '../nestor-cloud-agent.ts';
import { PiAgent } from '../pi-agent.ts';
import type { BaseAgent } from '../base-agent.ts';
import {
  FORK_CONVERSATION_SUPPORT,
  runtimeForksConversations,
} from '../runtime-agent-support.ts';
import {
  collectEvents,
  createMockBackendConfig,
  createMockCapabilityTurnRuntime,
  createMockSession,
  createMockWorkspace,
} from './test-utils.ts';

const WORKSPACE_ID = 'ws-p2298-runtime-capability';

let sessionCounter = 0;

function backendConfig(provider: BackendConfig['provider']): BackendConfig {
  sessionCounter += 1;
  const root = mkdtempSync(join(tmpdir(), 'nessy-p2298-'));
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
      id: `session-p2298-${sessionCounter}`,
      workingDirectory: root,
    }),
  } as Partial<BackendConfig>);
}

interface Harness {
  agent: BaseAgent;
  reachedChatImpl: string[];
}

/** A real backend whose `chatImpl` throws: reaching it is the failure. */
function harness(make: () => BaseAgent): Harness {
  const agent = make();
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

function infoMessages(events: AgentEvent[]): string[] {
  return events
    .filter((event): event is Extract<AgentEvent, { type: 'info' }> => event.type === 'info')
    .map(event => event.message);
}

/**
 * The runtimes with NO mechanism for each command — the cells P2.292 measured as
 * empty. Pi is deliberately absent from both lists and is covered by the
 * fall-through pins in `session-command-out-of-band-seam.test.ts`.
 */
const REFUSES_FORK: ReadonlyArray<{ name: string; make: () => BaseAgent }> = [
  { name: 'Claude', make: () => new ClaudeAgent(backendConfig('anthropic')) as unknown as BaseAgent },
  { name: 'Codex', make: () => new CodexAgent(backendConfig('codex-runtime')) as unknown as BaseAgent },
  {
    name: 'Nestor Cloud',
    make: () => new NestorCloudAgent(backendConfig('nestor-cloud-agent')) as unknown as BaseAgent,
  },
];

const REFUSES_COMPACT: ReadonlyArray<{ name: string; make: () => BaseAgent }> = [
  {
    name: 'Nestor Cloud',
    make: () => new NestorCloudAgent(backendConfig('nestor-cloud-agent')) as unknown as BaseAgent,
  },
];

describe('P2.298 · /subtask is answered, not prompted, on a runtime that cannot fork', () => {
  for (const backend of REFUSES_FORK) {
    it(`answers /subtask at the seam on ${backend.name}`, async () => {
      const { agent, reachedChatImpl } = harness(backend.make);
      try {
        const events = await collectEvents(agent.chat('/subtask draft the tests'));

        // The whole invariant: the backend is never entered, so the model never
        // sees the command. This is what shipped as prose on all three.
        expect(reachedChatImpl).toEqual([]);
        expect(events.map(event => event.type)).toEqual(['info', 'complete']);

        const [message] = infoMessages(events);
        // The i18n guard in reverse: a `t()` here would yield `undefined` on a
        // filtered run, and an empty info line is indistinguishable from a
        // command that did nothing.
        expect(typeof message).toBe('string');
        expect(message).toContain('/subtask');
        expect(message).toContain('not available on this runtime');
        // `SessionManager` keys `compaction_complete` off this prefix.
        expect(message!.startsWith('Compacted')).toBe(false);
      } finally {
        agent.destroy();
      }
    });
  }

  it('a bare /subtask with no task is refused the same way, not treated as a usage error', async () => {
    // Pi answers a task-less `/subtask` with its own usage line, inside
    // `runSessionCommand`. A runtime that cannot fork has nothing to explain the
    // usage of, so the honest answer is the same refusal either way.
    const { agent, reachedChatImpl } = harness(REFUSES_FORK[0]!.make);
    try {
      const events = await collectEvents(agent.chat('/subtask'));
      expect(reachedChatImpl).toEqual([]);
      expect(infoMessages(events)[0]).toContain('not available on this runtime');
    } finally {
      agent.destroy();
    }
  });
});

describe('P2.299 · a typed /compact is answered, not prompted, on the remote agent', () => {
  for (const backend of REFUSES_COMPACT) {
    it(`answers /compact at the seam on ${backend.name}`, async () => {
      const { agent, reachedChatImpl } = harness(backend.make);
      try {
        const events = await collectEvents(agent.chat('/compact keep the decisions'));

        expect(reachedChatImpl).toEqual([]);
        expect(events.map(event => event.type)).toEqual(['info', 'complete']);

        const [message] = infoMessages(events);
        expect(typeof message).toBe('string');
        expect(message).toContain('/compact');
        expect(message).toContain('not available on this runtime');
        // A refusal must NOT borrow the success wording: `SessionManager` keys
        // `compaction_complete` off the "Compacted" prefix, so a refusal that
        // started with it would report a compaction that never happened and the
        // pre-plan flow would proceed on an uncompacted context.
        expect(message!.startsWith('Compacted')).toBe(false);
      } finally {
        agent.destroy();
      }
    });
  }
});

describe('P2.298/P2.299 · the arms are not swallowers', () => {
  /**
   * The boundary. `parseSessionCommand` is whole-message, so prose that merely
   * mentions either command is a prompt and must still reach the backend — an
   * arm written as a prefix test would silently eat every question about them.
   */
  for (const backend of REFUSES_FORK) {
    it(`still sends prose mentioning the commands to ${backend.name}`, async () => {
      const agent = backend.make();
      const reached: string[] = [];
      (agent as unknown as { chatImpl: (message: string) => AsyncGenerator<AgentEvent> }).chatImpl =
        async function* (message: string) {
          reached.push(message);
          yield { type: 'complete' } as AgentEvent;
        };
      agent.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime({
        workspaceId: WORKSPACE_ID,
        sessionId: agent['config'].session!.id,
      }));
      try {
        await collectEvents(agent.chat('what does /subtask do on this runtime?'));
        await collectEvents(agent.chat('explain /compact before I run it'));

        expect(reached.length).toBe(2);
      } finally {
        agent.destroy();
      }
    });
  }
});

// ============================================================
// The drift rows. Same shape as
// `runtime-capability-drift.test.ts`'s P2.212 block (workflow dispatch): the
// claim must be held by the backends that hold the MECHANISM, never by a set
// someone remembered to update. That file is the home for per-runtime capability
// drift generally; these two rows live beside their behavioural pins instead,
// and the two files are cross-referenced from `base-agent.ts`.
// ============================================================

const repoFile = (relativeToThisFile: string): string =>
  readFileSync(fileURLToPath(new URL(relativeToThisFile, import.meta.url)), 'utf8');

/**
 * The source with its COMMENTS removed and its STRING LITERALS kept — which is
 * the difference from the drift file's `codeOccurrences`, and it is deliberate:
 * two of the three compaction mechanisms are reached by a string
 * (`'thread/compact/start'`, `'subtask_start'`), so stripping literals would
 * make the mechanism invisible and the biconditional would pass by vacuum. The
 * comments must still go, because every needle below is also NAMED in a comment
 * in at least one file that does not implement it.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        if (source[i] === '\\') { out += source.slice(i, i + 2); i += 2; continue; }
        out += source[i];
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const BACKEND_SOURCES = {
  pi: '../pi-agent.ts',
  anthropic: '../claude-agent.ts',
  'codex-runtime': '../codex-agent.ts',
  'nestor-cloud-agent': '../nestor-cloud-agent.ts',
} as const;

type BackendKey = keyof typeof BACKEND_SOURCES;
const BACKEND_KEYS = Object.keys(BACKEND_SOURCES) as BackendKey[];

const codeOf = (key: BackendKey): string => stripComments(repoFile(BACKEND_SOURCES[key]));

const holders = (needles: readonly string[]): BackendKey[] =>
  BACKEND_KEYS.filter(key => needles.some(needle => codeOf(key).includes(needle))).sort();

const claimers = (override: string): BackendKey[] =>
  BACKEND_KEYS.filter(key => codeOf(key).includes(`override ${override}()`)).sort();

describe('P2.298/P2.299 · a backend claims the capability iff it holds the mechanism', () => {
  /**
   * Every compaction mechanism that exists anywhere in the product. A backend
   * that compacts by a FOURTH mechanism claims the override without matching a
   * needle and fails this row — which is the intended loud failure: add the
   * needle in the same commit as the mechanism.
   */
  const COMPACT_MECHANISMS = ['requestCompact', 'SDK_SLASH_COMMANDS', 'thread/compact/start'];

  /**
   * Every conversation-fork mechanism that exists anywhere. One member, because
   * one exists. Codex's `thread/fork` is deliberately NOT here: it re-forks the
   * thread on a config drift and continues in it, producing no background
   * subagent with its own transcript and controls, so it cannot serve
   * `/subtask`.
   */
  const FORK_MECHANISMS = ['subtask_start'];

  it('compaction: the claim and the mechanism are the same set', () => {
    const holds = holders(COMPACT_MECHANISMS);
    expect(claimers('canCompactContext')).toEqual(holds);
    // Positive controls, both directions: a needle that stopped matching, or an
    // override that stopped being spelled this way, must not read as agreement
    // by vacuum. And the set stays a PROPER subset, so the row keeps a negative
    // side to fail on.
    expect(holds.length).toBeGreaterThan(0);
    expect(holds.length).toBeLessThan(BACKEND_KEYS.length);
  });

  it('conversation forks: the claim and the mechanism are the same set', () => {
    const holds = holders(FORK_MECHANISMS);
    expect(claimers('canForkConversation')).toEqual(holds);
    expect(holds).toEqual(['pi']);
  });

  /**
   * P3.71 · the COMPOSER's copy of the same claim.
   *
   * The refusal above was correct and the row above pinned it — and `/subtask`
   * went on appearing in the composer menu on all four runtimes anyway, so the
   * only thing a user could do with the row was be told it is unavailable.
   * `FORK_CONVERSATION_SUPPORT` is the third arm, read by
   * `backend/composer-capabilities.ts`; it must answer exactly what the backends
   * do, or the menu and the seam disagree again in the direction that hurt.
   * `WORKFLOW_DISPATCH_SUPPORT` carries the identical tie one record over
   * (`runtime-capability-drift.test.ts`), which is the point: one shape, one
   * mechanism, two instances.
   */
  it('the composer record claims forks for exactly those backends too', () => {
    const holds = holders(FORK_MECHANISMS);
    const record = (Object.keys(FORK_CONVERSATION_SUPPORT) as BackendKey[])
      .filter(key => FORK_CONVERSATION_SUPPORT[key])
      .sort();

    expect(record).toEqual(holds);
    // Total over the vocabulary: a runtime added to the union must WRITE its
    // answer here, and a record that lost a key would otherwise read as
    // agreement by omission.
    expect(Object.keys(FORK_CONVERSATION_SUPPORT).sort()).toEqual([...BACKEND_KEYS].sort());
    // Positive control for both halves, and it keeps a negative side to fail on.
    expect(record.length).toBeGreaterThan(0);
    expect(record.length).toBeLessThan(BACKEND_KEYS.length);
    // `undefined` answers TRUE — a read before any session exists must not
    // report a definite unavailability from an indefinite input.
    expect(runtimeForksConversations(undefined)).toBe(true);
    expect(runtimeForksConversations('pi')).toBe(true);
    expect(runtimeForksConversations('anthropic')).toBe(false);
  });

  it('the base answers are fail-closed and the seam reads them before chatImpl', () => {
    const base = repoFile('../base-agent.ts');
    // Concrete, not abstract: a backend that overrides nothing still ANSWERS the
    // command. `false` is the safe default because the other default fails
    // silently — the bare command reaches the model and reads as a prompt.
    expect(base).toContain('protected canForkConversation(): boolean');
    expect(base).toContain('protected canCompactContext(): boolean');
    // Pinned as source because the alternative — asserting no send happened — is
    // what the behavioural blocks above do, and the two together make a re-break
    // visible from either direction.
    expect(base).toContain("sessionCommand.kind === 'subtask' && !this.canForkConversation()");
    expect(base).toContain("sessionCommand.kind === 'compact' && !this.canCompactContext()");
    // No `provider` switch crept into the seam: the whole point of the predicate
    // is that this file stays ignorant of which runtime it is serving.
    const seam = base.slice(base.indexOf("sessionCommand.kind === 'subtask'"), base.indexOf('yield* this.chatImpl('));
    expect(seam).not.toContain('config.provider');
  });
});
