/* Moved from v0.13.4:apps/electron/src/renderer/components/app-shell/kanban/KanbanBoardContainer.tsx
   (craft-agents-oss, Apache-2.0) by UA3.6, 2026-10-02: `buildModelCatalog` (L55–L87), pure here so
   `bun test` pins it without the container's context graph (the precedent is UA2.4's `board-derive.ts`).
   Adaptations, each named:
   1. Each group is ONE connection and carries its runtime (`runtimeForProviderType`), which the editor's
      model picker shows as a chip beside the connection's name — on a three-runtime host the same model
      family is served by more than one runtime, and the runtime is what a node actually runs on.
   2. Gateway models resolve by ALIAS (spec §10, AGENTS.md "Gateway Facts"): an entry of a Nessy Gateway
      connection whose catalogue alias is `coder` or `fast` is offered under the alias, never under the id
      behind it, which rotates (a retired id answers 404). The task schema accepts exactly these aliases as
      known models (`GATEWAY_MODEL_ALIASES`, `packages/shared/src/tasks/validate.ts`; the test pins the two
      lists together), and a session resolves the alias through the connection's own table (P6.362).
   3. No `ANTHROPIC_MODELS` fallback (spec §3, reason (c)): the catalogue is the workspace's connections;
      {@link resolveCatalogDefaultModel} names the default from them.
   4. A pick carries its CONNECTION, and an id offered by two connections routes to the workspace default
      connection, never last-wins (UA3.6 follow-up, 2026-10-02; reason (c): adaptation 2 makes collisions the
      common case — all three gateway cards, Pi `nessy-gateway`, `claude-gateway` and `codex-gateway`, list
      `coder` and `fast` through the same `fetchNestorModels`, `server-core/src/model-fetchers/nestor.ts`).
      Upstream's map was last-wins ("acceptable for v1"), so `coder` under "Nessy Gateway · Pi" ran on
      whichever gateway card came last, and an edit could ask the host for a runtime switch it refuses
      (`task-attach-connection-locked`). Now: the workspace default connection's group comes FIRST
      ({@link resolveDefaultConnectionSlug}, the same connection {@link resolveCatalogDefaultModel} reads),
      the map is first-wins (so an id with no explicit connection routes to the first group offering it,
      which is where {@link checkedConnectionSlug} shows the check), and every picker passes the picked
      group's `connectionSlug` on (the editor's `ModelSelect`, the tile's add-subtask composer). */
import { getModelShortName } from '@config/models'
import {
  getDefaultModelsForConnection,
  isNessyGatewayConnectionShape,
  isSessionConnectionUnavailable,
  resolveEffectiveConnectionSlug,
  type LlmConnectionWithStatus,
  type LlmProviderType,
} from '@config/llm-connections'
import type { ModelProvider } from '@config/models'
import { runtimeForProviderType } from '../input/runtime-switch-copy'
import type { KanbanModelProviderGroup } from './types'

/** The gateway aliases a task may name as its model (adaptation 2). */
export const TASK_GATEWAY_MODEL_ALIASES: readonly string[] = ['coder', 'fast']

/** A connection's models, with the runtime that serves them (adaptation 1). */
export interface TaskModelGroup extends KanbanModelProviderGroup {
  /** The connection slug this group is. */
  connectionSlug: string
  runtime: ModelProvider
}

/**
 * Build the provider→model catalog from the workspace's authenticated LLM connections, plus a
 * model-id → connection-slug map so a spawned subtask routes to the connection that actually serves
 * the model. NESSY (adaptation 4): `preferredConnection` (the workspace default) heads the groups, and a
 * model id offered by more than one connection maps to the FIRST group offering it — never last-wins.
 */
export function buildModelCatalog(
  connections: readonly LlmConnectionWithStatus[],
  preferredConnection?: string,
): {
  groups: TaskModelGroup[]
  modelToConnection: Map<string, string>
} {
  const groups: TaskModelGroup[] = []
  const modelToConnection = new Map<string, string>()

  for (const conn of connections) {
    if (!conn.isAuthenticated) continue
    const rawModels = conn.models?.length
      ? conn.models
      : getDefaultModelsForConnection(conn.providerType, conn.piAuthProvider)
    const gateway = isNessyGatewayConnectionShape(conn)
    const models = rawModels.map(m => {
      if (typeof m === 'string') return { id: m, name: getModelShortName(m) }
      const alias = m.shortName?.trim().toLowerCase()
      const id = gateway && alias && TASK_GATEWAY_MODEL_ALIASES.includes(alias) ? alias : m.id
      return { id, name: m.name || getModelShortName(m.id) }
    })
    if (models.length === 0) continue
    // Provider key drives the brand icon: 'anthropic' resolves directly; Pi
    // connections resolve through their piAuthProvider (see resolveProviderIcon in TaskTile).
    const provider = conn.providerType === 'anthropic' ? 'anthropic' : conn.piAuthProvider || conn.providerType
    groups.push({
      provider,
      label: conn.name,
      models,
      connectionSlug: conn.slug,
      runtime: runtimeForProviderType(conn.providerType as LlmProviderType),
    })
  }

  const ordered = preferredConnection
    ? [...groups.filter(g => g.connectionSlug === preferredConnection), ...groups.filter(g => g.connectionSlug !== preferredConnection)]
    : groups
  for (const g of ordered) {
    for (const m of g.models) if (!modelToConnection.has(m.id)) modelToConnection.set(m.id, g.connectionSlug)
  }

  return { groups: ordered, modelToConnection }
}

/** The workspace default connection's slug: the workspace's own setting, else the global default. */
export function resolveDefaultConnectionSlug(
  connections: readonly LlmConnectionWithStatus[],
  workspaceDefaultConnection?: string,
): string | undefined {
  return workspaceDefaultConnection ?? connections.find(c => c.isDefault)?.slug
}

/**
 * The connection whose group shows the check for `model` (adaptation 4): the picked `connectionSlug` when
 * its group offers the model, else the first group offering it — the one `modelToConnection` routes to.
 * Undefined when no group offers it (or, for the playground's static groups, none carries a slug).
 */
export function checkedConnectionSlug(
  groups: readonly KanbanModelProviderGroup[],
  model: string,
  connectionSlug: string | undefined,
): string | undefined {
  const offers = (g: KanbanModelProviderGroup) => g.models.some(m => m.id === model)
  if (connectionSlug && groups.some(g => g.connectionSlug === connectionSlug && offers(g))) return connectionSlug
  return groups.find(offers)?.connectionSlug
}

/**
 * The model a new task starts on: the workspace default connection's own default model when the catalogue
 * offers it (under its alias, for a gateway), else that connection's first model, else the catalogue's first.
 * Undefined only for an empty catalogue.
 */
export function resolveCatalogDefaultModel(
  connections: readonly LlmConnectionWithStatus[],
  groups: readonly TaskModelGroup[],
  workspaceDefaultConnection?: string,
): string | undefined {
  const defaultSlug = resolveDefaultConnectionSlug(connections, workspaceDefaultConnection)
  const group = groups.find(g => g.connectionSlug === defaultSlug)
  if (group) {
    const conn = connections.find(c => c.slug === defaultSlug)
    const wanted = conn?.defaultModel
    const byId = wanted ? group.models.find(m => m.id === wanted) : undefined
    if (byId) return byId.id
    // A gateway default is stored as the rotating id; the catalogue offers it under its alias.
    const raw = wanted ? conn?.models?.find(m => typeof m !== 'string' && m.id === wanted) : undefined
    const alias = raw && typeof raw !== 'string' ? raw.shortName?.trim().toLowerCase() : undefined
    if (alias && group.models.some(m => m.id === alias)) return alias
    if (group.models[0]) return group.models[0].id
  }
  return groups[0]?.models[0]?.id
}

/**
 * UA12.46 — `modelId` as the catalogue names it for `connection` (adaptation 2): a Nessy Gateway entry whose
 * alias is a task alias is named by the alias (`coder`, `fast`), never by the id behind it, which rotates;
 * every other id is itself. The same mapping {@link resolveCatalogDefaultModel} applies to a stored default.
 */
export function catalogModelIdFor(
  connection: Pick<TaskModelConnection, 'providerType' | 'baseUrl' | 'models'>,
  modelId: string,
): string {
  if (!isNessyGatewayConnectionShape(connection)) return modelId
  const raw = connection.models?.find(m => typeof m !== 'string' && m.id === modelId)
  const alias = raw && typeof raw !== 'string' ? raw.shortName?.trim().toLowerCase() : undefined
  return alias && TASK_GATEWAY_MODEL_ALIASES.includes(alias) ? alias : modelId
}

/** UA12.46 — the connection fields {@link resolveSessionTaskModel} reads (structurally, `LlmConnectionWithStatus`'s). */
export interface TaskModelConnection {
  slug: string
  providerType: string
  baseUrl?: string | null
  piAuthProvider?: string | null
  models?: LlmConnectionWithStatus['models']
  defaultModel?: string
  isDefault?: boolean
}

/**
 * UA12.46 (Nessy, reason (c)) — the model a session WILL run on, for the board: the session's own model, else its
 * effective connection's `defaultModel` (`resolveEffectiveConnectionSlug`: the session's connection, the workspace
 * default, the global default, the first), named as the catalogue names it ({@link catalogModelIdFor}). This is the
 * composer's own resolution (`ChatPage.tsx` `effectiveModel`), so a tile and the chat it opens cannot disagree; a
 * session whose connection is gone resolves through no other one (`isSessionConnectionUnavailable`), as there.
 * Undefined when nothing names a model — the board then shows no model chip, where upstream showed `DEFAULT_MODEL`
 * (an Anthropic model a gateway workspace does not serve). `connection` is the connection the model came from.
 */
export function resolveSessionTaskModel(
  session: { model?: string; llmConnection?: string },
  connections: readonly TaskModelConnection[] | undefined,
  workspaceDefaultConnection: string | undefined,
): { model?: string; connection?: TaskModelConnection } {
  if (session.model) return { model: session.model }
  const all = connections ?? []
  if (isSessionConnectionUnavailable(session.llmConnection, [...all])) return {}
  const slug = resolveEffectiveConnectionSlug(session.llmConnection, workspaceDefaultConnection, [...all])
  const connection = slug ? all.find(c => c.slug === slug) : undefined
  if (!connection?.defaultModel) return {}
  return { model: catalogModelIdFor(connection, connection.defaultModel), connection }
}

/**
 * UA12.46 — the add-subtask composer's first pick: the catalogue default the container resolved
 * ({@link resolveCatalogDefaultModel}), else the catalogue's first model, else none (`''`, which the container
 * sends as no model, so the child runs on its connection's default). Upstream fell back to `DEFAULT_MODEL`.
 */
export function initialSubtaskModel(defaultModel: string | undefined, groups: readonly KanbanModelProviderGroup[] | undefined): string {
  return defaultModel ?? groups?.flatMap(g => g.models)[0]?.id ?? ''
}
