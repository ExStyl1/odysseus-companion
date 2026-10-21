import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import { SourceAvatar } from '../source-avatar'
import { SkillAvatar } from '../skill-avatar'

function capability(
  kind: 'source' | 'skill',
  iconUrl?: string,
): SafeCapabilitySummary {
  return {
    key: `${kind}:workspace:ws-1:item`,
    kind,
    logicalName: 'item',
    ...(iconUrl ? { iconUrl } : {}),
    origin: 'native',
    scope: { kind: 'workspace', workspaceId: 'ws-1' },
    state: 'active',
    readOnly: false,
    trustState: 'not-required',
    credentialState: 'not-required',
    selectedAsUnqualifiedAlias: true,
    diagnosticCodes: [],
  }
}

describe('capability avatars', () => {
  it('renders the opaque iconUrl supplied by the safe capability snapshot', () => {
    const iconUrl = 'data:image/png;base64,aWNvbg=='
    const sourceHtml = renderToStaticMarkup(<SourceAvatar source={capability('source', iconUrl)} />)
    const skillHtml = renderToStaticMarkup(<SkillAvatar skill={capability('skill', iconUrl)} />)

    expect(sourceHtml).toContain('src="data:image/png;base64,aWNvbg=="')
    expect(skillHtml).toContain('src="data:image/png;base64,aWNvbg=="')
  })

  it('keeps the existing fallback when no pinned icon exists', () => {
    const sourceHtml = renderToStaticMarkup(<SourceAvatar source={capability('source')} />)
    const skillHtml = renderToStaticMarkup(<SkillAvatar skill={capability('skill')} />)

    expect(sourceHtml).not.toContain('data:image/')
    expect(skillHtml).not.toContain('data:image/')
  })
})
