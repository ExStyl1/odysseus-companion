/**
 * Guard a headless server against runtime paths inherited from a running Nessy app.
 *
 * Copied from `v0.15.1:packages/server-core/src/runtime/inherited-app-env.ts`
 * (first shipped v0.15.0, silent; UB7.13; rebranded CRAFT_ → NESSY_, Craft → Nessy).
 *
 * The desktop app publishes its own locations on `process.env` (NESSY_APP_ROOT,
 * NESSY_RESOURCES_BASE, NESSY_UV, NESSY_BUN, NESSY_SCRIPTS, …) so the tools it spawns find
 * them, and every agent shell inherits them. A server started from such a shell (an agent
 * testing a branch in another worktree) would then resolve the Pi server bundle, the native
 * `claude` binary, uv and bun from the APP's checkout and silently run that code instead of
 * its own.
 *
 * Only applies when this server runs from a source checkout: bundled servers (Docker,
 * `scripts/build-server.ts`) set NESSY_APP_ROOT themselves and keep honoring it.
 */
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

export interface InheritedAppEnvResolution {
  /** Root to resolve bundled runtimes from. */
  appRootPath: string
  /** NESSY_APP_ROOT that was ignored because it points into another checkout. */
  ignoredAppRoot?: string
  /** NESSY_* variables to drop: paths inside the ignored checkout. */
  dropKeys: string[]
}

/**
 * This module's folder. `__dirname`, not `import.meta.dir`: Bun defines it in ES modules too,
 * and the Electron main bundle is CommonJS, where esbuild empties `import.meta` (the bundle's
 * own folder is returned there, which never holds a checkout).
 */
const MODULE_DIR: string | null = typeof __dirname === 'string' ? __dirname : null

/** The monorepo root when `server-core` runs from source, else null (bundled builds). */
export function sourceCheckoutRoot(moduleDir: string | null = MODULE_DIR): string | null {
  if (!moduleDir) return null
  const root = resolve(moduleDir, '..', '..', '..', '..')
  return existsSync(join(root, 'packages', 'server-core', 'package.json')) ? root : null
}

export function isPathInside(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function resolveInheritedAppEnv(
  env: Record<string, string | undefined>,
  sourceRoot: string | null,
  cwd: string,
): InheritedAppEnvResolution {
  const configured = env.NESSY_APP_ROOT?.trim()
  if (!sourceRoot || !configured || isPathInside(resolve(configured), sourceRoot)) {
    return { appRootPath: configured || cwd, dropKeys: [] }
  }

  const foreignRoot = resolve(configured)
  const dropKeys = Object.keys(env).filter((key) => {
    const value = env[key]?.trim()
    return key.startsWith('NESSY_') && !!value && isAbsolute(value) && isPathInside(resolve(value), foreignRoot)
  })
  return {
    appRootPath: isPathInside(resolve(cwd), sourceRoot) ? cwd : sourceRoot,
    ignoredAppRoot: foreignRoot,
    dropKeys,
  }
}
