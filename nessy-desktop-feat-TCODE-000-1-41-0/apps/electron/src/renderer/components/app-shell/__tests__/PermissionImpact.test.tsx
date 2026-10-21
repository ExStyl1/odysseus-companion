/**
 * U-A row 1 — the permission card must state the impact it was given.
 *
 * `PromptInfo.impact` is computed by the sandbox-escape band
 * (`pre-tool-use.ts`, "Runs outside the sandbox: matched the administrator's
 * excludedCommands pattern …"), travels the wire, is emitted by both backends
 * and persisted with the durable approval — but only the admin_approval card
 * ever rendered it, so an ordinary Bash prompt asked a human to approve a
 * command that leaves isolation without saying so.
 *
 * The impact must be rendered for ordinary prompts, visually separated from
 * the description (it outranks it), and ABOVE the command preview so a long
 * command cannot push it out of view at the moment of the click.
 *
 * UB12.84 — "visually separated" is checked against the stylesheet's own
 * vocabulary, not against class names. The block spelled `border-warning/30
 * bg-warning/10 text-warning` and this file asserted those names, but
 * tokens.css defines no warning colour, so the classes generated no CSS and the
 * block drew as untinted body text while this file stayed green. The impact
 * block and the publish card's access line now take v0.15.1's amber "needs you"
 * role (`bg-info-tint`, the `--info-border` inset hairline, `text-info`), and
 * every colour class on them must name a colour role tokens.css defines
 * (`--color-<role>`, or `--text-color-<role>` for text). The role list is READ
 * from tokens.css, so the needle set is the stylesheet's, not a copy.
 *
 * UB12.97 lifted that instrument into the renderer-wide census
 * (`renderer/__tests__/colour-role-census.ts`), which asks Tailwind's own
 * compiler, loaded on `renderer/index.css`, whether a class generates CSS —
 * so the namespaces (`--border-color-*` and the rest), the type scale and the
 * default palette are read by construction instead of from hand lists. This
 * file reads its `unresolved` through that one instrument.
 */

import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PermissionRequest as PermissionRequestType } from '../../../../shared/types'
import { PermissionRequest } from '../input/structured/PermissionRequest'
import type { ArtifactPublishCardData } from '../input/structured/artifact-publish-card'
import { COLOUR_CENSUS_HOOK_BUDGET_MS, loadColourVocabulary, type ColourVocabulary } from '../../../__tests__/colour-role-census'

const translations = {
  'chat.permissionImpact': 'Impact',
  'chat.permissionRequired': 'Permission required',
  'chat.permissionRemember.repository': '"Always Allow" saves this command for the repository',
}

const SANDBOX_ESCAPE_IMPACT =
  'Runs outside the sandbox: matched the administrator\'s excludedCommands pattern "rsync".'

let testI18n: I18nInstance
/** UB12.97 — the renderer's colour vocabulary: Tailwind's compiler on `renderer/index.css`. */
let vocabulary: ColourVocabulary

beforeAll(async () => {
  vocabulary = await loadColourVocabulary()
}, COLOUR_CENSUS_HOOK_BUDGET_MS)

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n
    .use(initReactI18next)
    .init({
      lng: 'en',
      fallbackLng: 'en',
      resources: { en: { translation: translations } },
      interpolation: { escapeValue: false },
    })
})

function render(request: PermissionRequestType): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <PermissionRequest request={request} onResponse={() => {}} />
    </I18nextProvider>
  )
}

// ---------------------------------------------------------------------------
// UB12.84 — every colour class must generate CSS. UB12.97 moved the instrument
// into the renderer census; this is its `unresolved`, under the name this file
// has always asserted with.
// ---------------------------------------------------------------------------

/** The classes in `classAttr` that name a colour role the stylesheet does not define — classes that generate no CSS. */
function unresolvedColourClasses(classAttr: string): string[] {
  return vocabulary.unresolved(classAttr)
}

/** Every class attribute in a rendered markup, joined (the whole card's class vocabulary). */
function allClasses(html: string): string {
  return [...html.matchAll(/ class="([^"]*)"/g)].map(match => match[1]).join(' ')
}

/** The class attribute of the element carrying `data-testid="<testId>"`. */
function classOf(html: string, testId: string): string {
  const match = new RegExp(`<div class="([^"]*)" data-testid="${testId}">`).exec(html)
  expect(match).not.toBeNull()
  return match![1]!
}

/** The amber "needs you" material both blocks take (v0.15.1 `Info_Alert` variant="info"). */
const NEEDS_YOU = ['bg-info-tint', 'text-info', 'inset-ring', 'inset-ring-[var(--info-border)]'] as const
/** What the two blocks spelled until UB12.84, verbatim from HEAD. */
const HEAD_IMPACT = 'mt-2.5 flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-label text-warning [&_svg]:size-3.5 [&_svg]:shrink-0'
const HEAD_ACCESS = 'flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-warning [&_svg]:size-3.5 [&_svg]:shrink-0'

function publishCard(): ArtifactPublishCardData {
  return {
    mode: 'create',
    sourcePath: 'report.html',
    contentType: 'html',
    title: 'Q3 report',
    emoji: '📊',
    byteLength: 120,
    lineCount: 4,
    sha256: 'abcdef0123456789'.repeat(4),
    serviceOrigin: 'https://t-artifacts.t-tech.team',
    expiresAt: '2026-10-09T12:00:00.000Z',
    retentionDays: 7,
    previewContent: '<h1>Q3</h1>',
    previewTruncated: false,
    sourceHead: '<h1>Q3</h1>',
    scriptCount: 0,
    externalHosts: [],
    scanSentence: 'Automatic check found no known token formats.',
    emailCount: 0,
    phoneCount: 0,
  }
}

function impactRequest(): PermissionRequestType {
  return {
    requestId: 'perm-impact-1',
    toolName: 'Bash',
    command: 'rsync -a ./dist/ deploy@staging:/srv/app/',
    description: 'Run a shell command',
    type: 'bash',
    impact: SANDBOX_ESCAPE_IMPACT,
  } as PermissionRequestType
}

function publishRequest(): PermissionRequestType {
  return {
    sessionId: 'session-a',
    requestId: 'publish-artifact-1',
    toolName: 'publish_artifact',
    description: 'Publish "Q3 report" (report.html) on https://t-artifacts.t-tech.team.',
    origin: 'host_gate',
    noAlwaysAllow: true,
    artifactPublish: publishCard(),
  } as PermissionRequestType
}

describe('permission request impact rendering', () => {
  it('renders the sandbox-escape impact on an ordinary bash prompt, set apart and above the command', () => {
    const html = render(impactRequest())

    // Present at all — the defect was that it never reached the human.
    expect(html).toContain('Runs outside the sandbox')
    expect(html).toContain('excludedCommands')
    expect(html).toContain('Impact')

    // Visually distinct from the description, not more body text: its own
    // toned block (UB12.84: the amber "needs you" role, on classes that exist).
    const impact = classOf(html, 'permission-impact')
    for (const cls of NEEDS_YOU) expect(impact.split(' ')).toContain(cls)
    expect(unresolvedColourClasses(impact)).toEqual([])
    expect(html.indexOf('data-testid="permission-impact"')).toBeLessThan(html.indexOf('Runs outside the sandbox'))

    // Above the command preview, which scrolls inside its own box.
    expect(html.indexOf('Runs outside the sandbox')).toBeLessThan(html.indexOf('rsync -a ./dist/'))
  })

  it('renders no impact block when the prompt carries none', () => {
    const html = render({
      requestId: 'perm-plain-1',
      toolName: 'Bash',
      command: 'ls -la',
      description: 'Execute: ls -la',
      type: 'bash',
    } as PermissionRequestType)

    expect(html).toContain('Permission required')
    expect(html).not.toContain('Impact')
    expect(html).not.toContain('data-testid="permission-impact"')
  })
})

describe('UB12.84 — the impact block and the publish access line are toned with colours tokens.css defines', () => {
  it('POSITIVE — both blocks take the info tint, its inset hairline and the solved info ink, and every colour class on either card resolves', () => {
    const impactHtml = render(impactRequest())
    const publishHtml = render(publishRequest())

    const access = classOf(publishHtml, 'artifact-publish-access')
    for (const cls of NEEDS_YOU) expect(access.split(' ')).toContain(cls)
    expect(unresolvedColourClasses(access)).toEqual([])
    expect(publishHtml).toContain('chat.artifactPublish.access')

    // The whole of both cards: no colour class anywhere on them names a role the stylesheet lacks.
    expect({ impactCard: unresolvedColourClasses(allClasses(impactHtml)), publishCard: unresolvedColourClasses(allClasses(publishHtml)) })
      .toEqual({ impactCard: [], publishCard: [] })
  })

  it('NEGATIVE (control) — the HEAD spelling of both blocks names three classes tokens.css cannot resolve', () => {
    // The instrument reads the stylesheet: the info role, its tint and the label step are defined, warning is not.
    expect(['bg-info', 'bg-info-tint', 'text-info', 'text-label'].map(cls => vocabulary.resolves(cls))).toEqual([true, true, true, true])
    expect(['bg-warning', 'text-warning', 'border-warning'].map(cls => vocabulary.resolves(cls))).toEqual([false, false, false])

    expect(unresolvedColourClasses(HEAD_IMPACT)).toEqual(['border-warning/30', 'bg-warning/10', 'text-warning'])
    expect(unresolvedColourClasses(HEAD_ACCESS)).toEqual(['border-warning/30', 'bg-warning/10', 'text-warning'])
    // A single planted class is caught on its own, a variant prefix included.
    expect(unresolvedColourClasses('text-label text-info hover:bg-warning')).toEqual(['hover:bg-warning'])
    // BOUNDARY — names that DO generate CSS are not flagged: a role defined only in a utility namespace
    // (`--border-color-default`), sides and widths, the ring offset, Tailwind's default type scale and palette.
    // (The palette class is spelled in parts so nessy-styles/no-raw-palette-colors does not read this needle as a use.)
    expect(unresolvedColourClasses(['border-default', ['bg', 'red', '500'].join('-')].join(' '))).toEqual([])
    expect(unresolvedColourClasses('border border-default border-l-2 border-t ring-1 ring-offset-2 ring-offset-paper text-sm text-label-sm border-separator/60')).toEqual([])
  })
})
