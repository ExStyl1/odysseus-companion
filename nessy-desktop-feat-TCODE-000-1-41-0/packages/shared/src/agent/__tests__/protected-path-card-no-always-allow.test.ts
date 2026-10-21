/**
 * F1.737 `[permissions]` — the protected-path card offers no Always Allow, on Pi
 * and on claude.
 *
 * SIT-v (2026-09-25, packaged `5896a66d2`, pi and claude-gateway): a Write into
 * the data folder in acceptEdits raised the F1.677 protected-path card. It says
 * the path is "never approved automatically — a permission rule that names this
 * path does not skip this prompt", and yet its buttons were Allow / Always Allow
 * / Deny with "'Always Allow' remembers this for the session", on both runtimes.
 *
 * Nothing a click saves is read before this floor: the gate emits it ahead of
 * the branch that reads allow rules, remembered approvals and the session
 * whitelist, and with no `commandHash`/`rememberForMinutes` (the protected-path
 * prompt's own comment in `core/pre-tool-use.ts`). So the button promised what
 * neither side does, and on Pi a `bash`-typed card's Always also reached the
 * host's permanent repository `Bash(<key> *)` rule (F1.913's mechanism) — a
 * grant wider than the question, which the floor then outranks.
 *
 * The fix is the gate's: the protected-path prompt carries `noAlwaysAllow`, the
 * field the renderer's `canRemember` reads and codex's floor cards already send
 * (P2.140). claude's PreToolUse hook forwards it since F1.842; Pi's card builder
 * forwards it now. INSTRUMENT: the REAL claude PreToolUse hook (the SDK `query`
 * is the only double) and the REAL Pi `handlePreToolUseRequest` with a recording
 * permission service — the card each runtime hands the host.
 *
 * CONTROL: an ordinary write card (no protected path, `default`) sends no
 * `noAlwaysAllow` on either runtime, so Always Allow stays offered there.
 */
import { afterAll, describe, expect, mock, setDefaultTimeout, test } from 'bun:test'
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts'
import type { PermissionMode } from '../mode-types.ts'
import { finalizePiExecutionManifest, type PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts'
import { PI_STATIC_MODEL_CONTRACT_HASHES, PI_TOOL_BINDINGS, getHarnessToolDescriptor } from '../pi-harness/harness-tool-descriptor.ts'
import { parseAndFreezePiPermissionReceipt, type PiPermissionServicePort } from '../pi-harness/permission-receipt.ts'

// The module graph (the whole claude and Pi agents) is the cost, not the bodies.
setDefaultTimeout(180_000)

/** A SNAPSHOT of the SDK's exports, never the live namespace (AGENTS.md §Traps, `mock.module`). */
const realSdk = { ...sdkPackage }
type HookFn = (input: Record<string, unknown>, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<unknown>
let capturedOptions: Record<string, unknown> | undefined
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    capturedOptions = input.options
    const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]()
    async function* serve(): AsyncGenerator<unknown> {
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
        yield { type: 'result', subtype: 'success', result: 'ok', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
      }
    }
    const stream = serve() as AsyncGenerator<unknown> & { interrupt(): Promise<unknown> }
    stream.interrupt = async () => ({ still_queued: [] })
    return stream
  },
}))

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'f1737-')))
afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk)
  rmSync(ROOT, { recursive: true, force: true })
})

const { ClaudeAgent } = await import('../claude-agent.ts')
const { PiAgent } = await import('../pi-agent.ts')

type Card = { type?: string; noAlwaysAllow?: boolean; commandHash?: string }
let counter = 0
function workspace(): string {
  counter += 1
  const ws = join(ROOT, `ws-${counter}`)
  mkdirSync(join(ws, '.git'), { recursive: true })
  return ws
}
/** A protected path (`.git`, `PROTECTED_DIRECTORIES`) and an ordinary file, both inside the workspace. */
const protectedWrite = (ws: string) => ({ file_path: join(ws, '.git', 'config'), content: '[core]\n' })
const ordinaryWrite = (ws: string) => ({ file_path: join(ws, 'notes.txt'), content: 'x' })

/** The card the REAL claude PreToolUse hook raises for one `Write` (or `toolName`), refused once seen. */
async function claudeCard(mode: PermissionMode, input: (ws: string) => Record<string, unknown>, toolName = 'Write'): Promise<Card | undefined> {
  const ws = workspace()
  capturedOptions = undefined
  const agent = new ClaudeAgent({
    provider: 'anthropic', providerType: 'anthropic', model: 'claude-sonnet-4-6', isHeadless: true, skipConfigWatcher: true,
    workspace: { id: `ws-f1737-${counter}`, name: 'F1737', rootPath: ws, workspaceRootPath: ws, sessionRootPath: join(ROOT, 'sessions') } as never,
    session: { id: `session-f1737-${counter}`, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: ws, permissionMode: mode } as never,
  } as BackendConfig)
  try {
    agent.setPermissionMode(mode)
    const cards: Array<Card & { requestId: string }> = []
    let raised: (requestId: string) => void = () => {}
    const carded = new Promise<string>(resolve => { raised = resolve })
    agent.onPermissionRequest = request => { cards.push(request as never); raised(request.requestId) }
    const chatImpl = (agent as unknown as { chatImpl(message: string): AsyncGenerator<unknown> }).chatImpl.bind(agent)
    for await (const _ of chatImpl('go')) { /* drain the one turn */ }
    const seen = capturedOptions as Record<string, unknown> | undefined
    const hook = (seen?.hooks as { PreToolUse?: Array<{ hooks: HookFn[] }> } | undefined)?.PreToolUse?.[0]?.hooks?.[0]
    if (!hook) throw new Error('the turn registered no PreToolUse hook')
    const answer = hook(
      { hook_event_name: 'PreToolUse', tool_name: toolName, tool_use_id: 'toolu_f1737', tool_input: input(ws), session_id: 'sdk-f1737', transcript_path: join(ROOT, 't.jsonl'), cwd: ws },
      'toolu_f1737',
      { signal: new AbortController().signal },
    )
    const settled = await Promise.race([answer.then(() => undefined), carded])
    if (settled === undefined) return undefined
    agent.respondToPermission(settled, false)
    await answer
    return cards.find(card => card.requestId === settled)
  } finally {
    agent.destroy()
  }
}

/** The card the REAL Pi `handlePreToolUseRequest` asks the permission service for, for one `Write` (or `toolName`). */
async function piCard(mode: PermissionMode, input: (ws: string) => Record<string, unknown>, toolName = 'Write'): Promise<Card | undefined> {
  const ws = workspace()
  const asked: Card[] = []
  const service: PiPermissionServicePort = {
    async authorize(request) {
      if (request.decision.outcome === 'ask') asked.push(request.decision.request as Card)
      const outcome = request.decision.outcome === 'allow' ? 'allow' : 'deny'
      return parseAndFreezePiPermissionReceipt({
        version: 1, sessionKey: request.subject.sessionKey,
        binding: { provider: 'pi', surfaceVersion: request.subject.surfaceVersion, piName: request.subject.piName, bindingName: request.subject.bindingName, semanticId: request.subject.semanticId, descriptorId: request.subject.descriptorId },
        manifest: { generation: request.subject.manifestGeneration, hash: request.subject.manifestHash, provenance: request.subject.manifestProvenance, responseEpoch: request.subject.responseEpoch },
        decisionId: 'f1737', outcome,
        canonicalInput: (request.decision.outcome === 'allow' ? request.decision.canonicalInput : undefined) ?? request.canonicalInput,
        contextProfile: request.subject.contextProfile, sandboxRequirement: request.subject.sandboxRequirement,
        ...(outcome === 'deny' ? { reason: 'refused by the test' } : {}),
      }, request.subject)
    },
  }
  const agent = new PiAgent({
    provider: 'pi',
    workspace: { id: 'ws-f1737-pi', name: 'W', rootPath: ws, workspaceRootPath: ws, sessionRootPath: join(ROOT, 'sessions') } as never,
    session: { id: 'session-f1737-pi', workspaceRootPath: ws, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: ws } as never,
    model: 'pi/test-model', isHeadless: true, permissionServicePort: service, contextProfile: 'bare',
  } as BackendConfig)
  try {
    agent.setPermissionMode(mode)
    const state = agent as unknown as Record<string, any>
    state.send = () => {}
    state.emitAutomationEvent = async () => ({ matchedCount: 0 })
    const seed: PiExecutionManifestSeedV2 = {
      surfaceVersion: 2, snapshotGeneration: 'test-generation', sessionKey: { workspaceId: 'ws-f1737-pi', sessionId: 'session-f1737-pi' },
      provenance: [], mcpSources: [],
      orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
      staticTools: PI_TOOL_BINDINGS.flatMap(binding => {
        const modelContractHash = PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName]
        return modelContractHash ? [{ descriptor: getHarnessToolDescriptor(binding.descriptorId), binding, source: { kind: 'piBuiltin' as const, bindingId: binding.bindingName }, modelContractHash }] : []
      }),
    }
    const manifest = finalizePiExecutionManifest(seed, [])
    const tool = manifest.tools.find(candidate => candidate.binding.permissionName === toolName)
    if (!tool) throw new Error(`the Pi manifest has no ${toolName} binding`)
    agent.setCapabilityTurnRuntime({ view: { generation: manifest.snapshotGeneration }, materializer: { assertActive() {} }, piExecutionManifestSeed: { snapshotGeneration: manifest.snapshotGeneration } } as unknown as CapabilityTurnRuntime)
    state.activeExecutionManifest = manifest
    await state.handlePreToolUseRequest({
      requestId: 'r1', semanticId: tool.descriptor.id, piName: tool.binding.piName, surfaceVersion: manifest.surfaceVersion,
      manifestResponseEpoch: 0, manifestGeneration: manifest.snapshotGeneration, manifestHash: manifest.manifestHash,
      toolName, input: input(ws),
    })
    return asked.at(-1)
  } finally {
    agent.destroy()
  }
}

describe('F1.737 — the protected-path card carries noAlwaysAllow (Always Allow hidden)', () => {
  for (const mode of ['acceptEdits', 'default'] as const) {
    test(`claude — ${mode}: a Write into .git raises a card with noAlwaysAllow`, async () => {
      const card = await claudeCard(mode, protectedWrite)
      expect(card?.type).toBe('file_write')
      expect(card?.noAlwaysAllow).toBe(true)
    })
    test(`Pi — ${mode}: a Write into .git raises a card with noAlwaysAllow`, async () => {
      const card = await piCard(mode, protectedWrite)
      expect(card?.type).toBe('file_write')
      expect(card?.noAlwaysAllow).toBe(true)
    })
  }
})

describe('F1.737 — CONTROL: an ordinary write card keeps its Always Allow', () => {
  test('claude — default: a Write of an ordinary file raises a card with no noAlwaysAllow', async () => {
    const card = await claudeCard('default', ordinaryWrite)
    expect(card?.type).toBe('file_write')
    expect(card?.noAlwaysAllow).toBeUndefined()
  })
  test('Pi — default: a Write of an ordinary file raises a card with no noAlwaysAllow', async () => {
    const card = await piCard('default', ordinaryWrite)
    expect(card?.type).toBe('file_write')
    expect(card?.noAlwaysAllow).toBeUndefined()
  })
})

/**
 * F1.982 — the other gate floors carry the same field (the gate-level pins, one per
 * floor class, are in `core/__tests__/floor-cards-no-always-allow.test.ts`). Driven
 * here end to end for the removal circuit breaker because its card is `bash`-typed:
 * on Pi an Always on it reached the host's permanent repository `Bash(<key> *)` rule.
 * The command is data — the claude hook's card is refused and Pi's service denies.
 */
describe('F1.982 — the removal circuit breaker card carries noAlwaysAllow on both runtimes', () => {
  const breaker = () => ({ command: 'rm -rf ~' })
  const ordinaryRemoval = () => ({ command: 'npm test' }) // UA12.70 — `rm -rf build` mints no key now, so its card offers no Always Allow either
  test('claude — default: rm -rf ~ raises a bash card with noAlwaysAllow', async () => {
    const card = await claudeCard('default', breaker, 'Bash')
    expect(card?.type).toBe('bash')
    expect(card?.noAlwaysAllow).toBe(true)
  })
  test('Pi — default: rm -rf ~ raises a bash card with noAlwaysAllow', async () => {
    const card = await piCard('default', breaker, 'Bash')
    expect(card?.type).toBe('bash')
    expect(card?.noAlwaysAllow).toBe(true)
  })
  test('CONTROL claude — default: npm test raises a bash card with no noAlwaysAllow', async () => {
    const card = await claudeCard('default', ordinaryRemoval, 'Bash')
    expect(card?.type).toBe('bash')
    expect(card?.noAlwaysAllow).toBeUndefined()
  })
  test('CONTROL Pi — default: npm test raises a bash card with no noAlwaysAllow', async () => {
    const card = await piCard('default', ordinaryRemoval, 'Bash')
    expect(card?.type).toBe('bash')
    expect(card?.noAlwaysAllow).toBeUndefined()
  })
})
