/**
 * UA9.3 — the source reconnect banner and the grant request dialog's row (spec §15, manifest G12; S25).
 *
 * Banner:
 * - positive: a source the page holds a grant on that needs authentication gets a row; when the host's pending-auth
 *   summary says the one-click OAuth flow applies (`canSignIn`, the gate the chat's PendingAuthNotice uses), "Reconnect"
 *   runs `performOAuth` for that source inline (a connector source carries its plugin-server target); "Reconnect in
 *   chat" hands off on every row; a running flow shows "Connecting" and a failed one says so on the row;
 * - negative: a row the host cannot sign in (a key or multi-field credential, `canSignIn` false, or no pending-auth row)
 *   offers only the chat hand-off — no Reconnect; the banner never routes to Sources by a bare source name (that route
 *   takes a capability key, and the source page has no reconnect for a workspace source); no credential input anywhere
 *   on the surface (no input element, no password field, no credential-saving call in its source); a connected source,
 *   a source the page holds no grant on, a disabled source and a non-source capability get no row; no grants → nothing.
 * Dialog row:
 * - positive: the host-validated descriptor renders as the authority — source and tool, method and path, script
 *   runtime, path, args and sha256;
 * - negative: a page `description` that contradicts the descriptor is shown only under the page-supplied label, and the
 *   descriptor fields still render in full beside it.
 *
 * Rendered with `renderToStaticMarkup` (this repo's `bun test` has no DOM); handlers are driven through the view's own
 * props (the view takes `t`, so it is hook-free). i18n is not initialised here, so labels render as their keys.
 */
import * as React from 'react'
import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import type { SafeWorkspacePendingAuth } from '@nessy-agent/shared/protocol'
import {
  PageSourceAuthBannerView,
  grantedSourceSlugs,
  pageSourceOAuthRequest,
  pageSourceSignInTargets,
  sourcesNeedingReconnect,
} from '../PageSourceAuthBanner'
import { PageGrantRequestRow } from '../PageGrantRequestDialog'

function source(logicalName: string, over: Partial<SafeCapabilitySummary> = {}): SafeCapabilitySummary {
  return {
    key: `source:${logicalName}`,
    kind: 'source',
    logicalName,
    displayName: logicalName.toUpperCase(),
    sourceType: 'api',
    origin: 'workspace',
    scope: { kind: 'workspace' },
    state: 'missing-credential',
    readOnly: false,
    trustState: 'trusted',
    credentialState: 'expired',
    selectedAsUnqualifiedAlias: false,
    diagnosticCodes: [],
    ...over,
  } as unknown as SafeCapabilitySummary
}

const grants = [
  { action: { kind: 'api' as const, sourceSlug: 'github', method: 'GET' as const, pathPattern: '/repos/.*' } },
  { action: { kind: 'mcp' as const, sourceSlug: 'linear', toolName: 'list_issues' } },
  { action: { kind: 'script' as const, script: 'pages/p/run.ts' } },
]

function pendingAuth(rows: Array<Partial<SafeWorkspacePendingAuth['sources'][number]> & { sourceSlug: string }>): SafeWorkspacePendingAuth {
  return {
    sources: rows.map(row => ({ workspaceId: 'ws', name: row.sourceSlug, reason: 'needs-auth' as const, canSignIn: true, ...row })),
    failedServers: [],
  }
}

type ViewRow = React.ReactElement<{ children: Array<React.ReactElement<{ onClick?: () => void; disabled?: boolean }> | false> }>

/** The view's rows, and each row's buttons, through the props the view wires to them. */
function rowsOf(view: React.ReactNode): ViewRow[] {
  return (view as React.ReactElement<{ children: React.ReactNode[] }>).props.children as unknown as ViewRow[]
}

describe('PageSourceAuthBanner — reconnect without a credential input', () => {
  it('positive: a granted source the host can sign in gets Reconnect, which runs OAuth for it inline', () => {
    const needing = sourcesNeedingReconnect(grants, [source('github'), source('linear', { kind: 'source', credentialState: 'ready', state: 'active' })])
    expect(needing.map(s => s.logicalName)).toEqual(['github'])
    const targets = pageSourceSignInTargets(pendingAuth([{ sourceSlug: 'github' }]))
    const reconnects: string[] = []
    const handoffs: string[] = []
    const view = PageSourceAuthBannerView({
      needing,
      signInTargets: targets,
      busySlug: null,
      errorSlug: null,
      onReconnect: s => reconnects.push(s.logicalName),
      onFixWithAgent: s => handoffs.push(s.logicalName),
      t: key => key,
    })
    const html = renderToStaticMarkup(<>{view}</>)
    expect(html).toContain('data-reconnect-source="github"')
    expect(html).toContain('pages.auth.sourceNeedsReconnect')
    expect(html).toContain('pages.auth.reconnect')
    expect(html).toContain('pages.auth.fixWithAgent')
    const [, , , agentButton, reconnectButton] = rowsOf(view)[0]!.props.children
    ;(reconnectButton as React.ReactElement<{ onClick: () => void }>).props.onClick()
    ;(agentButton as React.ReactElement<{ onClick: () => void }>).props.onClick()
    expect(reconnects).toEqual(['github'])
    expect(handoffs).toEqual(['github'])
    // What Reconnect hands to performOAuth: the workspace and the source's own slug — never a Sources route.
    expect(pageSourceOAuthRequest('ws', targets.get('github')!)).toEqual({ workspaceId: 'ws', sourceSlug: 'github' })
    // A connector-materialized source signs in through its plugin-server target, exactly as the chat notice does.
    const connector = pageSourceSignInTargets(pendingAuth([{ sourceSlug: 'linear', pluginServer: { pluginKey: 'p@m', serverName: 'linear' } }]))
    expect(pageSourceOAuthRequest('ws', connector.get('linear')!)).toEqual({
      workspaceId: 'ws',
      sourceSlug: 'linear',
      pluginServer: { pluginKey: 'p@m', serverName: 'linear' },
    })
  })

  it('positive: a running flow shows Connecting and disables the button; a failed one says so on the row', () => {
    const targets = pageSourceSignInTargets(pendingAuth([{ sourceSlug: 'github' }]))
    const busy = PageSourceAuthBannerView({
      needing: [source('github')], signInTargets: targets, busySlug: 'github', errorSlug: null,
      onReconnect: () => {}, onFixWithAgent: () => {}, t: key => key,
    })
    expect(renderToStaticMarkup(<>{busy}</>)).toContain('pendingAuth.connecting')
    const [, , , , reconnectButton] = rowsOf(busy)[0]!.props.children
    expect((reconnectButton as React.ReactElement<{ disabled: boolean }>).props.disabled).toBe(true)
    const failed = renderToStaticMarkup(
      <PageSourceAuthBannerView
        needing={[source('github')]} signInTargets={targets} busySlug={null} errorSlug="github"
        onReconnect={() => {}} onFixWithAgent={() => {}} t={key => key}
      />,
    )
    expect(failed).toContain('pendingAuth.error')
    expect(failed).not.toContain('pendingAuth.connecting')
  })

  it('negative: a source the host cannot sign in gets only the chat hand-off — no Reconnect', () => {
    // A key / multi-field credential (canSignIn false), and a source the summary does not list at all.
    const targets = pageSourceSignInTargets(pendingAuth([{ sourceSlug: 'github', canSignIn: false }]))
    expect(targets.size).toBe(0)
    expect(pageSourceSignInTargets(null).size).toBe(0)
    for (const signInTargets of [targets, pageSourceSignInTargets(pendingAuth([{ sourceSlug: 'jira' }]))]) {
      const html = renderToStaticMarkup(
        <PageSourceAuthBannerView
          needing={[source('github')]} signInTargets={signInTargets} busySlug={null} errorSlug={null}
          onReconnect={() => {}} onFixWithAgent={() => {}} t={key => key}
        />,
      )
      expect(html).toContain('pages.auth.fixWithAgent')
      expect(html).not.toContain('>pages.auth.reconnect<')
    }
    // Control: the same probe sees Reconnect when the host can sign the source in.
    expect(renderToStaticMarkup(
      <PageSourceAuthBannerView
        needing={[source('github')]} signInTargets={pageSourceSignInTargets(pendingAuth([{ sourceSlug: 'github' }]))}
        busySlug={null} errorSlug={null} onReconnect={() => {}} onFixWithAgent={() => {}} t={key => key}
      />,
    )).toContain('>pages.auth.reconnect<')
  })

  it('negative: no credential input and no Sources route — the rendered banner has no input, and its source takes no secret', () => {
    const html = renderToStaticMarkup(
      <PageSourceAuthBannerView
        needing={[source('github')]} signInTargets={pageSourceSignInTargets(pendingAuth([{ sourceSlug: 'github' }]))}
        busySlug={null} errorSlug={null} onReconnect={() => {}} onFixWithAgent={() => {}} t={key => key}
      />,
    )
    expect(html).not.toMatch(/<input|type="password"|<textarea/)
    const src = readFileSync(join(import.meta.dir, '..', 'PageSourceAuthBanner.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    // `routes.view.sources` takes a capability key; a bare source name lands on "failed to load".
    for (const needle of ['saveSourceCredentials', '<Input', 'type="password"', 'ReconnectCredentialDialog', 'routes.view.sources']) {
      expect(src).not.toContain(needle)
    }
    // Control: the same scanner finds a planted needle.
    expect(`${src}\nnavigate(routes.view.sources({ sourceSlug }))`).toContain('routes.view.sources')
  })

  it('negative: connected, ungranted, disabled and non-source capabilities get no row; no grants → nothing', () => {
    const sources = [
      source('github', { state: 'active', credentialState: 'ready' }), // connected
      source('jira'), // needs auth, but no grant on it
      source('linear', { state: 'disabled' }), // the user turned it off
      source('github-skill', { kind: 'skill' }),
    ]
    expect(sourcesNeedingReconnect(grants, sources)).toEqual([])
    expect(sourcesNeedingReconnect([], [source('github')])).toEqual([])
    expect(renderToStaticMarkup(<PageSourceAuthBannerView needing={[]} signInTargets={new Map()} busySlug={null} errorSlug={null} onReconnect={() => {}} onFixWithAgent={() => {}} t={key => key} />)).toBe('')
    // A script grant names no source.
    expect([...grantedSourceSlugs(grants)].sort()).toEqual(['github', 'linear'])
  })
})

describe('PageGrantRequestRow — the host descriptor is the authority', () => {
  const sha = 'ab'.repeat(32)

  it('positive: the host-validated fields render for each kind (a script with runtime, args and sha256)', () => {
    const script = renderToStaticMarkup(
      <PageGrantRequestRow entry={{ key: 'k', action: { kind: 'script', script: 'pages/p/run.ts', runtime: 'node', args: ['--once'] }, scriptSha256: sha }} />,
    )
    expect(script).toContain('script node pages/p/run.ts --once')
    expect(script).toContain(`sha256 ${sha}`)
    expect(script).toContain('pages.grants.scriptWarning')
    const api = renderToStaticMarkup(
      <PageGrantRequestRow entry={{ key: 'a', action: { kind: 'api', sourceSlug: 'github', method: 'POST', pathPattern: '/repos/x/issues' } }} />,
    )
    expect(api).toContain('api github · POST /repos/x/issues')
    const mcp = renderToStaticMarkup(<PageGrantRequestRow entry={{ key: 'm', action: { kind: 'mcp', sourceSlug: 'linear', toolName: 'create_issue' } }} />)
    expect(mcp).toContain('mcp linear · create_issue')
  })

  it('negative: a contradicting page description is labelled as the page\'s, and the descriptor still renders in full', () => {
    const html = renderToStaticMarkup(
      <PageGrantRequestRow
        entry={{
          key: 'k',
          description: 'Read-only: just shows your weather, nothing else',
          action: { kind: 'script', script: 'pages/p/wipe.sh', runtime: 'bun', args: ['--all'] },
          scriptSha256: sha,
        }}
      />,
    )
    expect(html).toContain('script bun pages/p/wipe.sh --all')
    expect(html).toContain(`sha256 ${sha}`)
    const supplied = html.match(/<div data-page-supplied="[^"]*"[^>]*>([\s\S]*?)<\/div>/)
    expect(supplied?.[1]).toContain('pages.grants.pageSupplied')
    expect(supplied?.[1]).toContain('Read-only: just shows your weather, nothing else')
    // The page's words appear only inside that labelled block, never as an authority line.
    const authority = [...html.matchAll(/<code data-grant-authority="[^"]*"[^>]*>([\s\S]*?)<\/code>/g)].map(m => m[1])
    expect(authority).toEqual(['script bun pages/p/wipe.sh --all', `sha256 ${sha}`])
    expect(html.split('Read-only: just shows your weather').length - 1).toBe(1)
  })
})
