/**
 * D2 consent surface — presentational report rows.
 *
 * Verifies the per-item rows the ProjectTrustDialog renders on open, and the
 * empty/absent case (report empty or unavailable → renders NOTHING, so the
 * dialog stays exactly as it was before detection existed).
 */

import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProjectContributionReport } from '@nessy-agent/shared/protocol/capabilities'
import { ProjectContributionsList } from '../ProjectContributionsList'

const RESOURCES: Record<string, string> = {
  'projectTrust.provides.title': 'This project provides',
  'projectTrust.provides.more': '+{{n}} more',
  'projectTrust.provides.mcpServers_one': '{{count}} MCP server',
  'projectTrust.provides.mcpServers_other': '{{count}} MCP servers',
  'projectTrust.provides.instructions_one': '{{count}} instruction file',
  'projectTrust.provides.instructions_other': '{{count}} instruction files',
  'projectTrust.provides.skills_one': '{{count}} skill',
  'projectTrust.provides.skills_other': '{{count}} skills',
}

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: RESOURCES } },
    interpolation: { escapeValue: false },
  })
})

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(<I18nextProvider i18n={testI18n}>{node}</I18nextProvider>)
}

const report: ProjectContributionReport = {
  items: [
    { itemType: 'AGENTS_MD', count: 1, names: ['AGENTS.md'], sourceLabel: 'project instructions' },
    { itemType: 'MCP_SERVER_CONFIG', count: 2, names: ['files', 'remote'], sourceLabel: 'project .mcp.json' },
    {
      itemType: 'SKILLS',
      count: 25,
      names: Array.from({ length: 20 }, (_, i) => `skill-${i}`),
      truncated: true,
      sourceLabel: '.nessy-agent/skills',
    },
  ],
}

describe('ProjectContributionsList', () => {
  it('renders a per-item row with pluralized counts, names, and source labels', () => {
    const html = render(<ProjectContributionsList report={report} />)
    expect(html).toContain('This project provides')
    expect(html).toContain('data-testid="project-contributions"')
    // Pluralization: singular vs plural resolves from count.
    expect(html).toContain('1 instruction file')
    expect(html).toContain('2 MCP servers')
    expect(html).toContain('25 skills')
    // Names + path-free source labels are surfaced verbatim.
    expect(html).toContain('files, remote')
    expect(html).toContain('project .mcp.json')
    expect(html).toContain('.nessy-agent/skills')
    // One row per detected item type.
    expect(html).toContain('data-testid="contribution-AGENTS_MD"')
    expect(html).toContain('data-testid="contribution-MCP_SERVER_CONFIG"')
    expect(html).toContain('data-testid="contribution-SKILLS"')
  })

  it('shows a "+N more" remainder only when names are truncated below count', () => {
    const html = render(<ProjectContributionsList report={report} />)
    // 25 skills, 20 names surfaced → +5 more.
    expect(html).toContain('+5 more')
  })

  it('renders nothing for an empty report', () => {
    expect(render(<ProjectContributionsList report={{ items: [] }} />)).toBe('')
  })

  it('renders nothing when the report is unavailable (fail-soft)', () => {
    expect(render(<ProjectContributionsList report={null} />)).toBe('')
    expect(render(<ProjectContributionsList report={undefined} />)).toBe('')
  })
})
