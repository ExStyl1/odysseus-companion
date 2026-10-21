import { describe, expect, it, mock } from 'bun:test'

// EditPopover imports ChatDisplay, which transitively pulls the composer's
// pdf.js worker (`?url`) import that Bun can't parse headless. The config
// accessor under test is pure data (EDIT_CONFIGS), so cut the heavy render
// subtree by stubbing ChatDisplay before importing EditPopover.
mock.module('../../app-shell/ChatDisplay', () => ({ ChatDisplay: () => null }))
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
mock.module('react-pdf', () => ({ Document: () => null, Page: () => null, pdfjs: { GlobalWorkerOptions: { workerSrc: '' } } }))

if (typeof (globalThis as any).DOMMatrix === 'undefined') {
  (globalThis as any).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    m11 = 1; m12 = 0; m13 = 0; m14 = 0
    m21 = 0; m22 = 1; m23 = 0; m24 = 0
    m31 = 0; m32 = 0; m33 = 1; m34 = 0
    m41 = 0; m42 = 0; m43 = 0; m44 = 1
    is2D = true
  }
}

const { getAddSourceEditConfig, getAddSkillEditConfig } = await import('../EditPopover')

describe('EditPopover managed creation flows', () => {
  it('routes skill creation through the hidden managed popover session', () => {
    const config = getAddSkillEditConfig('ws-1')

    expect(config.managedResource).toEqual({
      resource: { scope: 'workspace', workspaceId: 'ws-1', kind: 'skills-root' },
      contextKey: 'add-skill',
      label: 'Add Skill',
    })
    expect(config.inlineExecution).toBe(true)
    expect(config.model).toBe('default')
    expect(config.systemPromptPreset).toBe('default')
    expect('context' in config).toBe(false)
  })

  it('routes every source creation variant through the hidden managed popover session', () => {
    for (const contextKey of [
      'add-source',
      'add-source-api',
      'add-source-mcp',
      'add-source-local',
    ] as const) {
      const config = getAddSourceEditConfig(contextKey, 'ws-1')

      expect(config.managedResource).toMatchObject({
        resource: { scope: 'workspace', workspaceId: 'ws-1', kind: 'sources-root' },
        contextKey,
      })
      expect(config.inlineExecution).toBe(true)
      expect(config.model).toBe('default')
      expect(config.systemPromptPreset).toBe('default')
      expect('context' in config).toBe(false)
    }
  })
})
