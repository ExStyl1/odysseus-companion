import { basename, dirname, join } from 'path';
import { existsSync, readdirSync, statSync } from 'fs';
import {
  RPC_CHANNELS,
  type SkillFile,
  type SkillMarketplaceInstallResult,
  type SkillMarketplaceItem,
  type SkillScope,
} from '@craft-agent/shared/protocol';
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';
import type { LoadedSkill } from '@craft-agent/shared/skills/types';
import type { AvailableSkillDetail } from '@craft-agent/core/types';
import { createInternalMarketplaceClient } from '../../services/internal-marketplace';

type AvailableCommandsPayload = {
  availableCommands?: Array<{ name: string; description?: string }>;
  availableSkills?: string[];
  availableSkillDetails?: AvailableSkillDetail[];
  scopedSkillDetails?: AvailableSkillDetail[];
};

const installedMarketplaceSkillOverridesByWorkspace = new Map<
  string,
  Map<string, Map<string, Set<string>>>
>();

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.skills.GET,
  RPC_CHANNELS.skills.GET_FILES,
  RPC_CHANNELS.skills.DELETE,
  RPC_CHANNELS.skills.SET_ENABLED,
  RPC_CHANNELS.skills.MARKETPLACE_LIST,
  RPC_CHANNELS.skills.MARKETPLACE_GET,
  // [nessy-fork] desktop-pet-session-aggregation: мастер (AIDT-7260) добавил
  // хендлер, но не задекларировал канал — registration-тесты строят expected
  // из этого массива и падали.
  RPC_CHANNELS.skills.MARKETPLACE_DETAILS,
  RPC_CHANNELS.skills.MARKETPLACE_INSTALL,
  RPC_CHANNELS.skills.OPEN_EDITOR,
  RPC_CHANNELS.skills.OPEN_FINDER,
] as const;

function providerSkillFromDetail(detail: AvailableSkillDetail): LoadedSkill {
  const skillDir = detail.filePath ? dirname(detail.filePath) : '';

  return {
    slug: detail.name,
    metadata: {
      name: detail.name,
      description: detail.description ?? 'Nessy CLI skill',
    },
    content: detail.body ?? '',
    path: skillDir,
    source: 'provider',
    enabled: detail.modelInvocable !== false,
    providerLevel: detail.level,
    // [nessy-fork] desktop-skill-parse-error-display
    ...(detail.parseError ? { parseError: detail.parseError } : {}),
  };
}

function providerSkillFromName(
  name: string,
  description?: string,
): LoadedSkill {
  return providerSkillFromDetail({
    name,
    ...(description !== undefined ? { description } : {}),
  });
}

function skillAcpSessionId(
  fallbackPrefix: string,
  workspaceId: string,
): string {
  return `${fallbackPrefix}:${workspaceId}`;
}

function hasActiveAcpSession(activeSessionId?: string): boolean {
  return Boolean(activeSessionId?.trim());
}

function normalizeSkillIdentifier(identifier: string | undefined): string {
  return (
    identifier
      ?.trim()
      .replace(/^[@/]+/, '')
      .toLowerCase() ?? ''
  );
}

/**
 * Directory a skill was installed into. `dp skills install` names it after the
 * catalog's `folder_name`, which is also the marketplace item's `slug` — so
 * this is what ties an installed copy back to its catalog entry. Preferred over
 * `detail.name`, which carries the frontmatter title and diverges from the
 * directory (`Search All` vs `search-all`) — and is unreadable altogether when
 * the frontmatter is what failed to parse.
 */
// [nessy-fork] desktop-skill-scope-resolution
// [nessy-fork] desktop-skill-parse-error-display
function installedSkillDirectory(
  detail: AvailableSkillDetail,
): string | undefined {
  if (detail.filePath) return basename(dirname(detail.filePath));
  return detail.name?.trim() || undefined;
}

/**
 * Directory names compare on the slug form the installer writes, so a detail
 * that fell back to a frontmatter title (`Bailian CLI`) still lines up with the
 * directory it lives in (`bailian-cli`).
 */
// [nessy-fork] desktop-skill-scope-resolution
function normalizeSkillDirectory(name: string | undefined): string {
  return normalizeSkillIdentifier(name).replace(/\s+/g, '-');
}

function unmanagedSkillFingerprint(
  name: string | undefined,
  description: string | undefined,
): string | undefined {
  const normalizedName = normalizeSkillIdentifier(name);
  const normalizedDescription = description?.trim().toLowerCase();
  return normalizedName && normalizedDescription
    ? `${normalizedName}\0${normalizedDescription}`
    : undefined;
}

function rememberInstalledMarketplaceSkill(
  workspaceId: string,
  scope: SkillScope,
  workingDirectory: string | undefined,
  ...identifiers: Array<string | undefined>
): void {
  const installedByScope =
    installedMarketplaceSkillOverridesByWorkspace.get(workspaceId) ??
    new Map<string, Map<string, Set<string>>>();
  const scopeKey =
    scope === 'project' ? `project:${workingDirectory ?? ''}` : 'global';
  const next = installedByScope.get(scopeKey) ?? new Map<string, Set<string>>();
  const normalizedIdentifiers = new Set(
    identifiers
      .filter((identifier): identifier is string => Boolean(identifier))
      .map(normalizeSkillIdentifier),
  );
  if (normalizedIdentifiers.size === 0) return;
  for (const identifier of normalizedIdentifiers) {
    const existing = next.get(identifier);
    if (existing) {
      existing.forEach((value) => normalizedIdentifiers.add(value));
    }
  }
  for (const identifier of normalizedIdentifiers) {
    next.set(identifier, normalizedIdentifiers);
  }
  installedByScope.set(scopeKey, next);
  installedMarketplaceSkillOverridesByWorkspace.set(
    workspaceId,
    installedByScope,
  );
}

function forgetInstalledMarketplaceSkill(
  workspaceId: string,
  identifier: string,
  scope: SkillScope,
  workingDirectory?: string,
): void {
  const installedByScope =
    installedMarketplaceSkillOverridesByWorkspace.get(workspaceId);
  if (!installedByScope) return;
  const scopeKey =
    scope === 'project' ? `project:${workingDirectory ?? ''}` : 'global';
  const installed = installedByScope.get(scopeKey);
  if (!installed) return;
  const normalizedIdentifier = normalizeSkillIdentifier(identifier);
  const identifiers =
    installed.get(normalizedIdentifier) ?? new Set([normalizedIdentifier]);
  identifiers.forEach((value) => installed.delete(value));
  if (installed.size === 0) {
    installedByScope.delete(scopeKey);
  }
  if (installedByScope.size === 0) {
    installedMarketplaceSkillOverridesByWorkspace.delete(workspaceId);
  }
}

function providerSkillsFromAvailableCommands(
  payload: AvailableCommandsPayload,
): LoadedSkill[] {
  const commandDescriptions = new Map(
    (payload.availableCommands ?? []).map((command) => [
      command.name,
      command.description,
    ]),
  );
  const skillDetails =
    payload.scopedSkillDetails ?? payload.availableSkillDetails;

  return skillDetails?.length
    ? skillDetails.map(providerSkillFromDetail)
    : (payload.availableSkills ?? []).map((name) =>
        providerSkillFromName(name, commandDescriptions.get(name)),
      );
}

function marketplaceLoadedSkill(
  skill: Omit<SkillMarketplaceItem, 'installed' | 'installedScopes'>,
  installedSlug?: string,
  scope: SkillScope = 'project',
): LoadedSkill {
  return {
    slug: installedSlug ?? skill.slug,
    metadata: {
      name: skill.name,
      description: skill.description,
    },
    content: '',
    path: '',
    source: 'provider',
    enabled: true,
    providerLevel: scope === 'project' ? 'project' : 'user',
  };
}

function mergeLoadedSkills(
  skills: LoadedSkill[],
  additionalSkills: LoadedSkill[],
): LoadedSkill[] {
  if (additionalSkills.length === 0) return skills;

  const identifiersFor = (skill: LoadedSkill) => {
    const scope = skill.providerLevel ?? skill.source;
    return [skill.slug, skill.metadata.name].map(
      (identifier) => `${scope}:${normalizeSkillIdentifier(identifier)}`,
    );
  };
  const seen = new Set(skills.flatMap(identifiersFor));
  const merged = [...skills];
  for (const skill of additionalSkills) {
    const identifiers = identifiersFor(skill);
    if (identifiers.some((identifier) => seen.has(identifier))) continue;
    merged.push(skill);
    identifiers.forEach((identifier) => seen.add(identifier));
  }
  return merged;
}

// [nessy-fork] desktop-skill-scope-management
// [nessy-fork] desktop-skill-marketplace-install-state
// [nessy-fork] desktop-skill-scope-resolution
// [nessy-fork] desktop-skill-logging
async function getInstalledMarketplaceSkillScopes(
  deps: HandlerDeps,
  workspaceId: string,
  workingDirectory?: string,
  activeSessionId?: string,
): Promise<{
  byId: Map<string, Set<SkillScope>>;
  unmanagedByFingerprint: Map<string, Set<SkillScope>>;
  byDirectory: Map<string, Set<SkillScope>>;
  parseErrorsByDirectory: Map<string, string>;
}> {
  const empty = () => ({
    byId: new Map<string, Set<SkillScope>>(),
    unmanagedByFingerprint: new Map<string, Set<SkillScope>>(),
    byDirectory: new Map<string, Set<SkillScope>>(),
    parseErrorsByDirectory: new Map<string, string>(),
  });
  const workspace = getWorkspaceByNameOrId(workspaceId);
  if (!workspace) {
    return empty();
  }

  const shouldTryNessyAcp =
    hasActiveAcpSession(activeSessionId) ||
    (await shouldLoadSkillsFromNessyAcp(workspace.rootPath));
  if (!shouldTryNessyAcp) return empty();

  const effectiveWorkingDir =
    workingDirectory && existsSync(workingDirectory)
      ? workingDirectory
      : undefined;
  const result = await deps.sessionManager.refreshAvailableCommands(
    skillAcpSessionId('skills-marketplace', workspaceId),
    {
      workspaceId,
      workingDirectory: effectiveWorkingDir,
    },
  );
  if (!result.success) {
    deps.platform.logger?.warn(
      `SKILLS_MARKETPLACE_LIST: Nessy ACP skill discovery failed for ${workspaceId}: ${result.error ?? 'unknown error'}`,
    );
    return empty();
  }

  // [nessy-fork] desktop-skill-logging
  const loggedDiscovery = new Set<string>();
  const loggedScopes = new Set<string>();

  const installed = empty();
  const details =
    result.scopedSkillDetails ?? result.availableSkillDetails ?? [];
  for (const skill of details) {
    const scope =
      skill.level === 'project'
        ? 'project'
        : skill.level === 'user'
          ? 'global'
          : undefined;
    if (!scope) continue;

    // [nessy-fork] desktop-skill-logging
    // Log discovery data from ACP for skills without filePath
    if (!skill.filePath && !loggedDiscovery.has(skill.name)) {
      deps.platform.logger?.debug(
        `[SKILLS_MARKETPLACE_DISCOVERY] name=${skill.name}, level=${skill.level}, managedId=${skill.managedSkillId ?? 'none'}, filePath=${skill.filePath ?? 'none'}`,
      );
      loggedDiscovery.add(skill.name);
    }

    // [nessy-fork] desktop-skill-parse-error-display
    // A skill whose SKILL.md failed to parse arrives without a description, so
    // the fingerprint below cannot identify it. Its install directory still
    // carries the catalog's `folder_name` — the marketplace item's slug — so
    // that is what ties the broken copy back to its card. Restricted to
    // description-less details on purpose: with a description present the
    // fingerprint decides, and an unrelated hand-written skill that merely
    // shares a catalog name is not claimed as an installation.
    const directory = installedSkillDirectory(skill);
    if (directory && !skill.description?.trim()) {
      const directoryKey = normalizeSkillDirectory(directory);
      const directoryScopes =
        installed.byDirectory.get(directoryKey) ?? new Set<SkillScope>();
      directoryScopes.add(scope);
      installed.byDirectory.set(directoryKey, directoryScopes);
      if (skill.parseError) {
        installed.parseErrorsByDirectory.set(directoryKey, skill.parseError);
      }
    }

    const target = skill.managedSkillId
      ? installed.byId
      : installed.unmanagedByFingerprint;
    const identifier = skill.managedSkillId
      ? normalizeSkillIdentifier(skill.managedSkillId)
      : unmanagedSkillFingerprint(skill.name, skill.description);
    if (!identifier) continue;
    const scopes = target.get(identifier) ?? new Set<SkillScope>();
    scopes.add(scope);
    target.set(identifier, scopes);

    // [nessy-fork] desktop-skill-logging
    // Log final scope assignment
    const scopeKey = `${identifier}:${scope}`;
    if (!loggedScopes.has(scopeKey)) {
      deps.platform.logger?.debug(`[SKILL_SCOPE] "${identifier}" -> ${scope}`);
      loggedScopes.add(scopeKey);
    }
  }

  // [nessy-fork] desktop-skill-logging
  // Log final accepted skills with scopes
  for (const [id, scopes] of installed.byId.entries()) {
    deps.platform.logger?.debug(
      `[SKILLS_MARKETPLACE_SCOPES] managed "${id}" -> ${Array.from(scopes).join(',')}`,
    );
  }
  for (const [
    fingerprint,
    scopes,
  ] of installed.unmanagedByFingerprint.entries()) {
    deps.platform.logger?.debug(
      `[SKILLS_MARKETPLACE_SCOPES] unmanaged "${fingerprint}" -> ${Array.from(scopes).join(',')}`,
    );
  }
  for (const [directory, scopes] of installed.byDirectory.entries()) {
    const parseError = installed.parseErrorsByDirectory.get(directory);
    const errorSuffix = parseError
      ? ` (parseError: ${parseError.slice(0, 50)}...)`
      : '';
    deps.platform.logger?.debug(
      `[SKILLS_MARKETPLACE_SCOPES] directory "${directory}" -> ${Array.from(scopes).join(',')}${errorSuffix}`,
    );
  }

  return installed;
}

interface MarketplaceListPage<T> {
  items: T[];
  total: number;
}

async function listMarketplaceSkills(
  deps: HandlerDeps,
  workspaceId: string,
  workingDirectory?: string,
  activeSessionId?: string,
  page?: number,
  pageSize?: number,
  query?: string,
): Promise<MarketplaceListPage<SkillMarketplaceItem>> {
  const installedSkillScopes = await getInstalledMarketplaceSkillScopes(
    deps,
    workspaceId,
    workingDirectory,
    activeSessionId,
  );
  const installedOverrides =
    installedMarketplaceSkillOverridesByWorkspace.get(workspaceId);

  const marketplace = createInternalMarketplaceClient({
    fetch: deps.platform.fetch,
  });
  const result = await marketplace.listSkills({ page, pageSize, query });
  const items = result.items.map((skill) =>
    withInstalledScopes(
      skill,
      installedSkillScopes,
      installedOverrides,
      workingDirectory,
    ),
  );
  return { items, total: result.total };
}

type InstalledMarketplaceSkillScopes = Awaited<
  ReturnType<typeof getInstalledMarketplaceSkillScopes>
>;

function withInstalledScopes(
  skill: Omit<SkillMarketplaceItem, 'installed' | 'installedScopes'>,
  installedSkillScopes: InstalledMarketplaceSkillScopes,
  installedOverrides: Map<string, Map<string, Set<string>>> | undefined,
  workingDirectory: string | undefined,
): SkillMarketplaceItem {
  const installedScopes = new Set<SkillScope>();
  if (skill.detailsId) {
    installedSkillScopes.byId
      .get(normalizeSkillIdentifier(skill.detailsId))
      ?.forEach((scope) => installedScopes.add(scope));
  }
  const fingerprintsToCheck = [skill.slug, skill.name]
    .map((name) => unmanagedSkillFingerprint(name, skill.description))
    .filter((value): value is string => Boolean(value));

  for (const unmanagedFingerprint of fingerprintsToCheck) {
    installedSkillScopes.unmanagedByFingerprint
      .get(unmanagedFingerprint)
      ?.forEach((scope) => installedScopes.add(scope));
  }
  // A skill whose SKILL.md failed to parse reaches us with no description, so
  // the fingerprint above cannot match it. Its install directory still carries
  // the catalog's `folder_name`, which is exactly this item's slug.
  const directoryKey = normalizeSkillDirectory(skill.slug);
  installedSkillScopes.byDirectory
    .get(directoryKey)
    ?.forEach((scope) => installedScopes.add(scope));
  for (const [scopeKey, overrides] of installedOverrides ?? []) {
    if (
      scopeKey !== 'global' &&
      scopeKey !== `project:${workingDirectory ?? ''}`
    ) {
      continue;
    }
    const overrideIdentifier = normalizeSkillIdentifier(
      skill.detailsId ?? skill.id,
    );
    if (overrides.has(overrideIdentifier)) {
      installedScopes.add(scopeKey === 'global' ? 'global' : 'project');
    }
  }

  // [nessy-fork] desktop-skill-parse-error-display
  // Reported only for an installed copy: the error describes the SKILL.md on
  // this machine, not the catalog entry, and on a skill offered for install it
  // would read as "this skill is broken, don't install it".
  const parseError = installedScopes.size
    ? installedSkillScopes.parseErrorsByDirectory.get(directoryKey)
    : undefined;

  return {
    ...skill,
    installed: installedScopes.size > 0,
    installedScopes: Array.from(installedScopes),
    ...(parseError ? { parseError } : {}),
  };
}

/**
 * The catalog listing is capped at the first page, so a skill reached by a
 * search or a deep link is often absent from it. Resolving it on its own keeps
 * its detail view and install button working.
 */
async function getMarketplaceSkill(
  deps: HandlerDeps,
  workspaceId: string,
  skillId: string,
  workingDirectory?: string,
  activeSessionId?: string,
  detailsId?: string,
): Promise<SkillMarketplaceItem | null> {
  const marketplace = createInternalMarketplaceClient({
    fetch: deps.platform.fetch,
  });
  let skill: Omit<SkillMarketplaceItem, 'installed' | 'installedScopes'>;
  try {
    skill = await marketplace.getSkill(skillId, detailsId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.platform.logger?.warn(
      `SKILLS_MARKETPLACE_GET: could not resolve ${skillId} (detailsId: ${detailsId ?? 'none'}): ${message}`,
    );
    return null;
  }

  const installedSkillScopes = await getInstalledMarketplaceSkillScopes(
    deps,
    workspaceId,
    workingDirectory,
    activeSessionId,
  );
  return withInstalledScopes(
    skill,
    installedSkillScopes,
    installedMarketplaceSkillOverridesByWorkspace.get(workspaceId),
    workingDirectory,
  );
}

async function broadcastAvailableSkills(
  server: RpcServer,
  deps: HandlerDeps,
  workspaceId: string,
  workingDirectory?: string,
  additionalSkills: LoadedSkill[] = [],
): Promise<void> {
  const workspace = getWorkspaceByNameOrId(workspaceId);
  if (!workspace) return;

  const effectiveWorkingDir =
    workingDirectory && existsSync(workingDirectory)
      ? workingDirectory
      : undefined;
  const result = await deps.sessionManager.refreshAvailableCommands(
    skillAcpSessionId('skills-discovery', workspaceId),
    {
      workspaceId,
      workingDirectory: effectiveWorkingDir,
    },
  );
  if (!result.success) {
    deps.platform.logger?.warn(
      `SKILLS_MARKETPLACE_INSTALL: Nessy ACP skill refresh failed for ${workspaceId}: ${result.error ?? 'unknown error'}`,
    );
    if (additionalSkills.length > 0) {
      pushTyped(
        server,
        RPC_CHANNELS.skills.CHANGED,
        { to: 'workspace', workspaceId },
        workspaceId,
        additionalSkills,
      );
    }
    return;
  }

  const skills = mergeLoadedSkills(
    providerSkillsFromAvailableCommands(result),
    additionalSkills,
  );
  pushTyped(
    server,
    RPC_CHANNELS.skills.CHANGED,
    { to: 'workspace', workspaceId },
    workspaceId,
    skills,
  );
}

async function shouldLoadSkillsFromNessyAcp(
  workspaceRootPath: string,
): Promise<boolean> {
  const { loadWorkspaceConfig } =
    await import('@craft-agent/shared/workspaces');
  const {
    getDefaultLlmConnection,
    getLlmConnection,
    NESSY_CLI_CONNECTION_SLUG,
  } = await import('@craft-agent/shared/config');

  const workspaceConfig = loadWorkspaceConfig(workspaceRootPath);
  const connectionSlug =
    workspaceConfig?.defaults?.defaultLlmConnection ??
    getDefaultLlmConnection() ??
    undefined;
  if (!connectionSlug) return false;

  const connection = getLlmConnection(connectionSlug);
  return (
    connectionSlug === NESSY_CLI_CONNECTION_SLUG ||
    connection?.providerType === 'nessy'
  );
}

export function registerSkillsHandlers(
  server: RpcServer,
  deps: HandlerDeps,
): void {
  // Get all skills for a workspace (and optionally project-level skills from workingDirectory)
  server.handle(
    RPC_CHANNELS.skills.GET,
    async (
      _ctx,
      workspaceId: string,
      workingDirectory?: string,
      activeSessionId?: string,
    ) => {
      deps.platform.logger?.info(
        `SKILLS_GET: Loading skills for workspace: ${workspaceId}${workingDirectory ? `, workingDirectory: ${workingDirectory}` : ''}`,
      );
      const workspace = getWorkspaceByNameOrId(workspaceId);
      if (!workspace) {
        deps.platform.logger?.error(
          `SKILLS_GET: Workspace not found: ${workspaceId}`,
        );
        return [];
      }
      // Validate workingDirectory exists on this server — a thin client may pass
      // its local path which doesn't exist on the remote server's filesystem.
      const effectiveWorkingDir =
        workingDirectory && existsSync(workingDirectory)
          ? workingDirectory
          : undefined;

      const shouldTryNessyAcp =
        hasActiveAcpSession(activeSessionId) ||
        (await shouldLoadSkillsFromNessyAcp(workspace.rootPath));

      if (shouldTryNessyAcp) {
        const result = await deps.sessionManager.refreshAvailableCommands(
          skillAcpSessionId('skills-discovery', workspaceId),
          {
            workspaceId,
            workingDirectory: effectiveWorkingDir,
          },
        );
        if (!result.success) {
          deps.platform.logger?.warn(
            `SKILLS_GET: Nessy ACP skill discovery failed for ${workspaceId}: ${result.error ?? 'unknown error'}`,
          );
          return [];
        }

        const skills = providerSkillsFromAvailableCommands(result);
        deps.platform.logger?.info(
          `SKILLS_GET: Loaded ${skills.length} skills from Nessy ACP for ${workspaceId}`,
        );
        return skills;
      }

      const { loadAllSkills } = await import('@craft-agent/shared/skills');
      const skills = loadAllSkills(workspace.rootPath, effectiveWorkingDir);
      deps.platform.logger?.info(
        `SKILLS_GET: Loaded ${skills.length} skills from ${workspace.rootPath}`,
      );
      return skills;
    },
  );

  server.handle(
    RPC_CHANNELS.skills.MARKETPLACE_LIST,
    async (
      _ctx,
      workspaceId: string,
      workingDirectory?: string,
      activeSessionId?: string,
      page?: number,
      pageSize?: number,
      query?: string,
    ) =>
      listMarketplaceSkills(
        deps,
        workspaceId,
        workingDirectory,
        activeSessionId,
        page,
        pageSize,
        query,
      ),
  );

  server.handle(
    RPC_CHANNELS.skills.MARKETPLACE_GET,
    async (
      _ctx,
      workspaceId: string,
      skillId: string,
      workingDirectory?: string,
      activeSessionId?: string,
      detailsId?: string,
    ) =>
      getMarketplaceSkill(
        deps,
        workspaceId,
        skillId,
        workingDirectory,
        activeSessionId,
        detailsId,
      ),
  );

  server.handle(
    RPC_CHANNELS.skills.MARKETPLACE_DETAILS,
    async (_ctx, workspaceId: string, skillId: string) => {
      const marketplace = createInternalMarketplaceClient({
        fetch: deps.platform.fetch,
      });
      return marketplace.getSkillDetails(skillId);
    },
  );

  server.handle(
    RPC_CHANNELS.skills.MARKETPLACE_INSTALL,
    async (
      _ctx,
      workspaceId: string,
      skillId: string,
      workingDirectory?: string,
      _activeSessionId?: string,
      scope: SkillScope = 'project',
      detailsId?: string,
    ): Promise<SkillMarketplaceInstallResult> => {
      let marketplaceSkill: Awaited<
        ReturnType<
          ReturnType<typeof createInternalMarketplaceClient>['getSkill']
        >
      >;
      try {
        marketplaceSkill = await createInternalMarketplaceClient({
          fetch: deps.platform.fetch,
        }).getSkill(skillId, detailsId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.platform.logger?.error(
          `SKILLS_MARKETPLACE_INSTALL: could not resolve ${skillId} (detailsId: ${detailsId ?? 'none'}): ${message}`,
        );
        throw error;
      }
      if (!marketplaceSkill.installSource) {
        deps.platform.logger?.error(
          `SKILLS_MARKETPLACE_INSTALL: ${skillId} has no registry address (source: ${marketplaceSkill.sourceUrl || 'none'})`,
        );
        throw new Error(
          `Skill ${marketplaceSkill.slug} does not have a registry address`,
        );
      }

      // Nessy runs `dp` itself over ACP; this is the equivalent invocation,
      // logged so a failing install can be reproduced from a terminal.
      deps.platform.logger?.info(
        `SKILLS_MARKETPLACE_INSTALL: dp skills install ${marketplaceSkill.installSource} --agent nessy ${scope === 'global' ? '--global' : '--project'}` +
          ` (cwd: ${workingDirectory ?? 'workspace default'})`,
      );

      const result = await deps.sessionManager.installNessySkill(
        skillAcpSessionId('skills-marketplace', workspaceId),
        {
          id: marketplaceSkill.id,
          slug: marketplaceSkill.slug,
          name: marketplaceSkill.name,
          description: marketplaceSkill.description,
          sourceUrl: marketplaceSkill.installSource,
          scope,
        },
        {
          workspaceId,
          workingDirectory,
        },
      );
      if (!result.success || !result.skill) {
        deps.platform.logger?.error(
          `SKILLS_MARKETPLACE_INSTALL: ${marketplaceSkill.slug} failed from source ${marketplaceSkill.installSource}: ${result.error ?? 'unknown error'}`,
        );
        throw new Error(result.error ?? 'Nessy ACP skill installation failed');
      }
      rememberInstalledMarketplaceSkill(
        workspaceId,
        scope,
        workingDirectory,
        marketplaceSkill.detailsId ?? marketplaceSkill.id,
        marketplaceSkill.slug,
        result.skill.slug,
      );
      const installedSkill = marketplaceLoadedSkill(
        marketplaceSkill,
        result.skill.slug,
        scope,
      );
      await broadcastAvailableSkills(
        server,
        deps,
        workspaceId,
        workingDirectory,
        [installedSkill],
      );

      deps.platform.logger?.info(
        `Installed marketplace skill: ${marketplaceSkill.slug}`,
      );
      return {
        id: marketplaceSkill.id,
        slug: result.skill.slug ?? marketplaceSkill.slug,
        installedPath: result.skill.installedPath,
        source: 'nessy-acp',
      };
    },
  );

  // Get files in a skill directory
  server.handle(
    RPC_CHANNELS.skills.GET_FILES,
    async (_ctx, workspaceId: string, skillSlug: string) => {
      const workspace = getWorkspaceByNameOrId(workspaceId);
      if (!workspace) {
        deps.platform.logger?.error(
          `SKILLS_GET_FILES: Workspace not found: ${workspaceId}`,
        );
        return [];
      }

      const { getWorkspaceSkillsPath } =
        await import('@craft-agent/shared/workspaces');

      const skillsDir = getWorkspaceSkillsPath(workspace.rootPath);
      const skillDir = join(skillsDir, skillSlug);

      function scanDirectory(dirPath: string): SkillFile[] {
        try {
          const entries = readdirSync(dirPath, { withFileTypes: true });
          return entries
            .filter((entry) => !entry.name.startsWith('.')) // Skip hidden files
            .map((entry) => {
              const fullPath = join(dirPath, entry.name);
              if (entry.isDirectory()) {
                return {
                  name: entry.name,
                  type: 'directory' as const,
                  children: scanDirectory(fullPath),
                };
              } else {
                const stats = statSync(fullPath);
                return {
                  name: entry.name,
                  type: 'file' as const,
                  size: stats.size,
                };
              }
            })
            .sort((a, b) => {
              // Directories first, then files
              if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
              return a.name.localeCompare(b.name);
            });
        } catch (err) {
          deps.platform.logger?.error(
            `SKILLS_GET_FILES: Error scanning ${dirPath}:`,
            err,
          );
          return [];
        }
      }

      return scanDirectory(skillDir);
    },
  );

  // Delete a skill from a workspace
  server.handle(
    RPC_CHANNELS.skills.DELETE,
    async (
      _ctx,
      workspaceId: string,
      skillSlug: string,
      workingDirectory?: string,
      activeSessionId?: string,
      scope: SkillScope = 'global',
    ) => {
      const workspace = getWorkspaceByNameOrId(workspaceId);
      if (!workspace) throw new Error('Workspace not found');

      const shouldTryNessyAcp =
        hasActiveAcpSession(activeSessionId) ||
        (await shouldLoadSkillsFromNessyAcp(workspace.rootPath));

      if (shouldTryNessyAcp) {
        const result = await deps.sessionManager.deleteNessySkill(
          skillAcpSessionId('skills-discovery', workspaceId),
          { slug: skillSlug, scope },
          { workspaceId, workingDirectory },
        );
        if (!result.success) {
          throw new Error(result.error ?? 'Nessy ACP skill deletion failed');
        }
        await broadcastAvailableSkills(
          server,
          deps,
          workspaceId,
          workingDirectory,
        );
        forgetInstalledMarketplaceSkill(
          workspaceId,
          skillSlug,
          scope,
          workingDirectory,
        );
        deps.platform.logger?.info(`Deleted Nessy skill: ${skillSlug}`);
        return;
      }

      const { deleteSkill } = await import('@craft-agent/shared/skills');
      deleteSkill(workspace.rootPath, skillSlug);
      forgetInstalledMarketplaceSkill(
        workspaceId,
        skillSlug,
        scope,
        workingDirectory,
      );
      deps.platform.logger?.info(`Deleted skill: ${skillSlug}`);
    },
  );

  server.handle(
    RPC_CHANNELS.skills.SET_ENABLED,
    async (
      _ctx,
      workspaceId: string,
      skillSlug: string,
      enabled: boolean,
      workingDirectory?: string,
      activeSessionId?: string,
      scope?: 'global' | 'project',
    ) => {
      const workspace = getWorkspaceByNameOrId(workspaceId);
      if (!workspace) throw new Error('Workspace not found');
      const shouldTryNessyAcp =
        hasActiveAcpSession(activeSessionId) ||
        (await shouldLoadSkillsFromNessyAcp(workspace.rootPath));
      if (!shouldTryNessyAcp) {
        throw new Error('Skill enablement is only supported for Nessy skills');
      }

      const result = await deps.sessionManager.setNessySkillEnabled(
        skillAcpSessionId('skills-discovery', workspaceId),
        { slug: skillSlug, enabled, scope: scope ?? 'global' },
        { workspaceId, workingDirectory },
      );
      if (!result.success) {
        throw new Error(result.error ?? 'Nessy ACP skill update failed');
      }
      await broadcastAvailableSkills(
        server,
        deps,
        workspaceId,
        workingDirectory,
      );
      deps.platform.logger?.info(
        `Set Nessy skill ${skillSlug} enabled=${enabled}`,
      );
    },
  );

  // Open skill SKILL.md in editor
  server.handle(
    RPC_CHANNELS.skills.OPEN_EDITOR,
    async (_ctx, workspaceId: string, skillSlug: string) => {
      const workspace = getWorkspaceByNameOrId(workspaceId);
      if (!workspace) throw new Error('Workspace not found');
      if (workspace.remoteServer)
        throw new Error(
          'Open in editor is not available for remote workspaces',
        );

      const { getWorkspaceSkillsPath } =
        await import('@craft-agent/shared/workspaces');

      const skillsDir = getWorkspaceSkillsPath(workspace.rootPath);
      const skillFile = join(skillsDir, skillSlug, 'SKILL.md');
      await deps.platform.openPath?.(skillFile);
    },
  );

  // Open skill folder in Finder/Explorer
  server.handle(
    RPC_CHANNELS.skills.OPEN_FINDER,
    async (_ctx, workspaceId: string, skillSlug: string) => {
      const workspace = getWorkspaceByNameOrId(workspaceId);
      if (!workspace) throw new Error('Workspace not found');
      if (workspace.remoteServer)
        throw new Error(
          'Show in Finder is not available for remote workspaces',
        );

      const { getWorkspaceSkillsPath } =
        await import('@craft-agent/shared/workspaces');

      const skillsDir = getWorkspaceSkillsPath(workspace.rootPath);
      const skillDir = join(skillsDir, skillSlug);
      await deps.platform.showItemInFolder?.(skillDir);
    },
  );
}
