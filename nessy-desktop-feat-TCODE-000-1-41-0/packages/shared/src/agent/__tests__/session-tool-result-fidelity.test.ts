/**
 * P6.345 — the claude half of the shared tool-result contract.
 *
 * Two of the three symptoms the row names are decided in `convertResult`, which
 * used to return text and nothing else:
 *
 *  - a host tool's `structuredContent` record was DROPPED on the claude path
 *    while the codex path forwarded it live
 *    (`session-mcp-server/src/codex-reply-fidelity.test.ts`), so the same tool
 *    answered two different models two different things;
 *  - a non-text block could not be expressed at all, which is why
 *    `browser-tools.ts` declares its own result type outside the registry.
 *
 * Native mechanism, confirmed at HEAD rather than re-derived: the SDK's
 * `tool()` handler returns MCP's own `CallToolResult`
 * (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:7834`), which carries
 * both. Nothing needed building on the runtime side.
 */
import { describe, expect, it } from 'bun:test'
import { convertResult } from '../session-scoped-tools'
import type { ToolResult } from '@nessy-agent/session-tools-core'

describe('P6.345 — structuredContent reaches a claude-runtime model', () => {
  it('forwards a record beside the text', () => {
    const result: ToolResult = {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { id: 'plan-1', status: 'created' },
    }
    expect(convertResult(result)).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { id: 'plan-1', status: 'created' },
    })
  })

  it('drops an EMPTY record rather than forwarding it', () => {
    // The same rule the codex boundary applies: a present-but-empty field makes
    // a codex client hand the model `{}` INSTEAD of the reply text, so `{}` is
    // never the neutral value and must not be minted here either.
    const converted = convertResult({ content: [{ type: 'text', text: 'ok' }], structuredContent: {} })
    expect('structuredContent' in converted).toBe(false)
  })

  it('a result that never had the field is untouched', () => {
    expect(convertResult({ content: [{ type: 'text', text: 'plain' }] })).toEqual({
      content: [{ type: 'text', text: 'plain' }],
    })
  })
})

describe('P6.345 — a registry tool can answer with an image or a resource', () => {
  it('appends an image block after the text blocks', () => {
    const converted = convertResult({
      content: [{ type: 'text', text: 'Screenshot taken' }],
      extraContent: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }],
    })
    expect(converted.content).toEqual([
      { type: 'text', text: 'Screenshot taken' },
      { type: 'image', data: 'aGk=', mimeType: 'image/png' },
    ])
  })

  it('appends a named resource', () => {
    const converted = convertResult({
      content: [{ type: 'text', text: 'Report ready' }],
      extraContent: [{ type: 'resource', resource: { uri: 'file:///r.md', mimeType: 'text/markdown', text: '# r' } }],
    })
    expect(converted.content).toHaveLength(2)
    expect((converted.content as Array<Record<string, unknown>>)[1]).toEqual({
      type: 'resource',
      resource: { uri: 'file:///r.md', mimeType: 'text/markdown', text: '# r' },
    })
  })

  it('order is text first — the API reads blocks in order and the text is the reply', () => {
    const converted = convertResult({
      content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
      extraContent: [{ type: 'image', data: 'x', mimeType: 'image/jpeg' }],
    })
    expect((converted.content as Array<{ type: string }>).map((c) => c.type)).toEqual(['text', 'text', 'image'])
  })

  it('isError still rides through with the blocks', () => {
    const converted = convertResult({
      content: [{ type: 'text', text: '[ERROR] no' }],
      isError: true,
    })
    expect(converted.isError).toBe(true)
  })
})
