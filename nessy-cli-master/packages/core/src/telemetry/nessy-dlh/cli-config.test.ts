import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../config/config.js';
import type { DlhAgentEvent } from './dlh-types.js';
import { NessyDlh } from './nessy-dlh.js';
import { sendDlhEvents } from './dlh-client.js';
import { DiscoveredMCPTool } from '../../tools/mcp-tool.js';

vi.mock('../../tools/mcp-tool.js', () => {
  class DiscoveredMCPTool {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
  }
  return { DiscoveredMCPTool };
});

vi.mock('./dlh-client.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./dlh-client.js')>();
  return { ...mod, sendDlhEvents: vi.fn() };
});

const MockDiscoveredMCPTool = DiscoveredMCPTool as unknown as new (
  name: string,
) => DiscoveredMCPTool;

interface CliConfigPayloadJson {
  model: string;
  approval_mode: string;
  core_tools_enabled: string | null;
  mcp_servers: string;
  mcp_servers_count: number;
  mcp_tools: string | null;
  mcp_tools_count: number | null;
  skills: string | null;
  subagents: string | null;
  servers_json: string;
  completed?: boolean;
}

interface RegistryOverrides {
  tools?: DiscoveredMCPTool[];
}

function createConfig(overrides: RegistryOverrides = {}): Config {
  return {
    getSessionId: () => 'session-1',
    getModel: () => 'test-model',
    getSandbox: () => false,
    getCoreTools: () => ['bash', 'file'],
    getApprovalMode: () => 'default',
    getDebugMode: () => false,
    getTruncateToolOutputThreshold: () => 100_000,
    getTruncateToolOutputLines: () => 1_000,
    getMcpServers: () => ({ github: {}, docs: {} }),
    getTelemetryEnabled: () => false,
    getFileFilteringRespectGitIgnore: () => false,
    getOutputFormat: () => 'text',
    getIdeMode: () => false,
    getShouldUseNodePtyShell: () => false,
    getHookSystem: () => undefined,
    getChannel: () => 'cli',
    isInteractive: () => false,
    isMcpServerDisabled: () => false,
    isMcpServerPendingApproval: () => false,
    getToolRegistry: () => ({
      getAllTools: () => overrides.tools ?? [],
      getTool: () => undefined,
    }),
  } as unknown as Config;
}

function sentEvent(): DlhAgentEvent {
  const event = vi.mocked(sendDlhEvents).mock.calls[0][0][0] as {
    type: 'event';
    data: DlhAgentEvent;
  };
  return event.data;
}

function sentPayload(data: DlhAgentEvent): CliConfigPayloadJson {
  return JSON.parse(data.payload_json) as CliConfigPayloadJson;
}

describe('NessyDlh.logToolsSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits a cli_config event with the connected contract inventory', () => {
    const dlh = new NessyDlh(createConfig());
    dlh.logToolsSnapshot();

    expect(sendDlhEvents).toHaveBeenCalledTimes(1);
    const data = sentEvent();
    expect(data.type).toBe('cli_config');
    expect(data.session_id).toBe('session-1');

    const payload = sentPayload(data);
    expect(payload.mcp_servers).toBe('github,docs');
    expect(payload.mcp_servers_count).toBe(2);
    expect(payload.core_tools_enabled).toBe('bash,file');
    expect(payload.model).toBe('test-model');

    const servers = JSON.parse(payload.servers_json) as Array<
      Record<string, unknown>
    >;
    expect(servers).toHaveLength(2);
    expect(servers[0]).toMatchObject({ name: 'github', disabled: false });
  });

  it('includes discovered MCP tools in the snapshot', () => {
    const dlh = new NessyDlh(
      createConfig({
        tools: [new MockDiscoveredMCPTool('dpJira|dp_jira_create')],
      }),
    );
    dlh.logToolsSnapshot();

    const payload = sentPayload(sentEvent());
    expect(payload.mcp_tools).toBe('dpJira|dp_jira_create');
    expect(payload.mcp_tools_count).toBe(1);
  });

  it('emits a session_ended event on normal shutdown', () => {
    const dlh = new NessyDlh(createConfig());
    dlh.logSessionEnd();

    const data = sentEvent();
    expect(data.type).toBe('session_ended');
    expect(data.session_id).toBe('session-1');
    expect(sentPayload(data)).toEqual({ completed: true });
  });
});
