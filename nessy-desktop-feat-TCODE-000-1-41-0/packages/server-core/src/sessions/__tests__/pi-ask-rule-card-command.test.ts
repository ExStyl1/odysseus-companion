/**
 * F1.902 `[pi]` `[permissions]` `[ui]` — Pi's ask-rule card names the COMMAND it
 * asks about, beside the rule sentence.
 *
 * SIT-ac (2026-09-25, packaged RC `69a6d33da`, workspace `permissions.json` with
 * `"ask": ["Bash(echo SITAC-ASK:*)", "Bash(echo SITAC-ASK *)"]`, Pi, `default`):
 * the visible card's whole text was "Permission required · Tool: Bash · Bash
 * requires approval by readable permission policy rule `Bash(echo SITAC-ASK:*)`
 * (workspace scope)." and its four buttons — on the main thread and on both
 * child cards — while claude's card for the same kind of call shows the command.
 * An approval card that does not say what it approves.
 *
 * WHERE THE COMMAND WAS LOST, measured here rather than inferred. `echo` is a
 * read-only command, so the gate answers `allow`; the readable permission DSL's
 * `ask` match is what turns it back into a card, in `PiAgent`'s
 * `handlePreToolUseRequest` (the branch that composes "… requires approval by
 * readable permission policy …"). That branch built its request from
 * `toolName`, `type` and `description` alone. Every hop after it forwards
 * `command` verbatim when there is one — `createPiPermissionService`, the host's
 * `requestPiToolApproval` into `handleAgentPermissionRequest` and its
 * `permission_request` event, and the renderer, which files the event's
 * `request` unchanged (`lib/pending-permissions.ts` symbol
 * `addPendingPermission`) and renders `request.command` in the card's command
 * preview (`PermissionRequest.tsx`) — so the field was never there to drop.
 *
 * THE INSTRUMENT is the production chain from the runtime's own decision to the
 * card's props: the REAL `PiAgent` PreToolUse handler, the REAL
 * `createPiPermissionService`, and the REAL `SessionManager.requestPiToolApproval`
 * whose `permission_request` event IS the renderer's `request` prop. The rule
 * enters the way the product's does — a workspace-scoped settings document
 * through `setCapabilityPermissionLayers`, parsed by `parsePermissionsJson` — and
 * its text is SIT-ac's own file, so the rule sentence asserted below is the one
 * the sitting read off the screen.
 *
 * The same rig measured a TWIN on the other arm of that merge (the describe's
 * second docblock): over a MODE prompt the rule's `ask` left the mode's card as
 * it was — rule unnamed, remember window kept — so one Always Allow switched the
 * ask rule off for the rest of the session. F1.860's claude defect, on Pi.
 *
 * CONTROLS: a no-rule Pi Bash card is unchanged (`Execute: <command>`, type
 * `bash`, its remember window kept and honoured); the rule sentence stays; the
 * ask-rule card over a gate allow keeps its own type and no remember window, so
 * adding the command widens no grant (the host's permanent Bash rule is minted
 * for a `bash`-typed card only); a child's card still names the subagent that
 * asked (F1.70's A57 arm).
 *
 * F1.913 (the last describe) — the mode-prompt arm keeps type `bash`, so the
 * card's Always Allow still reached the host's permanent `Bash(<key> *)` rule,
 * a lasting grant the ask rule outranks on every later call. Both ask-rule
 * cards now carry `noAlwaysAllow`, the codex ask-rule card's shape (F1.870).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAgent, permissionsConfigCache } from '@nessy-agent/shared/agent'
import { finalizePiExecutionManifest, type PiExecutionManifestSeedV2 } from '@nessy-agent/shared/agent/pi-harness/harness-manifest'
import {
  PI_STATIC_MODEL_CONTRACT_HASHES,
  PI_TOOL_BINDINGS,
  getHarnessToolDescriptor,
} from '@nessy-agent/shared/agent/pi-harness/harness-tool-descriptor'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'

import { createPiPermissionService } from '../../pi-harness/permission-service.ts'
import { createTestSessionManager } from './test-session-manager.ts'

/** SIT-ac's workspace `permissions.json`, verbatim. */
const SITAC_PERMISSIONS = JSON.stringify({
  permissions: { ask: ['Bash(echo SITAC-ASK:*)', 'Bash(echo SITAC-ASK *)'] },
})
const SITAC_RULE_SENTENCE =
  'Bash requires approval by readable permission policy rule `Bash(echo SITAC-ASK:*)` (workspace scope).'

let root = ''
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'f1902-pi-ask-card-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })
afterEach(() => { permissionsConfigCache.clear() })

type Card = Record<string, unknown>
type Answer = { allowed: boolean; alwaysAllow: boolean }
/**
 * F1.913 — the strongest grant the card OFFERS, as `PermissionRequest.tsx`
 * offers it: Always Allow unless the card says `noAlwaysAllow` (its
 * `canRemember`), else Allow. The fixed `Answer` above is a client that sends
 * Always whatever the card says (F1.888's case), kept for the host-side pins.
 */
type Strongest = 'strongest-offered'

let counter = 0

/**
 * One Pi session: the real agent's PreToolUse handler, the real permission
 * service, and the real host seam it settles through. `cards` records every
 * `permission_request` event the host publishes — the renderer's props.
 */
function piSession(options: {
  mode: string
  permissions?: string
  answer?: Answer | Strongest
  child?: { name: string }
}) {
  const id = ++counter
  const workspaceId = `ws-f1902-${id}`
  const workingDirectory = join(root, `project-${id}`)
  const workspace = { id: workspaceId, rootPath: workingDirectory }
  const stub = (sessionId: string, extra: Record<string, unknown> = {}) => ({
    id: sessionId,
    activeProvider: 'pi',
    permissionMode: options.mode,
    isProcessing: true,
    backgroundShellCommands: new Map<string, unknown>(),
    workspace,
    workingDirectory,
    ...extra,
  })
  const parent = options.child ? stub(`parent-f1902-${id}`) : undefined
  const managed: Record<string, unknown> & { id: string } = stub(`session-f1902-${id}`, {
    ...(parent
      ? { hidden: true, name: options.child!.name, piParentSessionKey: { workspaceId, sessionId: parent.id } }
      : {}),
  })

  const manager = createTestSessionManager() as any
  manager.persistSession = () => undefined
  manager.emitPiHarnessInvalidation = () => undefined
  // Never write a repository rule into a real tree; recorded so a widening is visible.
  const persistedBashRules: string[] = []
  manager.persistBashAlwaysAllowRule = (_managed: unknown, command: string) => { persistedBashRules.push(command) }
  for (const session of [parent, managed]) {
    if (!session) continue
    manager.sessions.set(encodeSessionKey({ workspaceId, sessionId: session.id }), session)
  }
  const cards: Card[] = []
  const answer = options.answer ?? { allowed: false, alwaysAllow: false }
  manager.sendEvent = (event: { type?: string; request?: Card }) => {
    if (event?.type !== 'permission_request' || !event.request) return
    // Copied at publication: the host's own object is not re-read later.
    const card = { ...event.request }
    cards.push(card)
    const [allowed, alwaysAllow] = answer === 'strongest-offered'
      ? [true, card.noAlwaysAllow !== true]
      : [answer.allowed, answer.alwaysAllow]
    setTimeout(() => {
      manager.respondToPermission(String(card.sessionId), String(card.requestId), allowed, alwaysAllow, undefined, workspaceId)
    }, 0)
  }

  const service = createPiPermissionService({
    requestApproval: request => manager.requestPiToolApproval(managed, request),
  })
  const agent = new PiAgent({
    provider: 'pi',
    workspace: {
      id: workspaceId,
      name: 'F1.902 Workspace',
      rootPath: workingDirectory,
      workspaceRootPath: workingDirectory,
      sessionRootPath: join(root, `sessions-${id}`),
    },
    session: {
      id: managed.id,
      workspaceRootPath: workingDirectory,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory,
    },
    model: 'pi/test-model',
    isHeadless: true,
    permissionServicePort: service,
    contextProfile: 'bare',
  } as never)
  // A Pi tool card is raised mid-turn, when production has the agent (C3.371).
  managed.agent = agent
  agent.setPermissionMode(options.mode as never)
  const sent: Array<Record<string, unknown>> = []
  const internals = agent as unknown as {
    send: (message: Record<string, unknown>) => void
    emitAutomationEvent: (event: string, input: Record<string, unknown>) => Promise<unknown>
    setCurrentTurnUserMessage: (message: string) => void
    setCapabilityTurnRuntime: (runtime: unknown) => void
    activeExecutionManifest: unknown
    handlePreToolUseRequest: (request: Record<string, unknown>) => Promise<void>
    permissionManager: { setCapabilityPermissionLayers: (...args: unknown[]) => void }
  }
  internals.send = message => { sent.push(message) }
  internals.emitAutomationEvent = async () => ({ matchedCount: 0 })
  internals.setCurrentTurnUserMessage('run the command')

  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: `f1902-generation-${id}`,
    sessionKey: { workspaceId, sessionId: managed.id },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: PI_TOOL_BINDINGS.flatMap(binding => {
      const modelContractHash = PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName]
      return modelContractHash
        ? [{
            descriptor: getHarnessToolDescriptor(binding.descriptorId),
            binding,
            source: { kind: 'piBuiltin' as const, bindingId: binding.bindingName },
            modelContractHash,
          }]
        : []
    }),
  }
  const manifest = finalizePiExecutionManifest(seed, [])
  const tool = manifest.tools.find(candidate => candidate.binding.permissionName === 'Bash')
  if (!tool) throw new Error('missing Bash tool binding')
  internals.setCapabilityTurnRuntime({
    view: { generation: manifest.snapshotGeneration },
    materializer: { assertActive() {} },
    piExecutionManifestSeed: { snapshotGeneration: manifest.snapshotGeneration },
  })
  internals.activeExecutionManifest = manifest
  // AFTER the turn runtime (it clears manifest authority), and filed under the
  // MANIFEST's generation — any other name evaluates as a stale-generation deny
  // (D1.270), which would never reach the ask branch this row is about.
  internals.permissionManager.setCapabilityPermissionLayers(
    options.permissions
      ? [{ content: options.permissions, scope: 'workspace', sourceRoot: workingDirectory }]
      : [],
    manifest.snapshotGeneration,
    true,
  )

  let calls = 0
  const run = async (command: string) => {
    await internals.handlePreToolUseRequest({
      requestId: `req-f1902-${id}-${++calls}`,
      semanticId: tool.descriptor.id,
      piName: tool.binding.piName,
      surfaceVersion: manifest.surfaceVersion,
      manifestResponseEpoch: 0,
      manifestGeneration: manifest.snapshotGeneration,
      manifestHash: manifest.manifestHash,
      toolName: 'Bash',
      input: { command },
    })
  }
  return { agent, cards, sent, run, persistedBashRules, managed, parent }
}

describe('F1.902 — the Pi ask-rule card carries the command it asks about', () => {
  /**
   * SIT-ac's arm. The gate itself would have run the call — here because the
   * mode allows everything (`bypassPermissions`), on the sitting because `echo`
   * is on the read-only list — so the readable rule's `ask` is the ONLY thing
   * that raises the card, and this is the card the sitting read: the rule
   * sentence, and no command.
   */
  for (const mode of ['bypassPermissions', 'auto'] as const) {
    test(`over a gate allow (${mode}): the card shows the command beside the rule sentence`, async () => {
      const session = piSession({ mode, permissions: SITAC_PERMISSIONS })
      await session.run('echo SITAC-ASK one')
      session.agent.destroy()

      expect(session.cards).toHaveLength(1)
      const card = session.cards[0]!
      // THE ROW: the command reaches the card's props, in the field the card's
      // command preview renders.
      expect(card.command).toBe('echo SITAC-ASK one')
      // CONTROL — the rule sentence stays, exactly as the sitting read it.
      expect(card.description).toBe(SITAC_RULE_SENTENCE)
      expect(card.toolName).toBe('Bash')
      // CONTROL — no grant widens: the card keeps its own type (the host mints a
      // permanent Bash rule for a `bash`-typed card only) and carries no remember
      // window (the two fields ARE the don't-ask-again mechanism).
      expect(card.type).toBe('permission_dsl')
      expect(card.commandHash).toBeUndefined()
      expect(card.rememberForMinutes).toBeUndefined()
      // The answer (deny) reached the runtime, so the rig drove the real settle.
      expect(session.sent.at(-1)).toMatchObject({ action: 'block' })
    })
  }

  test('over a gate allow, an Always Allow stays one call: the next identical call asks again and no rule is written', async () => {
    const session = piSession({ mode: 'bypassPermissions', permissions: SITAC_PERMISSIONS, answer: { allowed: true, alwaysAllow: true } })
    await session.run('echo SITAC-ASK one')
    await session.run('echo SITAC-ASK one')
    session.agent.destroy()

    expect(session.cards.map(card => card.command)).toEqual(['echo SITAC-ASK one', 'echo SITAC-ASK one'])
    expect(session.persistedBashRules).toEqual([])
    expect(session.sent.map(message => message.action)).toEqual(['allow', 'allow'])
  })

  /**
   * THE TWIN, measured by this row's own rig at the lane's HEAD: when the MODE
   * already prompts (Manual, a command off the read-only list), the rule's `ask`
   * left the mode's card untouched — "Execute: <command>", the rule unnamed, and
   * the mode's `commandHash` + `rememberForMinutes: 10`. So one Always Allow
   * stored a session remember window and every later identical call ran with NO
   * card: an explicit ask rule switched off for the session, which is the
   * contract `permission-modes.md#actions-no-mode-auto-approves` forbids and
   * F1.860 closed on claude. Measured red: two calls, ONE card, both `allow`.
   */
  for (const arm of [
    { rules: SITAC_PERMISSIONS, command: 'echo SITAC-ASK one', sentence: SITAC_RULE_SENTENCE },
    {
      rules: JSON.stringify({ permissions: { ask: ['Bash(git push:*)'] } }),
      command: 'git push origin main',
      sentence: 'Bash requires approval by readable permission policy rule `Bash(git push:*)` (workspace scope).',
    },
  ]) {
    test(`over a MODE prompt (default, ${arm.command}): the card names the rule, keeps the command, and asks again after Always Allow`, async () => {
      const session = piSession({ mode: 'default', permissions: arm.rules, answer: { allowed: true, alwaysAllow: true } })
      await session.run(arm.command)
      await session.run(arm.command)
      session.agent.destroy()

      // Asks EVERY time: two calls, two cards.
      expect(session.cards).toHaveLength(2)
      const card = session.cards[0]!
      expect(card.command).toBe(arm.command)
      expect(card.description).toBe(arm.sentence)
      // No remember window on an ask-rule card, in any mode.
      expect(card.commandHash).toBeUndefined()
      expect(card.rememberForMinutes).toBeUndefined()
      // The mode card keeps its own type — the shape Pi's gate gives its own
      // ask-rule card (`nonNegotiable: 'askRule'`, promptType `bash`).
      expect(card.type).toBe('bash')
      expect(card.modePrompt).toBeUndefined()
      expect(session.sent.map(message => message.action)).toEqual(['allow', 'allow'])
    })
  }

  test('CONTROL — a no-rule Pi Bash card is unchanged: Execute: <command>, type bash, its remember window kept', async () => {
    const session = piSession({ mode: 'default' })
    await session.run('git push origin main')
    session.agent.destroy()

    expect(session.cards).toHaveLength(1)
    const card = session.cards[0]!
    expect(card.command).toBe('git push origin main')
    expect(card.description).toBe('Execute: git push origin main')
    expect(card.type).toBe('bash')
    expect(card.commandHash).toBeDefined()
    expect(card.rememberForMinutes).toBe(10)
    expect(card.modePrompt).toBe(true)
    expect(String(card.description)).not.toContain('readable permission policy')
  })

  test('CONTROL — a no-rule Always Allow still remembers: the next identical call runs with no card', async () => {
    // UA12.70 — a keyed command: `git push origin main` mints no key now, so its card offers no Always Allow.
    const session = piSession({ mode: 'default', answer: { allowed: true, alwaysAllow: true } })
    await session.run('npm test')
    await session.run('npm test')
    session.agent.destroy()

    expect(session.cards).toHaveLength(1)
    expect(session.sent.map(message => message.action)).toEqual(['allow', 'allow'])
  })

  test("CONTROL — a child's ask-rule card still names the subagent that asked, and now its command", async () => {
    const session = piSession({ mode: 'bypassPermissions', permissions: SITAC_PERMISSIONS, child: { name: 'worker: seed the file' } })
    await session.run('echo SITAC-ASK one')
    session.agent.destroy()

    expect(session.cards).toHaveLength(1)
    const card = session.cards[0]!
    // F1.70's A57 arm: shown in the visible parent, labelled with the child.
    expect(card.agentLabel).toBe('worker: seed the file')
    expect(card.parentSessionId).toBe(session.parent!.id)
    expect(card.sessionId).toBe(session.managed.id)
    expect(card.description).toBe(SITAC_RULE_SENTENCE)
    expect(card.command).toBe('echo SITAC-ASK one')
  })
})

/**
 * F1.913 `[pi]` `[ui]` — after F1.912 the ask-rule card over a MODE prompt kept
 * type `bash`, and `respondToPermission` mints the permanent repository
 * `Bash(<key> *)` rule for an Always Allow on a `bash`-typed card. The ask rule
 * outranks that allow on every later call (`permission-dsl.ts` ACTION_WEIGHT
 * ask 1 > allow 0), so the click bought a lasting grant that never stops this
 * ask — SIT-aj read the strongest grant as 'Allow for this session' and the next
 * identical call carded again. The card now says `noAlwaysAllow`, which the
 * renderer reads as "offer no Always Allow" (`PermissionRequest.tsx`
 * `canRemember`), so the strongest grant is Allow, one call.
 */
describe('F1.913 — a Pi ask-rule card offers no Always Allow', () => {
  const GIT_PUSH_ASK = JSON.stringify({ permissions: { ask: ['Bash(git push:*)'] } })

  test('over a MODE prompt: the strongest grant the card offers is one call — no repository rule, and the next call asks again', async () => {
    const session = piSession({ mode: 'default', permissions: GIT_PUSH_ASK, answer: 'strongest-offered' })
    await session.run('git push origin main')
    await session.run('git push origin main')
    session.agent.destroy()

    expect(session.cards).toHaveLength(2)
    const card = session.cards[0]!
    expect(card.type).toBe('bash')
    expect(card.noAlwaysAllow).toBe(true)
    expect(session.persistedBashRules).toEqual([])
    expect(session.sent.map(message => message.action)).toEqual(['allow', 'allow'])
  })

  test('over a gate allow: the permission_dsl card carries the same refusal', async () => {
    const session = piSession({ mode: 'bypassPermissions', permissions: SITAC_PERMISSIONS })
    await session.run('echo SITAC-ASK one')
    session.agent.destroy()

    expect(session.cards).toHaveLength(1)
    expect(session.cards[0]!.type).toBe('permission_dsl')
    expect(session.cards[0]!.noAlwaysAllow).toBe(true)
  })

  test('CONTROL — a no-rule Manual card still offers Always Allow, writes its rule, and skips the next card', async () => {
    const session = piSession({ mode: 'default', answer: 'strongest-offered' })
    await session.run('npm test') // UA12.70 — a keyed command (`git push` offers no Always Allow now)
    await session.run('npm test')
    session.agent.destroy()

    expect(session.cards).toHaveLength(1)
    expect(session.cards[0]!.noAlwaysAllow).toBeUndefined()
    expect(session.persistedBashRules).toEqual(['npm test'])
    expect(session.sent.map(message => message.action)).toEqual(['allow', 'allow'])
  })
})
