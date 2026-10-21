import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * P6.889 — the claude runtime has NO per-turn `traceparent` producer, and it
 * cannot have one. This file is the ceiling, recorded where the next lane will
 * meet it rather than only in a plan row, plus the assertions that make the day
 * it lifts a RED instead of a re-derivation.
 *
 * ## The row, and what "native-first" answered
 *
 * `4a5486a54` (P6.459 M30) configured claude's propagation:
 * `CLAUDE_CODE_PROPAGATE_TRACEPARENT=1` on the child. The value that then
 * propagates is the SDK's own span context, not the host turn span P6.732
 * opens — so a claude run's spans and the host's turn span are two traces. The
 * codex arm closed exactly that gap on its runtime (`CoreBackendConfig.resolveTraceparent`
 * → `AppServerClient`'s per-request `trace` field), which is why this one has
 * to say aloud why the same move is not available here.
 *
 * The native mechanism EXISTS and is documented; it is simply per-PROCESS.
 * `agent-sdk/observability.md#link-traces-to-your-application` (anchor verified
 * on the RENDERED page — `#trace-context-propagation`, the name the section's
 * own subject suggests, does not exist there), verbatim: *"The SDK automatically propagates W3C trace
 * context into the CLI subprocess. When you call `query()` while an
 * OpenTelemetry span is active in your application, the SDK injects
 * `TRACEPARENT` and `TRACESTATE` into the child process environment, and the
 * CLI reads them so its `claude_code.interaction` span becomes a child of your
 * span."* And the manual override, same page: *"Auto-injection is skipped when
 * you set `TRACEPARENT` explicitly in `options.env`, so you can pin a specific
 * parent context if needed."*
 *
 * `monitoring-usage.md#traces-beta` states the read side: *"In Agent SDK and
 * non-interactive sessions started with `-p`, Claude Code also reads
 * `TRACEPARENT` and `TRACESTATE` from its own environment when starting each
 * interaction span."* Corroborated in the vendored binary (`claudeCodeVersion`
 * `2.1.247`): the interaction span is opened as
 * `xn() && V.TRACEPARENT ? propagation.extract(r, {traceparent: V.TRACEPARENT,
 * tracestate: V.TRACESTATE}) : r` (transcribed at `2.1.233`; the minified names
 * are the minifier's, so read it by this shape). Re-measured 2026-09-12
 * (C3.252) with the instrument named on both sides, because they disagree on a
 * minified artefact (C3.294): `TRACEPARENT` 10 lines / 13 occurrences,
 * `TRACESTATE` 5/5, `CLAUDE_CODE_PROPAGATE_TRACEPARENT` 4/4, against a
 * `zzznonsensecontrolzzz` control of 0/0. The superseded reading was
 * "`TRACEPARENT` 17 and the propagate name 4" at `2.1.233`, instrument unnamed.
 * One caution the numbers above earned: `TRACEPARENT` is a SUFFIX of
 * `CLAUDE_CODE_PROPAGATE_TRACEPARENT`, so a probe that passes both needles to
 * one `grep -f` invocation silently attributes the overlap to the longer one
 * and reports 7/9 for the short needle. Count an overlapping needle alone.
 *
 * ## Why that is a CEILING and not a seam — three measurements
 *
 * 1. **The child reads its OWN process env.** `V.TRACEPARENT` is the child's
 *    environment, fixed at spawn. This fork runs ONE `query()` per agent that
 *    outlives the turn (see the package guide, *"One `query()` per Claude agent,
 *    and it outlives the turn"*), so the env is written once per SESSION while
 *    the host turn span moves per TURN.
 * 2. **There is no live setter.** `env` is an `Options` field — a construction
 *    option — and `Query`, the whole live-settings surface, declares nothing
 *    that touches it. Asserted below against the installed `sdk.d.ts`, because
 *    the hand-written version of a claim like this has rotted in this repo
 *    before.
 * 3. **Auto-injection injects nothing here.** The documented automatic path
 *    needs *"an OpenTelemetry span active in your application"*. `host-tracer.ts`
 *    is a standalone buffering tracer that mints its own W3C ids and never
 *    touches `@opentelemetry/api` — this repo does not depend on it — so
 *    `context.active()` in the SDK is empty at `query()` time.
 *
 * ## What we deliberately did NOT do, and it is the interesting half
 *
 * Passing the host's traceparent through `options.env` at spawn would compile,
 * ship, and be WRONG in a way a dashboard would not reveal: the child re-reads
 * the same static value when starting EVERY interaction span, so turn fifty's
 * `claude_code.interaction` would be parented to turn ONE's host span. Two
 * honest traces beat one trace that misreports its own shape — and a false
 * parent is exactly the class of defect P6.459's control (*"never mint a
 * traceparent when none is open"*) exists to prevent, one level up.
 *
 * The ceiling therefore lifts on ONE of two events, and each has an assertion
 * below that goes red when it happens: the SDK grows a live env seam, or the
 * host tracer becomes a real OpenTelemetry tracer whose span is active when
 * `query()` is called. A THIRD route — a host span whose lifetime is the
 * SESSION rather than the turn — is a build rather than a configuration and
 * belongs to whoever revisits P6.732's span shape.
 */

const sdkTypes = readFileSync(
  fileURLToPath(new URL('../../../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts', import.meta.url)),
  'utf8',
);

/** Every method name declared on `Query`, the SDK's live-settings surface. */
function queryMethodNames(): string[] {
  const start = sdkTypes.indexOf('export declare interface Query extends');
  expect(start, 'the Query interface moved or was renamed').toBeGreaterThan(0);
  const body = sdkTypes.slice(start, sdkTypes.indexOf('\n}', start));
  return [...body.matchAll(/^ {4}([A-Za-z_][A-Za-z0-9_]*)\(/gm)].map(match => match[1]!);
}

describe('P6.889 — the claude per-turn traceparent ceiling', () => {
  it('has no live env seam on Query, so a per-turn parent cannot be delivered', () => {
    const methods = queryMethodNames();
    // Positive control FIRST: an enumeration that found nothing would satisfy
    // the real assertion vacuously, and this is a regex over a 367 KB file.
    expect(methods).toContain('setModel');
    expect(methods).toContain('setPermissionMode');
    expect(methods.length).toBeGreaterThan(20);

    // THE CEILING. Nothing on the live surface sets, replaces or merges the
    // child's environment. The day one appears, this goes red and P6.889 is a
    // build rather than a recorded limit.
    expect(methods.filter(name => /env/i.test(name))).toEqual([]);
  });

  it('carries env as a CONSTRUCTION option, which is the whole reason it is per-session', () => {
    // The other half of the same fact, read from the same file so the two
    // cannot drift: `env` exists, and it exists on `Options`.
    const optionsStart = sdkTypes.indexOf('export declare type Options = {');
    expect(optionsStart, 'the Options type moved or was renamed').toBeGreaterThan(0);
    const optionsBody = sdkTypes.slice(optionsStart, sdkTypes.indexOf('\n};', optionsStart));
    expect(optionsBody).toContain('env?: {');
  });

  it('keeps the host tracer out of the OpenTelemetry global context, which is why auto-injection is inert', () => {
    // The documented automatic path needs an OTel span active in the embedding
    // application. Ours is a standalone buffering tracer minting its own ids,
    // so `context.active()` is empty and the SDK injects nothing.
    //
    // This assertion is the trigger, not a preference: the day the host tracer
    // becomes a real OTel tracer, propagation starts working for free and the
    // ceiling above must be re-read rather than trusted.
    const hostTracer = readFileSync(
      fileURLToPath(new URL('../../telemetry/host-tracer.ts', import.meta.url)),
      'utf8',
    );
    expect(hostTracer).not.toContain("from '@opentelemetry/");
    // And the positive control for the same file: it really does mint its own
    // W3C carrier, so "no OTel" is a design and not a missing dependency.
    expect(hostTracer).toContain('currentTraceparent');
  });

  it('leaves the resolver seam to codex alone, deliberately rather than by omission', () => {
    // `CoreBackendConfig.resolveTraceparent` is consumed by exactly one runtime.
    // Asserted so a later reader meets the asymmetry as a decision with a reason
    // in this file's header, instead of as an obvious-looking gap to "fix" by
    // wiring claude to a value it can only read once.
    const codexAgent = readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8');
    const claudeAgent = readFileSync(fileURLToPath(new URL('../claude-agent.ts', import.meta.url)), 'utf8');
    expect(codexAgent).toContain('this.config.resolveTraceparent?.()');
    expect(claudeAgent).not.toContain('resolveTraceparent');
  });
});
