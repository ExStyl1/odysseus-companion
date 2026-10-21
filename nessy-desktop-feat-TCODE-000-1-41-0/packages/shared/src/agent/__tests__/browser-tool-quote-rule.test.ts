/**
 * UB4.20 (B5-06, B5-10 quoting; upstream v0.15.1 `browser-tool-runtime.ts`,
 * landed in the SHARED parser browser-tool-command-parse.ts per the row's
 * ADAPT) — the browser_tool quote rule.
 *
 * At HEAD a toggle-quote tokenizer threw on any unbalanced quote, so
 * `fill @e5 Don't do this` failed outright; the docs promised `\;` for a
 * literal semicolon but `decodeEscapes` kept the backslash; and the executor
 * ran the RAW string when the split found one command while the classifier
 * classified the SPLIT one. The rule now lives in the shared parser (the
 * gate/executor desync its header warns about), mid-token quotes are literal,
 * and the executor runs the split command.
 *
 * The negative arm is the security point: the classifier must still refuse a
 * read-only verb hiding a mutation after the `;`, and an unclosed token-start
 * quote must throw in BOTH the classifier's and the executor's parse.
 */
import { describe, expect, it } from 'bun:test'
import { splitBatchCommands, tokenizeCommand } from '../browser-tool-command-parse'
import { isReadOnlyBrowserToolInput } from '../browser-tool-names'
import { executeBrowserToolCommand } from '../browser-tool-runtime'
import type { BrowserPaneFns } from '../browser-tools'

const UNCLOSED = 'Parse error: unclosed quote in browser_tool command.'

describe('UB4.20 · the shared quote rule', () => {
  it('THE ROW: a plain-text apostrophe stays literal and fill receives the joined text', async () => {
    expect(tokenizeCommand("fill @e5 Don't do this")).toEqual(['fill', '@e5', "Don't", 'do', 'this'])
    expect(splitBatchCommands("fill @e5 Don't do this")).toEqual(["fill @e5 Don't do this"])

    const seen: Array<[string, string]> = []
    const fns = {
      fill: async (ref: string, value: string) => {
        seen.push([ref, value])
        return {}
      },
      detectChallenge: async () => ({ detected: false }),
      snapshot: async () => ({ url: 'https://x', title: 'x', nodes: [] }),
    } as unknown as BrowserPaneFns
    await executeBrowserToolCommand({ command: "fill @e5 Don't do this", fns, sessionId: 's' })
    expect(seen).toEqual([['@e5', "Don't do this"]])
  })

  it('a token-start quote strips and a mid-token quote pair protects the semicolon', () => {
    expect(tokenizeCommand('fill @e5 "Hello world"')).toEqual(['fill', '@e5', 'Hello world'])
    expect(splitBatchCommands("screenshot-region --selector div[data-x='a;b'] --padding 8"))
      .toEqual(["screenshot-region --selector div[data-x='a;b'] --padding 8"])
    expect(tokenizeCommand("screenshot-region --selector div[data-x='a;b']"))
      .toEqual(['screenshot-region', '--selector', "div[data-x='a;b']"])
  })

  it('the docs promise holds: \\; decodes to a literal semicolon, \\\\ to a backslash', () => {
    expect(tokenizeCommand('fill @e5 a\\;b')).toEqual(['fill', '@e5', 'a;b'])
    expect(tokenizeCommand('fill @e5 c\\\\d')).toEqual(['fill', '@e5', 'c\\d'])
    expect(splitBatchCommands('fill @e1 "a;b"; click @e2')).toEqual(['fill @e1 "a;b"', 'click @e2'])
    // The executor's real path: split first, then tokenize the split command —
    // so the separator never reaches the tokenizer and the value is clean.
    expect(tokenizeCommand(splitBatchCommands('fill @e1 "a;b"; click @e2')[0]!))
      .toEqual(['fill', '@e1', 'a;b'])
  })

  it('CONTROL (the bypass): snapshot; click @e1 splits and classifies NOT read-only', () => {
    expect(splitBatchCommands('snapshot; click @e1')).toEqual(['snapshot', 'click @e1'])
    expect(isReadOnlyBrowserToolInput({ command: 'snapshot; click @e1' })).toBe(false)
  })

  it('CONTROL: an unclosed token-start quote throws the same error in parser, classifier path and executor', async () => {
    const bad = 'fill @e5 "never closed'
    expect(() => splitBatchCommands(bad)).toThrow(UNCLOSED)
    expect(() => tokenizeCommand(bad)).toThrow(UNCLOSED)
    expect(isReadOnlyBrowserToolInput({ command: bad })).toBe(true) // parse refuse: nothing can run

    const fns = {
      fill: async () => {
        throw new Error('fill must never be reached')
      },
      snapshot: async () => ({ url: 'https://x', title: 'x', nodes: [] }),
    } as unknown as BrowserPaneFns
    try {
      await executeBrowserToolCommand({ command: bad, fns, sessionId: 's' })
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).toContain(UNCLOSED)
    }
  })

  it('the executor runs the SPLIT single command, so a stray separator never reaches the tokenizer', async () => {
    const seen: string[] = []
    const fns = {
      click: async () => {
        seen.push('click')
        return {}
      },
      detectChallenge: async () => ({ detected: false }),
      snapshot: async () => ({ url: 'https://x', title: 'x', nodes: [] }),
    } as unknown as BrowserPaneFns
    await executeBrowserToolCommand({ command: 'click @e1;', fns, sessionId: 's' })
    expect(seen).toEqual(['click'])
  })

  it('an empty split is refused as Missing command', async () => {
    const fns = {} as unknown as BrowserPaneFns
    for (const input of [';', ' ; ']) {
      try {
        await executeBrowserToolCommand({ command: input, fns, sessionId: 's' })
        expect.unreachable()
      } catch (error) {
        expect((error as Error).message).toContain('Missing command')
      }
    }
  })
})
