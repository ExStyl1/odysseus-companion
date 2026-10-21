import { describe, expect, it } from 'bun:test'
import { formatMcpToolName, parseMcpArguments } from '../mcp-permission'

describe('formatMcpToolName', () => {
  it('turns the mcp tool id into server/tool', () => {
    expect(formatMcpToolName('mcp__dpWiki__get_page')).toBe('dpWiki/get_page')
  })

  it('keeps non-mcp tool names untouched', () => {
    expect(formatMcpToolName('Bash')).toBe('Bash')
    expect(formatMcpToolName('my__fancy_tool')).toBe('my__fancy_tool')
  })

  it('splits off the server prefix only', () => {
    expect(formatMcpToolName('mcp__jetbrains__get_file__text')).toBe(
      'jetbrains/get_file__text',
    )
  })
})

describe('parseMcpArguments', () => {
  it('returns compact and pretty forms of the arguments', () => {
    const args = parseMcpArguments('{"page_id":"123","include_children":true}')

    expect(args?.compact).toBe('{"page_id":"123","include_children":true}')
    expect(args?.pretty).toBe(
      '{\n  "page_id": "123",\n  "include_children": true\n}',
    )
  })

  it('indents nested structures with two spaces', () => {
    const args = parseMcpArguments('{"filters":{"status":["draft","published"]}}')

    expect(args?.pretty).toBe(
      [
        '{',
        '  "filters": {',
        '    "status": [',
        '      "draft",',
        '      "published"',
        '    ]',
        '  }',
        '}',
      ].join('\n'),
    )
  })

  it('returns null for missing, empty or non-JSON descriptions', () => {
    expect(parseMcpArguments(undefined)).toBeNull()
    expect(parseMcpArguments('   ')).toBeNull()
    expect(parseMcpArguments('Execute: ls -la')).toBeNull()
    expect(parseMcpArguments('"just a string"')).toBeNull()
  })

  it('returns null when there are no arguments to preview', () => {
    expect(parseMcpArguments('{}')).toBeNull()
    expect(parseMcpArguments('[]')).toBeNull()
  })
})
