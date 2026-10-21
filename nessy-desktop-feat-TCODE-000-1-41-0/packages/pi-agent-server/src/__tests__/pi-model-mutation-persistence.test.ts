import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SESSION_ONLY_MODEL_MUTATION } from '../model-mutation-persistence.ts'

/**
 * I2.29 — Pi 0.84.4 writes a global default only when `persist` is true, and
 * this host says `false` at every call site rather than inheriting it.
 *
 * ## Why the host half is read off the SOURCE
 *
 * The four call sites live in `src/index.ts`, whose module body IS the
 * subprocess entry point — importing it boots a server, which is why
 * `index-import-guard.test.ts` exists in this directory. The precedent for
 * pinning one wiring decision inside that module off its source text, with a
 * control that proves the extractor can still see, is
 * `set-thinking-level-publishes-effective.test.ts` beside this file.
 *
 * ## Why the SDK half is read off the INSTALLED package
 *
 * A spelling pin alone would survive the change that actually matters: upstream
 * renaming the option, or inverting its sense. So the last two cases read the
 * vendored `@earendil-works/pi-coding-agent` — the same instrument
 * `pi-harness-baseline.test.ts` uses for the event union — and go red on a Pi
 * whose mutators no longer gate the global-defaults write on `persist`.
 */

const INDEX_SOURCE = readFileSync(
	fileURLToPath(new URL('../index.ts', import.meta.url)),
	'utf8',
)

const PI_DIST = join(
	dirname(Bun.resolveSync('@earendil-works/pi-coding-agent/package.json', import.meta.dir)),
	'dist',
	'core',
)

/** Every `x.setModel(...)` / `x.setThinkingLevel(...)` call in `src/index.ts`. */
function mutationCallSites(): string[] {
	return [...INDEX_SOURCE.matchAll(/\.(?:setModel|setThinkingLevel)\([^\n]*/g)].map(m => m[0])
}

describe('I2.29 · Pi model and thinking mutations are session-only, explicitly', () => {
	it('the shared option says persist: false', () => {
		expect(SESSION_ONLY_MODEL_MUTATION).toEqual({ persist: false })
	})

	it('every mutation call site in index.ts passes it', () => {
		const sites = mutationCallSites()
		// Four: the ephemeral mini-model session, the runtime_config update,
		// `handleSetModel` and `handleSetThinkingLevel`. The count is asserted so
		// a NEW call site added without the argument cannot hide behind the
		// per-site loop below passing over three it already knows about.
		expect(sites).toHaveLength(4)
		for (const site of sites) expect(site).toContain('SESSION_ONLY_MODEL_MUTATION')
	})

	it('NEGATIVE — no call site asks Pi to write a global default', () => {
		for (const site of mutationCallSites()) expect(site).not.toContain('persist: true')
	})

	it('CONTROL — the extractor really reads the calls, so the negative can fail', () => {
		const sites = mutationCallSites()
		expect(sites.some(site => site.includes('ephemeralSession') || site.includes('piModel'))).toBe(true)
		expect(sites.some(site => site.includes('piLevel'))).toBe(true)
	})

	it('the vendored Pi still spells the option `persist` on all four mutators', () => {
		const declarations = readFileSync(join(PI_DIST, 'agent-session.d.ts'), 'utf8')
		expect(declarations).toContain('export interface ModelMutationOptions')
		expect(declarations).toContain('persist?: boolean')
		for (const mutator of ['setModel', 'cycleModel', 'setThinkingLevel', 'cycleThinkingLevel']) {
			expect(declarations).toContain(`${mutator}(`)
		}
		// The two host-visible ones carry the option; the two cycles do too, and
		// they have no host caller (`model-mutation-persistence.ts` records why).
		expect(declarations).toContain('setModel(model: Model<any>, options?: ModelMutationOptions)')
		expect(declarations).toContain('setThinkingLevel(level: ThinkingLevel, options?: ModelMutationOptions)')
	})

	it('the vendored Pi still GATES both global-defaults writes on it', () => {
		const implementation = readFileSync(join(PI_DIST, 'agent-session.js'), 'utf8')
		// The two writes this host must never trigger, each behind the flag. A Pi
		// that persisted unconditionally again — or that inverted the sense —
		// fails here rather than silently rewriting a user's defaults.
		for (const write of ['setDefaultModelAndProvider(', 'setDefaultThinkingLevel(']) {
			const at = implementation.indexOf(write)
			expect(at).toBeGreaterThan(-1)
			expect(implementation.slice(Math.max(0, at - 200), at)).toContain('if (options.persist)')
		}
	})
})
