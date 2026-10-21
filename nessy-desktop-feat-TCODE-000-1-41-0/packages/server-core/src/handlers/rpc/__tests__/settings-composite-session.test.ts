import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { HandlerFn, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { registerSettingsHandlers } from '../settings'
import { isErrorCode } from '@nessy-agent/shared/protocol'
import {
  clearManagedModelPolicy,
  setManagedModelPolicy,
} from '@nessy-agent/shared/config/managed-models'
import { parseManagedPiPolicyTolerantV1 } from '@nessy-agent/shared/agent/pi-harness/managed-policy'

const policyOf = (availableModels: readonly string[]) => parseManagedPiPolicyTolerantV1(
  { schemaVersion: 1, disabledPermissionModes: [], availableModels },
  { source: '/etc/nessy/managed-policy.json' },
).policy

function setupSettingsHandlers(): { handlers: Map<string, HandlerFn>; updates: unknown[][] } {
  const handlers = new Map<string, HandlerFn>()
  const updates: unknown[][] = []
  const server = {
    handle(channel: string, handler: HandlerFn) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as RpcServer
  const deps = {
    sessionManager: {
      async updateSessionModel(...args: unknown[]) { updates.push(args) },
    },
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerSettingsHandlers(server, deps)
  return { handlers, updates }
}

describe('settings session identity', () => {
  it('uses workspaceId when reading a session model', async () => {
    const handlers = new Map<string, HandlerFn>()
    const calls: unknown[][] = []
    const server = {
      handle(channel: string, handler: HandlerFn) { handlers.set(channel, handler) },
      push() {},
      async invokeClient() { return undefined },
      hasClientCapability() { return false },
      findClientsWithCapability() { return [] },
    } as RpcServer
    const deps = {
      sessionManager: {
        async getSession(...args: unknown[]) {
          calls.push(args)
          return { model: 'model-a' }
        },
      },
      platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
      oauthFlowStore: {},
    } as unknown as HandlerDeps
    registerSettingsHandlers(server, deps)

    const result = await handlers.get(RPC_CHANNELS.sessions.GET_MODEL)!({
      clientId: 'client-a', workspaceId: 'ws-a', webContentsId: null,
    }, 'session-a', 'ws-a')

    expect(result).toBe('model-a')
    expect(calls).toEqual([['session-a', 'ws-a']])
  })

  it('refuses a model switch the managed allowlist excludes, with a translatable code', async () => {
    // `model-config.md:165` — "**`/model`**: the switch is rejected with an
    // error." The refusal must never reach `updateSessionModel`, and it carries
    // a wire CODE so the renderer can translate it instead of showing an English
    // server string. The message names the model and nothing else: a policy's
    // contents are the administrator's to disclose.
    const { handlers, updates } = setupSettingsHandlers()
    const setModel = handlers.get(RPC_CHANNELS.sessions.SET_MODEL)!
    const ctx = { clientId: 'client-a', workspaceId: 'ws-a', webContentsId: null }

    setManagedModelPolicy(policyOf(['claude-haiku-4-5']))
    try {
      await expect(setModel(ctx, 'session-a', 'ws-a', 'claude-opus-4-5-20260101'))
        .rejects.toMatchObject({
          code: 'MODEL_RESTRICTED_BY_POLICY',
          message: 'Model is restricted by managed policy: claude-opus-4-5-20260101',
        })
      expect(updates).toEqual([])
      expect(isErrorCode('MODEL_RESTRICTED_BY_POLICY')).toBe(true)
    } finally {
      clearManagedModelPolicy()
    }
  })

  it('lets an allowlisted model through, and always lets the override be cleared', async () => {
    // Clearing resolves to the connection Default, which
    // `managed-settings.md#keys-that-fail-closed`'s `availableModels` row —
    // "Enforced as an empty allowlist until fixed, so only the Default model is
    // available" — and `model-config.md:205` keep reachable through any
    // allowlist, including one that admits no named model at all.
    const { handlers, updates } = setupSettingsHandlers()
    const setModel = handlers.get(RPC_CHANNELS.sessions.SET_MODEL)!
    const ctx = { clientId: 'client-a', workspaceId: 'ws-a', webContentsId: null }

    setManagedModelPolicy(policyOf([]))
    try {
      await setModel(ctx, 'session-a', 'ws-a', null)
      setManagedModelPolicy(policyOf(['claude-haiku-4-5']))
      await setModel(ctx, 'session-a', 'ws-a', 'claude-haiku-4-5-20251001')
    } finally {
      clearManagedModelPolicy()
    }
    expect(updates).toEqual([
      ['session-a', 'ws-a', null, undefined],
      ['session-a', 'ws-a', 'claude-haiku-4-5-20251001', undefined],
    ])
  })
})

/**
 * P2.527 — the guardian judge-model write consults the same allowlist as the
 * session-model write, with the same code.
 *
 * Before this, `SET_MODEL_FOR_CONNECTION` wrote straight to storage and
 * `resolveGuardianJudgeModel` silently substituted at judge time: the picker
 * showed one judge and another one ran the deny-net over auto mode. The renderer
 * arm that turns the code into a warning shipped in P2.502 and was unreachable
 * through this channel until the gate landed here.
 *
 * A refusal is asserted on BOTH judge channels, because a per-channel exemption
 * is how a closed door grows a second entrance; and clearing is asserted to stay
 * open on both, because a user trapped on a forbidden judge with no way back is
 * a worse outcome than the one being fixed.
 */
describe('the guardian judge model is refused by managed policy, not substituted', () => {
  const JUDGE_CHANNELS = [
    ['per connection', RPC_CHANNELS.guardian.SET_MODEL_FOR_CONNECTION, ['nessy-gateway']],
    ['legacy global', RPC_CHANNELS.guardian.SET_MODEL, []],
  ] as const

  const ctx = { clientId: 'client-a', workspaceId: 'ws-a', webContentsId: null }

  for (const [label, channel, leading] of JUDGE_CHANNELS) {
    it(`refuses a forbidden judge model on the ${label} channel, with the same wire code`, async () => {
      const { handlers } = setupSettingsHandlers()
      const setJudge = handlers.get(channel)!
      setManagedModelPolicy(policyOf(['claude-haiku-4-5']))
      try {
        await expect(setJudge(ctx, ...leading, 'claude-opus-4-5-20260101'))
          .rejects.toMatchObject({
            code: 'MODEL_RESTRICTED_BY_POLICY',
            message: 'Model is restricted by managed policy: claude-opus-4-5-20260101',
          })
        expect(isErrorCode('MODEL_RESTRICTED_BY_POLICY')).toBe(true)
      } finally {
        clearManagedModelPolicy()
      }
    })

    it(`still lets an allowlisted judge through, and always lets it be cleared, on the ${label} channel`, async () => {
      const { handlers } = setupSettingsHandlers()
      const setJudge = handlers.get(channel)!
      // An allowlist admitting NO named model still has to accept the clear —
      // clearing resolves back through the chain to the `fast` alias or the
      // session's own model, which no allowlist can make unreachable.
      setManagedModelPolicy(policyOf([]))
      try {
        await setJudge(ctx, ...leading, '')
        setManagedModelPolicy(policyOf(['claude-haiku-4-5']))
        await setJudge(ctx, ...leading, 'claude-haiku-4-5-20251001')
      } finally {
        clearManagedModelPolicy()
      }
    })
  }
})

/**
 * P2.528 — the advising model finally has an IPC surface, and it refuses the
 * one thing it can decide without a session.
 *
 * Until this row `advisorModel` had NO channel at all: the getter and setter
 * were reachable only in-process, so `/advisor` was the entire surface and a
 * settings row could not exist. The four channels are shaped as guardian's
 * because it is the same class of key and the same refusal — which is exactly
 * what these assert, so a divergence between the two writes is a red rather
 * than a discovery six months later.
 *
 * The three OTHER advisor refusals (`refused-entitlement`,
 * `refused-capability`, and the consult-time allowlist arm) are session-scoped
 * and are deliberately NOT asserted here: the handler has no connection
 * catalogue and no session model, so it cannot answer them, and a handler that
 * guessed would be the "picker that reports the wrong one" the row warns about.
 */
describe('the advisor model is refused by managed policy, not stored and dropped later', () => {
  const ctx = { clientId: 'client-a', workspaceId: 'ws-a', webContentsId: null }

  it('registers all four advisor channels — the surface the row exists to create', async () => {
    const { handlers } = setupSettingsHandlers()
    for (const channel of [
      RPC_CHANNELS.advisor.GET_ENABLED,
      RPC_CHANNELS.advisor.SET_ENABLED,
      RPC_CHANNELS.advisor.GET_MODEL,
      RPC_CHANNELS.advisor.SET_MODEL,
    ]) {
      expect(handlers.get(channel), `${channel} is declared but not registered`).toBeDefined()
    }
  })

  it('refuses a forbidden advisor model with the SAME wire code as the session and judge writes', async () => {
    const { handlers } = setupSettingsHandlers()
    const setAdvisor = handlers.get(RPC_CHANNELS.advisor.SET_MODEL)!
    setManagedModelPolicy(policyOf(['claude-haiku-4-5']))
    try {
      await expect(setAdvisor(ctx, 'claude-opus-4-5-20260101'))
        .rejects.toMatchObject({
          code: 'MODEL_RESTRICTED_BY_POLICY',
          message: 'Model is restricted by managed policy: claude-opus-4-5-20260101',
        })
      // The renderer arm that translates this code already exists
      // (`describeManagedModelRefusal`, P2.502) — reusing the code is what makes
      // it reachable from a new control with no renderer change.
      expect(isErrorCode('MODEL_RESTRICTED_BY_POLICY')).toBe(true)
    } finally {
      clearManagedModelPolicy()
    }
  })

  it('always lets the advisor be cleared back to the session\'s own model', async () => {
    const { handlers } = setupSettingsHandlers()
    const setAdvisor = handlers.get(RPC_CHANNELS.advisor.SET_MODEL)!
    // An allowlist admitting no named model still has to accept the clear: `''`
    // is the documented default — "the session's own model advises" — and it is
    // reachable through any allowlist. Refusing it would trap the user on a
    // forbidden advisor with the consult disabled and no way back.
    //
    // The assertion is that neither call REJECTS, and no value is read back: in
    // this rig `config.json` is absent, so a read-back would return `''` even
    // with the setter deleted and the test would pass vacuously.
    setManagedModelPolicy(policyOf([]))
    try {
      await setAdvisor(ctx, '')
      // Whitespace is a clear too, not a model id: the setter trims before it
      // decides, so a stray space cannot be refused as an unknown model. Under
      // the pre-trim shape this line throws MODEL_RESTRICTED_BY_POLICY.
      await setAdvisor(ctx, '   ')
    } finally {
      clearManagedModelPolicy()
    }
  })

  it('lets an allowlisted advisor model through the gate', async () => {
    // The complement of the refusal above. It asserts the GATE, not persistence:
    // this rig has no `config.json`, so every `config/storage` setter logs
    // "the change was NOT persisted" and no-ops — which is why the guardian block
    // above never reads a value back either. Persistence is `config/storage`'s
    // contract and is tested there; what this layer owns is refuse-or-pass.
    const { handlers } = setupSettingsHandlers()
    const setAdvisor = handlers.get(RPC_CHANNELS.advisor.SET_MODEL)!
    setManagedModelPolicy(policyOf(['claude-haiku-4-5']))
    try {
      await setAdvisor(ctx, 'claude-haiku-4-5-20251001')
    } finally {
      clearManagedModelPolicy()
    }
  })

  it('wires both getters to the storage readers, with the documented shapes', async () => {
    // Cheap, but it is the half a broken import would silently take out: a
    // getter bound to nothing rejects, and a settings row would then show a
    // spinner forever rather than the documented default.
    const { handlers } = setupSettingsHandlers()
    const model = await handlers.get(RPC_CHANNELS.advisor.GET_MODEL)!(ctx)
    const enabled = await handlers.get(RPC_CHANNELS.advisor.GET_ENABLED)!(ctx)
    expect(typeof model).toBe('string')
    // OPT-IN: `advisor.md` turns the advisor on with `/advisor`, `advisorModel`
    // or `--advisor`, and an absent key falls through to the bundled default
    // `false`. A picker must READ this rather than assume it — which is half of
    // why the channel exists.
    expect(enabled).toBe(false)
    // `''` is the documented "the session's own model advises" default, and it
    // is what an unconfigured install answers.
    expect(model).toBe('')
  })

  it('does not throw on the enable write', async () => {
    const { handlers } = setupSettingsHandlers()
    await handlers.get(RPC_CHANNELS.advisor.SET_ENABLED)!(ctx, true)
    await handlers.get(RPC_CHANNELS.advisor.SET_ENABLED)!(ctx, false)
  })
})
