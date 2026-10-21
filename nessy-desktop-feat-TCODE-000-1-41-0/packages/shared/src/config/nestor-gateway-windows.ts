/**
 * The gateway context-window table, reachable from the renderer.
 *
 * ## Why this file exists at all
 *
 * The table itself lives in `auth/nestor.ts`, and it stays there: three readers
 * in three packages depend on that location, and moving it would be churn with
 * no gain. What was missing is a door.
 *
 * P3.79 recorded that the electron `nessy-gateway` preset "cannot import
 * `shared`", and seeded a hand-typed `262_144` for that reason — a number 144
 * tokens ABOVE the gateway's own reported window, which is the direction that
 * reproduces the bug the table exists to prevent. **Measured 2026-08-29, the
 * boundary is narrower than that.** The renderer resolves `@config/*` to
 * `packages/shared/src/config/*` in BOTH `apps/electron/vite.config.ts` and
 * `apps/electron/tsconfig.json`, and it already imports RUNTIME VALUES through
 * it — `getModelShortName` from `@config/models`, `resolveMidStreamBehavior`
 * from `@config/llm-connections`, the theme helpers from `@config/theme`. So the
 * renderer cannot reach `shared/src/auth/…`, but it can reach
 * `shared/src/config/…`, and the table was one directory out of reach rather
 * than behind a package boundary.
 *
 * **That last sentence is REFUTED and is kept only as history (DA1.28,
 * 2026-09-14).** The renderer CAN reach `shared/src/auth/…`, through the
 * exports-map key `@nessy-agent/shared/auth/nestor`: `apps/electron/tsconfig.json`
 * maps `@nessy-agent/shared/*` onto this package's sources, and Vite resolves
 * the same specifier through the workspace link and this package's `exports`
 * (it declares no alias for the scope, only for `@` and `@config`, which is why
 * the two mechanisms are named separately here rather than as one). A renderer
 * test has imported that specifier since DA1.10, and
 * `apps/electron/src/renderer/components/apisetup/nessy-gateway.ts` now imports
 * `NESTOR_GATEWAY_CHAT_BASE_URL` from it in PRODUCTION. So this module is a
 * convenience door, not the only one. It stays: it is the door three readers
 * already use, and deleting a re-export to make a point costs more than it
 * saves.
 *
 * This module is that one directory. It adds no logic and holds no number: it
 * re-exports, so the preset and the two backends read the same table and cannot
 * disagree about what the gateway's window is.
 *
 * Safe to pull into a browser bundle: `auth/nestor.ts` imports nothing but its
 * own generated snapshot, and both are pure data plus pure functions — no node
 * builtins, no credentials, no I/O.
 */
export {
  MIN_PLAUSIBLE_CONTEXT_WINDOW,
  NESTOR_GATEWAY_MODEL_WINDOWS,
  NESTOR_MODEL_SNAPSHOT_META,
  nestorGatewayModelWindow,
  sanitizeReportedContextWindow,
} from '../auth/nestor.ts';
