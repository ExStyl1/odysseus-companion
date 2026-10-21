/**
 * The plain files the BLOCKED rows below have been waiting on.
 *
 * AGT-4, AGT-5, AGT-6, AGT-8, CRU-5, CDX-ROLES and RS-30 all reported BLOCKED on
 * "install an agent / a skill / a hook / an output style / a managed policy",
 * and every one of those is a file under `CONFIG_DIR` — the directory
 * `packages/shared/src/config/paths.ts` resolves from `NESSY_CONFIG_DIR`:
 *
 * | Row | File | Read by |
 * | --- | --- | --- |
 * | AGT-4 | `output-styles/*.md`, `MEMORY.md` | `prompts/output-styles.ts`, `agent/memory/memory-store.ts` |
 * | AGT-5 | `agents/*.md` with and without `effort:` | `agents/definitions.ts` |
 * | AGT-6 | `hooks.json` (`UserPromptSubmit`, `SessionStart`) | `automations/hooks-config.ts` |
 * | RS-30 | `hooks.json` (`PostToolUse` -> `classifierContext`) | `automations/hook-command.ts` |
 * | AGT-8 | `managed-delivery.json` | `config/managed-delivery.ts` |
 * | CRU-5 | `agents/*.md` + `skills/<name>/SKILL.md` | `agents/definitions.ts`, `capabilities/native-sources.ts` |
 * | CDX-ROLES | `agents/probe-role.md`, `agents/probe-denied.md` | the codex role builder |
 *
 * ## The policy question, and where the harness already answered it
 *
 * `scripts/cdp/README.md`'s "the harness does not write config" is about the
 * OPERATOR'S LIVE configuration, and the precedent is written into the harness
 * in its own words — `fixtures/runtime-switch.ts`: *"This is a config write,
 * which a CASE may not do … A fixture may — that is what a fixture is — and it
 * happens here, in one reviewable place, against a scratch config dir, rather
 * than inside a case where a later reader would not expect it."* This file is
 * that one reviewable place for the native config-dir surfaces.
 *
 * ## Two rules this fixture holds itself to
 *
 * 1. **It never clobbers.** Every file it owns carries a `cdp-`/`probe-` name of
 *    its own, `hooks.json` is MERGED into rather than replaced, and `MEMORY.md`
 *    is APPENDED to. A config dir the operator has been using survives being
 *    seeded.
 * 2. **Markers are minted once and kept.** `cdp-markers.json` holds them, so
 *    re-running the fixture mid-wave does not invalidate a measurement in
 *    flight by changing the token a case is hunting for. `--fresh` re-mints.
 *
 * ## Where it writes
 *
 *   `--config-dir <path>`   explicit, and the only way to target a live dir
 *   `NESSY_CONFIG_DIR`      when set, the dir the app was launched with
 *   otherwise               `~/nessy-cdp-agents/config`, a scratch dir
 *
 * `--remove-hooks` is the teardown ({@link removeCdpHooks}): it takes every CDP
 * hook back out of that dir's `hooks.json` and writes nothing else. RS-30's
 * `PostToolUse` hook carries no matcher on purpose, so leaving it behind
 * annotates every later session in a live config dir.
 *
 * The default is scratch on purpose: a fixture that silently writes
 * `~/.nessy-agent` because a variable happened to be unset is the failure mode
 * rule 1 exists to prevent.
 *
 * ## What it does NOT do
 *
 * It writes no LLM connection and no credential. A scratch config dir has no
 * gateway cards, so the rows that need a live runtime also need
 * `fixtures/runtime-switch.ts`'s `seedConfig()` (which copies the operator's
 * connection rows, secret-free) against the same dir, or a `--config-dir`
 * pointed at a dir that already has them.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// D1.134's hook matrix needs the COMPLETE event vocabulary, and a list written
// out here would be a prose enumeration beside a single source of truth — the
// shape AGENTS.md says ages silently. `AGENT_EVENTS` is derived from
// `AGENT_EVENT_CONTRACTS_V1`, so it cannot fall behind the contract table.
// The import is admissible in a FIXTURE for the reason the harness's own
// `cru-3` note gives about cases: the cost is a module graph, and this file is
// already imported by `harness.test.ts`, which imports from `@nessy-agent/*`
// itself. Measured 2026-09-18 (SIT-6b): `bun -e` importing this module answers
// 32 events in `real 0.38`.
import { AGENT_EVENTS } from '@nessy-agent/shared/automations/types'

/** Names this fixture owns. Anything else in the config dir is not its business. */
export const FIXTURE_NAMES = {
  /** AGT-5 half 1 — declares `effort: high`, so it outranks the session level. */
  deepAgent: 'cdp-deep',
  /** AGT-5 half 2 — declares NO effort, so the SESSION level reaches it. */
  shallowAgent: 'cdp-shallow',
  /** CRU-5 — declares `skills:`, and its control. */
  skilledAgent: 'cdp-skilled',
  plainAgent: 'cdp-plain',
  skill: 'cdp-house-marker',
  /** CDX-ROLES — the two codex probes, named by VERIFICATION-STATE.md. */
  roleAgent: 'probe-role',
  deniedAgent: 'probe-denied',
  /** AGT-4 — the custom output style. Its id is `custom:<slug>`. */
  outputStyle: 'cdp-marker',
  /**
   * D1.135 — the four subagent-field probes, written only when
   * {@link SeedOptions.subagentProbeDir} names a directory for them to append
   * to. They come in PAIRS because every one of the row's arms is a difference:
   * the field declared, and the same definition without it.
   */
  cappedAgent: 'cdp-capped',
  uncappedAgent: 'cdp-uncapped',
  backgroundAgent: 'cdp-background',
  foregroundAgent: 'cdp-foreground',
} as const

export interface FixtureMarkers {
  /** AGT-6 — `NESSY_CDP_PROMPT_HOOK_MARKER`. */
  promptHook: string
  /** AGT-6 — `NESSY_CDP_COMPACT_HOOK_MARKER`. */
  compactHook: string
  /** RS-30 — `NESSY_CDP_CLASSIFIER_NOTE`, the note the PostToolUse hook hands the auto-mode classifier. */
  classifierHook: string
  /** AGT-4 — `NESSY_CDP_OUTPUT_STYLE_MARKER`. */
  outputStyle: string
  /** AGT-4 — `NESSY_CDP_MEMORY_MARKER`. */
  memory: string
  /** CRU-5 — `NESSY_CDP_SKILL_MARKER`, the literal only the skill body carries. */
  skill: string
  /** CDX-ROLES — the `ZEPHYR-<8 hex>` codeword in `probe-role.md`'s BODY. */
  zephyr: string
  /**
   * D1.134 — the per-event hook matrix's own token.
   *
   * It is in {@link FixtureMarkers} rather than minted at the call site for the
   * reason the `addHook` sweep states: `cdpMarkerPrefixes` derives itself from a
   * fresh mint, so a marker that lives here is swept on a re-seed and one that
   * does not would stack a second copy of all 32 hooks onto every event.
   */
  hookMatrix: string
}

const MARKERS_FILE = 'cdp-markers.json'

/**
 * The config dir this fixture writes into.
 *
 * `NESSY_CONFIG_DIR` is honoured because the operator launching the app with it
 * and then running this fixture in the same shell means the same dir; anything
 * else would seed a directory the app under test is not reading, which is the
 * exact defect that kept CDX-ROLES blocked.
 */
export function targetConfigDir(explicit?: string): string {
  if (explicit) return resolve(explicit)
  const fromEnv = process.env.NESSY_CONFIG_DIR?.trim()
  if (fromEnv) return resolve(fromEnv)
  return resolve(join(homedir(), 'nessy-cdp-agents', 'config'))
}

function token(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`
}

/** `ZEPHYR-<8 hex>` exactly, which is the shape CDX-ROLES' spec names. */
function zephyr(): string {
  return `ZEPHYR-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`
}

function mintMarkers(): FixtureMarkers {
  return {
    promptHook: token('CDP-PROMPT-HOOK'),
    compactHook: token('CDP-COMPACT-HOOK'),
    classifierHook: token('CDP-CLASSIFIER'),
    outputStyle: token('CDP-OSTYLE'),
    memory: token('CDP-MEMORY'),
    skill: token('CDP-HOUSE'),
    zephyr: zephyr(),
    hookMatrix: token('CDP-HOOKMX'),
  }
}

/**
 * The markers already on disk — every one that is a non-empty string is KEPT.
 *
 * The key list is DERIVED from a fresh mint rather than written out beside the
 * type, so a marker added to {@link FixtureMarkers} cannot be forgotten here;
 * and the result is a MERGE rather than all-or-nothing. A `cdp-markers.json`
 * written before a key existed — every one on an operator's disk the day this
 * fixture grew `classifierHook` — keeps every token it does carry and gains only
 * the new one. Rule 2 of this file is that a re-seed must not re-mint a token a
 * running case is hunting for, and re-minting the whole set because the FIXTURE
 * grew a field is that same failure wearing an upgrade's clothes.
 */
async function readMarkers(configDir: string): Promise<FixtureMarkers | undefined> {
  const path = join(configDir, MARKERS_FILE)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<FixtureMarkers>
    const merged = mintMarkers()
    let kept = 0
    for (const key of Object.keys(merged) as (keyof FixtureMarkers)[]) {
      const value = parsed[key]
      if (typeof value === 'string' && value.length > 0) {
        merged[key] = value
        kept += 1
      }
    }
    // Nothing usable at all is a corrupt file, not a marker set.
    if (kept > 0) return merged
  } catch { /* a corrupt marker file is re-minted, not a failure */ }
  return undefined
}

async function writeText(path: string, lines: string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * One agent markdown definition.
 *
 * `effort` is a first-class frontmatter field — declared in
 * `packages/shared/src/agents/definitions.ts`, normalised through
 * `normalizeThinkingLevel` and REJECTED LOUDLY when invalid, so a typo here
 * surfaces as a refused definition rather than as a silently ignored line.
 * `skills` and `isolation` are parsed from the same block.
 */
function agentFile(options: {
  name: string
  description: string
  body: string[]
  effort?: string
  skills?: string
  tools?: string
  /**
   * D1.135 (H25). Frontmatter delivers it as a STRING and `normalizeMaxTurns`
   * accepts that shape deliberately (`agents/definitions.ts`); an invalid value
   * throws `Invalid <label>.maxTurns: expected positive integer` rather than
   * being ignored, so a typo here is a refused definition and not a silent
   * absence.
   */
  maxTurns?: number
  /**
   * D1.135 (H26). Same shape difference: `"true"` / `"false"` in markdown,
   * a native boolean in JSON config, and `normalizeBackground` refuses anything
   * else loudly.
   */
  background?: boolean
}): string[] {
  return [
    '---',
    `name: ${options.name}`,
    `description: ${options.description}`,
    ...(options.effort ? [`effort: ${options.effort}`] : []),
    ...(options.skills ? [`skills: ${options.skills}`] : []),
    ...(options.tools ? [`tools: ${options.tools}`] : []),
    ...(options.maxTurns === undefined ? [] : [`maxTurns: "${options.maxTurns}"`]),
    ...(options.background === undefined ? [] : [`background: "${options.background}"`]),
    '---',
    '',
    ...options.body,
    '',
  ]
}

export interface SeedReport {
  configDir: string
  markers: FixtureMarkers
  written: string[]
  /** Files left exactly as they were, and why. */
  preserved: string[]
  managedPolicy?: { allowed: string[]; path: string; keys: string[] }
  /** D1.134 — the per-event matrix, when {@link SeedOptions.hookMatrixDir} asked for one. */
  hookMatrix?: { dir: string; events: string[]; marker: string }
  /** D1.135 — the four subagent-field probes, when a directory was named for them. */
  subagentProbes?: { dir: string; agents: Record<string, string>; steps: number }
}

/**
 * Take every CDP hook back out of a config dir's `hooks.json` — PR-7.
 *
 * The RS-30 hook carries **no matcher**, deliberately: the case's framing count
 * wants every `PostToolUse` annotated. That is also why it must not be left
 * behind — in a live config dir it goes on annotating every tool call of every
 * later session, and `README.md` has told the operator to remove it by hand
 * since the case landed. Told, and nothing removed it: an instruction in prose
 * is not a teardown, which is the shape of PR-7 from the 1.36.0 sitting.
 *
 * It is HERE rather than in the case for the rule this file exists for: a case
 * may not write live hook config, and removing one is a write. The removal is
 * the mirror of `addHook`'s own sweep — the same `<PREFIX>-` derivation off a
 * fresh mint, so a marker added to {@link FixtureMarkers} is swept without
 * anyone listing it here — and it touches nothing else in the document: an
 * operator's own hooks, and any event whose list ends up empty, are left exactly
 * as they were rather than tidied.
 */
export async function removeCdpHooks(configDirOverride?: string): Promise<{ configDir: string; removed: string[]; file?: string }> {
  const configDir = targetConfigDir(configDirOverride)
  const hooksPath = join(configDir, 'hooks.json')
  if (!existsSync(hooksPath)) return { configDir, removed: [] }
  const raw = await readFile(hooksPath, 'utf8')
  if (!raw.trim()) return { configDir, removed: [], file: hooksPath }
  let doc: Record<string, unknown>
  try {
    doc = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new Error(
      `${hooksPath} is not valid JSON. Refusing to rewrite it — fix or move it, then re-run. `
      + 'A teardown that eats an unreadable file is worse than the hook it came to remove.',
    )
  }
  const map = (doc.hooks ?? doc.automations ?? {}) as Record<string, unknown[]>
  const prefixes = Object.values(mintMarkers()).map(minted => minted.replace(/-[0-9A-F]+$/i, '-'))
  const removed: string[] = []
  for (const [event, list] of Object.entries(map)) {
    if (!Array.isArray(list)) continue
    const kept = list.filter(row => {
      const hit = prefixes.some(prefix => JSON.stringify(row).includes(prefix))
      if (hit) removed.push(event)
      return !hit
    })
    map[event] = kept
  }
  if (removed.length > 0) await writeJson(hooksPath, { ...doc, hooks: map })
  return { configDir, removed, file: hooksPath }
}

export interface SeedOptions {
  configDir?: string
  /** Re-mint every marker instead of reusing `cdp-markers.json`. */
  fresh?: boolean
  /**
   * AGT-8: write `managed-delivery.json` with an `availableModels`-only
   * payload. Opt-in, because it NARROWS the model list of every session in that
   * config dir until the file is removed and the app relaunched.
   */
  managedModels?: string[]
  /**
   * RS-35 / C3.37: the administrator's own pre-install trust sentence, carried
   * in the same delivered document.
   *
   * Opt-in for the same reason as `managedModels`, and a weaker one: it only
   * ADDS a sentence to a confirmation dialog. Like `availableModels` it is in
   * none of `classifyManagedApproval`'s three categories (shell, sandbox, env),
   * so the payload applies straight from the cache with no approval prompt and
   * no root — measured on the packaged build 2026-09-12, where the same profile
   * answered `pluginTrustMessage: null` before the file and the sentence after
   * a relaunch.
   *
   * The VALUE is the caller's, not this file's: the assertion C3.37 makes is
   * "verbatim", so the sentence must carry a token nothing else on the machine
   * holds, and minting it here would put it in the repository.
   */
  managedTrustMessage?: string
  /**
   * RS-35 / C3.38: the organization's startup announcements, same document.
   *
   * A LIST because the page's rule is about a list — *"when you list more than
   * one, Claude Code picks one at random for each session; on a person's very
   * first launch it shows the first entry"* — and a single-entry fixture cannot
   * tell "the first entry" from "the only entry".
   */
  managedAnnouncements?: string[]
  /**
   * D1.73 / F1.66: the marketplace NAMES whose `relevance` declarations may pin
   * plugins as suggestions — `settings-reference.md#pluginsuggestionmarketplaces`,
   * carried in the same delivered document.
   *
   * Opt-in for the same reason as the three keys above, and the narrowest of the
   * four: it only UNMUTES a suggestion surface that every shipped install keeps
   * silent (the pin, the session-start notice, the spinner tip), and it is in
   * none of `classifyManagedApproval`'s three categories, so it applies straight
   * from the cache with no approval and no root. The NAMES alone are not the
   * whole gate — `PluginRegistrySource.isSuggestionAllowed` also requires the
   * same managed policy to declare the registry's SOURCE (`extraKnownMarketplaces`
   * for that name, or a `strictKnownMarketplaces` entry), so a rig that wants a
   * pin must seed the name AND its source binding; this key is the allowlist
   * half only, spelled exactly as the delivered parser reads it
   * (`managed-policy.ts` symbol `pluginSuggestionMarketplaces`).
   */
  managedPluginSuggestions?: string[]
  /**
   * D1.134: instead of the three named hooks, write ONE command hook per
   * {@link AGENT_EVENTS} entry, each appending a line to `<dir>/<Event>.hit`.
   *
   * ## Why a file and not stdout
   *
   * The row asks which events actually FIRE. A hook's stdout only tells you that
   * for the handful of events whose output is delivered somewhere a case can
   * read; a file append tells you it for all of them, and it survives the turn,
   * the session and the app. `>>` opens its target before writing, so a hook
   * that started and produced nothing is still distinguishable from one that
   * never started — which is what `hook-command.ts`'s own docblock says about
   * the same operator.
   *
   * ## Why it REPLACES the three named hooks rather than joining them
   *
   * `addHook` drops any earlier CDP hook for the same event so a re-seed cannot
   * stack markers onto one turn. A matrix written beside the named hooks would
   * therefore delete AGT-6's `UserPromptSubmit` entry anyway, silently — so the
   * matrix mode states it instead, and carries AGT-6's own codeword ON the
   * `UserPromptSubmit` entry so that instrument is not lost. Only that one event
   * echoes: thirty-one further hooks writing arbitrary text to stdout would put
   * an unstated needle into whatever surface each event's output reaches, which
   * is the contamination measure sitting 5e parked this file's hooks to avoid.
   */
  hookMatrixDir?: string
  /**
   * D1.135: write the four subagent-field probe agents, each appending one line
   * per step to `<dir>/<agent name>.log`.
   *
   * ## Why a file and why THREE steps
   *
   * The row's two measurable arms are both differences in HOW FAR a child got
   * and WHEN it got there, and neither is legible in a parent's transcript: a
   * `maxTurns: 1` child that was cut off and one that finished both come back as
   * an Agent tool result, and a `background: true` child that is still running
   * is invisible from the parent's side by construction. A file the child
   * appends to answers both — line COUNT for the cap, line TIMESTAMP against the
   * parent's settle time for the background flag — and it survives the turn.
   *
   * Three steps rather than one, because a cap of one turn has to have something
   * to cut off. A single-step body would finish inside the cap and the arm would
   * measure nothing.
   *
   * Opt-in for the same reason as the managed policy: four extra agents change
   * what every session in that config dir is offered.
   */
  subagentProbeDir?: string
}

export async function seedAgentSurfaces(options: SeedOptions = {}): Promise<SeedReport> {
  const configDir = targetConfigDir(options.configDir)
  await mkdir(configDir, { recursive: true })
  const markers = (options.fresh ? undefined : await readMarkers(configDir)) ?? mintMarkers()
  const written: string[] = []
  const preserved: string[] = []
  const record = async (path: string, lines: string[]): Promise<void> => {
    await writeText(path, lines)
    written.push(path)
  }

  await writeJson(join(configDir, MARKERS_FILE), markers)

  // ---- AGT-5: one agent that declares an effort, one that declares none ----
  await record(join(configDir, 'agents', `${FIXTURE_NAMES.deepAgent}.md`), agentFile({
    name: FIXTURE_NAMES.deepAgent,
    description: 'CDP fixture. Declares a HIGH effort level, so it must out-think a parent sitting at low.',
    effort: 'high',
    tools: 'Read, Glob, Grep',
    body: ['Answer the question you are given in one short line, and nothing else.'],
  }))
  await record(join(configDir, 'agents', `${FIXTURE_NAMES.shallowAgent}.md`), agentFile({
    name: FIXTURE_NAMES.shallowAgent,
    description: 'CDP fixture. Declares NO effort, so the SESSION level is what reaches it — the instrument for AGT-5 half 2.',
    tools: 'Read, Glob, Grep',
    // Deliberately NO `effort:` line. `resolveEffortLevel` is
    // `invocation ?? declared ?? session`, so a declared level here would mask
    // the mid-session change this agent exists to make visible.
    body: ['Answer the question you are given in one short line, and nothing else.'],
  }))

  // ---- D1.135: the four subagent-field probes, in PAIRS -------------------
  //
  // Each pair differs in ONE frontmatter field, so the reading is a difference
  // and never a single number. The body is identical across all four — three
  // appends to a file named after the agent — for the same reason: a body that
  // differed would make the line count a reading about the prompt.
  let subagentProbes: SeedReport['subagentProbes']
  if (options.subagentProbeDir) {
    const probeDir = resolve(options.subagentProbeDir)
    await mkdir(probeDir, { recursive: true })
    const steps = 3
    const probeBody = (name: string): string[] => [
      `You are a probe. Do EXACTLY this, and report what you did:`,
      '',
      `1. Use the Bash tool to run: printf '%s\\n' "${name} step 1 $(date +%s)" >> '${join(probeDir, `${name}.log`)}'`,
      `2. Use the Bash tool to run: printf '%s\\n' "${name} step 2 $(date +%s)" >> '${join(probeDir, `${name}.log`)}'`,
      `3. Use the Bash tool to run: printf '%s\\n' "${name} step 3 $(date +%s)" >> '${join(probeDir, `${name}.log`)}'`,
      '',
      'Run them as THREE separate Bash calls, in order, one per assistant turn.',
      'When all three have run, reply with the single word done.',
    ]
    const probes: Array<{ key: keyof typeof FIXTURE_NAMES; description: string; maxTurns?: number; background?: boolean }> = [
      { key: 'cappedAgent', description: 'CDP fixture (D1.135 H25). Declares maxTurns: 1, so it cannot reach step 3.', maxTurns: 1 },
      { key: 'uncappedAgent', description: 'CDP fixture (D1.135 H25). THE CONTROL — the same body with NO cap.' },
      { key: 'backgroundAgent', description: 'CDP fixture (D1.135 H26). Declares background: true, so the parent turn should not wait for it.', background: true },
      { key: 'foregroundAgent', description: 'CDP fixture (D1.135 H26). THE CONTROL — the same body with NO background flag.' },
    ]
    const agents: Record<string, string> = {}
    for (const entry of probes) {
      const name = FIXTURE_NAMES[entry.key]
      await record(join(configDir, 'agents', `${name}.md`), agentFile({
        name,
        description: entry.description,
        tools: 'Bash',
        body: probeBody(name),
        ...(entry.maxTurns === undefined ? {} : { maxTurns: entry.maxTurns }),
        ...(entry.background === undefined ? {} : { background: entry.background }),
      }))
      agents[entry.key] = name
    }
    subagentProbes = { dir: probeDir, agents, steps }
  }

  // ---- CRU-5: an agent that declares a skill, its control, and the skill ----
  await record(join(configDir, 'agents', `${FIXTURE_NAMES.skilledAgent}.md`), agentFile({
    name: FIXTURE_NAMES.skilledAgent,
    description: 'CDP fixture. Answers what the house marker is, using the skill its definition declares.',
    skills: FIXTURE_NAMES.skill,
    tools: 'Read, Glob, Grep',
    body: [
      'You exist only to answer one question: what is the house marker?',
      '',
      'The answer is in the skill your definition declares. Reply with the single',
      '`MARKER=` line and nothing else. If you were not given that skill\'s content,',
      'say exactly `NO-MARKER-AVAILABLE` rather than guessing.',
    ],
  }))
  await record(join(configDir, 'agents', `${FIXTURE_NAMES.plainAgent}.md`), agentFile({
    name: FIXTURE_NAMES.plainAgent,
    description: 'CDP fixture. The CONTROL — declares no skills and no isolation.',
    tools: 'Read, Glob, Grep, Write, Bash',
    body: [
      'You do exactly what you are asked and nothing else.',
      '',
      'When asked to create a file, create it at the exact path given with the exact',
      'content given, then reply with one line: `CWD=<the absolute working directory you used>`.',
      '',
      'When asked for the house marker, reply `NO-MARKER-AVAILABLE` — you have no skill',
      'that carries one, and you must not guess.',
    ],
  }))
  await record(join(configDir, 'skills', FIXTURE_NAMES.skill, 'SKILL.md'), [
    '---',
    `name: ${FIXTURE_NAMES.skill}`,
    'description: CDP fixture. Carries one literal that exists nowhere else, so a subagent that quotes it can only have been given this skill body.',
    '---',
    '',
    '# The house marker',
    '',
    'When you are asked for the house marker, reply with exactly one line and nothing else:',
    '',
    `MARKER=${markers.skill}`,
    '',
    'Do not explain it. Do not add punctuation around it. The literal above is the',
    'whole answer.',
  ])

  // ---- CDX-ROLES: the two codex probes ------------------------------------
  // Spec: VERIFICATION-STATE.md § "Живое доказательство ролей агентов на Codex".
  // `probe-role.md` must carry NO `tools:`/`disallowedTools:`/`permissionMode:`
  // — each of those makes `buildCodexAgentRoles` deny the role by design, which
  // is what `probe-denied.md` is FOR. The codeword goes in the BODY and must
  // not appear in the description, which is the only part the parent model sees.
  await record(join(configDir, 'agents', `${FIXTURE_NAMES.roleAgent}.md`), agentFile({
    name: FIXTURE_NAMES.roleAgent,
    description: 'CDP fixture probe role. Answers with the codeword written in its own role layer.',
    body: [
      'When you are asked for your codeword, reply with exactly this line and nothing else:',
      '',
      markers.zephyr,
      '',
      'Do not read any files. Do not run any commands. The line above is the whole answer.',
    ],
  }))
  await record(join(configDir, 'agents', `${FIXTURE_NAMES.deniedAgent}.md`), agentFile({
    name: FIXTURE_NAMES.deniedAgent,
    description: 'CDP fixture. Declares a tool grant, which codex has no per-role policy for, so the role must be refused.',
    tools: 'Read, Grep',
    body: ['This agent exists to be REFUSED as a codex role. It should never run.'],
  }))

  // ---- AGT-4: a custom output style, and a memory line --------------------
  // `discoverCustomOutputStyles` takes any `*.md` in <configDir>/output-styles
  // and mints the id `custom:<slug>`, so the id AGT-4 wants is
  // `custom:cdp-marker`.
  await record(join(configDir, 'output-styles', `${FIXTURE_NAMES.outputStyle}.md`), [
    '---',
    'name: CDP marker style',
    'description: CDP fixture output style. Ends every reply with a distinctive token.',
    '---',
    '',
    'Answer normally, then end EVERY reply with this exact token on its own line:',
    '',
    markers.outputStyle,
    '',
    'The token goes on every reply without exception, including one-word answers.',
  ])

  // MEMORY.md is APPENDED to. The operator's own memory in a live config dir is
  // not this fixture's to replace, and a marker that is merely present is all
  // AGT-4 needs.
  const memoryPath = join(configDir, 'MEMORY.md')
  const existingMemory = existsSync(memoryPath) ? await readFile(memoryPath, 'utf8') : ''
  if (existingMemory.includes(markers.memory)) {
    preserved.push(`${memoryPath} (already carries the marker)`)
  } else {
    await mkdir(configDir, { recursive: true })
    await writeFile(
      memoryPath,
      `${existingMemory}${existingMemory.endsWith('\n') || existingMemory === '' ? '' : '\n'}`
      + `\n- CDP fixture: the memory token for this project is ${markers.memory}\n`,
      'utf8',
    )
    written.push(memoryPath)
  }

  // ---- AGT-6 and RS-30: the hooks, MERGED into whatever is already there --
  // Shape: `AutomationMatcher` — `{ matcher?, actions: [{ type: 'command',
  // command }] }` keyed by lifecycle event, under a `hooks` root
  // (`automations/hooks-config.ts` `extractHooksMap` accepts `hooks`,
  // `automations`, or the bare map).
  const hooksPath = join(configDir, 'hooks.json')
  const hooksRaw = existsSync(hooksPath) ? await readFile(hooksPath, 'utf8') : ''
  let hooksDoc: Record<string, unknown> = {}
  if (hooksRaw.trim()) {
    try {
      hooksDoc = JSON.parse(hooksRaw) as Record<string, unknown>
    } catch {
      throw new Error(
        `${hooksPath} is not valid JSON. Refusing to overwrite it — fix or move it, then re-run. `
        + 'A fixture that replaces a config file it could not read is a fixture that eats the operator\'s hooks.',
      )
    }
  }
  const hookMap = (hooksDoc.hooks ?? hooksDoc.automations ?? {}) as Record<string, unknown[]>
  // Every marker is `<PREFIX>-<random hex>`, so a fresh mint yields the PREFIXES
  // without anyone listing them — the sweep below cannot fall behind the type.
  const cdpMarkerPrefixes = Object.values(mintMarkers()).map(minted => minted.replace(/-[0-9A-F]+$/i, '-'))
  const addHook = (event: string, entry: Record<string, unknown>, marker: string): void => {
    const list = Array.isArray(hookMap[event]) ? [...hookMap[event]] : []
    const already = list.some(row => JSON.stringify(row).includes(marker))
    if (already) {
      preserved.push(`${hooksPath} ${event} (already echoes ${marker})`)
      return
    }
    // Drop any earlier CDP hook for this event so a re-seed does not stack
    // several markers onto one turn — AGT-6's part 3 counts occurrences, and so
    // does RS-30's framing count.
    const kept = list.filter(row => !cdpMarkerPrefixes.some(prefix => JSON.stringify(row).includes(prefix)))
    hookMap[event] = [...kept, entry]
  }
  // D1.134 — the per-event matrix, INSTEAD of the three named hooks. See
  // `SeedOptions.hookMatrixDir` for why it replaces rather than joins them.
  let hookMatrix: SeedReport['hookMatrix']
  if (options.hookMatrixDir) {
    const hitDir = resolve(options.hookMatrixDir)
    await mkdir(hitDir, { recursive: true })
    for (const event of AGENT_EVENTS) {
      // Shell form: `hook-command.ts` spawns a command with no `args` through
      // `shell: true`, so `>>` is the shell's and not something this file has to
      // emulate. The two single-quoted words are the only interpolation, and
      // both are `[A-Za-z0-9/._-]` by construction (a minted marker, an event
      // name, and a path this fixture was handed) — so nothing inside them can
      // close a quote. The event name is written INTO the line as well as into
      // the file name, so a misattributed append is visible rather than silent.
      const hitFile = join(hitDir, `${event}.hit`)
      const append = `printf '%s\\n' '${markers.hookMatrix} ${event}' >> '${hitFile}'`
      addHook(event, {
        actions: [{
          type: 'command',
          command: event === 'UserPromptSubmit'
            ? `${append}; echo "The codeword for this turn is ${markers.promptHook}."`
            : append,
        }],
      }, `${markers.hookMatrix} ${event}`)
    }
    hookMatrix = { dir: hitDir, events: [...AGENT_EVENTS], marker: markers.hookMatrix }
    preserved.push(
      `${hooksPath} — the MATRIX was written (${AGENT_EVENTS.length} events); AGT-6's SessionStart and RS-30's `
      + 'PostToolUse hooks were NOT written, because `addHook` would have dropped them for those events anyway. '
      + 'AGT-6\'s UserPromptSubmit codeword rides the matrix entry for that event.',
    )
  }
  if (!options.hookMatrixDir) addHook('UserPromptSubmit', {
    actions: [{ type: 'command', command: `echo "The codeword for this turn is ${markers.promptHook}."` }],
  }, markers.promptHook)
  if (!options.hookMatrixDir) addHook('SessionStart', {
    matcher: 'compact',
    actions: [{ type: 'command', command: `echo "The session-start codeword is ${markers.compactHook}."` }],
  }, markers.compactHook)
  // RS-30 — the auto-mode classifier note. The payload is NESTED and nothing
  // else: `hooks.md#annotate-a-result-for-the-auto-mode-classifier` shows it
  // under `hookSpecificOutput` only — *"Return `classifierContext` to send a
  // short note about the tool call's result to the auto mode classifier rather
  // than to Claude"* — and `automations/hook-command.ts`'s reader is nested-only
  // to match, so a top-level copy would be read by neither.
  //
  // `printf '%s'` rather than `echo`, because the payload is JSON: the marker is
  // `[A-Z0-9-]` only and the JSON carries no single quote, so the whole document
  // sits inside one single-quoted shell word with nothing to escape.
  //
  // NO `matcher`, so every tool call is annotated. That is what RS-30's framing
  // count wants — but it is also why the case's own recipe tells the operator to
  // REMOVE this hook afterwards: left in place it annotates every PostToolUse of
  // every later session in this config dir.
  if (!options.hookMatrixDir) addHook('PostToolUse', {
    actions: [{
      type: 'command',
      command: `printf '%s' '${JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', classifierContext: markers.classifierHook },
      })}'`,
    }],
  }, markers.classifierHook)
  await writeJson(hooksPath, { ...hooksDoc, hooks: hookMap })
  written.push(hooksPath)

  // ---- AGT-8 + RS-35: the delivered managed policy, opt-in only ----------
  //
  // ONE document, because there is one: `managed-delivery.json` is a single
  // cache file, so writing it per key would mean the last caller silently
  // dropped the others' payload. The four keys are assembled and written once.
  let managedPolicy: SeedReport['managedPolicy']
  const managedPayload: Record<string, unknown> = {}
  // `availableModels` is in NEITHER approval category — `classifyManagedApproval`
  // raises items only for sandbox, allow-rule and env categories — so an
  // `availableModels`-only payload applies straight from the cache with no
  // approval and no root. `pluginTrustMessage`, `companyAnnouncements` and
  // `pluginSuggestionMarketplaces` are in none of the three either, for the same
  // reason and measured the same way.
  if (options.managedModels && options.managedModels.length > 0) managedPayload.availableModels = options.managedModels
  if (options.managedTrustMessage) managedPayload.pluginTrustMessage = options.managedTrustMessage
  if (options.managedAnnouncements && options.managedAnnouncements.length > 0) {
    managedPayload.companyAnnouncements = options.managedAnnouncements
  }
  if (options.managedPluginSuggestions && options.managedPluginSuggestions.length > 0) {
    managedPayload.pluginSuggestionMarketplaces = options.managedPluginSuggestions
  }
  if (Object.keys(managedPayload).length > 0) {
    const path = join(configDir, 'managed-delivery.json')
    await writeJson(path, { schemaVersion: 1, fetchedAt: Date.now(), payload: managedPayload })
    written.push(path)
    managedPolicy = { allowed: options.managedModels ?? [], path, keys: Object.keys(managedPayload) }
  }

  return {
    configDir, markers, written, preserved,
    ...(managedPolicy ? { managedPolicy } : {}),
    ...(hookMatrix ? { hookMatrix } : {}),
    ...(subagentProbes ? { subagentProbes } : {}),
  }
}

/** The invocation each row needs, printed so nobody has to reconstruct it. */
export function invocations(report: SeedReport): string {
  const { configDir, markers } = report
  const lines = [
    'Launch the app against this config dir first:',
    '',
    '```bash',
    `export NESSY_CONFIG_DIR=${configDir}`,
    'export NESSY_CDP_PORT=9223',
    '```',
    '',
    'Then, per row:',
    '',
    '```bash',
    '# AGT-4 — output style + session memory (the rewind half drives itself)',
    `NESSY_CDP_OUTPUT_STYLE_ID=custom:${FIXTURE_NAMES.outputStyle} \\`,
    `  NESSY_CDP_OUTPUT_STYLE_MARKER=${markers.outputStyle} \\`,
    `  NESSY_CDP_MEMORY_MARKER=${markers.memory} \\`,
    '  bun run scripts/cdp/cases/agt-4.ts',
    '',
    '# AGT-5 — one agent that declares an effort, one that declares none',
    `NESSY_CDP_HIGH_EFFORT_SUBAGENT=${FIXTURE_NAMES.deepAgent} \\`,
    `  NESSY_CDP_SESSION_EFFORT_SUBAGENT=${FIXTURE_NAMES.shallowAgent} \\`,
    '  bun run scripts/cdp/cases/agt-5.ts',
    '',
    '# AGT-6 — the two hook markers',
    `NESSY_CDP_PROMPT_HOOK_MARKER=${markers.promptHook} \\`,
    `  NESSY_CDP_COMPACT_HOOK_MARKER=${markers.compactHook} \\`,
    '  bun run scripts/cdp/cases/agt-6.ts',
    '',
    '# CRU-5 — the skilled agent, its marker, and the question only it can answer',
    `NESSY_CDP_SKILLED_AGENT=${FIXTURE_NAMES.skilledAgent} \\`,
    `  NESSY_CDP_PLAIN_AGENT=${FIXTURE_NAMES.plainAgent} \\`,
    `  NESSY_CDP_SKILL_MARKER=${markers.skill} \\`,
    '  NESSY_CDP_SKILL_QUESTION="What is the house marker?" \\',
    '  bun run scripts/cdp/cases/cru-5.ts',
    '',
    '# CDX-ROLES — the probes are on disk; it needs a codex card and an app log',
    'NESSY_CDP_APP_LOG=/tmp/app.log bun run scripts/cdp/cases/cdx-roles.ts',
    '',
    '# RS-30 — the PostToolUse hook above already prints this note to the classifier',
    `NESSY_CDP_CLASSIFIER_NOTE=${markers.classifierHook} \\`,
    '  bun run scripts/cdp/cases/rs-30.ts',
    '```',
    '',
    'RS-30\'s hook is the one to REMOVE when the sitting is over: it carries no matcher,',
    'so it annotates every PostToolUse of every later session in this config dir.',
  ]
  if (report.managedPolicy?.keys.some(key => key === 'pluginTrustMessage' || key === 'companyAnnouncements')) {
    lines.push(
      '',
      'RS-35 (C3.37 + C3.38) — the delivered document now carries '
        + report.managedPolicy.keys.join(', ') + '. RELAUNCH the app: the cache is read at',
      'startup. Then export what the case must find VERBATIM and drive it:',
      '',
      '```bash',
      'NESSY_CDP_TRUST_MESSAGE="<the same sentence you passed to --trust-message>" \\',
      '  NESSY_CDP_ANNOUNCEMENTS="<entry 1>|<entry 2>" bun run scripts/cdp/cases/rs-35.ts',
      '',
      '# the CONTROL is the same case with the policy gone, which it refuses to',
      '# guess at: remove the file, RELAUNCH, then',
      `rm ${report.managedPolicy.path}`,
      'NESSY_CDP_POLICY_WITHDRAWN=1 bun run scripts/cdp/cases/rs-35.ts',
      '```',
    )
  }
  if (report.managedPolicy) {
    lines.push(
      '',
      'AGT-8 is a TWO-SITTING row — the allowlist is fixed for the process lifetime:',
      '',
      '```bash',
      `# sitting 1: the policy at ${report.managedPolicy.path} is in force`,
      '#            (allowed: ' + report.managedPolicy.allowed.join(', ') + ')',
      'NESSY_CDP_BLOCKED_MODEL=<any id NOT in that list> bun run scripts/cdp/cases/agt-8.ts',
      '',
      '# sitting 2: remove the file, RELAUNCH the app, then',
      `rm ${report.managedPolicy.path}`,
      'NESSY_CDP_BLOCKED_MODEL=<the same id> NESSY_CDP_POLICY_WITHDRAWN=1 \\',
      '  bun run scripts/cdp/cases/agt-8.ts',
      '```',
    )
  } else {
    lines.push(
      '',
      'AGT-8 needs a managed policy, which is NOT written by default because it narrows',
      'the model list of every session in this config dir. Add it with:',
      '',
      '```bash',
      'bun run scripts/cdp/fixtures/agent-surfaces.ts --managed <one-model-id-to-allow>',
      '```',
    )
  }
  lines.push(
    '',
    'A scratch config dir has no gateway cards. For the rows that need a live runtime,',
    'seed connections into the same dir as well:',
    '',
    '```bash',
    'NESSY_CDP_RTS_ROOT=$(dirname "$NESSY_CONFIG_DIR") bun run scripts/cdp/fixtures/runtime-switch.ts',
    '```',
  )
  return lines.join('\n')
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const valueOf = (flag: string): string | undefined => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }
  // The teardown half — `--remove-hooks`, PR-7. It runs INSTEAD of a seed and
  // exits, because a run that removed the hooks and then wrote them back would
  // be a no-op wearing a flag.
  if (argv.includes('--remove-hooks')) {
    const report = await removeCdpHooks(valueOf('--config-dir'))
    console.log(JSON.stringify(report, null, 2))
    console.log(
      report.removed.length > 0
        ? `\nRemoved ${report.removed.length} CDP hook(s) from ${report.file}. RS-30's PostToolUse hook carries no matcher, so this is the end of the sitting for it.`
        : `\nNo CDP hook found in ${report.configDir} — nothing to remove.`,
    )
    process.exit(0)
  }
  const managed = argv.indexOf('--managed')
  // D1.134 — `--hook-matrix <dir>`: one command hook per AgentEvent, each
  // appending to `<dir>/<Event>.hit`. It REPLACES the three named hooks (see
  // `SeedOptions.hookMatrixDir`), so it is a flag rather than a default.
  const hookMatrixDir = valueOf('--hook-matrix')
  // D1.135 — `--subagent-probes <dir>`: the four field probes. Opt-in, because
  // four extra agents change what every session in that config dir is offered.
  const subagentProbeDir = valueOf('--subagent-probes')
  // RS-35: `--announce` takes a LIST for the same reason `--managed` does — the
  // page's rule is about a list, and a one-entry fixture cannot tell "the first
  // entry" from "the only entry". `--trust-message` takes one value.
  const announce = argv.indexOf('--announce')
  const report = await seedAgentSurfaces({
    ...(valueOf('--config-dir') ? { configDir: valueOf('--config-dir')! } : {}),
    fresh: argv.includes('--fresh'),
    ...(managed >= 0
      ? { managedModels: argv.slice(managed + 1).filter(entry => !entry.startsWith('--')) }
      : {}),
    ...(valueOf('--trust-message') ? { managedTrustMessage: valueOf('--trust-message')! } : {}),
    ...(hookMatrixDir ? { hookMatrixDir } : {}),
    ...(subagentProbeDir ? { subagentProbeDir } : {}),
    ...(announce >= 0
      ? { managedAnnouncements: argv.slice(announce + 1).filter(entry => !entry.startsWith('--')) }
      : {}),
  })
  console.log(JSON.stringify({
    configDir: report.configDir,
    markers: report.markers,
    written: report.written,
    preserved: report.preserved,
    ...(report.managedPolicy ? { managedPolicy: report.managedPolicy } : {}),
    ...(report.hookMatrix ? { hookMatrix: report.hookMatrix } : {}),
    ...(report.subagentProbes ? { subagentProbes: report.subagentProbes } : {}),
  }, null, 2))
  console.log(`\n${invocations(report)}`)
}
