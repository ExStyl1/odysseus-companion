import { join } from 'path'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { getWorkspaceOrThrow } from '../utils'
import type { RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.skills.DELETE,
  RPC_CHANNELS.skills.OPEN_EDITOR,
  RPC_CHANNELS.skills.OPEN_FINDER,
] as const

export function registerSkillsHandlers(server: RpcServer, deps: HandlerDeps): void {
  // Delete a skill from a workspace
  server.handle(RPC_CHANNELS.skills.DELETE, async (_ctx, workspaceId: string, skillSlug: string) => {
    const workspace = getWorkspaceOrThrow(deps.workspaceService, workspaceId)

    const { deleteSkill } = await import('@nessy-agent/shared/skills')
    deleteSkill(workspace.workspaceRootPath, skillSlug)
    deps.platform.logger?.info(`Deleted skill: ${skillSlug}`)
  })

  // Open skill SKILL.md in editor
  server.handle(RPC_CHANNELS.skills.OPEN_EDITOR, async (_ctx, workspaceId: string, skillSlug: string) => {
    const workspace = getWorkspaceOrThrow(deps.workspaceService, workspaceId)
    if (workspace.config.remoteServer) throw new Error('Open in editor is not available for remote workspaces')

    const { getWorkspaceSkillsPath } = await import('@nessy-agent/shared/workspaces')

    const skillsDir = getWorkspaceSkillsPath(workspace.workspaceRootPath)
    const skillFile = join(skillsDir, skillSlug, 'SKILL.md')
    await deps.platform.openPath?.(skillFile)
  })

  // Open skill folder in Finder/Explorer
  server.handle(RPC_CHANNELS.skills.OPEN_FINDER, async (_ctx, workspaceId: string, skillSlug: string) => {
    const workspace = getWorkspaceOrThrow(deps.workspaceService, workspaceId)
    if (workspace.config.remoteServer) throw new Error('Show in Finder is not available for remote workspaces')

    const { getWorkspaceSkillsPath } = await import('@nessy-agent/shared/workspaces')

    const skillsDir = getWorkspaceSkillsPath(workspace.workspaceRootPath)
    const skillDir = join(skillsDir, skillSlug)
    await deps.platform.showItemInFolder?.(skillDir)
  })
}
