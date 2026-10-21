/**
 * RS-45 (DA2.5) — the loopback MCP pool server refuses an unauthenticated
 * request BEFORE any route work, on the packaged build.
 *
 * ## Why a live case for something a unit test already pins
 *
 * `packages/shared/src/mcp/__tests__/proxy-tool-names.test.ts` already asserts
 * 401 for an absent and a wrong bearer and that no session was created, and
 * DA2.5 closed on that. What it cannot say is anything about the SHIPPED
 * artefact: that the listener really is loopback-only, that the bearer really is
 * required by the binary a user runs, and — the half this case adds — that the
 * refusal comes before the two pieces of route work whose own failures would
 * otherwise answer differently.
 *
 * ## The discriminator, and it is the whole design
 *
 * A 401 for a well-formed request proves auth runs. It does NOT prove auth runs
 * FIRST: a server that parsed the body and looked up the session before checking
 * the bearer would answer 401 to that request too. Two probes separate them,
 * because each would produce a DIFFERENT status if auth ran later:
 *
 * - a body that is not JSON at all — the transport answers 400 for that;
 * - an `mcp-session-id` header naming a session that does not exist —
 *   `handleRequest` answers 404 *"Session not found"* for that.
 *
 * Both answering 401 is the ordering, measured rather than read off the source.
 *
 * ## Finding the port, and why the signature is the finder
 *
 * The pool server listens on `127.0.0.1:0` — a port the OS picks — and only a
 * `codex-runtime` session starts one. So the case enumerates the app's own
 * listening sockets (`lsof` over the pids of the running app) and identifies the
 * pool server by its OWN two answers: `404` for any path that is not `/mcp`, and
 * `401` for `/mcp` without a bearer. That pair is the server's shape and nothing
 * else on the app's loopback surface has it — which the case proves rather than
 * assumes, by recording what every other listening port answered.
 *
 * ## Safety
 *
 * Every request here is unauthenticated by construction: the case does not know
 * the bearer, cannot derive it (32 random bytes per instance), and never tries.
 * Nothing is sent that could be accepted, and no credential is read or written.
 */

import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-45'
const TITLE = 'the loopback MCP pool server answers 401 before any route work, on the packaged build'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'DA2.5',
  runtimes: ['codex'],
  credentials:
    'none. The case needs a CODEX session to exist, because only `codex-runtime` starts a pool server — it creates '
    + 'one on whatever codex card the profile has. It never learns, guesses or sends the bearer.',
} as const satisfies CaseMeta

interface Probe { status: number; body: string }

async function probe(port: number, path: string, init: RequestInit = {}): Promise<Probe> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      body: init.body ?? '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
      signal: AbortSignal.timeout(5_000),
    })
    return { status: response.status, body: (await response.text()).slice(0, 200) }
  } catch (cause) {
    return { status: 0, body: String(cause instanceof Error ? cause.message : cause).slice(0, 200) }
  }
}

/** Every 127.0.0.1 port the running app is listening on. */
function appListeningPorts(): number[] {
  const pids = Bun.spawnSync(['pgrep', '-f', 'Nessy Desktop']).stdout.toString().trim().split('\n').filter(Boolean)
  if (pids.length === 0) return []
  const listed = Bun.spawnSync(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pids.join(',')]).stdout.toString()
  return [...new Set([...listed.matchAll(/127\.0\.0\.1:(\d+)/g)].map(match => Number(match[1])))]
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  // A codex session, because only `codex-runtime` starts a pool server.
  const codex = await session.call<string | undefined>(`
    const rows = await window.electronAPI.listLlmConnections()
    return (rows ?? []).find(c => c.providerType === 'codex-runtime')?.slug
  `)
  if (!codex) {
    blocked(
      'this profile lists no codex-runtime connection, and only a codex session starts an MCP pool server — there is '
      + 'nothing listening to probe. Create the Codex (Nessy Gateway) card first (RS-41 presses that button).',
    )
  }
  process.env.NESSY_CDP_CARD = codex
  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  await session.call<null>(`
    await window.electronAPI.sessionCommand(${JSON.stringify('__S__')}, { type: 'switchRuntime', connectionSlug: ${JSON.stringify(codex)} })
    return null
  `.replace('"__S__"', JSON.stringify(key.sessionId))).catch(() => null)
  await Bun.sleep(6_000)

  // ---- discovery, by the server's own signature ---------------------------
  const ports = appListeningPorts()
  const surface: Array<{ port: number; root: number; mcp: number }> = []
  for (const port of ports) {
    const root = await probe(port, '/')
    const mcp = await probe(port, '/mcp')
    surface.push({ port, root: root.status, mcp: mcp.status })
  }
  run.observe('every 127.0.0.1 port the app is listening on, and what each answered', {
    method: 'pgrep -f "Nessy Desktop" → lsof -nP -iTCP -sTCP:LISTEN -a -p <pids>, then POST / and POST /mcp per port',
    surface,
  })
  const pool = surface.filter(entry => entry.mcp === 401 && entry.root === 404)
  run.check(
    'a pool server is listening on loopback, identified by its own 404-then-401 signature',
    pool.length > 0,
    `${surface.length} loopback port(s) and none answers 404 for "/" and 401 for "/mcp": ${JSON.stringify(surface)}. `
    + 'A codex session may not have started its pool yet — the case waits 6 s after the switch',
  )
  // THE CONTROL for the signature itself: the other ports must NOT match it, or
  // "the pool server refuses" would be a statement about every loopback socket
  // the app happens to own.
  run.check(
    'THE CONTROL — the signature discriminates: at least one OTHER loopback port does not match it',
    surface.length > pool.length,
    `all ${surface.length} loopback ports match the pool-server signature, so the signature identifies nothing and `
    + 'the refusals below cannot be attributed to the pool server',
  )
  if (pool.length === 0) return

  // ---- the refusals, and the ORDERING ------------------------------------
  for (const entry of pool) {
    const noBearer = await probe(entry.port, '/mcp')
    const wrongBearer = await probe(entry.port, '/mcp', { headers: { Authorization: 'Bearer cdp-rs45-not-the-bearer' } })
    const notJson = await probe(entry.port, '/mcp', { body: 'not json at all' })
    const badSession = await probe(entry.port, '/mcp', { headers: { 'mcp-session-id': 'cdp-rs45-no-such-session' } })
    run.observe(`port ${entry.port} — the four probes`, { noBearer, wrongBearer, notJson, badSession })

    run.check(
      `port ${entry.port} — an unauthenticated request is refused 401`,
      noBearer.status === 401,
      `it answered ${noBearer.status}: ${noBearer.body}`,
    )
    run.check(
      `port ${entry.port} — a WRONG bearer is refused 401`,
      wrongBearer.status === 401,
      `it answered ${wrongBearer.status}: ${wrongBearer.body} — the comparison is length-then-timingSafeEqual, so a `
      + 'wrong value of any length must land here',
    )
    run.check(
      `port ${entry.port} — the refusal comes BEFORE the body is parsed`,
      notJson.status === 401,
      `a body that is not JSON answered ${notJson.status}: ${notJson.body}. The transport answers 400 for an `
      + 'unparseable body, so anything but 401 here means auth runs after parsing',
    )
    run.check(
      `port ${entry.port} — and BEFORE the session lookup`,
      badSession.status === 401,
      `an unknown mcp-session-id answered ${badSession.status}: ${badSession.body}. \`handleRequest\` answers 404 `
      + '"Session not found" for that, so anything but 401 here means auth runs after the lookup',
    )
  }
}

if (import.meta.main) await main(ID, TITLE, drive)

export const manual = {
  steps: [
    '1. PACKAGED build on a NESSY_CONFIG_DIR created for the run, with a Codex (Nessy Gateway) card (RS-41 presses that button).',
    '2. `bun run scripts/cdp/cases/rs-45.ts`. It creates a codex session, waits for the pool server to listen, and finds the port by the server’s own 404-for-any-other-path / 401-for-/mcp signature.',
    '3. Read the four probes per port: no bearer, a wrong bearer, a body that is not JSON, and an unknown mcp-session-id. All four must be 401.',
  ],
  expected: 'every probe answers 401 with the protocol error body, including the two whose own failures would answer differently — so the bearer check runs before the body parse and before the session lookup.',
  detector: 'the HTTP status the SHIPPED listener answers, taken from outside the app over loopback. Not a unit test, not the source, and not a log.',
  positiveControl: 'the other loopback ports the same app is listening on: at least one must NOT match the 404/401 signature, or the signature identifies nothing and the refusals cannot be attributed to the pool server.',
  doneMeans: 'DA2.5 carries a packaged reading of the bearer floor, with the ORDERING measured rather than read off the source.',
  safety: 'every request is unauthenticated by construction — the bearer is 32 random bytes per instance, the case never learns it and never tries to. Nothing sent here could be accepted.',
  neverDo: 'do not try to read the bearer out of the app to send a POSITIVE request. The floor is the subject; an authenticated call would be a second MCP client on a live session, which is not this case’s business.',
} as const satisfies SittingRecipe
