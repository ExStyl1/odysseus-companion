import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Database,
  Loader2,
  Plus,
  Power,
  RefreshCw,
  Save,
  Settings2,
  Trash2,
  Wrench,
} from 'lucide-react';
import { toast } from 'sonner';

import { PanelHeader } from '@/components/app-shell/PanelHeader';
import { HeaderMenu } from '@/components/ui/HeaderMenu';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsTextarea,
  SettingsToggle,
} from '@/components/settings';
import { routes } from '@/lib/navigate';
import type { DetailsPageMeta } from '@/lib/navigation-registry';
import { normalizeNessySettingsSnapshot } from '@/lib/nessy-settings-snapshot';
import type {
  NessyCoreSettingKey,
  NessyCoreSettingsSnapshot,
  NessyExtensionSettingsEntry,
  NessyHookDefinition,
  NessyHookEntry,
  NessyHookEvent,
  NessyMcpServerConfig,
  NessyMcpServerEntry,
  NessyMcpManageAction,
  NessyMcpResourceStatus,
  NessyMcpStatusSnapshot,
  NessyMcpToolStatus,
  NessyMcpTransport,
  NessySettingValue,
  NessySettingsScope,
  SessionCommand,
} from '@craft-agent/shared/protocol';

export type NessySettingsTab =
  | 'general'
  | 'mcpServers'
  | 'hooks'
  | 'extensions';

type PageCopy = {
  titleKey: string;
  descriptionKey: string;
  slug: NessySettingsTab;
};

type RunNessySettingsCommand = (
  command: SessionCommand,
) => Promise<NessyCoreSettingsSnapshot | null>;

const PAGE_COPY: Record<NessySettingsTab, PageCopy> = {
  general: {
    titleKey: 'settings.general.title',
    descriptionKey: 'settings.general.description',
    slug: 'general',
  },
  mcpServers: {
    titleKey: 'settings.mcpServers.title',
    descriptionKey: 'settings.mcpServers.description',
    slug: 'mcpServers',
  },
  hooks: {
    titleKey: 'settings.hooks.title',
    descriptionKey: 'settings.hooks.description',
    slug: 'hooks',
  },
  extensions: {
    titleKey: 'settings.extensions.title',
    descriptionKey: 'settings.extensions.description',
    slug: 'extensions',
  },
};

const TRANSPORT_OPTIONS: Array<{ value: NessyMcpTransport; label: string }> = [
  { value: 'http', label: 'HTTP' },
  { value: 'stdio', label: 'Stdio' },
  { value: 'sse', label: 'SSE' },
];

const HOOK_EVENTS: NessyHookEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'Notification',
  'PreCompact',
  'SubagentStart',
  'SubagentStop',
];

const HOOK_EVENT_OPTIONS = HOOK_EVENTS.map((event) => ({
  value: event,
  label: event,
}));

function createMeta(slug: NessySettingsTab): DetailsPageMeta {
  return { navigator: 'settings', slug };
}

export const generalMeta = createMeta('general');
export const mcpServersMeta = createMeta('mcpServers');
export const hooksMeta = createMeta('hooks');
export const extensionsMeta = createMeta('extensions');

function valueOf(
  snapshot: NessyCoreSettingsSnapshot | null,
  key: NessyCoreSettingKey,
  fallback: NessySettingValue,
): NessySettingValue {
  return snapshot?.merged.values[key] ?? fallback;
}

function boolValue(
  snapshot: NessyCoreSettingsSnapshot | null,
  key: NessyCoreSettingKey,
  fallback: boolean,
): boolean {
  const value = valueOf(snapshot, key, fallback);
  return typeof value === 'boolean' ? value : fallback;
}

function stringValue(
  snapshot: NessyCoreSettingsSnapshot | null,
  key: NessyCoreSettingKey,
  fallback = '',
): string {
  const value = valueOf(snapshot, key, fallback);
  return typeof value === 'string' ? value : fallback;
}

function parseLines(value: string): string[] | undefined {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : undefined;
}

function stringifyLines(value?: string[]): string {
  return value?.join('\n') ?? '';
}

function parseKeyValueLines(value: string): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const item = trimmed.slice(index + 1).trim();
    if (key) result[key] = item;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function stringifyKeyValueLines(value?: Record<string, string>): string {
  return Object.entries(value ?? {})
    .map(([key, item]) => `${key}=${item}`)
    .join('\n');
}

function createEmptyMcpDraft(): McpDraft {
  return {
    scope: 'user',
    name: '',
    transport: 'http',
    commandOrUrl: '',
    args: '',
    cwd: '',
    env: '',
    headers: '',
    timeout: '',
    trust: false,
    description: '',
    includeTools: '',
    excludeTools: '',
  };
}

type McpDraft = {
  scope: NessySettingsScope;
  name: string;
  transport: NessyMcpTransport;
  commandOrUrl: string;
  args: string;
  cwd: string;
  env: string;
  headers: string;
  timeout: string;
  trust: boolean;
  description: string;
  includeTools: string;
  excludeTools: string;
};

function serverToDraft(entry: NessyMcpServerEntry): McpDraft {
  const { server } = entry;
  return {
    scope: entry.scope === 'workspace' ? 'workspace' : 'user',
    name: entry.name,
    transport: server.transport,
    commandOrUrl:
      server.transport === 'stdio'
        ? (server.command ?? '')
        : server.transport === 'http'
          ? (server.httpUrl ?? '')
          : (server.url ?? ''),
    args: stringifyLines(server.args),
    cwd: server.cwd ?? '',
    env: stringifyKeyValueLines(server.env),
    headers: stringifyKeyValueLines(server.headers),
    timeout: server.timeout === undefined ? '' : String(server.timeout),
    trust: server.trust ?? false,
    description: server.description ?? '',
    includeTools: stringifyLines(server.includeTools),
    excludeTools: stringifyLines(server.excludeTools),
  };
}

function draftToServer(draft: McpDraft): NessyMcpServerConfig {
  const timeout = draft.timeout.trim()
    ? Number(draft.timeout.trim())
    : undefined;
  const base = {
    transport: draft.transport,
    timeout,
    trust: draft.trust,
    description: draft.description.trim() || undefined,
    includeTools: parseLines(draft.includeTools),
    excludeTools: parseLines(draft.excludeTools),
  };
  if (draft.transport === 'stdio') {
    return {
      ...base,
      command: draft.commandOrUrl.trim(),
      args: parseLines(draft.args),
      cwd: draft.cwd.trim() || undefined,
      env: parseKeyValueLines(draft.env),
    };
  }
  if (draft.transport === 'http') {
    return {
      ...base,
      httpUrl: draft.commandOrUrl.trim(),
      headers: parseKeyValueLines(draft.headers),
    };
  }
  return {
    ...base,
    url: draft.commandOrUrl.trim(),
    headers: parseKeyValueLines(draft.headers),
  };
}

type HookDraft = {
  scope: NessySettingsScope;
  event: NessyHookEvent;
  index?: number;
  matcher: string;
  type: 'command' | 'http';
  commandOrUrl: string;
  name: string;
  description: string;
  timeout: string;
  statusMessage: string;
  env: string;
  headers: string;
  allowedEnvVars: string;
  async: boolean;
  once: boolean;
  sequential: boolean;
};

function createEmptyHookDraft(): HookDraft {
  return {
    scope: 'user',
    event: 'PreToolUse',
    matcher: '*',
    type: 'command',
    commandOrUrl: '',
    name: '',
    description: '',
    timeout: '',
    statusMessage: '',
    env: '',
    headers: '',
    allowedEnvVars: '',
    async: false,
    once: false,
    sequential: false,
  };
}

function hookToDraft(entry: NessyHookEntry): HookDraft {
  const config = entry.hook.hooks[0];
  const type = config?.type ?? 'command';
  return {
    scope: entry.scope === 'workspace' ? 'workspace' : 'user',
    event: entry.event,
    index: entry.index,
    matcher: entry.hook.matcher ?? '*',
    sequential: entry.hook.sequential ?? false,
    type,
    commandOrUrl:
      type === 'command' ? (config?.command ?? '') : (config?.url ?? ''),
    name: config?.name ?? '',
    description: config?.description ?? '',
    timeout: config?.timeout === undefined ? '' : String(config.timeout),
    statusMessage: config?.statusMessage ?? '',
    env: stringifyKeyValueLines(config?.env),
    headers: stringifyKeyValueLines(config?.headers),
    allowedEnvVars: stringifyLines(config?.allowedEnvVars),
    async: config?.async ?? false,
    once: config?.once ?? false,
  };
}

function draftToHook(draft: HookDraft): NessyHookDefinition {
  const timeout = draft.timeout.trim()
    ? Number(draft.timeout.trim())
    : undefined;
  const common = {
    name: draft.name.trim() || undefined,
    description: draft.description.trim() || undefined,
    timeout,
    statusMessage: draft.statusMessage.trim() || undefined,
  };
  return {
    matcher: draft.matcher,
    sequential: draft.sequential || undefined,
    hooks: [
      draft.type === 'command'
        ? {
            ...common,
            type: 'command',
            command: draft.commandOrUrl.trim(),
            env: parseKeyValueLines(draft.env),
            async: draft.async || undefined,
          }
        : {
            ...common,
            type: 'http',
            url: draft.commandOrUrl.trim(),
            headers: parseKeyValueLines(draft.headers),
            allowedEnvVars: parseLines(draft.allowedEnvVars),
            once: draft.once || undefined,
          },
    ],
  };
}

async function runSharedNessySettingsCommand(
  command: SessionCommand,
): Promise<NessyCoreSettingsSnapshot | null> {
  if (!window.electronAPI) return null;

  switch (command.type) {
    case 'getNessyCoreSettings':
      return window.electronAPI.getNessyCoreSettings();
    case 'setNessyCoreSetting':
      return window.electronAPI.setNessyCoreSetting(
        command.scope,
        command.key,
        command.value,
      );
    case 'setNessyMcpServer':
      return window.electronAPI.setNessyMcpServer(
        command.scope,
        command.name,
        command.server,
      );
    case 'removeNessyMcpServer':
      return window.electronAPI.removeNessyMcpServer(
        command.scope,
        command.name,
      );
    case 'setNessyHook':
      return window.electronAPI.setNessyHook(
        command.scope,
        command.event,
        command.index,
        command.hook,
      );
    case 'removeNessyHook':
      return window.electronAPI.removeNessyHook(
        command.scope,
        command.event,
        command.index,
      );
    case 'setNessyExtensionSetting':
      return window.electronAPI.setNessyExtensionSetting(
        command.extensionId,
        command.settingKey,
        command.scope,
        command.value,
      );
    default:
      return null;
  }
}

export default function NessySettingsPage({ tab }: { tab: NessySettingsTab }) {
  const { t } = useTranslation();
  const copy = PAGE_COPY[tab];
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<NessyCoreSettingsSnapshot | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const runCommand = useCallback(async (command: SessionCommand) => {
    if (!window.electronAPI) return null;
    const result = await runSharedNessySettingsCommand(command);
    return normalizeNessySettingsSnapshot(result as NessyCoreSettingsSnapshot);
  }, []);

  const load = useCallback(async () => {
    if (!window.electronAPI) {
      setSnapshot(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await runCommand({ type: 'getNessyCoreSettings' });
      setSnapshot(result);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, [runCommand]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveSetting = useCallback(
    async (
      key: NessyCoreSettingKey,
      value: NessySettingValue,
      scope: NessySettingsScope = 'user',
    ) => {
      try {
        const result = await runCommand({
          type: 'setNessyCoreSetting',
          scope,
          key,
          value,
        });
        if (result) setSnapshot(result);
      } catch (saveError) {
        toast.error(t('settings.nessy.failedToSaveSetting'), {
          description:
            saveError instanceof Error ? saveError.message : String(saveError),
        });
      }
    },
    [runCommand, t],
  );

  return (
    <div className="h-full flex flex-col">
      <PanelHeader
        title={t(copy.titleKey)}
        actions={<HeaderMenu route={routes.view.settings(copy.slug)} />}
      />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full" viewportRef={scrollViewportRef}>
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              <SettingsSection
                title={t(copy.titleKey)}
                description={t(copy.descriptionKey)}
              >
                {error ? (
                  <SettingsCard className="px-4 py-3 text-sm text-destructive flex gap-2">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{error}</span>
                  </SettingsCard>
                ) : null}
              </SettingsSection>

              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : !snapshot ? (
                <EmptyState
                  title={t('settings.nessy.settingsUnavailableTitle')}
                  description={t('settings.nessy.settingsUnavailableDesc')}
                />
              ) : tab === 'general' ? (
                <GeneralTab snapshot={snapshot} onSave={saveSetting} />
              ) : tab === 'mcpServers' ? (
                <McpServersTab
                  snapshot={snapshot}
                  runCommand={runCommand}
                  setSnapshot={setSnapshot}
                  scrollViewportRef={scrollViewportRef}
                />
              ) : tab === 'hooks' ? (
                <HooksTab
                  snapshot={snapshot}
                  runCommand={runCommand}
                  setSnapshot={setSnapshot}
                  onSave={saveSetting}
                  scrollViewportRef={scrollViewportRef}
                />
              ) : (
                <ExtensionsTab
                  snapshot={snapshot}
                  runCommand={runCommand}
                  setSnapshot={setSnapshot}
                />
              )}

              {snapshot ? (
                <div className="flex justify-end">
                  <Button variant="ghost" size="sm" onClick={() => void load()}>
                    <RefreshCw className="w-4 h-4 mr-2" />
                    {t('settings.nessy.refresh')}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <SettingsCard className="px-4 py-8">
      <div className="text-center">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
      </div>
    </SettingsCard>
  );
}

function GeneralTab({
  snapshot,
  onSave,
}: {
  snapshot: NessyCoreSettingsSnapshot;
  onSave: (
    key: NessyCoreSettingKey,
    value: NessySettingValue,
    scope?: NessySettingsScope,
  ) => Promise<void>;
}) {
  const { t } = useTranslation();
  const outputLanguage = stringValue(
    snapshot,
    'general.outputLanguage',
    'auto',
  );
  const [outputLanguageDraft, setOutputLanguageDraft] =
    useState(outputLanguage);
  useEffect(() => setOutputLanguageDraft(outputLanguage), [outputLanguage]);
  const approvalModeOptions = useMemo(
    () => [
      { value: 'plan', label: t('settings.nessy.approvalMode.plan') },
      { value: 'default', label: t('settings.nessy.approvalMode.default') },
      { value: 'auto-edit', label: t('settings.nessy.approvalMode.autoEdit') },
      { value: 'auto', label: t('settings.nessy.approvalMode.auto') },
    ],
    [t],
  );
  const fileEncodingOptions = useMemo(
    () => [
      { value: 'utf-8', label: 'UTF-8' },
      { value: 'utf-8-bom', label: t('settings.nessy.fileEncoding.utf8Bom') },
    ],
    [t],
  );

  return (
    <>
      <SettingsSection
        title={t('settings.nessy.general.responseLanguage')}
        description={t('settings.nessy.general.responseLanguageDesc')}
      >
        <SettingsCard>
          <SettingsInput
            inCard
            label={t('settings.nessy.general.outputLanguage')}
            description={t('settings.nessy.general.outputLanguageDesc')}
            value={outputLanguageDraft}
            placeholder={t('settings.nessy.option.auto')}
            onChange={(value) => {
              setOutputLanguageDraft(value);
              void onSave('general.outputLanguage', value);
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t('settings.nessy.general.everydayBehavior')}
        description={t('settings.nessy.general.everydayBehaviorDesc')}
      >
        <SettingsCard>
          <SettingsSelect
            inCard
            label={t('settings.nessy.general.toolApprovalMode')}
            description={t('settings.nessy.general.toolApprovalModeDesc')}
            value={stringValue(snapshot, 'tools.approvalMode', 'default')}
            options={approvalModeOptions}
            onValueChange={(value) => void onSave('tools.approvalMode', value)}
          />
          <SettingsToggle
            label={t('settings.nessy.general.commitAttribution')}
            description={t('settings.nessy.general.commitAttributionDesc')}
            checked={boolValue(snapshot, 'general.gitCoAuthor.commit', true)}
            onCheckedChange={(checked) =>
              void onSave('general.gitCoAuthor.commit', checked)
            }
          />
          <SettingsToggle
            label={t('settings.nessy.general.prAttribution')}
            description={t('settings.nessy.general.prAttributionDesc')}
            checked={boolValue(snapshot, 'general.gitCoAuthor.pr', true)}
            onCheckedChange={(checked) =>
              void onSave('general.gitCoAuthor.pr', checked)
            }
          />
          <SettingsSelect
            inCard
            label={t('settings.nessy.general.defaultFileEncoding')}
            description={t('settings.nessy.general.defaultFileEncodingDesc')}
            value={stringValue(
              snapshot,
              'general.defaultFileEncoding',
              'utf-8',
            )}
            options={fileEncodingOptions}
            onValueChange={(value) =>
              void onSave('general.defaultFileEncoding', value)
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t('settings.nessy.general.fileSearch')}
        description={t('settings.nessy.general.fileSearchDesc')}
      >
        <SettingsCard>
          <SettingsToggle
            label={t('settings.nessy.general.respectGitIgnore')}
            description={t('settings.nessy.general.respectGitIgnoreDesc')}
            checked={boolValue(
              snapshot,
              'context.fileFiltering.respectGitIgnore',
              true,
            )}
            onCheckedChange={(checked) =>
              void onSave('context.fileFiltering.respectGitIgnore', checked)
            }
          />
          <SettingsToggle
            label={t('settings.nessy.general.respectNessyIgnore')}
            description={t('settings.nessy.general.respectNessyIgnoreDesc')}
            checked={boolValue(
              snapshot,
              'context.fileFiltering.respectNessyIgnore',
              true,
            )}
            onCheckedChange={(checked) =>
              void onSave('context.fileFiltering.respectNessyIgnore', checked)
            }
          />
          <SettingsToggle
            label={t('settings.nessy.general.fuzzyFileSearch')}
            description={t('settings.nessy.general.fuzzyFileSearchDesc')}
            checked={boolValue(
              snapshot,
              'context.fileFiltering.enableFuzzySearch',
              true,
            )}
            onCheckedChange={(checked) =>
              void onSave('context.fileFiltering.enableFuzzySearch', checked)
            }
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}

// [nessy-fork] desktop-mcp-management
function McpServersTab({
  snapshot,
  runCommand,
  setSnapshot,
  scrollViewportRef,
}: {
  snapshot: NessyCoreSettingsSnapshot;
  runCommand: RunNessySettingsCommand;
  setSnapshot: (snapshot: NessyCoreSettingsSnapshot) => void;
  scrollViewportRef: RefObject<HTMLDivElement>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<McpDraft>(createEmptyMcpDraft);
  const [showEditor, setShowEditor] = useState(false);
  const [editorScrollRequest, setEditorScrollRequest] = useState(0);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [mcpStatus, setMcpStatus] = useState<NessyMcpStatusSnapshot | null>(
    null,
  );
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [selectedServerName, setSelectedServerName] = useState<string | null>(
    null,
  );
  const [detailTab, setDetailTab] = useState<
    'overview' | 'tools' | 'resources'
  >('overview');
  const [tools, setTools] = useState<NessyMcpToolStatus[]>([]);
  const [resources, setResources] = useState<NessyMcpResourceStatus[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<
    NessyMcpManageAction | 'restart' | null
  >(null);
  const scopeOptions = useMemo(
    () => [
      { value: 'user', label: t('settings.nessy.scope.user') },
      { value: 'workspace', label: t('settings.nessy.scope.project') },
    ],
    [t],
  );
  const entries = useMemo(
    () => [
      ...snapshot.user.mcpServers,
      ...snapshot.workspace.mcpServers,
      ...snapshot.merged.mcpServers.filter(
        (entry) => entry.scope === 'extension',
      ),
    ],
    [snapshot],
  );
  const statusByName = useMemo(
    () =>
      new Map(
        (mcpStatus?.servers ?? []).map((server) => [server.name, server]),
      ),
    [mcpStatus],
  );
  const selectedServer = selectedServerName
    ? (statusByName.get(selectedServerName) ?? null)
    : null;

  const openEditor = useCallback((nextDraft: McpDraft) => {
    setDraft(nextDraft);
    setShowEditor(true);
    setEditorScrollRequest((count) => count + 1);
  }, []);

  useEffect(() => {
    if (!showEditor) return;
    const frameId = requestAnimationFrame(() => {
      const viewport = scrollViewportRef.current;
      const editor = editorRef.current;
      if (!viewport || !editor) return;
      const viewportRect = viewport.getBoundingClientRect();
      const editorRect = editor.getBoundingClientRect();
      viewport.scrollTo({
        top: Math.max(
          0,
          viewport.scrollTop + editorRect.top - viewportRect.top - 8,
        ),
        behavior: 'smooth',
      });
    });
    return () => cancelAnimationFrame(frameId);
  }, [editorScrollRequest, scrollViewportRef, showEditor]);

  const refreshStatus = useCallback(async (silent = false) => {
    if (!window.electronAPI) return;
    if (!silent) setStatusLoading(true);
    setStatusError(null);
    try {
      setMcpStatus(await window.electronAPI.getNessyMcpStatus());
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!silent) setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    const shouldPoll =
      mcpStatus?.discoveryState === 'in_progress' ||
      mcpStatus?.servers.some(
        (server) => !server.disabled && server.mcpStatus === 'connecting',
      );
    if (!shouldPoll) return;
    const timeout = window.setTimeout(() => void refreshStatus(true), 750);
    return () => window.clearTimeout(timeout);
  }, [mcpStatus, refreshStatus]);

  const loadDetails = useCallback(
    async (serverName: string) => {
      if (!window.electronAPI) return;
      setDetailLoading(true);
      setTools([]);
      setResources([]);
      try {
        const [toolSnapshot, resourceSnapshot] = await Promise.all([
          window.electronAPI.getNessyMcpTools(serverName),
          window.electronAPI.getNessyMcpResources(serverName),
        ]);
        setTools(toolSnapshot.tools);
        setResources(resourceSnapshot.resources);
      } catch (error) {
        toast.error(t('settings.nessy.mcp.detailsFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setDetailLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    if (!selectedServerName) {
      setTools([]);
      setResources([]);
      return;
    }
    void loadDetails(selectedServerName);
  }, [loadDetails, selectedServerName]);

  const runServerAction = async (
    serverName: string,
    action: NessyMcpManageAction | 'restart',
  ) => {
    if (!window.electronAPI || busyAction) return;
    setBusyAction(action);
    try {
      if (action === 'restart') {
        await window.electronAPI.restartNessyMcpServer(serverName);
      } else {
        await window.electronAPI.manageNessyMcpServer(serverName, action);
      }
      await refreshStatus(true);
      await loadDetails(serverName);
    } catch (error) {
      toast.error(t('settings.nessy.mcp.actionFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const save = async () => {
    if (!draft.name.trim() || !draft.commandOrUrl.trim()) return;
    const result = await runCommand({
      type: 'setNessyMcpServer',
      scope: draft.scope,
      name: draft.name.trim(),
      server: draftToServer(draft),
    });
    if (result) {
      setSnapshot(result);
      setDraft(createEmptyMcpDraft());
      setShowEditor(false);
      await refreshStatus();
    }
  };

  const remove = async (entry: NessyMcpServerEntry) => {
    if (entry.scope !== 'user' && entry.scope !== 'workspace') return;
    const result = await runCommand({
      type: 'removeNessyMcpServer',
      scope: entry.scope,
      name: entry.name,
    });
    if (result) {
      setSnapshot(result);
      await refreshStatus();
    }
  };

  return (
    <>
      <SettingsSection
        title={t('settings.nessy.mcp.configuredServers')}
        description={t('settings.nessy.mcp.configuredServersDesc')}
      >
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={() => openEditor(createEmptyMcpDraft())}>
            <Plus className="w-4 h-4" />
            {t('settings.nessy.mcp.addServer')}
          </Button>
        </div>
        {statusError ? (
          <div className="mt-3 text-xs text-destructive flex gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{statusError}</span>
          </div>
        ) : null}
        <div className="mt-3 space-y-3">
          {entries.length === 0 ? (
            <EmptyState
              title={t('settings.nessy.mcp.noServersTitle')}
              description={t('settings.nessy.mcp.noServersDesc')}
            />
          ) : (
            entries.map((entry) => {
              const runtime = statusByName.get(entry.name);
              const label = runtime?.disabled
                ? t('settings.nessy.mcp.status.disabled')
                : runtime?.requiresAuth
                  ? t('settings.nessy.mcp.status.authRequired')
                  : runtime?.mcpStatus === 'connected'
                    ? t('settings.nessy.mcp.status.connected')
                    : runtime?.mcpStatus === 'connecting'
                      ? t('settings.nessy.mcp.status.connecting')
                      : runtime
                        ? t('settings.nessy.mcp.status.disconnected')
                        : t('settings.nessy.mcp.status.checking');
              const badgeClass =
                runtime?.disabled || runtime?.requiresAuth
                  ? 'text-amber-700 border-amber-500/40'
                  : runtime?.mcpStatus === 'connected'
                    ? 'text-emerald-700 border-emerald-500/40'
                    : runtime?.mcpStatus === 'connecting' || !runtime
                      ? 'text-muted-foreground'
                      : 'text-destructive border-destructive/40';
              return (
                <SettingsCard
                  key={`${entry.scope}:${entry.name}`}
                  className="px-4 py-3.5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="text-sm font-medium">{entry.name}</div>
                        <Badge variant="outline" className={badgeClass}>
                          {label}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {entry.scope} · {entry.server.transport} ·{' '}
                        {entry.server.command ??
                          entry.server.httpUrl ??
                          entry.server.url}
                      </div>
                      {entry.server.description ? (
                        <div className="text-xs text-muted-foreground mt-1">
                          {entry.server.description}
                        </div>
                      ) : null}
                      {runtime ? (
                        <div className="text-xs text-muted-foreground mt-2 flex flex-wrap gap-3">
                          <span>{runtime.toolCount ?? 0} tools</span>
                          <span>{runtime.promptCount ?? 0} prompts</span>
                          <span>{runtime.resourceCount ?? 0} resources</span>
                          {(runtime.invalidToolCount ?? 0) > 0 ? (
                            <span className="text-amber-700">
                              {runtime.invalidToolCount} invalid
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setDetailTab('overview');
                          setSelectedServerName(entry.name);
                        }}
                      >
                        {t('settings.nessy.mcp.details')}
                      </Button>
                      {entry.scope === 'extension' ? null : (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => openEditor(serverToDraft(entry))}
                            aria-label={t('common.edit')}
                          >
                            <Settings2 className="w-4 h-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void remove(entry)}
                          >
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </SettingsCard>
              );
            })
          )}
        </div>
      </SettingsSection>

      <Dialog
        open={selectedServerName !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedServerName(null);
        }}
      >
        <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{selectedServerName}</DialogTitle>
            <DialogDescription>
              {selectedServer
                ? `${selectedServer.source ?? 'user'} · ${selectedServer.transport}`
                : t('settings.nessy.mcp.status.checking')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            {(['overview', 'tools', 'resources'] as const).map((tab) => (
              <Button
                key={tab}
                size="sm"
                variant={detailTab === tab ? 'default' : 'ghost'}
                onClick={() => setDetailTab(tab)}
              >
                {tab === 'overview' ? (
                  <Settings2 className="w-4 h-4" />
                ) : tab === 'tools' ? (
                  <Wrench className="w-4 h-4" />
                ) : (
                  <Database className="w-4 h-4" />
                )}
                {t(`settings.nessy.mcp.tab.${tab}`)}
              </Button>
            ))}
          </div>
          {detailLoading ? (
            <div className="py-10 flex justify-center">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : detailTab === 'tools' ? (
            <div className="space-y-3">
              {tools.length === 0 ? (
                <div className="text-sm text-muted-foreground">
                  {t('settings.nessy.mcp.noTools')}
                </div>
              ) : (
                tools.map((tool) => (
                  <SettingsCard key={tool.name} className="p-4" divided={false}>
                    <div className="flex items-center gap-2">
                      <div className="text-sm font-medium">{tool.name}</div>
                      {!tool.isValid ? (
                        <Badge variant="outline" className="text-amber-700">
                          {tool.invalidReason}
                        </Badge>
                      ) : null}
                    </div>
                    {tool.description ? (
                      <p className="text-xs text-muted-foreground mt-2">
                        {tool.description}
                      </p>
                    ) : null}
                    {tool.schema ? (
                      <pre className="mt-3 text-xs overflow-x-auto rounded-md bg-muted/50 p-3">
                        {JSON.stringify(tool.schema, null, 2)}
                      </pre>
                    ) : null}
                    {tool.annotations ? (
                      <pre className="mt-3 text-xs overflow-x-auto rounded-md bg-muted/50 p-3">
                        {JSON.stringify(tool.annotations, null, 2)}
                      </pre>
                    ) : null}
                  </SettingsCard>
                ))
              )}
            </div>
          ) : detailTab === 'resources' ? (
            <div className="space-y-3">
              {resources.length === 0 ? (
                <div className="text-sm text-muted-foreground">
                  {t('settings.nessy.mcp.noResources')}
                </div>
              ) : (
                resources.map((resource) => (
                  <SettingsCard
                    key={resource.uri}
                    className="p-4"
                    divided={false}
                  >
                    <div className="text-sm font-medium">
                      {resource.title ?? resource.name ?? resource.uri}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 break-all">
                      {resource.uri}
                    </div>
                    {resource.description ? (
                      <p className="text-xs mt-2">{resource.description}</p>
                    ) : null}
                    <div className="text-xs text-muted-foreground mt-2">
                      {[
                        resource.mimeType,
                        resource.size === undefined
                          ? null
                          : `${resource.size} bytes`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                    <code className="block mt-3 text-xs break-all">
                      @{resource.serverName}:{resource.uri}
                    </code>
                  </SettingsCard>
                ))
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {selectedServer?.description ? (
                <p className="text-sm text-muted-foreground">
                  {selectedServer.description}
                </p>
              ) : null}
              <div className="grid grid-cols-3 gap-3 text-sm">
                <SettingsCard className="p-3" divided={false}>
                  {selectedServer?.toolCount ?? tools.length} tools
                </SettingsCard>
                <SettingsCard className="p-3" divided={false}>
                  {selectedServer?.promptCount ?? 0} prompts
                </SettingsCard>
                <SettingsCard className="p-3" divided={false}>
                  {selectedServer?.resourceCount ?? resources.length} resources
                </SettingsCard>
              </div>
              {selectedServer ? (
                <div className="flex flex-wrap gap-2">
                  {!selectedServer.disabled &&
                  selectedServer.mcpStatus === 'disconnected' ? (
                    <Button
                      size="sm"
                      onClick={() =>
                        void runServerAction(selectedServer.name, 'restart')
                      }
                      disabled={busyAction !== null}
                    >
                      <RefreshCw className="w-4 h-4" />
                      {t('settings.nessy.mcp.reconnect')}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void runServerAction(
                        selectedServer.name,
                        selectedServer.disabled ? 'enable' : 'disable',
                      )
                    }
                    disabled={busyAction !== null}
                  >
                    <Power className="w-4 h-4" />
                    {selectedServer.disabled
                      ? t('settings.nessy.mcp.enable')
                      : t('settings.nessy.mcp.disable')}
                  </Button>
                  {!selectedServer.disabled && selectedServer.oauthEnabled ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void runServerAction(
                          selectedServer.name,
                          'authenticate',
                        )
                      }
                      disabled={busyAction !== null}
                    >
                      {selectedServer.hasOAuthTokens
                        ? t('settings.nessy.mcp.reauthenticate')
                        : t('settings.nessy.mcp.authenticate')}
                    </Button>
                  ) : null}
                  {!selectedServer.disabled && selectedServer.hasOAuthTokens ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void runServerAction(selectedServer.name, 'clear-auth')
                      }
                      disabled={busyAction !== null}
                    >
                      {t('settings.nessy.mcp.clearAuth')}
                    </Button>
                  ) : null}
                  {busyAction ? (
                    <Loader2 className="w-4 h-4 animate-spin self-center" />
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {showEditor ? (
        <div ref={editorRef}>
          <SettingsSection
            title={t('settings.nessy.mcp.addOrEditServer')}
            description={t('settings.nessy.mcp.addOrEditServerDesc')}
          >
            <SettingsCard className="p-4 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <SettingsSelect
                  label={t('settings.nessy.common.scope')}
                  value={draft.scope}
                  options={scopeOptions}
                  onValueChange={(scope) =>
                    setDraft((current) => ({
                      ...current,
                      scope: scope as NessySettingsScope,
                    }))
                  }
                />
                <SettingsSelect
                  label={t('settings.nessy.mcp.transport')}
                  value={draft.transport}
                  options={TRANSPORT_OPTIONS}
                  onValueChange={(transport) =>
                    setDraft((current) => ({
                      ...current,
                      transport: transport as NessyMcpTransport,
                    }))
                  }
                />
                <SettingsInput
                  label={t('settings.nessy.common.name')}
                  value={draft.name}
                  onChange={(name) =>
                    setDraft((current) => ({ ...current, name }))
                  }
                  placeholder="my-server"
                />
              </div>
              <SettingsInput
                label={
                  draft.transport === 'stdio'
                    ? t('settings.nessy.common.command')
                    : t('settings.nessy.common.url')
                }
                value={draft.commandOrUrl}
                onChange={(commandOrUrl) =>
                  setDraft((current) => ({ ...current, commandOrUrl }))
                }
                placeholder={
                  draft.transport === 'stdio'
                    ? 'node'
                    : 'http://localhost:3000/mcp'
                }
              />
              {draft.transport === 'stdio' ? (
                <SettingsTextarea
                  label={t('settings.nessy.mcp.arguments')}
                  description={t('settings.nessy.mcp.oneArgumentPerLine')}
                  value={draft.args}
                  onChange={(args) =>
                    setDraft((current) => ({ ...current, args }))
                  }
                  placeholder={'-m\nmy_mcp_server'}
                  rows={3}
                />
              ) : (
                <SettingsTextarea
                  label={t('settings.nessy.common.headers')}
                  description={t('settings.nessy.common.oneKeyValuePerLine')}
                  value={draft.headers}
                  onChange={(headers) =>
                    setDraft((current) => ({ ...current, headers }))
                  }
                  placeholder="Authorization=Bearer ${TOKEN}"
                  rows={3}
                />
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <SettingsInput
                  label={t('settings.nessy.common.timeout')}
                  value={draft.timeout}
                  onChange={(timeout) =>
                    setDraft((current) => ({ ...current, timeout }))
                  }
                  placeholder="15000"
                />
                <SettingsInput
                  label={t('settings.nessy.common.description')}
                  value={draft.description}
                  onChange={(description) =>
                    setDraft((current) => ({ ...current, description }))
                  }
                  placeholder="Internal tools"
                />
              </div>
              {draft.transport === 'stdio' ? (
                <SettingsTextarea
                  label={t('settings.nessy.common.environment')}
                  description={t('settings.nessy.common.oneKeyValuePerLine')}
                  value={draft.env}
                  onChange={(env) =>
                    setDraft((current) => ({ ...current, env }))
                  }
                  placeholder="API_KEY=${API_KEY}"
                  rows={3}
                />
              ) : null}
              <SettingsToggle
                inCard={false}
                label={t('settings.nessy.mcp.trustThisServer')}
                description={t('settings.nessy.mcp.trustThisServerDesc')}
                checked={draft.trust}
                onCheckedChange={(trust) =>
                  setDraft((current) => ({ ...current, trust }))
                }
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setDraft(createEmptyMcpDraft());
                    setShowEditor(false);
                  }}
                >
                  {t('common.clear')}
                </Button>
                <Button
                  onClick={() => void save()}
                  disabled={!draft.name.trim() || !draft.commandOrUrl.trim()}
                >
                  <Save className="w-4 h-4 mr-2" />
                  {t('settings.nessy.mcp.saveServer')}
                </Button>
              </div>
            </SettingsCard>
          </SettingsSection>
        </div>
      ) : null}
    </>
  );
}

function HooksTab({
  snapshot,
  runCommand,
  setSnapshot,
  onSave,
  scrollViewportRef,
}: {
  snapshot: NessyCoreSettingsSnapshot;
  runCommand: RunNessySettingsCommand;
  setSnapshot: (snapshot: NessyCoreSettingsSnapshot) => void;
  onSave: (
    key: NessyCoreSettingKey,
    value: NessySettingValue,
    scope?: NessySettingsScope,
  ) => Promise<void>;
  scrollViewportRef: RefObject<HTMLDivElement>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<HookDraft>(createEmptyHookDraft);
  const [showEditor, setShowEditor] = useState(false);
  const [editorScrollRequest, setEditorScrollRequest] = useState(0);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const scopeOptions = useMemo(
    () => [
      { value: 'user', label: t('settings.nessy.scope.user') },
      { value: 'workspace', label: t('settings.nessy.scope.project') },
    ],
    [t],
  );
  const hookTypeOptions = useMemo(
    () => [
      { value: 'command', label: t('settings.nessy.common.command') },
      { value: 'http', label: 'HTTP' },
    ],
    [t],
  );
  const entries = useMemo(
    () => [
      ...snapshot.user.hooks,
      ...snapshot.workspace.hooks,
      ...snapshot.merged.hooks.filter((entry) => entry.scope === 'extension'),
    ],
    [snapshot],
  );

  const openEditor = useCallback((nextDraft: HookDraft) => {
    setDraft(nextDraft);
    setShowEditor(true);
    setEditorScrollRequest((count) => count + 1);
  }, []);

  useEffect(() => {
    if (!showEditor) return;
    const frameId = requestAnimationFrame(() => {
      const viewport = scrollViewportRef.current;
      const editor = editorRef.current;
      if (!viewport || !editor) return;
      const viewportRect = viewport.getBoundingClientRect();
      const editorRect = editor.getBoundingClientRect();
      viewport.scrollTo({
        top: Math.max(
          0,
          viewport.scrollTop + editorRect.top - viewportRect.top - 8,
        ),
        behavior: 'smooth',
      });
    });
    return () => cancelAnimationFrame(frameId);
  }, [editorScrollRequest, scrollViewportRef, showEditor]);

  const save = async () => {
    if (!draft.commandOrUrl.trim()) return;
    const result = await runCommand({
      type: 'setNessyHook',
      scope: draft.scope,
      event: draft.event,
      index: draft.index,
      hook: draftToHook(draft),
    });
    if (result) {
      setSnapshot(result);
      setDraft(createEmptyHookDraft());
      setShowEditor(false);
    }
  };

  const remove = async (entry: NessyHookEntry) => {
    if (entry.scope !== 'user' && entry.scope !== 'workspace') return;
    const result = await runCommand({
      type: 'removeNessyHook',
      scope: entry.scope,
      event: entry.event,
      index: entry.index,
    });
    if (result) setSnapshot(result);
  };

  return (
    <>
      <SettingsSection
        title={t('settings.nessy.hooks.hookControl')}
        description={t('settings.nessy.hooks.hookControlDesc')}
      >
        <SettingsCard>
          <SettingsToggle
            label={t('settings.nessy.hooks.disableAllHooks')}
            description={t('settings.nessy.hooks.disableAllHooksDesc')}
            checked={boolValue(snapshot, 'disableAllHooks', false)}
            onCheckedChange={(checked) =>
              void onSave('disableAllHooks', checked)
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t('settings.nessy.hooks.configuredHooks')}
        description={t('settings.nessy.hooks.configuredHooksDesc')}
      >
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            onClick={() => {
              openEditor(createEmptyHookDraft());
            }}
          >
            <Plus className="w-4 h-4" />
            {t('settings.nessy.hooks.addHook')}
          </Button>
        </div>
        <div className="mt-3 space-y-3">
          {entries.length === 0 ? (
            <EmptyState
              title={t('settings.nessy.hooks.noHooksTitle')}
              description={t('settings.nessy.hooks.noHooksDesc')}
            />
          ) : (
            entries.map((entry) => {
              const config = entry.hook.hooks[0];
              return (
                <SettingsCard
                  key={`${entry.scope}:${entry.event}:${entry.index}`}
                  className="px-4 py-3.5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{entry.event}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {entry.scope} · {config?.type} ·{' '}
                        {entry.hook.matcher || '*'}
                      </div>
                      <div className="text-xs font-mono text-muted-foreground mt-1 truncate">
                        {config?.command ?? config?.url}
                      </div>
                    </div>
                    {entry.scope === 'extension' ? null : (
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            openEditor(hookToDraft(entry));
                          }}
                          aria-label={t('common.edit')}
                        >
                          <Settings2 className="w-4 h-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void remove(entry)}
                        >
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
                      </div>
                    )}
                  </div>
                </SettingsCard>
              );
            })
          )}
        </div>
      </SettingsSection>

      {showEditor ? (
        <div ref={editorRef}>
          <SettingsSection
            title={t('settings.nessy.hooks.addOrEditHook')}
            description={t('settings.nessy.hooks.addOrEditHookDesc')}
          >
            <SettingsCard className="p-4 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <SettingsSelect
                  label={t('settings.nessy.common.scope')}
                  value={draft.scope}
                  options={scopeOptions}
                  onValueChange={(scope) =>
                    setDraft((current) => ({
                      ...current,
                      scope: scope as NessySettingsScope,
                    }))
                  }
                />
                <SettingsSelect
                  label={t('settings.nessy.hooks.event')}
                  value={draft.event}
                  options={HOOK_EVENT_OPTIONS}
                  onValueChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      event: event as NessyHookEvent,
                    }))
                  }
                />
                <SettingsSelect
                  label={t('settings.nessy.hooks.type')}
                  value={draft.type}
                  options={hookTypeOptions}
                  onValueChange={(type) =>
                    setDraft((current) => ({
                      ...current,
                      type: type as 'command' | 'http',
                    }))
                  }
                />
              </div>
              <SettingsInput
                label={t('settings.nessy.hooks.matcher')}
                value={draft.matcher}
                onChange={(matcher) =>
                  setDraft((current) => ({ ...current, matcher }))
                }
                placeholder="*"
              />
              <SettingsInput
                label={
                  draft.type === 'command'
                    ? t('settings.nessy.common.command')
                    : t('settings.nessy.common.url')
                }
                value={draft.commandOrUrl}
                onChange={(commandOrUrl) =>
                  setDraft((current) => ({ ...current, commandOrUrl }))
                }
                placeholder={
                  draft.type === 'command'
                    ? '$NESSY_PROJECT_DIR/.nessy/hooks/check.sh'
                    : 'http://127.0.0.1:8080/hook'
                }
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <SettingsInput
                  label={t('settings.nessy.common.name')}
                  value={draft.name}
                  onChange={(name) =>
                    setDraft((current) => ({ ...current, name }))
                  }
                />
                <SettingsInput
                  label={t('settings.nessy.common.timeout')}
                  value={draft.timeout}
                  onChange={(timeout) =>
                    setDraft((current) => ({ ...current, timeout }))
                  }
                  placeholder="10000"
                />
              </div>
              <SettingsInput
                label={t('settings.nessy.common.description')}
                value={draft.description}
                onChange={(description) =>
                  setDraft((current) => ({ ...current, description }))
                }
              />
              {draft.type === 'command' ? (
                <SettingsTextarea
                  label={t('settings.nessy.common.environment')}
                  description={t('settings.nessy.common.oneKeyValuePerLine')}
                  value={draft.env}
                  onChange={(env) =>
                    setDraft((current) => ({ ...current, env }))
                  }
                  rows={3}
                />
              ) : (
                <>
                  <SettingsTextarea
                    label={t('settings.nessy.common.headers')}
                    description={t('settings.nessy.common.oneKeyValuePerLine')}
                    value={draft.headers}
                    onChange={(headers) =>
                      setDraft((current) => ({ ...current, headers }))
                    }
                    rows={3}
                  />
                  <SettingsTextarea
                    label={t('settings.nessy.hooks.allowedEnvVars')}
                    description={t('settings.nessy.hooks.allowedEnvVarsDesc')}
                    value={draft.allowedEnvVars}
                    onChange={(allowedEnvVars) =>
                      setDraft((current) => ({ ...current, allowedEnvVars }))
                    }
                    rows={3}
                  />
                </>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <SettingsToggle
                  inCard={false}
                  label={t('settings.nessy.hooks.sequential')}
                  description={t('settings.nessy.hooks.sequentialDesc')}
                  checked={draft.sequential}
                  onCheckedChange={(sequential) =>
                    setDraft((current) => ({ ...current, sequential }))
                  }
                />
                <SettingsToggle
                  inCard={false}
                  label={
                    draft.type === 'command'
                      ? t('settings.nessy.hooks.async')
                      : t('settings.nessy.hooks.once')
                  }
                  description={
                    draft.type === 'command'
                      ? t('settings.nessy.hooks.asyncDesc')
                      : t('settings.nessy.hooks.onceDesc')
                  }
                  checked={draft.type === 'command' ? draft.async : draft.once}
                  onCheckedChange={(checked) =>
                    setDraft((current) =>
                      draft.type === 'command'
                        ? { ...current, async: checked }
                        : { ...current, once: checked },
                    )
                  }
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setDraft(createEmptyHookDraft());
                    setShowEditor(false);
                  }}
                >
                  {t('common.clear')}
                </Button>
                <Button
                  onClick={() => void save()}
                  disabled={!draft.commandOrUrl.trim()}
                >
                  <Save className="w-4 h-4 mr-2" />
                  {t('settings.nessy.hooks.saveHook')}
                </Button>
              </div>
            </SettingsCard>
          </SettingsSection>
        </div>
      ) : null}
    </>
  );
}

// [nessy-fork] desktop-extension-management
// "update available" per the CLI ExtensionUpdateState enum string.
const EXTENSION_UPDATE_AVAILABLE = 'update available';

function ExtensionsTab({
  snapshot,
  runCommand,
  setSnapshot,
}: {
  snapshot: NessyCoreSettingsSnapshot;
  runCommand: RunNessySettingsCommand;
  setSnapshot: (snapshot: NessyCoreSettingsSnapshot) => void;
}) {
  const { t } = useTranslation();
  // name -> ExtensionUpdateState string, populated on demand by "Check for updates".
  const [updateStates, setUpdateStates] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(
    async (changedExtension?: string) => {
      const result = await runCommand({ type: 'getNessyCoreSettings' });
      if (result) setSnapshot(result);
      if (changedExtension) {
        setUpdateStates((states) => {
          const next = { ...states };
          delete next[changedExtension];
          return next;
        });
      }
    },
    [runCommand, setSnapshot],
  );

  const checkUpdates = useCallback(async () => {
    if (!window.electronAPI || checking) return;
    setChecking(true);
    try {
      const results = await window.electronAPI.checkExtensionUpdates();
      const next: Record<string, string> = {};
      for (const entry of results) next[entry.name] = entry.updateState;
      setUpdateStates(next);
      const available = results.filter(
        (entry) => entry.updateState === EXTENSION_UPDATE_AVAILABLE,
      ).length;
      toast.success(
        t('settings.nessy.extensions.checkUpdatesDone', {
          count: available,
        }),
      );
    } catch (error) {
      toast.error(
        t('settings.nessy.extensions.actionFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setChecking(false);
    }
  }, [checking, t]);

  return (
    <SettingsSection
      title={t('settings.nessy.extensions.installedExtensions')}
      description={t('settings.nessy.extensions.installedExtensionsDesc')}
    >
      {snapshot.merged.extensions.length > 0 ? (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void checkUpdates()}
            disabled={checking}
          >
            {checking ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            {t('settings.nessy.extensions.checkUpdates')}
          </Button>
        </div>
      ) : null}
      <div className="space-y-3 mt-3">
        {snapshot.merged.extensions.length === 0 ? (
          <EmptyState
            title={t('settings.nessy.extensions.noExtensionsTitle')}
            description={t('settings.nessy.extensions.noExtensionsDesc')}
          />
        ) : (
          snapshot.merged.extensions.map((extension) => (
            <ExtensionCard
              key={extension.id}
              extension={extension}
              runCommand={runCommand}
              setSnapshot={setSnapshot}
              updateState={updateStates[extension.name]}
              onChanged={() => refresh(extension.name)}
            />
          ))
        )}
      </div>
    </SettingsSection>
  );
}

function ExtensionCard({
  extension,
  runCommand,
  setSnapshot,
  updateState,
  onChanged,
}: {
  extension: NessyExtensionSettingsEntry;
  runCommand: RunNessySettingsCommand;
  setSnapshot: (snapshot: NessyCoreSettingsSnapshot) => void;
  updateState?: string;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<
    null | 'toggle' | 'update' | 'uninstall'
  >(null);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const updateAvailable = updateState === EXTENSION_UPDATE_AVAILABLE;

  const runAction = async (
    action: 'toggle' | 'update' | 'uninstall',
    fn: () => Promise<{ message?: string }>,
    success: (message?: string) => string,
  ) => {
    if (!window.electronAPI || busy) return;
    setBusy(action);
    try {
      const result = await fn();
      toast.success(success(result.message));
      await onChanged();
    } catch (error) {
      toast.error(
        t('settings.nessy.extensions.actionFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setBusy(null);
    }
  };

  const toggleEnabled = () =>
    runAction(
      'toggle',
      () =>
        window.electronAPI.setExtensionEnabled(
          undefined,
          extension.name,
          !extension.isActive,
          'user',
        ),
      () =>
        extension.isActive
          ? t('settings.nessy.extensions.disabledToast', {
              name: extension.name,
            })
          : t('settings.nessy.extensions.enabledToast', {
              name: extension.name,
            }),
    );

  const update = () =>
    runAction(
      'update',
      () => window.electronAPI.updateExtension(undefined, extension.name),
      (message) =>
        message ||
        t('settings.nessy.extensions.updatedToast', { name: extension.name }),
    );

  const uninstall = () =>
    runAction(
      'uninstall',
      () => window.electronAPI.uninstallExtension(undefined, extension.name),
      () =>
        t('settings.nessy.extensions.uninstalledToast', {
          name: extension.name,
        }),
    );

  return (
    <SettingsCard className="px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium flex items-center gap-2">
            {extension.displayName ?? extension.name}
            {updateAvailable ? (
              <Badge variant="secondary" className="text-[10px]">
                {t('settings.nessy.extensions.updateAvailable')}
              </Badge>
            ) : null}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {extension.version} ·{' '}
            {extension.isActive
              ? t('settings.nessy.extensions.active')
              : t('settings.nessy.extensions.inactive')}
          </div>
          <div className="text-[11px] text-muted-foreground/70 mt-1 truncate font-mono">
            {extension.path}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void toggleEnabled()}
            disabled={busy !== null}
            title={
              extension.isActive
                ? t('settings.nessy.extensions.disable')
                : t('settings.nessy.extensions.enable')
            }
          >
            {busy === 'toggle' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Power
                className={
                  extension.isActive
                    ? 'w-4 h-4 text-emerald-500'
                    : 'w-4 h-4 text-muted-foreground'
                }
              />
            )}
          </Button>
          {updateAvailable ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void update()}
              disabled={busy !== null}
              title={t('settings.nessy.extensions.update')}
            >
              {busy === 'update' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4 text-blue-500" />
              )}
            </Button>
          ) : null}
          {confirmUninstall ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => void uninstall()}
                disabled={busy !== null}
              >
                {busy === 'uninstall' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  t('settings.nessy.extensions.confirm')
                )}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmUninstall(false)}
                disabled={busy !== null}
              >
                {t('common.cancel')}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmUninstall(true)}
              disabled={busy !== null}
              title={t('settings.nessy.extensions.uninstall')}
            >
              <Trash2 className="w-4 h-4 text-destructive" />
            </Button>
          )}
        </div>
      </div>
      <div className="mt-3 text-xs text-muted-foreground">
        {t('settings.nessy.extensions.summary', {
          commands: extension.commands.length,
          skills: extension.skills.length,
          mcpServers: extension.mcpServers.length,
        })}
      </div>
      <div className="mt-3 divide-y divide-border/60">
        {extension.settings.length === 0 ? (
          <div className="py-3 text-xs text-muted-foreground">
            {t('settings.nessy.extensions.noConfigurableSettings')}
          </div>
        ) : (
          extension.settings.map((setting) => (
            <ExtensionSettingRow
              key={setting.envVar}
              extension={extension}
              setting={setting}
              runCommand={runCommand}
              setSnapshot={setSnapshot}
            />
          ))
        )}
      </div>
    </SettingsCard>
  );
}

function ExtensionSettingRow({
  extension,
  setting,
  runCommand,
  setSnapshot,
}: {
  extension: NessyExtensionSettingsEntry;
  setting: NessyExtensionSettingsEntry['settings'][number];
  runCommand: RunNessySettingsCommand;
  setSnapshot: (snapshot: NessyCoreSettingsSnapshot) => void;
}) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<NessySettingsScope>(
    setting.effectiveScope ?? 'user',
  );
  const scopeOptions = useMemo(
    () => [
      { value: 'user', label: t('settings.nessy.scope.user') },
      { value: 'workspace', label: t('settings.nessy.scope.project') },
    ],
    [t],
  );
  const [draft, setDraft] = useState(
    setting.sensitive ? '' : String(setting.effectiveValue ?? ''),
  );

  useEffect(() => {
    setScope(setting.effectiveScope ?? 'user');
    setDraft(setting.sensitive ? '' : String(setting.effectiveValue ?? ''));
  }, [setting]);

  const save = async () => {
    const result = await runCommand({
      type: 'setNessyExtensionSetting',
      extensionId: extension.id,
      settingKey: setting.envVar,
      scope,
      value: draft,
    });
    if (result) setSnapshot(result);
  };

  return (
    <div className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{setting.name}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {setting.description}
          </div>
          <div className="text-[11px] text-muted-foreground/70 mt-1 font-mono">
            {setting.envVar}
          </div>
        </div>
        <SettingsSelect
          value={scope}
          options={scopeOptions}
          onValueChange={(value) => setScope(value as NessySettingsScope)}
          className="w-32"
        />
      </div>
      <div className="flex gap-2 mt-2">
        <Input
          value={draft}
          type={setting.sensitive ? 'password' : 'text'}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={
            setting.sensitive &&
            (setting.hasUserValue || setting.hasWorkspaceValue)
              ? t('settings.nessy.extensions.storedSecurely')
              : t('settings.nessy.extensions.value')
          }
          className="h-8 bg-muted/50"
        />
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={!draft && setting.sensitive}
        >
          <Save className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
