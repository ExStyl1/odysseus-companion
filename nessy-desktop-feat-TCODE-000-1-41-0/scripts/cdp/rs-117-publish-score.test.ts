/**
 * UA6.7 — the RS-117 pieces (`cases/rs-117.ts`), offline. Every scorer gets its
 * positive arm and a planted change that must fail it; the case's arm structure
 * is pinned against the case's own source (the no-data/with-data review pair,
 * the drift refusal carrying the OTHER sha, the delete-order sampler, the
 * disabled-Publish read); and the renderer, wire and playground facts the case
 * restates are read back out of the SOURCE they restate, so a rename there
 * turns this file red instead of leaving the case reading a copy, a code or a
 * variant the app no longer has.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MARKER_KEY, QUOTED_COPY, contentUrlFor, driftRefusalVerdict, fakeApiTokenValue, grantScriptSource, meta, needsOwnerIdentity,
  publishProbePageHtml, registryRowPresent, scoreCopyProbe, scoreDeleteOrder, scoreLinkGone, scoreLinkRenders,
  scoreReviewCard, scoreScriptBlocked, shaChangesVerdict, snapshotJson, type CopyProbe, type LinkFetch,
} from './cases/rs-117.ts'

const REPO = join(import.meta.dir, '..', '..')
const source = (relative: string): string => readFileSync(join(REPO, relative), 'utf8')
const kase = source('scripts/cdp/cases/rs-117.ts')

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

describe('RS-117: the fake token and the planted snapshot', () => {
  it('plants a your_… placeholder: the guard judges it not-a-secret, and it survives inlineJson\'s < escaping', () => {
    const first = fakeApiTokenValue()
    const second = fakeApiTokenValue()
    // The guard's OWN placeholder rule (one source of truth, publish-guard.ts) must judge the value
    // not-a-secret. It must carry NO `<`: share-bundle's inlineJson escapes `<` to `\u003c` in the built
    // document, which knocked a `<…>` placeholder out of placeholder shape, and the sitting measured a bare
    // `rs117-fake-not-a-secret-…` word REFUSED outright (RC4, S7-D 2026-10-10) — only this shape passes
    // both scans, and it keeps the value assertable in the served bytes.
    const ruleSource = /const PLACEHOLDER_VALUE = \/\^\(\?:(.+)\)\$\/i;/.exec(source('packages/shared/src/artifacts/publish-guard.ts'))?.[1]
    expect(ruleSource).toBeDefined()
    expect(first).toMatch(new RegExp(`^(?:${ruleSource})$`, 'i'))
    expect(first).toContain('rs117')
    expect(first).not.toContain('<')
    expect(first).not.toBe(second)
    // Still nothing a blocking scan knows: none of the shared table's prefixes, and the separator caps any
    // digit run at 8, so no 13-19 digit run a Luhn PAN check could claim (the pattern this file pins, not
    // the scanner itself).
    expect(first).not.toMatch(/\b(eyJ|sk-|ghp_|gho_|glrt-|glpat-|AKIA|ASIA|xox[bpea]-|npm_|pypi-|SG\.|rk_|pk_)/)
    expect(first).not.toMatch(/\d{13,19}/)
  })

  it('plants the marker beside the apiToken key, as a snapshot that parses', () => {
    const marker = 'RS117-112233'
    const parsed = JSON.parse(snapshotJson(marker, fakeApiTokenValue())) as { version: number; kv: Record<string, string> }
    expect(parsed.version).toBe(1)
    expect(parsed.kv[MARKER_KEY]).toBe(marker)
    expect(Object.keys(parsed.kv)).toContain('apiToken')
  })

  it('the apiToken key name is one the snapshot scan flags — read out of redaction\'s own pattern', () => {
    // The key-name heuristic `scanSnapshotForSecretCandidates` delegates to (one source of truth, share-bundle.ts).
    const patternSource = /const SENSITIVE_KEY_PATTERN = \/(.+)\/i;/.exec(source('packages/shared/src/utils/redaction.ts'))?.[1]
    expect(patternSource).toBeDefined()
    const pattern = new RegExp(patternSource!, 'i')
    expect(pattern.test('apiToken')).toBe(true)
    // The control: the marker's own key is not a candidate, so the warning names the planted key alone.
    expect(pattern.test(MARKER_KEY)).toBe(false)
  })
})

describe('RS-117: the probe page', () => {
  const html = publishProbePageHtml('RS117-112233')
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!

  it('has no doctype, compiles, and embeds the marker it must render', () => {
    expect(html.startsWith('<html>')).toBe(true)
    expect(() => new Function(script)).not.toThrow()
    expect(html).toContain('<div id="marker">RS117-112233</div>')
  })

  it('speaks nessy-pages/v1 to the shim and relays through window.top — never parent, which the shim replaces', () => {
    expect(script).toContain("var P = 'nessy-pages/v1'")
    expect(script).toContain("m.protocol !== P")
    expect(script).toContain('window.top.postMessage')
    expect(script).not.toContain('window.parent.postMessage')
    // The action probe is a same-window post (the shim replaced `parent` with the window itself).
    expect(script).toContain('window.postMessage({ protocol: P, type: \'action\'')
  })

  it('arm S\'s grant script is inert (no network, no writes)', () => {
    expect(grantScriptSource()).toContain('console.log')
    expect(grantScriptSource()).not.toMatch(/fetch|http|writeFile/)
  })
})

describe('RS-117: scoreReviewCard (arm R)', () => {
  it('passes a dialog naming the source path and the reviewed bytes\' sha256 prefix', () => {
    const text = `Anyone who has the link can open this page\nFile: pages/build-health\n1234 bytes · 40 lines · sha256 ${SHA_A.slice(0, 12)}…\n`
    expect(scoreReviewCard(text, 'build-health', SHA_A.slice(0, 12)).ok).toBe(true)
  })

  it('NEGATIVE — a planted change fails it: another page\'s path, a wrong prefix, an empty dialog', () => {
    const text = `File: pages/build-health\nsha256 ${SHA_A.slice(0, 12)}…\n`
    expect(scoreReviewCard(text, 'build-health', SHA_B.slice(0, 12)).ok).toBe(false)
    expect(scoreReviewCard(text, 'other-page', SHA_A.slice(0, 12)).ok).toBe(false)
    expect(scoreReviewCard('', 'build-health', SHA_A.slice(0, 12)).detail).toContain('lacks')
  })
})

describe('RS-117: shaChangesVerdict and driftRefusalVerdict (arm D)', () => {
  it('passes two different digests and fails an unchanged one', () => {
    expect(shaChangesVerdict(SHA_A, SHA_B).ok).toBe(true)
    expect(shaChangesVerdict(SHA_A, SHA_A).detail).toContain('UNCHANGED')
    // A planted shape change (uppercase, truncated) is not a digest.
    expect(shaChangesVerdict(SHA_A.toUpperCase(), SHA_B).ok).toBe(false)
    expect(shaChangesVerdict(SHA_A.slice(1), SHA_B).ok).toBe(false)
  })

  it('fails an unread side as UNMEASURED, never a pass', () => {
    expect(shaChangesVerdict(null, SHA_B).detail).toStartWith('UNMEASURED')
    expect(shaChangesVerdict(SHA_A, null).ok).toBe(false)
  })

  it('passes only the changed-after-review refusal; a success, another refusal or silence fails', () => {
    expect(driftRefusalVerdict({ status: 'refused', note: 'The page changed after you reviewed it, so nothing was sent. Review it again and publish.' }).ok).toBe(true)
    expect(driftRefusalVerdict({ status: 'published', note: 'https://t-artifacts/a/x' }).detail).toContain('NOT refused')
    expect(driftRefusalVerdict({ status: 'refused', note: 'This page is already being published; wait for that to finish.' }).ok).toBe(false)
    expect(driftRefusalVerdict(null).detail).toStartWith('UNMEASURED')
  })

  it('wires the negative arm where it belongs: the with-data publish carrying the NO-data sha (the case source)', () => {
    expect(kase).toContain('driftRefusalVerdict(drift)')
    expect(kase).toContain('{ includeData: true, reviewedSha256: shaOff! }')
    // And the publication is compared before/after the refused call, so "nothing was sent" is measured, not assumed.
    expect(kase).toContain('JSON.stringify(before) === JSON.stringify(afterDrift)')
  })
})

describe('RS-117: scoreCopyProbe (arms P and D)', () => {
  const viewOnly = { ok: false, error: 'view-only: this is a published copy of the page; actions only run in the Nessy app.' }
  const nullSnapshot: CopyProbe = { init: { snapshotNull: true, marker: null, grants: [] }, action: viewOnly }
  const withData: CopyProbe = { init: { snapshotNull: false, marker: 'RS117-1', grants: [] }, action: viewOnly }

  it('passes the null-snapshot/view-only pair (arm P) and the marker round-trip (arm D)', () => {
    expect(scoreCopyProbe(nullSnapshot, { marker: null }).ok).toBe(true)
    expect(scoreCopyProbe(withData, { marker: 'RS117-1' }).ok).toBe(true)
  })

  it('NEGATIVE — each planted change fails it', () => {
    // A snapshot that came through where none was published.
    expect(scoreCopyProbe(withData, { marker: null }).ok).toBe(false)
    // No snapshot where the data was published.
    expect(scoreCopyProbe(nullSnapshot, { marker: 'RS117-1' }).ok).toBe(false)
    // The wrong marker.
    expect(scoreCopyProbe(withData, { marker: 'RS117-2' }).ok).toBe(false)
    // An action that RAN.
    expect(scoreCopyProbe({ init: nullSnapshot.init, action: { ok: true, error: null } }, { marker: null }).ok).toBe(false)
    // An action refused for another reason.
    expect(scoreCopyProbe({ init: nullSnapshot.init, action: { ok: false, error: 'grant-not-found: x' } }, { marker: null }).ok).toBe(false)
    // Grants reaching the copy.
    expect(scoreCopyProbe({ init: { snapshotNull: true, marker: null, grants: [{ id: 'g' }] }, action: viewOnly }, { marker: null }).ok).toBe(false)
  })

  it('fails an unread side as UNMEASURED, never a pass', () => {
    expect(scoreCopyProbe({ init: null, action: viewOnly }, { marker: null }).detail).toStartWith('UNMEASURED')
    expect(scoreCopyProbe({ init: nullSnapshot.init, action: null }, { marker: null }).detail).toStartWith('UNMEASURED')
    expect(scoreCopyProbe({ init: null, action: null }, { marker: null }).ok).toBe(false)
  })

  it('is wired as the scorer, both arms, never an inline comparison (the case source)', () => {
    expect(kase).toContain('scoreCopyProbe(probeOff, { marker: null })')
    expect(kase).toContain('scoreCopyProbe(probeOn, { marker })')
  })
})

describe('RS-117: scoreLinkRenders and scoreLinkGone (arms P, U, X)', () => {
  const rendered: LinkFetch = { status: 200, contentType: 'text/html; charset=utf-8', body: '<html><body>RS117-1</body></html>' }

  it('passes a 200 HTML answer carrying the marker', () => {
    expect(scoreLinkRenders(rendered, 'RS117-1').ok).toBe(true)
  })

  it('NEGATIVE — a 404, a non-HTML content type, an empty body each fail it', () => {
    expect(scoreLinkRenders({ ...rendered, status: 404 }, 'RS117-1').ok).toBe(false)
    expect(scoreLinkRenders({ ...rendered, contentType: 'application/json' }, 'RS117-1').ok).toBe(false)
    expect(scoreLinkRenders({ ...rendered, body: '' }, 'RS117-1').ok).toBe(false)
    // The boundary: a served copy carrying the WRONG run's marker is not this page rendering.
    expect(scoreLinkRenders(rendered, 'RS117-2').ok).toBe(false)
  })

  it('passes only a 404; anything else the link answered — or no answer — fails', () => {
    expect(scoreLinkGone(404).ok).toBe(true)
    expect(scoreLinkGone(200).ok).toBe(false)
    expect(scoreLinkGone(302).ok).toBe(false)
    expect(scoreLinkGone(null).detail).toStartWith('UNMEASURED')
  })
})

describe('RS-117: contentUrlFor — the deployed service serves /a/{id} as a JS shell (S7-D 2026-10-10)', () => {
  it('derives the document endpoint on the link\'s own origin', () => {
    expect(contentUrlFor('https://t-artifacts.t-tech.team/a/abcdefghijklmnopqrstuv', 'abcdefghijklmnopqrstuv'))
      .toBe('https://t-artifacts.t-tech.team/api/artifacts/abcdefghijklmnopqrstuv/content')
    // A legacy 11-char id and a slug-carrying link resolve the same way (the origin is all that is read).
    expect(contentUrlFor('https://t-artifacts.t-tech.team/a/legacyid123-some-slug', 'legacyid123'))
      .toBe('https://t-artifacts.t-tech.team/api/artifacts/legacyid123/content')
  })

  it('the marker detectors fetch the CONTENT endpoint, never the /a/ shell (the case source)', () => {
    // The shell carries no page bytes, so a detector reading it can never pass (measured on RC4).
    expect(kase).toContain('await fetchLink(contentUrl)')
    expect(kase).toContain("await fetchLink(urlX === '' ? '' : contentUrlFor(urlX, artifactX))")
    // The P arm still observes the shell once — the deployed shape stays on the record.
    expect(kase).toContain("run.observe('P: the /a/ shell as fetched (the deployed service serves a JS shell here)'")
  })
})

describe('RS-117: scoreDeleteOrder and registryRowPresent (arm X)', () => {
  it('passes a separating sample, fails the reverse, and calls no-separation UNMEASURED', () => {
    expect(scoreDeleteOrder([
      { row: true, folder: true }, { row: false, folder: true }, { row: false, folder: false },
    ]).ok).toBe(true)
    // The planted reverse: the folder left while the row was still live.
    expect(scoreDeleteOrder([
      { row: true, folder: true }, { row: true, folder: false }, { row: false, folder: false },
    ]).detail).toContain('reversed')
    // Too coarse to see the order — never a pass.
    expect(scoreDeleteOrder([{ row: true, folder: true }, { row: false, folder: false }]).detail).toStartWith('UNMEASURED')
    expect(scoreDeleteOrder([]).ok).toBe(false)
    // A torn sample proves nothing either way: it is unread, not evidence of the reverse.
    expect(scoreDeleteOrder([{ row: null, folder: true }, { row: false, folder: false }]).detail).toStartWith('UNMEASURED')
  })

  it('reads the registry file defensively: torn JSON is null, not false', () => {
    expect(registryRowPresent('[{"id":"a1"}', 'a1')).toBe(null)
    expect(registryRowPresent(null, 'a1')).toBe(null)
    expect(registryRowPresent('[{"id":"a1"}]', 'a1')).toBe(true)
    expect(registryRowPresent('[{"id":"a2"}]', 'a1')).toBe(false)
  })

  it('wires the sampler beside the app\'s own delete (the case source)', () => {
    expect(kase).toContain('sampleDeleteOrder(registryPath, mainFolder, artifactX, () => deleteDone)')
    expect(kase).toContain('scoreDeleteOrder(samples)')
    // The registry the sampler reads is the registry's own path under the workspace root, read by the case process.
    expect(kase).toContain("join(root, 'artifacts', 'registry.json')")
  })
})

describe('RS-117: scoreScriptBlocked (arm S)', () => {
  const good = { blockShown: true, publishDisabled: true, reviewCode: 'PAGE_SHARE_SCRIPT_GRANT' }

  it('passes the block, the disabled button and the refusal code together', () => {
    expect(scoreScriptBlocked(good).ok).toBe(true)
  })

  it('NEGATIVE — each leg alone fails it', () => {
    expect(scoreScriptBlocked({ ...good, blockShown: false }).ok).toBe(false)
    expect(scoreScriptBlocked({ ...good, publishDisabled: false }).ok).toBe(false)
    expect(scoreScriptBlocked({ ...good, publishDisabled: null }).ok).toBe(false)
    expect(scoreScriptBlocked({ ...good, reviewCode: 'PAGE_SHARE_ACTIONS_ACK_REQUIRED' }).ok).toBe(false)
    expect(scoreScriptBlocked({ ...good, reviewCode: undefined }).ok).toBe(false)
  })

  it('reads the button\'s own disabled state, not a label match (the case source)', () => {
    expect(kase).toContain("dialogButtonDisabled(session, labels('pages.share.publish'))")
  })
})

describe('RS-117: needsOwnerIdentity (the O15 block)', () => {
  it('recognises the missing dp identity and nothing else', () => {
    expect(needsOwnerIdentity('artifacts-unavailable')).toBe(true)
    expect(needsOwnerIdentity('Error: needs-login: dp is signed out')).toBe(true)
    expect(needsOwnerIdentity('network: the artifact service could not be reached')).toBe(false)
    expect(needsOwnerIdentity('The page is too large to publish')).toBe(false)
  })
})

describe('RS-117: the copy the case presses, against the live locale', () => {
  it('every quoted string is what the shipped locale says, in both languages', () => {
    const locale = (lang: string) => JSON.parse(source(join('packages', 'shared', 'src', 'i18n', 'locales', `${lang}.json`))) as Record<string, string>
    const [en, ru] = [locale('en'), locale('ru')]
    expect(Object.keys(QUOTED_COPY).length).toBeGreaterThanOrEqual(10)
    for (const [key, byLocale] of Object.entries(QUOTED_COPY)) {
      expect(en[key], `${key} (en)`).toBe(byLocale.en)
      expect(ru[key], `${key} (ru)`).toBe(byLocale.ru)
    }
  })

  it('meta answers UA6.7 with the OWNER sitting\'s own preconditions', () => {
    expect(meta).toMatchObject({ id: 'RS-117', row: 'UA6.7' })
    expect(meta.runtimes).toEqual(['pi', 'claude', 'codex'])
    expect(meta.credentials).toContain('dp identity')
    expect(meta.credentials).toContain('retention to 1 day')
    expect(meta.credentials).toContain('every artifact id')
    // The manual add-ons the sitting owes beyond the case (arm M).
    expect(meta.credentials).toContain('Share Page Dialog')
    expect(meta.credentials).toContain('Page Tile "Published"')
    expect(meta.credentials).toContain('Three kinds · one published')
    expect(meta.credentials).toContain('Published page')
  })
})

describe('RS-117: the renderer and wire facts the case restates', () => {
  it('the dialog renders the review with the session card\'s own component and sends the card\'s sha256', () => {
    const dialog = source('apps/electron/src/renderer/components/pages/SharePageDialog.tsx')
    expect(dialog).toContain('<ArtifactPublishDetails card={review.review.card} />')
    expect(dialog).toContain('reviewedSha256: card.sha256')
    // The S arm's claim: Publish is off while busy, blocked, or cardless — the disabled read the case drives.
    expect(dialog).toContain('const publishDisabled = busy !== null || publishBlocked || !card')
    // The review is re-read when the include-data answer changes (the D arm waits on that effect).
    expect(dialog).toContain('[open, workspaceId, config.slug, config.contentDigest, includeDataSent, ackViewOnly, grants.length, reviewRound]')
    // The two-step unpublish the U arm presses twice.
    expect(dialog).toContain('setConfirmingUnpublish(true)')
  })

  it('the blocked rule is a decision as a value: a script grant, or an unacknowledged view-only need', () => {
    const state = source('apps/electron/src/renderer/components/pages/share-page-state.ts')
    expect(state).toContain('return state.scriptGrants.length > 0 || (state.needsViewOnlyAck && !acknowledged)')
  })

  it('the shim the case probes: view-only sentence, snapshot element id, parent replaced and top untouched', () => {
    const bundle = source('packages/shared/src/pages/share-bundle.ts')
    expect(bundle).toContain('view-only: this is a published copy of the page; actions only run in the Nessy app.')
    expect(bundle).toContain("export const PAGE_SHARE_SNAPSHOT_ELEMENT_ID = 'nessy-page-snapshot'")
    expect(bundle).toContain('try { window.parent = window; }')
    expect(bundle).not.toContain('window.top = window')
    // The snapshot key scan the warning reads, capped and key-name only.
    expect(bundle).toContain('export function scanSnapshotForSecretCandidates')
    // The script-grant refusal the S arm expects from the review.
    expect(bundle).toContain("'PAGE_SHARE_SCRIPT_GRANT'")
  })

  it('the host publish path: the pages/<slug> source, the reviewed-sha gate, and the three-part scan', () => {
    const publishing = source('packages/server-core/src/pages/page-publishing.ts')
    expect(publishing).toContain('return `pages/${slug}`')
    expect(publishing).toContain('card.sha256 === options.reviewedSha256')
    expect(publishing).toContain('The page changed after you reviewed it, so nothing was sent. Review it again and publish.')
    expect(publishing).toContain("name: 'The page\\'s HTML'")
    expect(publishing).toContain("name: 'The page\\'s data snapshot'")
    // UA12.118: the built copy is named for what it is, never "the published copy" (nothing was published).
    expect(publishing).toContain("name: 'The copy built from this page (its content and data together)'")
    expect(publishing).not.toContain("'The published copy of the page'")
    // The unpublish the delete reuses — one DELETE, gone counts as deleted.
    expect(publishing).toContain('deletePublishedArtifact')
  })

  it('the delete order is a policy in one place: unpublish runs before the folder goes', () => {
    const storage = source('packages/shared/src/pages/storage.ts')
    const body = storage.slice(storage.indexOf('export async function deletePageLocal'))
    const unpublishAt = body.indexOf('await options.unpublish(')
    const folderAt = body.indexOf('deletePage(workspaceRootPath, pageSlug)')
    expect(unpublishAt).toBeGreaterThan(-1)
    expect(folderAt).toBeGreaterThan(unpublishAt)
    const rpc = source('packages/server-core/src/handlers/rpc/pages.ts')
    expect(rpc).toContain('unpublishBeforeDelete')
    expect(rpc).toContain('artifacts-unavailable')
  })

  it('the runner offers RS-117 by name in SITTING, after RS-116', () => {
    const runner = source('scripts/cdp/run.ts')
    const sittingAt = runner.indexOf('const SITTING = [')
    expect(sittingAt).toBeGreaterThan(-1)
    // The block's own end — the FIRST `] as const` is CASES', which ends before SITTING begins.
    const block = runner.slice(sittingAt, runner.indexOf('] as const', sittingAt))
    expect(block.length).toBeGreaterThan(100)
    expect(block).toContain("'RS-117'")
    expect(block.indexOf("'RS-117'")).toBeGreaterThan(block.indexOf("'RS-116'"))
  })
})

describe('RS-117: arm M — the playground sweep the sitting owes by hand', () => {
  it('the four markers are spelled as the playground registry spells them', () => {
    const registry = source('apps/electron/src/renderer/playground/registry/pages.tsx')
    expect(registry).toContain("name: 'Published'")
    expect(registry).toContain("'Three kinds · one published'")
    expect(registry).toContain("name: 'Published page'")
    // The Share dialog's seven states, by value.
    for (const value of ['unpublished', 'published', 'drifted', 'pending', 'script-blocked', 'needs-ack', 'review-refused']) {
      expect(registry).toContain(`value: '${value}'`)
    }
  })

  it('and the packaged build really keeps the sweep out of CDP reach — both halves, from their own sources', () => {
    // P6.667: will-navigate admits only the app's own index.html on file://.
    const manager = source('apps/electron/src/main/window-manager.ts')
    expect(manager).toContain("filePath === join(rendererRoot, 'index.html')")
    // P6.668: the playground refuses a bridge it did not install.
    const mock = source('apps/electron/src/renderer/playground/mock-utils.ts')
    expect(mock).toContain('data-playground-refusal="foreign-bridge"')
    expect(mock).toContain("return installedMockBridge ? 'mock' : 'foreign'")
  })
})
