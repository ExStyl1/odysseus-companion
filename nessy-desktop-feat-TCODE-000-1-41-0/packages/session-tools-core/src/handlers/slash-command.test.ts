import { describe, expect, it } from 'bun:test';
import type { SessionToolContext } from '../context.ts';
import { handleSlashCommand } from './slash-command.ts';

function makeContext(dispatchSlashCommand?: SessionToolContext['dispatchSlashCommand']): SessionToolContext {
  return {
    configRoot: '/config',
    sessionId: 'session-1',
    workspacePath: '/workspace',
    sourcesPath: '/workspace/sources',
    skillsPath: '/workspace/skills',
    plansFolderPath: '/workspace/sessions/session-1/plans',
    callbacks: {
      onPlanSubmitted: () => {},
      onAuthRequest: () => {},
    },
    fs: {} as SessionToolContext['fs'],
    loadSourceConfig: () => null,
    dispatchSlashCommand,
  };
}

describe('handleSlashCommand', () => {
  it('dispatches an allowed compact command with arguments', async () => {
    const dispatched: string[] = [];
    const result = await handleSlashCommand(makeContext((command) => {
      dispatched.push(command);
      return 'compacted';
    }), {
      command: 'compact',
      arguments: 'preserve current todo list',
    });

    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe('compacted');
    expect(dispatched).toEqual(['/compact preserve current todo list']);
  });

  it('answers help without backend dispatch', async () => {
    const dispatched: string[] = [];
    const result = await handleSlashCommand(makeContext((command) => {
      dispatched.push(command);
    }), {
      command: 'help',
    });

    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain('/compact');
    expect(dispatched).toEqual([]);
  });

  it('rejects unknown slash commands', async () => {
    const dispatched: string[] = [];
    const result = await handleSlashCommand(makeContext((command) => {
      dispatched.push(command);
    }), {
      command: 'clear',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Unknown or blocked slash command');
    expect(dispatched).toEqual([]);
  });
});
