/**
 * D1.277 — the claude child's own telemetry verdict, said out loud only when it
 * DISAGREES with what this machine was configured to want, in the user's
 * language and on one channel.
 *
 * ## What moved, and why
 *
 * D1.208 read `analytics_disabled` off the SDK's `system`/`init` object (a field
 * in neither `sdk.d.ts` nor this repo until that row — AGENTS.md's membership
 * rule) and shipped the alarming direction as an ENGLISH
 * `queueDegradationNotice` from inside `ClaudeAgent`. The measurement is the
 * agent's; the sentence is the app's own words about its own host addressed to
 * the person in the chat, which is C3.331's localise case — and this session's
 * other two telemetry facts (`telemetry-identity-exported`,
 * `telemetry-event-dialect`) already ride the settings-tiers line in the user's
 * language. So the agent answers and the host renders.
 *
 * ## The second direction, built here for the first time
 *
 * The row asks for the disagreement "or the reverse", and the reverse had no
 * producer: this machine opted IN and has an exporter configured, and the child
 * reports its own analytics off — so a dashboard written against the runtime's
 * own stream returns silence for these sessions, which reads as "nothing
 * happened". That half is the HOST's to see, because it is the host's opt-in
 * predicates that know an exporter is configured.
 *
 * ## What must stay silent, and the arms that hold it
 *
 * The reassuring direction is not actionable. Analytics on with NO request is
 * the runtime's documented default, which this host neither set nor can undo.
 * And `null` — no `system/init` seen yet — is an answer, not a `false`.
 *
 * SAFETY: no real credential and no real telemetry endpoint; the two host
 * predicates are driven through a fabricated env object, never by mutating the
 * process (`telemetryOptedIn`/`telemetryOptedOut` read what they are given, and
 * the producer reads `process.env`, so each arm sets and restores by the
 * delete-before-assign rule AGENTS.md records for bun 1.3.14).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createTestSessionManager } from './test-session-manager.ts'

interface Internals {
  sessions: Map<string, unknown>
  sendEvent(event: { type: string; message?: string; level?: string }, workspaceId?: string): void
  announceChildTelemetryVerdict(managed: unknown): void
}

const ENV_KEYS = [
  'DISABLE_TELEMETRY',
  'DO_NOT_TRACK',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'NESSY_ENABLE_TELEMETRY',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_METRICS_EXPORTER',
  'OTEL_LOGS_EXPORTER',
] as const

const saved = new Map<string, string | undefined>()

function setEnv(entries: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key])
    // Delete before assign, and on the restore path too: a name introduced by
    // bare assignment is invisible to `Object.keys`/spread on bun 1.3.14.
    delete process.env[key]
    const value = entries[key]
    if (value !== undefined) process.env[key] = value
  }
}

afterEach(() => {
  for (const [key, value] of saved) {
    delete process.env[key]
    if (value !== undefined) process.env[key] = value
  }
  saved.clear()
})

function rig(agent: Record<string, unknown> | undefined) {
  const manager = createTestSessionManager()
  const internals = manager as unknown as Internals
  const sessionKey = { workspaceId: 'workspace-d1277', sessionId: 'session-d1277' }
  const lines: string[] = []
  internals.sendEvent = event => {
    if (event.type === 'info' && typeof event.message === 'string') lines.push(event.message)
  }
  const managed = {
    id: sessionKey.sessionId,
    name: 'D1.277',
    workspace: { id: sessionKey.workspaceId, rootPath: '/tmp/workspace-d1277' },
    agent,
  }
  internals.sessions.set(encodeSessionKey(sessionKey), managed)
  return {
    lines,
    announce: () => internals.announceChildTelemetryVerdict(managed),
  }
}

/** The two answers the agent publishes, as the host reads them. */
function claudeChild(disabled: boolean | null, requested: string | null) {
  return {
    childAnalyticsDisabled: () => disabled,
    childTelemetryOptOutIgnored: () => (disabled === false ? requested : null),
  }
}

describe('D1.277 · the child\'s telemetry verdict reaches the user only on a disagreement', () => {
  test('POSITIVE — the operator asked for no telemetry and the child says it is still on', () => {
    setEnv({ DISABLE_TELEMETRY: '0' })
    const { lines, announce } = rig(claudeChild(false, 'DISABLE_TELEMETRY'))

    announce()

    expect(lines).toHaveLength(1)
    // The localised clause, inside the localised frame — not the English
    // sentence the agent used to queue.
    expect(lines[0]).toContain('DISABLE_TELEMETRY')
    expect(lines[0]).toContain('Settings:')

    // Once per session per direction: the same disagreement twice is one fact.
    announce()
    expect(lines).toHaveLength(1)
  })

  test('POSITIVE — the reverse: this machine exports and the child reports its analytics off', () => {
    setEnv({ NESSY_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' })
    const { lines, announce } = rig(claudeChild(true, null))

    announce()

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('Settings:')
  })

  test('NEGATIVE — every silence the posture promises', () => {
    // Analytics ON with nothing asked: the runtime's documented default.
    setEnv({})
    expect(rigLines(claudeChild(false, null))).toEqual([])

    // Analytics OFF with no exporter on this machine: nothing to be silent in.
    setEnv({})
    expect(rigLines(claudeChild(true, null))).toEqual([])

    // Analytics OFF while this machine ALSO opted out: agreement, not a finding.
    setEnv({ DISABLE_TELEMETRY: '1', NESSY_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' })
    expect(rigLines(claudeChild(true, null))).toEqual([])

    // No `system/init` yet: `null` is an answer, and it must not read as `false`.
    setEnv({ DISABLE_TELEMETRY: '1' })
    expect(rigLines(claudeChild(null, 'DISABLE_TELEMETRY'))).toEqual([])

    // A runtime that publishes no such verdict at all — codex and Pi sessions.
    setEnv({ DISABLE_TELEMETRY: '1' })
    expect(rigLines({})).toEqual([])
    expect(rigLines(undefined)).toEqual([])
  })
})

/** One announce, one answer — the negative cases read nothing else. */
function rigLines(agent: Record<string, unknown> | undefined): string[] {
  const { lines, announce } = rig(agent)
  announce()
  return lines
}
