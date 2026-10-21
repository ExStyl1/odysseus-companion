/**
 * P2.504 · the markdown export is English in every locale, BY DECISION.
 *
 * The owner decided this on 2026-09-02 ("exports are always English, stated at
 * the site"), and the row exists because the alternative — *follow the UI
 * language* — is equally defensible, so a silent choice would have been made by
 * whoever wrote the first `import { useTranslation }` into `turn-utils.ts`.
 *
 * The test guards BOTH halves, because either alone is passable:
 *
 *  - the OUTPUT is English (a behavioural read of the real function, not a
 *    source grep), which catches someone wiring `t()` in; and
 *  - the module still carries the statement and still imports no i18n, which
 *    catches the opposite mistake — a future literals audit "fixing" these two
 *    headings without knowing they were argued about. `lint:i18n:parity` and
 *    `lint:i18n:sorted` are both green on a bare literal with no key, so
 *    neither gate can see this decision; this file is the only thing that can.
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { Message } from '@nessy-agent/core'
import { groupMessagesByTurn, formatActivityAsMarkdown, formatTurnAsMarkdown } from '../turn-utils'
import type { AssistantTurn } from '../turn-utils'

const TURN_UTILS = new URL('../turn-utils.ts', import.meta.url)
const source = readFileSync(TURN_UTILS, 'utf8')

let seq = 0

function assistantText(overrides: Partial<Message> = {}): Message {
  seq += 1
  return {
    id: `msg-${seq}`,
    role: 'assistant',
    content: 'body',
    timestamp: 1_000 + seq,
    turnId: 'turn-1',
    ...overrides,
  } as Message
}

function firstAssistantTurn(messages: Message[]): AssistantTurn {
  const turn = groupMessagesByTurn(messages).find(item => item.type === 'assistant')
  if (!turn || turn.type !== 'assistant') throw new Error('no assistant turn in fixture')
  return turn
}

function exportedTurn(): AssistantTurn {
  return firstAssistantTurn([
    assistantText({ content: 'why I did that', isIntermediate: true, isThinking: true } as Partial<Message>),
    assistantText({ content: 'ordinary aside', isIntermediate: true } as Partial<Message>),
    assistantText({ content: 'final answer', isIntermediate: false } as Partial<Message>),
  ])
}

describe('P2.504 · the markdown export stays English in every locale', () => {
  it('reads the module it is asserting about', () => {
    // The positive control. Every `not.toContain` below passes vacuously the
    // moment this URL stops resolving.
    expect(source).toContain('export function formatTurnAsMarkdown(')
    expect(source).toContain('export function formatActivityAsMarkdown(')
  })

  it('emits the two activity headings in English', () => {
    const turn = exportedTurn()
    const thinking = turn.activities.find(a => a.type === 'thinking')
    const commentary = turn.activities.find(a => a.type === 'intermediate')
    expect(thinking).toBeDefined()
    expect(commentary).toBeDefined()

    expect(formatActivityAsMarkdown(thinking!)).toContain('# Reasoning')
    expect(formatActivityAsMarkdown(commentary!)).toContain('# Commentary')
  })

  it('emits the whole-turn document in English', () => {
    const markdown = formatTurnAsMarkdown(exportedTurn())
    for (const heading of ['## Activities', '## Response', '🧠 Reasoning', '💭 Commentary']) {
      expect(markdown).toContain(heading)
    }
  })

  it('states the decision at the site, so an audit finds the answer and not just the literal', () => {
    // The mechanism-free half of the row: the decision has to be READABLE where
    // the literal is, or the next lane re-derives the argument. Keyed to the
    // row id rather than to a sentence, so the prose may be rewritten.
    expect(source).toContain('P2.504')
    expect(source).toContain('exports are always English')
  })

  it('imports no i18n, which is what makes the English literal a decision rather than a bug', () => {
    // Spelled as three separate absences because each is a different way the
    // decision could be reversed without anyone noticing.
    expect(source).not.toContain('react-i18next')
    expect(source).not.toContain("from '@nessy-agent/shared/i18n'")
    expect(source).not.toMatch(/\bi18n\.t\(/)
  })
})
