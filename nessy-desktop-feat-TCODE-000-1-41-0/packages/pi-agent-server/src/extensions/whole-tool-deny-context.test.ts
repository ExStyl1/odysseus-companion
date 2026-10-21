import { afterEach, describe, expect, it } from 'bun:test'
import { createPiLifecycleExtension } from './lifecycle-bridge.ts'
import { setWholeToolDenyRefusals } from './whole-tool-deny-context.ts'

// F1.1100 — the model reads the deny rule, not the Pi SDK's "Tool <name> not found", for a tool a whole-tool deny
// removed. Driven through the lifecycle extension's real `context` handler, the seam Pi calls before every model call.

const REFUSAL = 'Tool blocked: the workspace deny rule "Bash" names the whole tool.'

function contextHandler(): (event: { type: 'context'; messages: unknown[] }) => unknown {
  const handlers = new Map<string, (event: unknown) => unknown>()
  const pi = { on: (event: string, handler: (event: unknown) => unknown) => { handlers.set(event, handler) } }
  createPiLifecycleExtension({ cwd: '/tmp', emit: () => undefined, getOriginalUserPrompt: () => null })(pi as never)
  const handler = handlers.get('context')
  if (!handler) throw new Error('the lifecycle extension registers no context handler')
  return handler as never
}

const notFound = (toolName: string, extra: Record<string, unknown> = {}) => ({
  role: 'toolResult', toolCallId: 'c1', toolName, isError: true,
  content: [{ type: 'text', text: `Tool ${toolName} not found` }], timestamp: 1, ...extra,
})

afterEach(() => setWholeToolDenyRefusals(undefined))

describe('F1.1100: a deny-removed tool\'s not-found result reaches the model as the rule', () => {
  it('replaces the SDK sentence with the refusal, leaving every other message as it was', async () => {
    setWholeToolDenyRefusals([{ name: 'bash', refusal: REFUSAL }])
    const user = { role: 'user', content: 'run it', timestamp: 0 }
    const result = await contextHandler()({ type: 'context', messages: [user, notFound('bash')] }) as { messages: unknown[] }
    expect(result.messages[0]).toBe(user)
    expect(result.messages[1]).toEqual(notFound('bash', { content: [{ type: 'text', text: REFUSAL }] }))
  })

  it('CONTROL: a tool no rule removed, another error text, a success, and an empty list change nothing', async () => {
    setWholeToolDenyRefusals([{ name: 'bash', refusal: REFUSAL }])
    const handler = contextHandler()
    expect({
      otherTool: await handler({ type: 'context', messages: [notFound('read')] }),
      otherText: await handler({ type: 'context', messages: [notFound('bash', { content: [{ type: 'text', text: 'exit 1' }] })] }),
      success: await handler({ type: 'context', messages: [notFound('bash', { isError: false })] }),
    }).toEqual({ otherTool: undefined, otherText: undefined, success: undefined })
    setWholeToolDenyRefusals(undefined)
    expect(await handler({ type: 'context', messages: [notFound('bash')] })).toBeUndefined()
  })

  it('drops a malformed entry and keeps the well-formed ones', async () => {
    setWholeToolDenyRefusals([{ name: '', refusal: 'x' }, { name: 'grep' }, 7, null, { name: 'bash', refusal: REFUSAL }])
    const result = await contextHandler()({ type: 'context', messages: [notFound('grep'), notFound('bash')] }) as { messages: Array<{ content: unknown }> }
    expect(result.messages.map(message => message.content)).toEqual([
      [{ type: 'text', text: 'Tool grep not found' }],
      [{ type: 'text', text: REFUSAL }],
    ])
  })
})
