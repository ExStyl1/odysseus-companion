import { beforeAll, describe, expect, it, mock } from 'bun:test'

import type { AvailableSlashCommand } from '../../../../shared/types'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

let createNessySlashSections: typeof import('../slash-command-menu').createNessySlashSections
let createInlineSlashSections: typeof import('../slash-command-menu').createInlineSlashSections

beforeAll(async () => {
  const mod = await import('../slash-command-menu')
  createNessySlashSections = mod.createNessySlashSections
  createInlineSlashSections = mod.createInlineSlashSections
})

describe('createNessySlashSections', () => {
  it('uses provider-advertised commands when available', () => {
    const commands: AvailableSlashCommand[] = [
      { name: 'status', description: 'Show version info' },
      { name: '/compress', description: 'Compress context', input: { hint: '[instructions]' } },
    ]

    const sections = createNessySlashSections({ availableCommands: commands, enabled: true })
    const nessySection = sections.find(section => section.id === 'nessy-commands')

    expect(nessySection?.label).toBe('Commands')
    expect(nessySection?.labelKey).toBe('commands.title')
    expect(nessySection?.items.map(item => item.label)).toEqual(['/status', '/compress'])
    expect(nessySection?.items[1]).toMatchObject({
      id: 'nessy:compress',
      description: 'Compress context',
      insertText: '/compress ',
    })
  })

  it('falls back to common Nessy commands before provider data arrives', () => {
    const sections = createNessySlashSections({ enabled: true })
    const labels = sections.flatMap(section => section.items.map(item => item.label))

    expect(labels).toContain('/status')
    expect(labels).toContain('/tasks')
    expect(labels).toContain('/compress')
    expect(labels).not.toContain('/skills')
  })

  it('hides Nessy commands that cannot execute reliably', () => {
    const sections = createNessySlashSections({
      availableCommands: [
        { name: 'model', description: 'Switch model' },
        { name: 'skills', description: 'List skills' },
        { name: 'status', description: 'Show status' },
      ],
      availableSkills: ['model', 'skills', 'commit'],
      enabled: true,
    })
    const labels = sections.flatMap(section => section.items.map(item => item.label))

    expect(labels).toEqual(['/status', '/commit'])
  })

  it('adds skills as slash commands without duplicating command names', () => {
    const sections = createNessySlashSections({
      availableCommands: [{ name: 'review', description: 'Review code' }],
      availableSkills: ['review', 'commit'],
      enabled: true,
    })

    expect(sections.map(section => section.id)).toEqual(['nessy-commands'])
    expect(sections[0]?.items.map(item => item.label)).toEqual(['/review', '/commit'])
    expect(sections[0]?.items[1]).toMatchObject({
      id: 'nessy-skill:commit',
      insertText: '/commit ',
    })
  })

  it('returns no sections when disabled', () => {
    expect(createNessySlashSections({ enabled: false })).toEqual([])
  })
})

describe('createInlineSlashSections', () => {
  it('does not include mode or app command sections', () => {
    const sections = createInlineSlashSections({
      availableCommands: [{ name: 'status', description: 'Show status' }],
      enableNessyCommands: true,
    })

    expect(sections.map(section => section.id)).toEqual(['nessy-commands'])
    expect(sections[0]?.label).toBe('Commands')
    expect(sections[0]?.labelKey).toBe('commands.title')
  })

  it('keeps recent folders as the only non-command inline section', () => {
    const sections = createInlineSlashSections({
      availableCommands: [{ name: 'status', description: 'Show status' }],
      enableNessyCommands: true,
      recentFolders: ['/Users/me/zeta', '/Users/me/alpha'],
      homeDir: '/Users/me',
    })

    expect(sections.map(section => section.id)).toEqual(['nessy-commands', 'folders'])
    expect(sections[1]?.items.map(item => item.label)).toEqual(['alpha', 'zeta'])
  })
})
