import type { PiMailboxMessageV1 as MailboxMessageV1, PiMailboxStateV1 as MailboxStateV1 } from '@nessy-agent/shared/sessions/types'

/**
 * `documented, not implemented — R23 agent teams is an undecided subsystem.`
 *
 * Constructed once per Pi session (`SessionManager.ts`) with a real persist
 * closure and NO `profile`, so `send()` refuses with `peer-messaging-disabled`
 * before it can write anything, and neither method has a non-test caller. That
 * is the intended state, not an oversight: R23's first step is a judgement call
 * on whether we want agent teams at all, and both deleting this and finishing
 * it would pre-empt that call. See {@link MailboxMessageV1} for the chain.
 *
 * Live inter-session messaging is the unrelated `send_agent_message`.
 */
export class MailboxService {
  private state: MailboxStateV1
  private commitTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: {
    profile?: { peerMessaging: boolean; maxMessages: number; maxBytes: number }
    initialState?: MailboxStateV1
    persist(state: MailboxStateV1): Promise<void>
  }) {
    this.state = structuredClone(options.initialState ?? { schemaVersion: 1, revision: 0, messages: [] })
  }

  async send(input: Omit<MailboxMessageV1, 'schemaVersion' | 'kind'> & { kind?: 'message' }): Promise<void> {
    const operation = this.commitTail.then(async () => {
      const profile = this.options.profile
      if (!profile?.peerMessaging) throw new Error('peer-messaging-disabled')
      if (input.kind !== undefined && input.kind !== 'message') throw new Error('mailbox-message-kind-invalid')
      if (this.state.messages.some(message => message.id === input.id)) throw new Error('mailbox-message-id-reused')
      if (this.state.messages.length >= profile.maxMessages) throw new Error('mailbox-message-limit')
      if (Buffer.byteLength(input.body, 'utf8') > profile.maxBytes) throw new Error('mailbox-message-too-large')
      const candidate: MailboxStateV1 = {
        schemaVersion: 1,
        revision: this.state.revision + 1,
        messages: [...this.state.messages, { schemaVersion: 1, kind: 'message', ...structuredClone(input) }],
      }
      await this.options.persist(structuredClone(candidate))
      this.state = candidate
    })
    this.commitTail = operation.catch(() => {})
    await operation
  }

  list(agentId: string): MailboxMessageV1[] {
    return structuredClone(this.state.messages.filter(message => message.toAgentId === agentId))
  }
}
