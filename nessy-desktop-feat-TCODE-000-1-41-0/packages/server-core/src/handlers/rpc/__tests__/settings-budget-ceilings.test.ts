/**
 * P6.821 — `SETTINGS_GET` DISCLOSES BOTH BUDGET CEILINGS, because neither can
 * be set from this app and two notices told the user to set one anyway.
 *
 * `chat.budget.notMetered` and `chat.budget.unenforceable` both ended with *set
 * a token limit (`maxBudgetTokens`)*, and `SessionManager`'s
 * `maxBudgetUsdReached` latch rests on *ask the user to raise the limit* being
 * followable. Neither is: both ceilings live in `workspaceDefaults` of
 * `config-defaults.json`, which `syncConfigDefaults` rewrites from the bundle on
 * every launch, so they belong to whoever administers the installation. The
 * owner's answer (2026-09-10, balance rule) was (a) disclose them and (c) reword
 * the notices — NOT (b) invent a user-settable ceiling.
 *
 * WHAT IS PINNED HERE
 *
 *  1. the field is SENT and carries exactly what the two resolvers answer —
 *     asserted against `resolveMaxBudgetTokens()`/`resolveMaxBudgetUsd()`
 *     themselves, not against a number retyped here, because the whole point of
 *     routing the disclosure through the resolvers is that there is one rule;
 *  2. an UNSET ceiling reports the documented `0` — `config-defaults-schema.ts`
 *     says "0 disables the guard" of both, and the wire deliberately does not
 *     re-spell that as `null`;
 *  3. the field is READ-ONLY: `SETTINGS_UPDATE` refuses it by name;
 *  4. the SECOND copy of the USD rule — `BaseAgent.getMaxBudgetUsd`, the reader
 *     that actually stops a turn — still agrees with the resolver the
 *     disclosure uses. That one is a source-level pin and it is the only
 *     instrument that can see the divergence: a disclosure showing a ceiling
 *     the enforcement does not apply would be silent everywhere else.
 *
 * MUTATION PROBES (2026-09-10):
 *  - drop `budgetCeilings` from the payload → case 1 goes red on `toEqual`;
 *  - return the RAW `workspaceDefaults.maxBudgetUsd` instead of the resolver →
 *    case 2's negative arm goes red, because a negative ceiling on disk reads
 *    back as a ceiling instead of as no ceiling;
 *  - change `getMaxBudgetUsd`'s guard in `base-agent.ts` → case 4 goes red.
 *
 * In-process, on the fixture shape `settings-managed-default-mode.test.ts`
 * established. The config directory is the per-run temp one the root
 * `bunfig.toml` preload creates, so writing `config-defaults.json` here touches
 * no real config — and every case restores the seeded bytes afterwards, because
 * `bun test` shares that directory with every other file in the process.
 */

import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { resolveMaxBudgetTokens, resolveMaxBudgetUsd } from '@nessy-agent/shared/config'
import type { HandlerFn, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { registerSettingsHandlers } from '../settings'

const WORKSPACE_ID = 'ws-budget-ceilings'

const CONFIG_DEFAULTS_FILE = join(
  process.env.NESSY_CONFIG_DIR ?? '',
  'config-defaults.json',
)

let seeded = ''

beforeAll(() => {
  expect(process.env.NESSY_CONFIG_DIR, 'the isolate preload did not run').toBeTruthy()
  seeded = readFileSync(CONFIG_DEFAULTS_FILE, 'utf-8')
})

afterEach(() => {
  writeFileSync(CONFIG_DEFAULTS_FILE, seeded, 'utf-8')
})

/**
 * Write the two ceilings the operator would have deployed. `undefined` REMOVES
 * the field, which is the unset case rather than a zero the operator typed.
 */
function deployCeilings(over: { maxBudgetTokens?: number; maxBudgetUsd?: number }): void {
  const defaults = JSON.parse(seeded) as { workspaceDefaults: Record<string, unknown> }
  for (const key of ['maxBudgetTokens', 'maxBudgetUsd'] as const) {
    if (over[key] === undefined) delete defaults.workspaceDefaults[key]
    else defaults.workspaceDefaults[key] = over[key]
  }
  writeFileSync(CONFIG_DEFAULTS_FILE, JSON.stringify(defaults, null, 2), 'utf-8')
}

function handlers(): Map<string, HandlerFn> {
  const registered = new Map<string, HandlerFn>()
  const server = {
    handle(channel: string, handler: HandlerFn) { registered.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as RpcServer
  const deps = {
    sessionManager: {},
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    oauthFlowStore: {},
    workspaceService: {
      resolve(id: string) {
        return {
          id,
          name: 'Budget ceilings',
          rootPath: '/tmp/budget-ceilings',
          config: { name: 'Budget ceilings', defaults: {} },
        }
      },
    },
  } as unknown as HandlerDeps
  registerSettingsHandlers(server, deps)
  return registered
}

const ctx = { clientId: 'client-a', workspaceId: WORKSPACE_ID, webContentsId: null }

async function read() {
  const handler = handlers().get(RPC_CHANNELS.workspace.SETTINGS_GET)
  expect(handler, 'SETTINGS_GET is not registered').toBeDefined()
  return await handler!(ctx, WORKSPACE_ID) as {
    budgetCeilings?: { maxBudgetTokens: number; maxBudgetUsd: number }
  }
}

describe('P6.821 · SETTINGS_GET carries both effective budget ceilings', () => {
  it('sends exactly what the resolvers the agents read answer', async () => {
    deployCeilings({ maxBudgetTokens: 250_000, maxBudgetUsd: 12.5 })
    const settings = await read()
    // Against the resolvers FIRST — this is the assertion that fails if the
    // handler ever grows its own copy of the rule.
    expect(settings.budgetCeilings).toEqual({
      maxBudgetTokens: resolveMaxBudgetTokens(),
      maxBudgetUsd: resolveMaxBudgetUsd(),
    })
    // …and against the deployed values, so a pair of resolvers that both broke
    // the same way cannot satisfy the line above vacuously.
    expect(settings.budgetCeilings).toEqual({ maxBudgetTokens: 250_000, maxBudgetUsd: 12.5 })
  })

  /**
   * The NEGATIVE, and the documented answer is `0`, not absence:
   * `config-defaults-schema.ts` says "0 disables the guard" of `maxBudgetUsd`
   * and "0 disables the guard, exactly as its USD twin does" of
   * `maxBudgetTokens`. The renderer distinguishes `0` (no ceiling) from a
   * MISSING `budgetCeilings` (a host too old to say), so the object itself must
   * be present even when both ceilings are off.
   */
  it('an unset ceiling reports the documented 0, with the object still present', async () => {
    for (const deployed of [
      {},                                            // neither declared
      { maxBudgetTokens: 0, maxBudgetUsd: 0 },        // both explicitly off
      { maxBudgetTokens: -1, maxBudgetUsd: -1 },      // a nonsense value on disk
    ]) {
      deployCeilings(deployed)
      const settings = await read()
      expect(settings.budgetCeilings, JSON.stringify(deployed)).toBeDefined()
      expect(settings.budgetCeilings).toEqual({ maxBudgetTokens: 0, maxBudgetUsd: 0 })
    }
  })

  it('refuses a write: the disclosure is read-only on the wire', async () => {
    const update = handlers().get(RPC_CHANNELS.workspace.SETTINGS_UPDATE)
    expect(update).toBeDefined()
    await expect(update!(ctx, WORKSPACE_ID, 'budgetCeilings', { maxBudgetTokens: 1, maxBudgetUsd: 1 }))
      .rejects.toThrow(/Invalid workspace setting key/)
  })
})

/**
 * THE DRIFT PIN, and the reason it is a source read rather than a call.
 *
 * `BaseAgent.getMaxBudgetUsd` is `protected` — it cannot be imported and
 * compared — and it is the reader that actually stops a turn. If it and
 * `resolveMaxBudgetUsd()` ever answer differently, this page shows a ceiling the
 * product does not apply, and nothing else in the tree would say so. P6.821 was
 * forbidden from editing `base-agent.ts` (another lane's file for the whole of
 * wave 10); the controller landed the delegation the same day, so the guard is
 * now the narrow one: the method DELEGATES to the resolver. (The looser
 * `delegates || repeats` form it carried for one commit is what let the two
 * copies coexist; the narrow form is what makes a second copy a red.)
 */
describe('P6.821 · the enforcement reader and the disclosure resolver still agree', () => {
  it('BaseAgent.getMaxBudgetUsd delegates to resolveMaxBudgetUsd', () => {
    const baseAgent = readFileSync(
      fileURLToPath(new URL('../../../../../shared/src/agent/base-agent.ts', import.meta.url)),
      'utf8',
    )
    const start = baseAgent.indexOf('protected getMaxBudgetUsd(): number {')
    expect(start, 'getMaxBudgetUsd is gone from base-agent.ts — re-derive this pin').toBeGreaterThan(-1)
    const body = baseAgent.slice(start, baseAgent.indexOf('\n  }', start))
    const delegates = body.includes('resolveMaxBudgetUsd()')
    expect(
      delegates,
      'getMaxBudgetUsd no longer matches resolveMaxBudgetUsd — the settings page would '
        + 'disclose a ceiling the enforcement does not apply',
    ).toBe(true)
  })
})
