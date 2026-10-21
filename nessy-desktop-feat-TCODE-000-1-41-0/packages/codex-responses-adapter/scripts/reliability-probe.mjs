#!/usr/bin/env node
/**
 * Task 7.2 — tool-call reliability harness against the LIVE Nestor gateway.
 * Measures the Phase 2 retry + progressive-schema-simplification mitigation for
 * the gateway's non-deterministic 400 `"model is required"` on tool requests.
 *
 * NOT a unit test — hits the real gateway (JWT read-only from
 * ~/.nessy/dp_auth_creds.json) and reports rates. Run manually / nightly.
 *
 *   bun packages/codex-responses-adapter/scripts/reliability-probe.mjs [N]
 *
 * Reports: tool-call success rate (final success / total), retry-recovery rate
 * (recovered-by-retry / raw-400s), valid-JSON rate on returned tool calls.
 * The retry ladder (rung 0 as-is → 1 drop required → 2 trim descriptions) is
 * the Phase 2 `retry.ts` ladder — this only measures it.
 */
import { startAdapter } from '../src/server.ts';
import { readNestorJwt } from '../src/nestor-auth.ts';

const N = Number(process.argv[2] ?? 50);
const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

function toolRequestBody(i) {
  return {
    model: MODEL,
    instructions: 'You MUST call the exec_command tool to run the command. Do not answer in text.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `Run: echo probe-${i}` }] }],
    tools: [{ type: 'function', name: 'exec_command', description: 'Run a shell command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } }],
    stream: false,
    temperature: 0.7,
    top_p: 0.8,
  };
}

async function main() {
  const jwt = readNestorJwt();
  if (!jwt) {
    console.log('DEFERRED — no gateway access (no JWT in ~/.nessy/dp_auth_creds.json).');
    process.exit(0);
  }

  const rungs = [];
  let toolCalls = 0;
  let validJson = 0;
  let finalFailures = 0;
  let httpErrors = 0;

  const adapter = await startAdapter({ jwt, onRetryRung: (r) => rungs.push(r) });
  for (let i = 0; i < N; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${adapter.port}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toolRequestBody(i)),
      });
      if (!res.ok) { httpErrors++; finalFailures++; continue; }
      const json = await res.json();
      const fc = (json.output ?? []).find((o) => o.type === 'function_call');
      if (fc) {
        toolCalls++;
        try { JSON.parse(fc.arguments); validJson++; } catch { /* malformed */ }
      }
    } catch {
      finalFailures++;
    }
    if ((i + 1) % 10 === 0) process.stderr.write(`  ${i + 1}/${N}\n`);
  }
  await adapter.close();

  // Rung distribution: rung 0 = succeeded as-is; rung>0 = retry recovered at that rung.
  const dist = rungs.reduce((a, r) => { a[r] = (a[r] || 0) + 1; return a; }, {});
  const retriesRecovered = rungs.filter((r) => r > 0).length;
  const toolCallSuccessRate = toolCalls / N;
  const validJsonRate = toolCalls > 0 ? validJson / toolCalls : 1;

  console.log('\n=== codex tool-call reliability (live gateway) ===');
  console.log(`N=${N}`);
  console.log(`rung distribution: ${JSON.stringify(dist)}  (0=as-is, 1=dropped required, 2=trimmed descriptions)`);
  console.log(`tool-call success rate:  ${toolCallSuccessRate.toFixed(3)}  (${toolCalls}/${N})   [threshold ≥ 0.95]`);
  console.log(`valid-JSON rate:         ${validJsonRate.toFixed(3)}  (${validJson}/${toolCalls})   [threshold ≥ 0.98]`);
  console.log(`retry-recovered turns:   ${retriesRecovered}`);
  console.log(`final failures / http errors: ${finalFailures} / ${httpErrors}`);
  console.log(`SUMMARY: success=${toolCallSuccessRate.toFixed(3)} validJson=${validJsonRate.toFixed(3)} retriesRecovered=${retriesRecovered}/${N}`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
