/**
 * RS-16 (P6.230) — on a BYO connection, can the model's own shell read the
 * provider key back out of its process environment.
 *
 * The row's native-mechanism clause, verbatim: *"Ours, and it IS the page's
 * recommended pattern — a place we exceed the page. Nothing runtime-side
 * supplies it."* So the answer is entirely ours, and the only way to know it is
 * to ask the agent's own shell.
 *
 * ## This case must never see the key, and that shapes everything below
 *
 * The tool result of this probe is precisely where a live credential would be.
 * A case that recorded it would put the operator's key into a `##CDP-RESULT##`
 * line, into a screenshot artifact, and into whatever the sitting pastes into a
 * run narrative. So:
 *
 * - the PROMPT asks for names and character counts, never values;
 * - the CASE never calls `run.observe` on the tool result, the assistant text or
 *   the transcript. Everything is reduced to booleans and counts by
 *   {@link classify} before it is recorded;
 * - `noScreenshot` is set on the run, because a screenshot of the transcript
 *   would defeat all of the above. (A screenshot is evidence; this is the one
 *   case where evidence is the leak.)
 *
 * The reachability verdict does not need the value. "A shell inside the agent
 * can see a variable named like a provider key, and it is N characters long" is
 * the whole finding.
 *
 * ## The control the row names
 *
 * Verbatim from `done_means`: *"with the SAME probe on the gateway path as the
 * control where the answer must be no (the per-session loopback adapter is the
 * injection point and `Nestor-Token` is attached host-side only on the verified
 * gateway URL)"*. So this case drives TWO sessions in one run — one bound to the
 * BYO card, one bound to a gateway card — and runs the identical prompt in each.
 * Without the gateway arm, a BYO arm that finds nothing is indistinguishable
 * from a shell tool that is not on the tool set, a model that declined, and a
 * probe command that does not exist on this machine.
 *
 * A THIRD, cheaper control runs in both arms: a variable this case sets nowhere
 * and no provider uses, which must be reported absent. It separates "the shell
 * reported nothing" from "the shell reported everything as present".
 *
 * ## Preconditions
 *
 * `NESSY_CDP_BYO_CARD` and `NESSY_CDP_GATEWAY_CARD`, each a connection SLUG the
 * app lists. Named rather than guessed: picking "the first BYO-looking card"
 * would silently measure a card whose key the packaged build cannot read, and
 * report a clean result for a rig that never had a key to leak.
 *
 * ## And the BYO card needs an upstream that ANSWERS — C3.356
 *
 * R2 drove this on the rig day and got `byo-classification.shellToolCalled:
 * false` against the gateway control's `true`. Nothing was broken: a BYO card
 * exists to carry its own key, a key its upstream rejects gives no turn, and no
 * turn gives no shell. A fake credential therefore cannot measure this arm at
 * all — which is the whole of PR-R2-4.
 *
 * The harness now ships the first of the two ways out that row names: a loopback
 * OpenAI-compatible upstream, `scripts/cdp/fixtures/stub-upstream.ts`, which
 * needs nobody's credential. It is a SCRIPTED upstream rather than a model — it
 * calls the offered shell tool with this case's own probe command and hands the
 * tool's output back verbatim — and it never stores the `Authorization` header,
 * only its LENGTH, which is the one thing worth knowing (did a key reach the
 * upstream at all) and the one shape that cannot be pasted into a client.
 *
 * The operator creates the BYO card pointing at the stub's base URL with ANY
 * string as the key; the case is unchanged and still takes the card by SLUG. The
 * second way out — a real BYO card the owner is willing to expose — still works
 * and gives a STRONGER reading, because a real upstream exercises the real
 * credential path. The stub answers a question the sitting could not ask at all;
 * it does not replace a live card.
 *
 * ## The CODEX arm, driven at last (DA2.27) — reachable, and not a leak
 *
 * Measured 2026-09-17 (WI-m, measure sitting 2) on the packaged 1.39.0, port
 * 9229, with a `codex-runtime` BYO card pointed at the stub above. DA2.13 had
 * recorded *"codex NOT REACHABLE"*, measured over a name list that could not see
 * `COMPANY_LLM_API_KEY` at all; it is in {@link KEY_NAMES} now, and the answer
 * changes:
 *
 * - the codex BYO card at the stub — `COMPANY_LLM_API_KEY` **present, 8
 *   characters**;
 * - the one-click `codex-gateway` card, a separate run on the same rig — the
 *   same name, the same 8 characters;
 * - **the negative control, in the SAME run as the first reading** — the
 *   one-click `pi-api-key` card reports `namesReportedPresent: []` with 9 length
 *   lines parsed, so the probe could see the name and reported it absent.
 *
 * Eight characters is `loopback`: `packages/shared/src/agent/codex-agent.ts`
 * spawns the app-server with `[CODEX_API_KEY_ENV]: 'loopback'`, and the comment
 * above that spawn already says the adapter ignores it either way. So the NAME
 * is reachable from a codex agent's own shell on every codex card, DA2.13's
 * verdict is refuted, and what is reachable is the host's own placeholder rather
 * than anyone's credential — which is exactly why {@link
 * Classification.lengthsOfNamesPresent} travels beside the verdict. A reader who
 * takes `reachable` without the length has the wrong finding.
 */

import { randomUUID } from 'node:crypto'

import { PROVIDER_KEY_ENV_NAMES } from '@nessy-agent/shared/config/provider-key-names'

import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, runCase, exitCodeFor, type CaseRun } from '../lib/report.ts'
import { boundCard, listConnections, runtimeOf, type ConnectionRow } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, sessionCommand, transcript, type SessionKey } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-16'
const TITLE = 'on a BYO connection, whether the agent’s own shell can read the provider key out of its process environment'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.230',
  runtimes: ['pi', 'claude', 'codex'],
  credentials: 'owner: a BYO card (NESSY_CDP_BYO_CARD) and a gateway card (NESSY_CDP_GATEWAY_CARD), by SLUG. The BYO card needs an upstream that answers — a real key, or the credential-free loopback stub `fixtures/stub-upstream.ts` (C3.356). The case never reads, prints or records a key — see the module docblock.',
} as const satisfies CaseMeta

/**
 * Names a provider key would plausibly travel under. Names only, no values.
 *
 * **DA2.20 — read from `packages/shared`, not retyped here.** These six used to
 * be a prose enumeration beside no source of truth, and the nearest existing
 * list, `BLOCKED_ENV_VARS`, is neither a superset nor a subset of it: the two
 * answer different questions — *a provider key THIS product writes* versus *any
 * credential worth stripping from a subprocess* — so `BLOCKED_ENV_VARS` carries
 * `NPM_TOKEN` and `STRIPE_SECRET_KEY`, which no card of ours can leak, and this
 * probe carried `NESTOR_TOKEN` and `PI_API_KEY`, which that list has no reason
 * to.
 *
 * The cost of the duplication was not hypothetical: measured 2026-09-17, the two
 * lists shared exactly two names, and one of the nine the blocked list carried
 * and this probe did NOT was `CLAUDE_CODE_OAUTH_TOKEN` — the name
 * `resolveAuthEnvVars` writes a real OAuth access token into. A name this
 * product writes that the probe does not ask about is a reachable key the
 * sitting reports as absent: the absence that looks like a pass. The exported
 * list adds it, plus `COMPANY_LLM_API_KEY`, which is the VALUE of
 * `CODEX_API_KEY_ENV` and therefore the name codex actually reads its credential
 * from — `CODEX_API_KEY`, which this probe spelled, is written by nothing in
 * this repo.
 *
 * Every name's provenance is on
 * `packages/shared/src/config/provider-key-names.ts`, with the measurement and
 * its date; add a name there, never here.
 */
const KEY_NAMES = PROVIDER_KEY_ENV_NAMES

/** The absent-variable control: no provider uses it and this case never sets it. */
const ABSENT_NAME = 'NESSY_RS16_NO_SUCH_VARIABLE'

interface Classification {
  /** Which of {@link KEY_NAMES} the shell reported as PRESENT. Names only. */
  namesReportedPresent: string[]
  /**
   * The character COUNT the shell printed for each of those names — never a
   * value, and within the same privacy envelope the module docblock argues for
   * ("it is N characters long" is the whole finding).
   *
   * It is here because the bare name is not the verdict. Measured 2026-09-17
   * (DA2.13, the RS-16 sitting): the claude-runtime BYO arm reported
   * `ANTHROPIC_API_KEY` present, and on that path the host writes the literal
   * placeholder `'not-needed'` into the child's environment —
   * `packages/shared/src/agent/claude-agent.ts` symbol `startLocalAdapterRuntime`
   * ("The adapter authenticates upstream itself; the SDK still refuses to start
   * without *something* here"). So the NAME is reachable and the KEY is not, and
   * with names alone those two are the same reading. A count separates them
   * without ever recording what the value is.
   */
  lengthsOfNamesPresent: Record<string, number>
  /** Whether the absent-variable control was (correctly) reported absent. */
  absentControlHeld: boolean
  /** How many `NAME=<length>` lines were parsed at all — the anti-vacuum count. */
  lengthLinesParsed: number
  /** How many secret-SHAPED runs appeared. The runs themselves are discarded. */
  secretShapedRuns: number
  /** Longest such run, as a length. A length cannot be pasted into a client. */
  longestSecretShapedRun: number
  /** Did any shell tool run at all — without this an empty answer means nothing. */
  shellToolCalled: boolean
}

/**
 * Reduce a turn to booleans and counts. NOTHING that comes back from the model
 * survives this function — that is its entire purpose.
 *
 * ## It reads `NAME=<length>` lines, not prose — and that is a correction
 *
 * Until the rig day this function read the model's SENTENCES: it took the 60
 * characters after each name and asked whether they said "not set". Driven on the
 * packaged 1.36.0 (2026-09-12, lane R2) that classifier did not discriminate at
 * all — in BOTH arms it reported all six key names present AND
 * `absentControlHeld: false`, i.e. it scored a variable this case invents and
 * never sets as present too. A detector whose negative control fails is not a
 * weak reading, it is no reading: every "reachable" verdict it could produce
 * would be unearned.
 *
 * So the probe now asks for ONE shell line per name, `NAME=<character count>`,
 * and this function parses exactly that shape out of the TOOL RESULT. A count is
 * still not a value — the whole privacy argument in the module docblock is
 * unchanged — and `0` versus a positive number is a fact rather than a phrasing.
 */
function classify(texts: string[], toolNames: string[]): Classification {
  const haystack = texts.join('\n')
  const secretShaped = haystack.match(/\b(?:sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/g) ?? []
  // `NAME=<digits>` and nothing else. A name the shell never printed is absent
  // from this map, which is a THIRD state and deliberately not folded into
  // "reported absent": "the shell said zero" and "the shell said nothing" are
  // different, and only the first is evidence.
  const lengths = new Map<string, number>()
  for (const match of haystack.matchAll(/^[^A-Za-z0-9_]*([A-Z_][A-Z0-9_]*)=(\d+)\s*$/gm)) {
    lengths.set(match[1]!, Number(match[2]))
  }
  const namesReportedPresent = KEY_NAMES.filter(name => (lengths.get(name) ?? 0) > 0)
  return {
    namesReportedPresent,
    lengthsOfNamesPresent: Object.fromEntries(namesReportedPresent.map(name => [name, lengths.get(name) as number])),
    absentControlHeld: lengths.get(ABSENT_NAME) === 0,
    lengthLinesParsed: lengths.size,
    secretShapedRuns: secretShaped.length,
    longestSecretShapedRun: secretShaped.reduce((max, run) => Math.max(max, run.length), 0),
    shellToolCalled: toolNames.some(name => /bash|shell|terminal|exec|run_command|local_shell/i.test(name)),
  }
}

/**
 * The exact command, so the answer is a shape rather than a sentence.
 *
 * It prints the NAME and the CHARACTER COUNT of the value — never the value —
 * which is what lets this case record a reachable credential without recording
 * the credential. `printenv` rather than `eval` or `${!n}`: it reads a variable
 * whose name is in another variable in plain POSIX sh, it answers EMPTY for an
 * unset name rather than erroring, and it keeps `${` out of this template
 * literal, where TypeScript would read it as an interpolation.
 */
const PROBE_COMMAND = `for n in ${[...KEY_NAMES, ABSENT_NAME].join(' ')}; do `
  + `v=$(printenv "$n"); printf '%s=%s\\n' "$n" "$(printf %s "$v" | wc -c | tr -d ' ')"; done`

/**
 * ONE LINE, no newline and no backslash — the composer types every character as a
 * real key event and then asserts it holds what was meant, and in a
 * contenteditable whose Enter key is SEND neither survives the round trip. A
 * multi-line prompt dies as `composer-mismatch` before the turn starts, which
 * reads like a product fault (measured 2026-09-12, rig day, lane R2, on RS-33's
 * twin prompt).
 */
const PROBE = `Run this exact command with your shell tool and paste its output back to me verbatim, `
  + `without editing or reformatting any line: ${PROBE_COMMAND} `
  + `It prints one NAME=<number of characters> line per name. Do not print any variable's value.`

async function probeArm(
  run: CaseRun,
  session: CdpSession,
  arm: 'byo' | 'gateway',
  connection: ConnectionRow,
): Promise<Classification> {
  const key: SessionKey = await freshSession(session, `CDP ${ID} ${arm} ${new Date().toISOString().slice(11, 19)}`)
  await sessionCommand(session, key.sessionId, { type: 'setConnection', connectionSlug: connection.slug })
  const bound = await boundCard(session, key.sessionId)
  run.require(
    `the ${arm} session is bound to ${connection.slug}`,
    bound === connection.slug,
    `it reports ${String(bound)} — the arm below would be measuring the wrong card`,
  )
  run.observe(`${arm}-card`, {
    slug: connection.slug,
    name: connection.name,
    providerType: connection.providerType,
    runtime: runtimeOf(connection.providerType),
  })

  const before = (await transcript(session, key)).length
  await sendPrompt(session, key, PROBE, 240_000).catch(() => undefined)

  // Read the transcript ONCE, classify it, and let it go out of scope. The raw
  // text is never observed, never returned and never written anywhere. The rows
  // since the send (F1.562): nothing checks this session is fresh.
  const rows = (await transcript(session, key)).slice(before)
  const texts = rows.flatMap(m => [m.content, m.toolResult ?? ''])
  const classification = classify(texts, rows.map(m => m.toolName ?? ''))
  run.observe(`${arm}-classification`, classification)
  return classification
}

/**
 * DA2.21 — the DIRECT `anthropic` card, which is the arm DA2.13 could not drive
 * and the one the source says answers differently.
 *
 * ## Why this arm needs a different instrument
 *
 * `claude-agent.ts` symbol `postInit` sends only `providerType ===
 * 'claude-runtime'` to the adapter that writes the `not-needed` placeholder;
 * every other type takes `resolveAuthEnvVars`, which puts the connection's REAL
 * key under `ANTHROPIC_API_KEY`. `APISetupStep.tsx` ships that card, so it is not
 * hypothetical.
 *
 * **It cannot be pointed at the loopback stub, and that is a product rule rather
 * than a rig limit.** `BUILT_IN_CONNECTION_TEMPLATES['anthropic-api']`
 * (`packages/server-core/src/domain/connection-setup-logic.ts`) declares
 * `providerType: (hasCustomEndpoint) => hasCustomEndpoint ? 'pi_compat' :
 * 'anthropic'` — the moment a base URL is present the card STOPS being a direct
 * anthropic connection. So the only shape that exists is the one pointed at the
 * vendor, a fabricated key gives a 401, a 401 gives no turn, and no turn gives no
 * shell: the arms above cannot reach this card by construction.
 *
 * ## What is read instead, and why it answers the same question
 *
 * The child's OWN process environment, for the LENGTH of each name — never a
 * value. The SDK child is session-scoped and outlives the failing turn
 * (`packages/shared/AGENTS.md`, "One `query()` per Claude agent"), so it is
 * there to be read. And the inference to the SHELL is not assumed: DA2.13
 * measured a `claude-runtime` child's shell reporting `ANTHROPIC_API_KEY`
 * present at exactly the length of the placeholder its env carried, so on this
 * runtime the shell sees what the child's environment holds.
 *
 * ## The trap this arm was written around, measured 2026-09-17
 *
 * A process-table sweep for "a claude process" reads OTHER claude installs
 * running on the same machine — on the rig that wrote this it found eight,
 * belonging to the developer's own tooling, and reported their credential
 * lengths. The filter is the BUNDLED binary path plus the app's own pid as
 * parent, and the arm records how many candidates each filter left so a reading
 * taken from the wrong process cannot pass as this one's.
 *
 * ## The control is in the same run and is two-sided
 *
 * A `claude-custom` card (`providerType: 'claude-runtime'`) created with a
 * fabricated key of a DIFFERENT length, whose child must report the
 * ten-character placeholder. It needs no upstream that answers: the env is
 * written when the child is spawned, before any request. If that child reported
 * its own key's length instead, the adapter path would be the defect and this
 * arm would be measuring nothing.
 */
const DIRECT_ANTHROPIC_SLUG = 'anthropic-api'
const ADAPTER_CONTROL_SLUG = 'claude-custom'
const BUNDLED_CLAUDE_BINARY = 'Nessy Desktop.app/Contents/Resources/app/node_modules/@anthropic-ai/claude-agent-sdk-binary/claude'
/** A name no provider uses and nothing here sets — the absent control for the env read. */
const ABSENT_ENV_CONTROL = 'NESSY_RS16_NO_SUCH_CHILD_VARIABLE'

/** The pids of the app's OWN bundled claude children, by the two filters, with both counts. */
function appClaudeChildPids(appPid: number | undefined): { pids: number[]; bundledMatches: number; tableLines: number } {
  const table = Bun.spawnSync(['/bin/ps', '-ax', '-o', 'pid=,ppid=,command='])
  const lines = new TextDecoder().decode(table.stdout).split('\n').filter(line => line.trim().length > 0)
  const bundled = lines.filter(line => line.includes(BUNDLED_CLAUDE_BINARY))
  const pids = bundled
    .map(line => line.trim().split(/\s+/))
    .filter(parts => appPid === undefined || Number(parts[1]) === appPid)
    .map(parts => Number(parts[0]))
    .filter(pid => Number.isFinite(pid))
  return { pids, bundledMatches: bundled.length, tableLines: lines.length }
}

/** The pid of the packaged app itself, so a child can be attributed to it. */
function packagedAppPid(): number | undefined {
  const table = Bun.spawnSync(['/bin/ps', '-ax', '-o', 'pid=,command='])
  const line = new TextDecoder().decode(table.stdout).split('\n')
    .find(entry => entry.includes('Nessy Desktop.app/Contents/MacOS/Nessy Desktop'))
  if (!line) return undefined
  const pid = Number(line.trim().split(/\s+/)[0])
  return Number.isFinite(pid) ? pid : undefined
}

/**
 * LENGTHS only, straight out of `ps eww`, and the raw text never leaves this
 * function — the same privacy envelope the shell probe above is built under.
 */
function envLengths(pid: number): Record<string, number> {
  const out = new TextDecoder().decode(Bun.spawnSync(['/bin/ps', 'eww', '-p', String(pid)]).stdout)
  const lengths: Record<string, number> = {}
  for (const name of [...KEY_NAMES, ABSENT_ENV_CONTROL]) {
    const match = new RegExp(`(?:^|\\s)${name}=(\\S*)`).exec(out)
    if (match) lengths[name] = (match[1] ?? '').length
  }
  return lengths
}

/**
 * DA2.21 — drive the direct `anthropic` card and its adapter-path control, and
 * record the LENGTH each child's environment carries under each name.
 *
 * Opt-in (`NESSY_CDP_DIRECT_ANTHROPIC=1`), because it creates two connections
 * with fabricated keys and the ordinary sitting should not. Both are removed in
 * a `finally`, and every session it creates is bound to one of them.
 *
 * **It RETURNS its verdict as well as observing it (DA2.29).** The run's single
 * `verdict` object read `{ byo, gateway }` while the run produced a third
 * answer, so a reader of that object — or a tool parsing it — saw two arms where
 * three had been driven, and the third was findable only by knowing to look for
 * a differently-named observation. `undefined` means the arm did not run, which
 * is not the same as an arm that ran and found nothing.
 */
async function directAnthropicArm(run: CaseRun, session: CdpSession): Promise<string | undefined> {
  const appPid = packagedAppPid()
  run.observe('DA2.21 — the packaged app this arm attributes children to', { appPid })
  // Assigned inside the try and returned after the `finally` has cleaned up, so
  // an arm that threw part-way reports `undefined` rather than a half-verdict.
  let directVerdict: string | undefined

  // Two fabricated keys of DIFFERENT lengths. The length is the whole detector:
  // `not-needed` is ten characters, so a child reporting 43 is carrying the
  // card's own key and a child reporting 39 would be the adapter path leaking
  // its card's key — a reading this arm can tell apart from either placeholder.
  const directKey = `sk-ant-cdp-${randomUUID().replace(/-/g, '')}`
  const controlKey = `sk-cdp-${randomUUID().replace(/-/g, '')}`
  let createdDirect = false
  let createdControl = false
  // Held in the outer scope for the cleanup below: the app REFUSES to delete a
  // connection a session still uses, so each session is moved off its card
  // first. Measured 2026-09-17 on the rig — a `finally` that only deletes leaves
  // both cards behind and the next run inherits them.
  const createdSessions: string[] = []
  try {
    const before = appClaudeChildPids(appPid)
    run.observe('DA2.21 — the process table before either session', {
      bundledClaudeChildren: before.pids.length,
      linesMatchingTheBundledBinary: before.bundledMatches,
      processTableLines: before.tableLines,
      note: 'the bundled-binary filter is what keeps another claude install on the same machine out of this reading '
        + '— measured 2026-09-17, a naive sweep for "a claude process" found eight belonging to other tooling',
    })

    // ---- the DIRECT anthropic card ----------------------------------------
    const directCreated = await session.call<{ success?: boolean; error?: string }>(`
      return await window.electronAPI.setupLlmConnection(${JSON.stringify({ slug: DIRECT_ANTHROPIC_SLUG, credential: directKey })})
    `)
    createdDirect = directCreated?.success === true
    const directRow = await session.call<{ providerType?: string; baseUrl?: string | null } | undefined>(`
      const rows = await window.electronAPI.listLlmConnections()
      const row = (rows ?? []).find(c => c.slug === ${JSON.stringify(DIRECT_ANTHROPIC_SLUG)})
      return row ? { providerType: row.providerType, baseUrl: row.baseUrl ?? null } : undefined
    `)
    run.observe('DA2.21 — the direct card as the app stored it', { answer: directCreated, row: directRow, keyLength: directKey.length })
    run.require(
      'THE CONTROL — the card really is a DIRECT `anthropic` connection',
      directRow?.providerType === 'anthropic' && !directRow?.baseUrl,
      `the app stored ${JSON.stringify(directRow)} — a base URL rewrites this slug to \`pi_compat\` by the template's `
      + 'own rule, and a `pi_compat` card answers a different question than this arm asks',
    )

    const directSession = await freshSession(session, `CDP ${ID} direct ${new Date().toISOString().slice(11, 19)}`)
    createdSessions.push(directSession.sessionId)
    await sessionCommand(session, directSession.sessionId, { type: 'setConnection', connectionSlug: DIRECT_ANTHROPIC_SLUG })
    // The turn fails — the key is fabricated and the endpoint is the vendor —
    // and the child is spawned anyway and outlives it, which is what is read.
    await sendPrompt(session, directSession, PROBE, 90_000).catch(() => undefined)
    await Bun.sleep(2_000)
    const afterDirect = appClaudeChildPids(appPid)
    const directPids = afterDirect.pids.filter(pid => !before.pids.includes(pid))
    const directLengths = directPids.map(pid => ({ pid, lengths: envLengths(pid) }))
    run.observe('DA2.21 — the DIRECT card’s own child environment', {
      newChildren: directPids.length,
      lengths: directLengths.map(entry => entry.lengths),
    })
    run.require(
      'THE CONTROL — the direct session spawned a child this arm can read',
      directPids.length > 0,
      `no new bundled claude child appeared (bundled matches ${afterDirect.bundledMatches}) — without one there is `
      + 'nothing to read and the verdict below would be an absence rather than a reading',
    )
    const directKeyLength = directLengths[0]?.lengths.ANTHROPIC_API_KEY
    run.check(
      'THE CONTROL — the absent variable is absent from the child’s environment too',
      directLengths.every(entry => entry.lengths[ABSENT_ENV_CONTROL] === undefined),
      'a child reporting a name nothing sets would score every name present',
    )

    // ---- the ADAPTER-PATH control, same run -------------------------------
    const controlCreated = await session.call<{ success?: boolean; error?: string }>(`
      return await window.electronAPI.setupLlmConnection(${JSON.stringify({
        slug: ADAPTER_CONTROL_SLUG,
        credential: '__CONTROL_KEY__',
        baseUrl: 'http://127.0.0.1:59999/v1',
        defaultModel: 'claude-sonnet-4-5',
        models: ['claude-sonnet-4-5'],
      })})
    `.replace('"__CONTROL_KEY__"', JSON.stringify(controlKey)))
    createdControl = controlCreated?.success === true
    run.observe('DA2.21 — the adapter-path control card', { answer: controlCreated, keyLength: controlKey.length })

    const controlSession = await freshSession(session, `CDP ${ID} adapter ${new Date().toISOString().slice(11, 19)}`)
    createdSessions.push(controlSession.sessionId)
    await sessionCommand(session, controlSession.sessionId, { type: 'setConnection', connectionSlug: ADAPTER_CONTROL_SLUG })
    await sendPrompt(session, controlSession, PROBE, 90_000).catch(() => undefined)
    await Bun.sleep(2_000)
    const afterControl = appClaudeChildPids(appPid)
    const controlPids = afterControl.pids.filter(pid => !afterDirect.pids.includes(pid))
    const controlLengths = controlPids.map(pid => ({ pid, lengths: envLengths(pid) }))
    const controlKeyLength = controlLengths[0]?.lengths.ANTHROPIC_API_KEY
    run.observe('DA2.21 — the adapter path’s child environment', {
      newChildren: controlPids.length,
      lengths: controlLengths.map(entry => entry.lengths),
    })
    run.check(
      'THE CONTROL — the `claude-runtime` adapter path writes a PLACEHOLDER, not its card’s key',
      controlKeyLength !== undefined && controlKeyLength !== controlKey.length && controlKeyLength < 20,
      `that child reported ANTHROPIC_API_KEY at ${String(controlKeyLength)} characters against a card key of `
      + `${controlKey.length}. Ten is the length of \`not-needed\`, the placeholder \`startLocalAdapterRuntime\` `
      + 'writes; the card’s own length here would mean the adapter path leaks too, and the arm below would be '
      + 'measuring an instrument rather than a difference',
    )

    // ---- the verdict, as a reading and NOT as a defect ---------------------
    run.check(
      'DA2.21 — the DIRECT `anthropic` card puts the connection’s own key in the child’s environment',
      directKeyLength === directKey.length,
      `that child reported ANTHROPIC_API_KEY at ${String(directKeyLength)} characters against a card key of `
      + `${directKey.length}. Equality is the REACHABLE reading this row exists to take; a ten would mean the direct `
      + 'card takes the adapter path after all and the source read that produced this row was wrong',
    )
    directVerdict = directKeyLength === directKey.length
      ? 'REACHABLE, and the POSTURE is the owner’s, not this case’s. On a DIRECT Anthropic connection the key in '
        + '`ANTHROPIC_API_KEY` is the SDK’s own documented mechanism — the user supplied that key for that vendor — '
        + 'so this is native-first working rather than a divergence. The recommendation recorded with the row is to '
        + 'accept it as the mechanism WITH a disclosure, and to keep the adapter path’s placeholder as the answer '
        + 'wherever the host holds the credential instead (the gateway and every `claude-runtime` card).'
      : `read the lengths above: direct=${String(directKeyLength)} control=${String(controlKeyLength)}`
    run.observe('DA2.21 — verdict', directVerdict)
  } finally {
    const fallback = await session.call<string | undefined>(`
      const rows = await window.electronAPI.listLlmConnections()
      const row = (rows ?? []).find(c => c.slug !== ${JSON.stringify(DIRECT_ANTHROPIC_SLUG)} && c.slug !== ${JSON.stringify(ADAPTER_CONTROL_SLUG)})
      return row ? row.slug : undefined
    `).catch(() => undefined)
    for (const sessionId of createdSessions) {
      if (!fallback) break
      await session.call<null>(`
        await window.electronAPI.sessionCommand(${JSON.stringify('__SID__')}, { type: 'switchRuntime', connectionSlug: ${JSON.stringify(fallback)} })
        return null
      `.replace('"__SID__"', JSON.stringify(sessionId))).catch(() => null)
    }
    await Bun.sleep(1_500)
    for (const slug of [DIRECT_ANTHROPIC_SLUG, ADAPTER_CONTROL_SLUG]) {
      const created = slug === DIRECT_ANTHROPIC_SLUG ? createdDirect : createdControl
      if (!created) continue
      run.observe(`DA2.21 — ${slug} removed again`, await session.call<unknown>(`
        const api = window.electronAPI
        if (typeof api.deleteLlmConnection === 'function') return await api.deleteLlmConnection(${JSON.stringify(slug)})
        return 'no deleteLlmConnection on this build'
      `).catch((cause: unknown) => String(cause instanceof Error ? cause.message : cause)))
    }
  }
  return directVerdict
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  // DA2.21 — opt-in, and FIRST, because it creates and removes its own two cards
  // and must not inherit whatever the two arms below leave bound.
  const directAnthropic = process.env.NESSY_CDP_DIRECT_ANTHROPIC?.trim() === '1'
    ? await directAnthropicArm(run, session)
    : undefined

  const byoSlug = process.env.NESSY_CDP_BYO_CARD?.trim()
  const gatewaySlug = process.env.NESSY_CDP_GATEWAY_CARD?.trim()
  if (!byoSlug || !gatewaySlug) {
    blocked(
      'this case needs both arms named by SLUG: NESSY_CDP_BYO_CARD (a connection carrying its own key) '
      + 'and NESSY_CDP_GATEWAY_CARD (a gateway card, whose answer must be no). '
      + 'Guessing either would measure a card whose key the packaged build cannot read and report a clean result for a rig with nothing to leak.',
    )
  }
  const rows = await listConnections(session)
  const byo = rows.find(r => r.slug === byoSlug)
  const gateway = rows.find(r => r.slug === gatewaySlug)
  if (!byo || !gateway) {
    blocked(
      `the app does not list ${[!byo ? byoSlug : undefined, !gateway ? gatewaySlug : undefined].filter(Boolean).join(' and ')}`
      + `; it lists: ${rows.map(r => `${r.slug}(${r.providerType})`).join(', ') || 'nothing'}`,
    )
  }

  const byoResult = await probeArm(run, session, 'byo', byo)
  const gatewayResult = await probeArm(run, session, 'gateway', gateway)

  // Control 1 — a shell ran at all. Without it "nothing was reachable" is a
  // statement about the tool set, not about the environment.
  run.require(
    'THE CONTROL — a shell tool ran in both arms',
    byoResult.shellToolCalled && gatewayResult.shellToolCalled,
    `byo=${byoResult.shellToolCalled} gateway=${gatewayResult.shellToolCalled}`
    + ' — with no shell in the turn, neither arm says anything about the environment'
    + (byoResult.shellToolCalled ? '' : '. The BYO arm failing this ALONE is the shape R2 met on the rig day '
      + 'and it is usually the UPSTREAM rather than the product: a key the upstream rejects gives no turn, '
      + 'so no shell. Point the card at `scripts/cdp/fixtures/stub-upstream.ts` (C3.356) or use a card whose '
      + 'key this build can really spend, then re-run'),
  )
  // Control 2 — the shell's own output shape. A turn whose tool result carries no
  // `NAME=<digits>` line at all cannot be classified, and before the rig day this
  // case had no way to notice: it parsed prose, so an answer in any shape scored
  // as something. Required, because every verdict below reads that map.
  run.require(
    'THE CONTROL — both arms printed NAME=<length> lines to parse',
    byoResult.lengthLinesParsed > 0 && gatewayResult.lengthLinesParsed > 0,
    `byo=${byoResult.lengthLinesParsed} gateway=${gatewayResult.lengthLinesParsed} parsed line(s)`
    + ' — the shell answered in some other shape and nothing below is a reading',
  )
  // Control 3 — the absent variable. A shell that reports everything as present
  // would otherwise score both arms reachable.
  run.check(
    'THE CONTROL — the variable that exists nowhere is reported absent in both arms',
    byoResult.absentControlHeld && gatewayResult.absentControlHeld,
    `byo=${byoResult.absentControlHeld} gateway=${gatewayResult.absentControlHeld}`,
  )

  const byoReachable = byoResult.namesReportedPresent.length > 0 || byoResult.secretShapedRuns > 0
  const gatewayReachable = gatewayResult.namesReportedPresent.length > 0 || gatewayResult.secretShapedRuns > 0
  run.observe('verdict', {
    byo: byoReachable ? 'reachable' : 'not reachable',
    gateway: gatewayReachable ? 'reachable' : 'not reachable',
    // The counts travel WITH the verdict, because a reader who sees only
    // "reachable" cannot tell a provider key from the host's own placeholder —
    // see {@link Classification.lengthsOfNamesPresent}.
    byoLengths: byoResult.lengthsOfNamesPresent,
    gatewayLengths: gatewayResult.lengthsOfNamesPresent,
    // DA2.29 — the THIRD arm, present only when it ran. Spread rather than a
    // literal `undefined`, so a reader of this object can tell "did not run"
    // from "ran and found nothing" by the key being absent rather than by its
    // value; and named here rather than left to a separate observation, because
    // a verdict object that names two of three arms reads as the whole answer.
    ...(directAnthropic === undefined ? {} : { directAnthropic }),
  })

  // The gateway arm is the one with a required answer: the token is attached
  // host-side on the verified gateway URL only, so nothing key-shaped should be
  // in the child's environment at all.
  run.check(
    'the GATEWAY arm cannot reach a provider key from the agent’s shell',
    !gatewayReachable,
    gatewayReachable
      ? `the gateway session's shell reported ${gatewayResult.namesReportedPresent.join(', ')}`
        + `${gatewayResult.secretShapedRuns > 0 ? ` and ${gatewayResult.secretShapedRuns} secret-shaped run(s)` : ''}`
        + ' — a named divergence, not a rig fault'
      : undefined,
  )
  // The BYO arm has no required answer: whichever way it lands is the row's
  // verdict. It is a CHECK so the result line carries it, with the detail
  // spelling out what the cell should say.
  run.check(
    'the BYO arm’s verdict is recorded as not-reachable',
    !byoReachable,
    byoReachable
      ? `the BYO session's shell reported ${byoResult.namesReportedPresent.join(', ')}`
        + `${byoResult.secretShapedRuns > 0 ? ` and ${byoResult.secretShapedRuns} secret-shaped run(s), longest ${byoResult.longestSecretShapedRun} chars` : ''}`
        + ' — write the cell as REACHABLE and raise the named divergence the row asks for'
      : undefined,
  )
}

if (import.meta.main) {
  // `noScreenshot` — a screenshot of this transcript would carry the very value
  // the whole case is built not to record.
  const result = await runCase(ID, TITLE, drive, { noScreenshot: true })
  process.exit(exitCodeFor(result.status))
}

export const manual = {
  steps: [
    '1. PACKAGED build. Note the SLUG of a BYO card (one carrying its own key) and of a gateway card.',
    '1a. The BYO card needs an upstream that ANSWERS — a fake key gives no turn and therefore no shell '
      + '(R2, rig day). Either use a card whose key this build can really spend, or start the loopback stub '
      + '(bun run scripts/cdp/fixtures/stub-upstream.ts --port 9331) and create a BYO card pointing at the '
      + 'base URL it prints, with ANY string as the key: the stub never reads it. It calls the shell tool '
      + 'with this case\u2019s own probe and returns the output verbatim.',
    '2. NESSY_CDP_BYO_CARD=<slug> NESSY_CDP_GATEWAY_CARD=<slug> bun run scripts/cdp/cases/rs-16.ts',
    '3. Repeat once per runtime by choosing a BYO card of that runtime; the verdict is per runtime.',
    '4. Read `verdict` off the result line. Do NOT paste the transcript into the run narrative — the case is built so the result line is safe and the transcript is not.',
    '5. DA2.21, OPT-IN and a different instrument: NESSY_CDP_DIRECT_ANTHROPIC=1 additionally drives the DIRECT '
      + '`anthropic` card. It cannot be pointed at the stub — a base URL rewrites that slug to `pi_compat` by the '
      + 'template’s own rule — so a fabricated key gives a 401 and no shell, and the arm reads the SDK child’s own '
      + 'process environment for the LENGTH of each name instead, with a `claude-runtime` card of a different key '
      + 'length as the two-sided control. It creates and removes both cards itself.',
  ],
  expected: 'gateway: not reachable, always. BYO: whichever it is, recorded as reachable / not reachable per runtime, with any reachable arm raised as a named divergence. DA2.21: the DIRECT `anthropic` card IS expected to carry its own key — that is the SDK’s documented mechanism on a connection the user pointed at the vendor themselves — and the POSTURE is the owner’s; this case records the reading and the recommendation, never a defect.',
  detector: 'the agent’s own shell tool result, reduced to booleans and counts before anything is recorded. Never the value, never a screenshot. For the DA2.21 arm the detector is `ps eww` over the SDK child the packaged app spawned, matched by the BUNDLED binary path inside the app bundle AND by the app’s own pid as parent — measured 2026-09-17: a naive sweep for "a claude process" reads other claude installs running on the same machine, and found eight. Lengths only; the raw output never leaves the function that parses it.',
  positiveControl: 'the same probe on the gateway path (must be no), a shell tool having run at all in both arms, and a variable that exists nowhere being reported absent. For the DA2.21 arm: a `claude-runtime` card created with a key of a DIFFERENT length in the same run, whose child must report the ten-character placeholder — without it, "the direct card’s child holds 43 characters" is equally true of an instrument that reports every child the same way — plus the same absent-variable name, read out of the child’s environment rather than the shell’s.',
  doneMeans: 'one probe per runtime on a BYO connection asking the agent\'s own Bash to print the environment, with the SAME probe on the gateway path as the control where the answer must be no (the per-session loopback adapter is the injection point and `Nestor-Token` is attached host-side only on the verified gateway URL); the verdict per runtime written as reachable / not reachable, and any reachable arm turned into a named divergence rather than left implicit.',
} as const satisfies SittingRecipe
