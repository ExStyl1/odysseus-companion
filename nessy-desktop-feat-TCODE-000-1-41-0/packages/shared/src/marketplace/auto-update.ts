/**
 * The post-startup marketplace auto-update check.
 *
 * Contract: `discover-plugins.md` § Configure auto-updates, fetched 2026-08-07.
 *
 * `:445` — "Claude Code checks for marketplace and plugin updates after your
 * session starts, with a random delay of up to ten minutes, so the running
 * session keeps using the versions it loaded at launch. If any plugins were
 * updated, you'll see a notification prompting you to run `/reload-plugins`, or
 * the new versions load on your next launch."
 *
 * `:458` — "To disable all automatic updates entirely for both Claude Code and
 * all plugins, set the `DISABLE_AUTOUPDATER` environment variable."
 *
 * `:460` — "To keep plugin auto-updates enabled while disabling Claude Code
 * auto-updates, set `FORCE_AUTOUPDATE_PLUGINS=1` along with
 * `DISABLE_AUTOUPDATER`".
 *
 * The delay IS the contract, not an implementation detail: it is the mechanism
 * by which the running session keeps the versions it loaded at launch. Every
 * clock here is therefore injected rather than reached for, so the behaviour can
 * be proven without a test that sleeps — and so nobody is tempted to shorten the
 * delay to make testing easier, which would delete the guarantee.
 */

import { parseBooleanEnv } from '../feature-flags.ts';

/** `:445` — "a random delay of up to ten minutes". */
export const MARKETPLACE_AUTO_UPDATE_MAX_DELAY_MS = 10 * 60 * 1000;

/**
 * The `capabilities.CHANGED` reason code a BACKGROUND marketplace refresh
 * carries, distinct from the `plugin-runtime-changed` every interactive
 * mutation carries. Lives here, in the leaf both sides can import, so the
 * emitter (server-core) and the renderer notice cannot drift apart on a
 * string literal.
 */
export const MARKETPLACE_AUTO_UPDATE_REASON_CODE = 'marketplace-auto-updated';

export type MarketplaceAutoUpdateGate =
  /** No env said otherwise: the check runs. */
  | { run: true; reason: 'default' }
  /** `DISABLE_AUTOUPDATER` is set AND `FORCE_AUTOUPDATE_PLUGINS=1` overrides it. */
  | { run: true; reason: 'forced' }
  /** `DISABLE_AUTOUPDATER` is set with no override. */
  | { run: false; reason: 'disabled-by-env' };

export type MarketplaceAutoUpdateEnv = Readonly<Record<string, string | undefined>>;

/**
 * `:458`/`:460`'s two-variable decision.
 *
 * `FORCE_AUTOUPDATE_PLUGINS` is documented as an escape hatch FROM
 * `DISABLE_AUTOUPDATER`, so it is read only when the disable switch is on. On
 * its own it is not a second way to turn anything on — there is nothing to turn
 * on, the check already runs.
 */
export function resolveMarketplaceAutoUpdateGate(
  env: MarketplaceAutoUpdateEnv,
): MarketplaceAutoUpdateGate {
  if (parseBooleanEnv(env.DISABLE_AUTOUPDATER) !== true) return { run: true, reason: 'default' };
  if (parseBooleanEnv(env.FORCE_AUTOUPDATE_PLUGINS) === true) return { run: true, reason: 'forced' };
  return { run: false, reason: 'disabled-by-env' };
}

export interface ScheduleMarketplaceAutoUpdateOptions {
  /**
   * The pass itself.
   *
   * It must NAME its own failures before it returns — the swallow below is a
   * floor against an unhandled rejection, not a reporting channel, and it has
   * nothing to report with (this leaf has no logger by design). P2.184: the
   * composition in `server-core/handlers/rpc/marketplace-auto-update.ts` wraps
   * its whole body and writes one `MARKETPLACE_AUTO_UPDATE:` warn line.
   */
  run: () => Promise<unknown>;
  env: MarketplaceAutoUpdateEnv;
  /** Injected `Math.random` (test seam). Values outside `[0, 1)` are clamped. */
  random?: () => number;
  /**
   * Injected timer (test seam). Production passes a `setTimeout` whose handle is
   * `unref`'d so a pending check can never hold the process open.
   */
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Delay ceiling override (test seam only — `:445` fixes it at ten minutes). */
  maxDelayMs?: number;
}

export interface ScheduledMarketplaceAutoUpdate {
  /** `false` when the env gate refused; nothing was scheduled. */
  scheduled: boolean;
  gate: MarketplaceAutoUpdateGate;
  /** The delay actually chosen, for the log line. Zero when nothing was scheduled. */
  delayMs: number;
  /** Idempotent. Safe to call after the check has already fired. */
  cancel: () => void;
}

/**
 * Arm the one post-startup check. Returns immediately; the pass runs later, in
 * the background, exactly once.
 */
export function scheduleMarketplaceAutoUpdate(
  options: ScheduleMarketplaceAutoUpdateOptions,
): ScheduledMarketplaceAutoUpdate {
  const gate = resolveMarketplaceAutoUpdateGate(options.env);
  if (!gate.run) return { scheduled: false, gate, delayMs: 0, cancel: () => {} };

  const maxDelayMs = options.maxDelayMs ?? MARKETPLACE_AUTO_UPDATE_MAX_DELAY_MS;
  const raw = options.random?.() ?? Math.random();
  // A random source that misbehaves must not become a zero-delay check that
  // re-fetches while the session is still starting.
  const fraction = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 1;
  const delayMs = Math.floor(fraction * maxDelayMs);

  const setTimer = options.setTimer ?? defaultSetTimer;
  const clearTimer = options.clearTimer ?? defaultClearTimer;
  let cancelled = false;
  const handle = setTimer(() => {
    if (cancelled) return;
    void Promise.resolve()
      .then(() => options.run())
      .catch(() => {
        // A background check must never surface as an unhandled rejection.
        //
        // P2.184 — this comment used to end "the pass logs its own failures",
        // and that sentence was FALSE for everything outside the pass's
        // per-plugin loops: a throw from the catalog refresh or the
        // invalidation emit landed here and produced no line anywhere. The
        // sentence is now true because the pass was changed, not because the
        // comment was: `startMarketplaceAutoUpdate` wraps its whole body and
        // names the failure on the logger it already writes to. This stays a
        // last-resort floor for a `run` that breaks that contract, and the
        // contract is stated on the option rather than assumed here.
      });
  }, delayMs);

  return {
    scheduled: true,
    gate,
    delayMs,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      clearTimer(handle);
    },
  };
}

function defaultSetTimer(callback: () => void, delayMs: number): unknown {
  const handle = setTimeout(callback, delayMs);
  // A ten-minute pending check must not keep a headless server alive.
  (handle as { unref?: () => void }).unref?.();
  return handle;
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}
