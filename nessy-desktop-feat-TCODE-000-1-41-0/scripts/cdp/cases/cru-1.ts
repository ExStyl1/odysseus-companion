/**
 * CRU-1 — the read-only mode (Plan; Safe Mode/Explore until F1.1054) decides on the
 * Claude runtime, and a user's own ask rule is honoured.
 *
 * Until R3 we ran the Claude SDK with its whole permission system switched off
 * (`permissionMode: 'bypassPermissions'`) and decided everything ourselves. R1
 * made our PreToolUse hook speak the SDK's own vocabulary
 * (`permissionDecision: 'allow' | 'ask' | 'deny'`), R2 routed `canUseTool`, and
 * R3 removed the pin. `claude-permission-mode.ts` closes with the sentence this
 * case exists to discharge:
 *
 *   "The SDK's *interpretation* of this option runs inside the native `claude`
 *   binary. Nothing here can execute it … The behavioural half — Safe Mode still
 *   running a read-only command with no card, an `ask` rule now raising one —
 *   belongs to a live case."
 *
 * ## UNRESOLVED: which `blocked()` fired on 2026-08-21
 *
 * The close-out recorded this row under a blanket "fixtures/env, unchanged from
 * history" with **no case-specific reason**, so the sitting cannot be
 * attributed. The live state was checked on 2026-08-27 and the honest reading is
 * that the FIXTURE block (no `permissions.ask` rule anywhere) is the likely one:
 * no `claude-config/settings.json` exists under any workspace, and no
 * `.claude/settings*.json` under any session dir. But two other blocks are
 * equally reachable without a fixture — an unanswered project-trust gate, and a
 * project-scope rule the SDK's cwd never loaded.
 *
 * Whoever runs it next: record the block's own TEXT in the narrative rather than
 * the word "fixtures". Each of these messages names its own cause and quotes the
 * file it wants; the word "fixtures" names none of them, and that is why this
 * paragraph has to exist at all.
 *
 * ## Why BOTH halves, and why neither is optional
 *
 * Either half alone is passable by a broken build.
 *
 * - **(a) alone** — "no card appeared" is satisfied by a build that raises no
 *   cards at all, which is precisely the pre-R3 bypass. An absence needs a
 *   control on the same rig.
 * - **(b) alone** — "a card appeared" is satisfied by a build whose hook forgot
 *   R1's `permissionDecision: 'allow'` and therefore prompts for *everything*.
 *   That is the exact regression R3's row warns about: "the moment R3 lands it
 *   becomes the difference between Safe Mode working and Safe Mode prompting on
 *   every read-only command."
 *
 * So (b) is (a)'s positive control and (a) is (b)'s. They are run in ONE session,
 * in ONE permission mode, with TWO commands that are both on the shipped
 * read-only allowlist (`apps/electron/resources/permissions/default.json`) — so
 * the single difference between the two arms is that the operator's own `ask`
 * rule names one of them and not the other.
 *
 * ## Why the ask probe is a READ-ONLY command and not `git push`
 *
 * The plan's release note is about `git push`, and driving that here would be
 * both dangerous and vacuous:
 *
 * - In Plan our gate hands a write command up for a card of its own (plan mode's
 *   shell band, `planShellReview`), so a card appears whether or not the user's
 *   rule was read, and the measurement attributes nothing. (Under the retired
 *   Explore it was DENIED at step 1 instead, which was just as vacuous.)
 * - In `default`/`acceptEdits`/`auto` our own gate already returns `prompt` for
 *   `git push` (measured in R3's review), so a card appears whether or not the
 *   user's rule was read, and the measurement attributes nothing.
 * - And a build that had lost the card would RUN the command. A live case must
 *   not be able to push.
 *
 * A read-only command our gate allows with no card is the only probe where the
 * card can be attributed to the rule and to nothing else.
 *
 * ## The attribution check, which is the part most likely to be got wrong
 *
 * "A card appeared" is not "the ask rule raised a card". Our PreToolUse `prompt`
 * branch and the SDK's ask-rule route render the SAME component. They differ in
 * one observable: `askToolApproval` sets `noAlwaysAllow: true` with the reason on
 * the field, and `PermissionRequest.tsx`'s `canRemember` renders the "Always Allow" button
 * only when `request.noAlwaysAllow !== true`. Our gate's prompt branch never sets
 * it. So a card with no "Always Allow" button came through `canUseTool` — the
 * route R2 built and R3 gave a surface — and a card WITH one came from our own
 * gate and would mean the probe was not the read-only call this case thinks it is.
 *
 * ## What the harness will not do for itself
 *
 * It never writes the rule. A harness that installs the policy it is measuring
 * measures itself; `README.md` states the rule for hooks, plugins and managed
 * policy and an `ask` rule is the same kind of thing. When the rule is absent the
 * case reports BLOCKED with the exact file and the exact JSON.
 *
 * **And it names the right file.** `~/.claude/settings.json` does NOT reach this
 * runtime: `agent/options.ts` points `CLAUDE_CONFIG_DIR` at
 * `<config>/workspaces/<id>/claude-config` per workspace, deliberately, so the
 * user scope moves with it. The project scope is `<the SDK's cwd>/.claude/`, and
 * the SDK's cwd for a Nessy session is the session's own directory unless a
 * project was bound BEFORE the first turn (`shouldUpdateSdkCwd = messages.length
 * === 0`). Both facts are checked here rather than assumed — the cwd is read back
 * out of the SDK's own transcript, which stamps `cwd` on every entry.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'

import { clearComposer, readComposer, submitComposer, typeIntoComposer } from '../lib/composer.ts'
import type { CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { configDir, readClaudeSessionLog } from '../lib/runtime-session-log.ts'
import {
  listConnections,
  runtimeOf,
  bindWorkingDirectory,
  switchRuntime,
  waitForConnection, TRUST_GATE_HEADING_IN_PAGE,
} from '../lib/runtime-switch.ts'
import {
  assertElectronApi,
  freshSession,
  isProcessing,
  listSessions,
  setPermissionMode,
  transcript,
  waitFor,
  type SessionKey,
  type TranscriptMessage,
} from '../lib/state.ts'
import { clickSelector } from '../lib/viewport.ts'

const ID = 'CRU-1'
const TITLE = 'Plan runs a read-only command with no card on Claude, and a user ask rule raises one'

/** `PermissionRequest.tsx`'s `permission-banner` / `permission-allow-button` data-tutorial anchors — the same pair AGT-3 drives. */
const PERMISSION_CARD = '[data-tutorial="permission-banner"]'
const ALLOW_BUTTON = '[data-tutorial="permission-allow-button"]'

/**
 * The read-only mode, in the vocabulary the product actually stores.
 *
 * F1.1054 (2026-09-29): Plan. This case drove Safe Mode (`explore`), Nessy's own
 * read-only mode, until F1.1050 retired it: `parsePermissionMode` now reads
 * `explore` and `safe` as `plan`, so a probe that asked for `explore` would read
 * back `plan` and fail its own mode check. Plan carries the same contract for
 * this case — a shell command on the read-only allowlist runs without asking
 * (`shouldAllowToolInMode`'s read-only band, which plan and the retired explore
 * shared) — so the case's two arms and their attribution are unchanged. The
 * constant keeps its name so the arms below still read as the case's history.
 */
const SAFE_MODE = 'plan'

/**
 * The read-only arm's command.
 *
 * `^echo\b` is on the shipped read-only allowlist, it needs no repository, no
 * network and no filesystem, and it is the only allowlisted command that can
 * carry a per-run token — which is what turns "no card appeared" from a claim
 * about the screen into a claim about a command that demonstrably RAN. Without
 * that, a model that answered in prose and never called a tool would satisfy the
 * check (AGT-10's detector 1, which scored a broken product as working).
 */
const SAFE_PROBE_COMMAND = 'echo'

/**
 * The arm the operator's rule names. Read-only for the reason in the header;
 * overridable because the operator may already have a rule they would rather use.
 *
 * Whatever it is set to must be a command this build's gate ALLOWS in Plan,
 * or the case measures the gate instead of the rule.
 */
const ASK_PROBE_COMMAND = (process.env.NESSY_CDP_CLAUDE_ASK_COMMAND ?? 'whoami').trim()

/**
 * A directory the app ALREADY TRUSTS whose `.claude/settings.json` carries the
 * rule. Optional: without it the case still looks in the user scope, which is
 * the only other source `settingSources: ['user','project','local']` admits.
 */
const ASK_PROJECT_DIR = process.env.NESSY_CDP_CLAUDE_ASK_PROJECT?.trim()

const TURN_TIMEOUT_MS = 300_000
const CARD_POLL_MS = 1_000

/** One permission card as it stood at one poll. */
interface CardSighting {
  text: string
  buttons: string[]
  /**
   * Whether "Always Allow" is offered. `false` ⇒ `noAlwaysAllow: true` ⇒ the
   * card came from `canUseTool` (`claude-agent.ts` `askToolApproval`), which is
   * the only route a settings ask rule can take. Our own PreToolUse prompt
   * branch never sets the flag, so its cards always offer the button.
   */
  hasAlwaysAllow: boolean
}

interface WatchedTurn {
  completed: boolean
  messages: TranscriptMessage[] // this turn's rows: the ones added since its submit (F1.562)
  /** Distinct cards seen at any point between submit and settle, in order. */
  sightings: CardSighting[]
  /** How many cards this turn answered with Allow, counting only landed clicks. */
  answered: number
}

/**
 * Every VISIBLE permission card, with its buttons.
 *
 * Visibility is filtered the way `describeElements` filters it: a zero-sized or
 * hidden copy left in the tree keeps a selector count above zero forever, which
 * both fakes a render and fakes a card that never clears. And `innerText` is
 * layout-dependent — it returns `''` for an element inside a container that has
 * not sized yet, and `'' ?? x` is `''`, never the fallback — so emptiness is
 * tested rather than the property's existence.
 */
async function readPermissionCards(session: CdpSession): Promise<CardSighting[]> {
  return session.call<CardSighting[]>(`
    return Array.from(document.querySelectorAll(${JSON.stringify(PERMISSION_CARD)})).flatMap(el => {
      const rect = el.getBoundingClientRect()
      const style = window.getComputedStyle(el)
      if (rect.width === 0 || rect.height === 0 || style.display === 'none' || style.visibility === 'hidden') return []
      const rendered = (el.innerText ?? '').replace(/\\s+/g, ' ').trim()
      const text = rendered || (el.textContent ?? '').replace(/\\s+/g, ' ').trim()
      const buttons = Array.from(el.querySelectorAll('button'))
        .map(b => ((b.innerText || b.textContent) ?? '').replace(/\\s+/g, ' ').trim())
        .filter(Boolean)
      return [{ text, buttons, hasAlwaysAllow: buttons.some(b => /always allow/i.test(b)) }]
    })
  `)
}

/**
 * Send one prompt, watch the permission surface for the whole turn, and release
 * whatever it raises.
 *
 * `sendPrompt` cannot be used for either arm: it waits for the turn and returns
 * only what the transcript holds afterwards, and a permission card is a thing
 * that exists BETWEEN submit and settle. On the (a) arm a card would also block
 * the turn until the timeout, so `sendPrompt` would report a stall where the
 * finding is "a card was raised".
 *
 * **The SAME instrument runs on both arms, and that is deliberate.** The two arms
 * differ in what is ASSERTED about the sightings, never in how they are
 * collected — an absence and its control measured by two different readers is
 * how a comparison stops being one. Answering on the read-only arm is not a
 * courtesy either: an unanswered card wedges the session, and arm (b) would then
 * fail for a reason that has nothing to do with the rule. The only call in flight
 * on that arm is an `echo` of this run's own token.
 *
 * A card cannot be missed by this polling: it blocks the SDK until it is
 * answered, so it does not flash. The poll interval decides how promptly a card
 * is released, never whether one is seen.
 */
async function turnWithCardWatch(
  session: CdpSession,
  key: SessionKey,
  text: string,
  options: { timeoutMs: number },
): Promise<WatchedTurn> {
  const before = (await transcript(session, key)).length
  await clearComposer(session)
  await typeIntoComposer(session, text)
  const typed = await readComposer(session)
  const normalise = (value: string): string => value.replace(/\s+/g, ' ').trim()
  if (normalise(typed) !== normalise(text)) {
    throw new Error(`composer-mismatch: meant to send ${JSON.stringify(text)}, composer holds ${JSON.stringify(typed)}`)
  }
  await submitComposer(session)

  const sightings: CardSighting[] = []
  let answered = 0
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    const cards = await readPermissionCards(session).catch(() => [] as CardSighting[])
    for (const card of cards) {
      const last = sightings[sightings.length - 1]
      if (!last || last.text !== card.text || last.buttons.join('|') !== card.buttons.join('|')) {
        sightings.push(card)
      }
    }
    // Answer only a card that has finished rendering its buttons — clicking at
    // the instant the selector matches is the read the README's "wait for the
    // surface" note is about, and a click into a half-built card lands nowhere.
    // `answered` counts LANDED clicks only: a click the viewport guard refused is
    // not an answer, and recording it as one would hide a wedged session behind a
    // number that says it was released.
    if (cards.some(card => card.buttons.length > 0)) {
      const landed = await clickSelector(session, ALLOW_BUTTON).then(() => true).catch(() => false)
      if (landed) answered += 1
    }

    const messages = (await transcript(session, key)).slice(before)
    if (messages.length > 0 && !(await isProcessing(session, key))) {
      return { completed: true, messages, sightings, answered }
    }
    if (Date.now() >= deadline) {
      return { completed: false, messages, sightings, answered }
    }
    await Bun.sleep(CARD_POLL_MS)
  }
}

interface ShellCall {
  tool?: string
  toolUseId?: string
  command: string
  result: string
  status?: string
}

/**
 * Shell calls in a transcript, found by their INPUT rather than by tool name,
 * and paired with their result by `toolUseId`.
 *
 * **Name-agnostic on purpose.** Anthropic has renamed a tool under this product
 * twice (`Task` → `Agent`, `input.lsp` → `lspServers`), and a case that keys off
 * `toolName === 'Bash'` reports "the model never called the tool" the next time
 * it happens — a product-defect-shaped result from a harness fault. The names
 * seen are reported so a rename is visible in the record without failing the
 * case for it.
 *
 * **Paired rather than read off one message**, because the call and its output
 * need not arrive on the same transcript row: `toolResult` is keyed by
 * `toolUseId` (`state.ts` carries both for exactly this reason). Reading
 * `message.toolResult` beside `message.toolInput` and finding nothing is a false
 * negative that reads as "the command never ran".
 */
function shellCalls(messages: TranscriptMessage[]): ShellCall[] {
  const results = new Map<string, { result: string; status?: string }>()
  for (const message of messages) {
    if (message.toolUseId && typeof message.toolResult === 'string' && message.toolResult.length > 0) {
      results.set(message.toolUseId, { result: message.toolResult, status: message.toolStatus })
    }
  }
  return messages.flatMap(message => {
    const command = message.toolInput?.command
    if (typeof command !== 'string' || command.length === 0) return []
    const paired = message.toolUseId ? results.get(message.toolUseId) : undefined
    return [{
      tool: message.toolName,
      toolUseId: message.toolUseId,
      command,
      result: paired?.result ?? message.toolResult ?? '',
      status: paired?.status ?? message.toolStatus,
    }]
  })
}

interface SettingsScope {
  scope: 'project' | 'local' | 'user'
  file: string
  exists: boolean
  ask: string[]
  allow: string[]
  deny: string[]
  parseError?: string
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function readSettingsScope(scope: SettingsScope['scope'], file: string): SettingsScope {
  if (!existsSync(file)) return { scope, file, exists: false, ask: [], allow: [], deny: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { permissions?: Record<string, unknown> }
    const permissions = parsed.permissions ?? {}
    return {
      scope,
      file,
      exists: true,
      ask: stringList(permissions.ask),
      allow: stringList(permissions.allow),
      deny: stringList(permissions.deny),
    }
  } catch (cause) {
    return {
      scope,
      file,
      exists: true,
      ask: [],
      allow: [],
      deny: [],
      parseError: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

/**
 * Does one Claude permission-rule string cover this bash command?
 *
 * Claude's Bash rules are PREFIX rules on the command string —
 * `Bash(git diff:*)` matches any command starting with `git diff` — which is the
 * whole reason R3's row keeps our AST validator: a string prefix cannot tell a
 * genuinely read-only command from one that merely starts like an allowed one.
 *
 * This matcher is deliberately GENEROUS, and the direction of its error is the
 * point: every use of it here can only produce a BLOCKED (a rule that might
 * contaminate an arm) or a precondition that is satisfied. It can never turn a
 * failing product into a passing case.
 */
function bashRuleCovers(rule: string, command: string): boolean {
  const trimmed = rule.trim()
  if (/^bash$/i.test(trimmed)) return true
  const match = /^bash\s*\(([^)]*)\)$/i.exec(trimmed)
  if (!match) return false
  const content = (match[1] ?? '').trim()
  if (content === '*' || content === ':*') return true
  const prefix = (content.endsWith(':*') ? content.slice(0, -2) : content).trim()
  if (prefix.length === 0) return false
  return command === prefix || command.startsWith(`${prefix} `)
}

function rulesCovering(scopes: SettingsScope[], kind: 'ask' | 'deny' | 'allow', command: string): Array<{ scope: string; rule: string }> {
  return scopes.flatMap(scope =>
    scope[kind].filter(rule => bashRuleCovers(rule, command)).map(rule => ({ scope: `${scope.scope}:${scope.file}`, rule })))
}

/**
 * The app's "Trust this folder?" gate, DETECTED and never answered.
 *
 * `trustFixtureProject` may click it for one harness-owned fixture directory;
 * this case binds a directory the operator named, so answering it here would be
 * the harness granting "project instructions, skills, agents, MCP servers, hooks
 * and memory can run from this folder" on the operator's behalf. It reports the
 * gate instead. The modal is raised asynchronously after the bind, so a single
 * read races it — this polls for the window the bind could raise it in.
 */
async function trustGatePath(session: CdpSession, timeoutMs = 8_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const dialog = await session.call<{ present: boolean; path?: string }>(`
      const heading = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
        .find(${TRUST_GATE_HEADING_IN_PAGE})
      if (!heading) return { present: false }
      const root = heading.closest('[role="dialog"]') ?? heading.parentElement?.parentElement ?? document.body
      const field = root.querySelector('input,code,pre,[class*="path"]')
      const text = field ? (field.value ?? field.textContent ?? '') : ''
      return { present: true, path: String(text).trim() }
    `).catch((): { present: boolean; path?: string } => ({ present: false }))
    if (dialog.present) return dialog.path ?? '(the dialog names no path)'
    if (Date.now() >= deadline) return undefined
    await Bun.sleep(500)
  }
}

/** Every working directory the SDK stamped on its own transcript entries. */
function sdkCwdsSeen(workspaceId: string): { cwds: string[]; files: string[]; reason?: string } {
  const log = readClaudeSessionLog(workspaceId)
  if (log.reason) return { cwds: [], files: [], reason: log.reason }
  const cwds = new Set<string>()
  for (const entry of log.entries) {
    const cwd = entry.raw.cwd
    if (typeof cwd === 'string' && cwd.length > 0) cwds.add(cwd)
  }
  return { cwds: [...cwds], files: log.files ?? (log.file ? [log.file] : []) }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))

  // The Claude runtime is the surface under test. On a Pi-only host every claim
  // below would be measured through a different permission engine and the row
  // would pass without touching the code it is about.
  const connections = await listConnections(session)
  const claude = connections.find(row => runtimeOf(row.providerType) === 'anthropic' && row.providerType === 'claude-runtime')
  run.observe('connections', connections.map(row => `${row.slug}(${row.providerType})`))
  if (!claude) {
    blocked(
      'this case needs a claude-runtime connection (the "Claude Code (Nessy Gateway)" card); '
      + `the host lists ${connections.map(row => `${row.slug}(${row.providerType})`).join(', ') || 'nothing'}`,
    )
  }

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
  run.observe('session-origin', key.fresh ? 'created by this run' : `CONTAMINATED: ${key.reason}`)
  run.require('the case ran in a session it created', key.fresh, key.reason ?? '')

  const outcome = await switchRuntime(session, key.sessionId, claude.slug)
  run.observe('switch onto the claude card', outcome)
  run.require('the session moved onto the claude-runtime card', outcome.ok, outcome.error ?? '')
  const settledConnection = await waitForConnection(session, key.sessionId, claude.slug)
  run.require(`the session reports ${claude.slug}`, settledConnection === claude.slug, String(settledConnection))

  // ---- where the SDK will look for the operator's rules ---------------------
  // Bound BEFORE the first turn on purpose: `shouldUpdateSdkCwd` in
  // `SessionManager` is `managed.messages.length === 0`, so a project bound after
  // a turn moves `workingDirectory` and leaves `sdkCwd` — and therefore the
  // project settings scope — pointing at the session directory.
  if (ASK_PROJECT_DIR) {
    if (!ASK_PROJECT_DIR.startsWith('/') || !existsSync(ASK_PROJECT_DIR)) {
      blocked(
        `NESSY_CDP_CLAUDE_ASK_PROJECT=${ASK_PROJECT_DIR} is not an existing absolute path. It is compared against the `
        + 'directory the app reports binding and against the cwd the SDK stamps on its own transcript, and neither '
        + 'comparison survives a relative path or a `~`.',
      )
    }
    const binding = bindWorkingDirectory(session, key.sessionId, ASK_PROJECT_DIR, { timeoutMs: 20_000, attempts: 1 })
    const gate = await trustGatePath(session)
    if (gate) {
      blocked(
        `the app is asking whether to trust ${gate}. This harness does not answer that gate for a directory the `
        + 'operator named — trusting a folder grants its instructions, skills, agents, MCP servers and hooks the '
        + 'right to run. Open the folder in the app once, answer "Trust folder", then re-run this case.',
      )
    }
    // F1.182 — the bind above is STARTED and not awaited. This case deliberately
    // refuses to answer the gate for a directory the operator named, so awaiting
    // the mutation would wait on a modal nothing here will ever click (the
    // `pkg-4.ts` deadlock, with no way out); the gate is read while the command
    // is in flight and the verdict is the session's own field, polled.
    const bound = await binding
    run.require(
      'the session bound the project directory the ask rule lives in',
      bound.bound,
      `NESSY_CDP_CLAUDE_ASK_PROJECT=${ASK_PROJECT_DIR}; ${bound.reason ?? 'bound'}`,
    )
  }

  const root = configDir()
  const projectDir = ASK_PROJECT_DIR ?? join(root, 'sessions', key.workspaceId, key.sessionId)
  const scopes: SettingsScope[] = [
    readSettingsScope('project', join(projectDir, '.claude', 'settings.json')),
    readSettingsScope('local', join(projectDir, '.claude', 'settings.local.json')),
    // NOT `~/.claude/settings.json`. `agent/options.ts:226` points
    // `CLAUDE_CONFIG_DIR` at the per-workspace directory, and its own comment
    // calls the consequence deliberate: "a hand-written `~/.claude/settings.json`
    // stops reaching the subprocess". Naming the wrong file in a BLOCKED message
    // would send the operator to write a rule that can never fire.
    readSettingsScope('user', join(root, 'workspaces', key.workspaceId, 'claude-config', 'settings.json')),
  ]
  run.observe('permission rule sources', scopes.map(scope => ({
    scope: scope.scope,
    file: scope.file,
    exists: scope.exists,
    ask: scope.ask,
    deny: scope.deny,
    ...(scope.parseError ? { parseError: scope.parseError } : {}),
  })))

  const askRules = rulesCovering(scopes, 'ask', ASK_PROBE_COMMAND)
  const askProbeRule = askRules[0]
  if (!askProbeRule) {
    blocked(
      `no "ask" rule names \`${ASK_PROBE_COMMAND}\`, so half (b) has nothing to measure and this harness will not `
      + 'write one for itself — a case that installs the policy it is testing is measuring itself. '
      + `Add it to ${scopes[0]!.file} (project scope, the file the plan's release note is about):\n`
      + `    { "permissions": { "ask": ["Bash(${ASK_PROBE_COMMAND})", "Bash(${ASK_PROBE_COMMAND}:*)"] } }\n`
      + `Then re-run with NESSY_CDP_CLAUDE_ASK_PROJECT=${projectDir}. `
      + `The user scope (${scopes[2]!.file}) works too; \`~/.claude/settings.json\` does NOT — `
      + 'CLAUDE_CONFIG_DIR is redirected per workspace by `agent/options.ts`. '
      + `The command must be one Plan auto-allows (it is compared against the read-only allowlist in `
      + 'apps/electron/resources/permissions/default.json), or the card that appears is our own gate\'s and '
      + 'proves nothing about the rule. Override the command with NESSY_CDP_CLAUDE_ASK_COMMAND.',
    )
  }
  run.observe('the ask rule under test', askProbeRule)

  // The read-only arm has to be genuinely unruled, or "no card" is a statement
  // about the operator's settings rather than about Plan. Tested against the
  // EXACT string this run will send rather than against a stand-in, which is why
  // the token is minted here rather than at the arm below.
  const token = `CRU1-${Math.random().toString(16).slice(2, 10).toUpperCase()}`
  const safeCommand = `${SAFE_PROBE_COMMAND} ${token}`
  run.observe('the read-only arm\'s command', safeCommand)
  const safeContamination = [
    ...rulesCovering(scopes, 'ask', safeCommand),
    ...rulesCovering(scopes, 'deny', safeCommand),
  ]
  if (safeContamination.length > 0) {
    blocked(
      `the read-only arm's own command \`${SAFE_PROBE_COMMAND}\` is named by `
      + `${safeContamination.map(entry => `${entry.rule} (${entry.scope})`).join(', ')}, so a card on that arm would be `
      + 'the operator\'s rule doing its job rather than Plan failing. Remove the rule, or point the case at a '
      + 'project whose settings do not carry one.',
    )
  }
  const askProbeDenied = rulesCovering(scopes, 'deny', ASK_PROBE_COMMAND)
  if (askProbeDenied.length > 0) {
    blocked(
      `\`${ASK_PROBE_COMMAND}\` is also covered by a deny rule `
      + `(${askProbeDenied.map(entry => `${entry.rule} (${entry.scope})`).join(', ')}). A deny refuses the call `
      + 'without asking — "Deny and ask rules are still evaluated regardless of what the hook returns", and deny wins '
      + 'over ask — so no card can appear and half (b) is unmeasurable on this command.',
    )
  }

  // ---- Plan, IN EFFECT rather than merely requested -------------------------
  // A fixed sleep after the request is AGT-10's detector 3: one run wrote a file
  // successfully because the prompt went out before the mode took hold, which
  // scores a working guard as "nothing was blocked".
  await setPermissionMode(session, key.sessionId, SAFE_MODE)
  const mode = await waitFor(
    async () => (await listSessions(session)).find(s => s.id === key.sessionId)?.permissionMode,
    value => value === SAFE_MODE,
    { timeoutMs: 30_000, intervalMs: 500, label: `${SAFE_MODE} to take effect` },
  ).catch(() => undefined)
  run.require(`the session is in Plan (${SAFE_MODE}) before either probe`, mode === SAFE_MODE, `mode=${String(mode)}`)

  // ---- (a) a read-only command runs with NO card ---------------------------
  const safeTurn = await turnWithCardWatch(
    session,
    key,
    // ASCII only, deliberately. Every character here is typed as a real key
    // event; the punctuation table in `lib/keys.ts` covers the ASCII set and an
    // em dash would ride the generic path, where a failure surfaces as
    // `composer-mismatch` and kills the case for a typographic reason.
    `Run exactly one shell command: \`${safeCommand}\`, using your shell tool. `
    + 'Issue the tool call as your first action: do not explain first, do not ask, and run nothing else. '
    + 'Then reply with the command\'s output and nothing more.',
    { timeoutMs: TURN_TIMEOUT_MS },
  )
  const safeCalls = shellCalls(safeTurn.messages)
  run.observe('(a) shell calls', safeCalls.map(call => ({ tool: call.tool, command: call.command.slice(0, 120), status: call.status })))
  run.observe('(a) cards seen while the turn ran', safeTurn.sightings)
  run.observe('(a) cards released to keep the rig usable', safeTurn.answered)

  // Without a real tool call there is nothing to measure, and scoring that as a
  // pass is AGT-10's detector 1 exactly: the model declines in prose, no
  // permission decision is ever taken, and the case reports a working Plan.
  //
  // The call and its output are looked for SEPARATELY. Requiring one message to
  // carry both is the pairing assumption `shellCalls` exists to remove, and here
  // it would turn a working runtime into "the model never called the tool".
  const safeCalled = safeCalls.some(call => call.command.includes(token))
  const safeAnswered = safeTurn.messages.some(message => (message.toolResult ?? '').includes(token))
  run.require(
    '(a) the read-only command actually RAN — a decision was taken, not avoided',
    safeCalled && safeAnswered,
    safeCalled && safeAnswered
      ? undefined
      : `called=${safeCalled} resultCarriedToken=${safeAnswered} for ${token}. `
        + `Calls seen: ${JSON.stringify(safeCalls.map(c => c.command.slice(0, 80)))}. `
        + 'With no tool call nothing was decided, and "no card" would mean nothing.',
  )
  run.check(
    '(a) Plan ran it with NO permission card — our hook\'s `permissionDecision: "allow"` skipped the SDK\'s prompt',
    safeTurn.sightings.length === 0,
    safeTurn.sightings.length === 0
      ? undefined
      : `${safeTurn.sightings.length} card(s): ${JSON.stringify(safeTurn.sightings.map(s => s.text.slice(0, 160)))}. `
        + 'This is the R1 regression R3 warns about — an allow that carries no `permissionDecision` no longer skips '
        + 'anything once the bypass is gone, so Plan prompts on every read-only command.',
  )

  // ---- the rules the SDK actually loaded were the ones read above -----------
  // The first Claude turn has run, so the SDK has written its transcript and
  // stamped its own `cwd` on every entry. A project-scope rule sitting anywhere
  // else was never loaded, and a card that then fails to appear is a
  // misconfigured rig rather than a product defect — the difference this repo
  // pays for whenever a detector goes unchecked.
  if (askProbeRule.scope.startsWith('project') || askProbeRule.scope.startsWith('local')) {
    const seen = sdkCwdsSeen(key.workspaceId)
    run.observe('cwds the SDK stamped on its own transcript', seen)
    const matched = seen.cwds.some(cwd => resolvePath(cwd) === resolvePath(projectDir))
    if (!matched) {
      blocked(
        `the ask rule was read from ${askProbeRule.scope}, whose project root is ${projectDir}, but the SDK's own `
        + `transcript reports cwd ${JSON.stringify(seen.cwds)}${seen.reason ? ` (${seen.reason})` : ''}. `
        + 'Project-scope settings are resolved against the SDK\'s cwd, so that file was never loaded and half (b) '
        + 'would fail for a reason that has nothing to do with the runtime. Bind the project with '
        + 'NESSY_CDP_CLAUDE_ASK_PROJECT before the session\'s first turn, or move the rule to the user scope.',
      )
    }
  }

  // ---- (b) the operator's own ask rule raises a card -----------------------
  const askTurn = await turnWithCardWatch(
    session,
    key,
    `Run exactly one shell command: \`${ASK_PROBE_COMMAND}\`, using your shell tool. `
    + 'Issue the tool call as your first action: do not explain first, do not ask, and run nothing else.',
    { timeoutMs: TURN_TIMEOUT_MS },
  )
  const askCalls = shellCalls(askTurn.messages)
  run.observe('(b) shell calls', askCalls.map(call => ({ tool: call.tool, command: call.command.slice(0, 120), status: call.status })))
  run.observe('(b) cards seen while the turn ran', askTurn.sightings)
  run.observe('(b) cards answered with Allow', askTurn.answered)

  const attributable = askTurn.sightings.find(sighting => sighting.buttons.length > 0)
  run.check(
    `(b) the operator's own ask rule (${askProbeRule.rule}) raised a permission card`,
    askTurn.sightings.length > 0,
    askTurn.sightings.length > 0
      ? undefined
      : 'no card. Before R2 the stub `canUseTool` answered "yes" on the user\'s behalf and the rule was silently '
        + 'ignored; after R2 and before R3 the same call was silently refused. Either way the user is never asked.',
  )
  if (attributable) {
    run.check(
      `(b) the card is about \`${ASK_PROBE_COMMAND}\``,
      new RegExp(`\\b${ASK_PROBE_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(attributable.text),
      attributable.text.slice(0, 240),
    )
    run.check(
      '(b) the card came through `canUseTool` — it offers no "Always Allow", which only `noAlwaysAllow: true` produces',
      !attributable.hasAlwaysAllow,
      attributable.hasAlwaysAllow
        ? `buttons: ${JSON.stringify(attributable.buttons)}. Our own PreToolUse prompt branch never sets `
          + '`noAlwaysAllow`, so this card is our gate\'s — the probe is not the auto-allowed read-only call this '
          + 'case assumes, and the ask rule is not what raised it.'
        : `buttons: ${JSON.stringify(attributable.buttons)}`,
    )
  }

  // Answering has to UNBLOCK it. A prompt that appears and does not release the
  // call is the same hang wearing a friendlier face (AGT-3's second half), and
  // an unsettled `canUseTool` is the SDK's own documented worst case: "no
  // control_response is sent and the tool stays blocked indefinitely — permission
  // prompts have no park deadline."
  //
  // A non-empty result is NOT enough on its own: every refusal path in
  // `buildClaudeCanUseTool` also produces a tool result, in prose
  // (`CAN_USE_TOOL_DECLINED_DENIAL` and friends). So the denial vocabulary is
  // excluded explicitly — otherwise a run whose Allow click missed would score
  // "the call was released" off the message that says it was not.
  const askCall = askCalls.find(call => call.command.trim().startsWith(ASK_PROBE_COMMAND))
  const askResult = askCall?.result.trim() ?? ''
  const deniedInstead = /declined this tool call|denied instead of asked|refused rather than approved|needs a person to approve/i.test(askResult)
  run.check(
    '(b) Allow released the call — the command ran and the turn settled',
    askTurn.completed && askResult.length > 0 && !deniedInstead,
    !askTurn.completed
      ? 'the turn never settled after Allow'
      : askResult.length === 0
        ? `no result for \`${ASK_PROBE_COMMAND}\`; calls: ${JSON.stringify(askCalls.map(c => c.command.slice(0, 80)))}`
        : deniedInstead
          ? `the call was REFUSED, not released: ${askResult.slice(0, 200)} (${askTurn.answered} Allow click(s) landed)`
          : `status=${String(askCall?.status)}`,
  )

  const cardsLeft = await readPermissionCards(session)
  run.observe('cards still on screen at the end', cardsLeft)
  run.check(
    'the answered card cleared',
    cardsLeft.length === 0,
    cardsLeft.length === 0 ? undefined : `${cardsLeft.length} card(s) remain: ${JSON.stringify(cardsLeft.map(c => c.text.slice(0, 120)))}`,
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
