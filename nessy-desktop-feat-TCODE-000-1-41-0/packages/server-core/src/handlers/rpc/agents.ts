import type { RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

/** Raw AgentDefinition listing ended in W8; agents are catalog capabilities. */
export const HANDLED_CHANNELS = [] as const

export function registerAgentsHandlers(_server: RpcServer, _deps: HandlerDeps): void {}
