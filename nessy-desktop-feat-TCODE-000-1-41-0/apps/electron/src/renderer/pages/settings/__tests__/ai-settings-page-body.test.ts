/**
 * UB15.11 — the AI page body on v0.15.1's material (R5-09b), with our runtime sections kept.
 *
 * v0.15.0 restyled `pages/settings/AiSettingsPage.tsx` hunk by hunk: the credential-health banner moved onto the
 * info tint with a `primary md` action that wraps under its text; the default-connection badge became a
 * `rounded-xs bg-fill-hover` chip and the duplicate-account icon `text-info`; the connection "⋯" became an
 * `IconButton` named `common.more`; each workspace override became ONE ROW (`EXPANDER_ROW_CLASS`, `aria-expanded`,
 * an `AnimatedCollapsibleContent` body) inside ONE shared `SettingsCard`; Add connection and the RTK
 * update/get/recheck buttons became `secondary md`; the RTK meter scales on X and its refresh is an `IconButton`;
 * the setup overlay sits on `bg-navigator` with a named `Button` close. Ours keeps the Nessy gateway rows and their
 * Reconnect, the runtime connection labels, the BYO edit target, the managed-model refusal, the guardian / advisor /
 * codex sections, the output style and the mid-stream hint.
 *
 * SOURCE MATCH, for the reason `ai-settings-reconnect.test.ts` gives: `bun test` has no DOM here, and the page
 * needs the app-shell context and `window.electronAPI` past its first render. Assertions read the page's CODE
 * (comments stripped), so a comment quoting a forbidden shape cannot pass or fail an arm.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'

const read = (file: string) => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8')

/** Comments quote the shapes these assertions forbid; assert against CODE. */
function codeOf(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const PAGE = codeOf(read('AiSettingsPage.tsx'))
const CARD = codeOf(read('DecisionModelCard.tsx'))

const count = (text: string, needle: string | RegExp): number =>
  typeof needle === 'string' ? text.split(needle).length - 1 : (text.match(new RegExp(needle, 'g')) ?? []).length

/** The text of `function <name>(` up to the next top-level `function ` (or the end). */
function functionBody(code: string, name: string): string {
  const start = code.indexOf(`function ${name}(`)
  if (start === -1) return ''
  const next = code.indexOf('\nfunction ', start + 1)
  const nextExport = code.indexOf('\nexport default function ', start + 1)
  const ends = [next, nextExport].filter(at => at > start)
  return code.slice(start, ends.length ? Math.min(...ends) : undefined)
}

/** The workspace-override section: ONE SettingsCard around the whole list (v0.15.1). */
const ONE_CARD_FOR_ALL_WORKSPACES =
  /<SettingsCard>\s*\{workspaces\.map\(\(workspace\) => \(\s*<WorkspaceOverrideCard[\s\S]*?\)\)\}\s*<\/SettingsCard>/

/** Any trace of the `motion/react` height animation the expanders used until UB15.11. */
const MOTION_TRACES: ReadonlyArray<[string, RegExp]> = [
  ['motion/react import', /from\s+['"]motion\/react['"]/],
  ['AnimatePresence', /\bAnimatePresence\b/],
  ['motion.<element>', /\bmotion\.[a-z]+\b/],
]

/** The pre-redesign material the page and the decision card drew by hand (the 6 raw palette classes among them). */
const LEGACY_MATERIAL: ReadonlyArray<[string, RegExp]> = [
  ['amber palette', /\bamber-\d/],
  ['shadow-minimal', /\bshadow-minimal\b/],
  ['text-muted-foreground', /\btext-muted-foreground\b/],
  ['foreground alpha', /\b(?:text|bg|border)-foreground\/[\d[]/],
  ['arbitrary text size', /\btext-\[\d+px\]/],
  ['transition on all properties', /\btransition-all\b/],
  ['wrapDescription', /\bwrapDescription\b/],
  ['size="sm" Button', /<Button[^>]*\bsize="sm"/],
]

const legacyIn = (code: string) => LEGACY_MATERIAL.filter(([, needle]) => needle.test(code)).map(([name]) => name)

describe('UB15.11 · the workspace overrides are rows of ONE shared card', () => {
  it('POSITIVE — one SettingsCard wraps every workspace, and each override is an expander row with an in-place body', () => {
    expect(count(PAGE, ONE_CARD_FOR_ALL_WORKSPACES)).toBe(1)
    const row = functionBody(PAGE, 'WorkspaceOverrideCard')
    expect(row.length).toBeGreaterThan(0)
    expect(row).toContain('aria-expanded={isExpanded}')
    expect(row).toContain('className={EXPANDER_ROW_CLASS}')
    expect(row).toMatch(/<AnimatedCollapsibleContent isOpen=\{isExpanded\}>\s*<div className="border-t border-subtle py-1 pl-9">/)
    // The decision card's Advanced expander is the same row (v0.15.1 shares one constant between the two).
    expect(CARD).toContain('className={EXPANDER_ROW_CLASS}')
    expect(CARD).toMatch(/<AnimatedCollapsibleContent isOpen=\{advancedOpen\}>/)
  })

  it('NEGATIVE — a workspace row draws no card of its own, and no space-y list stands in for the card', () => {
    expect(functionBody(PAGE, 'WorkspaceOverrideCard')).not.toContain('<SettingsCard')
    expect(PAGE).not.toMatch(/<div className="space-y-2">\s*\{workspaces\.map/)
  })

  it('CONTROL — the card instrument refuses the shape HEAD drew before UB15.11 (a card per workspace in a space-y list)', () => {
    const before = [
      '<div className="space-y-2">',
      '  {workspaces.map((workspace) => (',
      '    <WorkspaceOverrideCard key={workspace.id} workspace={workspace} />',
      '  ))}',
      '</div>',
    ].join('\n')
    expect(count(before, ONE_CARD_FOR_ALL_WORKSPACES)).toBe(0)
    expect(functionBody('function WorkspaceOverrideCard() {\n  return (<SettingsCard><button /></SettingsCard>)\n}\n', 'WorkspaceOverrideCard'))
      .toContain('<SettingsCard')
  })
})

describe('UB15.11 · no motion/react, raw palette or pre-redesign material remains', () => {
  it('NEGATIVE — neither the page nor the decision card imports or draws motion/react', () => {
    for (const [file, code] of [['AiSettingsPage', PAGE], ['DecisionModelCard', CARD]] as const) {
      expect({ file, found: MOTION_TRACES.filter(([, needle]) => needle.test(code)).map(([name]) => name) })
        .toEqual({ file, found: [] })
    }
  })

  it('NEGATIVE — no entry of LEGACY_MATERIAL (raw palette, old shadow and inks, px text, all-property transitions, wrapDescription, sm Button) remains', () => {
    expect({ file: 'AiSettingsPage', legacy: legacyIn(PAGE) }).toEqual({ file: 'AiSettingsPage', legacy: [] })
    expect({ file: 'DecisionModelCard', legacy: legacyIn(CARD) }).toEqual({ file: 'DecisionModelCard', legacy: [] })
  })

  it('CONTROL — both instruments fire on the shapes HEAD drew before UB15.11', () => {
    const before = [
      "import { motion, AnimatePresence } from 'motion/react'",
      // eslint-disable-next-line nessy-styles/no-raw-palette-colors -- the planted pre-UB15.11 banner the CONTROL must catch
      '<div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 mb-6">',
      '<span className="inline-flex items-center h-5 px-2 text-[11px] font-medium rounded-[4px] bg-background shadow-minimal text-foreground/60">',
      '<span className="text-xs text-muted-foreground truncate">{oauthIdentityLine}</span>',
      // eslint-disable-next-line nessy-styles/no-motion-antipatterns -- the planted pre-UB15.11 meter the CONTROL must catch
      '<div className="h-full bg-foreground/60 transition-all" />',
      'description={getDescription()} wrapDescription',
      '<Button size="sm" onClick={onTest} disabled={testing} variant="secondary">',
      '<motion.div initial={{ height: 0, opacity: 0 }}>',
    ].join('\n')
    expect(MOTION_TRACES.filter(([, needle]) => needle.test(before)).map(([name]) => name))
      .toEqual(['motion/react import', 'AnimatePresence', 'motion.<element>'])
    expect(legacyIn(before)).toEqual(LEGACY_MATERIAL.map(([name]) => name))
  })
})

describe('UB15.11 · the v0.15.1 controls', () => {
  it('POSITIVE — banner, badge, "⋯", Add connection, RTK, overlay and its close take the v0.15.1 look', () => {
    // The credential-health banner: info tint, inset hairline, a primary md action that wraps under the text.
    expect(PAGE).toContain('<div className="rounded-lg bg-info-tint px-3.5 py-3 inset-ring inset-ring-[var(--info-border)]">')
    expect(PAGE).toMatch(/<Button\s+variant="primary"\s+size="md"\s+onClick=\{onReauthenticate\}\s*>/)
    // The default badge and the duplicate-account icon.
    expect(PAGE).toContain('rounded-xs bg-fill-hover px-1.5 text-label-sm font-medium text-secondary')
    expect(PAGE).toContain('<AlertTriangle className="size-3.5 text-info" />')
    // The row's "⋯" is a named IconButton that still carries the trigger's open state (rs-40 walks to button[data-state]).
    expect(PAGE).toMatch(/<IconButton\s+aria-label=\{t\("common\.more"\)\}\s+data-state=\{menuOpen \? 'open' : 'closed'\}/)
    expect(count(PAGE, '<Button variant="secondary" size="md" onClick={() => openApiSetup()}>')).toBe(1)
    // RTK: three secondary md buttons, the refresh IconButton, the X-scaled meter.
    expect(count(PAGE, /size="md"\s+onClick=\{(?:\(\) => setRtkDialogOpen\(true\)|handleGetRtk|handleRecheckRtk)\}[\s\S]{0,120}?variant="secondary"/)).toBe(3)
    expect(PAGE).toMatch(/<IconButton\s+size="sm"\s+onClick=\{refreshRtkGain\}\s+aria-label=\{t\("settings\.ai\.rtk\.gainRefresh"\)\}/)
    expect(PAGE).toContain('transform: `scaleX(')
    // The setup overlay and its named close.
    expect(PAGE).toContain('className="z-splash flex flex-col bg-navigator"')
    expect(PAGE).toMatch(/<Button\s+variant="secondary"\s+size="icon"\s+onClick=\{handleCloseApiSetup\}[\s\S]{0,120}?aria-label=\{t\("common\.closeEsc"\)\}/)
  })

  it('NEGATIVE — no unnamed hand-rolled "⋯", Add-connection or close button, and no width-animated meter', () => {
    expect(PAGE).not.toMatch(/<button\s+className="p-1\.5 rounded-md/)
    expect(PAGE).not.toMatch(/<button\s+onClick=\{\(\) => openApiSetup\(\)\}/)
    expect(PAGE).not.toMatch(/<button\s+onClick=\{handleCloseApiSetup\}/)
    expect(PAGE).not.toContain('width: `${Math.min(100')
    expect(PAGE).not.toContain('bg-foreground-2')
  })
})

describe('UB15.11 · KEEP — our runtime specifics survive the restyle', () => {
  it('BOUNDARY — gateway Reconnect, runtime labels, Nessy Backend, edit target, refusals, in-use holders and our sections', () => {
    for (const kept of [
      'const reconnectItem = computeGatewayReconnectItem(connection, reconnectPhase)',
      'useNessyGatewayAuth()',
      'toastGatewayReconnectFailure(result, t)',
      'runtimeConnectionLabel(conn)',
      "`${harness} (Nessy Gateway)`",
      "'Nessy Backend'",
      '!canEditLlmConnection(connection)',
      'resolveConnectionEditTarget(connection)',
      'describeManagedModelRefusal(error, modelId)',
      'describeConnectionInUseHolders(',
      '<MidStreamOneMessageHint />',
      'label={t("settings.ai.outputStyle")}',
      'title={t("settings.ai.guardian.title")}',
      'guardianModels[guardianActiveConnection.slug]',
      'title={t("settings.ai.advisor.title")}',
      'title={t("settings.ai.codexAutoReview.title")}',
      'label={t("settings.ai.codexSubagentsLabel")}',
      '<DecisionModelCard',
    ]) {
      expect({ kept, present: PAGE.includes(kept) }).toEqual({ kept, present: true })
    }
    // The mid-stream hint sits on the solved tertiary ink, not the retired muted-foreground.
    expect(functionBody(PAGE, 'MidStreamOneMessageHint')).toContain('text-label-sm leading-snug text-tertiary')
  })

  it('NEGATIVE — the Cloudflare AI Gateway label is not taken (the preset is DROP-a)', () => {
    expect(PAGE).not.toContain('cloudflare-ai-gateway')
    // Positive control on the same instrument: the label map is read (a label it does carry is found).
    expect(PAGE).toContain("'vercel-ai-gateway': 'Vercel AI Gateway'")
  })
})
