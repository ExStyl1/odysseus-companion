import { describe, expect, it } from 'bun:test';
import type { SessionToolContext } from '../context.ts';
import { handleBashOutput } from './bash-output.ts';

function makeContext(readBackgroundShellOutput?: SessionToolContext['readBackgroundShellOutput']): SessionToolContext {
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
    readBackgroundShellOutput,
  };
}

describe('handleBashOutput', () => {
  it('returns incremental output and next offset', async () => {
    const calls: Array<{ shellId: string; offset?: number }> = [];
    const result = await handleBashOutput(makeContext((shellId, offset) => {
      calls.push({ shellId, offset });
      return {
        shellId,
        output: 'second chunk\n',
        nextOffset: 2,
        isRunning: true,
      };
    }), {
      shell_id: 'shell_123',
      offset: 1,
    });

    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain('second chunk');
    expect(result.content[0]?.text).toContain('next_offset: 2');
    expect(calls).toEqual([{ shellId: 'shell_123', offset: 1 }]);
  });

  it('rejects unknown shell ids', async () => {
    const result = await handleBashOutput(makeContext(() => null), {
      shell_id: 'missing_shell',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Unknown shell_id');
  });
});
