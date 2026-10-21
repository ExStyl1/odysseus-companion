/**
 * P6.169 — `config/read`, the request family we had never sent.
 *
 * ## Native mechanism, step 1 and not step 3
 *
 * The codex app-server publishes a per-key origin map and we had never asked
 * for it: `git grep -a 'config/read'` scored 0 across `packages/shared/src` and
 * `packages/codex-agent-server/src` at HEAD, and we send no `config/*` method at
 * all, so this is a new client request family rather than a new mechanism.
 * `ConfigReadResponse` (`packages/codex-protocol/generated/v2/`) is verbatim
 * `{ config: Config, origins: { [key in string]?: ConfigLayerMetadata }, layers: Array<ConfigLayer> | null }`
 * and `ConfigLayerSource` names an absolute file per layer plus `mdm{domain,key}`
 * and `enterpriseManaged{id,name}`. Nothing is built beside it, and nothing is
 * inferred from the `config.toml` this host authors.
 *
 * ## Measured on the shipped binary, and it corrected the row
 *
 * 2026-09-08, `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`,
 * scratch `CODEX_HOME` carrying `model` + `model_reasoning_effort`, plus an
 * untrusted project layer setting `model`:
 *
 * | reading | value |
 * | --- | --- |
 * | `config` top-level keys | 97 |
 * | `origins` entries | 2 |
 * | `layers` with `includeLayers: true` | 3 (project, user, system) |
 * | `layers` WITHOUT it | `undefined` |
 * | `/etc/codex/config.toml` (does not exist) | present as a `system` layer, `config: {}` |
 * | the untrusted project layer | `config: { model: … }` **and** a `disabledReason` |
 * | `origins.model` with that project layer present | the USER file |
 * | a `cwd` that does not exist | no error, no project layer |
 *
 * Three consequences are written into `describeCodexConfigProvenance`'s own
 * header, because they are properties of the ANSWER rather than of this probe.
 * The one that matters here: `origins` explains 2 of 97 effective keys, so the
 * row's control as filed — *"a key we did NOT write comes back with a user /
 * system / packagedDefaults origin"* — cannot run as written. A key nobody set
 * has no origin, because its value is the runtime's own default.
 *
 * ## It degrades, and it must
 *
 * Same contract as {@link probeCodexConfigRequirements}, for the same reason: the
 * app-server is a separately versioned binary, `config/read` is optional to any
 * particular build, and this is a READ that changes no posture. It never throws,
 * never rejects and never hangs — an ignored method is exactly as unable to
 * answer as a refused one, and a hang on the spawn path is the worse failure.
 */

import {
  isDefinitiveAppServerRefusal,
  type CodexRequestChannel,
} from './codex-config-requirements.ts';
import {
  describeCodexConfigProvenance,
  type CodexConfigProvenanceV1,
} from '../config/config-doctor.ts';

export const CODEX_CONFIG_READ_METHOD = 'config/read';

/**
 * Five seconds, the same bound its sibling probe takes and for the same measured
 * reason: on the shipped binary an unknown method is refused in ~1 ms and a real
 * read answers in single-digit milliseconds, so nothing that reaches this timer
 * is a refusal this client could have read.
 */
export const CODEX_CONFIG_READ_TIMEOUT_MS = 5_000;

export interface CodexConfigOriginsReadingV1 {
  /**
   * `read` — the runtime answered. `unsupported` — it refused definitively (an
   * older or newer build without the method). `failed` — anything transient,
   * including the deadline.
   *
   * The three are kept apart for the sibling probe's reason: a build that does
   * not have the method and a build that was wedged for two seconds are
   * different facts, and only the first is permanent.
   */
  readonly status: 'read' | 'unsupported' | 'failed';
  readonly provenance?: CodexConfigProvenanceV1 | undefined;
  readonly detail?: string | undefined;
}

/**
 * Ask a codex app-server where its effective configuration came from.
 *
 * `includeLayers: true` is ALWAYS sent: without it the shipped binary returns
 * `layers: undefined`, and the layer list is the half that answers "the file I
 * edited exists and set nothing" and "the file I edited was read and not
 * applied" — the two states a per-key map cannot show.
 *
 * `cwd` is the workspace directory, so the project layer between it and the repo
 * root is resolved (`ConfigReadParams.cwd`, verbatim: *"return the effective
 * config as seen from that directory (i.e., including any project layers between
 * `cwd` and the project/repo root)"*). Omitted when the caller has none — the
 * measurement above shows a nonexistent path is not an error, but sending a path
 * we do not believe in would make the answer a guess.
 */
export async function probeCodexConfigOrigins(
  client: CodexRequestChannel,
  options: {
    cwd?: string | undefined;
    onDiagnostic?: (message: string) => void;
    timeoutMs?: number;
  } = {},
): Promise<CodexConfigOriginsReadingV1> {
  const params = {
    includeLayers: true,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  };
  const timeoutMs = options.timeoutMs ?? CODEX_CONFIG_READ_TIMEOUT_MS;
  let result: unknown;
  try {
    // Both mechanisms, exactly as the sibling probe holds them: the channel's
    // own `timeoutMs` is what lets a real `AppServerClient` reclaim its pending
    // entry, and the race is what makes the deadline a property of this module
    // rather than a favour from whichever object was passed in.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      result = await Promise.race([
        client.request(CODEX_CONFIG_READ_METHOD, params, { timeoutMs }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(
              `app-server request ${CODEX_CONFIG_READ_METHOD} timed out after ${timeoutMs}ms`,
            )),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const status = isDefinitiveAppServerRefusal(error) ? 'unsupported' as const : 'failed' as const;
    options.onDiagnostic?.(
      `codex ${CODEX_CONFIG_READ_METHOD} ${status}: the settings-provenance view will show no codex `
      + `section for this session (${detail})`,
    );
    return Object.freeze({ status, detail });
  }

  const provenance = describeCodexConfigProvenance(result);
  if (!provenance) {
    // Answered, but not in a shape this host can read. Reported as `failed`
    // rather than `read`, because an empty section that claims to be an answer
    // is the exact defect the whole provenance view exists to remove.
    const detail = 'the answer carried no readable config object';
    options.onDiagnostic?.(`codex ${CODEX_CONFIG_READ_METHOD} failed: ${detail}`);
    return Object.freeze({ status: 'failed', detail });
  }
  return Object.freeze({ status: 'read', provenance });
}

/**
 * The last answer a codex session got IN EACH WORKSPACE, for the settings page
 * to read.
 *
 * MODULE-SCOPE, and the reason is the same one `recordCodexInAppUpdatesRequirement`
 * gives for its own tier: the reader is a settings handler with no session, and
 * the writer is a runtime that has one. The alternative — reaching into
 * `SessionManager` for a live agent from an RPC settings handler — would make a
 * read-only checkup depend on session lifetime, and `SessionManager` is not this
 * seam's to widen.
 *
 * P6.823 — KEYED BY WORKSPACE, and that is a correctness fix rather than a
 * refinement. `config/read` resolves the project layer from the session's `cwd`
 * (`ConfigReadParams.cwd`, verbatim: *"return the effective config as seen from
 * that directory (i.e., including any project layers between `cwd` and the
 * project/repo root)"*), so the answer is a property of ONE workspace. A single
 * process-wide slot handed whichever workspace opened the settings page the
 * layer list of whichever workspace started a codex session last — a
 * confidently-wrong answer, which is the exact defect this whole view exists to
 * remove.
 *
 * The key is the workspace id or `undefined`; a `Map` takes `undefined` as a key
 * directly, so a session with no workspace and a reader with no workspace meet
 * in their own slot and can never collide with a real workspace id — no
 * sentinel string to be shadowed by a workspace someone names that way.
 *
 * A missing entry is the honest empty state and is what the surface must say:
 * "no codex session has answered in THIS workspace", never "codex has no
 * layers".
 */
const recordedCodexConfigProvenance = new Map<string | undefined, CodexConfigProvenanceV1>();

/**
 * Record what a codex session in `workspaceId` read. `undefined` provenance
 * CLEARS nothing on purpose — a probe that could not run must not erase a good
 * answer from the session before it, for `recordCodexInAppUpdatesRequirement`'s
 * reason: a runtime that fails to answer is not a statement about the
 * configuration.
 */
export function recordCodexConfigProvenance(
  workspaceId: string | undefined,
  provenance: CodexConfigProvenanceV1 | undefined,
): void {
  if (provenance === undefined) return;
  recordedCodexConfigProvenance.set(workspaceId, provenance);
}

/**
 * What a codex session in `workspaceId` last reported, or `undefined` when none
 * has. A reader that names no workspace reads only what a session with no
 * workspace wrote: borrowing another workspace's answer is the bug, not the
 * fallback.
 */
export function readRecordedCodexConfigProvenance(
  workspaceId?: string | undefined,
): CodexConfigProvenanceV1 | undefined {
  return recordedCodexConfigProvenance.get(workspaceId);
}

/** Test seam: forget every recorded answer. Never called by product code. */
export function resetRecordedCodexConfigProvenance(): void {
  recordedCodexConfigProvenance.clear();
}
