import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { HandlerDeps } from '../../handler-deps'
import type { HandlerFn, RpcServer } from '../../../transport/types'
import { registerSkillsHandlers } from '../skills'

describe('registerSkillsHandlers', () => {
  it('keeps native skill actions but removes raw list/detail routes', () => {
    const handlers = new Map<string, HandlerFn>()
    const server = {
      handle(channel: string, handler: HandlerFn) { handlers.set(channel, handler) },
      push() {},
      async invokeClient() { return undefined },
      hasClientCapability() { return false },
      findClientsWithCapability() { return [] },
    } as RpcServer
    registerSkillsHandlers(server, {
      platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    } as unknown as HandlerDeps)

    expect([...handlers.keys()].sort()).toEqual([
      RPC_CHANNELS.skills.DELETE,
      RPC_CHANNELS.skills.OPEN_EDITOR,
      RPC_CHANNELS.skills.OPEN_FINDER,
    ].sort())
    expect(handlers.has('skills:get')).toBe(false)
    expect(handlers.has('skills:getFiles')).toBe(false)
  })
})
