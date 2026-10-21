// [nessy-fork] desktop-extension-auto-update
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { mainLog } from './logger'

const execFileAsync = promisify(execFile)

// How often to re-check for extension updates while the app is running. Desktop
// sessions are long-lived (rarely restarted), so a single startup check is not
// enough — a background timer catches extensions published later.
const EXTENSION_AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000

let timer: NodeJS.Timeout | null = null
let inFlight = false

/**
 * Brings installed extensions up to date by shelling out to the vendored CLI
 * (`nessy extensions update --all`), mirroring the TUI's update-all behavior for
 * every installed extension. Fire-and-forget: failures are logged, never thrown,
 * so a network blip or a single blocked extension can't disrupt app startup.
 *
 * @param waitForFirstRunInstall resolves once the first-run default-extension
 *   install has settled, so the two CLI invocations never race on the shared
 *   ~/.nessy extension store. Resolves immediately when no first-run is pending.
 */
async function autoUpdateExtensions(
  waitForFirstRunInstall: () => Promise<void>,
): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    try {
      await waitForFirstRunInstall()
    } catch {
      // First-run prep failure is already logged; still attempt the update.
    }
    const cliPath = process.env.CRAFT_CLI_ENTRY
    const bunPath = process.env.CRAFT_BUN
    if (!cliPath || !bunPath) {
      mainLog.warn(
        '[autoUpdateExtensions] Vendored CLI or Bun runtime missing, skipping extension auto-update',
      )
      return
    }
    try {
      const { stdout } = await execFileAsync(
        bunPath,
        [cliPath, 'extensions', 'update', '--all'],
        { cwd: homedir(), env: process.env, timeout: 120000 },
      )
      const output = stdout.trim()
      if (output) {
        mainLog.info(`[autoUpdateExtensions] ${output}`)
      }
    } catch (error) {
      mainLog.warn(
        '[autoUpdateExtensions] Extension auto-update failed:',
        error instanceof Error ? error.message : String(error),
      )
    }
  } finally {
    inFlight = false
  }
}

/**
 * Runs the auto-update once immediately on startup, then periodically while the
 * app is open. Idempotent — a second call is a no-op until the process exits.
 */
export function scheduleExtensionAutoUpdate(
  waitForFirstRunInstall: () => Promise<void>,
): void {
  if (timer) return
  void autoUpdateExtensions(waitForFirstRunInstall)
  timer = setInterval(() => {
    void autoUpdateExtensions(waitForFirstRunInstall)
  }, EXTENSION_AUTO_UPDATE_INTERVAL_MS)
  timer.unref?.()
}