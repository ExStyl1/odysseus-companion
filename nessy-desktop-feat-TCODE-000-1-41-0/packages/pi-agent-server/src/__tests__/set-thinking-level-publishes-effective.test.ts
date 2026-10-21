import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { THINKING_TO_PI } from '../../../shared/src/agent/backend/pi/constants.ts'

/**
 * C3.385 — `set_thinking_level` publishes what Pi HOLDS, never what was asked for.
 *
 * ## Why the instrument is the SOURCE and not a running session
 *
 * `handleSetThinkingLevel` is a module-private function in `src/index.ts`, whose
 * module body IS the subprocess entry point — importing it boots a server
 * (`index-import-guard.test.ts` in this same directory exists for that reason).
 * The behaviour under test is one publication inside that function, and the only
 * arm that could observe it end to end is a real-server run against a model whose
 * `reasoning` flag is unset, i.e. the slow `*-real-server.test.ts` family. So this
 * pins the WIRING off the source text, with a positive control that proves the
 * probe can still see, and the behavioural claim it rests on is read out of the
 * installed SDK below rather than asserted here.
 *
 * ## The reading the row turns on (installed Pi 0.84.3, 2026-09-13)
 *
 * `@earendil-works/pi-coding-agent` `dist/core/agent-session.js` `setThinkingLevel`:
 * `const effectiveLevel = availableLevels.includes(level) ? level :
 * this._clampThinkingLevel(level, availableLevels)`, then
 * `this.agent.state.thinkingLevel = effectiveLevel` and — only `if (isChanging)` —
 * `this.sessionManager.appendThinkingLevelChange(effectiveLevel)`.
 * `getAvailableThinkingLevels()` delegates to `@earendil-works/pi-ai`
 * `dist/models.js` `getSupportedThinkingLevels`, whose first two lines are
 * `if (!model.reasoning) return ["off"]`. A non-reasoning model therefore has
 * exactly ONE available level, every request clamps back to it, `isChanging` is
 * false, and nothing is appended to the thread — which is what R7 measured and
 * read as a missing record. The record was not missing; the change never happened.
 *
 * The defect it left behind is the publication: `initConfig.thinkingLevel` is read
 * back at spawn time by the subagent spawner (`thinkingLevel: () =>
 * normalizeThinkingLevel(initConfig?.thinkingLevel)`), so a requested level that
 * Pi clamped away was being handed to every child spawned afterwards.
 */

const INDEX_SOURCE = readFileSync(
	fileURLToPath(new URL('../index.ts', import.meta.url)),
	'utf8',
)

/** The body of `handleSetThinkingLevel`, with every `//` comment line removed. */
function handlerCodeWithoutComments(): string {
	const start = INDEX_SOURCE.indexOf('async function handleSetThinkingLevel(')
	expect(start).toBeGreaterThan(-1)
	const end = INDEX_SOURCE.indexOf('\n}\n', start)
	expect(end).toBeGreaterThan(start)
	return INDEX_SOURCE.slice(start, end)
		.split('\n')
		.filter(line => !line.trim().startsWith('//'))
		.join('\n')
}

describe('C3.385 · set_thinking_level publishes the level Pi actually holds', () => {
	it('publishes the level read BACK off the session, never the requested one', () => {
		const code = handlerCodeWithoutComments()
		expect(code).toContain('const effectivePiLevel = piSession.thinkingLevel')
		expect(code).toContain(
			'publishActiveConfig({ ...initConfig, thinkingLevel: effectiveLevel ?? initConfig.thinkingLevel })',
		)
	})

	it('NEGATIVE — no publication carries `msg.level`, the requested value', () => {
		// The defect this row is about, written as the shape rather than the
		// identifier: `msg.level` legitimately survives elsewhere in the handler
		// (the map lookup and both log lines), and the control below proves it.
		expect(handlerCodeWithoutComments()).not.toContain('thinkingLevel: msg.level')
	})

	it('CONTROL — the comment strip leaves the code, so the negative can fail', () => {
		const code = handlerCodeWithoutComments()
		// If the strip had eaten the body, the negative above would pass vacuously.
		expect(code).toContain('msg.level')
		expect(code).toContain('THINKING_TO_PI[msg.level as keyof typeof THINKING_TO_PI]')
	})

	it('BOUNDARY — a clamp Pi can reach has no name here, and the fallback covers it', () => {
		// Pi's ladder carries `minimal`; this product's `ThinkingLevel` does not, so
		// the reverse lookup the handler performs returns `undefined` for it. The
		// published value then stays at the previous one rather than becoming the
		// requested one, which is the whole point of the row.
		const piLevels = Object.values(THINKING_TO_PI)
		expect(piLevels).not.toContain('minimal')
		// Every level this product CAN name round-trips, so the lookup is total
		// over the map and partial only outside it.
		for (const [nessyLevel, piLevel] of Object.entries(THINKING_TO_PI)) {
			const found = (Object.keys(THINKING_TO_PI) as Array<keyof typeof THINKING_TO_PI>)
				.find(level => THINKING_TO_PI[level] === piLevel)
			expect(found).toBe(nessyLevel as keyof typeof THINKING_TO_PI)
		}
	})
})
