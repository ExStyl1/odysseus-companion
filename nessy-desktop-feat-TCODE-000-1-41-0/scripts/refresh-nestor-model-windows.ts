#!/usr/bin/env bun
/**
 * refresh-nestor-model-windows.ts — rebuild the shipped gateway context-window
 * snapshot from the gateway's own model catalogue.
 *
 *     NESTOR_TOKEN=<jwt> bun scripts/refresh-nestor-model-windows.ts > /tmp/snapshot.ts \
 *       && mv /tmp/snapshot.ts packages/shared/src/auth/nestor-model-snapshot.ts
 *
 * THE TWO STEPS ARE NOT OPTIONAL, and redirecting straight onto the output file
 * fails in a way that reads like a bug in this script. The repo-root
 * `bunfig.toml` preloads `packages/shared/src/unified-network-interceptor.ts`
 * into every in-repo `bun` invocation, which transitively imports
 * `auth/nestor.ts`, which imports the very file being written. The shell
 * truncates a `>` target BEFORE the process starts, so bun then preloads an
 * empty module and dies with `export 'NESTOR_MODEL_SNAPSHOT_META' not found`
 * having written nothing — and a second run "succeeds" identically at zero
 * bytes, so a determinism check comparing two empty files passes. Measured
 * 2026-08-28, in exactly that order.
 *
 * WHY A COMMITTED SNAPSHOT AT ALL, GIVEN THE LIVE PATH WORKS. Measured
 * 2026-08-28, `GET /api/v1/cli/models` reports `context_window_size` on every
 * row, so `fetchNestorModels` normally stamps a real window straight onto the
 * catalogue and nothing here is consulted. The snapshot is tier two: a refresh
 * that failed, a stored catalogue entry that lost its window, a connection
 * seeded before the first refresh. Tier two used to be two numbers typed by
 * hand, and by the time the gateway published its own they had drifted — the
 * hand-written 262144 against the gateway's 262000. A fallback nobody can
 * re-derive goes stale silently, so the re-derivation is this file.
 *
 * CREDENTIALS COME FROM THE ENVIRONMENT, and this is not negotiable. This script
 * reads `NESTOR_TOKEN` (and optionally `LLM_PROXY_API_KEY`) from the process
 * environment and nowhere else. It does not read, and must never learn to read,
 * `~/.nessy/dp_auth_creds.json` — that file is nessy-cli's contract, written
 * only by `packages/shared/src/auth/dp`. It never writes a credential anywhere,
 * and no key belongs in the generated output.
 *
 * `LLM_PROXY_API_KEY` IS A CROSS-CHECK, NOT A SECOND SOURCE, and the measurement
 * is the reason. llm-proxy's `GET /models` carries `context_length` behind a
 * Bearer key and listed 387 ids on 2026-08-28 (383 a fortnight earlier — the
 * count carries its date because that catalogue moves weekly), but the gateway
 * does not serve that catalogue:
 * probed 2026-08-28, a POST through `…/cli/openai-like/v1/chat/completions` for
 * a real llm-proxy id the gateway's preset omits (`tgpt/qwen3-vl-235b-instruct`)
 * returns `400 {"message":"model not available"}` — the gateway's own error, not
 * llm-proxy's `404 quota not found`. Presence in llm-proxy is therefore not even
 * reachability, let alone entitlement. So an llm-proxy row may LOWER the window
 * of an id the gateway already serves and may never introduce one.
 *
 * ON A DISAGREEMENT, THE SMALLER VALUE WINS. Staleness in a context window is
 * silent and asymmetric: an over-stated window reproduces the bug this fallback
 * exists to prevent, an under-stated one merely compacts early.
 */

import { readFileSync } from 'node:fs';

const GATEWAY_MODELS_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/models';
const LLM_PROXY_MODELS_URL = 'https://llm-proxy.t-tech.team/v1/models';
const SHARED_NESTOR_SOURCE = 'packages/shared/src/auth/nestor.ts';
const OUTPUT_PATH = 'packages/shared/src/auth/nestor-model-snapshot.ts';

interface GatewayModel {
  id: string;
  context_window_size?: number;
  contextWindow?: number;
  context_window?: number;
  context_window_tokens?: number;
}

interface LlmProxyModel {
  id: string;
  context_length?: number;
}

/**
 * The placeholder floor, read out of the shared module rather than restated.
 *
 * A second copy of this number is a second thing to forget, and the two would
 * disagree exactly when it mattered — the snapshot would ship a value the
 * runtime then rejects. Parsed as text rather than imported because
 * `scripts/tsconfig.json` covers this directory as a standalone program, and an
 * import of `packages/shared` drags that package into it (the reason
 * `ipc-inventory.ts` needs a tsconfig of its own).
 */
function readPlaceholderFloor(): number {
  const text = readFileSync(SHARED_NESTOR_SOURCE, 'utf8');
  const match = /export const MIN_PLAUSIBLE_CONTEXT_WINDOW = (\d[\d_]*)/.exec(text);
  if (!match?.[1]) {
    throw new Error(
      `no \`export const MIN_PLAUSIBLE_CONTEXT_WINDOW = <n>\` in ${SHARED_NESTOR_SOURCE} — ` +
        'the placeholder floor moved or was renamed, and guessing it here would ship a ' +
        'snapshot the runtime disagrees with. Fix the pattern, do not hardcode the number.',
    );
  }
  return Number(match[1].replaceAll('_', ''));
}

function reportedWindow(model: GatewayModel): number | undefined {
  const value = model.contextWindow
    ?? model.context_window
    ?? model.context_window_size
    ?? model.context_window_tokens;
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined;
}

async function fetchJson<T>(url: string, headers: Record<string, string>, label: string): Promise<T> {
  const res = await fetch(url, { headers, redirect: 'error' });
  if (!res.ok) {
    throw new Error(
      `${label} returned ${res.status}. The snapshot was NOT rewritten; the committed one still ` +
        'stands, which is the right outcome — a half-harvested fallback is worse than a dated one.',
    );
  }
  return (await res.json()) as T;
}

/** A single-quoted TS string literal — the quote style the shared package uses. */
function q(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function render(
  windows: Record<string, number>,
  meta: {
    snapshot: string;
    source: string;
    rows: number;
    windows: number;
    rejectedAsPlaceholder: number;
    crossCheckLowered: number;
  },
): string {
  const entries = Object.keys(windows)
    .sort()
    .map((id) => `  ${q(id)}: ${windows[id]},`)
    .join('\n');
  return `/**
 * GENERATED FILE — do not hand-edit.
 *
 * Rebuilt by \`scripts/refresh-nestor-model-windows.ts\`; see that script's header
 * for the fetch that produces it and the environment keys it reads.
 *
 * Read {@link NESTOR_MODEL_SNAPSHOT_META} for when this was harvested and from
 * where. It is the ONLY provenance statement for these numbers: a prose sentence
 * elsewhere claiming a date or a count is not evidence about this file, and this
 * repo has twice shipped a document asserting a stale count beside a correct one.
 */

/** When, from where, and over how many rows this snapshot was harvested. */
export const NESTOR_MODEL_SNAPSHOT_META = Object.freeze({
  /** ISO date of the harvest that produced the windows below. */
  snapshot: ${q(meta.snapshot)},
  /** The endpoint the windows were read from. */
  source: ${q(meta.source)},
  /** Rows the endpoint returned. */
  rows: ${meta.rows},
  /** Rows that carried a usable window (the rest are absent below, not zeroed). */
  windows: ${meta.windows},
  /**
   * Rows whose reported window was at or below
   * \`MIN_PLAUSIBLE_CONTEXT_WINDOW\` — a "not filled in" placeholder rather than a
   * window, dropped rather than recorded.
   */
  rejectedAsPlaceholder: ${meta.rejectedAsPlaceholder},
  /**
   * Rows whose window an \`LLM_PROXY_API_KEY\` cross-check disagreed with. The
   * smaller value is the one recorded; 0 means either no disagreement or no
   * cross-check key was supplied.
   */
  crossCheckLowered: ${meta.crossCheckLowered},
});

/**
 * Gateway model id → context window, as the gateway itself reported it.
 *
 * This is the FALLBACK, not the design: \`fetchNestorModels\` prefers the window
 * the live \`/cli/models\` response carries, and this table covers what the live
 * path could not — a refresh that failed, a stored catalogue entry that lost its
 * window, a connection seeded before the first refresh.
 */
export const NESTOR_MODEL_SNAPSHOT_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
${entries}
});
`;
}

async function main(): Promise<number> {
  const token = process.env.NESTOR_TOKEN?.trim();
  if (!token) {
    console.error(
      'NESTOR_TOKEN is empty. Export the gateway JWT into the environment and re-run:\n' +
        '  NESTOR_TOKEN=<jwt> bun scripts/refresh-nestor-model-windows.ts > /tmp/snapshot.ts \\\n' +
        `    && mv /tmp/snapshot.ts ${OUTPUT_PATH}\n` +
        'This script reads the key from the environment ONLY — never from a credential file.',
    );
    return 1;
  }

  const floor = readPlaceholderFloor();
  const rows = await fetchJson<GatewayModel[]>(
    GATEWAY_MODELS_URL,
    { 'Nestor-Token': token },
    'gateway /cli/models',
  );

  const windows: Record<string, number> = {};
  let rejected = 0;
  for (const row of rows) {
    const value = reportedWindow(row);
    if (value === undefined) {
      console.error(`NOTE: ${row.id} reports no context window at all — falls through to the warning.`);
      continue;
    }
    if (value < floor) {
      rejected += 1;
      console.error(
        `WARNING: ${row.id} reports context window ${value}, below the ${floor} placeholder floor. ` +
          'That is "not filled in", not a small window — dropped rather than shipped.',
      );
      continue;
    }
    windows[row.id] = value;
  }

  let lowered = 0;
  const proxyKey = process.env.LLM_PROXY_API_KEY?.trim();
  if (proxyKey) {
    const proxyRows = await fetchJson<{ data?: LlmProxyModel[] } | LlmProxyModel[]>(
      LLM_PROXY_MODELS_URL,
      { Authorization: `Bearer ${proxyKey}` },
      'llm-proxy /v1/models',
    );
    const list = Array.isArray(proxyRows) ? proxyRows : (proxyRows.data ?? []);
    let unreachable = 0;
    for (const row of list) {
      const value = row.context_length;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < floor) continue;
      const current = windows[row.id];
      if (current === undefined) {
        unreachable += 1;
        continue;
      }
      if (value < current) {
        lowered += 1;
        console.error(
          `WARNING: llm-proxy reports ${value} for ${row.id} where the gateway reports ${current}. ` +
            'Recording the smaller value — an over-stated window is the failure that is silent.',
        );
        windows[row.id] = value;
      }
    }
    console.error(
      `NOTE: ${unreachable} llm-proxy ids the gateway does not serve were ignored. ` +
        'The gateway rejects them with 400 "model not available"; a window for a model the ' +
        'shipped card cannot call is not a fallback, it is noise.',
    );
  } else {
    console.error('NOTE: LLM_PROXY_API_KEY unset — gateway values shipped without a cross-check.');
  }

  process.stdout.write(
    render(windows, {
      snapshot: new Date().toISOString().slice(0, 10),
      source: GATEWAY_MODELS_URL,
      rows: rows.length,
      windows: Object.keys(windows).length,
      rejectedAsPlaceholder: rejected,
      crossCheckLowered: lowered,
    }),
  );
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
