import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  RPC_CHANNELS,
  type SkillMarketplaceItem,
} from '@craft-agent/shared/protocol';
import type {
  HandlerFn,
  RequestContext,
  RpcServer,
} from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';

const mockGetWorkspaceByNameOrId = mock((workspaceId?: string) => ({
  id: workspaceId ?? 'workspace-1',
  rootPath: `/tmp/${workspaceId ?? 'workspace-1'}`,
}));
const marketplaceSkills: Array<
  Omit<SkillMarketplaceItem, 'installed' | 'installedScopes'>
> = [
  {
    id: 'bailian-cli',
    slug: 'bailian-cli',
    name: 'Bailian CLI',
    tagline: 'Test skill',
    description: 'Test skill',
    iconKey: 'internal-skill',
    sourceUrl: 'https://example.test/bailian-cli',
    installSource: 'modelstudio/bailian-cli',
    detailsId: 'skl_v1_bailian_cli',
    examples: [],
  },
];
const mockMarketplaceClient = {
  listSkills: mock(async () => ({
    items: marketplaceSkills,
    total: 1,
    page: 1,
    pageSize: 100,
  })),
  getSkill: mock(async (skillId: string) => {
    const skill = marketplaceSkills.find((item) => item.id === skillId);
    if (!skill) throw new Error('Skill not found');
    return skill;
  }),
};

mock.module('@craft-agent/shared/config', () => ({
  getWorkspaceByNameOrId: mockGetWorkspaceByNameOrId,
}));

mock.module('../../services/internal-marketplace', () => ({
  createInternalMarketplaceClient: () => mockMarketplaceClient,
}));

import { registerSkillsHandlers } from './skills';

function createTestHarness(workspaceId = 'workspace-1') {
  const handlers = new Map<string, HandlerFn>();
  const pushCalls: Array<{
    channel: string;
    target: unknown;
    args: unknown[];
  }> = [];
  const refreshAvailableCommands = mock(async () => ({
    success: true,
    availableCommands: [{ name: 'old:command' }],
    availableSkills: ['old-skill'],
  }));
  const installNessySkill = mock(async (..._args: unknown[]) => ({
    success: true,
    skill: {
      id: 'bailian-cli',
      slug: 'bailian-cli',
      installed: true,
    },
    availableCommands: [{ name: 'old:command' }],
    availableSkills: ['old-skill'],
  }));
  const deleteNessySkill = mock(async () => ({
    success: true,
    skill: {
      slug: 'bailian-cli',
      deleted: true,
    },
    availableCommands: [{ name: 'old:command' }],
    availableSkills: ['old-skill'],
  }));

  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    push(channel, target, ...args) {
      pushCalls.push({ channel, target, args });
    },
    async invokeClient() {
      return undefined;
    },
  };

  const infoLogs: string[] = [];

  const deps: HandlerDeps = {
    sessionManager: {
      refreshAvailableCommands,
      installNessySkill,
      deleteNessySkill,
    } as unknown as HandlerDeps['sessionManager'],
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
    platform: {
      appRootPath: '/',
      resourcesPath: '/',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: {
        info: (message: string) => {
          infoLogs.push(message);
        },
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
  };

  registerSkillsHandlers(server, deps);

  const listMarketplace = handlers.get(RPC_CHANNELS.skills.MARKETPLACE_LIST);
  const getMarketplace = handlers.get(RPC_CHANNELS.skills.MARKETPLACE_GET);
  const installMarketplace = handlers.get(
    RPC_CHANNELS.skills.MARKETPLACE_INSTALL,
  );
  const deleteSkill = handlers.get(RPC_CHANNELS.skills.DELETE);
  if (
    !listMarketplace ||
    !getMarketplace ||
    !installMarketplace ||
    !deleteSkill
  ) {
    throw new Error('Marketplace skill handlers not registered');
  }

  const ctx: RequestContext = {
    clientId: 'client-1',
    workspaceId,
    webContentsId: 101,
  };

  return {
    ctx,
    infoLogs,
    listMarketplace,
    getMarketplace,
    installMarketplace,
    deleteSkill,
    deleteNessySkill,
    installNessySkill,
    pushCalls,
    refreshAvailableCommands,
  };
}

// [nessy-fork] desktop-skill-scope-management
// [nessy-fork] desktop-skill-marketplace-install-state
describe('registerSkillsHandlers marketplace', () => {
  beforeEach(() => {
    mockGetWorkspaceByNameOrId.mockClear();
    mockMarketplaceClient.listSkills.mockClear();
    mockMarketplaceClient.getSkill.mockClear();
  });

  it('passes pagination and query to the marketplace client', async () => {
    const { ctx, listMarketplace } = createTestHarness('workspace-search');

    await listMarketplace(
      ctx,
      'workspace-search',
      '/tmp/workspace-search',
      'session-1',
      2,
      15,
      'whiteboard',
    );

    expect(mockMarketplaceClient.listSkills).toHaveBeenCalledWith({
      page: 2,
      pageSize: 15,
      query: 'whiteboard',
    });
  });

  it('reports project and user installations independently', async () => {
    const { ctx, listMarketplace, refreshAvailableCommands } =
      createTestHarness('workspace-scopes');
    refreshAvailableCommands.mockImplementation(async () => ({
      success: true,
      availableCommands: [],
      availableSkills: [],
      scopedSkillDetails: [
        {
          name: 'bailian-cli',
          description: 'Test skill',
          level: 'project' as const,
        },
        {
          name: 'bailian-cli',
          description: 'Test skill',
          level: 'user' as const,
        },
      ],
    }));

    const result = (await listMarketplace(
      ctx,
      'workspace-scopes',
      '/tmp/workspace-scopes',
      'session-1',
    )) as { items: SkillMarketplaceItem[]; total: number };

    expect(result.items[0]?.installedScopes).toEqual(['project', 'global']);
  });

  it('matches managed skills by canonical id when names collide', async () => {
    const duplicate = {
      ...marketplaceSkills[0]!,
      id: 'bailian-cli-copy',
      slug: 'bailian-cli-copy',
      detailsId: 'skl_v1_bailian_cli_copy',
    };
    marketplaceSkills.push(duplicate);
    const { ctx, listMarketplace, refreshAvailableCommands } =
      createTestHarness('workspace-managed-identity');
    refreshAvailableCommands.mockImplementation(async () => ({
      success: true,
      availableCommands: [],
      availableSkills: [],
      scopedSkillDetails: [
        {
          name: 'bailian-cli',
          level: 'user' as const,
          managedSkillId: 'skl_v1_bailian_cli',
          filePath: '/home/user/.nessy/skills/bailian-cli/SKILL.md',
        },
      ],
    }));

    try {
      const result = (await listMarketplace(
        ctx,
        'workspace-managed-identity',
        '/tmp/workspace-managed-identity',
        'session-1',
      )) as { items: SkillMarketplaceItem[] };

      expect(result.items[0]?.installedScopes).toEqual(['global']);
      expect(result.items[1]?.installedScopes).toEqual([]);
    } finally {
      marketplaceSkills.pop();
    }
  });

  it('does not match a different manual skill by name alone', async () => {
    const { ctx, listMarketplace, refreshAvailableCommands } =
      createTestHarness('workspace-manual-identity');
    refreshAvailableCommands.mockImplementation(async () => ({
      success: true,
      availableCommands: [],
      availableSkills: [],
      scopedSkillDetails: [
        {
          name: 'bailian-cli',
          description: 'A manually created skill with the same name',
          level: 'user' as const,
        },
      ],
    }));

    const result = (await listMarketplace(
      ctx,
      'workspace-manual-identity',
      '/tmp/workspace-manual-identity',
      'session-1',
    )) as { items: SkillMarketplaceItem[] };

    expect(result.items[0]?.installedScopes).toEqual([]);
  });

  it('keeps both scopes when installing a project copy of a user skill', async () => {
    const { ctx, installMarketplace, pushCalls, refreshAvailableCommands } =
      createTestHarness('workspace-duplicate-scopes');
    refreshAvailableCommands.mockImplementation(async () => ({
      success: true,
      availableCommands: [],
      availableSkills: ['bailian-cli'],
      scopedSkillDetails: [
        {
          name: 'bailian-cli',
          description: 'Test skill',
          level: 'user' as const,
        },
      ],
    }));

    await installMarketplace(
      ctx,
      'workspace-duplicate-scopes',
      'bailian-cli',
      '/tmp/workspace-duplicate-scopes',
      'session-1',
      'project',
    );

    const changed = pushCalls.find(
      (call) => call.channel === RPC_CHANNELS.skills.CHANGED,
    );
    const pushedSkills = changed?.args[1] as
      | Array<{ slug: string; providerLevel?: string }>
      | undefined;
    expect(
      pushedSkills
        ?.filter((skill) => skill.slug === 'bailian-cli')
        .map((skill) => skill.providerLevel),
    ).toEqual(['user', 'project']);
  });

  it('keeps an installed marketplace skill marked installed when discovery is stale', async () => {
    const {
      ctx,
      listMarketplace,
      installMarketplace,
      installNessySkill,
      pushCalls,
    } = createTestHarness('workspace-stale-install');

    const beforeResult = (await listMarketplace(
      ctx,
      'workspace-stale-install',
      '/tmp/workspace-stale-install',
      'session-1',
    )) as { items: SkillMarketplaceItem[]; total: number };
    expect(
      beforeResult.items.find((skill) => skill.id === 'bailian-cli')?.installed,
    ).toBe(false);

    await installMarketplace(
      ctx,
      'workspace-stale-install',
      'bailian-cli',
      '/tmp/workspace-stale-install',
      'session-1',
    );

    const afterResult = (await listMarketplace(
      ctx,
      'workspace-stale-install',
      '/tmp/workspace-stale-install',
      'session-1',
    )) as { items: SkillMarketplaceItem[]; total: number };

    expect(installNessySkill).toHaveBeenCalled();
    expect(installNessySkill.mock.calls[0]?.[1]).toMatchObject({
      scope: 'project',
      sourceUrl: 'modelstudio/bailian-cli',
    });
    const changed = pushCalls.find(
      (call) => call.channel === RPC_CHANNELS.skills.CHANGED,
    );
    const pushedSkills = changed?.args[1] as
      | Array<{ slug: string }>
      | undefined;
    expect(pushedSkills?.some((skill) => skill.slug === 'bailian-cli')).toBe(
      true,
    );
    expect(
      afterResult.items.find((skill) => skill.id === 'bailian-cli')?.installed,
    ).toBe(true);
  });

  it('honours a project install made outside desktop', async () => {
    // Installed by the CLI: ACP reports the frontmatter title while the folder
    // keeps the catalog's address name.
    const { ctx, listMarketplace, refreshAvailableCommands } =
      createTestHarness('workspace-external-install');
    refreshAvailableCommands.mockImplementation(async () => ({
      success: true,
      availableCommands: [],
      availableSkills: [],
      scopedSkillDetails: [
        {
          name: 'Bailian CLI',
          level: 'project' as const,
          filePath: '/tmp/workspace-external/.nessy/skills/bailian-cli/SKILL.md',
        },
      ],
    }));

    const result = (await listMarketplace(
      ctx,
      'workspace-external-install',
      '/tmp/workspace-external-install',
      'session-1',
    )) as { items: SkillMarketplaceItem[] };

    expect(result.items[0]?.installedScopes).toEqual(['project']);
  });

  // [nessy-fork] desktop-skill-parse-error-display
  it('surfaces a validation error on the installed catalog entry', async () => {
    const { ctx, listMarketplace, refreshAvailableCommands } =
      createTestHarness('workspace-parse-error');
    refreshAvailableCommands.mockImplementation(async () => ({
      success: true,
      availableCommands: [],
      availableSkills: [],
      scopedSkillDetails: [
        // Unparseable frontmatter: no description reaches Desktop, and the
        // name falls back to the install directory.
        {
          name: 'bailian-cli',
          level: 'project' as const,
          filePath: '/tmp/workspace-parse-error/.nessy/skills/bailian-cli/SKILL.md',
          parseError: 'Failed to parse skill file: Missing "description"',
        },
      ],
    }));

    const result = (await listMarketplace(
      ctx,
      'workspace-parse-error',
      '/tmp/workspace-parse-error',
      'session-1',
    )) as { items: SkillMarketplaceItem[] };

    expect(result.items[0]?.installed).toBe(true);
    expect(result.items[0]?.parseError).toBe(
      'Failed to parse skill file: Missing "description"',
    );
  });

  it('leaves a skill that is not installed free of a validation error', async () => {
    const { ctx, listMarketplace, refreshAvailableCommands } =
      createTestHarness('workspace-parse-error-unrelated');
    refreshAvailableCommands.mockImplementation(async () => ({
      success: true,
      availableCommands: [],
      availableSkills: [],
      scopedSkillDetails: [
        {
          name: 'some-other-skill',
          level: 'project' as const,
          filePath: '/tmp/other/.nessy/skills/some-other-skill/SKILL.md',
          parseError: 'Failed to parse skill file: Missing "description"',
        },
      ],
    }));

    const result = (await listMarketplace(
      ctx,
      'workspace-parse-error-unrelated',
      '/tmp/workspace-parse-error-unrelated',
      'session-1',
    )) as { items: SkillMarketplaceItem[] };

    expect(result.items[0]?.installed).toBe(false);
    expect(result.items[0]?.parseError).toBeUndefined();
  });

  it('logs the equivalent dp command before installing', async () => {
    const { ctx, installMarketplace, infoLogs } = createTestHarness(
      'workspace-install-log',
    );

    await installMarketplace(
      ctx,
      'workspace-install-log',
      'bailian-cli',
      '/tmp/workspace-install-log',
      'session-1',
      'global',
    );

    expect(
      infoLogs.some((message) =>
        message.includes(
          'dp skills install modelstudio/bailian-cli --agent nessy --global',
        ),
      ),
    ).toBe(true);
  });

  it('resolves a skill that is missing from the catalog listing', async () => {
    const { ctx, getMarketplace, refreshAvailableCommands } = createTestHarness(
      'workspace-unlisted',
    );
    refreshAvailableCommands.mockImplementation(async () => ({
      success: true,
      availableCommands: [],
      availableSkills: [],
      scopedSkillDetails: [
        {
          name: 'bailian-cli',
          description: 'Test skill',
          level: 'user' as const,
          filePath: '/home/user/.nessy/skills/bailian-cli/SKILL.md',
        },
      ],
    }));

    const skill = (await getMarketplace(
      ctx,
      'workspace-unlisted',
      'bailian-cli',
      '/tmp/workspace-unlisted',
      'session-1',
      'skl_v1_bailian_cli',
    )) as SkillMarketplaceItem | null;

    expect(mockMarketplaceClient.getSkill).toHaveBeenCalledWith(
      'bailian-cli',
      'skl_v1_bailian_cli',
    );
    expect(mockMarketplaceClient.listSkills).not.toHaveBeenCalled();
    expect(skill).toMatchObject({
      id: 'bailian-cli',
      installSource: 'modelstudio/bailian-cli',
      installedScopes: ['global'],
    });
  });

  it('returns null when the skill cannot be resolved', async () => {
    const { ctx, getMarketplace } = createTestHarness('workspace-unknown');

    const skill = await getMarketplace(
      ctx,
      'workspace-unknown',
      'not-in-catalog',
      '/tmp/workspace-unknown',
      'session-1',
    );

    expect(skill).toBeNull();
  });

  it('does not fall back to the unsupported marketplace URL', async () => {
    const { ctx, installMarketplace, installNessySkill } = createTestHarness(
      'workspace-missing-registry-address',
    );
    const skill = marketplaceSkills[0]!;
    const installSource = skill.installSource;
    delete skill.installSource;

    try {
      await expect(
        installMarketplace(
          ctx,
          'workspace-missing-registry-address',
          'bailian-cli',
          '/tmp/workspace-missing-registry-address',
          'session-1',
        ),
      ).rejects.toThrow('does not have a registry address');
      expect(installNessySkill).not.toHaveBeenCalled();
    } finally {
      skill.installSource = installSource;
    }
  });

  it('clears the installed override after deleting the skill', async () => {
    const {
      ctx,
      listMarketplace,
      installMarketplace,
      deleteSkill,
      deleteNessySkill,
    } = createTestHarness('workspace-delete');

    await installMarketplace(
      ctx,
      'workspace-delete',
      'bailian-cli',
      '/tmp/workspace-delete',
      'session-1',
      'project',
    );

    await deleteSkill(
      ctx,
      'workspace-delete',
      'bailian-cli',
      '/tmp/workspace-delete',
      'session-1',
      'project',
    );

    expect(deleteNessySkill).toHaveBeenCalledWith(
      'skills-discovery:workspace-delete',
      { slug: 'bailian-cli', scope: 'project' },
      {
        workspaceId: 'workspace-delete',
        workingDirectory: '/tmp/workspace-delete',
      },
    );

    const afterResult = (await listMarketplace(
      ctx,
      'workspace-delete',
      '/tmp/workspace-delete',
      'session-1',
    )) as { items: SkillMarketplaceItem[]; total: number };

    expect(
      afterResult.items.find((skill) => skill.id === 'bailian-cli')?.installed,
    ).toBe(false);
  });
});
