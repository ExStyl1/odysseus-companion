import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { CODEX_UNREAD_NOTIFICATION_METHODS } from '../codex-notification-families.ts'

/**
 * The control frame, as the WIRE spells it. Written as a literal rather than
 * imported from `@nessy-agent/codex-agent-server`'s `CODEX_CONFIG_WARNING_METHOD`
 * (`config-warning.ts:62`) because that module is not on this package's exports
 * map — and because the wire string, not the JS constant, is what a codex bump
 * can actually move.
 */
const CODEX_CONFIG_WARNING_METHOD = 'configWarning'

/**
 * P6.228 — does an asynchronous safety-monitoring pause reach an app-server
 * embedder at all?
 *
 * ## The row expected an absence. There isn't one.
 *
 * Denominator A72 scored codex `unknown` on the clause *"whether it reaches an
 * app-server embedder at all is unmeasured"*, and named the row's product as
 * *"one honest line saying no runtime can pause on async monitoring"*. Measured
 * against the generated bindings — which ARE the app-server's published wire
 * contract, ts-rs output from the codex source the shipped binary is built
 * from — codex publishes THREE such notifications, and one of them carries
 * exactly the *"pause plus findings"* shape the row's own native-mechanism
 * clause describes:
 *
 * ```ts
 * ModelSafetyBufferingUpdatedNotification = {
 *   threadId, turnId, model, useCases: string[], reasons: string[],
 *   showBufferingUi: boolean, fasterModel: string | null }
 * ```
 *
 * `showBufferingUi` IS the pause; `reasons` and `useCases` ARE the findings.
 *
 * So the finding is not an absence in the runtime. It is that **the host drops
 * all three**: they sit in {@link CODEX_UNREAD_NOTIFICATION_METHODS} under the
 * heading "Moderation and model-safety telemetry", which reads as inert
 * telemetry and is not what `showBufferingUi` is.
 *
 * The other two runtimes, measured on the same rig:
 *  - **claude** — the shipped binary has a `monitoring-notice` startup notice
 *    (6 occurrences; `{ id:"monitoring-notice", tier:"warning", type:"info" }`
 *    rendering a text plus an optional "learn more" URL) and NO pause:
 *    `safetyBuffering` → 0, `moderation` → 0, fabricated control → 0. It is
 *    also an Ink TUI notice, so an SDK embedder cannot receive it either way.
 *  - **pi** — Guardian is a pre-turn/pre-action check, not an async pause; the
 *    row's own evidence, unchanged at HEAD.
 *
 * ## What this test pins, and what it cannot
 *
 * It pins the WIRE CONTRACT and the host's own reader set against each other,
 * so the day codex removes a frame, adds a fourth, or the day someone starts
 * reading one, this goes red and the A72 verdict gets re-decided rather than
 * inherited. It CANNOT tell you whether the binary ever emits one on a real
 * account — that needs a live session and is W7-p's kind of evidence, not a
 * unit test's. Stated rather than papered over.
 */
const SERVER_NOTIFICATION_UNION = fileURLToPath(new URL(
  '../../../../codex-protocol/generated/ServerNotification.ts',
  import.meta.url,
))

/** Every `"method": "…"` the generated `ServerNotification` union publishes. */
function publishedNotificationMethods(): string[] {
  const source = readFileSync(SERVER_NOTIFICATION_UNION, 'utf8')
  const body = /export type ServerNotification =(.*);/s.exec(source)?.[1]
  expect(body, 'the generated union moved or was reshaped').toBeTruthy()
  return [...(body ?? '').matchAll(/"method":\s*"([^"]+)"/g)].map(match => match[1]!)
}

const MONITORING_METHODS = [
  'model/safetyBuffering/updated',
  'turn/moderationMetadata',
  'model/verification',
] as const

describe('P6.228 — the codex async safety-monitoring frames', () => {
  it('DO reach an app-server embedder — the row\'s premise of an absence is refuted', () => {
    const published = publishedNotificationMethods()
    // The positive control on the same instrument: a frame this host provably
    // consumes must be in the same list, or the reader is broken rather than
    // the subject absent.
    expect(published).toContain(CODEX_CONFIG_WARNING_METHOD)
    expect(published).toContain('guardianWarning')
    // A fabricated method, so a regex that matched everything would fail here.
    expect(published).not.toContain('model/thisIsNotARealMethod')

    for (const method of MONITORING_METHODS) {
      expect(published, `${method} left the published wire contract`).toContain(method)
    }
  })

  it('carries the PAUSE and its FINDINGS, not just a label', () => {
    // Without these three fields the frame would be a notice, and the row's
    // question ("pause … see the findings … and resume") would still be open.
    const source = readFileSync(fileURLToPath(new URL(
      '../../../../codex-protocol/generated/v2/ModelSafetyBufferingUpdatedNotification.ts',
      import.meta.url,
    )), 'utf8')
    expect(source).toContain('showBufferingUi: boolean')
    expect(source).toContain('reasons: Array<string>')
    expect(source).toContain('useCases: Array<string>')
  })

  it('and the host reads NONE of them — this is where the gap actually is', () => {
    const unread = new Set<string>(CODEX_UNREAD_NOTIFICATION_METHODS)
    for (const method of MONITORING_METHODS) {
      expect(unread.has(method), `${method} acquired a reader — re-decide A72`).toBe(true)
    }
    // Control: the frames we DO consume are not in the unread set, so the
    // assertion above distinguishes "unread" from "everything is unread".
    expect(unread.has(CODEX_CONFIG_WARNING_METHOD)).toBe(false)
    expect(unread.has('guardianWarning')).toBe(false)
  })
})
