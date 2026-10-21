/**
 * F1.424 — the ONE teardown guard for suites that run a REAL plugin-store
 * install, and the budget it travels with.
 *
 * ## The lottery this closes
 *
 * About twenty suites build a real `PluginStoreV2` + `PluginManagementServiceV2`
 * and install a `local-path` bundle — an fs copy into a staging root — under
 * bun's 5 000 ms default, then remove their temp root in a synchronous
 * `afterEach`. When a case times out, bun runs `afterEach` while the case's
 * install is STILL COPYING, the root goes, and the orphaned install surfaces as
 * an unhandled `ENOENT … copyfile …/staging/…` charged to whichever case runs
 * next. Measured by WJ-y on `plugin-capability-runtime.test.ts` (2026-09-23
 * 14:36, 8-file batch, load 10.7) and fixed there alone by F1.268; this module
 * is that fix made shared, for the siblings the F1.268 verifier listed.
 *
 * ## The recipe — both halves, every caller
 *
 * ```ts
 * import { afterEach, setDefaultTimeout } from 'bun:test'
 * import { MODULE_GRAPH_CASE_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
 * import { createInstallTracker } from '@nessy-agent/shared/testing/install-tracker'
 * setDefaultTimeout(MODULE_GRAPH_CASE_BUDGET_MS)
 * const installs = createInstallTracker()
 * afterEach(async () => { await installs.settle(); rmSync(root, …) })
 * // …and wherever the suite builds its service:
 * const service = installs.track(new PluginManagementServiceV2({ … }))
 * ```
 *
 * - **The budget** is the budgets module's per-CASE shape, imported rather than
 *   copied — the import is ordinary and the cases are not, which is exactly the
 *   shape `MODULE_GRAPH_CASE_BUDGET_MS` names. It stays visible at the call site,
 *   as that module asks. It removes the timeout.
 * - **The tracker** removes the race even when a case DOES time out: `track`
 *   wraps the service so every promise any of its methods returns is held until
 *   it settles, and `settle` waits for all of them — including ones started
 *   while it waited — before the caller's teardown deletes anything. Wrapping
 *   the SERVICE rather than each call is deliberate: one line per suite covers
 *   every `install`, `update`, `repair` and `uninstall` it will ever make, where
 *   a per-call wrapper is one line per call site and the fifty-sixth is the one
 *   somebody forgets.
 *
 * ## What `track` does and does not change
 *
 * Every method runs on the ORIGINAL object (`this` is the target, so private
 * fields keep working); a method that returns a promise hands the caller a
 * promise that settles exactly as the original did — same value, same
 * rejection — and one the caller never awaits still rejects unhandled, as it
 * would have without the tracker. Non-function properties and synchronous
 * results pass through untouched. Nothing is retried, nothing is swallowed:
 * `settle` uses `allSettled`, so a rejected install is the case's failure to
 * report, never the teardown's.
 */

export type InstallTracker = {
  /** The same object, whose every promise-returning method is held until it settles. */
  track<T extends object>(target: T): T
  /** Waits until nothing tracked is still running. Call it before a teardown removes any root. */
  settle(): Promise<void>
  /** How many tracked promises are still running — for a test of the tracker itself. */
  readonly pending: number
}

export function createInstallTracker(): InstallTracker {
  const running = new Set<Promise<unknown>>()

  const hold = (result: Promise<unknown>): Promise<unknown> => {
    // The caller receives THIS promise, so its rejection is observed exactly
    // where the original's would have been — `finally` adds no handler of its own.
    const held: Promise<unknown> = result.finally(() => {
      running.delete(held)
    })
    running.add(held)
    return held
  }

  return {
    track<T extends object>(target: T): T {
      return new Proxy(target, {
        get(object, property) {
          const value: unknown = Reflect.get(object, property, object)
          if (typeof value !== 'function') return value
          return (...args: unknown[]): unknown => {
            const result: unknown = Reflect.apply(value as (...a: unknown[]) => unknown, object, args)
            return result instanceof Promise ? hold(result) : result
          }
        },
      })
    },
    async settle(): Promise<void> {
      // A loop, not one `allSettled`: an install that finishes can start the
      // next tracked call (a repair after an install), and that one counts too.
      while (running.size > 0) await Promise.allSettled([...running])
    },
    get pending(): number {
      return running.size
    },
  }
}
