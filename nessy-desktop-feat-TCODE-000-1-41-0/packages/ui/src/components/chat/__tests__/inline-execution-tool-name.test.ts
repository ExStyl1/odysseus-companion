/**
 * The inline execution label splits on the same real boundary as the turn card.
 *
 * `mapToolEventToActivity` built its label by stripping `/^mcp__[^_]+__/` and
 * then title-casing what was left. `[^_]+` stops at the FIRST underscore, so the
 * strip missed the same two shapes `TurnCard` missed — and here the damage was
 * louder, because whatever survived the strip went through
 * `.replace(/_/g, ' ')` and came out as a title-cased sentence:
 *
 * - `mcp__my_server_v2__whoami` did not match the strip at all and rendered as
 *   `Mcp  My Server V2  Whoami`;
 * - the Codex bridge row `mcp__sources__<wire>__<tool>` matched at the wrong
 *   place and rendered the wire name as prose: `Plugin Cdp-Echo-Probe Echo
 *   Whoami`.
 *
 * Both call sites now share `parseMcpToolName` (see `../mcp-tool-name`), which
 * mirrors `resolveToolDisplayMeta` in server-core. The title-casing itself is
 * unchanged — only where the name is cut.
 */
import { describe, expect, it } from 'bun:test'
// Imported from the pure module rather than `../InlineExecution`, which
// re-exports this same function: importing the `.tsx` loads Markdown → react-pdf
// → `pdfjs-dist/build/pdf.worker.min.mjs?url`, and that module has no default
// export under `bun test`, so the whole file errors before a test runs.
import { mapToolEventToActivity } from '../inline-execution-helpers'

const label = (toolName: string): string =>
  mapToolEventToActivity(toolName, 'tool-use-1', 'running').name

describe('mapToolEventToActivity label', () => {
  it('keeps a simple MCP name working', () => {
    expect(label('mcp__t-tracker__list')).toBe('List')
  })

  it('cuts a wire name that contains single underscores', () => {
    expect(label('mcp__my_server_v2__whoami')).toBe('Whoami')
  })

  it('cuts past the codex sources bridge to the real tool', () => {
    expect(label('mcp__sources__plugin_cdp-echo-probe_echo__whoami')).toBe('Whoami')
  })

  it('cuts a hash fallback server name', () => {
    expect(label('mcp__server-ab518e32f3__whoami')).toBe('Whoami')
  })

  it('handles a degenerate sources shape', () => {
    expect(label('mcp__sources__x')).toBe('X')
  })

  it('title-cases a non-MCP name exactly as before', () => {
    expect(label('set_session_labels')).toBe('Set Session Labels')
    expect(label('Bash')).toBe('Bash')
    expect(label('TodoWrite')).toBe('TodoWrite')
  })

  it('carries the rest of the activity through untouched', () => {
    expect(mapToolEventToActivity('mcp__my_server_v2__whoami', 'tu-7', 'completed', 'note')).toEqual({
      id: 'tu-7',
      name: 'Whoami',
      status: 'completed',
      description: 'note',
    })
  })
})
