import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * I2.31 + I2.32 — the two facts the per-name verdicts in
 * `compat/pi-runtime-adapter.ts` rest on, pinned so they cannot go quietly
 * false, plus the one defect reading them surfaced.
 *
 * The verdicts themselves are prose and belong beside
 * `SUPPORTED_PI_RUNTIME_VERSION`. What is testable is (1) that thirteen of the
 * named surfaces are UNREACHABLE — the package's exports map admits four
 * entries at 0.87.1 (three at 0.84.4), only two of which resolve from here,
 * and its root surface re-exports none of them — and (2) that the
 * host's direct `compact()` call now supplies the retry policy Pi's own caller
 * supplies. Both are read off the installed package or the source rather than
 * asserted, for the reason `set-thinking-level-publishes-effective.test.ts`
 * states in this directory: `src/index.ts`'s module body is the subprocess
 * entry point, so importing it boots a server.
 */

const PI_ROOT = dirname(
	Bun.resolveSync('@earendil-works/pi-coding-agent/package.json', import.meta.dir),
)

const INDEX_SOURCE = readFileSync(
	fileURLToPath(new URL('../index.ts', import.meta.url)),
	'utf8',
)

/** Every name I2.31 and I2.32 name that does not sit on the package root. */
const OFF_ROOT_NAMES = [
	'exportSessionToJsonl',
	'collectSettingsDiagnostics',
	'deduplicateDiagnostics',
	'exportSessionForShare',
	'shareSession',
	'splitBom',
	'stripBom',
	'findNodePackageDir',
	'normalizeSessionName',
	'createSessionManager',
	'cleanupManagedInstall',
	'loadAllHighlightLanguages',
	'fetchWithRetry',
] as const

describe('I2.31 / I2.32 · the Pi 0.84.4 surfaces this host does not read (re-read at 0.87.1)', () => {
	/**
	 * FIRED at the 0.85.1 lift (F1.255, 2026-09-24), as it was written to: the map
	 * gained `./experimental/plugin`. Like `./client`, its only condition is
	 * `source` (`./src/experimental/plugin.ts`) and the package ships no `src/`,
	 * so neither resolves from this package — the NEGATIVE case below now proves
	 * both — and the thirteen verdicts in `compat/pi-runtime-adapter.ts` stand.
	 */
	it('the package admits exactly four exports entries, two of them source-only', () => {
		const manifest = JSON.parse(readFileSync(join(PI_ROOT, 'package.json'), 'utf8'))
		expect(Object.keys(manifest.exports).sort()).toEqual(['.', './client', './experimental/plugin', './rpc-entry'])
		expect(manifest.exports['./client']).toEqual({ source: './src/client/index.ts' })
		expect(manifest.exports['./experimental/plugin']).toEqual({ source: './src/experimental/plugin.ts' })
		expect(manifest.version).toBe('0.87.1')
	})

	it('none of the thirteen names is on the package root surface', () => {
		const rootSurface = readFileSync(join(PI_ROOT, 'dist', 'index.d.ts'), 'utf8')
		for (const name of OFF_ROOT_NAMES) expect(rootSurface).not.toContain(name)
	})

	it('CONTROL — a name the host DOES import is on that surface', () => {
		// Without this, the assertion above would pass just as happily against an
		// empty file or a path that no longer exists.
		const rootSurface = readFileSync(join(PI_ROOT, 'dist', 'index.d.ts'), 'utf8')
		expect(rootSurface).toContain('createAgentSession')
		expect(rootSurface).toContain('compact')
	})

	it('NEGATIVE — a deep specifier and a bare subpath are both refused', () => {
		for (const specifier of [
			'@earendil-works/pi-coding-agent/dist/core/session-export.js',
			'@earendil-works/pi-coding-agent/core/session-export',
			// The two source-only entries (0.87.1): declared, and unresolvable from here.
			'@earendil-works/pi-coding-agent/client',
			'@earendil-works/pi-coding-agent/experimental/plugin',
		]) {
			expect(() => Bun.resolveSync(specifier, import.meta.dir)).toThrow()
		}
		// The control on the same instrument: the root resolves.
		expect(Bun.resolveSync('@earendil-works/pi-coding-agent', import.meta.dir)).toContain('dist/index.js')
	})
})

describe('I2.32 · the host compaction call supplies the retry policy', () => {
	/** The host's own `compact()` call, from the callee name to its closing line. */
	function hostCompactCall(): string {
		const start = INDEX_SOURCE.indexOf('await compactPiSession(')
		expect(start).toBeGreaterThan(-1)
		const end = INDEX_SOURCE.indexOf('\n          ),', start)
		expect(end).toBeGreaterThan(start)
		return INDEX_SOURCE.slice(start, end)
	}

	it('passes the session settings manager the runtime itself would read', () => {
		expect(hostCompactCall()).toContain('session.settingsManager.getRetrySettings()')
	})

	it('CONTROL — the extractor really spans the argument list', () => {
		const call = hostCompactCall()
		expect(call).toContain('event.preparation')
		expect(call).toContain('session.agent.streamFunction')
	})

	it('and the vendored runtime still reads that policy the same way', () => {
		// Pi's own `AgentSession.compact()` is the reference implementation for
		// this call, and it passes exactly this value in this position.
		const session = readFileSync(join(PI_ROOT, 'dist', 'core', 'agent-session.js'), 'utf8')
		expect(session).toContain('this.settingsManager.getRetrySettings()')
		// And the consequence of omitting it, from the helper that consumes it.
		const retry = readFileSync(
			join(dirname(Bun.resolveSync('@earendil-works/pi-ai/package.json', import.meta.dir)),
				'dist', 'utils', 'retry.js'),
			'utf8',
		)
		expect(retry).toContain('const maxAttempts = policy?.enabled ? policy.maxRetries : 0')
	})
})
