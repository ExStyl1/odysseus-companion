/**
 * CRU-7 — the WebFetch hostname preflight, and what a packaged sitting still has
 * to answer now that the host TURNS IT OFF.
 *
 * ## The claim this case was written for has been INVERTED, and that is the refresh
 *
 * When this file landed (W5-a, 2026-09-04) the vendored binary sent the hostname
 * of every page it fetched to a hardcoded Anthropic endpoint, and the case asked
 * whether that egress happened on a packaged gateway session. The owner then
 * ruled (sitting 2026-09-05 §2.2, option **C**): disable the preflight, PAIRED
 * with a host-supplied domain allowlist. It was built in `9af3a92c4` —
 * `buildClaudeWebFetchPreflightSettings` (`packages/shared/src/agent/claude-agent.ts`)
 * rides `Options.settings` as a third contributor through
 * `composeClaudeSpawnSettings` and writes `skipWebFetchPreflight: true` on EVERY
 * claude-runtime spawn.
 *
 * So the question a live run answers is now the mirror of the old one: **is the
 * setting reaching the packaged child, i.e. does the hostname stay in?** A case
 * left asserting the old direction would score the shipped fix as a regression,
 * which is why this file is refreshed rather than re-run.
 *
 * ## The four static facts are still pinned OFFLINE and are not re-derived here
 *
 * `packages/shared/src/agent/__tests__/claude-webfetch-preflight-markers.test.ts`
 * reads them out of the shipped binary:
 *
 *   - the endpoint is a HARDCODED absolute URL and the hostname is a QUERY
 *     PARAMETER, so the per-session loopback adapter cannot intercept it;
 *   - the only gate is the settings key `skipWebFetchPreflight` — no env var
 *     reaches it, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` included;
 *   - the cache is ALLOW-ONLY, 128 entries, 300 000 ms;
 *   - the setting's own describe names "enterprise environments with
 *     restrictive security policies".
 *
 * That test proves the KEY IS WRITTEN. It cannot prove the child READ it, and no
 * offline read ever will: the reader is inside a closed binary. That gap is the
 * whole of what a sitting buys.
 *
 * ## The three live questions, in the order they gate each other
 *
 * 1. **Is `WebFetch` in this session's tool set at all?** A session whose tool
 *    set has no WebFetch cannot run a preflight, and scoring that as "no egress"
 *    would be this row's own failure mode.
 * 2. **Does the packaged gateway session stay off `api.anthropic.com`?** With the
 *    control below green, an absent request is evidence the setting arrived.
 * 3. **Does the empty-pairing NOTICE appear?** Option (C) is disable PLUS a
 *    pairing, and an install with no operator domain control is, for that
 *    install, indistinguishable from bare (B). The host says so out loud —
 *    `claude-webfetch-preflight-disabled: …`, an `info` on the session's own
 *    transcript — and that sentence is the feature's own record of its own
 *    residue. It is asserted only when the host has no domain control
 *    configured, because on a host that HAS one its absence is correct.
 *
 * ## The detector, and the four ways it goes wrong
 *
 * 1. **A REUSED HOSTNAME PRODUCES NO EGRESS.** The allow-cache is five minutes
 *    and 128 entries, so a second run against the same host was answered from
 *    memory even before the fix, and the proxy log stayed empty — which reads
 *    exactly like the fix. The case mints a fresh label per run and never reuses
 *    one. This detector matters MORE now, not less: it is the one thing that can
 *    manufacture the very absence the case is looking for.
 * 2. **THE MODEL'S REPLY IS NOT THE INSTRUMENT.** "I could not fetch that" is
 *    equally true of a blocked preflight, a DNS failure, a denied tool and a
 *    model that declined. The verdict is read from the operator's proxy log.
 * 3. **AN ABSENCE NEEDS A POSITIVE CONTROL ON THE SAME RIG.** The WebFetch GET
 *    for the probe URL itself must appear in the same log. Without it, "no
 *    `api.anthropic.com` line" is indistinguishable from "the proxy saw nothing
 *    at all" — and that is now the reading that would score a LEAKING build
 *    clean, because absence is the passing answer.
 * 4. **A DEV BUILD IS NOT THE ARTEFACT.** `electron:dev` runs the host and the Pi
 *    subprocess from built bundles; the settings composition under test ships
 *    inside the packaged app. The case records the app it is attached to so a
 *    dev reading cannot be filed as a packaged one.
 *
 * ## Preconditions the harness will not create
 *
 * A logging egress proxy and a PACKAGED build behind it are the operator's to
 * arrange. Set `NESSY_CDP_PROXY_LOG` to a file the proxy appends request lines
 * to; the case reports BLOCKED, with what is missing, rather than inventing a
 * rig. No credential is typed or read by this case: the claude-runtime card is
 * the owner's, already signed in through the one-click `dp` flow.
 *
 * `NESSY_CDP_PROXY_BLOCKS_ANTHROPIC=1` selects the cheap DISCRIMINATOR arm, and
 * it too has inverted. With `api.anthropic.com` refused at the proxy: BEFORE the
 * fix a fresh hostname failed outright (the binary throws on `check_failed`);
 * AFTER it, a fresh hostname must SUCCEED, because nothing consults that host any
 * more. A failure on this arm is therefore the finding, and it separates "the
 * setting arrived" from "the network happened to be quiet" without parsing the
 * proxy's own format.
 *
 * ## What this case does NOT decide
 *
 * Whether to set `skipWebFetchPreflight`. That was decided — owner sitting
 * 2026-09-05 §2.2, option (C) — and built. The case measures whether the decision
 * reaches a packaged child; it does not re-open it.
 */

import { readFileSync } from 'node:fs'
import { resolveAppUnderTest } from '../lib/bundle.ts'
import { infoTexts, sendPrompt } from '../lib/chat.ts'
import { resolveClaudeCard } from '../lib/claude-child.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import type { CaseMeta } from '../lib/sitting.ts'
import { assertElectronApi, freshSession, transcript } from '../lib/state.ts'

const ID = 'CRU-7'
const TITLE = 'A packaged gateway session sends no WebFetch hostname preflight to api.anthropic.com'

/**
 * The row this case answers, and what a sitting must supply for it.
 *
 * `satisfies CaseMeta` since P6.1058. This block was written in the sitting's own
 * shape and aligned to the family vocabulary by hand in `de2efae23`, but it never
 * opted into the type — so the union that refuses `claude-runtime` in every
 * `rs-*.ts` was not binding the one wave case that carries the same field. Opting
 * in costs a type import that is erased before bun sees the file.
 */
export const meta = {
  id: ID,
  title: TITLE,
  row: 'P3.352',
  runtimes: ['claude'],
  credentials: 'owner: the Claude Code (Nessy Gateway) card, already signed in; no key is typed or read here',
} as const satisfies CaseMeta

/** The hostname the preflight WOULD be asked about, and must not be. */
const PREFLIGHT_HOST = 'api.anthropic.com'

/** The host's own sentence when the pairing is empty — the feature's own record. */
const EMPTY_PAIRING_NOTICE = 'claude-webfetch-preflight-disabled'

function readProxyLog(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    blocked(`NESSY_CDP_PROXY_LOG points at ${path}, which could not be read: ${String(error)}`)
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const logPath = process.env.NESSY_CDP_PROXY_LOG?.trim()
  if (!logPath) {
    blocked(
      'this case needs a PACKAGED build running behind a logging egress proxy. '
      + 'Set NESSY_CDP_PROXY_LOG to the file the proxy appends request lines to. '
      + 'Optionally set NESSY_CDP_PROXY_BLOCKS_ANTHROPIC=1 to run the discriminator arm, '
      + 'which refuses api.anthropic.com at the proxy so a fresh hostname must SUCCEED — '
      + 'the mirror of the pre-9af3a92c4 expectation, and the arm that separates '
      + '"the setting arrived" from "the network was quiet".',
    )
  }

  // Detector 4: which artefact answered. A dev reading filed as a packaged one is
  // the failure this line exists to make impossible.
  const app = resolveAppUnderTest(session)
  run.observe('app under test', { kind: app.kind, appRoot: app.appRoot, via: app.via })
  run.check(
    'the artefact under test is the PACKAGED app',
    app.kind === 'packaged',
    app.kind === 'packaged' ? undefined
      : `kind=${app.kind} (${app.via}) — the settings composition under test ships inside the packaged app; `
        + 'a dev reading must not be filed as a packaged one',
  )

  const card = await resolveClaudeCard(session, run, { caseId: ID })
  run.observe('card under test', card.slug)

  // A FRESH label per run, so the allow-cache cannot answer for the network.
  // `example.com` is the fetch target because it resolves everywhere and its
  // content is irrelevant — the hostname is the payload under discussion.
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const probeHost = `nessy-cru7-${stamp}.example.com`
  const probeUrl = `https://${probeHost}/`
  run.observe('probe', { probeHost, blocksAnthropic: process.env.NESSY_CDP_PROXY_BLOCKS_ANTHROPIC === '1' })

  const before = readProxyLog(logPath)
  run.check(
    'the proxy log is readable before the turn',
    typeof before === 'string',
    undefined,
  )
  // A log that ALREADY names the probe host would make every assertion below
  // vacuous, and a fresh label is what makes that impossible — asserted rather
  // than assumed, because a truncated stamp would silently reuse one.
  run.check(
    'the fresh probe hostname does not already appear in the log',
    !before.includes(probeHost),
    before.includes(probeHost) ? 'the stamp is not unique — every assertion below would be reading an earlier run' : undefined,
  )

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
  run.check('the case ran in a session it created', key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)

  const outcome = await switchRuntime(session, key.sessionId, card.slug)
  run.observe(`switch onto ${card.slug}`, outcome)
  const active = await waitForConnection(session, key.sessionId, card.slug)
  run.require(`the session runs on ${card.slug}`, active === card.slug, `llmConnection=${String(active)}`)

  await sendPrompt(
    session,
    key,
    `Fetch ${probeUrl} using your web-fetch tool and tell me what happened. `
    + 'Issue the tool call as your first action. If the tool reports a failure, quote the failure verbatim.',
    240_000,
  ).catch(() => undefined)

  const all = await transcript(session, key)
  const fetchCalls = all.filter(m => m.toolName && /webfetch|web_fetch|fetch/i.test(m.toolName))
  run.observe('tools', all.filter(m => m.toolName).map(m => ({ tool: m.toolName, status: (m as { toolStatus?: string }).toolStatus })))

  // Question 3 — the host's own sentence, read off the surface the host writes it
  // to. Recorded unconditionally and asserted only where its absence would be a
  // defect: an install WITH an operator allowlist or denylist correctly says
  // nothing, and this case cannot see that configuration from here, so the notice
  // is an observation plus a conditional check driven by the operator's own
  // declaration.
  const notices = infoTexts(all)
  const sawEmptyPairingNotice = notices.some(text => text.includes(EMPTY_PAIRING_NOTICE))
  run.observe('empty-pairing notice', sawEmptyPairingNotice ? 'present' : 'absent')
  if (process.env.NESSY_CDP_NO_DOMAIN_CONTROL === '1') {
    run.check(
      'with no operator domain control configured, the session says so on its own transcript',
      sawEmptyPairingNotice,
      sawEmptyPairingNotice
        ? undefined
        : 'the operator declared NESSY_CDP_NO_DOMAIN_CONTROL=1 and the session emitted no '
          + 'claude-webfetch-preflight-disabled info — the residue option (C) owes a disclosure for is silent',
    )
  }

  // Question 1, and it gates question 2: a session whose tool set has no WebFetch
  // cannot run a preflight, and scoring that as "no egress" would be this row's
  // own failure mode.
  run.check(
    'WebFetch is on this session tool set and was called',
    fetchCalls.length > 0,
    fetchCalls.length > 0 ? undefined : 'no web-fetch tool call in the transcript — either the tool is absent here or the model declined; nothing about egress can be read from this run',
  )
  if (fetchCalls.length === 0) return

  const after = readProxyLog(logPath)
  const added = after.slice(before.length)
  run.observe('proxy-log-added-bytes', added.length)

  // Detector 3 — the positive control, on the same log, in the same window.
  // Without it, "no api.anthropic.com line" cannot be told from "the proxy saw
  // nothing", and absence is now the PASSING answer, so a dead rig would read as
  // a clean build.
  const sawProbeFetch = added.includes(probeHost)
  run.check(
    'THE CONTROL — the WebFetch GET for the probe URL reached the proxy',
    sawProbeFetch,
    sawProbeFetch ? undefined : 'the proxy recorded no request for the probe host, so this rig cannot answer the question either way',
  )
  if (!sawProbeFetch) return

  const sawPreflight = added.includes(PREFLIGHT_HOST)
  const sawHostnameOnTheWire = added.includes(`domain=${probeHost}`) || added.includes(`domain%3D${probeHost}`)
  run.observe('preflight', { sawPreflight, sawHostnameOnTheWire })

  // Question 2 — THE finding, and it is now an absence with a live control beside
  // it. `9af3a92c4` writes `skipWebFetchPreflight: true` on every claude-runtime
  // spawn; a request here means the setting did not reach the packaged child.
  run.check(
    'the packaged gateway session did NOT contact api.anthropic.com during the fetch',
    !sawPreflight,
    sawPreflight
      ? 'an api.anthropic.com request appeared in the window with the control green — the '
        + 'skipWebFetchPreflight setting 9af3a92c4 writes did not reach this packaged child, '
        + 'and the hostname of every fetched page is still leaving'
      : undefined,
  )
  run.check(
    'and the probe hostname itself never travelled as a domain= query parameter',
    !sawHostnameOnTheWire,
    sawHostnameOnTheWire ? 'the fetched hostname appears as a domain= parameter in the proxy log' : undefined,
  )

  if (process.env.NESSY_CDP_PROXY_BLOCKS_ANTHROPIC === '1') {
    // The discriminator, inverted with the fix. With the preflight endpoint
    // refused at the proxy and no preflight running, the fetch has no reason to
    // fail: a failure here is the shape a still-running preflight makes, because
    // `check_failed` makes the binary throw.
    const failed = all.some(m => m.toolName
      && /blocked|check|failed|error/i.test((m as { toolResult?: string }).toolResult ?? ''))
    run.check(
      'with api.anthropic.com refused at the proxy, the FRESH hostname fetch still SUCCEEDS',
      !failed,
      failed
        ? 'the fetch failed while the preflight endpoint was unreachable — that is the pre-9af3a92c4 '
          + 'shape (the binary throws on check_failed), so something is still consulting the vendor host'
        : undefined,
    )
  }
}

if (import.meta.main) await main(ID, TITLE, drive)
