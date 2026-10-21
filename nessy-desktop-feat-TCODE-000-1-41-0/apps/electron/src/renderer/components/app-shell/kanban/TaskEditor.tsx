/* Copied from v0.13.4:apps/electron/src/renderer/components/app-shell/kanban/TaskEditor.tsx
   (craft-agents-oss, Apache-2.0) by UA3.6, 2026-10-02. STAGED COPY — the Manual editor (create and
   edit), Generate, its Run and its Results tab ship; each range below is out of this file until its row
   lands, and no control of this copy leads into one. UA5.10 restored the project picker: L9 (`useProjects`
   import), L513 (its binding), L523's `setProjectId`, L618/L640 (an edit starts on the task's project),
   L693 (the picked project's entity) and L1031–L1056 (the picker row, "No project" offered only while the
   task is unbound — the save floors a blank pick to the existing binding, `buildSpec`). The pick reaches
   the host as `spec.project`: a create binds the orchestrator to it and, with no folder picked, starts it
   in the project's folder through a re-validated handle (`createSession({ projectId })`, UA5.4); an attach
   rebinds the session's project and never moves its folder (`bindManagedSessionToTask`).
   Dropped, each with its reason (spec §3 and the port manifest):
   - L7's `ANTHROPIC_MODELS`, L50–L56: the fallback groups — reason (c): our catalogue is the workspace's
     connections (`model-catalog.ts`), with no Anthropic list to fall back to.
   - L29, L321–L353: upstream's `WorkingDirectorySelector` `FolderField` — reason (c), owner 2026-09-23:
     the editor renders OUR `ui/CompactWorkingDirectorySelector.tsx`, whose pick is an issued project
     HANDLE (recent folders and the trust prompt included). The handle travels as
     `TaskCreateRequest.projectHandleId`; the spec never carries a folder the user picked
     (`task-spec-form.ts` adaptation 3).
   Adaptations, each named:
   1. Models are grouped by connection, each group headed by the connection's name and a runtime chip
      (`model-catalog.ts`); gateway models are offered under their alias. A pick carries the connection of
      the group it was made under, and the check shows under that group only (UA3.6 follow-up; upstream's
      pick was the id alone, routed last-wins — `model-catalog.ts` adaptation 4).
   2. Our permission modes: the picker offers the workspace's modes in the composer's order
      (`PERMISSION_MODE_PICKER_ORDER`), a new task starts in the mode a new session of this workspace
      starts in (`defaultPermissionMode`; upstream started every task in `allow-all`), and an edit offers
      no mode above the bound session's own — the spec is clamped to it (`permissionModeCeiling`), as the
      host clamps the session (`bindManagedSessionToTask`). A CREATE offers and writes nothing above `auto`
      (`TASK_NEW_MODE_CEILING`, UA3.6 follow-up): `tasks:create` would start the orchestrator in
      `bypassPermissions` without the first-activation responsibility dialog (`BypassPermissionsDialog`,
      raised only from App.tsx `handleSessionOptionsChange`), and UA4.2 kept it ("No `allow-all`"; a
      child never runs above it); an edit of a session already in bypass keeps it (it activates nothing new).
      The bound session's mode is read LIVE from the session options map (the composer's own source),
      the meta-map snapshot only as fallback — UA12.157: the snapshot went stale the moment the
      session's mode changed, so the menu offered above the session's mode.
   3. The slug: a create derives it with `uniqueTaskSlug` against `tasks:list` (a second task with the same
      title gets `-2`, never the first one's folder; the host still refuses `task-slug-taken:<slug>` for a
      live session's slug); an edit keeps its slug, and an edit of a tile with no spec yet derives one the
      same way as a create.
   4. The folder in edit mode is shown, not picked: an attach never moves a session's folder (only
      `projects:setSessionProject` does, spec §10), so a picker there would be a control that does
      nothing. A folder whose trust is undecided raises our `ProjectTrustDialog` first, as the composer's
      badge does; the host accepts only a trusted handle (`task-cwd-untrusted`).
   5. Sources and skills are the capability catalogue's rows (`sourcesAtom`, `skillsAtom`), picked by
      mention id like the composer's source picker; a disabled source is not offered.
   6. UA4.4 — a run goes through the run confirmation (`run-controls.ts` `startTaskRun`, `RunConfirmationDialog`):
      the host refuses a spec no human saved or confirmed (`rpc/tasks.ts`), so "Create & Run" / "Save & Run" ask
      first when the host says so (after a Generate adoption, or an edit on disk); a declined run leaves the
      saved task on the board. The Results tab adds the run's status and its Pause / Resume / Stop
      (`resolveRunControls`; an interrupted run — the app restarted — offers Resume, spec §11 item 7) and marks a
      node whose session worked again after it was done (`wokeAfterDone`). Two help lines under Sources and Skills
      say what a node's plugins and sources are (UA4.1 "Plugins"). Upstream's Results read is unchanged.
   8. UA4.6 — Generate (v0.13.4 L32–L34, L65, L667–L691, L709–L812, L851–L853, L869–L874, L976–L990,
      L1174–L1209): the client fallback is the shared `GENERATE_CLIENT_TIMEOUT_MS` (620 s = 2 × 300 s + 20 s since UB2.9,
      `@nessy-agent/shared/tasks/generate-limits`; upstream hard-coded 200 s against its 360 s worst case); the
      request carries the picked folder as its handle (`projectHandleId`, never a path; an edit names the tile's
      orchestrator instead, `orchestratorSessionId`, and the draft authors in its folder — UA12.93) and the editor's mode, which the draft receives only on adoption (it
      authors in `dontAsk`, UA4.5); a generated mode is clamped to the editor's ceiling (`resolveGeneratedResult`,
      task-spec-form adaptation 5); the draft's adopt / discard / post-create resolution is
      `createGenerateDraftTracker`. The draft is a visible session (UA4.5), never a board card (`taskDraft`).
      A save that adopts it records no confirmed digest, so its Create & Run asks first (adaptation 6). A folder
      picked after Generate moves the held draft there before the save adopts it (`projects:setSessionProject`;
      upstream moves the cwd on adoption, our host never does — task-spec-form adaptation 5, follow-up 2).
      `LoadingIndicator` comes from `@nessy-agent/ui/ui/LoadingIndicator` (our `@nessy-agent/ui` barrel does not
      re-export it; `SubtaskRow.tsx` takes `Spinner` the same way).
   7. Editing a tile with no task.yaml starts from the model and connection its session runs on (UA3.6
      follow-up; upstream started from the catalogue default), so a save neither re-models the session nor
      asks the host for a runtime switch it refuses on a session with messages (`task-attach-connection-locked`).
   UA12.69 — with an EMPTY catalogue (no authenticated connection) the editor names no model: the fallback
      chain ends at `''` (upstream's ended at `DEFAULT_MODEL`, an Anthropic id a Nessy workspace does not
      serve — reason (c), the UA-cr6 deferred row), so a save emits no `defaults.model` and the Generate request
      carries model/connection only when one is named; the pickers show the existing "None" key instead of
      an empty menu. A gateway default still reaches the save as `coder` (`resolveCatalogDefaultModel`).
   UB14.60 (R2-16), 2026-10-16 — v0.15.1's restyle hunks (changed in v0.15.0) taken onto this copy: `Btn` is the
      `Button` primitive (md 28px, lg for the Generate CTA), the Definition/Results and Manual/Generate switches are
      the segmented group (`SegmentedGroup`/`SegmentedButton`, `aria-pressed`), `SelectButton` takes the field
      material, the fields are `Input`/`Textarea`, a subtask card's remove and a dependency's remove are
      `IconButton`s, the header is the 48px panel header on the paper (no surface of its own), the panes are
      raised cards, the verdict/node blocks are hairline blocks in the solved status roles, a node's output sits
      in the sunken well and its "Open session" is `Button variant="link"`. Kept, each named: the generate timeout
      stays the shared `GENERATE_CLIENT_TIMEOUT_MS` (its value is UB2.9's; v0.15.1's literal 620 000 not taken);
      our folder-handle picker (`CompactWorkingDirectorySelector`) and the edit-mode folder shown in an inert
      well; ModelSelect's runtime chip and its UA12.69 "None" well on the new neutral roles; UA4.4's run status
      block and the node's woke-after-done mark (in the info role, "needs you"); UB6.6's inferred-verdict line
      (its v0.15.1 classes land here, as UB6.6 handed them). */
import * as React from 'react'
import { ChevronLeft, ChevronDown, Sparkles, Plus, Trash2, Check, X, ExternalLink, RefreshCw, CheckCircle2, XCircle, CircleSlash, DatabaseZap, Zap, Folder, Pause, Play, Square } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Spinner, Markdown } from '@nessy-agent/ui'
import { LoadingIndicator } from '@nessy-agent/ui/ui/LoadingIndicator'
import { getModelShortName } from '@config/models'
import { useAtomValue, useStore } from 'jotai'
import { useProjects } from '@/hooks/useProjects'
import { PERMISSION_MODE_ORDER, clampPermissionModeToParent, type PermissionMode } from '@nessy-agent/shared/agent/modes'
import { uniqueTaskSlug } from '@nessy-agent/shared/tasks/slug'
import { GENERATE_CLIENT_TIMEOUT_MS } from '@nessy-agent/shared/tasks/generate-limits'
import type { IssuedProjectHandle } from '@nessy-agent/shared/projects/project-handle-service'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import { sourcesAtom } from '@/atoms/sources'
import { skillsAtom } from '@/atoms/skills'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { useAppShellContext } from '@/context/AppShellContext'
import { getSessionTitle } from '@/utils/session'
import { getPathBasename } from '@/lib/platform'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { Button, IconButton } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { TaskEditorTarget } from './types'
import { checkedConnectionSlug, type TaskModelGroup } from './model-catalog'
import { runtimeLabel } from '../input/runtime-switch-copy'
import {
  uid,
  buildSpec,
  buildTaskCreateRequest,
  specToSubtasks,
  canDependOn,
  modesAtOrBelow,
  quickAddNodeId,
  quickAddChildToSubtask,
  DEFAULT_REPAIR_ATTEMPTS,
  MAX_REPAIR_ATTEMPTS_CAP,
  taskEditorModeCeiling,
  taskRefusalDescription,
  resolveGeneratedResult,
  createGenerateDraftTracker,
  type GeneratedTaskResult,
  type EditorSubtask,
  type SpecNode,
  type TaskPermissionMode,
} from './task-spec-form'
import { SourceAvatar } from '@/components/ui/source-avatar'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import { SourceSelectorPopover } from '@/components/ui/SourceSelectorPopover'
import { SkillSelectorPopover, skillSelectionId } from '@/components/ui/SkillSelectorPopover'
import { CompactWorkingDirectorySelector } from '@/components/ui/CompactWorkingDirectorySelector'
import { ProjectTrustDialog } from '@/components/workspace/ProjectTrustDialog'
import { TaskModeHint, taskJudgeRuntimes } from './TaskModeHint'
import { resolveNodeStatePill } from './node-state-pill'
import { resolveRunControls, startTaskRun, type RunControl } from './run-controls'
import { RunConfirmationDialog, useRunConfirmation } from './RunConfirmationDialog'

/**
 * TaskEditor — full-pane authoring surface for a Tasks DAG (graduated from the
 * playground demo). Manual mode authors the node list by hand; it serializes to a
 * TaskSpec and (via tasks:create) writes a task.yaml and creates or binds the
 * orchestrator parent session. The task lands on the board in ToDo; running it is
 * the Conductor's (Phase 4).
 *
 * The spec is sent as JSON (a valid YAML subset) so there is no hand-rolled YAML
 * escaping; the backend re-serializes it to real YAML on save.
 */

function resolveModelName(groups: TaskModelGroup[], id: string): string {
  for (const g of groups) {
    const hit = g.models.find((m) => m.id === id)
    if (hit) return hit.name
  }
  return getModelShortName(id)
}

/** The id a source is picked by — `SourceSelectorPopover`'s own key. */
function sourceSelectionId(source: SafeCapabilitySummary): string {
  return source.mention?.id ?? source.logicalName
}

/** A stored mode string read as ours, or undefined when it is not one. */
function asPermissionMode(value: string | undefined): PermissionMode | undefined {
  return value && (PERMISSION_MODE_ORDER as string[]).includes(value) ? (value as PermissionMode) : undefined
}

type Mode = 'generate' | 'manual'
type Tab = 'definition' | 'results'

// The target type lives in ./types so the editor-target atom can import it without
// pulling in this component module; re-exported here for existing consumers.
export type { TaskEditorTarget } from './types'

/** Storage-backed run results (shape inferred from the electronAPI so no shared import is needed). */
type TaskResults = Awaited<ReturnType<typeof window.electronAPI.getTaskResults>>

// ---------------------------------------------------------------------------
// Small inline controls (presentational)
// ---------------------------------------------------------------------------
type BtnVariant = 'primary' | 'secondary' | 'ghost'

/** The editor's button: the Button primitive (primary = the one solid-accent treatment). 28px; 32px for CTAs. */
function Btn({
  variant = 'secondary',
  size = 'md',
  className,
  ...rest
}: { variant?: BtnVariant; size?: 'md' | 'lg' } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <Button type="button" variant={variant} size={size} className={className} {...rest} />
}

/** Segmented control (the Tabs primitive's material): a neutral well with the selected item raised. */
function SegmentedGroup({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('inline-flex h-control items-center gap-0.5 rounded-md bg-fill-hover p-0.5', className)}>
      {children}
    </div>
  )
}

function SegmentedButton({
  active,
  className,
  ...rest
}: { active: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        'motion-press inline-flex h-control-sm items-center justify-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 text-label-sm font-medium [&_svg]:size-3.5 [&_svg]:shrink-0',
        active ? 'bg-floating text-foreground shadow-elev-1' : 'text-secondary hover:text-foreground',
        className,
      )}
      {...rest}
    />
  )
}

// MUST forward the ref: Radix's <DropdownMenuTrigger asChild> attaches a ref to
// this element to anchor the menu. A function component without forwardRef drops
// that ref and the dropdown fails to open/position.
/** Select trigger: the field material (sunken well, hairline, focus tint when open), like SelectTrigger. */
const SelectButton = React.forwardRef<
  HTMLButtonElement,
  { size?: 'sm' | 'md' } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(function SelectButton({ size = 'md', children, className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        'field-surface inline-flex items-center gap-1.5 font-medium text-foreground',
        size === 'sm' ? 'h-control rounded-md px-2 text-label-sm' : 'h-control-lg rounded-md px-2.5 text-label',
        className,
      )}
      {...rest}
    >
      {children}
      <ChevronDown className="ml-auto size-3.5 shrink-0 text-tertiary" strokeWidth={2} />
    </button>
  )
})

function ModelSelect({
  value,
  connection,
  onChange,
  groups,
  width = 168,
  size = 'md',
}: {
  value: string
  /** The connection the value was picked under (undefined: the group the id routes to). */
  connection: string | undefined
  onChange: (id: string, connectionSlug: string) => void
  groups: TaskModelGroup[]
  width?: number
  size?: 'sm' | 'md'
}) {
  const { t } = useTranslation()
  const checked = checkedConnectionSlug(groups, value, connection)
  // UA12.69: nothing names a model and the catalogue is empty (no authenticated connection) — there is
  // nothing to pick, so a static "None" (the existing `tasks.noneSelected` key) stands where upstream's
  // `DEFAULT_MODEL` button opened an empty menu. The save carries no model (the fallback chain ends at
  // `''`), so the node keeps its routing.
  if (!value && groups.length === 0) {
    return (
      <span
        className={cn(
          // UB14.60: the inert well beside SelectButton's field material (no hairline, no chevron).
          'inline-flex items-center rounded-md bg-fill-hover font-medium text-tertiary',
          size === 'sm' ? 'h-control px-2 text-label-sm' : 'h-control-lg px-2.5 text-label',
        )}
        style={{ width }}
      >
        <span className="truncate">{t('tasks.noneSelected')}</span>
      </span>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SelectButton size={size} style={{ width }}>
          <span className="truncate">{resolveModelName(groups, value)}</span>
        </SelectButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[320px] min-w-[180px]">
        {groups.map((g, gi) => (
          <React.Fragment key={`${g.connectionSlug}-${gi}`}>
            {gi > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="flex items-center gap-1.5">
              <span className="truncate">{g.label}</span>
              <span className="inline-flex h-4 shrink-0 items-center rounded-xs bg-fill-hover px-1 text-caption font-medium text-secondary">
                {runtimeLabel(g.runtime)}
              </span>
            </DropdownMenuLabel>
            {g.models.map((m) => (
              <DropdownMenuItem key={m.id} onSelect={() => onChange(m.id, g.connectionSlug)}>
                <span className="truncate">{m.name}</span>
                {m.id === value && g.connectionSlug === checked && <Check className="ml-auto shrink-0" strokeWidth={2} />}
              </DropdownMenuItem>
            ))}
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-control-lg items-center justify-between gap-3">
      <span className="text-label text-secondary">{label}</span>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/**
 * Overlapping avatar stack for the selector triggers — mirrors the chat input's
 * source badge (first three avatars, then a "+N" chip).
 */
function AvatarStack({ avatars }: { avatars: React.ReactNode[] }) {
  const display = avatars.slice(0, 3)
  const remaining = avatars.length - 3
  return (
    <div className="-ml-0.5 flex shrink-0 items-center">
      {display.map((node, i) => (
        <div
          key={i}
          className={cn(
            'relative flex size-5 items-center justify-center rounded-xs bg-raised shadow-elev-1',
            i > 0 && '-ml-1',
          )}
          style={{ zIndex: i + 1 }}
        >
          {node}
        </div>
      ))}
      {remaining > 0 && (
        <div
          className="-ml-1 flex h-5 min-w-5 items-center justify-center rounded-xs bg-raised px-0.5 text-caption tabular-nums text-tertiary shadow-elev-1"
          style={{ zIndex: display.length + 1 }}
        >
          +{remaining}
        </div>
      )}
    </div>
  )
}

/**
 * Sources picker — the chat input's source dropdown (SourceSelectorPopover:
 * avatar rows + filter + check) fronted by the form's bordered SelectButton
 * trigger with a leading avatar stack.
 */
function SourcesField({
  sources,
  values,
  onChange,
  title,
}: {
  sources: SafeCapabilitySummary[]
  values: string[]
  onChange: (next: string[]) => void
  title?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const anchorRef = React.useRef<HTMLButtonElement>(null)
  const selected = values
    .map((slug) => sources.find((s) => sourceSelectionId(s) === slug))
    .filter((s): s is SafeCapabilitySummary => Boolean(s))
  const firstName = selected[0]?.logicalName ?? values[0]
  const label =
    values.length === 0 ? t('tasks.noneSelected') : values.length === 1 ? firstName : `${firstName} +${values.length - 1}`
  const toggle = (slug: string) =>
    onChange(values.includes(slug) ? values.filter((v) => v !== slug) : [...values, slug])
  return (
    <>
      <SelectButton
        ref={anchorRef}
        style={{ width: 168 }}
        title={title}
        data-state={open ? 'open' : 'closed'}
        onClick={() => setOpen((prev) => !prev)}
      >
        {selected.length === 0 ? (
          <DatabaseZap className="size-4 shrink-0 text-tertiary" strokeWidth={2} />
        ) : (
          <AvatarStack avatars={selected.map((s) => <SourceAvatar key={s.key} source={s} size="xs" />)} />
        )}
        <span className={cn('min-w-0 flex-1 truncate text-left', values.length === 0 && 'text-tertiary')}>{label}</span>
      </SelectButton>
      <SourceSelectorPopover
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        sources={sources}
        selectedSlugs={values}
        onToggleSlug={toggle}
      />
    </>
  )
}

/**
 * Skills picker — parallel to {@link SourcesField} using SkillSelectorPopover
 * and SkillAvatar (workspace-scoped icons).
 */
function SkillsField({
  skills,
  values,
  onChange,
  workspaceId,
  title,
}: {
  skills: SafeCapabilitySummary[]
  values: string[]
  onChange: (next: string[]) => void
  workspaceId: string
  title?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const anchorRef = React.useRef<HTMLButtonElement>(null)
  const selected = values
    .map((slug) => skills.find((s) => skillSelectionId(s) === slug))
    .filter((s): s is SafeCapabilitySummary => Boolean(s))
  const firstName = selected[0]?.logicalName ?? values[0]
  const label =
    values.length === 0 ? t('tasks.noneSelected') : values.length === 1 ? firstName : `${firstName} +${values.length - 1}`
  const toggle = (slug: string) =>
    onChange(values.includes(slug) ? values.filter((v) => v !== slug) : [...values, slug])
  return (
    <>
      <SelectButton
        ref={anchorRef}
        style={{ width: 168 }}
        title={title}
        data-state={open ? 'open' : 'closed'}
        onClick={() => setOpen((prev) => !prev)}
      >
        {selected.length === 0 ? (
          <Zap className="size-4 shrink-0 text-tertiary" strokeWidth={2} />
        ) : (
          <AvatarStack avatars={selected.map((s) => <SkillAvatar key={s.key} skill={s} size="xs" workspaceId={workspaceId} />)} />
        )}
        <span className={cn('min-w-0 flex-1 truncate text-left', values.length === 0 && 'text-tertiary')}>{label}</span>
      </SelectButton>
      <SkillSelectorPopover
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        skills={skills}
        selectedSlugs={values}
        onToggleSlug={toggle}
        workspaceId={workspaceId}
      />
    </>
  )
}

/**
 * The folder field (adaptation 4). Create mode: OUR composer folder picker; its pick is an issued
 * project handle. Edit mode: the bound session's folder, shown — an attach never moves it.
 */
function FolderField({
  isEdit,
  folder,
  sessionFolder,
  onChange,
  workspaceId,
}: {
  isEdit: boolean
  folder: IssuedProjectHandle | undefined
  sessionFolder: string | undefined
  onChange: (project: IssuedProjectHandle) => void
  workspaceId: string
}) {
  const { t } = useTranslation()
  if (isEdit) {
    return (
      <span
        // UB14.60: the inert well (SelectButton's height and type, no hairline or chevron) — a shown folder, not a picker.
        className="inline-flex h-control-lg w-[168px] items-center gap-1.5 rounded-md bg-fill-hover px-2.5 text-label font-medium text-secondary"
        title={sessionFolder}
      >
        <Folder className="size-3.5 shrink-0 text-tertiary" strokeWidth={2} />
        <span className="min-w-0 flex-1 truncate">
          {sessionFolder ? getPathBasename(sessionFolder) || sessionFolder : t('tasks.noneSelected')}
        </span>
      </span>
    )
  }
  return (
    <CompactWorkingDirectorySelector
      workingDirectory={folder?.displayPath}
      onWorkingDirectoryChange={onChange}
      workspaceId={workspaceId}
    />
  )
}

// ---------------------------------------------------------------------------
// Subtask card (includes the required prompt)
// ---------------------------------------------------------------------------
function SubtaskCard({
  index,
  subtask,
  allSubtasks,
  groups,
  fallbackModel,
  fallbackConnection,
  onChange,
  onRemove,
}: {
  index: number
  subtask: EditorSubtask
  /** Every row, so dependency chips resolve titles (incl. forward edges) and add-candidates can be cycle-filtered. */
  allSubtasks: EditorSubtask[]
  groups: TaskModelGroup[]
  /** Effective model shown when the node has no explicit one (it inherits the orchestrator default). */
  fallbackModel: string
  /** The orchestrator's picked connection, shown with `fallbackModel` (UA3.6 follow-up). */
  fallbackConnection: string | undefined
  onChange: (patch: Partial<EditorSubtask>) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const titleByUid = new Map(allSubtasks.map((s) => [s.uid, s.title]))
  const depTitle = (depUid: string) => titleByUid.get(depUid) || t('tasks.untitledSubtask')
  const addDep = (depUid: string) => onChange({ dependsOn: [...subtask.dependsOn, depUid] })
  const removeDep = (depUid: string) => onChange({ dependsOn: subtask.dependsOn.filter((d) => d !== depUid) })
  // Candidates exclude self, already-selected, and any edge that would close a cycle.
  const candidates = allSubtasks.filter(
    (s) => !subtask.dependsOn.includes(s.uid) && canDependOn(allSubtasks, subtask.uid, s.uid),
  )
  return (
    <div className="group rounded-lg border border-subtle p-3">
      <div className="flex items-start gap-2">
        <div className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-accent-tint text-label-sm font-semibold tabular-nums text-accent">
          {index + 1}
        </div>
        <div className="min-w-0 flex-1">
          <input
            value={subtask.title}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder={t('tasks.subtaskTitlePlaceholder')}
            className="h-7 w-full bg-transparent text-label font-semibold text-foreground outline-none placeholder:text-tertiary"
          />
          <Textarea
            value={subtask.prompt}
            onChange={(e) => onChange({ prompt: e.target.value })}
            rows={2}
            placeholder={t('tasks.promptPlaceholder')}
            className="mt-1 min-h-0 max-h-40 resize-none px-2 py-1.5 text-label-sm md:text-label-sm"
          />
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <ModelSelect
              value={subtask.model ?? fallbackModel}
              connection={subtask.model ? subtask.llmConnection : fallbackConnection}
              onChange={(id, conn) => onChange({ model: id, llmConnection: conn })}
              groups={groups}
              width={128}
              size="sm"
            />
            {subtask.dependsOn.map((depUid) => (
              <span
                key={depUid}
                className="inline-flex h-control max-w-[168px] items-center gap-0.5 rounded-md bg-fill-hover pl-2 pr-0.5 text-label-sm font-medium text-secondary"
              >
                <span className="truncate">{t('tasks.dependsOnLabel', { title: depTitle(depUid) })}</span>
                <IconButton
                  size="sm"
                  icon={<X className="size-3.5" strokeWidth={2.5} />}
                  onClick={() => removeDep(depUid)}
                  aria-label={t('tasks.removeDependency')}
                  className="text-tertiary hover:text-destructive"
                />
              </span>
            ))}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SelectButton size="sm" style={{ width: 144 }}>
                  <span className="truncate text-secondary">
                    {subtask.dependsOn.length === 0 ? t('tasks.noDependencies') : t('tasks.addDependency')}
                  </span>
                </SelectButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-w-[240px]">
                {candidates.map((c) => (
                  <DropdownMenuItem key={c.uid} onSelect={() => addDep(c.uid)}>
                    <span className="truncate">{c.title || t('tasks.untitledSubtask')}</span>
                  </DropdownMenuItem>
                ))}
                {candidates.length === 0 && (
                  <div className="px-2 py-1.5 text-label-sm text-tertiary">{t('tasks.noAvailableSubtasks')}</div>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {/* Hover-revealed on desktop; always visible on touch (data-touch-reveal) */}
        <IconButton
          size="sm"
          icon={<Trash2 className="size-3.5" strokeWidth={2} />}
          onClick={onRemove}
          aria-label={t('tasks.removeSubtask')}
          data-touch-reveal="true"
          className="text-tertiary opacity-0 hover:text-destructive group-hover:opacity-100 group-hover:duration-instant focus-visible:opacity-100"
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Task Editor
// ---------------------------------------------------------------------------
export interface TaskEditorProps {
  workspaceId: string
  /** What the editor points at: create-new or edit an existing tile. Defaults to create. */
  target?: TaskEditorTarget
  /** Return to the board. */
  onClose: () => void
  /** Jump to the underlying orchestrator chat session (edit mode only). */
  onOpenSession?: () => void
  /** Jump to a specific child/subtask session (used by Results "Open session" links). */
  onOpenChildSession?: (sessionId: string) => void
  /**
   * Fired after a successful CREATE (never for edit-mode saves) so the host can land the
   * user somewhere useful — e.g. the session list scoped to the task. `taskLabelId` is the
   * RESOLVED reserved-label id from tasks:create (may be 'task-2' after a name collision).
   */
  onCreated?: (created: { sessionId: string; taskLabelId?: string; projectId?: string }) => void
  /** Connection-grouped models (from the workspace's LLM connections), each with its runtime (adaptation 1). */
  modelGroups: TaskModelGroup[]
  /** model id → connection slug that serves it (so each node routes to the right backend). */
  modelToConnection: Map<string, string>
  /** Default model id. UA12.69: `''` = none (an empty catalogue — no authenticated connection); the save
   *  then emits no `defaults.model` and the Generate request names no model, never upstream's `DEFAULT_MODEL`. */
  defaultModel: string
  /** NESSY (adaptation 2): the modes the picker offers, in order. */
  permissionModes: readonly PermissionMode[]
  /** NESSY (adaptation 2): the mode a new session of this workspace starts in — a new task's initial mode. */
  defaultPermissionMode: PermissionMode
  /** NESSY (adaptation 6): the workspace default connection — where a node naming none runs (the run confirmation). */
  defaultConnectionSlug?: string
}

export function TaskEditor({
  workspaceId,
  target = { mode: 'create' },
  onClose,
  onOpenSession,
  onOpenChildSession,
  onCreated,
  modelGroups,
  modelToConnection,
  defaultModel,
  permissionModes,
  defaultPermissionMode,
  defaultConnectionSlug,
}: TaskEditorProps) {
  const { t } = useTranslation()
  const isEdit = target.mode === 'edit'
  // The slug to pin on save (edit mode). Undefined for create and for quick-add tiles with no slug;
  // in those cases the slug is derived from the title with uniqueTaskSlug at save (adaptation 3).
  const editSlug = target.mode === 'edit' ? target.taskSlug : undefined
  const editSessionId = target.mode === 'edit' ? target.sessionId : undefined
  const groups = modelGroups
  // UA12.69: the chain ends at the EMPTY sentinel, never upstream's `DEFAULT_MODEL` — an Anthropic id no
  // Nessy connection serves, written into a node by any save with an empty catalogue (no authenticated
  // connection). `''` names no model: buildSpec emits no `defaults.model`, and the pickers show "None".
  const fallbackModel = defaultModel || groups[0]?.models[0]?.id || ''
  const { projects } = useProjects(workspaceId)
  const [tab, setTab] = React.useState<Tab>('definition')
  const [mode, setMode] = React.useState<Mode>('manual')
  const [title, setTitle] = React.useState('')
  const [goal, setGoal] = React.useState('')
  const [acceptanceCriteria, setAcceptanceCriteria] = React.useState('')
  // Empty string = "use the runner default"; a number pins the spec's max_iterations.
  const [maxRepairs, setMaxRepairs] = React.useState('')
  // Create mode seeds the project from the board's active filter (so a new card stays
  // visible under that filter); edit mode starts empty and is prefilled from the spec below.
  const [projectId, setProjectId] = React.useState(target.mode === 'create' ? (target.initialProjectId ?? '') : '')
  const [orchModel, setOrchModel] = React.useState(fallbackModel)
  // Explicit connection serving the orch model; undefined lets buildSpec derive it from orchModel.
  // Preserved from the loaded spec so an authored connection isn't rewritten on save (round-trip).
  const [orchConnection, setOrchConnection] = React.useState<string | undefined>(undefined)
  // Task-family permission mode (adaptation 2): a new task starts where a new session of this
  // workspace starts; edit mode prefills from the spec, else from the bound session.
  const [permissionMode, setPermissionMode] = React.useState<TaskPermissionMode>(() => clampPermissionModeToParent(defaultPermissionMode, taskEditorModeCeiling(undefined)))
  // The task's project binding at load (edit mode). Floor for buildSpec so leaving the picker on
  // "No Project" can't silently drop a binding, and the gate for whether "No Project" is offered.
  const [boundProjectId, setBoundProjectId] = React.useState('')
  const [subtasks, setSubtasks] = React.useState<EditorSubtask[]>([])
  // Create mode: the folder picked in the editor, as an issued handle (never a path in the spec).
  const [folder, setFolder] = React.useState<IssuedProjectHandle | undefined>(undefined)
  // A picked folder whose trust is undecided waits here for the trust prompt (adaptation 4).
  const [pendingTrust, setPendingTrust] = React.useState<IssuedProjectHandle | null>(null)
  // Edit mode: the cwd the saved task.yaml carries, round-tripped verbatim (task-spec-form adaptation 3).
  const [preservedCwd, setPreservedCwd] = React.useState<string | undefined>(undefined)
  // Task-level sources (enabled on orchestrator + children) and skills (read as context
  // before each child works). Empty = leave workspace defaults / no skill preamble.
  const [sourceSlugs, setSourceSlugs] = React.useState<string[]>([])
  const [skillSlugs, setSkillSlugs] = React.useState<string[]>([])
  const [busy, setBusy] = React.useState(false)

  // Pickable catalogs from the active workspace (AppShell keeps these atoms populated).
  const workspaceSources = useAtomValue(sourcesAtom)
  const workspaceSkills = useAtomValue(skillsAtom)
  // Sources are the task-level pickable catalog (children inherit them); skills are
  // read as context before each child. Both feed the icon-rich selector fields below.
  const enabledSources = React.useMemo(
    () => workspaceSources.filter((s) => s.state !== 'disabled'),
    [workspaceSources],
  )

  // Results tab (edit mode): storage-backed run outcome, loaded lazily on tab open / refresh.
  const [results, setResults] = React.useState<TaskResults | null>(null)
  const [resultsLoading, setResultsLoading] = React.useState(false)
  // UA4.4 (adaptation 6): the run confirmation this editor's run path shows.
  const runConfirmation = useRunConfirmation()

  // Jotai store handle for one-shot reads (no subscription — the editor must not re-render
  // on every streaming metadata tick just to have read children once at open).
  const store = useStore()
  // The bound session (edit mode), read once: its folder is shown (adaptation 4). Its mode is only
  // the ceiling's FALLBACK (adaptation 2) — the ceiling itself reads the LIVE session options map,
  // the composer's own source for a session's mode (updated by every `permission_mode_changed`
  // event), because a mode change never writes the meta map: UA12.157 (SIT-A, 2026-10-04) measured
  // the snapshot's mode missing at mount, so the ceiling fell back to `auto` and a `default`
  // orchestrator's menu offered everything the create ceiling offers.
  const [editSession] = React.useState(() => (editSessionId ? store.get(sessionMetaMapAtom).get(editSessionId) : undefined))
  const { sessionOptions } = useAppShellContext()
  const boundSessionMode = asPermissionMode(sessionOptions.get(editSessionId ?? '')?.permissionMode ?? editSession?.permissionMode)
  const modeCeiling = taskEditorModeCeiling(boundSessionMode)
  const offeredModes = React.useMemo(() => modesAtOrBelow(permissionModes, modeCeiling), [permissionModes, modeCeiling])
  // UA4.2: the runtimes this task's sessions run on, so the Auto hint names each one's judge (TaskModeHint).
  const judgeRuntimes = React.useMemo(
    () => taskJudgeRuntimes(groups, modelToConnection, { model: orchModel, llmConnection: orchConnection }, subtasks),
    [groups, modelToConnection, orchModel, orchConnection, subtasks],
  )

  /**
   * The tile's quick-add children as editor rows, so hand-spawned subtasks show up (and get
   * adopted into the spec on save) instead of living only on the tile. Each row carries the
   * deterministic node id `qa-<sessionId>`; a child whose qa-id is already a spec node was
   * adopted by a previous save and is skipped. Conductor-owned children (`taskNodeId`) are
   * executions of spec nodes — the node row already represents them.
   */
  const collectQuickAddRows = React.useCallback(
    (adoptedNodeIds: ReadonlySet<string>): EditorSubtask[] => {
      if (!editSessionId) return []
      const metaMap = store.get(sessionMetaMapAtom)
      const children = [...metaMap.values()]
        .filter(
          (child) =>
            child.parentSessionId === editSessionId &&
            !child.taskNodeId &&
            !child.hidden &&
            !child.isArchived &&
            !adoptedNodeIds.has(quickAddNodeId(child.id)),
        )
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      return children.map((child) => {
        // Quick-add contract: the typed title is the session name AND the dispatch prompt. Preserve the
        // child's explicit model + connection (custom-routed children must not lose their backend).
        const title = child.name?.trim() || getSessionTitle(child)
        return quickAddChildToSubtask({ sessionId: child.id, title, model: child.model, llmConnection: child.llmConnection })
      })
    },
    [store, editSessionId],
  )

  // Edit-mode prefill: spec-backed tiles load their authored task.yaml; either way the tile's
  // quick-add children merge in as editable rows (adopted into the spec on the next save).
  React.useEffect(() => {
    if (target.mode !== 'edit') return
    let cancelled = false
    // The tile's existing project binding (spec-less quick-add tiles have no spec.project, so fall
    // back to the session's own projectId) — prefilled into the picker and kept as the buildSpec floor.
    const sessionMeta = editSessionId ? store.get(sessionMetaMapAtom).get(editSessionId) : undefined
    const sessionProjectId = sessionMeta?.projectId ?? ''
    const sessionMode = asPermissionMode(sessionMeta?.permissionMode)
    if (target.taskSlug) {
      void window.electronAPI
        .getTask(workspaceId, target.taskSlug)
        .then((res) => {
          if (cancelled) return
          const spec = res.spec as
            | { title?: string; goal?: string; acceptance_criteria?: string; max_iterations?: number; project?: string; cwd?: string; sources?: string[]; skills?: string[]; defaults?: { model?: string; llmConnection?: string; permissionMode?: TaskPermissionMode }; nodes?: SpecNode[] }
            | undefined
          if (!spec) return
          if (spec.title) setTitle(spec.title)
          if (spec.goal) setGoal(spec.goal)
          setAcceptanceCriteria(spec.acceptance_criteria ?? '')
          setMaxRepairs(spec.max_iterations != null ? String(spec.max_iterations) : '')
          // Bind from the spec, else the session's existing binding. Record it as the immutable floor.
          const bound = spec.project ?? sessionProjectId
          setProjectId(bound)
          setBoundProjectId(bound)
          setPreservedCwd(spec.cwd)
          setSourceSlugs(spec.sources ?? [])
          setSkillSlugs(spec.skills ?? [])
          if (spec.defaults?.model) setOrchModel(spec.defaults.model)
          // Preserve the authored orchestrator connection + permission mode (round-trip, no silent rewrite).
          // Fall back to the session's actual mode so saving a bound tile can't silently escalate it.
          setOrchConnection(spec.defaults?.llmConnection)
          // Shown clamped to the bound session's mode, as the save writes it (adaptation 2).
          const specMode = spec.defaults?.permissionMode
          if (specMode) setPermissionMode(clampPermissionModeToParent(specMode, taskEditorModeCeiling(sessionMode)))
          else if (sessionMode) setPermissionMode(sessionMode)
          const nodes = spec.nodes ?? []
          setSubtasks([
            ...specToSubtasks(nodes),
            ...collectQuickAddRows(new Set(nodes.map((n) => n.id))),
          ])
        })
        .catch(() => {})
    } else {
      if (target.initialTitle) setTitle(target.initialTitle)
      // A bound quick-add tile with no task.yaml: prefill + floor from the session's own state, so
      // saving it as a task neither drops its project nor silently changes its permission mode.
      setProjectId(sessionProjectId)
      setBoundProjectId(sessionProjectId)
      if (sessionMode) setPermissionMode(sessionMode)
      // Adaptation 7: the model and connection the session runs on, not the catalogue default.
      if (sessionMeta?.model) setOrchModel(sessionMeta.model)
      if (sessionMeta?.llmConnection) setOrchConnection(sessionMeta.llmConnection)
      setSubtasks(collectQuickAddRows(new Set()))
    }
    return () => {
      cancelled = true
    }
    // Prefill runs once per target identity; fallbackModel is stable enough for this load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.mode, editSessionId, editSlug, workspaceId])

  const loadResults = React.useCallback(() => {
    if (!editSlug) return
    setResultsLoading(true)
    void window.electronAPI
      .getTaskResults(workspaceId, editSlug)
      .then((res) => setResults(res))
      .catch(() => {})
      .finally(() => setResultsLoading(false))
  }, [workspaceId, editSlug])

  // Load results when the Results tab is first opened (and there's a slug to read).
  React.useEffect(() => {
    if (tab === 'results' && editSlug && !results && !resultsLoading) loadResults()
  }, [tab, editSlug, results, resultsLoading, loadResults])

  // UA4.4 (adaptation 6): Pause / Resume / Stop of the run the Results tab shows, then a fresh read.
  const controlRun = React.useCallback(
    async (control: RunControl) => {
      if (!editSlug || !results?.runId) return
      const runId = results.runId
      try {
        if (control === 'pause') await window.electronAPI.pauseTask(workspaceId, editSlug, runId)
        else if (control === 'resume') await window.electronAPI.resumeTask(workspaceId, editSlug, runId)
        else await window.electronAPI.stopTask(workspaceId, editSlug, runId)
      } catch (err) {
        toast.error(t('tasks.toastRunControlFailed'), { description: err instanceof Error ? err.message : String(err) })
      }
      loadResults()
    },
    [workspaceId, editSlug, results, loadResults, t],
  )

  // Async generate: tasks:generate returns the orchestrator session id immediately and the
  // authored spec arrives later via the onTaskGenerated push event. We track the pending
  // orchestrator id so the listener only reacts to *our* generation, plus a client-side
  // fallback timer so the spinner can't hang forever if the event never lands.
  const pendingGenRef = React.useRef<string | null>(null)
  // The folder the in-flight generation authors in (none = the workspace default), recorded on adoption.
  const genFolderRef = React.useRef<IssuedProjectHandle | undefined>(undefined)
  const genTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  // A completed-but-unadopted generate orchestrator (a visible `taskDraft` session, UA4.5). Submit adopts it
  // in place — editing the authored spec is fine, since the draft is just the conductor orchestrator
  // and spec edits run on it. Discarded on regenerate/close; cleared once adopted so the unmount
  // cleanup never deletes a live orchestrator (adaptation 8: `createGenerateDraftTracker`).
  const draftsRef = React.useRef(createGenerateDraftTracker((sessionId) => {
    void window.electronAPI.deleteSession(sessionId).catch(() => {})
  }))

  const finishGenerate = React.useCallback(() => {
    pendingGenRef.current = null
    if (genTimeoutRef.current) {
      clearTimeout(genTimeoutRef.current)
      genTimeoutRef.current = null
    }
    setBusy(false)
  }, [])

  // Apply a generated spec to the editor (or surface its failure). Runs from the
  // onTaskGenerated listener once the orchestrator finishes authoring.
  const applyGeneratedSpec = React.useCallback(
    (res: GeneratedTaskResult) => {
      const outcome = resolveGeneratedResult(res, modeCeiling)
      if (outcome.kind === 'failed') {
        // The draft orchestrator can't produce a usable spec — discard it so it doesn't linger.
        draftsRef.current.discardDraft(outcome.discardDraftId)
        toast.error(t('tasks.toastCreateFailed'), { description: outcome.message })
        return
      }
      if (outcome.kind === 'invalid') {
        draftsRef.current.discardDraft(outcome.discardDraftId)
        toast.error(t('tasks.toastInvalid'), { description: outcome.description })
        return
      }
      const form = outcome.form
      if (form.title) setTitle(form.title)
      if (form.goal) setGoal(form.goal)
      setAcceptanceCriteria(form.acceptanceCriteria)
      setMaxRepairs(form.maxRepairs)
      if (form.model) setOrchModel(form.model)
      if (form.llmConnection) setOrchConnection(form.llmConnection)
      if (form.permissionMode) setPermissionMode(form.permissionMode)
      setSubtasks(form.subtasks)
      setMode('manual')
      // Record the draft as adoptable: submit reuses it in place (edits are fine to run on it).
      draftsRef.current.adopt(outcome.draftId, genFolderRef.current)
      // No success toast here: switching to Manual mode and populating the Subtasks panel is
      // the visible signal. A top-right toast would also overlap the editor's top-right
      // Cancel/Create/Create & Run buttons and swallow their clicks.
    },
    [t, modeCeiling],
  )

  // Subscribe once for async generate results; ignore events for other generations/sessions.
  React.useEffect(() => {
    const off = window.electronAPI.onTaskGenerated((_wsId, res) => {
      if (res.orchestratorSessionId !== pendingGenRef.current) return
      finishGenerate()
      applyGeneratedSpec(res)
    })
    return off
  }, [finishGenerate, applyGeneratedSpec])

  // Clear any pending fallback timer on unmount, and discard a draft orchestrator that was never
  // adopted (editor closed/cancelled after generating) or is still generating (closed mid-generation:
  // its result would reach no listener). Best-effort — a dropped delete only leaves a draft session,
  // never a board tile.
  React.useEffect(() => () => {
    if (genTimeoutRef.current) clearTimeout(genTimeoutRef.current)
    draftsRef.current.discardOnClose(pendingGenRef.current)
  }, [])

  async function generatePlan() {
    const g = goal.trim() || title.trim()
    if (!g) {
      toast.error(t('tasks.toastNeedTitle'))
      return
    }
    // Regenerating abandons any previously authored draft — discard it before minting a new one.
    draftsRef.current.discardCurrent()
    setBusy(true)
    genFolderRef.current = !isEdit ? folder : undefined
    try {
      // UA12.69: an empty catalogue names no model — the draft then runs on its connection's default.
      // The old unconditional `model: orchModel` sent `''` (or, before that row, `DEFAULT_MODEL`) over
      // the wire; `TaskGenerateRequest.model` is optional and defaults to the session's own.
      const genConnection = orchConnection ?? modelToConnection.get(orchModel)
      const ack = await window.electronAPI.generateTask(workspaceId, {
        goal: g,
        title: title.trim() || undefined,
        ...(orchModel ? { model: orchModel } : {}),
        // Route the authoring turn through the preserved connection (falls back to the model's default),
        // and give the draft the project context + sources it will author against. The mode arrives on
        // adoption (adaptation 8).
        ...(genConnection ? { llmConnection: genConnection } : {}),
        permissionMode,
        ...(projectId || boundProjectId ? { projectId: projectId || boundProjectId } : {}),
        ...(sourceSlugs.length ? { enabledSourceSlugs: sourceSlugs } : {}),
        ...(!isEdit && folder ? { projectHandleId: folder.id } : {}),
        // UA12.93: an edit authors in the task's own folder — the host reads it from the tile's orchestrator.
        ...(isEdit && editSessionId ? { orchestratorSessionId: editSessionId } : {}),
      })
      // Authoring continues on the server; the spec arrives via onTaskGenerated. Keep busy until
      // then, with a fallback timer that releases the spinner if the event never lands. An editor closed
      // before the ack resolved deletes the draft instead (follow-up 2).
      if (!draftsRef.current.claimAck(ack.orchestratorSessionId)) return
      pendingGenRef.current = ack.orchestratorSessionId
      if (genTimeoutRef.current) clearTimeout(genTimeoutRef.current)
      genTimeoutRef.current = setTimeout(() => {
        if (pendingGenRef.current !== ack.orchestratorSessionId) return
        finishGenerate()
        toast.error(t('tasks.toastCreateFailed'), { description: t('tasks.toastGenerateTimeout') })
      }, GENERATE_CLIENT_TIMEOUT_MS)
    } catch (err) {
      finishGenerate()
      // UA12.57 — a known host refusal (task-slug-taken:<slug> and friends) shows its localized sentence; an unknown error keeps the raw text.
      toast.error(t('tasks.toastCreateFailed'), { description: taskRefusalDescription(err instanceof Error ? err.message : String(err), t) })
    }
  }

  const project = projects.find((p) => p.config.id === projectId)

  const updateSubtask = (id: string, patch: Partial<EditorSubtask>) =>
    setSubtasks((prev) => prev.map((s) => (s.uid === id ? { ...s, ...patch } : s)))
  const removeSubtask = (id: string) =>
    setSubtasks((prev) =>
      prev.filter((s) => s.uid !== id).map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => d !== id) })),
    )
  const addSubtask = () =>
    setSubtasks((prev) => {
      const last = prev[prev.length - 1]
      // No explicit model → the new subtask inherits the orchestrator default (the picker still shows
      // that effective model). Picking a model in the row makes it explicit.
      return [...prev, { uid: uid(), title: '', prompt: '', dependsOn: last ? [last.uid] : [] }]
    })

  // A folder pick (adaptation 4): an undecided folder raises the trust prompt first.
  const handleFolderChange = (project: IssuedProjectHandle) => {
    if (project.trustState === 'unknown') {
      setPendingTrust(project)
      return
    }
    setFolder(project)
  }

  // Create the task (write task.yaml + orchestrator session). When `run` is true, also start a
  // run (through the run confirmation, adaptation 6); otherwise the task tile just lands on the board in ToDo
  // for the user to run later.
  async function submit(run: boolean) {
    if (!title.trim()) {
      toast.error(t('tasks.toastNeedTitle'))
      return
    }
    if (subtasks.length === 0) {
      toast.error(t('tasks.toastNeedSubtask'))
      return
    }
    if (subtasks.some((s) => !s.prompt.trim())) {
      toast.error(t('tasks.toastNeedPrompt'))
      return
    }
    setBusy(true)
    try {
      // Edit mode pins the existing slug so the title can change without forking a new task folder
      // and orphaning the bound orchestrator session; otherwise the first free slug (adaptation 3).
      const fixedId = editSlug ?? uniqueTaskSlug(title, new Set(await window.electronAPI.listTasks(workspaceId)))
      const spec = buildSpec(
        {
          title,
          goal,
          acceptanceCriteria,
          maxRepairs: maxRepairs.trim() === '' ? undefined : Number(maxRepairs),
          projectId,
          orchModel,
          orchConnection,
          permissionMode,
          permissionModeCeiling: modeCeiling,
          boundProjectId,
          subtasks,
          preservedCwd,
          sourceSlugs,
          skillSlugs,
          fixedId,
        },
        modelToConnection,
      )
      // Adopt the generate draft in place whenever we have one — spec edits run fine on the draft
      // orchestrator, so there's no need to mint a fresh session.
      const draftId = draftsRef.current.current()
      // A folder picked after Generate: move the draft there first — adoption never moves a folder (follow-up 2).
      const moveTo = !isEdit && draftId ? draftsRef.current.folderMoveFor(folder) : null
      if (draftId && moveTo && folder) {
        await window.electronAPI.setSessionProject({ session: { workspaceId, sessionId: draftId }, projectHandleId: moveTo })
        draftsRef.current.adopt(draftId, folder)
      }
      // Edit mode binds the authored spec onto the tile's existing session; create mode reuses a generate
      // draft if present, else mints a fresh orchestrator in the picked folder (sent as its handle). Either
      // way a held draft travels by id, so the host records no human confirmation of a plan an agent wrote
      // (UA4.6 follow-up 3: an edit's Save & Run asks first, as Create & Run does).
      const created = await window.electronAPI.createTask(
        workspaceId,
        buildTaskCreateRequest(
          spec,
          isEdit && editSessionId
            ? { attachToExistingSession: editSessionId, ...(draftId ? { orchestratorSessionId: draftId } : {}) }
            : { folder, ...(draftId ? { orchestratorSessionId: draftId } : {}) },
        ),
      )
      if (!created.validation.valid) {
        const first = created.validation.errors[0]
        toast.error(t('tasks.toastInvalid'), { description: first ? `${first.path}: ${first.message}` : undefined })
        return
      }
      // Resolve the draft: if the server reused it, it's now a live orchestrator — stop tracking it.
      // If it minted a fresh session instead (draft gone server-side), discard the orphan.
      draftsRef.current.resolveAfterCreate(created.orchestratorSessionId)
      // After a successful CREATE, hand off to the host so it can land the user on the
      // task-scoped session list (edit-mode saves stay on the board).
      const notifyCreated = () => {
        if (isEdit) return
        onCreated?.({
          sessionId: created.orchestratorSessionId,
          taskLabelId: created.taskLabelId,
          projectId: projectId || undefined,
        })
      }
      if (!run) {
        toast.success(t('tasks.toastCreated'), { description: t('tasks.toastCreatedDesc', { slug: created.slug }) })
        onClose()
        notifyCreated()
        return
      }
      let runResult: Awaited<ReturnType<typeof startTaskRun>>
      try {
        runResult = await startTaskRun(
          window.electronAPI,
          workspaceId,
          { slug: created.slug, orchestratorSessionId: created.orchestratorSessionId },
          runConfirmation.confirm,
        )
      } catch (err) {
        // The task is saved; only the run failed. It stays on the board to run later.
        toast.error(t('tasks.toastRunFailed'), { description: err instanceof Error ? err.message : String(err) })
        onClose()
        notifyCreated()
        return
      }
      if (runResult) {
        toast.success(t('tasks.toastStarted'), {
          description: t('tasks.toastStartedDesc', { slug: created.slug, runId: runResult.runId, count: runResult.nodes.length }),
        })
      } else {
        // Declined in the run confirmation: saved, not run.
        toast.success(t('tasks.toastCreated'), { description: t('tasks.toastCreatedDesc', { slug: created.slug }) })
      }
      onClose()
      notifyCreated()
    } catch (err) {
      // UA12.57 — the host's create refusals show their localized sentences; an unknown error keeps the raw text.
      toast.error(t('tasks.toastCreateFailed'), { description: taskRefusalDescription(err instanceof Error ? err.message : String(err), t) })
    } finally {
      setBusy(false)
    }
  }

  return (
    // No surface of its own: the panel card (paper) shows through; the two panes are raised cards.
    <div className="flex h-full flex-col text-foreground">
      {/* Header (48px, like the panel headers): back to the board / title · tabs … actions */}
      <div className="flex h-12 shrink-0 items-center gap-1.5 px-2">
        <Btn variant="ghost" className="px-2 text-secondary hover:text-foreground" onClick={onClose}>
          <ChevronLeft strokeWidth={2} /> {t('kanban.board')}
        </Btn>
        <span className="text-label text-tertiary" aria-hidden>/</span>
        <span className="truncate text-label-lg font-semibold">{isEdit ? t('tasks.editTask') : t('kanban.newTask')}</span>

        {/* Definition / Results tabs — edit mode only (results need a backing task to read). */}
        {isEdit && (
          <SegmentedGroup className="ml-2">
            {(['definition', 'results'] as Tab[]).map((tb) => (
              <SegmentedButton key={tb} active={tab === tb} onClick={() => setTab(tb)}>
                {tb === 'definition' ? t('tasks.tabDefinition') : t('tasks.tabResults')}
              </SegmentedButton>
            ))}
          </SegmentedGroup>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {isEdit && onOpenSession && (
            <Btn variant="secondary" onClick={onOpenSession} disabled={busy}>
              <ExternalLink strokeWidth={2} /> {t('tasks.openSession')}
            </Btn>
          )}
          {tab === 'definition' && (
            <>
              <Btn variant="ghost" onClick={onClose} disabled={busy}>
                {t('common.cancel')}
              </Btn>
              <Btn variant="secondary" onClick={() => void submit(false)} disabled={busy}>
                {isEdit ? t('common.save') : t('common.create')}
              </Btn>
              <Btn variant="primary" onClick={() => void submit(true)} disabled={busy}>
                {busy ? <Spinner className="text-label" /> : <Sparkles strokeWidth={2} />}
                {busy ? t('tasks.starting') : isEdit ? t('tasks.saveAndRun') : t('tasks.createAndRun')}
              </Btn>
            </>
          )}
          {tab === 'results' && (
            <Btn variant="secondary" onClick={loadResults} disabled={resultsLoading}>
              {resultsLoading ? <Spinner className="text-label" /> : <RefreshCw strokeWidth={2} />} {t('common.refresh')}
            </Btn>
          )}
        </div>
      </div>

      {tab === 'results' ? (
        <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
          <ResultsPanel
            results={results}
            loading={resultsLoading}
            onOpenChildSession={onOpenChildSession}
            onRunControl={(control) => void controlRun(control)}
          />
        </div>
      ) : (
      /* Body */
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(360px,2fr)_3fr] gap-3 px-3 pb-3">
        {/* Left — definition */}
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto rounded-lg bg-raised p-4 shadow-elev-1">
          <div className="text-label-lg font-semibold">{t('tasks.definition')}</div>

          <SegmentedGroup className="w-fit">
            {(['manual', 'generate'] as Mode[]).map((m) => (
              <SegmentedButton key={m} active={mode === m} onClick={() => setMode(m)}>
                {m === 'generate' && <Sparkles strokeWidth={2} />}
                {m === 'generate' ? t('tasks.modeGenerate') : t('tasks.modeManual')}
              </SegmentedButton>
            ))}
          </SegmentedGroup>

          <div>
            <div className="mb-1.5 text-label font-medium text-secondary">{t('tasks.title')}</div>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('tasks.titlePlaceholder')}
              className="font-medium"
            />
          </div>

          <div>
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <span className="text-label font-medium text-secondary">{t('tasks.goal')}</span>
              <span className="text-label-sm text-tertiary">{t('tasks.goalHint')}</span>
            </div>
            <Textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={4}
              placeholder={t('tasks.goalPlaceholder')}
              className="max-h-48 resize-none"
            />
          </div>

          <div>
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <span className="text-label font-medium text-secondary">{t('tasks.acceptanceCriteria')}</span>
              <span className="text-label-sm text-tertiary">{t('tasks.acceptanceCriteriaHint')}</span>
            </div>
            <Textarea
              value={acceptanceCriteria}
              onChange={(e) => setAcceptanceCriteria(e.target.value)}
              rows={3}
              placeholder={t('tasks.acceptanceCriteriaPlaceholder')}
              className="max-h-48 resize-none"
            />
          </div>

          <div className="flex flex-col gap-2">
            <FieldRow label={t('tasks.project')}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SelectButton style={{ width: 168 }}>
                    <span className="truncate">{project ? project.config.name : t('tasks.noProject')}</span>
                  </SelectButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[160px]">
                  {/* "No Project" clears the binding — only offered when NOT already bound. The backend
                      never unbinds on save, and buildSpec floors a blank pick to the existing project,
                      so showing it for a bound task would be a no-op that implies clearing works. */}
                  {!boundProjectId && (
                    <DropdownMenuItem onSelect={() => setProjectId('')}>
                      {t('tasks.noProject')}
                      {!projectId && <Check className="ml-auto" strokeWidth={2} />}
                    </DropdownMenuItem>
                  )}
                  {projects.map((p) => (
                    <DropdownMenuItem key={p.config.id} onSelect={() => setProjectId(p.config.id)}>
                      <span className="truncate">{p.config.name}</span>
                      {projectId === p.config.id && <Check className="ml-auto shrink-0" strokeWidth={2} />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </FieldRow>

            <FieldRow label={t('tasks.orchestratorModel')}>
              <ModelSelect
                value={orchModel}
                connection={orchConnection}
                onChange={(m, conn) => {
                  // Keep the connection in step with the model: an unchanged model preserves the loaded
                  // (possibly custom) connection; a pick routes to the group it was made under.
                  setOrchModel(m)
                  setOrchConnection(conn)
                }}
                groups={groups}
              />
            </FieldRow>

            <FieldRow label={t('tasks.permissionMode')}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SelectButton style={{ width: 168 }}>
                    <span className="truncate">{t(`mode.${permissionMode}`)}</span>
                  </SelectButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[160px]">
                  {offeredModes.map((m) => (
                    <DropdownMenuItem key={m} onSelect={() => setPermissionMode(m)}>
                      <span className="truncate">{t(`mode.${m}`)}</span>
                      {permissionMode === m && <Check className="ml-auto shrink-0" strokeWidth={2} />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </FieldRow>
            <TaskModeHint mode={permissionMode} runtimes={judgeRuntimes} />

            {enabledSources.length > 0 && (
              <FieldRow label={t('tasks.sources')}>
                <SourcesField
                  sources={enabledSources}
                  values={sourceSlugs}
                  onChange={setSourceSlugs}
                  title={t('tasks.sourcesHint')}
                />
              </FieldRow>
            )}

            {workspaceSkills.length > 0 && (
              <FieldRow label={t('tasks.skills')}>
                <SkillsField
                  skills={workspaceSkills}
                  values={skillSlugs}
                  onChange={setSkillSlugs}
                  workspaceId={workspaceId}
                  title={t('tasks.skillsHint')}
                />
              </FieldRow>
            )}
            {/* UA4.4 (adaptation 6): what a node's sources and plugins are (UA4.1 "Plugins"). */}
            <div className="flex flex-col gap-1 text-label-sm text-tertiary">
              <span>{t('tasks.sourcesScopeHelp')}</span>
              <span>{t('tasks.pluginsHelp')}</span>
            </div>

            <FieldRow label={t('tasks.workingDirectory')}>
              <FolderField
                isEdit={isEdit}
                folder={folder}
                sessionFolder={editSession?.workingDirectory}
                onChange={handleFolderChange}
                workspaceId={workspaceId}
              />
            </FieldRow>

            <FieldRow label={t('tasks.maxRepairs')}>
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_REPAIR_ATTEMPTS_CAP}
                value={maxRepairs}
                onChange={(e) => setMaxRepairs(e.target.value)}
                placeholder={String(DEFAULT_REPAIR_ATTEMPTS)}
                title={t('tasks.maxRepairsHint')}
                className="w-[88px] text-right tabular-nums"
              />
            </FieldRow>
          </div>
        </div>

        {/* Right — subtasks (Manual) / scaffold (Generate) */}
        <div className="flex min-h-0 flex-col rounded-lg bg-raised shadow-elev-1">
          {mode === 'manual' ? (
            <>
              <div className="flex shrink-0 items-center gap-2 px-4 pt-4">
                <span className="text-label-lg font-semibold">{t('kanban.subtasks')}</span>
                <span className="text-label-sm tabular-nums text-tertiary">{subtasks.length}</span>
                <Btn variant="secondary" className="ml-auto" onClick={addSubtask}>
                  <Plus strokeWidth={2} /> {t('kanban.addSubtask')}
                </Btn>
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-4">
                {subtasks.map((st, i) => (
                  <SubtaskCard
                    key={st.uid}
                    index={i}
                    subtask={st}
                    allSubtasks={subtasks}
                    groups={groups}
                    fallbackModel={orchModel || fallbackModel}
                    fallbackConnection={orchConnection}
                    onChange={(patch) => updateSubtask(st.uid, patch)}
                    onRemove={() => removeSubtask(st.uid)}
                  />
                ))}
                {subtasks.length === 0 && (
                  <button
                    type="button"
                    onClick={addSubtask}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-default py-2.5 text-label font-medium text-tertiary transition-colors duration-micro ease-out-subtle hover:border-strong hover:text-secondary hover:duration-instant"
                  >
                    <Plus className="size-4" strokeWidth={2} /> {t('tasks.addFirstSubtask')}
                  </button>
                )}
              </div>

              <div className="shrink-0 border-t border-subtle px-4 py-2.5 text-caption font-normal text-tertiary">
                {t('tasks.subtaskFooter')}
                {/* UA4.8: when a subtask counts as done, and the two background producers the host cannot see. */}
                <div className="mt-1">{t('tasks.backgroundWorkHint')}</div>
              </div>
            </>
          ) : busy ? (
            <div className="flex min-h-full flex-col gap-3 p-4">
              <div className="flex items-center gap-2 text-label font-medium text-secondary">
                <LoadingIndicator label={t('tasks.generatingTitle')} showElapsed />
              </div>
              <p className="text-label-sm text-tertiary">{t('tasks.generatingBody')}</p>
              {/* Skeleton subtask cards: the long author wait reads as "drafting nodes", not frozen. */}
              {[0, 1, 2].map((i) => (
                <div key={i} className="rounded-lg border border-subtle p-3" aria-hidden>
                  <div className="flex items-start gap-2">
                    <div className="skeleton mt-0.5 size-6 shrink-0 rounded-full" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="skeleton h-3.5 w-1/2" />
                      <div className="skeleton h-8 w-full" />
                      <div className="flex gap-1.5">
                        <div className="skeleton h-control w-[128px] rounded-md" />
                        <div className="skeleton h-control w-[144px] rounded-md" />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex min-h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center">
              <div className="grid size-12 place-items-center rounded-full bg-accent-tint text-accent">
                <Sparkles className="size-6" strokeWidth={2} />
              </div>
              <div className="text-label-lg font-semibold">{t('tasks.generatePlan')}</div>
              <p className="max-w-[360px] text-label text-secondary">{t('tasks.generateBody')}</p>
              <Btn variant="primary" size="lg" onClick={() => void generatePlan()} disabled={busy}>
                <Sparkles strokeWidth={2} /> {t('tasks.generatePlan')}
              </Btn>
              <span className="text-label-sm text-tertiary">{t('tasks.generateHint')}</span>
            </div>
          )}
        </div>
      </div>
      )}

      <RunConfirmationDialog
        confirmation={runConfirmation.pending}
        groups={groups}
        defaultConnectionSlug={defaultConnectionSlug}
        onSettle={runConfirmation.settle}
      />

      <ProjectTrustDialog
        open={pendingTrust !== null}
        project={pendingTrust}
        onClose={() => setPendingTrust(null)}
        onDecision={(project) => setFolder(project)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Results panel — storage-backed run outcome (verdict + per-node output).
// UA4.4 (adaptation 6): the run's status with its Pause / Resume / Stop, and the woke-after-done mark.
// ---------------------------------------------------------------------------
const RUN_CONTROL_ICON: Record<RunControl, typeof Pause> = { pause: Pause, resume: Play, stop: Square }
const RUN_CONTROL_LABEL: Record<RunControl, string> = { pause: 'tasks.runPause', resume: 'tasks.runResume', stop: 'tasks.runStop' }
const RUN_STATUS_LABEL: Record<string, string> = {
  running: 'tasks.runStatus.running',
  paused: 'tasks.runStatus.paused',
  verifying: 'tasks.runStatus.verifying',
  completed: 'tasks.runStatus.completed',
  failed: 'tasks.runStatus.failed',
  stopped: 'tasks.runStatus.stopped',
  interrupted: 'tasks.runStatus.interrupted',
}

function ResultsPanel({
  results,
  loading,
  onOpenChildSession,
  onRunControl,
}: {
  results: TaskResults | null
  loading: boolean
  onOpenChildSession?: (sessionId: string) => void
  onRunControl: (control: RunControl) => void
}) {
  const { t } = useTranslation()

  if (loading && !results) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg bg-raised text-tertiary shadow-elev-1">
        <Spinner className="text-label-lg" />
      </div>
    )
  }

  if (!results || !results.runId || results.nodes.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-lg bg-raised px-6 text-center text-tertiary shadow-elev-1">
        <CircleSlash className="size-6" strokeWidth={2} />
        <p className="text-label">{t('tasks.resultsEmpty')}</p>
      </div>
    )
  }

  const verdict = results.verdict
  const verdicts = results.verdicts ?? (verdict ? [verdict] : [])
  const repair = results.repair
  const controls = resolveRunControls(results.runStatus)
  const statusKey = results.runStatus ? RUN_STATUS_LABEL[results.runStatus] : undefined
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-lg bg-raised p-4 shadow-elev-1">
      {results.runStatus && (
        // UA4.4 — the run's status and its Pause / Resume / Stop, on the same hairline block as the rest.
        <div className="flex flex-col gap-1.5 rounded-lg border border-subtle px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-label font-semibold">{statusKey ? t(statusKey) : results.runStatus}</span>
            <div className="ml-auto flex items-center gap-1.5">
              {controls.map((control) => {
                const Icon = RUN_CONTROL_ICON[control]
                return (
                  <Btn key={control} variant="secondary" onClick={() => onRunControl(control)}>
                    <Icon strokeWidth={2} /> {t(RUN_CONTROL_LABEL[control])}
                  </Btn>
                )
              })}
            </div>
          </div>
          {results.runStatus === 'interrupted' && (
            <p className="text-label-sm text-tertiary">{t('tasks.runInterruptedHint')}</p>
          )}
        </div>
      )}

      {results.acceptanceCriteria && (
        <div className="rounded-lg border border-subtle px-3 py-2.5">
          <div className="text-label-sm font-medium text-tertiary">{t('tasks.acceptanceCriteria')}</div>
          <p className="mt-1 text-label text-secondary">{results.acceptanceCriteria}</p>
        </div>
      )}

      {verdict && (
        // Verdict: status tint + hairline in its role (pass = success, fail = destructive, else neutral)
        <div
          className={cn(
            'flex items-start gap-2.5 rounded-lg border px-3 py-2.5',
            verdict.result === 'pass'
              ? 'border-[color:var(--success-border)] bg-success-tint'
              : verdict.result === 'fail'
                ? 'border-[color:var(--destructive-border)] bg-destructive-tint'
                : 'border-subtle bg-fill-hover',
          )}
        >
          {verdict.result === 'pass' ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" strokeWidth={2.5} />
          ) : verdict.result === 'fail' ? (
            <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" strokeWidth={2.5} />
          ) : (
            <CircleSlash className="mt-0.5 size-4 shrink-0 text-tertiary" strokeWidth={2.5} />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-label font-semibold">
                {verdict.result === 'pass' ? t('tasks.verdictPass') : verdict.result === 'fail' ? t('tasks.verdictFail') : t('tasks.verdictUnparsed')}
              </span>
              {repair && (
                <span className="ml-auto inline-flex h-5 shrink-0 items-center rounded-xs bg-fill-hover px-1.5 text-label-sm font-medium tabular-nums text-secondary">
                  {t('tasks.repairAttempt', { used: repair.used, max: repair.max })}
                </span>
              )}
            </div>
            {verdict.via === 'decision' && (
              // UB6.6 — the UI marks a verdict the decision model read out of a reply
              // without a VERDICT line (v0.15.1's line, in v0.15.1's classes since UB14.60).
              <p className="mt-0.5 text-label-sm text-tertiary">
                {t('tasks.verdictInferred', { confidence: Math.round((verdict.confidence ?? 0) * 100) })}
              </p>
            )}
            {verdict.reason && <p className="mt-0.5 text-label text-secondary">{verdict.reason}</p>}
            {verdict.nodes && verdict.nodes.length > 0 && (
              <p className="mt-1 text-label-sm text-tertiary">{t('tasks.repairNodes', { nodes: verdict.nodes.join(', ') })}</p>
            )}
          </div>
        </div>
      )}

      {verdicts.length > 1 && (
        <div className="rounded-lg border border-subtle px-3 py-2.5">
          <div className="mb-1.5 text-label-sm font-medium text-tertiary">{t('tasks.verdictHistory')}</div>
          <div className="flex flex-col gap-1">
            {verdicts.map((v, i) => (
              <div key={i} className="flex items-start gap-2 text-label-sm">
                {v.result === 'pass' ? (
                  <CheckCircle2 className="mt-px size-3.5 shrink-0 text-success" strokeWidth={2.5} />
                ) : v.result === 'fail' ? (
                  <XCircle className="mt-px size-3.5 shrink-0 text-destructive" strokeWidth={2.5} />
                ) : (
                  <CircleSlash className="mt-px size-3.5 shrink-0 text-tertiary" strokeWidth={2.5} />
                )}
                <span className="min-w-0 flex-1 text-secondary">
                  {v.reason || (v.result === 'pass' ? t('tasks.verdictPass') : v.result === 'fail' ? t('tasks.verdictFail') : t('tasks.verdictUnparsed'))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {results.nodes.map((node) => {
        const pill = resolveNodeStatePill(node.state)
        return (
        <div key={node.id} className="rounded-lg border border-subtle p-3">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-label font-semibold">{node.title}</span>
            {node.wokeAfterDone && (
              // UA4.4 — the woke-after-done mark in the "needs you" role (info), on the node pill's chip shape.
              <span
                className="inline-flex h-5 shrink-0 items-center rounded-xs bg-info-tint px-1.5 text-label-sm font-medium text-info"
                title={t('kanban.wokeAfterDoneHint')}
              >
                {t('kanban.wokeAfterDone')}
              </span>
            )}
            <span className={cn('inline-flex h-5 shrink-0 items-center rounded-xs px-1.5 text-label-sm font-medium', pill.className)}>
              {pill.labelKey ? t(pill.labelKey) : node.state}
            </span>
            {node.sessionId && onOpenChildSession && (
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => onOpenChildSession(node.sessionId!)}
                className="shrink-0 gap-1 font-medium"
              >
                <ExternalLink className="size-3.5" strokeWidth={2} /> {t('tasks.openSession')}
              </Button>
            )}
          </div>
          {node.output ? (
            // Run output reads in a sunken well (tool output material), scrollable past 288px
            <div className="mt-2 max-h-72 overflow-y-auto rounded-md bg-sunken px-3 py-2 text-label">
              <Markdown>{node.output}</Markdown>
            </div>
          ) : (
            <p className="mt-1.5 text-label-sm text-tertiary">{t('tasks.noOutput')}</p>
          )}
        </div>
        )
      })}
    </div>
  )
}
