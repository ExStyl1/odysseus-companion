/**
 * UB4.18 (B5-04; upstream v0.15.1 `browser-tool-runtime.ts`) — screenshot
 * metadata as compact lines, not a pretty-printed JSON dump.
 *
 * At HEAD both screenshot arms appended `'Metadata:', JSON.stringify(metadata,
 * null, 2)`; an annotated capture carries up to 100 targets and the block cost
 * ~15k tokens. The port formats one short line per known field and caps the
 * listed targets at 50 with a "…N more targets" tail; browser-pane-manager now
 * annotates ON-SCREEN elements only (its half of the row).
 *
 * Instrument: the `createBrowserTools` mock-fns harness `browser-tools.test.ts`
 * already uses — the metadata crosses RPC as a plain record, so a stubbed
 * `screenshot`/`screenshotRegion` return drives the real formatting code.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { createBrowserTools, type BrowserPaneFns } from '../browser-tools'

function findTool(tools: ReturnType<typeof createBrowserTools>, name: string) {
  return tools.find((t: { name: string }) => t.name === name)
}

async function executeTool(tools: ReturnType<typeof createBrowserTools>, name: string, args: Record<string, unknown> = {}) {
  const t = findTool(tools, name) as unknown as { handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> } | undefined
  if (!t) throw new Error(`Tool "${name}" not found`)
  const result = await t.handler(args)
  const text = result.content[0]?.text
  if (typeof text !== 'string') throw new Error('tool returned no text block')
  return { text }
}

function target(i: number) {
  return {
    ref: `@e${i}`,
    role: 'button',
    name: `Target ${i}`,
    box: { x: 10, y: i * 30, width: 120, height: 24 },
    clickPoint: { x: 70, y: i * 30 + 12 },
  }
}

const HUNDRED_TARGETS = {
  viewport: { width: 1280, height: 800, dpr: 2 },
  targets: Array.from({ length: 100 }, (_, i) => target(i)),
  action: { tool: 'click', ref: '@e3', status: 'ok', timestamp: 1760000000000 },
  warnings: ['Annotation capped at 100 of 240 on-screen elements'],
  annotationPartial: true,
}

let mockFns: BrowserPaneFns
let tools: ReturnType<typeof createBrowserTools>

describe('UB4.18 · screenshot metadata as compact lines', () => {
  beforeEach(() => {
    mockFns = {
      screenshot: async () => ({
        imageBuffer: Buffer.from('fake-png-data'),
        imageFormat: 'png' as const,
        metadata: HUNDRED_TARGETS,
      }),
      screenshotRegion: async () => ({
        imageBuffer: Buffer.from('fake-png-data'),
        imageFormat: 'png' as const,
        metadata: HUNDRED_TARGETS,
      }),
    } as unknown as BrowserPaneFns
    tools = createBrowserTools({
      sessionId: 'test-session',
      getBrowserPaneFns: () => mockFns,
    })
  })

  it('THE ROW: 100 targets render as at most 50 target lines plus the "more" tail', async () => {
    const result = await executeTool(tools, 'browser_tool', { command: 'screenshot --annotated' })
    const text = result.text

    expect(text).toContain('Annotated targets: 100')
    expect(text).toContain('@e49 button "Target 49" at (70,1482) 120x24')
    expect(text).not.toContain('@e50 button')
    expect(text).toContain('…50 more targets (use snapshot or find)')
    expect(text).toContain('Viewport: 1280x800 @ DPR 2')
    expect(text).toContain('Warning: Annotation capped at 100 of 240 on-screen elements')
    expect(text).toContain('Annotation incomplete')
    expect(text).toContain('Last action: click @e3 ok at 2025-10-09')
  })

  it('CONTROL: no screenshot output carries the pretty-printed Metadata: JSON block any more', async () => {
    for (const command of ['screenshot', 'screenshot --annotated', 'screenshot-region 0 0 100 100']) {
      const result = await executeTool(tools, 'browser_tool', { command })
      const text = result.text
      expect(text).not.toContain('Metadata:')
      expect(text).not.toContain('"viewport"')
      expect(text).not.toContain('"clickPoint"')
    }
  })

  it('a metadata-less capture renders no metadata lines at all', async () => {
    mockFns.screenshot = async () => ({
      imageBuffer: Buffer.from('fake-png-data'),
      imageFormat: 'png' as const,
    }) as never
    const result = await executeTool(tools, 'browser_tool', { command: 'screenshot' })
    expect(result.text).not.toContain('Annotated targets')
    expect(result.text).not.toContain('Viewport:')
  })
})
