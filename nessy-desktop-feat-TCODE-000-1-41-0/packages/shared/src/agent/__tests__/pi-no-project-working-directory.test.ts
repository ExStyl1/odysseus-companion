/**
 * F1.907 — a Pi session with no project is not told the SESSION folder as its
 * working directory.
 *
 * Pi's process and file tools run in the workspace root there (`resolvedCwd`,
 * `BaseAgent.workingDirectory`), while the session folder is managed storage
 * the file floor refuses. The host block named the session folder, so the model
 * aimed `Write` at a refused folder and fell back to Bash. The owner's choice
 * (A2, 2026-09-26): drop the host's session-folder block for Pi and let Pi's
 * own `Current working directory:` line — re-appended by the subprocess
 * adapter from `event.systemPromptOptions.cwd` — name the folder, with one
 * pathless sentence for where plans and attachments live.
 *
 * Asserted at the delivery boundary, the `{ type: 'prompt', systemPrompt }` RPC
 * PiAgent hands its subprocess (the harness of `pi-child-system-prompt.test.ts`).
 */
import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import { PI_NO_PROJECT_WORKING_DIRECTORY_CONTEXT } from '../core/prompt-builder.ts';
import { getSessionDirPath } from '../../sessions/storage.ts';

const WORKSPACE_ID = 'ws-f1907';
const SESSION_ID = 'f1907-session';
const WORKSPACE_ROOT = '/tmp/nessy-f1907-workspace';

function createConfig(workingDirectory: string | undefined): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: WORKSPACE_ID,
      name: 'F1.907 Workspace',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `/tmp/nessy-f1907-sessions/${WORKSPACE_ID}`,
    } as never,
    session: {
      id: SESSION_ID,
      workspaceRootPath: WORKSPACE_ROOT,
      ...(workingDirectory ? { workingDirectory } : {}),
      createdAt: 0,
      lastUsedAt: 0,
    } as never,
    isHeadless: true,
  } as BackendConfig;
}

/** Drive one real turn; return the system prompt sent and the agent's own builder. */
async function captureTurn(workingDirectory: string | undefined) {
  const agent = new PiAgent(createConfig(workingDirectory));
  const sent: Array<Record<string, unknown>> = [];
  const internals = agent as unknown as Record<string, unknown>;
  internals.ensureSubprocess = async () => {};
  internals.send = (message: Record<string, unknown>) => { sent.push(message); };
  internals.emitAutomationEvent = async () => {};
  internals.syncExecutionManifestForCurrentTurn = async () => ({
    snapshotGeneration: 'generation-1',
    manifestHash: 'hash-1',
    tools: [],
    deferredMcp: { candidatePiNames: [] },
  });
  const queue = internals.eventQueue as Record<string, unknown>;
  queue.reset = () => {};
  queue.drain = async function* () { yield { type: 'complete' }; };

  try {
    for await (const _event of (agent as unknown as {
      chatImpl(message: string): AsyncGenerator<unknown>
    }).chatImpl('write notes.md here')) { /* drain */ }
    const prompt = sent.find(message => message.type === 'prompt');
    expect(prompt).toBeDefined();
    return {
      systemPrompt: prompt!.systemPrompt as string,
      defaultStable: agent.getPromptBuilder().buildStableContextParts().join('\n\n'),
    };
  } finally {
    agent.destroy();
  }
}

describe('F1.907 · the folder a no-project Pi session is told', () => {
  it('drops the session-folder block and says, without a path, where plans and attachments live', async () => {
    const sessionDir = getSessionDirPath(WORKSPACE_ID, SESSION_ID);
    const { systemPrompt } = await captureTurn(undefined);

    expect(systemPrompt).not.toContain('<working_directory>');
    expect(systemPrompt).not.toContain(`${sessionDir}</working_directory>`);
    expect(systemPrompt).not.toContain("This is the session's root folder");
    expect(systemPrompt).toContain(PI_NO_PROJECT_WORKING_DIRECTORY_CONTEXT);
    // Pathless by construction: the folder itself comes from Pi's own line.
    expect(PI_NO_PROJECT_WORKING_DIRECTORY_CONTEXT.replace(/<\/?working_directory_context>/g, '')).not.toContain('/');
    expect(PI_NO_PROJECT_WORKING_DIRECTORY_CONTEXT).toContain('Current working directory:');
  });

  it('keeps the project block for a project-bound Pi session, and the session-folder block for the other runtimes', async () => {
    const project = await captureTurn('/tmp/nessy-f1907-project');
    expect(project.systemPrompt).toContain('<working_directory>/tmp/nessy-f1907-project</working_directory>');
    expect(project.systemPrompt).not.toContain(PI_NO_PROJECT_WORKING_DIRECTORY_CONTEXT);

    // The same builder's default call — what claude and codex compose — still
    // names the session folder: claude's process runs there (D1.141).
    const noProject = await captureTurn(undefined);
    expect(noProject.defaultStable).toContain(
      `<working_directory>${getSessionDirPath(WORKSPACE_ID, SESSION_ID)}</working_directory>`,
    );
    expect(noProject.defaultStable).toContain("This is the session's root folder");
  });
});
