import { existsSync } from 'fs'
import { join } from 'path'

// [nessy-fork] desktop-bundled-runtime-packaging
export function resolveBundledBunPath(
  resourcesBase: string,
  platform: NodeJS.Platform,
  arch: string,
): string | undefined {
  const bunName = platform === 'win32' ? 'bun.exe' : 'bun'
  const bunDir = join(resourcesBase, 'vendor', 'bun')
  const bundledPath = join(bunDir, `${platform}-${arch}`, bunName)

  if (existsSync(bundledPath)) return bundledPath

  const legacyPath = join(bunDir, bunName)
  return existsSync(legacyPath) ? legacyPath : undefined
}
