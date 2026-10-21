/**
 * F1.1007 — AGENT-INSTALL's `loaded-not-callable` verdict follows the Pi bundle
 * that answered the load.
 *
 * Since F1.803 (`722c67605`) a tool loaded with `mcp__tool_load` is callable
 * from the next step of the same request. A model that still says "callable on
 * your next message" in the request that asked for the CALL is then the product
 * regressing, and the case FAILS. On a bundle older than F1.803 the same words
 * describe the old contract, and the case stays BLOCKED. The bundle is read off
 * its own load answer, so the verdict reason says which bundle answered.
 *
 * Kept apart from `harness.test.ts`'s F1.145 block (which still pins the kinds)
 * only because that file was held by another lane when this row landed.
 *
 * F1.1020 adds F1.1007's two leftovers: PLUGIN-INSTALL-RUNTIMES keeps that
 * verdict instead of rebuilding every reach miss as BLOCKED, and RS-103's load
 * prompt restricts the turn positively, naming no tool it forbids.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { classifyInstallMiss, LOAD_ANSWER_F1_803, piLoadContract } from './cases/agent-install.ts'
import { classifyReachMiss, reachNames } from './cases/plugin-install-runtimes.ts'
import { loadSessionToolPrompt } from './cases/rs-103.ts'
import type { TranscriptMessage } from './lib/state.ts'

const row = (partial: Partial<TranscriptMessage>): TranscriptMessage => ({
  id: `m-${Math.random().toString(36).slice(2, 8)}`, role: 'tool', content: '', timestamp: 0, ...partial,
})
const said = (content: string): TranscriptMessage => row({ role: 'assistant', content })
const NAMES = 'mcp__session__plugin_plan_install, mcp__session__plugin_install'
const load = (answer: string): TranscriptMessage =>
  row({ toolName: 'mcp__tool_load', toolStatus: 'completed', toolResult: `${answer}: ${NAMES}` })

/** The three load answers the Pi bundle has shipped, newest first (`deferred-mcp-tools.ts`'s history). */
const F1_803 = 'Tools loaded and callable from your next step (not in the same batch of tool calls as this load)'
const V1_31 = 'MCP tools loaded and available from the user\'s next message (not callable in this request)'
const V_JULY = 'MCP tools available on the next model turn of this request'
const WORDS = 'They only become callable on your **next** message, so I cannot run them in this turn.'

describe('AGENT-INSTALL: a loaded tool left uncallable FAILS on a Pi bundle that carries F1.803 (F1.1007)', () => {
  it('THE FINDING: the F1.803 load answer plus the deferral words in the CALL request is a FAIL that says so', () => {
    const miss = classifyInstallMiss([said(WORDS)], [load(F1_803)])
    expect(miss.kind).toBe('loaded-not-callable')
    expect(miss.verdict).toBe('fail')
    expect(miss.reason).toContain('FAIL')
    expect(miss.reason).toContain('carries F1.803')
    // The model's own words stay in the sentence, emphasis stripped.
    expect(miss.reason).toContain('They only become callable on your next message')
  })

  it('THE BOUNDARY: the same words on an older bundle, or on an unread one, stay BLOCKED and say which', () => {
    for (const answer of [V1_31, V_JULY]) {
      const miss = classifyInstallMiss([said(WORDS)], [load(answer)])
      expect(miss.kind).toBe('loaded-not-callable')
      expect(miss.verdict).toBe('blocked')
      expect(miss.reason).toContain('BLOCKED')
      expect(miss.reason).toContain('predates F1.803')
    }
    // No load row at all (a claude-gateway turn loads nothing), and a wording no
    // bundle ever shipped: the bundle is unread, and an unread bundle never FAILS.
    for (const loads of [[], [load('Loaded, somehow')]]) {
      const miss = classifyInstallMiss([said(WORDS)], loads)
      expect(miss.kind).toBe('loaded-not-callable')
      expect(miss.verdict).toBe('blocked')
      expect(miss.reason).toContain('is unread')
    }
    // The bundle reading never decides the KIND: with the words taken away the
    // F1.803 rows are a decline, still BLOCKED.
    const silent = classifyInstallMiss([said('OK.')], [load(F1_803)])
    expect(silent.kind).toBe('declined')
    expect(silent.verdict).toBe('blocked')
  })

  it('reads the bundle off the Pi loader\'s rows only, and knows the wording the product ships TODAY', () => {
    expect(piLoadContract([load(F1_803)])).toBe('carries-F1.803')
    expect(piLoadContract([load(V1_31)])).toBe('predates-F1.803')
    // A non-loader row carrying the same text is not the loader's answer.
    expect(piLoadContract([row({ toolName: 'mcp__tool_search', toolResult: F1_803 })])).toBe('unknown')
    // The successor pin: when the loader is reworded again, this goes red and
    // names what to update, instead of the FAIL arm reading `unknown` forever.
    // The CALL that answers, not the phrase: the tool's description says
    // "callable from your next step" too.
    const loader = readFileSync(join(import.meta.dir, '..', '..', 'packages', 'pi-agent-server', 'src', 'deferred-mcp-tools.ts'), 'utf8')
    expect(loader, 'deferred-mcp-tools.ts reworded its load answer: update LOAD_ANSWER_F1_803 in agent-install.ts')
      .toContain(`return textResult(\`${LOAD_ANSWER_F1_803} `)
    // This file's verbatim answer is the product's, so the rows above are too.
    expect(loader).toContain(`textResult(\`${F1_803}: `)
  })

  it('the not-installed branch FAILS on that verdict before it blocks', () => {
    const text = readFileSync(join(import.meta.dir, 'cases', 'agent-install.ts'), 'utf8')
    const start = text.indexOf('if (!installed.includes(FIXTURE.pluginEchoId)) {')
    const end = text.indexOf('blocked(`the plugin was not installed')
    // Anti-vacuum: both anchors exist, in order.
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    expect(text.slice(start, end)).toContain(", miss.verdict !== 'fail', miss.reason)")
  })
})

describe('F1.1007 leftovers: the reach keeps the verdict, and the RS-103 load prompt forbids no named tool (F1.1020)', () => {
  const { hostRow } = reachNames('claude')

  it('THE FINDING: PLUGIN-INSTALL-RUNTIMES keeps a loaded-not-callable FAIL, so verdict and reason agree', () => {
    const miss = classifyReachMiss([load(F1_803), said(WORDS)], hostRow)
    expect(miss.kind).toBe('loaded-not-callable')
    expect(miss.verdict).toBe('fail')
    expect(miss.reason).toContain('FAIL: ')
  })

  it('THE BOUNDARY: an older or unread bundle still BLOCKS the reach, and says so', () => {
    for (const loads of [[load(V1_31)], [load(V_JULY)], []]) {
      const miss = classifyReachMiss([...loads, said(WORDS)], hostRow)
      expect(miss.kind).toBe('loaded-not-callable')
      expect(miss.verdict).toBe('blocked')
      expect(miss.reason).toContain('BLOCKED: ')
      expect(miss.reason).not.toContain('FAIL: ')
    }
  })

  it('RS-103 loads a session tool with a POSITIVE restriction: it names the tool and forbids none', () => {
    const prompt = loadSessionToolPrompt('automation_create')
    expect(prompt).toContain('automation_create')
    expect(prompt).toContain('use only')
    // The composer swallows a newline, so every prompt here is ONE line.
    expect(prompt).not.toContain('\n')
    // The Guardian shape (MCP-W2's header, AGENTS.md): a named tool plus a ban on calling it.
    expect(prompt).not.toMatch(/\b(do not|don['’]t|never|not) (yet )?(call|use|run|invoke)\b/i)
  })
})
