import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  ExternalLink,
  Loader2,
  Store,
  Shield,
  Copy,
  Check,
  FolderOpen,
  Layers,
  HelpCircle,
  UserRound,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { rendererLog } from '@/lib/logger';
import { cn } from '@/lib/utils';
import { useNavigation, routes } from '@/contexts/NavigationContext';
import { dispatchFocusInputEvent } from './input/focus-input-events';
import skillMarketHero from '@/assets/skill-market-hero.webp';
import { MarketplaceSkillIcon } from './MarketplaceSkillIcon';
import { SkillInstallButton } from './SkillInstallButton';
// [nessy-fork] desktop-skill-scope-management
// [nessy-fork] desktop-skill-marketplace-install-state
import type { SkillScope } from '@craft-agent/shared/protocol';
import type {
  SkillMarketplaceExample,
  SkillMarketplaceItem,
} from '../../../shared/types';

export interface SkillMarketplaceDetailPanelProps {
  workspaceId?: string;
  workingDirectory?: string;
  onWorkingDirectoryChange?: (path: string) => void;
  activeSessionId?: string | null;
  selectedSkillId?: string | null;
  onInstalled?: (options?: { force?: boolean }) => Promise<void> | void;
  installingSkillIds?: ReadonlySet<string>;
  onInstallStart?: (skillId: string) => void;
  onInstallFinish?: (skillId: string) => void;
  className?: string;
}

interface SkillDetails {
  tenant?: string;
  repoDisplay?: string;
  repoUrl?: string;
  author?: string;
  lastCommitAt?: string;
  firstCommitAt?: string;
  professions?: string[];
  tags?: string[];
  taxonomy?: Record<string, unknown>;
  enrichment?: {
    source?: string;
    status?: string;
    category?: string;
    updatedAt?: string;
    securityVerdict?: string;
  };
  installCommand?: string;
  sources?: Array<{
    tenant?: string;
    repoPath?: string;
    repoUrl?: string;
    skillUrl?: string;
    author?: string;
    relation?: string;
    lastCommitAt?: string;
  }>;
  aggregatedInstalls?: number;
  aggregatedAuthors?: string[];
}

function sourceHost(sourceUrl: string): string {
  try {
    return new URL(sourceUrl).host;
  } catch {
    return sourceUrl;
  }
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toLocaleDateString('ru-RU', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

function pluralVariants(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'вариант';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'варианта';
  return 'вариантов';
}

function formatSubdomains(subdomains: unknown): string {
  if (Array.isArray(subdomains)) return subdomains.join(', ');
  if (subdomains == null) return '';
  return String(subdomains);
}

function buildExamplePrompt(
  skill: SkillMarketplaceItem,
  example: SkillMarketplaceExample,
): string {
  return `[skill:${skill.slug}] ${example.prompt}`.trim();
}

export function SkillMarketplaceDetailPanel({
  workspaceId,
  workingDirectory,
  onWorkingDirectoryChange,
  activeSessionId,
  selectedSkillId,
  onInstalled,
  installingSkillIds,
  onInstallStart,
  onInstallFinish,
  className,
}: SkillMarketplaceDetailPanelProps) {
  const { t } = useTranslation();
  const { navigate } = useNavigation();
  const [skills, setSkills] = React.useState<SkillMarketplaceItem[]>([]);
  const [unlistedSkill, setUnlistedSkill] =
    React.useState<SkillMarketplaceItem | null>(null);
  const [resolvingSkill, setResolvingSkill] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [skillDetails, setSkillDetails] = React.useState<SkillDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = React.useState(false);
  const [detailsError, setDetailsError] = React.useState<string | null>(null);
  const [copiedCommand, setCopiedCommand] = React.useState(false);
  const loadSkills = React.useCallback(async () => {
    if (!workspaceId) {
      setSkills([]);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.listSkillMarketplace(
        workspaceId,
        workingDirectory,
        activeSessionId ?? undefined,
      );
      setSkills(result.items);
    } catch (loadError) {
      rendererLog.error(
        '[SkillMarketplaceDetailPanel] Failed to load skill marketplace:',
        loadError,
      );
      setError(
        t('skillMarketplace.loadFailed', 'Could not load the skill market.'),
      );
    } finally {
      setLoading(false);
    }
  }, [activeSessionId, t, workingDirectory, workspaceId]);

  React.useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  React.useEffect(() => {
    if (!workspaceId) return;
    const cleanup = window.electronAPI.onSkillsChanged((changedWorkspaceId) => {
      if (changedWorkspaceId === workspaceId) {
        void loadSkills();
      }
    });
    return cleanup;
  }, [loadSkills, workspaceId]);

  const listedSkill = selectedSkillId
    ? (skills.find((skill) => skill.id === selectedSkillId) ?? null)
    : null;

  // The catalog listing only covers its first page, so a skill opened from a
  // search or a deep link is often absent from it — resolve it on its own.
  React.useEffect(() => {
    if (!selectedSkillId || !workspaceId || listedSkill) {
      setUnlistedSkill(null);
      return;
    }
    // Keep the resolved skill while the listing reloads, or the detail view
    // would blank out after every install.
    if (loading) return;

    // [nessy-fork] desktop-skill-marketplace-pagination
    // Clear the previous unlisted skill when the selected skill ID changes,
    // otherwise the old skill briefly appears while the new one is loading.
    setUnlistedSkill(null);
    setResolvingSkill(true);

    let cancelled = false;
    window.electronAPI
      .getSkillFromMarketplace(
        workspaceId,
        selectedSkillId,
        workingDirectory,
        activeSessionId ?? undefined,
      )
      .then((skill) => {
        if (!cancelled) setUnlistedSkill(skill);
      })
      .catch((resolveError) => {
        if (cancelled) return;
        rendererLog.error(
          `[SkillMarketplaceDetailPanel] Failed to resolve skill ${selectedSkillId}:`,
          resolveError,
        );
        setUnlistedSkill(null);
      })
      .finally(() => {
        if (!cancelled) setResolvingSkill(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeSessionId,
    listedSkill,
    loading,
    selectedSkillId,
    workingDirectory,
    workspaceId,
  ]);

  const selectedSkill = listedSkill ?? unlistedSkill;

  // Load skill details when selected
  React.useEffect(() => {
    if (!selectedSkillId || !workspaceId || !selectedSkill) {
      setSkillDetails(null);
      return;
    }

    let cancelled = false;
    setDetailsLoading(true);
    setDetailsError(null);
    window.electronAPI
      .getSkillMarketplaceDetails(
        workspaceId,
        selectedSkill.detailsId ??
          selectedSkill.sourceUrl ??
          selectedSkill.websiteUrl ??
          '',
      )
      .then((details) => {
        if (!cancelled) {
          setSkillDetails(details as unknown as SkillDetails);
          setDetailsLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          rendererLog.error(
            '[SkillMarketplaceDetailPanel] Failed to load skill details:',
            err,
          );
          setSkillDetails(null);
          setDetailsError(
            t(
              'skillMarketplace.detailsFailed',
              'Не удалось загрузить детали Skill.',
            ),
          );
          setDetailsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    selectedSkillId,
    selectedSkill?.slug,
    selectedSkill?.detailsId,
    selectedSkill?.sourceUrl,
    selectedSkill?.websiteUrl,
    workspaceId,
    t,
  ]);

  const handleInstall = React.useCallback(
    async (
      skill: SkillMarketplaceItem,
      scope: SkillScope,
      installWorkingDirectory?: string,
    ) => {
      if (!workspaceId) return;
      if (installingSkillIds?.has(skill.id)) return;

      onInstallStart?.(skill.id);
      try {
        await window.electronAPI.installSkillFromMarketplace(
          workspaceId,
          skill.id,
          installWorkingDirectory ?? workingDirectory,
          activeSessionId ?? undefined,
          scope,
          skill.detailsId,
        );
        setSkills((items) =>
          items.map((item) =>
            item.id === skill.id
              ? {
                  ...item,
                  installed: true,
                  installedScopes: Array.from(
                    new Set([...item.installedScopes, scope]),
                  ),
                }
              : item,
          ),
        );
        setUnlistedSkill((current) =>
          current?.id === skill.id
            ? {
                ...current,
                installed: true,
                installedScopes: Array.from(
                  new Set([...current.installedScopes, scope]),
                ),
              }
            : current,
        );
        await onInstalled?.({ force: true });
        await loadSkills();
        toast.success(
          t('skillMarketplace.installedToast', {
            name: skill.name,
            defaultValue: '{{name}} installed',
          }),
        );
      } catch (installError) {
        rendererLog.error(
          '[SkillMarketplaceDetailPanel] Failed to install marketplace skill:',
          installError,
        );
        toast.error(
          t('skillMarketplace.installFailed', {
            name: skill.name,
            defaultValue: 'Failed to install {{name}}',
          }),
        );
      } finally {
        onInstallFinish?.(skill.id);
      }
    },
    [
      activeSessionId,
      installingSkillIds,
      loadSkills,
      onInstalled,
      onInstallFinish,
      onInstallStart,
      t,
      workingDirectory,
      workspaceId,
    ],
  );

  const handleUninstall = React.useCallback(
    async (skill: SkillMarketplaceItem, scope: SkillScope) => {
      if (!workspaceId) return;
      if (installingSkillIds?.has(skill.id)) return;

      onInstallStart?.(skill.id);
      try {
        await window.electronAPI.deleteSkill(
          workspaceId,
          skill.slug,
          workingDirectory,
          activeSessionId ?? undefined,
          scope,
        );
        setSkills((items) =>
          items.map((item) => {
            if (item.id !== skill.id) return item;
            const installedScopes = item.installedScopes.filter(
              (installedScope) => installedScope !== scope,
            );
            return {
              ...item,
              installed: installedScopes.length > 0,
              installedScopes,
            };
          }),
        );
        setUnlistedSkill((current) => {
          if (current?.id !== skill.id) return current;
          const installedScopes = current.installedScopes.filter(
            (installedScope) => installedScope !== scope,
          );
          return {
            ...current,
            installed: installedScopes.length > 0,
            installedScopes,
          };
        });
        await onInstalled?.({ force: true });
        await loadSkills();
        toast.success(`${skill.name} uninstalled`);
      } catch (uninstallError) {
        rendererLog.error(
          '[SkillMarketplaceDetailPanel] Failed to uninstall marketplace skill:',
          uninstallError,
        );
        toast.error(`Failed to uninstall ${skill.name}`);
      } finally {
        onInstallFinish?.(skill.id);
      }
    },
    [
      activeSessionId,
      installingSkillIds,
      loadSkills,
      onInstalled,
      onInstallFinish,
      onInstallStart,
      workingDirectory,
      workspaceId,
    ],
  );

  const handleUseExample = React.useCallback(
    (skill: SkillMarketplaceItem, example: SkillMarketplaceExample) => {
      if (!skill.installed) {
        toast.message(
          t('skillMarketplace.installBeforeExample', {
            name: skill.name,
            defaultValue: 'Install {{name}} to use examples',
          }),
        );
        return;
      }

      void navigate(
        routes.action.newSession({
          input: buildExamplePrompt(skill, example),
        }),
      );
      window.setTimeout(() => dispatchFocusInputEvent(), 120);
    },
    [navigate, t],
  );

  if ((loading || resolvingSkill) && !selectedSkill && !error) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('skillMarketplace.loading', 'Loading skills...')}
        </div>
      </div>
    );
  }

  if (error || !selectedSkill) {
    const emptyMessage =
      error ??
      (skills.length === 0
        ? t('skillMarketplace.empty', 'No skills are available yet.')
        : t('skillMarketplace.title', 'Skill Market'));

    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <div className="flex flex-col items-center gap-2 text-center">
          <Store className="h-5 w-5" />
          <p className="max-w-xs text-sm">{emptyMessage}</p>
        </div>
      </div>
    );
  }

  const heroImage = selectedSkill.heroImage ?? skillMarketHero;
  const isInstalling = installingSkillIds?.has(selectedSkill.id) ?? false;
  const hasExamples = selectedSkill.examples.length > 0;

  return (
    <ScrollArea className={cn('h-full', className)}>
      <div className="mx-auto flex w-full max-w-[1120px] flex-col px-8 py-9">
        <div className="flex items-start justify-between gap-5">
          <div className="flex min-w-0 items-start gap-4">
            <MarketplaceSkillIcon
              iconKey={selectedSkill.iconKey}
              className="h-16 w-16"
            />
            <div className="min-w-0 pt-1">
              <h1 className="truncate text-3xl font-semibold tracking-normal">
                {selectedSkill.name}
              </h1>
              {selectedSkill.installedScopes.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {selectedSkill.installedScopes.includes('project') && (
                    <div className="flex w-fit items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                      <FolderOpen className="h-3.5 w-3.5" />
                      {t(
                        'skillMarketplace.installedInProject',
                        'Installed in project',
                      )}
                    </div>
                  )}
                  {selectedSkill.installedScopes.includes('global') && (
                    <div className="flex w-fit items-center gap-1 rounded-full bg-sky-500/10 px-2 py-1 text-xs font-medium text-sky-700 dark:text-sky-400">
                      <UserRound className="h-3.5 w-3.5" />
                      {t(
                        'skillMarketplace.installedForUser',
                        'Installed for user',
                      )}
                    </div>
                  )}
                </div>
              )}
              {/* Unlike the list card's marker, there is room here for the
                  validator's message — which is what makes the skill fixable. */}
              {selectedSkill.parseError && (
                <div className="mt-2 flex w-fit items-start gap-1.5 rounded-lg bg-red-500/10 px-2 py-1 text-xs font-medium text-red-700 dark:text-red-400">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="break-words">
                    {t('skillsList.parseErrorTooltip', {
                      message: selectedSkill.parseError,
                    })}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 pt-1">
            <Button
              size="icon"
              variant="ghost"
              className="h-9 w-9"
              onClick={() =>
                void window.electronAPI.openUrl(
                  selectedSkill.websiteUrl ?? selectedSkill.sourceUrl,
                )
              }
              title={sourceHost(
                selectedSkill.websiteUrl ?? selectedSkill.sourceUrl,
              )}
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
            <SkillInstallButton
              installedScopes={selectedSkill.installedScopes}
              installing={isInstalling}
              workingDirectory={workingDirectory}
              onWorkingDirectoryChange={onWorkingDirectoryChange}
              onInstall={(scope, directory) =>
                handleInstall(selectedSkill, scope, directory)
              }
              onUninstall={(scope) =>
                void handleUninstall(selectedSkill, scope)
              }
            />
          </div>
        </div>

        {/* Категории (taxonomy) под заголовком */}
        {skillDetails?.taxonomy &&
          Object.keys(skillDetails.taxonomy).length > 0 && (
            <div className="mt-4 grid gap-x-10 gap-y-2 sm:grid-cols-2">
              {Object.entries(skillDetails.taxonomy).map(
                ([domain, subdomains]) => {
                  const sub = formatSubdomains(subdomains);
                  return (
                    <div
                      key={domain}
                      className="flex items-center gap-2 text-sm text-muted-foreground"
                    >
                      <Layers className="h-4 w-4 shrink-0 opacity-70" />
                      <span className="truncate">
                        {domain}
                        {sub && ` · ${sub}`}
                      </span>
                    </div>
                  );
                },
              )}
            </div>
          )}

        {hasExamples && (
          <div
            className="relative mt-10 min-h-[260px] overflow-hidden rounded-[8px] border border-white/10 bg-cover bg-center px-6 py-10 shadow-strong"
            style={{
              backgroundImage: `linear-gradient(90deg, rgba(5,10,18,0.42), rgba(5,10,18,0.16)), url(${heroImage})`,
            }}
          >
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_40%,rgba(255,255,255,0.12),transparent_42%)]" />
            <div className="relative flex min-h-[180px] flex-col items-center justify-center gap-4">
              {selectedSkill.examples.map((example, index) => (
                <button
                  key={example.title}
                  type="button"
                  aria-disabled={!selectedSkill.installed}
                  className={cn(
                    'flex max-w-full items-center gap-2 rounded-[8px] border border-white/14 bg-black/46 px-4 py-2.5 text-left text-white shadow-middle backdrop-blur-md transition',
                    selectedSkill.installed
                      ? 'hover:-translate-y-0.5 hover:bg-black/56'
                      : 'cursor-default opacity-55',
                    index === 0 && 'sm:translate-x-[-6%]',
                    index === 1 && 'sm:translate-x-[7%]',
                    index === 2 && 'sm:translate-x-[-1%]',
                  )}
                  onClick={() => handleUseExample(selectedSkill, example)}
                >
                  <MarketplaceSkillIcon
                    iconKey={selectedSkill.iconKey}
                    className="h-5 w-5 rounded-[6px]"
                  />
                  <span className="shrink-0 text-sm font-medium text-white/55">
                    {selectedSkill.name}
                  </span>
                  <span className="min-w-0 truncate text-sm">
                    {example.prompt}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Skill details section */}
        {detailsLoading && (
          <div className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('skillMarketplace.loadingDetails', 'Loading details...')}
          </div>
        )}

        {!detailsLoading && detailsError && (
          <div className="mt-8 text-sm text-muted-foreground">
            {detailsError}
          </div>
        )}

        {!detailsLoading && !detailsError && skillDetails && (
          <div className="mt-8 space-y-6">
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
              {/* Left card: Когда использовать + сведения */}
              <div className="rounded-2xl border border-border bg-card/40 p-6">
                <h2 className="text-lg font-semibold">
                  {t('skillMarketplace.whenToUse', 'Когда использовать')}
                </h2>
                <p className="mt-4 border-b border-border pb-6 text-[15px] leading-7 text-foreground/86">
                  {selectedSkill.description}
                </p>
                <dl className="divide-y divide-border">
                  <div className="grid grid-cols-[minmax(110px,150px)_1fr] gap-4 py-4 text-sm">
                    <dt className="text-muted-foreground">
                      {t('skillMarketplace.type', 'Тип')}
                    </dt>
                    <dd>AI Skill</dd>
                  </div>
                  {skillDetails.tenant && (
                    <div className="grid grid-cols-[minmax(110px,150px)_1fr] gap-4 py-4 text-sm">
                      <dt className="text-muted-foreground">
                        {t('skillMarketplace.tenant', 'Тенант')}
                      </dt>
                      <dd>{skillDetails.tenant}</dd>
                    </div>
                  )}
                  {(skillDetails.repoDisplay || skillDetails.repoUrl) && (
                    <div className="grid grid-cols-[minmax(110px,150px)_1fr] gap-4 py-4 text-sm">
                      <dt className="text-muted-foreground">
                        {t('skillMarketplace.repository', 'Репозиторий')}
                      </dt>
                      <dd className="min-w-0">
                        <button
                          type="button"
                          className="truncate text-left text-primary hover:underline"
                          onClick={() => {
                            if (skillDetails.repoUrl)
                              void window.electronAPI.openUrl(
                                skillDetails.repoUrl,
                              );
                          }}
                        >
                          {skillDetails.repoDisplay ?? skillDetails.repoUrl}
                        </button>
                      </dd>
                    </div>
                  )}
                  <div className="grid grid-cols-[minmax(110px,150px)_1fr] gap-4 py-4 text-sm">
                    <dt className="text-muted-foreground">
                      {t('skillMarketplace.file', 'Файл')}
                    </dt>
                    <dd>
                      <button
                        type="button"
                        className="text-left text-primary hover:underline"
                        onClick={() => {
                          const sourceUrl = selectedSkill.sourceUrl;
                          if (sourceUrl)
                            void window.electronAPI.openUrl(sourceUrl);
                        }}
                      >
                        SKILL.md
                      </button>
                    </dd>
                  </div>
                  {skillDetails.lastCommitAt && (
                    <div className="grid grid-cols-[minmax(110px,150px)_1fr] gap-4 py-4 text-sm">
                      <dt className="text-muted-foreground">
                        {t('skillMarketplace.updated', 'Обновлено')}
                      </dt>
                      <dd>{formatDate(skillDetails.lastCommitAt)}</dd>
                    </div>
                  )}
                  {skillDetails.author && (
                    <div className="grid grid-cols-[minmax(110px,150px)_1fr] gap-4 py-4 text-sm">
                      <dt className="text-muted-foreground">
                        {t('skillMarketplace.author', 'Ответственный')}
                      </dt>
                      <dd>{skillDetails.author}</dd>
                    </div>
                  )}
                </dl>
              </div>

              {/* Right column */}
              <div className="space-y-6">
                {/* Отчёт безопасности */}
                <div className="flex items-center justify-between rounded-2xl border border-border bg-card/40 px-5 py-4">
                  <span className="text-sm">
                    {t('skillMarketplace.security', 'Безопасность')}
                  </span>
                  <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    {skillDetails.enrichment?.securityVerdict ? (
                      <Shield className="h-4 w-4" />
                    ) : (
                      <HelpCircle className="h-4 w-4" />
                    )}
                    {skillDetails.enrichment?.securityVerdict ??
                      t('skillMarketplace.noReport', 'No report')}
                  </span>
                </div>

                {/* Установка */}
                {skillDetails.installCommand && (
                  <div className="rounded-2xl border border-border bg-card/40 p-5">
                    <h2 className="text-lg font-semibold">
                      {t('skillMarketplace.install', 'Установка')}
                    </h2>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Agent Package artifact ·{' '}
                      {t('skillMarketplace.original', 'Оригинал')}
                      {skillDetails.tenant && ` · ${skillDetails.tenant}`}
                      {(skillDetails.repoDisplay || skillDetails.repoUrl) &&
                        ` · ${skillDetails.repoDisplay ?? skillDetails.repoUrl}`}
                    </p>
                    <Button
                      variant="outline"
                      className="mt-4 w-full justify-center gap-2"
                      onClick={() => {
                        navigator.clipboard
                          .writeText(skillDetails.installCommand ?? '')
                          .then(() => {
                            setCopiedCommand(true);
                            setTimeout(() => setCopiedCommand(false), 2000);
                          })
                          .catch(() => {});
                      }}
                    >
                      {copiedCommand ? (
                        <Check className="h-4 w-4 text-emerald-500" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                      {copiedCommand
                        ? t('skillMarketplace.copied', 'Скопировано')
                        : t('skillMarketplace.copyCommand', 'Копировать')}
                    </Button>
                    <div className="mt-3 flex items-center gap-2 overflow-x-auto rounded-[8px] bg-muted px-3 py-2.5 text-xs text-muted-foreground">
                      <span className="shrink-0 text-muted-foreground/60">$</span>
                      <code className="whitespace-pre">
                        {skillDetails.installCommand}
                      </code>
                    </div>
                  </div>
                )}

                {/* Рекомендовано */}
                {skillDetails.aggregatedInstalls !== undefined && (
                  <div className="rounded-2xl border border-border bg-card/40 p-5">
                    <h2 className="text-sm font-semibold">
                      {t('skillMarketplace.recommended', 'Рекомендовано')}
                    </h2>
                    <div className="mt-2 flex items-baseline gap-2">
                      <span className="text-2xl font-semibold">
                        {skillDetails.aggregatedInstalls}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {t('skillMarketplace.times', 'раз')}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Источники Skill (на всю ширину) */}
            {skillDetails.sources && skillDetails.sources.length > 0 && (
              <div className="rounded-2xl border border-border bg-card/40 p-6">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold">
                    {t('skillMarketplace.sources', 'Источники Skill')}
                  </h2>
                  <span className="text-sm text-muted-foreground">
                    {skillDetails.sources.length}{' '}
                    {pluralVariants(skillDetails.sources.length)}
                  </span>
                </div>
                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  {skillDetails.sources.map((source, index) => {
                    const isOwner = source.relation === 'owner';
                    return (
                      <div
                        key={source.skillUrl ?? index}
                        className={cn(
                          'rounded-xl border p-4',
                          isOwner
                            ? 'border-primary/40 bg-primary/[0.03]'
                            : 'border-border',
                        )}
                      >
                        <div className="mb-2 flex items-center gap-2">
                          <span
                            className={cn(
                              'rounded-[4px] px-1.5 py-0.5 text-[10px] font-medium uppercase',
                              isOwner
                                ? 'bg-emerald-500/10 text-emerald-500'
                                : 'bg-muted text-muted-foreground',
                            )}
                          >
                            {isOwner
                              ? t('skillMarketplace.original', 'Оригинал')
                              : t('skillMarketplace.copy', 'Копия')}
                          </span>
                          {isOwner && (
                            <span className="rounded-[4px] border border-emerald-500/30 px-1.5 py-0.5 text-[10px] text-emerald-500">
                              {t('skillMarketplace.selected', 'Выбран')}
                            </span>
                          )}
                        </div>
                        <div className="text-sm font-medium">
                          {[source.tenant, source.repoPath]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                        {source.skillUrl && (
                          <div className="mt-0.5 break-all text-xs text-muted-foreground">
                            {source.skillUrl}
                          </div>
                        )}
                        {source.lastCommitAt && (
                          <div className="mt-2 text-xs text-muted-foreground/60">
                            {t('skillMarketplace.updated', 'Обновлено')}{' '}
                            {formatDate(source.lastCommitAt)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
