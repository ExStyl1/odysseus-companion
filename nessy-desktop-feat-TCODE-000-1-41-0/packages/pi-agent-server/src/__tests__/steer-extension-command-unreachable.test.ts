/**
 * F1.497 — "a user steer on Pi that starts with a registered extension command
 * name may make the Pi SDK's `steer()` throw". MEASURED on the lifted Pi 0.85.1
 * (F1.255, 2026-09-24) through the production adapter, and the verdict is
 * LATENT, not live:
 *
 *  - the mechanism is real. `AgentSession.steer` calls `_throwIfExtensionCommand`
 *    for any text starting with `/`, and that throws "Extension command
 *    "/<name>" cannot be queued …" when `extensionRunner.getCommand(<name>)`
 *    answers. `pi-agent-server`'s inbound loop would turn the rejection into an
 *    `error` event AND `clearPendingPreToolUse(…)` (the `processMessage(msg).catch`
 *    in `index.ts`), while `PiAgent.redirect` has already returned `true`.
 *  - it is UNREACHABLE in the shipped build: the production composition
 *    registers NO extension command. `PINNED_NESSY_FACTORIES` is empty, the
 *    resource loader is built with `noExtensions: true`, and none of the three
 *    builtin extensions (prompt, lifecycle bridge, deferred MCP) nor the
 *    auto-compaction extension calls `registerCommand`. So `/compact now`, and
 *    every other `/word`, is queued as text.
 *
 * The first case below is the standing guard: the day a curated extension
 * declares a command, it reddens here and F1.497's fix is owed — refuse (or
 * re-queue) the steer before `redirect` returns `true`, and never clear pending
 * PreToolUse requests for a steer that was merely refused. The CONTROL builds the
 * same production session plus ONE factory registering a command, through the
 * one extra-factory slot production itself fills (`autoCompactionExtension`),
 * and shows the SDK refusing that steer by name — so the instrument can see the
 * throw at all.
 */
import { beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODULE_GRAPH_BUDGET_MS, MODULE_GRAPH_HOOK_BUDGET_MS } from '../../../shared/src/testing/module-graph-budgets.ts'

// Building a real session loads Pi's whole module graph (≈2 min cold on this rig) in
// the cases, so the file-wide timer is the budgets module's name for an import cost
// spread across cases, not the hook's (F1.668).
setDefaultTimeout(MODULE_GRAPH_BUDGET_MS)

type SteerOutcome = 'queued' | `threw: ${string}`

let createPiRuntimeAdapter: typeof import('../compat/pi-runtime-adapter.ts').createPiRuntimeAdapter
beforeAll(async () => {
  ({ createPiRuntimeAdapter } = await import('../compat/pi-runtime-adapter.ts'))
}, MODULE_GRAPH_HOOK_BUDGET_MS)

async function steerOutcomes(
  extraCommand: string | undefined,
  texts: readonly string[],
): Promise<{ commands: string[]; outcomes: Record<string, SteerOutcome> }> {
  const root = mkdtempSync(join(tmpdir(), 'nessy-f1497-'))
  const adapter = createPiRuntimeAdapter()
  const handle = await adapter.createSession({
    cwd: root,
    agentDir: join(root, 'agent'),
    registry: await adapter.createRegistry(),
    strategy: { kind: 'memory' },
    sessionOptions: { tools: [] },
    ...(extraCommand
      ? {
          autoCompactionExtension: (pi: { registerCommand(name: string, options: object): void }) => {
            pi.registerCommand(extraCommand, { description: 'F1.497 probe', handler: async () => {} })
          },
        }
      : {}),
  } as never)
  try {
    const session = handle.session as unknown as {
      steer(text: string): Promise<void>
      extensionRunner: { getRegisteredCommands(): Array<{ name: string }> }
    }
    const outcomes: Record<string, SteerOutcome> = {}
    for (const text of texts) {
      try {
        await session.steer(text)
        outcomes[text] = 'queued'
      } catch (error) {
        outcomes[text] = `threw: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    return { commands: session.extensionRunner.getRegisteredCommands().map(command => command.name), outcomes }
  } finally {
    handle.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}

describe('F1.497 · a steer naming an extension command, on the production composition', () => {
  it('the production composition registers no extension command, so every steer is queued', async () => {
    const { commands, outcomes } = await steerOutcomes(undefined, ['/compact now', '/f1497-probe x', 'plain text'])
    expect(commands).toEqual([])
    expect(outcomes).toEqual({ '/compact now': 'queued', '/f1497-probe x': 'queued', 'plain text': 'queued' })
  })

  it('CONTROL — one factory registering a command makes the SDK refuse exactly that steer', async () => {
    const { commands, outcomes } = await steerOutcomes('f1497-probe', ['/f1497-probe x', '/compact now', 'plain text'])
    expect(commands).toEqual(['f1497-probe'])
    expect(outcomes['/f1497-probe x']).toContain('Extension command "/f1497-probe" cannot be queued')
    expect(outcomes['/compact now']).toBe('queued')
    expect(outcomes['plain text']).toBe('queued')
  })
})
