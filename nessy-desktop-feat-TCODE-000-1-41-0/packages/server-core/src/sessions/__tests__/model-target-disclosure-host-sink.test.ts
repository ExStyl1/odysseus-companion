/**
 * DA2.15 — the HOST supplies `onModelTargetDisclosure`, and what it does with it.
 *
 * `packages/shared/src/agent/__tests__/model-target-disclosure-sink.test.ts`
 * (WC-e) pins that the port exists on `CoreBackendConfig` and that all three
 * `noteModelTargetToolEgress` call sites pass it through. Nothing pinned the
 * other end: that a real session actually HANDS one in. That half is the whole
 * row — the port's own contract says `emit` REPLACES the helper's
 * `console.warn`, so a host that supplies no sink is on the old path and a host
 * that supplies a sink which does not log has silently DELETED the operator's
 * only copy of the line.
 *
 * ## Three invariants, and the third is the one a future reader will want to break
 *
 * 1. the wire exists — the config the production path hands the backend factory
 *    carries the sink;
 * 2. it LOGS — calling it reaches the platform logger, which is where an
 *    operator can still read it (a packaged Electron build writes the helper's
 *    own `console.warn` nowhere: `main/logger.ts` disables both electron-log
 *    transports outside debug mode, which is DA1.58's finding on another sink);
 * 3. it mints NO transcript message. `noteModelTargetToolEgress` dedupes per
 *    PROCESS on `(class, host, model-namespace, has-tool-names)` — documented at
 *    its `emittedModelTargetNotices` declaration, because a per-session line
 *    would be per-turn noise on a long-running app — so a transcript row driven
 *    off this sink would appear for the FIRST session in the process and for no
 *    session after it. Right for an operator log, wrong for a per-session user
 *    notice; the per-session surface is DA2.6's renderer classification, which
 *    needs no sink at all. Arm 3 is what goes red the day someone wires a
 *    `sendEvent` here believing it is per-session.
 *
 * Stands at the factory seam `createBackendFromManagedContext`, which exists so
 * a test can stand there — the pattern of `agent-config-budget-anchors.test.ts`
 * and `agent-config-project-trust.test.ts` next door, and for their reason: the
 * gap is the WIRE, and everything past the seam (credentials, subprocess spawn)
 * is irrelevant to a wire.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHeadlessPlatform } from '../../runtime/platform-headless.ts'
import { createManagedSession, setSessionPlatform } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

setSessionPlatform(createHeadlessPlatform())

/** The module under read, for the source-text arm and for the child below. */
const SESSION_MANAGER = join(import.meta.dir, '..', 'SessionManager.ts')
const HEADLESS_PLATFORM = join(import.meta.dir, '..', '..', 'runtime', 'platform-headless.ts')
const TEST_SESSION_MANAGER = join(import.meta.dir, 'test-session-manager.ts')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type CapturedConfig = {
  onModelTargetDisclosure?: (line: string) => void
  onHostOverheadUsage?: (turn: unknown) => void
}

interface Captured {
  config: CapturedConfig
  messageCount: number
  messagesAfter: () => number
}

async function captureBackendConfig(): Promise<Captured> {
  const root = mkdtempSync(join(tmpdir(), 'nessy-agent-model-target-sink-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })

  const manager = createTestSessionManager()
  const managed = createManagedSession({ id: 'session-da215' }, {
    id: 'workspace-da215',
    name: 'Workspace DA2.15',
    rootPath: workspaceRoot,
    createdAt: 1,
  }, {
    messagesLoaded: true,
    ephemeral: true,
    workingDirectory: workspaceRoot,
  })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    'workspace-da215:session-da215',
    managed,
  )

  const internals = manager as unknown as {
    createCapabilityTurn(managed: unknown): Promise<{ runtime: unknown }>
    getOrCreateAgent(managed: unknown, runtime: unknown): Promise<unknown>
    createBackendFromManagedContext(args: { coreConfig: CapturedConfig }): unknown
    cleanup(): void
  }
  try {
    const turn = await internals.createCapabilityTurn(managed)
    let captured: CapturedConfig | undefined
    internals.createBackendFromManagedContext = args => {
      captured = args.coreConfig
      throw new Error('captured-before-construction')
    }
    await expect(internals.getOrCreateAgent(managed, turn.runtime)).rejects.toThrow('captured-before-construction')
    expect(captured).toBeTruthy()
    const messages = managed.messages as unknown[]
    return {
      config: captured!,
      messageCount: messages.length,
      messagesAfter: () => (managed.messages as unknown[]).length,
    }
  } finally {
    internals.cleanup()
  }
}

/** A disclosure sentence in the helper's own shape. Carries no schema and no key. */
const LINE = 'This model answers from api.example.invalid, and the tools it can call are named to it.'

describe('DA2.15 · the host wires the model-target disclosure sink', () => {
  it('the config the production path hands the factory carries it', async () => {
    const { config } = await captureBackendConfig()

    expect(typeof config.onModelTargetDisclosure).toBe('function')
    // The precedent it copies, in the same capture: without this the assertion
    // above is equally true of a config object that carries every optional port
    // for some unrelated reason.
    expect(typeof config.onHostOverheadUsage).toBe('function')
  })

  it('binds the disclosure to the sink a PACKAGED build keeps, not to the scoped alias', async () => {
    // F1.177, the source-text half. The live half is the child below, which is
    // the only instrument that can answer *which file descriptor* an operator
    // has to be capturing. The binding this row found wrote through
    // `createScopedLogger(platform.logger, 'session')`, and
    // `apps/electron/src/main/logger.ts` sets BOTH electron-log transports to
    // `level = false` outside debug mode — which a packaged build always is — so
    // the disclosure DA2.15 exists to publish was written nowhere in every build
    // it was written for. This is DA1.58's and DA2.6's mistake a third time, one
    // module over from F1.143's.
    const src = await Bun.file(SESSION_MANAGER).text()
    const at = src.indexOf('onModelTargetDisclosure: (line) => {')
    expect(at).toBeGreaterThan(0)
    const binding = src.slice(at, src.indexOf('\n        },', at))
    // A runaway slice would swallow the rest of a 38 000-line module and make
    // every assertion below pass for a match anywhere in it. The negative needle
    // names something this module spells hundreds of times BELOW the anchor as
    // well as above it, so it really can fail on a runaway.
    expect(binding.length).toBeLessThan(400)

    expect(binding).toContain('modelTargetLog.warn(line)')
    expect(binding).not.toContain('sessionLog')
  })

  it('NEGATIVE: it adds no transcript message — the helper dedupes per PROCESS', async () => {
    // The arm that goes red the day a `sendEvent` is wired here. A line driven
    // off this sink is first-session-only; a per-session user notice is DA2.6's
    // renderer classification, which needs no sink.
    const captured = await captureBackendConfig()

    const realWarn = console.warn
    console.warn = () => {}
    try {
      captured.config.onModelTargetDisclosure!(LINE)
      captured.config.onModelTargetDisclosure!(LINE)
    } finally {
      console.warn = realWarn
    }

    expect(captured.messagesAfter()).toBe(captured.messageCount)
  })
})

/**
 * F1.177 (origin WJ-i, P-WJ-i-1) — the disclosure on a file descriptor a
 * PACKAGED build still carries.
 *
 * ## Why a child, and why a SILENT platform logger inside it
 *
 * Stubbing `process.stderr.write` in-process does not intercept `console.*`
 * under bun 1.3.14 (AGENTS.md, WI-v), and the question this row asks is exactly
 * *which file descriptor an operator has to be capturing* — which only a real
 * child can answer. The child hands `setSessionPlatform` a platform whose logger
 * DROPS everything, which is the packaged shape (`main/logger.ts` sets both
 * electron-log transports to `level = false` outside debug mode). A headless
 * platform would not reproduce it: `platform-headless.ts` supplies a console
 * logger that always writes, so the old binding would have passed this arm for
 * the wrong reason.
 *
 * The stdout marker is the positive control and it carries the CAPTURE's own
 * outcome, so an absent disclosure is an absent DISCLOSURE rather than a config
 * that was never built — the shape F1.143's child uses one module over.
 */
describe('F1.177 · the disclosure reaches the sink a packaged build keeps', () => {
  function childSource(): string {
    return [
      `const sm = await import(${JSON.stringify(SESSION_MANAGER)})`,
      `const hp = await import(${JSON.stringify(HEADLESS_PLATFORM)})`,
      `const tsm = await import(${JSON.stringify(TEST_SESSION_MANAGER)})`,
      `const fs = await import("node:fs")`,
      `const os = await import("node:os")`,
      `const path = await import("node:path")`,
      // The packaged shape: every level a no-op, exactly what electron-log with
      // both transports disabled amounts to at the call site.
      `const dropped = { debug(){}, info(){}, warn(){}, error(){} }`,
      `sm.setSessionPlatform({ ...hp.createHeadlessPlatform(), logger: dropped })`,
      `const root = fs.mkdtempSync(path.join(os.tmpdir(), "nessy-agent-f1177-"))`,
      `const workspaceRoot = path.join(root, "workspace")`,
      `fs.mkdirSync(workspaceRoot, { recursive: true })`,
      `const manager = tsm.createTestSessionManager()`,
      `const managed = sm.createManagedSession({ id: "session-f1177" }, {`,
      `  id: "workspace-f1177", name: "Workspace F1.177", rootPath: workspaceRoot, createdAt: 1,`,
      `}, { messagesLoaded: true, ephemeral: true, workingDirectory: workspaceRoot })`,
      `manager.sessions.set("workspace-f1177:session-f1177", managed)`,
      `let captured`,
      `try {`,
      `  const turn = await manager.createCapabilityTurn(managed)`,
      `  manager.createBackendFromManagedContext = (args) => {`,
      `    captured = args.coreConfig`,
      `    throw new Error("captured-before-construction")`,
      `  }`,
      `  try { await manager.getOrCreateAgent(managed, turn.runtime) } catch {}`,
      `} finally { manager.cleanup() }`,
      `console.log("DISCLOSURE-STDOUT-CONTROL " + typeof captured?.onModelTargetDisclosure)`,
      `captured.onModelTargetDisclosure(${JSON.stringify(LINE)})`,
      `fs.rmSync(root, { recursive: true, force: true })`,
    ].join('\n')
  }

  /**
   * `delete` then assign, never a spread with `undefined` — AGENTS.md records
   * that an object literal cannot clear a name Bun pre-created a slot for, which
   * would leave the switch ON in the negative arm.
   */
  async function runChild(debugOn: boolean) {
    const env = { ...process.env }
    delete env.NESSY_DEBUG
    if (debugOn) env.NESSY_DEBUG = '1'
    const child = Bun.spawn(['bun', '-e', childSource()], { env, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await child.exited
    return { stdout, stderr }
  }

  it('writes the disclosure to the child\'s STDERR under NESSY_DEBUG=1 although the platform logger drops everything', async () => {
    const { stdout, stderr } = await runChild(true)

    // The positive control FIRST: the production config really was built in this
    // child and really carries the port.
    expect(stdout).toContain('DISCLOSURE-STDOUT-CONTROL function')

    expect(stderr).toContain('[model-target]')
    expect(stderr).toContain(LINE)
  }, 300_000)

  it('NEGATIVE CONTROL: with the switch off nothing is written, and the instrument still reads the child', async () => {
    const { stdout, stderr } = await runChild(false)

    expect(stdout).toContain('DISCLOSURE-STDOUT-CONTROL function')
    expect(stderr).not.toContain(LINE)
  }, 300_000)
})
