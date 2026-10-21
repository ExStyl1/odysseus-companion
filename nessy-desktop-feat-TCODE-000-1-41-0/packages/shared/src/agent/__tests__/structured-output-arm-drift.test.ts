/**
 * P3.23 — where structured output is validated, per runtime arm, pinned.
 *
 * THE ROW ASKED FOR A DECISION between two shapes: one host-side validation
 * point at the `SessionManager` seam, or per-arm validation recorded as the
 * contract and pinned by a drift test that enumerates the arms. This file is
 * the second, and the reason is the 2026-08-28 native-first ruling rather than
 * a preference: **claude's arm already has a validator, and it is the runtime's
 * own.** `code.claude.com/docs/en/agent-sdk/structured-outputs.md` specifies
 * that the SDK validates the model's output against the supplied schema and
 * re-prompts on a violation, with `MAX_STRUCTURED_OUTPUT_RETRIES` (default 5)
 * as the budget — and that knob reaches our SDK subprocess by env inheritance
 * (`claude-agent.ts`, `buildClaudeStructuredOutputOptions`). Rule (1) of
 * native-first is "enable and configure what the runtime already has", so
 * re-validating the SDK's own validated result in the host would be building
 * beside a mechanism rather than instead of one.
 *
 * WHAT THE RULE'S SECOND HALF THEN OBLIGES, and this file is it: three runtimes
 * each doing it their own way IS the switch-safety problem, so the host must
 * make the residual difference **uniform or honest**. It cannot be uniform here
 * — Pi's validation drives an in-session reprompt loop that only works inside
 * the subprocess owning the session — so it is made honest, by naming the three
 * arms and the exact seam each validates at, in a place that goes red when one
 * of them moves.
 *
 * THE MEASUREMENT THIS PINS (2026-09-03), which is not what the row assumed.
 * The row's worry was "an arm that forgets to validate". Measured, the arm that
 * does not validate IN OUR CODE is claude, and that is by delegation rather
 * than by omission — but the delegation was nowhere stated, and one thing said
 * the opposite: `SessionManager`'s own field comment calls the parked value
 * "the turn's VALIDATED structured output" for all three arms, which is true of
 * codex and Pi by our code and true of claude only if the SDK is doing what its
 * page says. An unstated delegation is indistinguishable from a defect, which
 * is the shape this plan exists to remove.
 *
 * WHY A SOURCE PROBE AND NOT A BEHAVIOURAL ONE. The claude arm's validation
 * happens inside a closed SDK subprocess; there is no in-process seam that can
 * be handed a bad payload and observed. So the arms are read from source, and
 * every absence claim carries a positive control on the same rig: the same
 * probe, on the same call spellings, finds the codex and Pi call sites. A probe
 * that matched nothing would report "claude does not validate" about a repo
 * where nobody does.
 *
 * IF THIS GOES RED. A new call site in `claude-agent.ts` or the claude event
 * adapter means the delegation ended — update the table and say why we stopped
 * trusting the SDK. A LOST call site in codex or Pi is the row's original fear
 * arriving, and it is a defect. A call site appearing in `SessionManager.ts`
 * means someone built the host backstop; that is a posture change, not a tidy,
 * and the two paragraphs above are what it has to argue with.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..', '..', '..', '..', '..')

const read = (relative: string): string => readFileSync(resolve(REPO, relative), 'utf-8')

/** Count, not boolean: a call site that multiplies is as much a drift as one that vanishes. */
const calls = (source: string, spelling: string): number =>
  source.split(spelling).length - 1

const VALIDATE = 'validateStructuredOutputText('
const COMPILE = 'compileStructuredOutputSchema('

/**
 * The three arms and the two host files, with the seam each one validates at.
 * `validate`/`compile` are the measured counts on 2026-09-03; the note is the
 * reason, and it is the half a future reader needs.
 */
const ARMS = [
  {
    file: 'packages/shared/src/agent/codex-agent.ts',
    validate: 1,
    compile: 1,
    note: 'host-side, in `withStructuredOutput`; a violation ends the turn as `error_max_structured_output_retries` with no retry',
  },
  {
    file: 'packages/pi-agent-server/src/index.ts',
    validate: 1,
    compile: 1,
    note: 'in the Pi subprocess, with a real validate-and-reprompt loop bounded by `resolveMaxStructuredOutputRetries()`',
  },
  {
    file: 'packages/shared/src/agent/claude-agent.ts',
    validate: 0,
    compile: 0,
    note: 'DELEGATED to the Agent SDK by the documented contract — see this file\'s header; we neither compile the schema nor re-check the result',
  },
  {
    file: 'packages/shared/src/agent/backend/claude/event-adapter.ts',
    validate: 0,
    compile: 0,
    note: 'reads `structured_output` and the error subtype off the SDK result and forwards them; no check of its own',
  },
  {
    file: 'packages/server-core/src/sessions/SessionManager.ts',
    validate: 0,
    compile: 0,
    note: 'a conduit in both directions — forwards `outputSchema` outbound and parks the result inbound. There is no host backstop, and that is the decision above rather than an oversight',
  },
] as const

describe('P3.23 · structured-output validation, per arm', () => {
  for (const arm of ARMS) {
    it(`${arm.file} — ${arm.validate} validate / ${arm.compile} compile (${arm.note})`, () => {
      const source = read(arm.file)
      expect({ validate: calls(source, VALIDATE), compile: calls(source, COMPILE) })
        .toEqual({ validate: arm.validate, compile: arm.compile })
    })
  }

  /**
   * The positive control the two zero rows need. Without it, a renamed export
   * would make every `0` above true and the file would report "claude does not
   * validate" about a tree where nothing does.
   */
  it('positive control — the probe finds the spellings it is looking for', () => {
    const found = ARMS.map(arm => calls(read(arm.file), VALIDATE)).reduce((sum, n) => sum + n, 0)
    expect(found).toBeGreaterThan(0)
    // And the module those call sites resolve to still exports both names, so a
    // rename cannot leave this file green against a validator that is gone.
    const index = read('packages/shared/src/structured-output/index.ts')
    expect(index).toContain('validateStructuredOutputText')
    expect(index).toContain('compileStructuredOutputSchema')
  })

  /**
   * The claim that makes the delegation legible rather than assumed: the claude
   * arm passes the caller's schema to the SDK as its documented `outputFormat`,
   * so "we do not validate" is "the SDK was asked to", not "nobody was".
   */
  it('the claude arm hands the schema to the SDK it delegates to', () => {
    const source = read('packages/shared/src/agent/claude-agent.ts')
    expect(source).toContain('json_schema')
    expect(source).toContain('agent-sdk/structured-outputs.md')
  })
})
