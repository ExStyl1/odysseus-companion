/**
 * C3.259 — `[claude-code:unrecognized_model]`, which every gateway spawn writes
 * and which nothing in this tree mentioned.
 *
 * The row's three options were silence it, map it, or record it. RECORD is what
 * landed; the reading that ruled out the other two — including the vendor's own
 * description of `modelOverrides`, the remedy its changelog names — is on
 * `describeClaudeUnrecognizedModelStderr` in `claude-agent.ts`.
 *
 * What this file holds it to:
 *
 *  - it fires on the line the child really writes (the payload shape recorded by
 *    W15-b's live gateway run) and on that line only;
 *  - it picks the line OUT of a multi-line chunk, because stderr arrives in
 *    chunks — the same reason its sibling `surfaceForcedDefaultModeNotice`
 *    splits rather than testing the whole chunk;
 *  - it says the line is expected AND says the id is unknown to the RUNTIME,
 *    never that the model is unavailable, which is the different and actionable
 *    fact the host reports elsewhere (P6.362);
 *  - the tag it matches is the binary's own string constant, so this suite does
 *    not depend on the payload's wording.
 */
import { describe, expect, it } from 'bun:test'

import { bracedRegion } from '../../testing/source-regions.ts'

import { describeClaudeUnrecognizedModelStderr } from '../claude-agent.ts'

/** Verbatim shape from W15-b's live gateway run, with the model id of that run. */
const LIVE_LINE = '[claude-code:unrecognized_model] {"model":"tgpt/deepseek-v4-flash-0731","query_source":"sdk"}'

describe('C3.259 — the expected-line classifier', () => {
  it('explains the line the child actually writes, carrying it verbatim', () => {
    const explained = describeClaudeUnrecognizedModelStderr(LIVE_LINE)

    expect(explained).not.toBeNull()
    expect(explained!).toContain(LIVE_LINE)
    expect(explained!).toContain('EXPECTED on this connection and not a failure')
    // The claim is about the RUNTIME's table, never about availability: the
    // id being absent from the connection's own catalogue is a separate fact
    // with its own diagnostic, and confusing the two would tell a user their
    // model is missing when the turn just succeeded on it.
    expect(explained!).toContain("built-in model table")
    expect(explained!).not.toContain('unavailable')
  })

  it('picks the line out of a chunk that carries other lines', () => {
    const chunk = ['starting session', LIVE_LINE, 'some later note'].join('\n')
    const explained = describeClaudeUnrecognizedModelStderr(chunk)

    expect(explained).not.toBeNull()
    expect(explained!).toStartWith(LIVE_LINE)
    // Only the one line is quoted; the neighbours keep reaching the raw sinks
    // the caller leaves untouched.
    expect(explained!).not.toContain('some later note')
  })

  it('answers null for every other chunk, so no other sink changes', () => {
    expect(describeClaudeUnrecognizedModelStderr('')).toBeNull()
    expect(describeClaudeUnrecognizedModelStderr('⚠ Permission mode forced to default — …')).toBeNull()
    // The NEAR MISS: the telemetry event name the same emitter sends alongside
    // the line. Matching it would make this classifier fire on a different
    // channel's string and relabel a chunk that carries no such line.
    expect(describeClaudeUnrecognizedModelStderr('tengu_api_unrecognized_model')).toBeNull()
  })

  it('does not map the id away, and says why in the sentence itself', () => {
    const explained = describeClaudeUnrecognizedModelStderr(LIVE_LINE)!

    // The decision is IN the line a reader meets, not only in a docblock they
    // would have to go and find: the override map is keyed by an Anthropic id,
    // so using it changes what the runtime believes the model is.
    expect(explained).toContain('keyed by an Anthropic model id')
    expect(explained).toContain('context window, capabilities and price')
  })
})

describe('C3.259 — the call site keeps every sink it had', () => {
  const source = Bun.file(new URL('../claude-agent.ts', import.meta.url)).name!

  it('the raw chunk still reaches debug and console before anything is explained', async () => {
    const text = await Bun.file(source).text()
    const start = text.indexOf('stderr: (data: string) => {')

    expect(start).toBeGreaterThan(-1)
    // D1.111 — the callback's own body: the anchor ENDS in `{`, so the region is
    // the arrow function exactly and the ordering claim below is bounded by the
    // thing it was always about.
    const callback = bracedRegion(text, start)
    // BOUNDARY CONTROL: the next option below the callback. Both `indexOf`s in
    // the claim answer -1 on a region that lost its text, and `-1 < -1` is
    // false, so this negative is what keeps a runaway visible.
    expect(callback).not.toContain('Thinking config is provider-aware')
    // Order matters: the unconditional sinks come first, so the explanation can
    // only ever be additive. A refactor that moved the raw log inside the
    // branch would make the line invisible whenever the branch is latched.
    expect(callback.indexOf("console.error('[SDK stderr]', data)"))
      .toBeLessThan(callback.indexOf('describeClaudeUnrecognizedModelStderr'))
  })
})
