/**
 * Contour (a)'s wiring pin — the one line that makes `sandbox.enabled` real for
 * every supervised command.
 *
 * `SessionManager` constructs its `ProcessSupervisor` with
 * `sandboxEnabled: this.sandboxSettings.enabled`. The supervisor's own default
 * when the option is absent is "isolate" (fail-closed, deliberately), so
 * deleting that line does NOT break a single existing test: the switch simply
 * stops being read, every command silently goes back to being wrapped, and the
 * whole feature is inert while the suite stays green. The final whole-branch
 * review flagged this as the only contour with no pin — (b), (d), (e) and (f)
 * each have one.
 *
 * A source pin rather than a behavioural one, and deliberately so: constructing
 * a real supervised spawn here would need a live agent and a real workspace,
 * which this harness has none of. It is the same trade the sibling contour pins
 * make, and its weakness is honest — it catches deletion and renaming, not a
 * subtly wrong value.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SESSION_MANAGER = join(import.meta.dir, '..', 'SessionManager.ts')

describe('sandbox.enabled reaches the ProcessSupervisor', () => {
  it('SessionManager passes the resolved switch into the supervisor it builds', () => {
    // `grep -a` semantics: several files in this repo carry a NUL byte and a
    // plain read is the safe way to search one.
    const source = readFileSync(SESSION_MANAGER, 'utf8')

    expect(
      source.includes('sandboxEnabled: this.sandboxSettings.enabled'),
      'the contour-(a) wiring is gone: sandbox.enabled would be resolved and then never read, '
      + 'so every supervised command silently goes back to being wrapped while every test stays green',
    ).toBe(true)
  })
})
