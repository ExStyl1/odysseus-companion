import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * D1.188 — our REPLACING compaction narrates its retries, at the posture the
 * host already chose for Pi's own.
 *
 * I2.32 gave the host's direct `compact()` call the retry POLICY (the tenth
 * argument) and recorded the CALLBACKS (the eleventh) as a null, because Pi
 * supplies them from `_summarizationRetryCallbacks`, which is private to the
 * session. So every retry this path performed was silent where Pi's would
 * `_emit` `summarization_retry_scheduled` and its two bookends.
 *
 * Read off the source rather than imported, for the reason
 * `pi-new-surface-verdicts.test.ts` states in this directory: `src/index.ts`'s
 * module body is the subprocess entry point, so importing it boots a server.
 * The TYPE half needs no test at all — the helper is declared as
 * `Parameters<typeof compactPiSession>[10]`, so a Pi that moves or retypes that
 * argument is a compile error rather than a silent drop.
 */

const PI_ROOT = dirname(
	Bun.resolveSync('@earendil-works/pi-coding-agent/package.json', import.meta.dir),
)

const INDEX_SOURCE = readFileSync(
	fileURLToPath(new URL('../index.ts', import.meta.url)),
	'utf8',
)

/** The host's own `compact()` call, from the callee name to its closing line. */
function hostCompactCall(): string {
	const start = INDEX_SOURCE.indexOf('await compactPiSession(')
	expect(start).toBeGreaterThan(-1)
	const end = INDEX_SOURCE.indexOf('\n          ),', start)
	expect(end).toBeGreaterThan(start)
	return INDEX_SOURCE.slice(start, end)
}

/** The same call with every comment line dropped, so positions can be read. */
function hostCompactArguments(): string {
	return hostCompactCall()
		.split('\n')
		.filter(line => !line.trim().startsWith('//'))
		.join('\n')
}

/** The body of the helper the call site names. */
function diagnosticsHelper(): string {
	const start = INDEX_SOURCE.indexOf('function compactionRetryDiagnostics(')
	expect(start).toBeGreaterThan(-1)
	const end = INDEX_SOURCE.indexOf('\n}', start)
	expect(end).toBeGreaterThan(start)
	return INDEX_SOURCE.slice(start, end)
}

describe('D1.188 · the compaction retry callbacks are supplied', () => {
	it('passes them as the ELEVENTH argument, straight after the retry policy', () => {
		// Position, not mere presence: the policy is the tenth argument and the
		// callbacks the eleventh, so the two must be the last two in this order.
		expect(hostCompactArguments()).toMatch(
			/session\.settingsManager\.getRetrySettings\(\),\s*compactionRetryDiagnostics\(\),\s*$/,
		)
	})

	it('CONTROL — the extractor really spans the argument list', () => {
		const call = hostCompactArguments()
		expect(call).toContain('event.preparation')
		expect(call).toContain('session.agent.streamFunction')
	})

	it('narrates all three callbacks, on stderr and nowhere else', () => {
		const helper = diagnosticsHelper()
		// Every callback the contract declares is answered — a partial set would
		// leave the failing half of a retry silent, which is the half that matters.
		expect(helper).toContain('onRetryScheduled:')
		expect(helper).toContain('onRetryAttemptStart:')
		expect(helper).toContain('onRetryFinished:')
		expect(helper.match(/debugLog\(/g)?.length).toBe(3)
	})

	it('NEGATIVE — it puts nothing on the JSONL wire', () => {
		// The posture, asserted rather than described: `compaction_start` has
		// already put "Compacting context..." on screen and `compaction_end`
		// reports the outcome, so a `send()` from here would make the replacing
		// path noisier than Pi's own, whose identical events the host's
		// `backend/pi/event-adapter.ts` logs and does not surface.
		const helper = diagnosticsHelper()
		expect(helper).not.toContain('send(')
		expect(helper).not.toContain('yield')
	})

	it('and the vendored runtime still declares that argument in that place', () => {
		const declaration = readFileSync(
			join(PI_ROOT, 'dist', 'core', 'compaction', 'compaction.d.ts'),
			'utf8',
		)
		// The reference implementation for this call: a Pi that reorders these
		// two names, or renames the callback type, is named by this failure
		// rather than by a silently dropped argument.
		expect(declaration).toMatch(
			/retry\?: RetryPolicy, callbacks\?: RetryCallbacks, sessionId\?: string/,
		)
		// And Pi's own caller passes exactly this pair in exactly this order.
		const session = readFileSync(join(PI_ROOT, 'dist', 'core', 'agent-session.js'), 'utf8')
		expect(session).toContain(
			'this.settingsManager.getRetrySettings(), this._summarizationRetryCallbacks(',
		)
	})
})
