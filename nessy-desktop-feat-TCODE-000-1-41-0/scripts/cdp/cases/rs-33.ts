/**
 * RS-33 (row P6.255, open item (b)) — the FAIL-CLOSED PROXY rig, on all three
 * runtimes, on the packaged build.
 *
 * The plan row C3.54 carries the drive; P6.255 carries the mechanism, and its
 * own note ends *"Open: (b) the fail-closed rig row -> packaged sitting"*. The
 * ledger row it moves is **C12** — *"Have every runtime's HTTP traffic actually
 * follow HTTP_PROXY/HTTPS_PROXY, including Node fetch, which ignores them by
 * default"* — whose `done_means` is written out in the ledger in exactly these
 * words: *"run each runtime against a proxy that refuses everything and see
 * which still reaches the network; positive control, the same proxy blocking
 * `curl` from the same env. done_means: all three fail closed."*
 *
 * ## What "refuses everything" has to mean on a rig that still needs a model
 *
 * A proxy that refuses literally every host also refuses the session's own
 * model channel, and then no runtime can issue the shell command the row is
 * about: the case would measure its own inability to ask. So the rig exempts
 * ONE host — the gateway the cards answer from — through the product's OWN
 * `noProxy` setting, and refuses everything else. That exemption is declared to
 * the case (`NESSY_CDP_PROXY_EXEMPT`) and printed into the result, because a
 * reader who does not know which host was let through cannot tell a fail-closed
 * verdict from a rig that let the probe host through too.
 *
 * The probe host is therefore never the exempt one, and the case refuses to run
 * if it is.
 *
 * ## The three readings per runtime, which answer different questions
 *
 * | Reading | Shell | What it settles |
 * | --- | --- | --- |
 * | the ENV arm | `env \| grep -i proxy` | did the projection reach the child at all — `HTTPS_PROXY` present, and `NODE_USE_ENV_PROXY=1`, the name P6.255 added |
 * | the CURL arm | `curl … https://<probe>` | the generic client: refused, or a live status code |
 * | the NODE arm | `node -e "fetch(…)"` | the one Node 24 un-proxies unless `NODE_USE_ENV_PROXY` is set — the whole reason C12 exists |
 *
 * An env arm that comes back empty makes the other two uninterpretable, and the
 * case says so rather than scoring a refusal it cannot attribute.
 *
 * ## The detector is the PROXY'S OWN LOG, not the command's exit code
 *
 * A command that fails proves nothing on its own: a host that cannot resolve, a
 * DNS hiccup and a proxy refusal are the same non-zero exit. The rig's log
 * records one line per request with the host and the verdict, and it is written
 * by the proxy — a source neither the app nor the model can touch. So "fail
 * closed" means: the probe host APPEARS in the proxy log with a refusing
 * verdict inside this runtime's own window, and the command did not come back
 * with a live status.
 *
 * The inverse is the finding: a probe that SUCCEEDS with no line in the log at
 * all went straight out, past a proxy the operator configured — that is the
 * fail-OPEN this row exists to catch.
 *
 * ## The positive control the row names, run FIRST
 *
 * `curl` through the same proxy from this case's own process. It must be
 * refused AND it must leave a line in the log. Without it, every absence below
 * is equally true of a proxy that is not running, a log path nobody writes, and
 * a rig that was never wired up — and the case BLOCKS instead of scoring.
 *
 * ## Safety
 *
 * The proxy is the lane's own, on 127.0.0.1, and forwards nothing while it is
 * in refusing mode. The probe host is a public example domain. Nothing here
 * reads, prints or writes a credential: the gateway exemption is a HOSTNAME,
 * and the `env` arm's output is filtered to the proxy names before it is
 * recorded.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveAppUnderTest } from '../lib/bundle.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { bindProject, listConnections, runtimeOf, switchRuntime, trustScratchProject, waitForConnection } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, setPermissionMode, transcript, type SessionKey } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-33'
const TITLE = 'every runtime against a proxy that refuses everything — which of them still reaches the network'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.255',
  runtimes: ['pi', 'claude', 'codex'],
  credentials:
    'owner: one card per runtime, already signed in, all three answering from the SAME gateway host — that host is the '
    + 'one the rig exempts so a turn can still be issued, and it is named to the case as a hostname (never a key, never a '
    + 'token). The proxy is the lane\'s own on 127.0.0.1 and forwards nothing while it refuses.',
} as const satisfies CaseMeta

/** The host the probes aim at: public, unrelated to the product, never the exempt one. */
const PROBE_HOST = process.env.NESSY_CDP_PROBE_HOST ?? 'example.com'

/**
 * One shell command, so one turn answers all three arms of a runtime.
 *
 * ## It is ONE LINE and carries no backslash, and that is load-bearing
 *
 * The first version of this command spanned several lines and used
 * `-w 'curl_code=%{http_code}\\n'`. Measured 2026-09-12 (rig day, lane R2), the
 * pi arm died before the turn with `composer-mismatch: meant to send …` — the
 * harness types every character as a real key event and then asserts the composer
 * holds what it meant to send, and neither a newline nor a backslash survives
 * that round trip in a contenteditable whose Enter key is SEND. The failure looks
 * like a product fault (a turn that never settles) and is entirely the prompt's.
 *
 * So: one line, no `\n` inside a `-w` format, no escapes. The two outputs are
 * captured into shell variables and echoed as `curl_code=` / `node_out=`, which
 * is also what makes them parseable from the tool result.
 */
function probeCommand(): string {
  return [
    `env | grep -iE '(_proxy|NODE_USE_ENV_PROXY)' | sort`,
    `c=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 25 https://${PROBE_HOST} 2>&1)`,
    `echo "curl_code=$c"`,
    `n=$(node -e "fetch('https://${PROBE_HOST}').then(r=>console.log('NODE_REACHED '+r.status)).catch(e=>console.log('NODE_REFUSED '+(e.cause?e.cause.message:e.message)))" 2>&1 | tail -1)`,
    `echo "node_out=$n"`,
  ].join('; ')
}

interface ProxyLine { t: string; kind: string; host: string; verdict: string }

/** Every line the rig's proxy has written so far, parsed. */
function proxyLog(path: string): ProxyLine[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as ProxyLine)
  } catch { return [] }
}

/** A refusing verdict is anything the rig spells as a denial; `forward` is not one. */
function refusing(line: ProxyLine): boolean {
  return line.verdict.startsWith('deny')
}

interface ArmReading {
  runtime: string
  card: string
  /** The proxy names the child actually received, filtered to the proxy family. */
  envSeen: string[]
  nodeEnvProxy: boolean
  curl: string
  node: string
  /** Proxy-log lines naming the probe host inside this runtime's own window. */
  probeLines: ProxyLine[]
  /**
   * `unproxied-egress` is the fourth value and it is a FINDING, not a null.
   *
   * `uninterpretable` used to carry two facts that need different answers.
   * Measured 2026-09-12 (R7) on the packaged 1.37.0 against a proxy refusing
   * everything, with the SAME proxy refusing this process's own `curl`
   * (exit 56, `CONNECT tunnel failed, response 403`, logged): codex's shell saw
   * no proxy name AND did not reach the network (`Could not resolve host`), 0
   * proxy-log lines — its own sandbox denied the egress and the proxy is not
   * why, which is genuinely uninterpretable for C12. Pi's shell saw no proxy
   * name and **reached the public internet**: `curl_code=200`,
   * `node_out=NODE_REACHED 200`, and 0 proxy-log lines for the probe host. The
   * second is not "we cannot tell"; it is "the operator's proxy did not reach
   * this child and egress happened anyway", which is the thing C12 exists to
   * catch. It deliberately does NOT say the child bypassed an instruction — it
   * received none — it says the projection is missing and the network is open.
   */
  verdict: 'fail-closed' | 'fail-open' | 'unproxied-egress' | 'uninterpretable'
  /** Tool calls the turn made — what separates "no turn" from "the env was filtered". */
  toolCalls: number
}

/** The text a turn produced, tool results included — never the model's summary alone. */
async function turnText(session: CdpSession, key: SessionKey): Promise<{ text: string; toolCalls: number }> {
  const messages = await transcript(session, key)
  return {
    text: messages.map(m => `${m.toolResult ?? ''}\n${m.content ?? ''}`).join('\n'),
    // An empty env arm has TWO causes and they need different fixes: the turn
    // never ran a tool at all (an unauthenticated card, a model that declined),
    // or it ran one and the runtime filtered the variables out of the shell's
    // environment. Measured 2026-09-12 (lane R6b): the pi arm is the first —
    // `pi-api-key` answers `auth-request` while the dp CLI session is lapsed —
    // and the codex arm needs this count to be told apart from it. RS-02 already
    // carries the same third-outcome discipline for the same reason.
    toolCalls: messages.filter(m => typeof m.toolName === 'string' && m.toolName.length > 0).length,
  }
}

function firstMatch(haystack: string, pattern: RegExp): string {
  return haystack.match(pattern)?.[0] ?? ''
}

async function driveArm(
  session: CdpSession,
  run: CaseRun,
  runtime: string,
  card: string,
  root: string,
  logPath: string,
): Promise<ArmReading> {
  const before = proxyLog(logPath).length

  const key = await freshSession(session, `CDP ${ID} ${runtime} ${new Date().toISOString().slice(11, 19)}`)
  run.check(`${runtime}: ran in a session it created`, key.fresh,
    key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)
  await switchRuntime(session, key.sessionId, card)
  await waitForConnection(session, key.sessionId, card)
  await bindProject(run, session, key.sessionId, root, {
    label: runtime, gate: () => trustScratchProject(session, root),
  })

  // bypassPermissions, deliberately: the subject is the NETWORK, and a
  // permission card standing between the model and its shell would turn every
  // reading below into a reading of the approval surface instead. The command
  // is read-only and aimed at a public host.
  await setPermissionMode(session, key.sessionId, 'bypassPermissions')
    .catch(error => run.observe(`${runtime}: posture`, `refused: ${String(error)}`))

  await sendPrompt(
    session,
    key,
    'Run this exact command with your shell tool, once, and paste its complete output back to me verbatim '
    + `without editing it: ${probeCommand()}`,
    300_000,
  ).catch(error => run.observe(`${runtime}: the turn did not settle`, String(error)))

  const { text, toolCalls } = await turnText(session, key)
  const envSeen = [...text.matchAll(/^\s*((?:https?|all|no)_proxy|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NODE_USE_ENV_PROXY)=/gmi)]
    .map(m => m[1]!).filter((v, i, a) => a.indexOf(v) === i)
  const nodeEnvProxy = /NODE_USE_ENV_PROXY=1/.test(text)
  // The curl line is recorded WHOLE rather than reduced to three digits: with a
  // CONNECT tunnel refused at the proxy, `%{http_code}` is `000` and the reason
  // is in the stderr this command merges into the same variable — which is the
  // sentence the narrative wants. Only a literal `200` counts as having reached
  // the probe host.
  // `(?!\$)` on both, and it is the whole of this reading's honesty: the
  // transcript ECHOES the probe command, and the command spells `curl_code=$c`
  // and the literal string `NODE_REACHED` inside the `node -e` body. Measured
  // 2026-09-12 (lane R6b) driving C3.54 on the packaged build: the claude arm
  // received all seven proxy names plus `NODE_USE_ENV_PROXY=1` and the proxy's
  // own log carried TWO `example.com` `deny-all` CONNECT lines inside its
  // window — it FAILED CLOSED — and this case scored it `fail-open` off its own
  // command text, while both observation strings came back as that command.
  // A detector that matches its own probe is a dead control.
  const curl = firstMatch(text, /curl_code=(?!\$)[^\n]{0,160}/) || '(no curl line)'
  const node = firstMatch(text, /node_out=(?!\$)[^\n]{0,160}/) || '(no node line)'

  const probeLines = proxyLog(logPath).slice(before).filter(line => line.host === PROBE_HOST)
  const reachedLive = /curl_code=\s*200\b/.test(text) || /node_out=\s*NODE_REACHED/.test(text)
  const verdict: ArmReading['verdict'] = envSeen.length === 0
    ? (reachedLive && probeLines.length === 0 ? 'unproxied-egress' : 'uninterpretable')
    : reachedLive ? 'fail-open' : 'fail-closed'

  return { runtime, card, envSeen, nodeEnvProxy, curl, node, probeLines, verdict, toolCalls }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const app = resolveAppUnderTest(session)
  run.observe('app under test', { kind: app.kind, via: app.via })
  run.check('the artefact under test is the PACKAGED app', app.kind === 'packaged',
    app.kind === 'packaged' ? undefined : `kind=${app.kind} — a dev build is not the shipped artefact`)

  const logPath = process.env.NESSY_CDP_PROXY_LOG
  const proxyUrl = process.env.NESSY_CDP_PROXY_URL
  const exempt = process.env.NESSY_CDP_PROXY_EXEMPT
  if (!logPath || !proxyUrl) {
    blocked(
      'this case needs the lane\'s own refusing proxy: NESSY_CDP_PROXY_URL (e.g. http://127.0.0.1:8899) and '
      + 'NESSY_CDP_PROXY_LOG (its JSONL log), with the PACKAGED app launched against a config dir whose '
      + '`networkProxy` names that same proxy. Without the log there is no detector, and a refusal cannot be told '
      + 'from a host that simply did not resolve.',
    )
  }
  run.observe('the rig', { proxy: proxyUrl, log: logPath, exemptHost: exempt ?? '(none declared)', probeHost: PROBE_HOST })
  if (exempt && (PROBE_HOST === exempt || PROBE_HOST.endsWith(`.${exempt}`))) {
    blocked(`the probe host ${PROBE_HOST} is the exempt host — the rig would measure the exemption, not the proxy`)
  }

  // THE POSITIVE CONTROL, first and load-bearing: the same proxy, the same
  // probe host, from this process. It must refuse AND it must say so in the log.
  const controlBefore = proxyLog(logPath!).length
  const control = Bun.spawnSync(
    ['curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '25', `https://${PROBE_HOST}`],
    { env: { ...process.env, HTTPS_PROXY: proxyUrl!, https_proxy: proxyUrl!, HTTP_PROXY: proxyUrl!, http_proxy: proxyUrl! } },
  )
  const controlOut = `${control.stdout.toString().trim()} ${control.stderr.toString().trim()}`.trim()
  const controlLines = proxyLog(logPath!).slice(controlBefore).filter(line => line.host === PROBE_HOST)
  run.observe('THE POSITIVE CONTROL — curl through the same proxy, from this process',
    { exitCode: control.exitCode, output: controlOut.slice(0, 200), loggedLines: controlLines })
  const controlRefused = control.exitCode !== 0 || controlLines.some(refusing)
  run.check(
    'THE POSITIVE CONTROL — the same proxy refuses curl from the same environment, and its log says so',
    controlRefused && controlLines.length > 0,
    controlRefused && controlLines.length > 0 ? undefined
      : `the rig is not refusing (exit ${control.exitCode}, ${controlLines.length} logged lines) — every `
        + 'fail-closed verdict below would be unearned',
  )
  if (!(controlRefused && controlLines.length > 0)) {
    blocked('the refusing proxy is not in the path: start it, point the app\'s `networkProxy` at it, relaunch')
  }

  const connections = await listConnections(session)
  const cards = {
    pi: connections.find(row => runtimeOf(row.providerType) === 'pi')?.slug,
    claude: connections.find(row => runtimeOf(row.providerType) === 'anthropic')?.slug,
    codex: connections.find(row => runtimeOf(row.providerType) === 'codex-runtime')?.slug,
  }
  run.observe('cards', cards)
  if (!cards.pi || !cards.claude || !cards.codex) {
    blocked(
      'C12 is a three-runtime cell and `done_means` is "all three fail closed" — a two-runtime run cannot answer it. '
      + 'Missing: ' + [!cards.pi && 'pi', !cards.claude && 'claude', !cards.codex && 'codex'].filter(Boolean).join(', '),
    )
  }

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-rs33-')))
  run.observe('probe working directory', root)
  try {
    const readings: ArmReading[] = []
    for (const [runtime, card] of [['pi', cards.pi], ['claude', cards.claude], ['codex', cards.codex]] as const) {
      readings.push(await driveArm(session, run, runtime, card, root, logPath!))
    }
    run.observe('readings', readings)

    for (const reading of readings) {
      run.check(
        `${reading.runtime}: the proxy projection reached the child at all`,
        reading.envSeen.length > 0,
        reading.envSeen.length > 0 ? undefined
          : reading.toolCalls === 0
            ? 'the turn made NO TOOL CALL, so the shell was never reached and nothing about the projection was '
              + 'measured — an unauthenticated card or a model that declined, never a filtered environment'
            : `the turn made ${reading.toolCalls} tool call(s) and the shell STILL saw no proxy variable, so the `
              + 'runtime filtered them out of the shell environment it built — a refusal here cannot be attributed '
              + 'to the proxy and a success cannot be called a bypass',
      )
      run.observe(`${reading.runtime}: tool calls in the probe turn`, reading.toolCalls)
      run.observe(`${reading.runtime}: NODE_USE_ENV_PROXY reached the child`, reading.nodeEnvProxy)
      run.check(
        `${reading.runtime}: FAILS CLOSED against a proxy that refuses everything`,
        reading.verdict === 'fail-closed',
        reading.verdict === 'fail-closed' ? undefined
          : reading.verdict === 'unproxied-egress'
            ? `UNPROXIED EGRESS — the shell received no proxy name at all and still reached ${PROBE_HOST}: `
              + `curl ${reading.curl}, node ${reading.node}, and ${reading.probeLines.length} proxy-log line(s), `
              + 'so the traffic did not cross the proxy the app is configured to use. This is not "we cannot '
              + 'tell": the projection is missing and the network is open'
            : `verdict ${reading.verdict} — curl ${reading.curl}, node ${reading.node}, `
              + `${reading.probeLines.length} proxy-log line(s) for ${PROBE_HOST}`,
      )
    }

    run.observe('C12 verdict, per runtime', Object.fromEntries(readings.map(r => [r.runtime, r.verdict])))
  } finally {
    rmSync(root, { recursive: true, force: true })
    run.observe('probe working directory removed', root)
  }
}

/**
 * The arm a driver must not perform, and the rig recipe the narrative records.
 */
export const manual = {
  steps: [
    '1. Start the lane\'s OWN forward proxy on 127.0.0.1 in refusing mode, logging one JSONL line per request with the host and the verdict. Never a real proxy, never an upstream the lane does not own.',
    '2. Write the app\'s `networkProxy` into the run\'s config dir: `enabled: true`, `httpProxy`/`httpsProxy` = that proxy, and `noProxy` = the gateway host the cards answer from (the app adds the loopback hosts itself and says so in its own startup line).',
    '3. Launch the PACKAGED build against that config dir. A dev build runs main and Pi from built bundles and is not the shipped artefact.',
    '4. Export NESSY_CDP_PROXY_URL, NESSY_CDP_PROXY_LOG and NESSY_CDP_PROXY_EXEMPT, then run this case.',
    '5. Tear the proxy down and remove the `networkProxy` block when the row is answered.',
  ],
  expected: 'per runtime: the proxy variables present in the child, NODE_USE_ENV_PROXY=1, and both probes refused with the proxy\'s own log naming the probe host — "all three fail closed". A probe that SUCCEEDS with no log line is the fail-open finding.',
  detector: 'the rig proxy\'s own JSONL log — a source neither the app nor the model can write — sliced to the window of each runtime\'s turn, plus the command\'s own printed `curl_code=` / `NODE_REACHED|NODE_REFUSED` line read out of the tool result rather than out of the model\'s summary.',
  positiveControl: '`curl` to the same probe host through the same proxy from the case\'s own process, before any runtime is driven: it must be refused AND leave a line in the log. The case BLOCKS when it is not, because a proxy that is not running produces the same silence as a runtime that fails closed.',
  doneMeans: 'C12 x3 carries a driven verdict; on all three fail-closed the cells move with the twin row following, and anything else is recorded as measured.',
  neverDo: 'Do not point the rig at a proxy the lane does not own, and do not exempt the probe host — the case refuses to run if the probe host is the exempt one, because that rig would measure its own exemption.',
  safety: 'the proxy forwards nothing while refusing; the `env` arm is filtered to the proxy names before anything is recorded, so no unrelated environment value is quoted into a run narrative.',
} as const satisfies SittingRecipe

if (import.meta.main) await main(ID, TITLE, drive)
