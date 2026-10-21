/**
 * P6.179 — the codex telemetry refusals were announced on a channel a packaged
 * build never writes.
 *
 * `resolveCodexOtelExport` DECLINES a configured pipeline in three arms — the
 * `OTEL_EXPORTER_OTLP_HEADERS` refusal, an unparseable endpoint, and a
 * scheme/credential refusal (THREE, where the row counted two) — and each ends
 * codex event export for the whole session. The only statement of that went to
 * `this.debug(...)`, which routes through electron-log with the packaged main
 * process's transports disabled: an operator who had configured a collector saw
 * nothing at all, and could not tell a refusal from a silently working exporter.
 *
 * Native mechanism: none to enable — the refusal is ours and deliberate (codex
 * takes OTLP headers only as literal values in `config.toml`, i.e. a credential
 * written to disk). Step 2, the host making its own refusal legible, is the
 * whole row: `surfaceCodexOperatorNotice` is the one event family the session
 * layer persists, so the sentence survives a reload.
 *
 * Two halves are pinned here and they fail for different reasons: the SENTENCES,
 * which are now operator-facing rather than log-shaped; and the CALL SITE, read
 * off the source because the alternative — booting a runtime with a collector
 * configured — measures the same wiring at ten times the cost, and because a
 * revert to `debug()` is exactly the regression this row exists to prevent.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveCodexOtelExport } from '../codex-agent.ts';

/** Telemetry configured and opted in, so the resolver reaches its decline arms. */
const ON = { NESSY_TELEMETRY: '1', CLAUDE_CODE_ENABLE_TELEMETRY: '1' } as Record<string, string | undefined>;

describe('P6.179 · the refusal sentences are written for an operator, not a log', () => {
  it('names the header refusal without carrying the credential', () => {
    const plan = resolveCodexOtelExport({
      ...ON,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.invalid',
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer sekret',
    });

    expect(plan.notice).toContain('Codex TELEMETRY DECLINED');
    expect(plan.notice).toContain('OTEL_EXPORTER_OTLP_HEADERS');
    expect(plan.notice).toContain('This session exports no codex events');
    // The credential never travels in the sentence — now that the sentence is
    // durable and user-visible, this matters more than it did on a debug line.
    expect(plan.notice).not.toContain('sekret');
  });

  it('names the two endpoint refusals the same way', () => {
    expect(resolveCodexOtelExport({ ...ON, OTEL_EXPORTER_OTLP_ENDPOINT: 'not a url' }).notice)
      .toContain('Codex TELEMETRY DECLINED');
    expect(resolveCodexOtelExport({ ...ON, OTEL_EXPORTER_OTLP_ENDPOINT: 'https://user:pw@collector.example.invalid' }).notice)
      .toContain('Codex TELEMETRY DECLINED');
  });

  it('says nothing at all when the pipeline is accepted — the control', () => {
    const plan = resolveCodexOtelExport({ ...ON, OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.invalid' });

    expect(plan.notice).toBeUndefined();
    expect(plan.logsEndpoint).toContain('/v1/logs');
  });
});

describe('P6.179 · the notice reaches the durable channel', () => {
  it('is surfaced, not debugged, at the one call site that reads the plan', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'codex-agent.ts'), 'utf-8');
    const at = source.indexOf('const otelExport = resolveCodexOtelExport();');
    expect(at).toBeGreaterThan(-1);

    // D1.111 — an END ANCHOR, not 1 400 characters, and NOT `bracedRegion`:
    // this anchor is a complete statement and the next `{` after it is a block
    // far below, so a brace scan would run past the sequence this case is
    // about. The block really is 1 751 characters today, so the old number was
    // reading 80 % of it and the negative below could not have seen a
    // `this.debug(...)` in the last 351.
    const end = source.indexOf('const planModeThinkingLevel = this.planModeThinkingLevel();', at);
    expect(end).toBeGreaterThan(at);
    const window = source.slice(at, end);
    expect(window).toContain('this.surfaceCodexOperatorNotice(otelExport.notice)');
    // KILLS the shipped state: the same window used to read `this.debug(...)`,
    // which a packaged build does not write.
    expect(window).not.toContain('this.debug(otelExport.notice)');
    // BOUNDARY CONTROL. With an explicit end anchor the bound is exact, so the
    // failure mode is a RENAMED end anchor: `indexOf` would find its next
    // occurrence far below and the region would swallow whole methods. None
    // belongs in this stretch of the runtime build, so this fires on that.
    expect(window).not.toContain('private ');
  });
});

/**
 * P6.488 — a header-authenticated OTLP collector got a full stream from Pi and
 * claude and nothing at all from codex.
 *
 * Owner decision 2026-09-05, Q24 option 3: write the headers as literals ONLY
 * behind a named opt-in. codex accepts nothing else — `OtlpHttp.headers` is a
 * literal map in `config/src/types.rs` at `rust-v0.150.1` with no env-var-NAME
 * form anywhere in `OtelExporterKind` — so the writer's standing invariant
 * (`config.toml` holds `env_key` / `bearer_token_env_var`, never a value) is the
 * thing being relaxed, deliberately and on request.
 *
 * These cases pin the DEFAULT first: unset, the refusal still stands. That
 * ordering is the point of the row — a knob that quietly widens what lands on
 * disk would be worse than the gap it closes.
 */
describe('P6.488 — the OTLP headers reach codex only behind the named opt-in', () => {
  const OPT_IN = 'NESSY_CODEX_OTLP_HEADERS_ON_DISK'
  const base = {
    NESSY_ENABLE_TELEMETRY: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer sekret,x-scope=team%20a',
  }

  it('still refuses with the opt-in unset, and now names the way out', () => {
    const plan = resolveCodexOtelExport(base)
    expect(plan.logsEndpoint).toBeUndefined()
    expect(plan.otlpHeaders).toBeUndefined()
    expect(plan.notice).toContain(OPT_IN)
    // The refusal must still never carry the credential.
    expect(plan.notice).not.toContain('sekret')
  })

  it('carries the parsed headers when the operator accepts the trade', () => {
    const plan = resolveCodexOtelExport({ ...base, [OPT_IN]: '1' })
    expect(plan.notice).toBeUndefined()
    expect(plan.logsEndpoint).toBe('http://127.0.0.1:4318/v1/logs')
    // Percent-decoded per entry, which is the OTLP spec's own form.
    expect(plan.otlpHeaders).toEqual({ authorization: 'Bearer sekret', 'x-scope': 'team a' })
  })

  it('refuses rather than exporting headerless when the opt-in has nothing to write', () => {
    // A collector that answers 401 with the operator told nothing is the exact
    // silence this row exists to end, so an unusable header string is a refusal
    // and not a quiet downgrade.
    const plan = resolveCodexOtelExport({
      ...base, [OPT_IN]: '1', OTEL_EXPORTER_OTLP_HEADERS: 'no-equals-sign',
    })
    expect(plan.logsEndpoint).toBeUndefined()
    expect(plan.notice).toContain('no usable')
  })

  it('drops an entry carrying a control character rather than repairing it', () => {
    // A header we cannot spell faithfully would make codex reject the WHOLE
    // config file, which takes the provider block and every deny floor with it.
    const plan = resolveCodexOtelExport({
      ...base, [OPT_IN]: '1', OTEL_EXPORTER_OTLP_HEADERS: 'good=1,bad=a\nb',
    })
    expect(plan.otlpHeaders).toEqual({ good: '1' })
  })

  it('tells the truth about claude, which is spelling-dependent', () => {
    // The sentence used to end "Pi and claude are unaffected". Pi always is; the
    // claude child is the vendored SDK and gates its own exporter on its OWN
    // name, so an operator who used only the Nessy spelling has a claude session
    // exporting nothing either.
    const nessyOnly = resolveCodexOtelExport(base).notice ?? ''
    expect(nessyOnly).toContain('Claude is NOT exporting either')

    const claudeSpelling = resolveCodexOtelExport({
      ...base, CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    }).notice ?? ''
    expect(claudeSpelling).toContain('Pi and claude are unaffected')
  })
})
