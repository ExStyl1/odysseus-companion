import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search,
  Sparkles,
  FlaskConical,
  Code2,
  Workflow,
  ArrowUpRight,
  Package,
  Play,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PanelHeader } from '@/components/app-shell/PanelHeader';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { useAppShellContext } from '@/context/AppShellContext';
import { skillMentionInvocationId } from '@/lib/capability-catalog';
import { UI_SKILLS, filterUiSkills, type SkillRole, type UiSkill } from '@/lib/odysseus-skills';
const roles = [
  { id: 'general', icon: Sparkles },
  { id: 'qa', icon: FlaskConical },
  { id: 'dev', icon: Code2 },
  { id: 'sa', icon: Workflow },
] as const;
export function RoleSkillsCatalog({ onManagePlugins }: { onManagePlugins: () => void }) {
  const { t } = useTranslation(),
    app = useAppShellContext();
  const [role, setRole] = React.useState<SkillRole>('general'),
    [query, setQuery] = React.useState(''),
    [limit, setLimit] = React.useState(36);
  const [selected, setSelected] = React.useState<UiSkill | null>(null),
    [starting, setStarting] = React.useState<string | null>(null);
  const items = React.useMemo(() => filterUiSkills(role, query), [role, query]);
  const counts = React.useMemo(
    () =>
      Object.fromEntries(
        roles.map((r) => [r.id, UI_SKILLS.filter((s) => s.roles.includes(r.id)).length]),
      ),
    [],
  );
  const choose = (next: SkillRole) => {
    setRole(next);
    setLimit(36);
  };
  const prepare = async (skill: UiSkill) => {
    if (!app.openNewChat || starting) return;
    setStarting(skill.name);
    try {
      const native = app.capabilityCatalog?.capabilities.find(
        (row) => row.kind === 'skill' && row.logicalName === skill.name && row.state === 'active',
      );
      const prompt = native
        ? `Используй навык $${skillMentionInvocationId(native)}.\nСначала помоги уточнить задачу и необходимые исходные данные.`
        : skill.bundled
          ? await window.electronAPI.getOdysseusSkillPrompt(skill.name)
          : `Используй навык $${skill.name}.\nЕсли этот навык недоступен текущему агенту, сообщи об этом и помоги выбрать доступный аналог. Сначала уточни мою задачу.`;
      await app.openNewChat({
        name: t('roleSkills.chatName', { name: skill.name }),
        input: prompt,
      });
      setSelected(null);
    } catch {
      toast.error(t('roleSkills.launchFailed'));
    } finally {
      setStarting(null);
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PanelHeader
        title={t('roleSkills.title')}
        actions={
          <Button variant="ghost" size="sm" onClick={onManagePlugins}>
            <Package className="mr-2 h-4 w-4" />
            {t('roleSkills.manage')}
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 py-7">
          <div className="mb-6">
            <h1 className="text-2xl font-semibold tracking-tight">{t('roleSkills.heading')}</h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              {t('roleSkills.intro', { count: UI_SKILLS.length })}
            </p>
            <p className="mt-3 max-w-3xl text-sm text-muted-foreground">
              {t('roleSkills.selectionHelp')}
            </p>
          </div>
          <div
            role="tablist"
            aria-label={t('roleSkills.tabs')}
            className="mb-5 grid grid-cols-2 gap-2 rounded-xl bg-foreground/5 p-1.5 sm:grid-cols-4"
          >
            {roles.map(({ id, icon: Icon }, index) => (
              <button
                key={id}
                id={`role-tab-${id}`}
                type="button"
                role="tab"
                aria-selected={role === id}
                aria-controls="role-skills-panel"
                tabIndex={role === id ? 0 : -1}
                onClick={() => choose(id)}
                onKeyDown={(event) => {
                  const next =
                    event.key === 'ArrowRight'
                      ? (index + 1) % 4
                      : event.key === 'ArrowLeft'
                        ? (index + 3) % 4
                        : event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? 3
                            : -1;
                  if (next >= 0) {
                    event.preventDefault();
                    choose(roles[next]!.id);
                    document.getElementById(`role-tab-${roles[next]!.id}`)?.focus();
                  }
                }}
                className={`flex items-center justify-center gap-2 rounded-lg px-3 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${role === id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'}`}
              >
                <Icon className="h-4 w-4" />
                {t(`roleSkills.role.${id}`)}
                <span className="rounded-md bg-foreground/5 px-1.5 py-0.5 text-xs tabular-nums">
                  {counts[id]}
                </span>
              </button>
            ))}
          </div>
          <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">{t(`roleSkills.about.${role}`)}</p>
            <div className="relative w-full sm:w-80">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                aria-label={t('roleSkills.search')}
                placeholder={t('roleSkills.search')}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setLimit(36);
                }}
                className="pl-9"
              />
            </div>
          </div>
          <section id="role-skills-panel" role="tabpanel" aria-labelledby={`role-tab-${role}`}>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {items.slice(0, limit).map((skill) => (
                <article
                  key={skill.name}
                  className="flex min-h-52 flex-col rounded-xl border border-border/70 bg-background p-5 transition-colors hover:border-foreground/25"
                >
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <h2 className="break-words text-sm font-semibold">{skill.name}</h2>
                    <span className="shrink-0 rounded-full bg-foreground/5 px-2 py-1 text-[10px] text-muted-foreground">
                      {t(
                        !skill.bundled
                          ? 'roleSkills.agentRules'
                          : skill.automatic
                            ? 'roleSkills.automatic'
                            : 'roleSkills.explicit',
                      )}
                    </span>
                  </div>
                  <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
                    {skill.description}
                  </p>
                  {skill.autoCriteria.length > 0 && (
                    <div className="mb-4 rounded-lg bg-foreground/5 p-3 text-xs leading-relaxed">
                      <p className="mb-1 font-medium">{t('roleSkills.autoWhen')}</p>
                      <p className="text-muted-foreground">{skill.autoCriteria[0]}</p>
                    </div>
                  )}
                  <div className="mt-auto flex items-center justify-between gap-2 pt-2">
                    <Button variant="ghost" size="sm" onClick={() => setSelected(skill)}>
                      {t('roleSkills.details')}
                      <ArrowUpRight className="ml-1 h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!!starting || !app.openNewChat}
                      onClick={() => void prepare(skill)}
                    >
                      <Play className="mr-1.5 h-3 w-3" />
                      {starting === skill.name ? t('roleSkills.preparing') : t('roleSkills.apply')}
                    </Button>
                  </div>
                </article>
              ))}
            </div>
            {!items.length && (
              <p className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
                {t('roleSkills.empty')}
              </p>
            )}
            {items.length > limit && (
              <div className="mt-6 text-center">
                <Button variant="outline" onClick={() => setLimit((value) => value + 36)}>
                  {t('roleSkills.more', { count: items.length - limit })}
                </Button>
              </div>
            )}
            <p className="mt-6 text-xs text-muted-foreground">{t('roleSkills.note')}</p>
          </section>
        </div>
      </div>
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{selected?.name}</DialogTitle>
            <DialogDescription>{selected?.description}</DialogDescription>
          </DialogHeader>
          {selected && (
            <div className="space-y-5 text-sm leading-relaxed">
              <section>
                <h3 className="mb-1 font-medium">
                  {t(
                    selected.autoCriteria.length
                      ? 'roleSkills.autoWhen'
                      : selected.bundled
                        ? 'roleSkills.explicitWhen'
                        : 'roleSkills.agentRules',
                  )}
                </h3>
                {selected.autoCriteria.map((criterion) => (
                  <p key={criterion} className="text-muted-foreground">
                    {criterion}
                  </p>
                ))}
                <p className="mt-2 text-muted-foreground">
                  {t(
                    !selected.bundled
                      ? 'roleSkills.agentRulesHelp'
                      : selected.automatic
                        ? 'roleSkills.autoHelp'
                        : 'roleSkills.explicitHelp',
                  )}
                </p>
              </section>
              <section>
                <h3 className="mb-1 font-medium">{t('roleSkills.example')}</h3>
                <p className="rounded-lg bg-foreground/5 p-3 text-muted-foreground">
                  {selected.requestExample}
                </p>
              </section>
              {[
                ['how', selected.how],
                ['dependencies', selected.dependencies],
              ].map(([key, value]) => (
                <section key={key}>
                  <h3 className="mb-1 font-medium">{t(`roleSkills.${key}`)}</h3>
                  <p className="text-muted-foreground">{value}</p>
                </section>
              ))}
              <p className="text-xs text-muted-foreground">{t('roleSkills.draftOnly')}</p>
              <Button
                disabled={!!starting || !app.openNewChat}
                onClick={() => void prepare(selected)}
              >
                {t('roleSkills.apply')}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
