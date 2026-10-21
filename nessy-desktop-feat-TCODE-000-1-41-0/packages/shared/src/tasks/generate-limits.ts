/**
 * UA4.5 — the Generate mode's limits, in ONE module both sides read (spec §11 "Generate", plan UA4.5/UA4.6).
 *
 * The server values are craft-agents-oss v0.13.4's (`packages/server-core/src/handlers/rpc/tasks.ts` L81–L85,
 * Apache-2.0), re-derived from v0.15.1's by UB2.9: each authoring attempt fails when idle for
 * {@link GENERATE_IDLE_TIMEOUT_MS} or past its cap {@link GENERATE_ATTEMPT_MAX_MS}, and a spec that fails
 * validation gets one repair turn ({@link MAX_GENERATE_ATTEMPTS} attempts in all). Upstream's v0.13.4 editor gave up
 * after a hard-coded 200 s against its 360 s worst case (spec §19 defect 12); ours derives the client fallback from the
 * same constants, {@link GENERATE_CLIENT_TIMEOUT_MS} = attempts × cap + {@link GENERATE_CLIENT_GRACE_MS} = 620 s
 * (380 s before UB2.9), so the server's own timeouts and its `tasks:generated` push always land first.
 *
 * {@link GENERATE_PERMISSION_MODE} is NESSY: the draft authors in `dontAsk` whatever the request asks for — the one
 * mode that never raises a card on any runtime, so an unattended authoring turn cannot hang on a prompt nobody sees,
 * and runs only what a rule pre-approves (spec §11; upstream seeded the draft with the editor's mode). On adoption the
 * draft takes the editor's mode (`rpc/tasks.ts` `tasks:create`).
 *
 * Renderer-safe: no Node import (the renderer takes `@nessy-agent/shared/tasks/generate-limits`; the `./tasks`
 * barrel carries `fs`).
 */
import type { PermissionMode } from '../agent/mode-types.ts'

/** UB2.9 (B4-14) — one authoring turn fails when it shows NO ACTIVITY for this long (upstream
 * `GENERATE_IDLE_TIMEOUT_MS`): a turn that is slow but still writing never hits it. */
export const GENERATE_IDLE_TIMEOUT_MS = 90_000

/** UB2.9 (B4-14) — one authoring turn's hard cap, activity or not (upstream `GENERATE_ATTEMPT_MAX_MS`). */
export const GENERATE_ATTEMPT_MAX_MS = 300_000

/** UA4.5 — the pre-UB2.9 fixed per-attempt wait, kept for the option's shape until its last reader is gone. */
export const GENERATE_TIMEOUT_MS = 180_000

/** The initial authoring turn plus one feedback-driven repair turn (upstream `MAX_GENERATE_ATTEMPTS`). */
export const MAX_GENERATE_ATTEMPTS = 2

/** How much longer than the server's worst case the editor waits before it gives up locally. */
export const GENERATE_CLIENT_GRACE_MS = 20_000

/**
 * The editor's fallback: the server's worst case plus the grace. UB2.9 re-derives the worst case
 * from the cap (attempts × {@link GENERATE_ATTEMPT_MAX_MS} = 600 s; 620 s with the grace), so the
 * server's own timeouts and its `tasks:generated` push always land first. (Was 2 × 180 + 20 = 380 s.)
 */
export const GENERATE_CLIENT_TIMEOUT_MS = MAX_GENERATE_ATTEMPTS * GENERATE_ATTEMPT_MAX_MS + GENERATE_CLIENT_GRACE_MS

/** The mode every Generate draft authors in, whatever the request carries (module header). */
export const GENERATE_PERMISSION_MODE: PermissionMode = 'dontAsk'
