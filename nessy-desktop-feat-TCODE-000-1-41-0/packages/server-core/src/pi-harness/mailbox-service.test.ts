import { describe, expect, it } from 'bun:test'
import { MailboxService } from './mailbox-service'

describe('MailboxService', () => {
  it('is off by default and durably orders only child/peer messages', async () => {
    const persisted: string[] = []
    const disabled = new MailboxService({ persist: async () => {} })
    await expect(disabled.send({ id: 'm1', fromAgentId: 'a', toAgentId: 'b', body: 'hello' })).rejects.toThrow('peer-messaging-disabled')

    const service = new MailboxService({
      profile: { peerMessaging: true, maxMessages: 2, maxBytes: 32 },
      persist: async state => { persisted.push(JSON.stringify(state)) },
    })
    await service.send({ id: 'm1', fromAgentId: 'a', toAgentId: 'b', body: 'one' })
    await service.send({ id: 'm2', fromAgentId: 'a', toAgentId: 'b', body: 'two' })
    expect(service.list('b').map(message => message.id)).toEqual(['m1', 'm2'])
    expect(persisted).toHaveLength(2)
    await expect(service.send({ id: 'm3', fromAgentId: 'a', toAgentId: 'b', body: 'three' })).rejects.toThrow('mailbox-message-limit')
    await expect(service.send({ id: 'permission', fromAgentId: 'a', toAgentId: 'b', body: 'permission', kind: 'permission' as never })).rejects.toThrow('mailbox-message-kind-invalid')
  })

  it('serializes concurrent sends without losing messages or bypassing quota', async () => {
    const service = new MailboxService({
      profile: { peerMessaging: true, maxMessages: 2, maxBytes: 32 },
      persist: async () => { await Promise.resolve() },
    })
    await Promise.all([
      service.send({ id: 'm1', fromAgentId: 'a', toAgentId: 'b', body: 'one' }),
      service.send({ id: 'm2', fromAgentId: 'a', toAgentId: 'b', body: 'two' }),
    ])
    expect(service.list('b').map(message => message.id)).toEqual(['m1', 'm2'])
    await expect(service.send({ id: 'm3', fromAgentId: 'a', toAgentId: 'b', body: 'three' })).rejects.toThrow('mailbox-message-limit')
  })
})
