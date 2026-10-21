/* Copied from v0.13.4:apps/electron/src/renderer/pages/ProjectInfoPage.tsx (craft-agents-oss, Apache-2.0) by UA5.8,
   2026-10-02, rebranded `@craft-agent` → `@nessy-agent`. Adapted:
   - The folder (plan manifest "picker"). Upstream types a working-directory PATH and saves it with the other
     settings. Ours never sends a path: the field is OUR composer folder picker (`ui/CompactWorkingDirectorySelector`,
     as UA3.6's TaskEditor), whose pick is an issued project handle bound at once with `setProjectFolder(…, handle.id)`
     (`projects:setFolder`, UA5.3); "Remove folder" unbinds it (`null`). The field shows the folder's display path and
     whether it is trusted, or that it no longer resolves (`folder.problem`) — what the server re-validates on every
     read. `updateProject` never carries a folder (the server refuses one: `project-folder-handle-required`).
   - The reach note (UA5.5, UA5.12): what of the project reaches the agent, and when — and, for a project without a
     folder, that its MEMORY.md does too.
   - Assets (UA5.6): the upload's base64 is encoded in chunks (`project-asset-upload.ts`); upstream's one-shot spread
     throws on a file of a few hundred KB.
   - Clearing a field: an emptied description, details or colour is saved as '' so it clears (storage removes the
     key, never stores ''); upstream sends `undefined`, which the JSON transport drops, so the old value silently stayed.
   - A reload (the folder bind's own, a `projects:changed` broadcast) re-seeds only the Settings fields the user has
     not edited since the last seed (`project-settings-form.ts`), so binding a folder keeps unsaved edits.
   - A failed "New session in …" names the server's reason (e.g. `project-folder-identity-changed`) under the toast.
   - The colour field is a div, not a label: a click on its label text selected the first swatch.
   - "Open location" goes through the shell's `onOpenFile` (the link interceptor; a folder opens externally).
   UB14.59 took v0.15.1's hunks of this file (the hero avatar tile, `Button`/`IconButton` variants, the segmented tab
   bar, 44px list rows on the separator, the slug in mono, the role text) and re-applied the NESSY folder field, its
   trust line and the reach note on the same role tokens (`text-label font-medium text-foreground` labels,
   `text-label-sm text-tertiary` hints), as upstream's `Field` does. */
/**
 * ProjectInfoPage
 *
 * Workspace-project detail page with three tabs: Sessions, Assets, Settings.
 * v1 scope only — no memory tab, no provider selection, no plugin marketplace.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useAtomValue } from 'jotai'
import { FolderKanban, FolderOpen, Plus, Trash2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import type { IssuedProjectHandle } from '@nessy-agent/shared/projects/project-handle-service'
import { useActiveWorkspace, useAppShellContext } from '@/context/AppShellContext'
import { navigate, routes } from '@/lib/navigate'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import {
  Info_Page,
  Info_Section,
  Info_Table,
} from '@/components/info'
import { Button, IconButton, buttonVariants } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { CompactWorkingDirectorySelector } from '@/components/ui/CompactWorkingDirectorySelector'
import { cn } from '@/lib/utils'
import { PROJECT_COLOR_PALETTE } from '@/utils/project-colors'
import { InlineColorPickerRow } from '@/components/ui/inline-color-picker-row'
import type { LoadedProjectView } from '@nessy-agent/shared/protocol'
import type { ProjectAsset } from '@nessy-agent/shared/projects/types'
import { bytesToBase64, uploadFailureToast } from './project-asset-upload'
import { projectSettingsSeed, reseedProjectSettings, type ProjectSettingsForm } from './project-settings-form'

interface ProjectInfoPageProps {
  projectSlug: string
}

type TabKey = 'sessions' | 'assets' | 'settings'

export default function ProjectInfoPage({ projectSlug }: ProjectInfoPageProps) {
  const { t } = useTranslation()
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const { onCreateSession, onOpenFile } = useAppShellContext()

  const [project, setProject] = useState<LoadedProjectView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<TabKey>('sessions')
  const [assets, setAssets] = useState<ProjectAsset[]>([])
  const [form, setForm] = useState<ProjectSettingsForm>({ name: '', description: '', details: '', color: '' })
  const seededRef = useRef<ProjectSettingsForm | null>(null)
  const { name: editName, description: editDescription, details: editDetails, color: editColor } = form
  const setEditName = useCallback((name: string) => setForm(f => ({ ...f, name })), [])
  const setEditDescription = useCallback((description: string) => setForm(f => ({ ...f, description })), [])
  const setEditDetails = useCallback((details: string) => setForm(f => ({ ...f, details })), [])
  const setEditColor = useCallback((color: string) => setForm(f => ({ ...f, color })), [])
  const [saving, setSaving] = useState(false)
  const [folderBusy, setFolderBusy] = useState(false)

  // Load project (and re-load on broadcast)
  const loadProject = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.getProject(workspaceId, projectSlug)
      if (!result) {
        setError(t('projectInfo.notFound'))
        setProject(null)
        return
      }
      const loaded = result
      setProject(loaded)
      // NESSY: re-seed only the fields still holding the last seed — a reload keeps unsaved edits.
      const next = projectSettingsSeed(loaded.config)
      const last = seededRef.current
      seededRef.current = next
      setForm(cur => reseedProjectSettings(cur, last, next))
    } catch (err) {
      console.error('[ProjectInfoPage] Failed to load project:', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [workspaceId, projectSlug, t])

  useEffect(() => {
    loadProject()
  }, [loadProject])

  useEffect(() => {
    if (!workspaceId) return
    const off = window.electronAPI.onProjectsChanged((wsId: string) => {
      if (wsId === workspaceId) loadProject()
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [workspaceId, loadProject])

  // Load assets when entering Assets tab
  const refreshAssets = useCallback(async () => {
    if (!workspaceId) return
    try {
      const list = await window.electronAPI.listProjectAssets(workspaceId, projectSlug)
      setAssets(Array.isArray(list) ? list : [])
    } catch (err) {
      console.error('[ProjectInfoPage] Failed to load assets:', err)
    }
  }, [workspaceId, projectSlug])

  useEffect(() => {
    if (tab === 'assets') refreshAssets()
  }, [tab, refreshAssets])

  const projectSessions = useMemo(() => {
    if (!project) return []
    const result: { id: string; name: string }[] = []
    for (const meta of sessionMetaMap.values()) {
      if (meta.projectId === project.config.id) {
        result.push({ id: meta.id, name: meta.name ?? meta.id })
      }
    }
    return result
  }, [project, sessionMetaMap])

  const handleStartSession = useCallback(async () => {
    if (!workspaceId || !project) return
    try {
      const session = await onCreateSession(workspaceId, { projectId: project.config.id })
      if (session?.id) {
        navigate(routes.view.allSessions(session.id))
      }
    } catch (err) {
      console.error('[ProjectInfoPage] Failed to create session:', err)
      toast.error(t('projectInfo.newSessionFailed'), {
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }, [workspaceId, project, onCreateSession, t])

  // NESSY: the folder is bound through an issued handle, at once (never typed, never saved as a path).
  const handlePickFolder = useCallback(async (picked: IssuedProjectHandle) => {
    if (!workspaceId || !project) return
    setFolderBusy(true)
    try {
      await window.electronAPI.setProjectFolder(workspaceId, project.config.slug, picked.id)
      await loadProject()
    } catch (err) {
      console.error('[ProjectInfoPage] Folder update failed:', err)
      toast.error(t('projectInfo.folderUpdateFailed'))
    } finally {
      setFolderBusy(false)
    }
  }, [workspaceId, project, loadProject, t])

  const handleRemoveFolder = useCallback(async () => {
    if (!workspaceId || !project) return
    setFolderBusy(true)
    try {
      await window.electronAPI.setProjectFolder(workspaceId, project.config.slug, null)
      await loadProject()
    } catch (err) {
      console.error('[ProjectInfoPage] Folder removal failed:', err)
      toast.error(t('projectInfo.folderUpdateFailed'))
    } finally {
      setFolderBusy(false)
    }
  }, [workspaceId, project, loadProject, t])

  const handleSaveSettings = useCallback(async () => {
    if (!workspaceId || !project) return
    setSaving(true)
    try {
      await window.electronAPI.updateProject(workspaceId, project.config.slug, {
        name: editName.trim() || project.config.name,
        description: editDescription.trim(),
        details: editDetails.trim(),
        color: editColor.trim(),
      })
      toast.success(t('projectInfo.saved'))
    } catch (err) {
      console.error('[ProjectInfoPage] Save failed:', err)
      toast.error(t('projectInfo.saveFailed'))
    } finally {
      setSaving(false)
    }
  }, [workspaceId, project, editName, editDescription, editDetails, editColor, t])

  const handleDeleteProject = useCallback(async () => {
    if (!workspaceId || !project) return
    if (!window.confirm(t('projectInfo.deleteConfirm', { name: project.config.name }))) return
    try {
      await window.electronAPI.deleteProject(workspaceId, project.config.slug)
      navigate(routes.view.projects())
    } catch (err) {
      console.error('[ProjectInfoPage] Delete failed:', err)
      toast.error(t('projectInfo.deleteFailed'))
    }
  }, [workspaceId, project, t])

  const handleUpload = useCallback(async (file: File) => {
    if (!workspaceId || !project) return
    try {
      const arrayBuffer = await file.arrayBuffer()
      const base64 = bytesToBase64(new Uint8Array(arrayBuffer))
      await window.electronAPI.uploadProjectAsset(workspaceId, project.config.slug, {
        filename: file.name,
        base64,
      })
      await refreshAssets()
      toast.success(t('projectInfo.assetUploaded', { name: file.name }))
    } catch (err) {
      console.error('[ProjectInfoPage] Upload failed:', err)
      const failure = uploadFailureToast(err) // UA12.113: the size cap names its limit
      toast.error(failure.key === 'projectInfo.assetTooLarge' ? t(failure.key, { name: file.name, ...failure.params }) : t(failure.key))
    }
  }, [workspaceId, project, refreshAssets, t])

  const handleDeleteAsset = useCallback(async (asset: ProjectAsset) => {
    if (!workspaceId || !project) return
    if (!window.confirm(t('projectInfo.deleteAssetConfirm', { name: asset.filename }))) return
    try {
      await window.electronAPI.deleteProjectAsset(workspaceId, project.config.slug, asset.filename)
      await refreshAssets()
    } catch (err) {
      console.error('[ProjectInfoPage] Asset delete failed:', err)
      toast.error(t('projectInfo.deleteAssetFailed'))
    }
  }, [workspaceId, project, refreshAssets, t])

  const folder = project?.config.folder

  return (
    <Info_Page
      loading={loading}
      error={error ?? undefined}
      empty={!project && !loading && !error ? t('projectInfo.notFound') : undefined}
    >
      {/* The name lives in the hero */}
      <Info_Page.Header />
      {project && (
        <Info_Page.Content>
          <Info_Page.Hero
            avatar={
              <div className="grid size-full place-items-center bg-fill-hover">
                <FolderKanban className="size-5 text-secondary" aria-hidden />
              </div>
            }
            title={project.config.name}
            tagline={project.config.description || t('projectInfo.taglineFallback')}
          />

          {/* Tab bar */}
          <div className="flex h-control w-fit items-center gap-0.5 rounded-md bg-fill-hover p-0.5">
            <TabButton active={tab === 'sessions'} onClick={() => setTab('sessions')}>
              {t('projectInfo.tabSessions')}
            </TabButton>
            <TabButton active={tab === 'assets'} onClick={() => setTab('assets')}>
              {t('projectInfo.tabAssets')}
            </TabButton>
            <TabButton active={tab === 'settings'} onClick={() => setTab('settings')}>
              {t('projectInfo.tabSettings')}
            </TabButton>
          </div>

          {/* Sessions tab */}
          {tab === 'sessions' && (
            <Info_Section
              title={t('projectInfo.tabSessions')}
              actions={
                <Button size="md" variant="secondary" onClick={handleStartSession}>
                  <Plus className="size-3.5" />
                  {t('projectInfo.newSessionButton', { name: project.config.name })}
                </Button>
              }
            >
              {projectSessions.length === 0 ? (
                <div className="px-3.5 py-6 text-label text-tertiary">
                  {t('projectInfo.noSessions')}
                </div>
              ) : (
                <ul className="divide-y divide-separator">
                  {projectSessions.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        className="flex min-h-11 w-full items-center px-3.5 py-2 text-left text-label text-foreground -outline-offset-2 transition-colors duration-micro ease-out-subtle hover:bg-fill-hover hover:duration-instant"
                        onClick={() => navigate(routes.view.allSessions(s.id))}
                      >
                        <span className="truncate">{s.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Info_Section>
          )}

          {/* Assets tab */}
          {tab === 'assets' && (
            <Info_Section
              title={t('projectInfo.tabAssets')}
              actions={
                <label
                  className={cn(buttonVariants({ variant: 'secondary', size: 'md' }), 'cursor-pointer')}
                >
                  <Upload className="size-3.5" />
                  {t('projectInfo.uploadAssets')}
                  <input
                    type="file"
                    className="hidden"
                    multiple
                    onChange={async (e) => {
                      const files = Array.from(e.target.files ?? [])
                      for (const f of files) await handleUpload(f)
                      e.target.value = ''
                    }}
                  />
                </label>
              }
            >
              {assets.length === 0 ? (
                <div className="px-3.5 py-6 text-label text-tertiary">
                  {t('projectInfo.noAssets')}
                </div>
              ) : (
                <ul className="divide-y divide-separator">
                  {assets.map((a) => (
                    <li key={a.filename} className="flex min-h-11 items-center gap-3 px-3.5 py-2">
                      <div className="flex-1 min-w-0">
                        <div className="truncate text-label text-foreground">{a.filename}</div>
                        <div className="text-label-sm text-tertiary tabular-nums">
                          {(a.sizeBytes / 1024).toFixed(1)} KB · {a.mimeType}
                        </div>
                      </div>
                      <IconButton
                        size="sm"
                        aria-label={t('common.delete')}
                        icon={<Trash2 className="size-3.5" />}
                        onClick={() => handleDeleteAsset(a)}
                        className="text-destructive hover:bg-destructive-tint hover:text-destructive"
                      />
                    </li>
                  ))}
                </ul>
              )}
            </Info_Section>
          )}

          {/* Settings tab */}
          {tab === 'settings' && workspaceId && (
            <Info_Section title={t('projectInfo.tabSettings')}>
              <div className="space-y-4 px-3.5 py-3.5">
                <Field label={t('projectInfo.title')}>
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder={project.config.name}
                  />
                </Field>
                <Field label={t('projectInfo.description')}>
                  <Input
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    placeholder={t('projectInfo.descriptionPlaceholder')}
                  />
                </Field>
                {/* NESSY: the folder — a div, not a label (a label forwards its clicks to the picker's button) */}
                <div>
                  <div className="mb-1.5 text-label font-medium text-foreground">{t('projectInfo.workingDirectory')}</div>
                  <div className={cn('flex items-center gap-2', folderBusy && 'opacity-60 pointer-events-none')}>
                    <CompactWorkingDirectorySelector
                      workingDirectory={folder?.displayPath}
                      onWorkingDirectoryChange={handlePickFolder}
                      workspaceId={workspaceId}
                    />
                    {folder && (
                      <Button variant="ghost" onClick={handleRemoveFolder}>
                        <X className="size-3.5" />
                        {t('projectInfo.workingDirectoryRemove')}
                      </Button>
                    )}
                  </div>
                  <div className="mt-1 text-label-sm text-tertiary">
                    {!folder
                      ? t('projectInfo.workingDirectoryNone')
                      : (
                        <>
                          <span className="font-mono text-mono-ui">{folder.displayPath}</span>
                          {' · '}
                          {folder.problem
                            ? t('projectInfo.folderProblem')
                            : folder.trusted ? t('projectInfo.folderTrusted') : t('projectInfo.folderNotTrusted')}
                        </>
                      )}
                  </div>
                </div>
                <Field
                  label={t('projectInfo.color')}
                  hint={t('projectInfo.colorHint')}
                  group
                >
                  <InlineColorPickerRow
                    value={editColor}
                    onChange={setEditColor}
                    presets={PROJECT_COLOR_PALETTE}
                    onClear={() => setEditColor('')}
                    clearLabel={t('projectInfo.colorClear')}
                    customAriaLabel={t('projectInfo.colorCustom')}
                  />
                </Field>
                <Field
                  label={t('projectInfo.details')}
                  hint={t('projectInfo.detailsHelpText')}
                >
                  <Textarea
                    value={editDetails}
                    onChange={(e) => setEditDetails(e.target.value)}
                    rows={6}
                    placeholder={t('projectInfo.detailsPlaceholder')}
                  />
                </Field>
                {/* NESSY (UA5.5, UA5.12): what reaches the agent, and when */}
                <div className="text-label-sm text-tertiary">
                  {t('projectInfo.contextReachNote')}
                  {!folder && <> {t('projectInfo.memoryReachNote')}</>}
                </div>
                <div className="flex justify-between pt-2">
                  <Button variant="danger" onClick={handleDeleteProject}>
                    <Trash2 className="size-3.5" />
                    {t('projectInfo.deleteProject')}
                  </Button>
                  <Button variant="primary" onClick={handleSaveSettings} disabled={saving}>
                    {saving ? t('common.saving') : t('common.save')}
                  </Button>
                </div>
              </div>
            </Info_Section>
          )}

          {/* Metadata read-out for quick reference */}
          <Info_Section title={t('projectInfo.metadata')}>
            <Info_Table>
              <Info_Table.Row label={t('common.slug')}>
                <span className="font-mono text-mono-ui">{project.config.slug}</span>
              </Info_Table.Row>
              <Info_Table.Row label={t('common.location')}>
                <div className="-my-1 flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-mono-ui">{project.folderPath}</span>
                  <IconButton
                    size="sm"
                    aria-label={t('projectInfo.openLocation')}
                    tooltip
                    icon={<FolderOpen className="size-3.5" />}
                    onClick={() => onOpenFile(project.folderPath)}
                  />
                </div>
              </Info_Table.Row>
            </Info_Table>
          </Info_Section>
        </Info_Page.Content>
      )}
    </Info_Page>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'motion-press inline-flex h-control-sm in-data-compact:h-9 items-center rounded-sm px-2.5 text-label-sm font-medium',
        active
          ? 'bg-floating text-foreground shadow-elev-1'
          : 'text-secondary hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}

/** NESSY: `group` renders a div — a label around several buttons forwards a click on its text to the first one. */
function Field({
  label,
  hint,
  group,
  children,
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  group?: boolean
  children: React.ReactNode
}) {
  const Wrapper = group ? 'div' : 'label'
  return (
    <Wrapper className="block">
      <div className="mb-1.5 text-label font-medium text-foreground">{label}</div>
      {children}
      {hint && <div className="mt-1 text-label-sm text-tertiary">{hint}</div>}
    </Wrapper>
  )
}
