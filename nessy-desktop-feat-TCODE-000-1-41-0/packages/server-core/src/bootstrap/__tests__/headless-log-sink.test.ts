import { describe, it, expect } from 'bun:test'
import { join } from 'path'

/**
 * D1.232 — the headless server's own log has to reach somebody.
 *
 * The row was born from a measurement that came back BLIND: over three real
 * arms the CLI's stderr carried WARN and ERROR lines and zero INFO lines,
 * INCLUDING the control arm where the work those INFO lines describe provably
 * ran, so the absence proved nothing (WI-n, 2026-09-17). The cause is that in
 * this host stdout is a PROTOCOL — `packages/server/src/index.ts` writes
 * `NESSY_SERVER_URL=` and `NESSY_SERVER_TOKEN=` there for the CLI's spawner to
 * parse — and `platform.logger.info` was writing onto it.
 *
 * The row names `packages/server/src/index.ts`'s
 * `{ info: console.log, warn: console.warn, error: console.error }` as the
 * sink. That object is the WEBUI handler's logger and is the only one of its
 * shape in the tree; the platform the headless server runs on is
 * `createHeadlessPlatform`'s, which timestamps and level-pads every line —
 * which is what WI-n's own captured lines (`18:42:47.715 INFO Shutting
 * down...`) show, a bare `console.log` printing neither.
 *
 * ## Why this drives a CHILD, which is the whole reason the case exists
 *
 * The obvious in-process rig cannot see this row. Stubbing
 * `process.stdout.write` / `process.stderr.write` does NOT intercept
 * `console.log` / `console.warn` / `console.error` under bun 1.3.14 — measured
 * here on the first draft of this file: the stubbed stderr captured the empty
 * string while the real `console.error` line printed to the terminal. So an
 * in-process `expect(stdout).toBe('')` would have passed against the OLD sink
 * too, for the wrong reason, and the case would have been dead from birth.
 *
 * A child's real file descriptors are the only instrument that answers the
 * question the row asks, which is *which fd does an operator have to be
 * capturing*. The `console.log` marker is the positive control on that
 * instrument: it proves this harness CAN see the child's stdout, so an empty
 * stdout is an absence rather than a broken pipe.
 */
describe('D1.232 — the headless platform logger writes to stderr, never to the handshake stream', () => {
  it('every level lands on the child\'s stderr, and only the control reaches stdout', async () => {
    const modulePath = join(import.meta.dir, '..', '..', 'runtime', 'platform-headless.ts')
    const source = [
      'const mod = await import(' + JSON.stringify(modulePath) + ')',
      'const { logger } = mod.createHeadlessPlatform({ appVersion: "0.0.0-test" })',
      'logger.info("SINK-INFO")',
      'logger.warn("SINK-WARN")',
      'logger.error("SINK-ERROR")',
      'logger.debug("SINK-DEBUG")',
      'console.log("SINK-STDOUT-CONTROL")',
    ].join('\n')

    const child = Bun.spawn(['bun', '-e', source], {
      env: { ...process.env, NESSY_DEBUG: 'true' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await child.exited

    // The positive control FIRST: without it an empty stdout says nothing.
    expect(stdout).toContain('SINK-STDOUT-CONTROL')

    // THE ROW. `info` was on stdout, where nothing reads it; `debug` was too,
    // because `console.debug` is an alias of `console.log`, and the row does
    // not mention it.
    expect(stderr).toContain('SINK-INFO')
    expect(stderr).toContain('SINK-DEBUG')
    expect(stdout).not.toContain('SINK-INFO')
    expect(stdout).not.toContain('SINK-DEBUG')

    // The other half of the control: the two levels that were ALREADY on
    // stderr are still there, so the change moved what it meant to move.
    expect(stderr).toContain('SINK-WARN')
    expect(stderr).toContain('SINK-ERROR')
    expect(stdout).not.toContain('SINK-WARN')
    expect(stdout).not.toContain('SINK-ERROR')

    // The format is what makes the stream greppable, and it is also the
    // discriminator that identified this sink: `INFO ` padded to five, after an
    // ISO timestamp, is this platform's and not the WebUI logger's.
    expect(stderr).toMatch(/\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO {2}SINK-INFO/)
  }, 30_000)

  /**
   * D1.276 — the SIBLING sink D1.232 could not reach, on the same instrument.
   *
   * `CONSOLE_LOGGER` (`runtime/platform.ts`) is what every module-scope logger
   * in this package starts on before `setPlatform` runs — `SessionManager`'s
   * `sessionLog`, `services/search.ts`'s two, the model-fetcher `handlerLog` —
   * and its `info` was `console.log` while its `debug` was `console.debug`, an
   * alias of the same. So the pre-initialisation diagnostics of the headless
   * host were landing in the middle of the handshake stream, which is the exact
   * defect above one layer up.
   */
  it('D1.276 — CONSOLE_LOGGER\'s info and debug land on stderr too', async () => {
    const modulePath = join(import.meta.dir, '..', '..', 'runtime', 'platform.ts')
    const source = [
      'const mod = await import(' + JSON.stringify(modulePath) + ')',
      'mod.CONSOLE_LOGGER.info("PRE-INFO", { a: 1 })',
      'mod.CONSOLE_LOGGER.warn("PRE-WARN")',
      'mod.CONSOLE_LOGGER.error("PRE-ERROR")',
      'mod.CONSOLE_LOGGER.debug("PRE-DEBUG")',
      'mod.createScopedLogger(mod.CONSOLE_LOGGER, "session").info("PRE-SCOPED")',
      'console.log("PRE-STDOUT-CONTROL")',
    ].join('\n')

    const child = Bun.spawn(['bun', '-e', source], {
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await child.exited

    // The positive control FIRST, for the reason the header gives.
    expect(stdout).toContain('PRE-STDOUT-CONTROL')

    expect(stderr).toContain('PRE-INFO')
    expect(stderr).toContain('PRE-DEBUG')
    expect(stdout).not.toContain('PRE-INFO')
    expect(stdout).not.toContain('PRE-DEBUG')

    // An object argument still reads, which is what `console.log` gave for free
    // and a naive `String(arg)` would have turned into `[object Object]`.
    expect(stderr).toContain('{"a":1}')

    // The scoped wrapper is how every real caller reaches it, so it is driven
    // rather than assumed: a `createScopedLogger` that had kept its own
    // `console.log` would pass the plain arm and fail here.
    expect(stderr).toContain('[session] PRE-SCOPED')
    expect(stdout).not.toContain('PRE-SCOPED')

    // The two that were already right, unmoved.
    expect(stderr).toContain('PRE-WARN')
    expect(stderr).toContain('PRE-ERROR')
    expect(stdout).not.toContain('PRE-WARN')
    expect(stdout).not.toContain('PRE-ERROR')
  }, 30_000)
})
