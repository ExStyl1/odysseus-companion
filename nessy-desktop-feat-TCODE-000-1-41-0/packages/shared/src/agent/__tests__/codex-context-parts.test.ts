/**
 * The PromptBuilder context parts must ride the codex turn.
 *
 * The skill LISTING (the half that makes a skill discoverable without the user
 * naming it) rides the STABLE context part — `BaseAgent.setCapabilityTurnRuntime`
 * feeds it to `PromptBuilder.setRuntimeSkills`, and every other backend delivers
 * it: Claude puts every part on the user message (`claude-agent.ts:2622`,
 * `:2668`), Pi folds stable parts into the system prefix and volatile parts onto
 * the user tail (`pi-agent.ts:7252`). Codex composed nothing, so date/time,
 * `session_state`, `<sources>`, workspace capabilities, the working directory
 * and the skill listing were absent from every codex conversation — live-measured
 * as `SKILL=NO` on codex while Pi listed the same fixture skill.
 *
 * The pinned capability block (the skill INVOCATION half) is a separate,
 * backend-agnostic mechanism that already reaches codex through
 * `BaseAgent.chat`'s effective message; it is not what these tests pin.
 */
import { describe, expect, it, afterEach } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import type { RuntimeSkillHandle } from '../../capabilities/views.ts';
import type { SessionKey } from '../../sessions/session-key.ts';
import { cleanupModeState } from '../mode-manager.ts';
import { CodexAgent } from '../codex-agent.ts';

const WORKSPACE_ID = 'ws-context';
const SESSION_ID = 'session-context';
const SESSION_KEY: SessionKey = { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID };

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: WORKSPACE_ID,
      name: 'Context Workspace',
      rootPath: '/tmp/ws-context-root',
      workspaceRootPath: '/tmp/ws-context-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-context',
    } as any,
    session: {
      id: SESSION_ID,
      workspaceRootPath: '/tmp/ws-context-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

function skillHandle(logicalName: string, description: string): RuntimeSkillHandle {
  return {
    key: `skill:ws:${logicalName}`,
    logicalName,
    description,
    selectedAsUnqualifiedAlias: true,
    resource: {
      source: 'workspace',
      scope: { kind: 'workspace', workspaceId: WORKSPACE_ID },
      resourceId: logicalName,
      absolutePath: `/abs/skills/${logicalName}`,
      revision: 'r1',
      contentHash: 'a'.repeat(64),
    },
  } as RuntimeSkillHandle;
}

/** Stand in for the app-server: record every request, settle each turn. */
function stubTransport(agent: CodexAgent): Array<{ method: string; params: any }> {
  const requests: Array<{ method: string; params: any }> = [];
  const client = {
    request(method: string, params: any) {
      requests.push({ method, params });
      if (method === 'turn/start') {
        queueMicrotask(() => (agent as any).handleNotification('turn/completed', {}));
      }
      return Promise.resolve({ thread: { id: 'thread-1' } });
    },
    notify() {},
    close() {},
  };
  (agent as any).ensureRuntime = async () => {
    (agent as any).client = client;
    (agent as any).threadId = 'thread-1';
  };
  return requests;
}

async function drain(agent: CodexAgent, prompt: string): Promise<void> {
  for await (const _event of (agent as any).chatImpl(prompt)) { /* drain */ }
}

function turnText(requests: Array<{ method: string; params: any }>, index = 0): string {
  const turns = requests.filter(entry => entry.method === 'turn/start');
  return turns[index]?.params.input[0].text as string;
}

describe('CodexAgent outgoing turn carries the PromptBuilder context parts', () => {
  afterEach(() => cleanupModeState(SESSION_KEY));

  it('delivers the skill listing and the rest of the context parts before the user text', async () => {
    cleanupModeState(SESSION_KEY);
    const agent = new CodexAgent(createConfig());
    const requests = stubTransport(agent);
    // The listing is fed from the pinned turn view, never read from disk here.
    agent.setCapabilityTurnRuntime({
      view: { skills: [skillHandle('review', 'Review a diff for correctness')] },
    } as any);

    await drain(agent, 'hello codex');

    const text = turnText(requests);
    // The skill listing — the block whose absence was measured as SKILL=NO.
    expect(text).toContain('<available_skills>');
    expect(text).toContain('- [skill:review] — Review a diff for correctness');
    // The rest of the parts every other runtime already gets.
    expect(text).toContain("USER'S DATE AND TIME:");
    expect(text).toContain('<session_state>');
    expect(text).toContain(`sessionId: ${SESSION_ID}`);
    expect(text).toContain('<sources>');
    expect(text).toContain('<workspace_capabilities>');
    expect(text).toContain('/tmp/project-root');
    // Claude's shape: parts first, the user's own text last.
    expect(text.endsWith('hello codex')).toBe(true);
    expect(text.indexOf('<available_skills>')).toBeLessThan(text.indexOf('hello codex'));

    agent.setCapabilityTurnRuntime(null);
    agent.destroy();
  });

  /**
   * P2.321 — A LATENT GUARD, DECLARED, WITH THE CONDITION THAT REVIVES IT
   * MACHINE-CHECKED.
   *
   * This case drives `chatImpl` directly, and today NO session command kind
   * reaches `chatImpl` from `chat()` on codex, so what it guards is a path a
   * user cannot take:
   *
   *  - `/subtask` is answered at the `BaseAgent.chat` seam, because
   *    `canForkConversation()` is `false` here (codex's `thread/fork` re-forks
   *    the thread and continues in it — no background subagent, so it does not
   *    claim the capability);
   *  - `/compact` DOES fall through to `chatImpl`, and is intercepted there by
   *    the `thread/compact/start` branch the case below pins — it never reaches
   *    `turn/start` at all;
   *  - every other kind is claimed by an arm of the seam, which
   *    `session-command-out-of-band-seam.test.ts` pins ("this fall-through
   *    carries those two and nothing else").
   *
   * It is kept rather than deleted for the reason the row states: the invariant
   * is real and becomes reachable again the day codex claims a fork, or the day
   * a new `ParsedSessionCommand` kind is added that no seam arm claims — that
   * new kind lands in `chatImpl` and is sent to the model, which is exactly the
   * shape driven here. An unexplained deletion is how coverage quietly shrinks.
   *
   * The reviving condition is ASSERTED rather than described, so a comment
   * cannot be what goes stale: the first line of the case fails the day codex
   * gains a fork, and points whoever is reading at this note.
   */
  it('sends a session command bare, ahead of the context that would disguise it (LATENT — see the note above)', async () => {
    // `base-agent.ts:3311-3322`: a session command "must reach the backend as
    // the bare command", because anything composed onto the front "pushes the
    // leading slash out of the backend's command branch. That is how BOTH
    // `/compact` and `/subtask` shipped reaching the model as prose."
    cleanupModeState(SESSION_KEY);
    const agent = new CodexAgent(createConfig());
    // THE TRIPWIRE. While this holds, `/subtask` is refused at the seam and the
    // rest of this case guards `chatImpl` alone; when it fails, the user-typed
    // path is live again and this case should be re-pointed at `chat()` and
    // lose both this line and its LATENT marker. The biconditional behind it —
    // "only a runtime that starts a background fork claims this" — is asserted
    // against the backend sources in
    // `session-command-runtime-capability-seam.test.ts`.
    expect((agent as any).canForkConversation()).toBe(false);
    const requests = stubTransport(agent);
    agent.setCapabilityTurnRuntime({
      view: { skills: [skillHandle('review', 'Review a diff for correctness')] },
    } as any);
    // Hook directives prepend too, so they are the same defect class: the slash
    // has to survive them as well.
    agent.setAutomationSystem({
      async executeAgentEvent(event: string) {
        if (event === 'SessionStart') {
          return { matchedCount: 1, decision: { additionalContext: 'Session directive' } };
        }
        if (event === 'UserPromptSubmit') {
          return { matchedCount: 1, decision: { additionalContext: 'Prompt directive' } };
        }
        return { matchedCount: 1 };
      },
    } as any);

    // `/subtask` rather than `/compact`: since F3 a codex `/compact` is not a
    // turn at all (`thread/compact/start` — asserted below), so it can no
    // longer carry the invariant this test exists for.
    await drain(agent, '/subtask investigate the flake');

    const text = turnText(requests);
    expect(text).toBe('/subtask investigate the flake');
    expect(text).not.toContain('<available_skills>');
    expect(text).not.toContain('<session_state>');

    agent.setAutomationSystem(undefined);
    agent.setCapabilityTurnRuntime(null);
    agent.destroy();
  });

  it('sends /compact as a request, not as a turn', async () => {
    // The affordance the composer offers has to DO something. As prose it asked
    // the model to talk about compaction; `thread/compact/start` is the
    // app-server's own method, confirmed present in the bundled binary's
    // client-request table beside `thread/start` and `thread/fork`.
    cleanupModeState(SESSION_KEY);
    const agent = new CodexAgent(createConfig());
    const requests = stubTransport(agent);

    await drain(agent, '/compact');

    expect(requests.some(r => r.method === 'turn/start')).toBe(false);
    const compact = requests.find(r => r.method === 'thread/compact/start');
    expect(compact).toBeDefined();
    expect(compact!.params).toEqual({ threadId: 'thread-1' });

    agent.destroy();
  });

  it('sends clean text with no empty scaffolding when no capability runtime is set', async () => {
    cleanupModeState(SESSION_KEY);
    const agent = new CodexAgent(createConfig());
    const requests = stubTransport(agent);

    await drain(agent, 'plain turn');

    const text = turnText(requests);
    // No runtime skills → no listing block at all, not an empty one.
    expect(text).not.toContain('available_skills');
    // Parts are joined with exactly one blank line; an empty part would show up
    // as a doubled separator or a leading/trailing blank.
    expect(text).not.toContain('\n\n\n');
    expect(text).toBe(text.trim());
    expect(text.endsWith('plain turn')).toBe(true);
    // The invariant parts still ride the turn.
    expect(text).toContain('<session_state>');
    expect(text).toContain('<workspace_capabilities>');

    agent.destroy();
  });
});
