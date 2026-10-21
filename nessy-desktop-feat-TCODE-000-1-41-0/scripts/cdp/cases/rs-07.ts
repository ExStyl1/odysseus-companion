/**
 * RS-07 (row P6.150) — does an APPROVED Bash command reach the network, on Pi
 * and on claude, in the shipped default?
 *
 * Ledger J11/pi and J11/claude, both `—`: never measured, on either runtime. One
 * rig, one sitting, two arms — and they must be the SAME sitting, because two
 * readings hours apart on a laptop that changed networks measure the network
 * rather than the runtime.
 *
 * ## Nothing to build, and the code prior is strong
 *
 * Pi's own mechanism is present and wired: `denyNetworkEgress` is threaded
 * through the process supervisor into all three platform profiles, and on
 * Windows it is written as codex's OWN `[permissions.<profile>.network]` block.
 * There is no claude-specific egress control — the tree's only network gate
 * structurally does not apply to claude — and `sandboxing.md` documents the
 * sandbox, not a per-runtime network switch. Both runtimes share
 * `bash-seatbelt.ts`, where `SEATBELT_TESTING_WILDCARD = true` makes the opt-in
 * wrapper emit `(allow default)`, and egress denial is profile-scoped. The
 * shipped default has the sandbox master switch OFF. So the strong prior is
 * `covered` on both cells — the network is reachable — and this run is what
 * turns a prior into a verdict.
 *
 * ## The three controls, and the one that inverts the whole reading
 *
 * 1. **THE HOST SHELL, AT THE SAME MOMENT.** The same two commands, run by this
 *    case's own process, in the same minute. A corporate proxy denying both
 *    would make a refusal inside the agent look like a runtime policy when it is
 *    the office network. This control runs FIRST and its failure blocks the case
 *    rather than colouring it.
 * 2. **THE RESOLVER.** `dscacheutil -q host example.com`, recorded with its exit
 *    code, because this whole row is about a denial that reads as a resolver
 *    fault.
 * 3. **THE MASTER SWITCH.** A second session with the sandbox ON, which must
 *    DIFFER if the switch does anything. It is in `manual` below: the switch is
 *    off by standing owner decision, and a case that died mid-run would leave it
 *    on.
 *
 * ## Approval is part of the subject, not a nuisance
 *
 * The row says "an APPROVED Bash command". `approvePermissionsWhile` answers the
 * ordinary tool-permission card with a real mouse click — never an in-page
 * `.click()`, which was measured removing the card from the DOM while leaving
 * the request unanswered in the backend — and the count it approved is recorded,
 * so a run where nothing was ever asked is visible rather than assumed.
 *
 * ## The reading is the command's OWN output, not the model's summary
 *
 * `curl -w '%{http_code}'` prints three digits and nothing else, and
 * `git ls-remote` prints a sha and a ref. Both are read out of the tool result.
 * "The model said it worked" is not evidence, and on this row it is the exact
 * shape of a wrong answer: a model that cannot reach the network is perfectly
 * capable of describing what the page would have said.
 */

import { resolveAppUnderTest } from '../lib/bundle.ts'
import { approvePermissionsWhile } from '../lib/ask-user.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { listConnections, runtimeOf, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, transcript, type SessionKey } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-07'
const TITLE = 'An approved Bash command reaches the network on Pi and on claude, measured against the host shell'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.150',
  runtimes: ['pi', 'claude'],
  credentials: 'owner: a claude-runtime card, already signed in. The two probe commands reach only '
    + 'example.com and a public git repository.',
} as const satisfies CaseMeta

/** Prints exactly three digits and nothing else, so the result parses cleanly. */
const HTTP_PROBE = "curl -sS -o /dev/null -w '%{http_code}' https://example.com"
/** A second protocol on a second host, so one blocked port is not the whole answer. */
const GIT_PROBE = 'git ls-remote https://github.com/openai/codex HEAD'
/** The resolver, because a denial here reads exactly like a policy refusal. */
const DNS_PROBE = ['dscacheutil', '-q', 'host', 'example.com']

interface HostReading {
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
}

async function hostRun(command: string[], label: string): Promise<HostReading> {
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  await child.exited
  return { command: label, exitCode: child.exitCode, stdout: stdout.slice(0, 400).trim(), stderr: stderr.slice(0, 400).trim() }
}

interface AgentProbe {
  prompt: string
  toolCalls: { tool: string; status?: string; result: string }[]
}

async function agentRun(session: CdpSession, key: SessionKey, command: string): Promise<AgentProbe> {
  const before = (await transcript(session, key)).length
  await sendPrompt(
    session,
    key,
    `Please run this shell command exactly as written and quote its complete output back to me: ${command}`,
    300_000,
  ).catch(() => undefined)
  const added = (await transcript(session, key)).slice(before)
  return {
    prompt: command,
    toolCalls: added
      .filter(message => typeof message.toolName === 'string' && message.toolName.length > 0)
      .map(message => ({
        tool: message.toolName!,
        status: message.toolStatus,
        // Bounded: these are HTTP codes and git refs, not documents.
        result: (message.toolResult ?? '').slice(0, 500),
      })),
  }
}

interface ArmReading {
  runtime: string
  card: string
  approvals: number
  http: AgentProbe
  git: AgentProbe
  httpReached: boolean
  gitReached: boolean
}

async function driveArm(session: CdpSession, run: CaseRun, runtime: string, card: string): Promise<ArmReading> {
  const key = await freshSession(session, `CDP ${ID} ${runtime} ${new Date().toISOString().slice(11, 19)}`)
  run.check(`${runtime}: the arm ran in a session it created`, key.fresh,
    key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)
  const moved = await switchRuntime(session, key.sessionId, card)
  run.observe(`${runtime} — switch onto ${card}`, moved)
  run.require(`${runtime}: the session reports ${card}`,
    (await waitForConnection(session, key.sessionId, card)) === card, card)

  const approver = approvePermissionsWhile(session, key.sessionId)
  let http: AgentProbe
  let git: AgentProbe
  let approvals = 0
  try {
    http = await agentRun(session, key, HTTP_PROBE)
    git = await agentRun(session, key, GIT_PROBE)
  } finally {
    approvals = await approver.stop()
  }
  run.observe(`${runtime} — permission cards approved`, approvals)
  run.observe(`${runtime} — http probe`, http.toolCalls)
  run.observe(`${runtime} — git probe`, git.toolCalls)

  const httpText = http.toolCalls.map(call => call.result).join('\n')
  const gitText = git.toolCalls.map(call => call.result).join('\n')
  return {
    runtime,
    card,
    approvals,
    http,
    git,
    // A three-digit code in the 2xx/3xx/4xx/5xx range is proof the request left
    // and something answered. `000` is curl's own "could not connect".
    httpReached: /\b[2-5]\d{2}\b/.test(httpText) && !/\b000\b/.test(httpText),
    // A 40-hex sha beside a ref is proof the remote answered.
    gitReached: /\b[0-9a-f]{40}\b/.test(gitText),
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const app = resolveAppUnderTest(session)
  run.observe('app under test', { kind: app.kind, via: app.via })
  run.check('the artefact under test is the PACKAGED app', app.kind === 'packaged',
    app.kind === 'packaged' ? undefined : `kind=${app.kind} — the shipped default is the subject`)

  // ---- Control 1, FIRST: the host shell at this moment ----------------------
  const hostHttp = await hostRun(['sh', '-c', HTTP_PROBE], HTTP_PROBE)
  const hostGit = await hostRun(['sh', '-c', GIT_PROBE], GIT_PROBE)
  const hostDns = await hostRun(DNS_PROBE, DNS_PROBE.join(' '))
  run.observe('host shell — http', hostHttp)
  run.observe('host shell — git', hostGit)
  run.observe('host shell — resolver', { exitCode: hostDns.exitCode, stdout: hostDns.stdout.slice(0, 200) })
  const hostHttpOk = /\b[2-5]\d{2}\b/.test(hostHttp.stdout) && !/\b000\b/.test(hostHttp.stdout)
  const hostGitOk = /\b[0-9a-f]{40}\b/.test(hostGit.stdout)
  if (!hostHttpOk || !hostGitOk) {
    blocked(
      'THE CONTROL FAILED: this machine\'s own shell could not reach '
      + `${!hostHttpOk ? 'example.com' : ''}${!hostHttpOk && !hostGitOk ? ' or ' : ''}${!hostGitOk ? 'the git remote' : ''} `
      + 'at this moment, so a refusal inside the agent would be indistinguishable from the office network. '
      + `curl said "${hostHttp.stdout || hostHttp.stderr}"; git exited ${hostGit.exitCode}. `
      + `The resolver answered exit ${hostDns.exitCode}. Re-run from a network that reaches both.`,
    )
  }
  run.check('THE CONTROL — this machine\'s own shell reaches both hosts right now', true)

  const connections = await listConnections(session)
  const piCard = connections.find(row => runtimeOf(row.providerType) === 'pi')?.slug
  const claudeCard = connections.find(row => runtimeOf(row.providerType) === 'anthropic')?.slug
  run.observe('cards', { pi: piCard, claude: claudeCard })
  if (!piCard || !claudeCard) {
    blocked(
      'both arms belong to ONE sitting, so both cards must be on this host: '
      + `${!piCard ? 'no Pi card; ' : ''}${!claudeCard ? 'no claude-runtime card; ' : ''}`
      + `the host lists ${connections.map(row => `${row.slug}(${row.providerType})`).join(', ') || 'nothing'}.`,
    )
  }

  const arms = [
    await driveArm(session, run, 'pi', piCard),
    await driveArm(session, run, 'claude', claudeCard),
  ]

  for (const arm of arms) {
    run.check(
      `${arm.runtime}: the Bash tool ran at all`,
      arm.http.toolCalls.length > 0 || arm.git.toolCalls.length > 0,
      'no tool call in either probe — the model answered without running anything, and nothing about the '
      + 'network can be read from this arm',
    )
    run.observe(`${arm.runtime} — VERDICT`, {
      http: arm.httpReached ? 'reached the network' : 'did NOT reach the network',
      git: arm.gitReached ? 'reached the network' : 'did NOT reach the network',
    })
  }

  const [pi, claude] = arms as [ArmReading, ArmReading]
  run.observe(
    'the shellNetwork switch-cost sentence this pair decides',
    pi.httpReached === claude.httpReached && pi.gitReached === claude.gitReached
      ? 'Pi and claude AGREE on the shipped default — the switch copy says "nothing changes"'
      : 'Pi and claude DIFFER on the shipped default — the switch copy owes "you lose the network", '
        + `pi=${pi.httpReached}/${pi.gitReached} claude=${claude.httpReached}/${claude.gitReached}`,
  )
}

/**
 * The master-switch control. Run it after the arm above, whichever way that went:
 * if both runtimes reached the network, this says whether the switch can stop
 * them; if one did not, this says whether the switch is why.
 */
export const manual = {
  why: 'control (2) of P6.150 — the sandbox master switch, which a case does not flip',
  steps: [
    'Note the verdicts the automated run recorded.',
    'Quit the packaged app. Turn the isolation master switch (sandbox.enabled) ON. Relaunch.',
    'Re-run this case: bun run scripts/cdp/cases/rs-07.ts — the host controls re-run with it, which is the point.',
    'Turn the switch back OFF and relaunch: it is OFF by standing owner decision (2026-08-12/13).',
  ],
  expected: 'with the switch OFF both runtimes reach the network (the strong code prior); with it ON the '
    + 'reading must DIFFER on at least one probe, or the switch does nothing here',
  detector: 'the command\'s own output inside the tool result — a 2xx-5xx HTTP code, a 40-hex git sha — '
    + 'never the model\'s summary of it',
  positiveControl: 'the same two commands in the host shell in the same minute, which BLOCK the case when '
    + 'they fail rather than colouring the verdict',
  doneMeans: 'both ledger J11 cells carry a verdict with a marker better than s, and the shellNetwork switch '
    + 'row states the real Pi-claude-codex difference instead of guessing it',
} as const satisfies SittingRecipe

if (import.meta.main) await main(ID, TITLE, drive)
