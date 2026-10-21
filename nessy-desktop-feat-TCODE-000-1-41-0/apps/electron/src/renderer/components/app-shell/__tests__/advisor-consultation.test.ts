import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  describeAdvisorConsultation,
  isAdvisorCardActivity,
  isAdvisorConsultActivity,
  type AdvisorMomentId,
} from '../advisor-consultation'

/**
 * P4.5 · asserted on VALUES, for the reason `intermediate-row.ts`'s own tests
 * give: the card is rendered from `ChatDisplay`, which cannot be loaded in a
 * shared bun test process, and a source-text assertion cannot tell a painted
 * value from a dropped one.
 */

const REPO_ROOT = join(import.meta.dir, '../../../../../../..')
const BASE_AGENT = join(REPO_ROOT, 'packages/shared/src/agent/base-agent.ts')

function activity(over: Record<string, unknown> = {}) {
  return {
    toolName: 'advisor_consult',
    status: 'completed',
    content: 'Advisor (claude-sonnet-4-5):\n\nPut the retry in the transport.',
    toolInput: { moment: 'approach', question: 'Where does the retry belong?' },
    ...over,
  }
}

describe('advisor consultation · the producer contract', () => {
  /**
   * THE ONE ASSUMPTION THIS MODULE MAKES, pinned where it is made.
   *
   * `BaseAgent.executeAdvisorConsult` composes guidance as
   * `Advisor (${outcome.modelId}):\n\n${outcome.text}` and is deliberately
   * un-i18n'd English because a MODEL reads it. That template is the only way
   * the model name and the advice can be told apart in the tool result, so a
   * silent change to it would leave the card matching nothing.
   *
   * The failure mode this guards is not a crash — `describeAdvisorConsultation`
   * returns `null` and the ordinary row paints, which is safe. It is that the
   * feature would quietly stop working with every gate green. Reading the
   * producer's own source is the strongest instrument available from here:
   * importing `base-agent.ts` into a renderer test pulls the whole agent tree.
   */
  it('still matches the literal base-agent.ts composes', () => {
    const source = readFileSync(BASE_AGENT, 'utf8')
    // The positive control for the read itself: a sentence from the same
    // method. If this fails, the file moved and the assertion below is vacuous.
    expect(source).toContain('protected async executeAdvisorConsult(')
    expect(source).toContain('return `Advisor (${outcome.modelId}):\\n\\n${outcome.text}`;')
  })
})

describe('describeAdvisorConsultation', () => {
  it('reads the model name and the guidance out of a completed reply', () => {
    const result = describeAdvisorConsultation(activity())
    expect(result).not.toBeNull()
    expect(result!.modelId).toBe('claude-sonnet-4-5')
    expect(result!.guidance).toBe('Put the retry in the transport.')
  })

  it('keeps the moment and the question when the model named them', () => {
    const result = describeAdvisorConsultation(activity())
    expect(result!.moment).toBe('approach')
    expect(result!.question).toBe('Where does the retry belong?')
  })

  it.each<AdvisorMomentId>([
    'approach',
    'recurring-error',
    'before-done',
  ])('accepts the documented moment %s', (moment) => {
    const result = describeAdvisorConsultation(activity({ toolInput: { moment, question: 'q' } }))
    expect(result!.moment).toBe(moment)
  })

  it('drops an unrecognised moment but keeps the guidance', () => {
    const result = describeAdvisorConsultation(
      activity({ toolInput: { moment: 'whenever', question: 'q' } })
    )
    expect(result!.moment).toBeUndefined()
    expect(result!.guidance).toBe('Put the retry in the transport.')
  })

  it('keeps a multi-paragraph answer whole rather than to its first line', () => {
    const result = describeAdvisorConsultation(
      activity({ content: 'Advisor (m):\n\nFirst point.\n\nSecond point.\n\nThird.' })
    )
    expect(result!.guidance).toBe('First point.\n\nSecond point.\n\nThird.')
  })

  it('declines every refusal sentence rather than showing it as advice', () => {
    for (const content of [
      'The advisor is turned off for this session. Continue on your own — do not consult again this turn.',
      'No advisor model is available for this session. Continue on your own.',
      'The configured advisor model is not available on this connection, so the advisor is unavailable. Continue on your own.',
      'The configured advisor model is not permitted by the managed model allowlist, so the advisor is unavailable. Continue on your own.',
      "The configured advisor model is not as capable as this session's model, so the advisor is unavailable. Continue on your own.",
      'The advisor could not answer (timeout). Continue on your own.',
    ]) {
      expect(describeAdvisorConsultation(activity({ content }))).toBeNull()
    }
  })

  it('declines a consult that has not finished', () => {
    expect(describeAdvisorConsultation(activity({ status: 'running', content: undefined }))).toBeNull()
    expect(describeAdvisorConsultation(activity({ status: 'error' }))).toBeNull()
  })

  it('declines a reply whose guidance body is empty', () => {
    expect(describeAdvisorConsultation(activity({ content: 'Advisor (m):\n\n   ' }))).toBeNull()
  })

  it('declines a different tool', () => {
    expect(describeAdvisorConsultation(activity({ toolName: 'Read' }))).toBeNull()
  })
})

describe('routing', () => {
  /**
   * The distinction P3.24 paid for in this slot. `isAdvisorConsultActivity` is
   * the NAME; `isAdvisorCardActivity` is the full decision, and only the second
   * may drive `renderActivityCard` — a card returned for a row it renders
   * `null` for removes that row from the transcript, because an element is
   * never nullish and `TurnCard`'s `?? <ActivityRow>` cannot fire.
   */
  it('routes only rows the card will actually draw', () => {
    const refused = activity({ content: 'No advisor model is available for this session. Continue on your own.' })
    expect(isAdvisorConsultActivity(refused)).toBe(true)
    expect(isAdvisorCardActivity(refused)).toBe(false)

    const running = activity({ status: 'running', content: undefined })
    expect(isAdvisorConsultActivity(running)).toBe(true)
    expect(isAdvisorCardActivity(running)).toBe(false)

    expect(isAdvisorCardActivity(activity())).toBe(true)
  })

  it('matches the tool name case-insensitively and nothing else', () => {
    expect(isAdvisorConsultActivity({ toolName: 'ADVISOR_CONSULT' })).toBe(true)
    expect(isAdvisorConsultActivity({ toolName: 'advisor' })).toBe(false)
    expect(isAdvisorConsultActivity({})).toBe(false)
  })
})
