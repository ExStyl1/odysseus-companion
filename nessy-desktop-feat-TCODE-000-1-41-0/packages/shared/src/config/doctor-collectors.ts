/**
 * P6.684 — the doctor's collectors, where every surface can reach them.
 *
 * **Eight of them, and the arithmetic is worth stating because two sentences
 * about it were already wrong.** P6.684 moved SIX out of `apps/cli/src/doctor.ts`
 * (`collectMandatedPluginFindings`, `collectAgentDefinitionFindings`,
 * `collectInstructionFileFindings`, `collectSearchBackendInput`,
 * `collectNetworkTrustInput`, `collectUncarriedSandboxKeys`), four of them
 * module-private — its own commit message and this header both said *"five …
 * three module-private"*, counted 2026-09-08 by P6.760 against the diff. P6.760
 * then moved the seventh, `collectUserAutoModeInput`, which P6.684 had left
 * behind ON PURPOSE so that its own done-means stayed checkable against a fixed
 * number. P6.878 then ADDED the eighth, `collectStoredConfigValidationInput` —
 * born here rather than moved, because no surface had it: it is the first
 * reader of `validateConfig()` outside the `config_validate` session tool.
 * Count the exports rather than quoting this paragraph:
 * `grep -c '^export function collect' packages/shared/src/config/doctor-collectors.ts`.
 *
 * They lived inside `apps/cli/src/doctor.ts`. `buildConfigDoctorReport` and `buildSettingsTiersSessionClauses`
 * both take the record they produce, so the desktop's D12 surface and the
 * session-start settings line each reported a NARROWER version of the same
 * record and each disclosed the gap in its own words — the mandate clause and
 * the instruction-file clause simply never fired outside the CLI.
 *
 * Nothing here is new. The bodies, and their reasons, are the CLI's own, moved
 * so that "what the doctor knows" stops being a property of which process is
 * asking. Two of them gained a PARAMETER where they used to reach for a value
 * only one caller could produce — the managed `enabledPlugins` map, which is
 * `server-core`'s to resolve, and `isPackaged`, on which the CLI and the
 * desktop genuinely differ. Both default to the CLI's previous answer, so that
 * caller is byte-identical.
 *
 * Every collector keeps the distinction the input fields document:
 * `undefined` is *"I could not look"* and omits the section, an empty array is
 * *"I looked and found none"*. They are different answers and a collector that
 * conflated them would make the report lie in the quiet direction.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  instructionFileSections,
  type AgentDefinitionFindingV1,
  type ConfigOnlySettingV1,
  type ConfigOnlySettingsDoctorInputV1,
  type InstructionFileFindingV1,
  type GatewayAuthDoctorInputV1,
  type NetworkTrustDoctorInputV1,
  type SearchBackendDoctorInputV1,
  type StoredConfigValidationDoctorInputV1,
  type StoredConfigValidationIssueV1,
} from './config-doctor.ts'
import { validateConfig } from './validators.ts'
import { getNetworkProxySettings, getSessionToolUniverse, loadStoredConfig } from './storage.ts'
import { documentedUncarriedSandboxKeys } from './sandbox-settings.ts'
import { resolveTlsCaRuntime } from './network-tls-ca.ts'
import { resolveClientIdentityRuntime } from './network-mtls.ts'
// DA1.34 — the LEAF modules, not the `auth/dp` barrel: the barrel imports
// `config/managed-delivery.ts` and would drag the managed-settings graph in
// behind one credential read.
import { getCredsPath } from '../auth/dp/creds-store.ts'
import { isJwtShaped, isUsableJwt } from '../auth/dp/jwt.ts'
import { NESSY_DP_AUTH_TOKEN_ENV, cliEnvTokenIsTheOnlyOne } from '../auth/dp/env-token.ts'
import { resolveDpRuntime } from '../auth/dp/dp-binary.ts'
import {
  instructionFileExistsAt,
  projectInstructionFilesIn,
} from '../capabilities/instruction-files.ts'
import { resolveBackendHostTooling } from '../agent/backend/index.ts'
import { validatePiRuntimeAgentDefinitionContent } from '../agent/pi-harness/runtime-agent-definition.ts'
import {
  readUserScopeAutoModePolicy,
  type UserScopeAutoModeReadV1,
} from '../agent/pi-harness/user-auto-mode-policy.ts'
import { validateMarkdownAgentDefinitionContent } from '../agents/index.ts'
import {
  resolveMandatedPluginFindings,
  type MandatedPluginFindingV1,
} from '../plugins/index.ts'
import { CONFIG_DIR, PLUGINS_DIR } from '../workspaces/index.ts'

function readRegistryJson<T>(path: string): T | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as T : undefined
  } catch {
    return undefined
  }
}

/**
 * What each managed `enabledPlugins: true` entry can do on this machine.
 *
 * The managed `enabledPlugins` map is a PARAMETER rather than a read, and that
 * is what lets this live in `packages/shared` at all: resolving the enforced
 * policy is `server-core`'s, one layer up, and a shared module that reached for
 * it would invert the dependency. The caller that owns the process resolves it —
 * `config-doctor.ts` states the same rule in its own header. `undefined` means
 * the caller could not resolve one, which omits the section.
 * `doctor` is read-only and session-free (`debug-your-config.md:46`), so it
 * builds no plugin store, takes no lock and acquires no lease — it reads the two
 * registry files directly. Both reads degrade to "nothing known" rather than
 * throwing: a checkup that dies on one malformed file is worse than one that
 * reports the rest, and a malformed registry already surfaces on every other
 * plugin path.
 */
export function collectMandatedPluginFindings(
  enabledPlugins: Readonly<Record<string, boolean>> | undefined,
): readonly MandatedPluginFindingV1[] | undefined {
  const installed = readRegistryJson<{ active?: Record<string, unknown> }>(join(PLUGINS_DIR, 'installed.json'))
  const marketplaces = readRegistryJson<{ registries?: unknown[] }>(join(PLUGINS_DIR, 'marketplaces.json'))
  return resolveMandatedPluginFindings({
    ...(enabledPlugins ? { enabledPlugins } : {}),
    installedPluginKeys: Object.keys(installed?.active ?? {}),
    marketplacesRegistered: Array.isArray(marketplaces?.registries) ? marketplaces.registries.length : 0,
  })
}

/**
 * `AGENTS.md` / `CLAUDE*` are instruction files, never agent definitions —
 * the same exclusion the capability discovery scan applies
 * (`packages/shared/src/agents/definitions.ts`).
 */
const INSTRUCTION_FILE_NAMES = new Set(['agents.md', 'claude.md', 'claude.local.md'])

/**
 * Validate every agent definition in the global agents directory with the
 * SAME code the send path uses to build one, so what this reports and what
 * the runtime skips can never disagree.
 *
 * The runtime skips a malformed definition rather than failing the session
 * (A1 — one `tools: []` file used to kill every send in every session), and
 * its own channel is the session log; this listing is where the skip gets
 * named. `debug-your-config.md:26` puts the subagent checkup here: "Setup
 * checkup: installation health, invalid settings files, unused extensions,
 * duplicate subagent names in the same directory, and checked-in `CLAUDE.md`
 * content."
 *
 * A missing directory means no agents and no findings; an unreadable one
 * returns `undefined` — "I could not look" — so the section is omitted rather
 * than claiming every definition is valid.
 */
export function collectAgentDefinitionFindings(
  agentsDir: string = join(CONFIG_DIR, 'agents'),
): readonly AgentDefinitionFindingV1[] | undefined {
  if (!existsSync(agentsDir)) return []
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(agentsDir, { withFileTypes: true })
  } catch {
    return undefined
  }
  const findings: AgentDefinitionFindingV1[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
    if (INSTRUCTION_FILE_NAMES.has(entry.name.toLowerCase())) continue
    const file = join(agentsDir, entry.name)
    const agentName = entry.name.replace(/\.md$/i, '')
    let content: string
    try {
      content = readFileSync(file, 'utf-8')
    } catch {
      findings.push({ file, agentName, reason: 'file could not be read' })
      continue
    }
    const result = validatePiRuntimeAgentDefinitionContent({ name: agentName, content })
    if (!result.ok) {
      findings.push({ file, agentName, reason: result.reason })
      continue
    }
    // A2: the global agents directory is ALSO read by the markdown fallback
    // loader (`packages/shared/src/agents/definitions.ts`), whose parse is not
    // identical — it validates `toolset`, for example. A file that loads for
    // the capability pipeline but is skipped by the fallback loader deserves
    // naming too, from the same strict-validator-per-loader pattern.
    // Workspace/project agent directories stay OUT of this scan: doctor is
    // session-free (`debug-your-config.md:46` — "without starting a session")
    // and has no workspace or trusted-project context to resolve them from.
    const fallback = validateMarkdownAgentDefinitionContent(entry.name, content)
    if (!fallback.ok) {
      findings.push({ file, agentName, reason: `${fallback.reason} (markdown fallback loader)` })
    }
  }
  return findings
}

/**
 * P6.398 — measure the checked-in project instruction files in the working
 * directory, so the report can propose a trim for one that has outgrown itself.
 *
 * The last clause of `debug-your-config.md:26`'s scope sentence — "…and
 * checked-in `CLAUDE.md` content" — and the only item in it this checkup did
 * not carry.
 *
 * The WORKING DIRECTORY, deliberately, and it is the honest boundary rather
 * than a shortcut: doctor is session-free (`debug-your-config.md:46` — "without
 * starting a session"), so it has no workspace and no trusted-project context
 * to resolve, exactly as `collectAgentDefinitionFindings` says one sentence
 * above. A user runs it in the repository they are asking about.
 *
 * `projectInstructionFilesIn` rather than a local list of names, so codex's
 * per-directory supersession rule (`AGENTS.override.md` silences `AGENTS.md`)
 * is honoured here as everywhere else: a superseded file is not loaded, so
 * proposing cuts to it would be advice about a file nothing reads.
 *
 * An unreadable file is skipped rather than reported as zero lines — an empty
 * measurement is worse than a missing one — and an unreadable DIRECTORY returns
 * `undefined`, which omits the section: "no instruction file" and "I could not
 * look" are different answers.
 */
export function collectInstructionFileFindings(
  directory: string = process.cwd(),
): readonly InstructionFileFindingV1[] | undefined {
  let names: readonly string[]
  try {
    names = projectInstructionFilesIn(directory)
  } catch {
    return undefined
  }
  const findings: InstructionFileFindingV1[] = []
  for (const name of names) {
    const path = join(directory, name)
    if (!instructionFileExistsAt(path)) continue
    let content: string
    try {
      content = readFileSync(path, 'utf-8')
    } catch {
      continue
    }
    const sections = instructionFileSections(content)
    findings.push({
      path,
      lineCount: sections.reduce((total, entry) => total + entry.lineCount, 0),
      sections,
    })
  }
  return findings
}

/**
 * P6.359 — which ripgrep this host's session search resolves to.
 *
 * `troubleshooting.md#search-and-discovery-issues` ends its remedy with a
 * verification step we could not perform on any runtime, verbatim: *"run
 * `claude doctor` in your terminal and check that the Search line shows the
 * path of your system ripgrep instead of `OK (bundled)`."* There was no Search
 * line, so the resolved binary was unobservable.
 *
 * Resolved through the same `resolveBackendHostTooling` the search service
 * itself calls, so the report cannot drift from what search actually runs — a
 * re-derivation here would be a second implementation of the resolver's four
 * branches, and this file is the read-only checkup, not a second resolver.
 *
 * `isPackaged` is a PARAMETER, because the two callers differ on exactly this:
 * the CLI is not an Electron bundle and may consult PATH, and the desktop is
 * one. It defaults to the CLI's answer so that caller reads as it did.
 */
export function collectSearchBackendInput(
  hostRuntime: { appRootPath?: string; isPackaged?: boolean } = {},
): SearchBackendDoctorInputV1 | undefined {
  const isPackaged = hostRuntime.isPackaged ?? false
  try {
    const { ripgrepPath } = resolveBackendHostTooling({
      hostRuntime: { appRootPath: hostRuntime.appRootPath ?? process.cwd(), isPackaged },
    })
    return { isPackaged, ...(ripgrepPath === undefined ? {} : { ripgrepPath }) }
  } catch {
    // "Could not look" is not "looked and found none": returning `undefined`
    // omits the section, which is the distinction the input field documents.
    return undefined
  }
}

/**
 * P6.255 (c) — the network trust chain, read once from the same resolvers the
 * app itself uses.
 *
 * `resolveTlsCaRuntime` and `resolveClientIdentityRuntime` are the SAME
 * functions `apps/electron/src/main/network-proxy.ts` calls, so this report
 * cannot describe a chain the app does not build. Both return certificate and
 * key BYTES; nothing but the tier, the paths and the error text is carried
 * forward — `NetworkTrustDoctorInputV1`'s header states that rule and this is
 * the call site it exists for.
 *
 * The four documented names come FIRST, in the page's order
 * (`network-config.md`: *"Lowercase variants also work, and Claude Code uses the
 * first one that's set in the order `https_proxy`, `HTTPS_PROXY`, `http_proxy`,
 * `HTTP_PROXY`."*), so the first entry really is the winner. `ALL_PROXY` and its
 * lowercase twin come after: they are no part of that chain — the app never
 * writes them and `unified-network-interceptor.ts` never reads them — but a
 * login shell often exports one, and an operator debugging a route needs to see
 * it in the same place as the names that do bind.
 */
const PROXY_ENV_CHAIN = [
  'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY',
  'ALL_PROXY', 'all_proxy',
] as const

/**
 * DA1.34 — the shared gateway credential's state, read the way the doctor's
 * other collectors read: in THIS module, because `config-doctor.ts` takes every
 * input and performs no reads of its own.
 *
 * The creds file is opened directly rather than through `getValidCreds`, and
 * that is the whole point: `getValidCreds` answers null for an absent file, an
 * unparseable one, a non-JWT value and an expired one alike, and the question
 * this section exists to answer is WHICH. The leaf modules are imported rather
 * than the `auth/dp` barrel, which pulls `config/managed-delivery.ts` and would
 * make this collector drag the managed-settings graph behind it.
 *
 * NO TOKEN VALUE LEAVES THIS FUNCTION. What does leave it: a length, booleans,
 * a code, and — since DA1.56 — the dp binary's own filesystem path and the rung
 * that chose it. A path is not a credential, and it is the one fact that tells
 * an operator whether an unrunnable `NESSY_DP` fell through silently.
 */
function collectDpBinary(): GatewayAuthDoctorInputV1['dpBinary'] {
  try {
    // `ensureStateRoot` is a NO-OP here, and since F1.363 the ladder no longer
    // reads it: it created `<CONFIG_DIR>/dp/state` at 0700 when there was no
    // `~/.dp`, and now writes nothing (dp keeps its own default). The no-op
    // stays as a guard, because `doctor` reports what it finds and must not
    // change the machine it is diagnosing if a write ever returns. Only
    // `dpPath` and `source` are read here, and neither depends on that
    // directory existing.
    const runtime = resolveDpRuntime({ ensureStateRoot: () => {} })
    return { source: runtime.source, path: runtime.dpPath }
  } catch {
    // The ladder throws `DpNotFound` when no candidate was runnable. Rendering
    // that as a value rather than swallowing it is the point of the field: an
    // unrunnable `NESSY_DP` used to be indistinguishable from an unset one.
    return { source: 'not-found' }
  }
}

export function collectGatewayAuthInput(): GatewayAuthDoctorInputV1 | undefined {
  const envTokenPresent = (process.env[NESSY_DP_AUTH_TOKEN_ENV] ?? '').trim().length > 0
  const cliEnvTokenOnly = cliEnvTokenIsTheOnlyOne(process.env)
  // Independent of the creds file, so it is read once and carried on every
  // return path below — including the two that answer before the file is even
  // parsed, which are exactly the states an operator is debugging when they
  // need to know which dp would run.
  const dpBinary = collectDpBinary()

  let raw: string
  try {
    raw = readFileSync(getCredsPath(), 'utf-8')
  } catch {
    return {
      credentialsFile: 'absent',
      reMintReason: envTokenPresent ? 'ok' : 'no_credentials',
      envTokenPresent,
      cliEnvTokenOnly,
      dpBinary,
    }
  }

  let parsed: { jwt?: unknown; expiresAt?: unknown }
  try {
    parsed = JSON.parse(raw) as { jwt?: unknown; expiresAt?: unknown }
  } catch {
    return {
      credentialsFile: 'unreadable',
      reMintReason: 'credentials_unreadable',
      envTokenPresent,
      cliEnvTokenOnly,
      dpBinary,
    }
  }

  const jwt = typeof parsed.jwt === 'string' ? parsed.jwt : ''
  const shaped = isJwtShaped(jwt)
  const decodes = isUsableJwt(jwt)
  const expiresAt = typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined
  const expiresInMinutes = expiresAt === undefined ? undefined : (expiresAt - Date.now()) / 60_000

  // Ordered the way the runtime fails, and the third arm is the one a reading of
  // `loadCreds` added: a value that cannot be decoded is refused before its
  // expiry is ever consulted (DA1.26), and a record whose `expiresAt` is not a
  // NUMBER is refused by `loadCreds` before `getValidCreds` compares anything at
  // all — so such a file is `credentials_unreadable` here rather than `ok`. The
  // first draft called it `ok`, which would have told an operator the credential
  // was fine while every turn on the machine took the no-credential path.
  const reMintReason: GatewayAuthDoctorInputV1['reMintReason'] =
    jwt.length === 0 ? 'no_credentials'
      : !decodes ? 'credentials_unparseable'
        : expiresInMinutes === undefined ? 'credentials_unreadable'
          : expiresInMinutes <= 0 ? 'credentials_expired'
            : 'ok'

  return {
    credentialsFile: 'present',
    jwtLength: jwt.length,
    jwtShaped: shaped,
    jwtDecodes: decodes,
    ...(expiresInMinutes === undefined ? {} : { expiresInMinutes }),
    reMintReason,
    envTokenPresent,
    cliEnvTokenOnly,
    dpBinary,
  }
}

export function collectNetworkTrustInput(): NetworkTrustDoctorInputV1 | undefined {
  let settings
  try {
    settings = getNetworkProxySettings()
  } catch {
    // An unreadable config is already reported by the managed-settings sections
    // above; reporting a chain we could not resolve would be worse than saying
    // nothing, because "none" and "unknown" are different answers.
    return undefined
  }
  const ca = resolveTlsCaRuntime(settings)
  const identity = resolveClientIdentityRuntime(settings)
  return {
    proxyEnv: PROXY_ENV_CHAIN.flatMap((name): { name: string; value: string }[] => {
      const value = process.env[name]
      return value === undefined ? [] : [{ name, value }]
    }),
    ...(process.env.NO_PROXY ?? process.env.no_proxy
      ? { noProxy: process.env.NO_PROXY ?? process.env.no_proxy }
      : {}),
    caSource: ca.source,
    ...(ca.path === undefined ? {} : { caPath: ca.path }),
    ...(ca.warning === undefined ? {} : { caWarning: ca.warning }),
    clientCertificate: identity.identity !== undefined,
    ...(identity.error === undefined ? {} : { clientCertificateError: identity.error }),
    mtlsReloadDisabled:
      process.env.CLAUDE_CODE_DISABLE_MTLS_RELOAD_ON_STALE_CONNECTION !== undefined,
  }
}

/**
 * The documented-but-uncarried `sandbox.*` keys this machine's settings carry.
 *
 * P6.710. P6.233 made the parser ACCEPT these keys — one documented key used to
 * cost the operator every other key in the same block — and put the naming on
 * `resolveHostSandboxSettings`'s diagnostic channel, which is the SESSION path.
 * `debug-your-config.md` scopes the terminal form to "read-only installation and
 * settings diagnostics **without starting a session**", so until now the only
 * way to read back an accepted-and-carried-nowhere key was to start a session.
 *
 * Read in this module for the reason `config-doctor.ts` states in its own
 * header: the process owner does the reads, and `buildConfigDoctorReport` takes
 * every input rather than performing any.
 * The list itself comes from the ONE exported function the session path calls,
 * so the two surfaces cannot name different keys.
 *
 * An unreadable config returns `undefined` — "I could not look" — so the section
 * is omitted rather than claiming the block carries nothing.
 */
export function collectUncarriedSandboxKeys(): readonly string[] | undefined {
  try {
    return documentedUncarriedSandboxKeys(loadStoredConfig()?.sandbox)
  } catch {
    return undefined
  }
}

/**
 * P6.493's settings surface — the safety judge's USER scope.
 *
 * Read in this module for the reason `config-doctor.ts` states in its own
 * header: the process owner does the reads, and `buildConfigDoctorReport` takes
 * every input rather than performing any.
 *
 * P6.760 moved it here from `apps/cli/src/doctor.ts`, where P6.684 had left it
 * deliberately: that row's text named five collectors, and a lane that quietly
 * lifts one more makes the row's own done-means unverifiable. It was never a
 * different KIND of collector — the doctor's report and the session-start
 * settings line take the same `userAutoMode` input, and while this function was
 * CLI-private only the CLI could fill it, which is the identical narrowing
 * P6.684 closed for the other six.
 *
 * {@link readUserScopeAutoModePolicy} never throws for an unreadable or
 * malformed settings file — it reports that inside the record it returns — so
 * this wrapper exists for the OTHER failure: a read that throws for a reason the
 * reader does not model must not take a caller down, and must be distinguishable
 * from a clean read. `undefined` is *"I could not look"* and omits the section,
 * exactly as every collector above.
 */
export function collectUserAutoModeInput(): UserScopeAutoModeReadV1 | undefined {
  try {
    return readUserScopeAutoModePolicy()
  } catch {
    return undefined
  }
}

/**
 * P6.878 — the eighth collector: every `config.json` value the schema refused.
 *
 * ## The defect it closes
 *
 * Six keys in `validators.ts` carry the same sentence in their own comments —
 * `crossSessionInbound`, `neverPersistSessions`, `unattendedApprovalFallback`,
 * `claudeSwitchModelsOnFlag` among them — each typed there because the
 * production load path is unknown-tolerant on purpose, so a wrong value
 * resolves to the vendor default SILENTLY, and *"`validateConfig()` is then the
 * only place a user learns their value never took effect"*. W9-aw measured
 * (P6.874) where that report actually reaches a person, and the answer was: not
 * proactively. Its only live route is the `config_validate` session tool, on
 * demand, in a session nobody is prompted to start.
 *
 * ## Why the dead callback was deleted rather than wired here
 *
 * The watcher's own route was `onValidationError` →
 * `config-watcher-manager.ts` → a public property on `BaseAgent` that was
 * DECLARED, nulled at teardown and **assigned by nobody**; it ended in
 * `debug()`, and a packaged build logs nothing outside debug mode. P6.884
 * (`47eafa2ea`) deleted that property, so the chain now stops at the watcher's
 * own debug line and this collector is the only user-facing route left.
 * Giving it a writer would have
 * built a second, session-scoped channel for a fact the doctor already
 * assembles for two surfaces — against the owner's smallest-integration rule
 * (2026-09-05) and against native-first: the host already HAS a place where a
 * user reads what their configuration actually does, and the settings page and
 * the CLI render it from one record. So this row took the collector route, and
 * P6.884 then removed the property rather than leaving it for the next lane to
 * rediscover. Re-adding a second channel here is re-opening that decision.
 *
 * ## Shape
 *
 * The user rung only, which is all `validateConfig()` reads: `CONFIG_FILE` is
 * `<config dir>/config.json` and nothing else. `.claude/settings.json` has its
 * own resolver and its own warning; this is not that file.
 *
 * The path is derived here rather than imported because `validators.ts` keeps
 * its `CONFIG_FILE` module-private — the SAME derivation, `CONFIG_DIR` plus
 * `config.json`, and it must track that constant if it ever moves.
 *
 * Errors before warnings, both flattened into one list carrying its severity:
 * the report renders them in one section with a per-line marker, and
 * `validateConfig()`'s own two lists are an artefact of `ValidationResult`
 * rather than a distinction the reader needs twice.
 *
 * `undefined` is *"I could not look"* and omits the section, as everywhere in
 * this module. `validateConfig()` reports a missing or unparseable file INSIDE
 * the result rather than by throwing, so that stays a record — an absent
 * `config.json` is a real answer about this machine, not a failed read.
 */
export function collectStoredConfigValidationInput():
StoredConfigValidationDoctorInputV1 | undefined {
  try {
    const result = validateConfig()
    const issues: StoredConfigValidationIssueV1[] = [
      ...result.errors.map((issue): StoredConfigValidationIssueV1 => ({
        // `path` is empty for a whole-file fault ("Config file does not
        // exist", "Invalid JSON"); the issue's own `file` is what names it
        // then, and an empty key would render as a bare colon.
        key: issue.path || issue.file,
        message: issue.message,
        severity: 'error',
      })),
      ...result.warnings.map((issue): StoredConfigValidationIssueV1 => ({
        key: issue.path || issue.file,
        message: issue.message,
        severity: 'warning',
      })),
    ]
    return { file: join(CONFIG_DIR, 'config.json'), issues }
  } catch {
    return undefined
  }
}

/**
 * P6.824 — the six settings a user can reach only by editing a file.
 *
 * ## Why they are here and not on a settings page
 *
 * The controller's P6.810 recommendation, applied once to the whole family
 * rather than six times: an operator-shaped key surfaces in the doctor and the
 * settings reference, not in a control beside the model picker. Each of the six
 * arrived with its own row, its own strict-envelope entry and its own tests, and
 * none of them arrived with a way for the person running the app to see what it
 * is set to. Their DEFAULTS are unchanged by this collector — it reads.
 *
 * ## One file now, and the second one is the row this collector produced
 *
 * All six live in `config.json` and are hand-editable there. Two of them did
 * not when this collector was written: `sessionAllowedTools` and
 * `sessionDisallowedTools` sat in `config-defaults.json`'s `workspaceDefaults`,
 * which is NOT a user file — `syncConfigDefaults` writes the bundled asset over
 * the user copy on every launch and the bundled asset shipped neither key, so
 * their value was always the empty list and a hand-written entry was gone by
 * the next start. This collector is what made that visible, and P6.912 moved
 * them onto the strict envelope beside their four neighbours. So every row here
 * now names a path, and the `settableIn`-less shape the two used to need is
 * gone with them.
 *
 * ## Reading them
 *
 * The RAW read decides `source` and the public reader decides `value`, because
 * only the raw read can tell "the user wrote `true`" from "the default is
 * `true`" — `getFileCheckpointingEnabled()` returns a boolean either way. The
 * unknown-tolerant rule those readers document is respected here too: a value of
 * the wrong type is not a user value, because it never took effect. It is
 * already reported, by key and by message, in the section above this one.
 *
 * `undefined` is *"I could not look"* and omits the section, as everywhere in
 * this module. Since P6.912 every read here is `loadStoredConfig()`, which
 * throws on an unparseable or layout-refused `config.json` — the only way this
 * collector can fail, and the one state in which reporting a value would be a
 * guess.
 */
export function collectConfigOnlySettings(): ConfigOnlySettingsDoctorInputV1 | undefined {
  try {
    const configFile = join(CONFIG_DIR, 'config.json')
    const stored = loadStoredConfig() as Record<string, unknown> | null

    /** A three-state boolean: unset leaves the runtime's own default alone. */
    const tristate = (key: string, unsetMeans: string): ConfigOnlySettingV1 => {
      const raw = stored?.[key]
      return typeof raw === 'boolean'
        ? { key, value: String(raw), source: 'user', settableIn: configFile }
        : { key, value: `unset — ${unsetMeans}`, source: 'default', settableIn: configFile }
    }

    const append = stored?.systemPromptAppend
    const checkpointing = stored?.fileCheckpointingEnabled
    const universe = getSessionToolUniverse()

    /**
     * P6.912 — read from `config.json` like every other row here, and pointed at
     * it. The RAW read still decides `source` while the public reader decides
     * `value`, for the reason the header gives: only the raw read can tell a
     * user's empty list from an absent key, and `getSessionToolUniverse()`
     * returns `[]` for both.
     */
    const universeRow = (key: string, names: readonly string[]): ConfigOnlySettingV1 => {
      // F1.661 — only the WHITELIST is checked: a blacklist entry may be a rule (`Bash(rm:*)`, `mcp__x__*`).
      const warnings = key === 'sessionAllowedTools' ? claudeWhitelistEntryWarnings(names) : []
      return {
        key,
        value: names.length === 0 ? 'empty — no restriction' : names.join(', '),
        source: Array.isArray(stored?.[key]) ? 'user' : 'default',
        settableIn: configFile,
        ...(warnings.length > 0 ? { warnings } : {}),
      }
    }

    return {
      settings: [
        tristate('claudeExplorePlanAgentsEnabled', "claude's own Explore and Plan subagents stay on"),
        tristate('claudeSwitchModelsOnFlag', "the vendored SDK's default, which is on"),
        {
          key: 'systemPromptAppend',
          value: typeof append === 'string' && append.trim()
            ? append
            : 'unset — nothing is appended to the system prompt',
          source: typeof append === 'string' && append.trim() ? 'user' : 'default',
          settableIn: configFile,
        },
        {
          key: 'fileCheckpointingEnabled',
          value: typeof checkpointing === 'boolean' ? String(checkpointing) : 'true (the default)',
          source: typeof checkpointing === 'boolean' ? 'user' : 'default',
          settableIn: configFile,
        },
        universeRow('sessionAllowedTools', universe.allowed),
        universeRow('sessionDisallowedTools', universe.disallowed),
      ],
    }
  } catch {
    return undefined
  }
}

/**
 * F1.661 (origin WJ-crit-b P-WJcritb-1) — every name claude's `tools` option can know, so the doctor can say which
 * `sessionAllowedTools` entries claude IGNORES. Since F1.638 the whitelist reaches claude as `tools`
 * (`buildClaudeSessionToolsOption` in `agent/claude-agent.ts`), and the child drops what it does not know WITHOUT a
 * word: measured on the vendored 2.1.267 (rig `work/wjcritb/`, arms `raw-mixed` and `raw-scoped`), `NoSuchTool`,
 * `mcp__session__Monitor` and `Bash(ls:*)` were ignored, and `['Bash(ls:*)', 'Read']` left the child with `Read` alone.
 *
 * A SUPERSET on purpose, so a name missing from it over-warns and a name wrongly in it only under-reports: the table
 * at the top of `tools-reference.md` (46 names under the H1, read 2026-09-26); the vendored SDK's own tool schemas
 * (`sdk-tools.d.ts`, one `<Name>Input` each) the page does not list; and the `aliases` the vendored binary declares
 * on its tools (`Task` is what the child's own init message still calls `Agent`). The doctor collectors test pins
 * this against `sdk-tools.d.ts`, so a vendored bump that adds a tool fails there rather than warning here.
 */
export const CLAUDE_KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  // tools-reference.md, the table under the H1
  'Agent', 'Artifact', 'AskUserQuestion', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'Edit', 'EndConversation',
  'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree', 'Glob', 'Grep', 'ListAgents',
  'ListMcpResourcesTool', 'LSP', 'Monitor', 'NotebookEdit', 'PowerShell', 'PushNotification', 'Read',
  'ReadMcpResourceTool', 'RemoteTrigger', 'ReportFindings', 'ScheduleWakeup', 'SendFeedback', 'SendMessage',
  'SendUserFile', 'ShareOnboardingGuide', 'Skill', 'SubagentHandback', 'TaskCreate', 'TaskGet', 'TaskList',
  'TaskOutput', 'TaskStop', 'TaskUpdate', 'TodoWrite', 'ToolSearch', 'WaitForMcpServers', 'WebFetch', 'WebSearch',
  'Workflow', 'Write',
  // sdk-tools.d.ts only (2.1.267; at 2.1.280 — UA12.211 — the SDK removed the
  // TaskOutput and REPL tools, `TaskOutputInput`/`REPLInput` are gone from
  // sdk-tools.d.ts, 45 → 43 declarations. Both names STAY below on purpose: a
  // stored permission rule naming either must not read as unknown, and this set
  // is a superset, so a stale name only under-reports.)
  'ClaudeDesign', 'Projects', 'ProposeGoal', 'ProposeSkills', 'ReadNotifications', 'RefreshMcpTools', 'REPL',
  'ShowOnboardingRolePicker',
  // the binary's tool aliases (2.1.267; TaskOutput left the declared set at 2.1.280 — kept here for the same superset reason)
  'AgentOutput', 'AgentOutputTool', 'BashOutput', 'BashOutputTool', 'KillBash', 'KillShell', 'ListMcpResources',
  'ReadMcpResource', 'ReadMcpResourceDir', 'ReadMcpResourceDirTool', 'RunWorkflow', 'Task',
])

// F1.669 — a Pi built-in spelling (`read`, `ls`, …) is translated for claude, so it is not warned about.
import { PI_TO_CLAUDE_BUILTIN_TOOL_NAMES } from '../agent/backend/claude/pi-tool-names.ts'

/**
 * F1.661 — one sentence per `sessionAllowedTools` entry claude will not honour as written, naming why. Pi reads the
 * same list with its own names and DOES narrow MCP tools (F1.638's docblock), so each sentence says "claude".
 * Printed with `!` and NOT a finding: a user-file value that does not bind is reported the way the `config.json`
 * validation section reports one, without moving the exit code.
 */
export function claudeWhitelistEntryWarnings(names: readonly string[]): string[] {
  const warnings: string[] = []
  for (const name of names) {
    const scoped = /^([^(]*)\(/.exec(name)
    if (scoped) {
      const tool = scoped[1]!.trim()
      warnings.push(names.includes(tool)
        ? `"${name}" is a permission rule, not a tool name — claude ignores it here (${tool} is kept by its bare entry)`
        : `"${name}" is a permission rule, not a tool name — claude ignores it, so ${tool || 'that tool'} is NOT`
          + ' kept on claude; list the bare name to keep it')
    } else if (name.startsWith('mcp__')) {
      warnings.push(`"${name}" is an MCP tool — on claude this list narrows built-in tools only, so MCP tools stay`
        + ' available whatever it says (Pi does narrow by it); sessionDisallowedTools removes one on claude')
    } else if (!CLAUDE_KNOWN_TOOL_NAMES.has(name) && !Object.hasOwn(PI_TO_CLAUDE_BUILTIN_TOOL_NAMES, name)) {
      warnings.push(`"${name}" is not a claude built-in tool name — claude ignores a name it does not know; check`
        + ' the spelling')
    }
  }
  return warnings
}
