import { describe, expect, test } from 'bun:test'
import {
  listMcpPromptCommands,
  mcpPromptCommandId,
  mcpPromptCommandName,
  mcpPromptCommandLabel,
  parseQuotedArgs,
  mapMcpPromptArguments,
  renderMcpPromptResult,
  normalizeMcpNameSegment,
} from './custom-commands.ts'

describe('MCP prompt command discovery', () => {
  test('a prompt-advertising server produces /mcp__slug__prompt', () => {
    const commands = listMcpPromptCommands([
      { server: 'jira', name: 'create_issue', description: 'Open a Jira issue', argumentNames: ['title', 'priority'] },
    ])
    expect(commands).toEqual([
      {
        id: mcpPromptCommandId('jira', 'create_issue'),
        name: 'mcp__jira__create_issue',
        label: '/mcp__jira__create_issue',
        description: 'Open a Jira issue',
      },
    ])
  })

  test('a server with no prompts produces no commands', () => {
    expect(listMcpPromptCommands([])).toEqual([])
  })

  test('server and prompt names normalise spaces to underscores', () => {
    expect(normalizeMcpNameSegment('my server')).toBe('my_server')
    expect(mcpPromptCommandName('my server', 'file summary')).toBe('mcp__my_server__file_summary')
    expect(mcpPromptCommandLabel('my server', 'file summary')).toBe('/mcp__my_server__file_summary')
  })
})

describe('quote-aware argument parsing', () => {
  test('groups a quoted run into a single token', () => {
    expect(parseQuotedArgs('foo "a b" c')).toEqual(['foo', 'a b', 'c'])
    expect(parseQuotedArgs('"Bug in login flow" high')).toEqual(['Bug in login flow', 'high'])
  })

  test('maps positional tokens onto declared parameters', () => {
    expect(mapMcpPromptArguments(['title', 'priority'], '"Bug in login flow" high')).toEqual({
      title: 'Bug in login flow',
      priority: 'high',
    })
    // Extra tokens beyond the declared parameters are dropped; missing ones omitted.
    expect(mapMcpPromptArguments(['only'], 'a b c')).toEqual({ only: 'a' })
    expect(mapMcpPromptArguments(['a', 'b'], 'x')).toEqual({ a: 'x' })
  })
})

describe('prompt result injection', () => {
  test('flattens returned messages into the injected turn body', () => {
    const body = renderMcpPromptResult([
      { role: 'user', content: { type: 'text', text: 'First line' } },
      { role: 'assistant', content: 'Second line' },
    ])
    expect(body).toBe('First line\n\nSecond line')
  })

  test('notes non-text content instead of dropping the message', () => {
    const body = renderMcpPromptResult([
      { role: 'user', content: { type: 'image', mimeType: 'image/png' } },
    ])
    expect(body).toContain('image image/png')
  })
})
