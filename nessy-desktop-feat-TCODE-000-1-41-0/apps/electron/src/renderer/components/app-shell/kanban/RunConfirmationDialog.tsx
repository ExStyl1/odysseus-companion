/* UA4.4 (Nessy; no v0.13.4 counterpart: upstream runs a spec without asking) — the run confirmation (spec §10
   "Run confirmation"). Shown by the tile's Play and the editor's run buttons whenever the host says the spec on disk
   is not the last one a human saved or confirmed (`run-controls.ts` `startTaskRun`); the host enforces it
   (`rpc/tasks.ts`). It lists the node count and each node's runtime and connection, model and EFFECTIVE mode, the
   task's sources, and the plugins a node sees with their MCP server names (spec §11 item 10, plan UA4.1 "Plugins"),
   and states two residues: plugin MCP servers follow plugin enablement, not the sources; a node's folder access is
   re-issued from the orchestrator's folder without a new trust prompt (UA4.1's P-UA-ab-2).
   UB14.39 (R6-10) — on v0.15.1's dialog vocabulary (recipe: v0.15.1 `ResetConfirmationDialog.tsx`): Cancel is the
   ghost, Run the forward primary, the body on the label type role with secondary and tertiary text, each node on a
   hairline card, the runtime on the composer's quiet badge (`RuntimeBadge`'s recipe). What it lists is unchanged. */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskRunConfirmationDto } from '@nessy-agent/shared/protocol'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { runtimeLabel } from '../input/runtime-switch-copy'
import type { TaskModelGroup } from './model-catalog'
import { describeConfirmationNode, type ConfirmTaskRun } from './run-controls'

/** One pending confirmation and the promise it answers (see {@link useRunConfirmation}). */
interface PendingConfirmation {
  confirmation: TaskRunConfirmationDto
  resolve: (ok: boolean) => void
}

/** The confirm callback `startTaskRun` takes, plus what the dialog renders. */
export function useRunConfirmation(): { confirm: ConfirmTaskRun; pending: TaskRunConfirmationDto | null; settle: (ok: boolean) => void } {
  const [pending, setPending] = React.useState<PendingConfirmation | null>(null)
  const pendingRef = React.useRef<PendingConfirmation | null>(null)
  const confirm = React.useCallback<ConfirmTaskRun>(
    (confirmation) => new Promise<boolean>((resolve) => {
      pendingRef.current?.resolve(false) // a second ask supersedes the first; the first is declined
      const next = { confirmation, resolve }
      pendingRef.current = next
      setPending(next)
    }),
    [],
  )
  const settle = React.useCallback((ok: boolean) => {
    pendingRef.current?.resolve(ok)
    pendingRef.current = null
    setPending(null)
  }, [])
  // An unmounted asker declines (the run is never sent).
  React.useEffect(() => () => { pendingRef.current?.resolve(false) }, [])
  return { confirm, pending: pending?.confirmation ?? null, settle }
}

export interface RunConfirmationDialogProps {
  confirmation: TaskRunConfirmationDto | null
  /** The editor's model catalogue: names each node's connection and runtime. */
  groups: readonly TaskModelGroup[]
  /** The workspace default connection — where a node naming none runs. */
  defaultConnectionSlug?: string
  onSettle: (ok: boolean) => void
}

export function RunConfirmationDialog({ confirmation, groups, defaultConnectionSlug, onSettle }: RunConfirmationDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={confirmation !== null} onOpenChange={(next) => { if (!next) onSettle(false) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('tasks.runConfirm.title')}</DialogTitle>
          <DialogDescription>{t('tasks.runConfirm.body')}</DialogDescription>
        </DialogHeader>
        {confirmation && (
          <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto text-label">
            <div className="font-semibold">{t('tasks.runConfirm.nodeCount', { count: confirmation.nodeCount })}</div>
            {confirmation.orchestratorPermissionMode && (
              <div className="text-secondary">
                {t('tasks.runConfirm.ceiling', { mode: t(`mode.${confirmation.orchestratorPermissionMode}`) })}
              </div>
            )}
            <ul className="flex flex-col gap-1.5">
              {confirmation.nodes.map((node) => {
                const view = describeConfirmationNode(node, groups, defaultConnectionSlug)
                return (
                  <li key={node.id} className="rounded-md border border-subtle px-2.5 py-1.5">
                    <div className="truncate font-medium">{node.title}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-label-sm text-tertiary">
                      {view.runtime && (
                        <span className="rounded-xs bg-fill-hover px-1.5 py-0.5 text-caption text-secondary">
                          {runtimeLabel(view.runtime)}
                        </span>
                      )}
                      {view.connectionLabel && <span>{view.connectionLabel}</span>}
                      {view.workspaceDefault && <span>({t('tasks.runConfirm.workspaceDefault')})</span>}
                      {node.model && <span>· {node.model}</span>}
                      {node.permissionMode && <span>· {t(`mode.${node.permissionMode}`)}</span>}
                    </div>
                  </li>
                )
              })}
            </ul>
            <div>
              <div className="font-semibold">{t('tasks.sources')}</div>
              <div className="text-secondary">
                {confirmation.sources.length > 0 ? confirmation.sources.join(', ') : t('tasks.runConfirm.defaultSources')}
              </div>
            </div>
            <div>
              <div className="font-semibold">{t('tasks.runConfirm.plugins')}</div>
              {confirmation.plugins === undefined ? (
                <div className="text-secondary">{t('tasks.runConfirm.pluginsUnknown')}</div>
              ) : confirmation.plugins.length === 0 ? (
                <div className="text-secondary">{t('tasks.runConfirm.noPlugins')}</div>
              ) : (
                <ul className="text-secondary">
                  {confirmation.plugins.map((plugin) => (
                    <li key={plugin.name}>
                      {plugin.name}: {plugin.mcpServers.length > 0 ? plugin.mcpServers.join(', ') : t('tasks.runConfirm.noMcpServers')}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-1 text-label-sm text-tertiary">{t('tasks.sourcesScopeHelp')}</div>
            </div>
            <div className="text-label-sm text-tertiary">{t('tasks.runConfirm.folder')}</div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onSettle(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => onSettle(true)}>{t('tasks.runConfirm.run')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
