/**
 * RS-40 (DA1.11 + DA1.10) — a BYO endpoint on the gateway HOST that is not the
 * gateway URL: is it NAMED, is it ACCEPTED, and does a turn on it carry a
 * corporate token?
 *
 * ## The two halves, and why only one of them has ever been proved end to end
 *
 * DA1.11 built a save-time NOTICE (`apiSetup.gatewayHostNotGatewayUrl`) for a
 * URL on `code-completion-nestor.tcsbank.ru` that is not one of the named
 * gateway endpoints: such a connection is a legitimate custom endpoint, it
 * classifies BYO, and the silence around that was what made the gateway's raw
 * 401 read as a broken login. DA1.10 narrowed the CREDENTIAL side to the named
 * endpoints, so the same connection must carry the user's own `Authorization`
 * and never `Nestor-Token`. The notice has unit tests; **the credential half has
 * no test that follows a real turn to the wire**, which is the clause this case
 * exists for.
 *
 * ## The detector for the credential half is the app's OWN line, PER SESSION
 *
 * `packages/pi-agent-server/src/gateway-proxy/nestor-reasoning-proxy.ts` symbol
 * `logUpstreamAuthScheme` writes `[nestor-proxy] upstream auth: <scheme>` when
 * `NESSY_PROXY_AUTH_DEBUG=1`, with `bearer` / `nestor-token` / `none` as the
 * entire vocabulary — a scheme and never a credential, which is why it is
 * quotable in a run narrative.
 *
 * It goes to the SIDECAR's stderr, and the app files that per session at
 * `<config dir>/logs/runtime/<sessionId>-pi.txt` — measured 2026-09-17, after
 * looking for it in the app's own captured output and finding zero lines there.
 * Reading the per-session file rather than slicing a shared log by time is what
 * makes the reading unambiguous: no window arithmetic, and a line from another
 * session cannot be attributed to this one.
 *
 * **TWO environment variables, and naming only one is how this arm fails while
 * telling you the opposite (DA2.28).** `NESSY_PROXY_AUTH_DEBUG=1` is what makes
 * `logUpstreamAuthScheme` write the LINE; `NESSY_DEBUG=1` is what makes the FILE
 * exist at all — `packages/shared/src/agent/pi-agent.ts` opens the per-session
 * diagnostic through `openSessionRuntimeDebugLog('pi', sessionId, hostDebug)`
 * and `hostDebug` is `process.argv.includes('--debug') || process.env.NESSY_DEBUG
 * === '1'`, nothing else. With the first alone the directory is never created,
 * this case reads an empty scheme list, and its own failure message used to name
 * the variable that WAS set — a recipe that sends the next reader to check the
 * one thing that was already right.
 *
 * **The gateway card is the instrument's positive control, in the same run.**
 * A session on the one-click card writes `nestor-token`; the BYO session on the
 * gateway HOST must write `bearer`. Without the first line, `bearer` alone is
 * equally true of an instrument that cannot say `nestor-token` at all.
 *
 * ## What the shipped ADD flow will not let this case do — measured 2026-09-17
 *
 * The row's recipe says *"Settings → AI → Add connection → Custom, type
 * `https://…/cli/other/v1`"*. **There is no field to type it into.**
 * `components/onboarding/ByoRuntimeStep.tsx` says so in its own comment — *"the
 * Endpoint — v2 hides it. It appears only for an EDIT of a connection that
 * points somewhere other than the hardcoded URL, and there it is read-only"* —
 * and the DOM agrees: the custom-runtime step renders `#byo-api-key` and no
 * endpoint input at all. So the notice is reachable on an EDIT and not on an
 * ADD, and this case records that rather than reporting the notice missing.
 * The first arm below is that measurement, with the API-key field as its control
 * so "no endpoint input" cannot be a form that failed to render.
 *
 * ## Safety
 *
 * The connection this case creates carries a FABRICATED key. Its endpoint is a
 * path on the gateway host that serves nothing, so the turn it drives fails —
 * which is fine and is not what is being read: the auth scheme is decided when
 * the request is BUILT, before any answer comes back. No credential is read,
 * printed or written, and the one-click gateway card is never touched.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { resolveConfigDir } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, selectorCount } from '../lib/state.ts'
import { clickAt } from '../lib/viewport.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-40'
const TITLE = 'a BYO endpoint on the gateway HOST: named, accepted, and carrying no corporate token'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'DA1.11',
  runtimes: ['pi'],
  credentials:
    'none of the operator’s. The connection this case creates carries a key it FABRICATES. Run it on a profile with '
    + 'the one-click gateway card seeded (RS-32 does that), because a session on it is this case’s positive control. '
    + 'Launch the packaged build with BOTH NESSY_PROXY_AUTH_DEBUG=1 (which writes the line) and NESSY_DEBUG=1 (which '
    + 'creates <config dir>/logs/runtime/ at all), and point NESSY_CONFIG_DIR at the same config dir — with either '
    + 'one missing the per-session runtime log the detector reads will not be there.',
} as const satisfies CaseMeta

/** The gateway HOST on a path that is not a named gateway endpoint — DA1.11's case. */
const GATEWAY_HOST_OTHER_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/other/v1'
/** The exact gateway URL, which the form refuses outright (`endpointIsGateway`). */
const GATEWAY_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1'
/** A built-in slug with a numeric suffix — the only door `setupLlmConnection` opens. */
const SLUG = 'pi-api-key-3'
const MODELS = ['tgpt/deepseek-v4-flash-0731', 'tgpt/qwen36-35b-a3b-fp8']
/** Either locale's `apiSetup.gatewayHostNotGatewayUrl`, matched on a distinctive clause. */
const NOTICE = /not the gateway URL|это не URL шлюза/i
/** `logUpstreamAuthScheme`'s whole vocabulary. */
const AUTH_LINE = /\[nestor-proxy\] upstream auth: (bearer|nestor-token|none)/g

function fakeKey(): string {
  return `sk-cdp-${randomUUID().replace(/-/g, '')}`
}

/** The Pi sidecar's own stderr for ONE session, as the app files it. */
function runtimeLogPath(sessionId: string): string {
  return join(resolveConfigDir(), 'logs', 'runtime', `${sessionId}-pi.txt`)
}

/** Every auth scheme that session's sidecar has written, in order. */
function authSchemes(sessionId: string): { file: string; schemes: string[] } {
  const file = runtimeLogPath(sessionId)
  try {
    return { file, schemes: [...readFileSync(file, 'utf8').matchAll(AUTH_LINE)].map(match => match[1] ?? '') }
  } catch {
    return { file, schemes: [] }
  }
}

interface Rect { x: number; y: number; text: string }

async function buttonByText(session: CdpSession, pattern: RegExp): Promise<Rect | undefined> {
  return session.call<Rect | undefined>(`
    const wanted = ${pattern.toString()}
    const button = Array.from(document.querySelectorAll('button')).find(el => wanted.test((el.innerText || '').replace(/\\s+/g, ' ')))
    if (!button) return undefined
    const r = button.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return undefined
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (button.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80) }
  `)
}

/**
 * DA2.24 — the per-connection «…» trigger of the row whose label carries `name`.
 *
 * Walked UP FROM THE NAME, not down from a trigger, and that direction is the
 * whole of it: `SettingsRow`'s markup is a label cell and an actions cell as
 * SIBLINGS, so walking up from a trigger reaches the section container — whose
 * `innerText` carries EVERY connection's name — and the first trigger in the
 * list matches whatever name you asked for. Measured 2026-09-17: that version
 * opened the one-click gateway card's menu instead, and `canEditLlmConnection`
 * is false for a managed card, so the menu correctly carried no Edit item and
 * the arm read as "the notice is unreachable". From the NAME the walk stops at
 * the first ancestor that contains a trigger, which is that row and no other.
 *
 * The name is matched on a leaf whose whole text IS the name, so a row whose
 * name is a prefix of another's cannot be taken for it.
 */
async function connectionMenuTrigger(session: CdpSession, name: string): Promise<Rect | undefined> {
  return session.call<Rect | undefined>(`
    const wanted = ${JSON.stringify(name)}
    const leaf = Array.from(document.querySelectorAll('span, div, p'))
      .filter(el => el.children.length === 0 && (el.textContent || '').trim() === wanted)[0]
    if (!leaf) return undefined
    let node = leaf.parentElement
    let trigger = null
    for (let depth = 0; node && depth < 8 && !trigger; depth += 1, node = node.parentElement) {
      trigger = node.querySelector('button[data-state]')
    }
    if (!trigger) return undefined
    const r = trigger.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return undefined
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: wanted }
  `)
}

/** DA2.24 — an open dropdown's item by its rendered text, in either locale. */
async function menuItemByText(session: CdpSession, pattern: RegExp): Promise<Rect | undefined> {
  return session.call<Rect | undefined>(`
    const wanted = ${pattern.toString()}
    const item = Array.from(document.querySelectorAll('[role="menuitem"]'))
      .find(el => wanted.test((el.innerText || '').replace(/\s+/g, ' ').trim()))
    if (!item) return undefined
    const r = item.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return undefined
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (item.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40) }
  `)
}

/** Whether the app's rendered text carries the DA1.11 notice anywhere on screen. */
async function noticeOnScreen(session: CdpSession): Promise<boolean> {
  const text = await session.call<string>(`return (document.body.innerText || '').replace(/\\s+/g, ' ')`)
  return NOTICE.test(text)
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  // The detector is a FILE the app writes under its own config dir, so the case
  // needs the same config dir the app was launched with — every filesystem
  // detector in this harness is scoped by it and a wrong one reports absence for
  // everything.
  run.observe('the config dir this case reads its detector from', resolveConfigDir())

  // ---- arm 1: can the row's own recipe be performed at all? ----------------
  await session.call<null>(`
    window.dispatchEvent(new CustomEvent('nessy-agent-navigate', { detail: { route: 'settings/ai' }, bubbles: true }))
    return null
  `)
  await Bun.sleep(2_500)
  const aiSection = await buttonByText(session, /^AI Model, thinking/i)
  if (aiSection) {
    await clickAt(session, { x: aiSection.x, y: aiSection.y }, 'the AI settings section')
    await Bun.sleep(2_000)
  }
  const addButton = await buttonByText(session, /Add Connection/i)
  let addFlow: Record<string, unknown> = { reached: false }
  if (addButton) {
    await clickAt(session, { x: addButton.x, y: addButton.y }, 'Add Connection')
    await Bun.sleep(2_000)
    const custom = await buttonByText(session, /Custom runtime endpoint/i)
    if (custom) {
      await clickAt(session, { x: custom.x, y: custom.y }, 'Custom runtime endpoint')
      await Bun.sleep(2_500)
      addFlow = {
        reached: true,
        apiKeyField: (await selectorCount(session, '#byo-api-key')) > 0,
        onboardingEndpointField: (await selectorCount(session, '#byo-base-url')) > 0,
        apiKeyFormEndpointField: (await selectorCount(session, '#base-url')) > 0,
      }
    }
  }
  run.observe('the ADD flow’s custom-endpoint step', addFlow)
  run.check(
    'THE CONTROL — the custom-runtime step rendered (its API-key field is on screen)',
    addFlow.apiKeyField === true,
    `the step did not render: ${JSON.stringify(addFlow)} — without it, "no endpoint field" below would be equally `
    + 'true of a form that never opened',
  )
  // RECORDED, not required: the absence is the product's own v2 decision, quoted
  // in `ByoRuntimeStep.tsx`'s own comment. It is here because the ROW's recipe
  // depends on it, and a reader following that recipe on this build meets a form
  // with nothing to type into and no explanation.
  run.observe('DA1.11 — can the URL be TYPED on this build?', addFlow.apiKeyField === true && addFlow.onboardingEndpointField === false
    ? 'NO. The custom-runtime step renders its API-key field and NO endpoint input (`#byo-base-url` absent, `#base-url` '
      + 'absent). `ByoRuntimeStep.tsx` says why in its own comment: the endpoint is hidden in v2 and appears only on an '
      + 'EDIT, read-only. So the notice is an EDIT-path surface, and the row’s "type the URL" recipe cannot be '
      + 'performed here.'
    : `read the raw counts above: ${JSON.stringify(addFlow)}`)
  await session.call<null>(`
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return null
  `)
  await Bun.sleep(1_000)

  // ---- arm 2: is the URL ACCEPTED, and is the gateway URL itself refused? --
  let created = false
  let sessionId: string | undefined
  try {
    const accepted = await session.call<{ success?: boolean; error?: string }>(`
      return await window.electronAPI.setupLlmConnection(${JSON.stringify({
        slug: SLUG,
        credential: fakeKey(),
        baseUrl: GATEWAY_HOST_OTHER_URL,
        customEndpoint: { api: 'openai-completions' },
        defaultModel: MODELS[0],
        models: MODELS,
      })})
    `)
    created = accepted?.success === true
    run.observe('the gateway-HOST non-gateway endpoint, stored', { url: GATEWAY_HOST_OTHER_URL, answer: accepted })
    run.check(
      'DA1.11 — a gateway-HOST endpoint that is not the gateway URL is ACCEPTED (a notice, never a refusal)',
      created,
      `the save path answered ${JSON.stringify(accepted)}. AGENTS.md is explicit that such a URL is a legitimate `
      + 'custom endpoint with normal provider auth semantics, so a refusal here would be the defect',
    )
    // Read through the app's own list rather than the harness's narrowed row
    // type: `ConnectionRow` (`lib/runtime-switch.ts`) carries no `baseUrl`, and
    // the endpoint IS the subject of this arm.
    const stored = await session.call<{ slug: string; providerType: string; baseUrl?: string } | undefined>(`
      const rows = await window.electronAPI.listLlmConnections()
      const row = (rows ?? []).find(c => c.slug === ${JSON.stringify(SLUG)})
      return row ? { slug: row.slug, providerType: row.providerType, baseUrl: row.baseUrl } : undefined
    `)
    run.observe('the app’s own record of it', stored)

    // The EXACT gateway URL, through the same door. The renderer's
    // `endpointIsGateway` refusal is a FORM rule and the form has no field to
    // type into on this build, so what is read here is what the SAVE path does —
    // recorded verbatim rather than asserted, because the two layers are allowed
    // to answer differently and only one of them is this row's subject.
    const gatewayUrlAnswer = await session.call<{ success?: boolean; error?: string }>(`
      return await window.electronAPI.setupLlmConnection(${JSON.stringify({
        slug: 'pi-api-key-4',
        credential: fakeKey(),
        baseUrl: GATEWAY_URL,
        customEndpoint: { api: 'openai-completions' },
        defaultModel: MODELS[0],
        models: MODELS,
      })})
    `)
    run.observe('the EXACT gateway URL through the same save path', { url: GATEWAY_URL, answer: gatewayUrlAnswer })
    run.observe('whether that attempt produced a connection', await session.call<boolean>(`
      const rows = await window.electronAPI.listLlmConnections()
      return (rows ?? []).some(c => c.slug === 'pi-api-key-4')
    `))

    // ---- arm 3: the NOTICE, wherever this build shows that URL -------------
    await session.call<null>(`
      window.dispatchEvent(new CustomEvent('nessy-agent-navigate', { detail: { route: 'settings/ai' }, bubbles: true }))
      return null
    `)
    await Bun.sleep(2_500)
    const section = await buttonByText(session, /^AI Model, thinking/i)
    if (section) {
      await clickAt(session, { x: section.x, y: section.y }, 'the AI settings section')
      await Bun.sleep(2_500)
    }
    run.observe('DA1.11’s notice on the AI settings surface', await noticeOnScreen(session)
      ? 'PRESENT'
      : 'ABSENT — the settings LIST shows the host beside the connection name and the sentence belongs to the EDIT '
        + 'form; this run did not open that form, so this is a NULL rather than a finding')

    // ---- arm 3b (DA2.24): the EDIT form, which is where the notice lives ----
    //
    // The arm above reads the LIST, where the sentence is not rendered at all —
    // and that absence is this arm's own negative control, taken on the same
    // screen moments earlier: `ApiKeyInput.tsx` and `ByoRuntimeStep.tsx` are the
    // only two readers of the key, and the settings list is neither. So a
    // PRESENT reading below cannot be a page that always carries the sentence.
    //
    // Driven through the product's own affordance — the per-connection «…» menu
    // and its Edit item — rather than by dispatching a route, because the notice
    // is conditional on the form MOUNTING with this connection's stored URL, and
    // a route that opened an empty form would answer the wrong question.
    const listNotice = await noticeOnScreen(session)
    const rowName = await session.call<string | undefined>(`
      const rows = await window.electronAPI.listLlmConnections()
      const row = (rows ?? []).find(c => c.slug === ${JSON.stringify(SLUG)})
      return row ? row.name : undefined
    `)
    let editForm: Record<string, unknown> = { reached: false, reason: 'the connection row was not found on screen' }
    if (rowName) {
      const trigger = await connectionMenuTrigger(session, rowName)
      if (trigger) {
        await clickAt(session, { x: trigger.x, y: trigger.y }, `the «…» menu of ${rowName}`)
        await Bun.sleep(1_200)
        // Both locales: this build ships en and ru and the sitting may run on
        // either. A menu item that matches neither is reported as such rather
        // than silently skipped.
        const edit = await menuItemByText(session, /^(Edit|Изменить|Редактировать)$/i)
        if (edit) {
          await clickAt(session, { x: edit.x, y: edit.y }, 'Edit')
          await Bun.sleep(3_000)
          editForm = {
            reached: true,
            item: edit.text,
            apiKeyField: (await selectorCount(session, '#byo-api-key')) > 0,
            endpointField: (await selectorCount(session, '#byo-base-url')) > 0,
            mergedEndpointField: (await selectorCount(session, '#base-url')) > 0,
            noticeOnEditForm: await noticeOnScreen(session),
          }
        } else {
          editForm = { reached: false, reason: 'the open menu carried no Edit item in either locale' }
        }
      } else {
        editForm = { reached: false, reason: `no «…» trigger was found in a row naming ${rowName}` }
      }
    }
    run.observe('DA2.24 — the stored connection’s EDIT form', { rowName, listNotice, ...editForm })
    run.check(
      'THE CONTROL — the EDIT form opened (its API-key field is on screen)',
      editForm.apiKeyField === true,
      `the form did not open: ${JSON.stringify(editForm)} — without it, a missing notice below would be equally true `
      + 'of a form that never mounted, which is exactly the NULL the 1.39.0 sitting recorded',
    )
    run.check(
      'DA1.11 — the notice IS rendered on the EDIT form of a stored gateway-HOST endpoint',
      editForm.noticeOnEditForm === true && listNotice === false,
      `the edit form read ${JSON.stringify(editForm.noticeOnEditForm)} and the settings LIST read `
      + `${JSON.stringify(listNotice)}. Read the control above first: the two together are the assertion — the `
      + 'sentence belongs to the EDIT surface and to nothing else, so PRESENT on the list would mean the detector '
      + 'matches something it should not',
    )
    await session.call<null>(`
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return null
    `)
    await Bun.sleep(1_500)

    // ---- arm 4: THE CREDENTIAL HALF — one turn per card, one instrument ----
    //
    // THE CONTROL FIRST, in the same run and on the same instrument: a session on
    // the one-click GATEWAY card, whose sidecar must write `nestor-token`. Without
    // it, a `bearer` reading below is equally true of an instrument that cannot
    // say `nestor-token` at all.
    const controlKey = await freshSession(session, `CDP ${ID} control ${new Date().toISOString().slice(11, 19)}`)
    const controlTurn = await sendPrompt(session, controlKey, 'Reply with the single word ready and nothing else.', 180_000)
      .catch((cause: unknown) => ({ error: cause instanceof Error ? cause.message : String(cause) }))
    await Bun.sleep(2_000)
    const control = authSchemes(controlKey.sessionId)
    run.observe('THE CONTROL — a session on the one-click gateway card', {
      answered: !('error' in controlTurn),
      file: control.file,
      schemes: control.schemes,
    })
    run.check(
      'THE CONTROL — the gateway card’s own turn writes `nestor-token`',
      control.schemes.length > 0 && control.schemes.every(scheme => scheme === 'nestor-token'),
      `the control session wrote ${JSON.stringify(control.schemes)} at ${control.file}. An empty list means one of `
      + 'three things, and they are checked in this order (DA2.28): NESSY_DEBUG=1 was not set, so '
      + '<config dir>/logs/runtime/ was never created and there is no file; NESSY_PROXY_AUTH_DEBUG=1 was not set, so '
      + 'the file exists and carries no `upstream auth:` line; or NESSY_CONFIG_DIR here is not the directory the app '
      + 'was launched with. Either way the BYO reading below cannot be interpreted',
    )

    // ---- the BYO session on the gateway HOST -------------------------------
    process.env.NESSY_CDP_CARD = SLUG
    const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
    sessionId = key.sessionId
    await session.call<null>(`
      await window.electronAPI.sessionCommand(${JSON.stringify('__SESSION__')}, { type: 'switchRuntime', connectionSlug: ${JSON.stringify(SLUG)} })
      return null
    `.replace('"__SESSION__"', JSON.stringify(key.sessionId))).catch(() => null)
    await Bun.sleep(2_000)
    const turn = await sendPrompt(session, key, 'Reply with the single word ready and nothing else.', 180_000)
      .catch((cause: unknown) => ({ error: cause instanceof Error ? cause.message : String(cause) }))
    await Bun.sleep(2_000)
    const byo = authSchemes(key.sessionId)
    run.observe('the turn on the gateway-HOST endpoint', {
      answered: !('error' in turn),
      ...('error' in turn ? { error: String(turn.error).slice(0, 300) } : {}),
      file: byo.file,
      schemes: byo.schemes,
      note: 'the endpoint serves nothing, so a failing turn is expected — the scheme is decided when the request is '
        + 'BUILT, before any answer comes back',
    })
    run.check(
      'DA1.10 — the turn carries the connection’s OWN Bearer and never the corporate token',
      byo.schemes.length > 0 && byo.schemes.every(scheme => scheme === 'bearer'),
      `this session’s sidecar wrote ${JSON.stringify(byo.schemes)} at ${byo.file}. A \`nestor-token\` here is the `
      + 'defect DA1.10 narrowed away: the dp JWT reaching a path on the gateway host that is not a named gateway '
      + 'endpoint. `none` means no credential was sent at all, which is a different finding. An EMPTY list means the '
      + 'turn never reached the sidecar’s proxy — read the turn’s own error above before reading anything into it',
    )
  } finally {
    if (sessionId) {
      await session.call<null>(`
        const rows = await window.electronAPI.listLlmConnections()
        const fallback = (rows ?? []).find(c => c.slug !== ${JSON.stringify(SLUG)})
        if (fallback) await window.electronAPI.sessionCommand(${JSON.stringify(sessionId)}, { type: 'switchRuntime', connectionSlug: fallback.slug })
        return null
      `).catch(() => null)
      await Bun.sleep(1_500)
    }
    if (created) {
      run.observe('the connection was removed again', await session.call<unknown>(`
        const api = window.electronAPI
        if (typeof api.deleteLlmConnection === 'function') return await api.deleteLlmConnection(${JSON.stringify(SLUG)})
        return 'no deleteLlmConnection on this build'
      `).catch((cause: unknown) => String(cause instanceof Error ? cause.message : cause)))
    }
    await session.call<unknown>(`
      const api = window.electronAPI
      if (typeof api.deleteLlmConnection === 'function') return await api.deleteLlmConnection('pi-api-key-4')
      return null
    `).catch(() => null)
  }
}

if (import.meta.main) await main(ID, TITLE, drive)

export const manual = {
  steps: [
    '1. PACKAGED build, dark theme, ONE content panel, a FRESH NESSY_CONFIG_DIR with the one-click gateway card seeded (RS-32 does that).',
    '2. Launch it with BOTH NESSY_PROXY_AUTH_DEBUG=1 and NESSY_DEBUG=1 — the first turns on `logUpstreamAuthScheme`, the second is what creates <config dir>/logs/runtime/ at all (`openSessionRuntimeDebugLog(\'pi\', sessionId, hostDebug)`, where hostDebug is NESSY_DEBUG=1 or --debug). The app files the sidecar’s stderr per session at <config dir>/logs/runtime/<sessionId>-pi.txt, which is where this case reads it (measured 2026-09-17: the app’s OWN captured stdout carries zero such lines).',
    '3. `bun run scripts/cdp/cases/rs-40.ts` with NESSY_CONFIG_DIR pointing at the SAME config dir the app was launched with — every filesystem detector here is scoped by it. The case creates its own connection with a FABRICATED key on `https://code-completion-nestor.tcsbank.ru/api/v1/cli/other/v1` and removes it again.',
    '4. Read five things: whether the ADD flow has an endpoint field at all, whether the URL was accepted, what the EXACT gateway URL did through the same door, whether the stored connection’s EDIT form carries `apiSetup.gatewayHostNotGatewayUrl` (DA2.24 — driven through the per-connection «…» menu, with the settings LIST as its negative control), and the auth SCHEMES inside the turn’s own window.',
  ],
  expected: 'the gateway-HOST non-gateway URL is ACCEPTED, and a turn on it writes `[nestor-proxy] upstream auth: bearer` — never `nestor-token`.',
  detector: '`logUpstreamAuthScheme` (`packages/pi-agent-server/src/gateway-proxy/nestor-reasoning-proxy.ts`), whose whole vocabulary is bearer / nestor-token / none — a scheme the app itself writes, never a credential and never the model’s prose. Read from the PER-SESSION runtime log the app files at <config dir>/logs/runtime/<sessionId>-pi.txt, so no window arithmetic is needed and another session’s line cannot be attributed to this one. It takes TWO levers: NESSY_PROXY_AUTH_DEBUG=1 writes the line, NESSY_DEBUG=1 creates the directory (DA2.28).',
  positiveControl: 'a session on the ONE-CLICK GATEWAY card in the same run, whose sidecar must write `nestor-token`. Without it a `bearer` reading is equally true of an instrument that cannot say `nestor-token` at all, and an EMPTY reading is equally true of the instrument being switched off. For the DA2.24 arm the control is the EDIT form’s own `#byo-api-key` field: a missing notice on a form that never mounted is not a reading.',
  doneMeans: 'DA1.10’s end-to-end clause is answered by one packaged run: the schemes inside the turn’s window recorded verbatim. DA1.11’s notice half is answered by arm 3b (DA2.24), which opens the stored connection’s EDIT form through the per-connection «…» menu and reads the sentence off the DOM, with the API-key field as its control that the form mounted and the settings LIST — read moments earlier on the same screen — as the negative that the detector does not match a page that always carries it. A run that cannot reach the menu records the reason rather than a bare NULL.',
  safety: 'the connection carries a fabricated key and its endpoint serves nothing, so the turn fails — which is expected and is not what is read. The one-click gateway card is never touched and no credential file is read, printed or written.',
  doNotConflate: 'the ADD flow with the EDIT flow. `ByoRuntimeStep.tsx` hides the endpoint field in v2 and shows it read-only only on an EDIT, so a reader following the row’s "type the URL" recipe meets a form with nothing to type into — that is the product’s own decision, not the notice being absent.',
} as const satisfies SittingRecipe
