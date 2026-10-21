import { normalize, isAbsolute, sep } from 'path'
import { homedir, tmpdir } from 'os'
import { realpath } from 'fs/promises'
import type { ResolvedWorkspace, WorkspaceService } from '@nessy-agent/shared/workspaces'
import type { PlatformServices } from '../runtime/platform'

/**
 * Resolve an opaque Workspace ID through the verified-v2 service.
 * Use this when a workspace must exist for the operation to proceed.
 */
export function getWorkspaceOrThrow(workspaceService: WorkspaceService | undefined, workspaceId: string): ResolvedWorkspace {
  if (!workspaceService) throw new Error('Workspace service is unavailable')
  return workspaceService.resolve(workspaceId)
}

export function buildBackendHostRuntimeContext(platform: PlatformServices) {
  return {
    appRootPath: platform.appRootPath,
    resourcesPath: platform.resourcesPath,
    isPackaged: platform.isPackaged,
  }
}

/**
 * Sanitizes a filename to prevent path traversal and filesystem issues.
 * Removes dangerous characters and limits length.
 */
export function sanitizeFilename(name: string): string {
  return name
    // Remove path separators and traversal patterns
    .replace(/[/\\]/g, '_')
    // Remove Windows-forbidden characters: < > : " | ? *
    .replace(/[<>:"|?*]/g, '_')
    // Remove control characters (ASCII 0-31)
    .replace(/[\x00-\x1f]/g, '')
    // Collapse multiple dots (prevent hidden files and extension tricks)
    .replace(/\.{2,}/g, '.')
    // Remove leading/trailing dots and spaces (Windows issues)
    .replace(/^[.\s]+|[.\s]+$/g, '')
    // Limit length (200 chars is safe for all filesystems)
    .slice(0, 200)
    // Fallback if name is empty after sanitization
    || 'unnamed'
}

/**
 * Resolve the managed Workspace root through the verified-v2 service.
 * Project paths are authorized separately through opaque project handles.
 */
export function getWorkspaceAllowedDirs(
  workspaceService: WorkspaceService | undefined,
  workspaceId?: string | null,
): string[] {
  if (!workspaceService || !workspaceId) return []
  try {
    return [workspaceService.resolve(workspaceId).workspaceRootPath]
  } catch {
    return []
  }
}

/**
 * Validates that a file path is within allowed directories to prevent path traversal attacks.
 * Allowed directories: user's home directory, /tmp, and any additional dirs passed by the caller
 * (e.g. workspace root, workspace working directory).
 */
export async function validateFilePath(
  filePath: string,
  additionalAllowedDirs?: string[],
): Promise<string> {
  // Normalize the path to resolve . and .. components
  let normalizedPath = normalize(filePath)

  // Expand ~ to home directory
  if (normalizedPath.startsWith('~')) {
    normalizedPath = normalizedPath.replace(/^~/, homedir())
  }

  // Must be an absolute path
  if (!isAbsolute(normalizedPath)) {
    throw new Error('Only absolute file paths are allowed')
  }

  // Resolve symlinks to get the real path
  let realFilePath: string
  try {
    realFilePath = await realpath(normalizedPath)
  } catch {
    // File doesn't exist or can't be resolved - use normalized path
    realFilePath = normalizedPath
  }

  // Define allowed base directories
  const allowedDirs = [
    homedir(),
    tmpdir(),
    ...(additionalAllowedDirs ?? []),
  ].filter(Boolean)

  // Check if the real path is within an allowed directory (cross-platform)
  const isAllowed = allowedDirs.some(dir => {
    const normalizedDir = normalize(dir)
    const normalizedReal = normalize(realFilePath)
    return normalizedReal.startsWith(normalizedDir + sep) || normalizedReal === normalizedDir
  })

  if (!isAllowed) {
    throw new Error('Access denied: file path is outside allowed directories')
  }

  // Block sensitive files even within allowed directories.
  // Use [\\/] to match both Unix / and Windows \ separators.
  const sensitivePatterns = [
    /\.ssh[\\/]/,
    /\.gnupg[\\/]/,
    /\.aws[\\/]credentials/,
    /\.env$/,
    /\.env\./,
    /credentials\.json$/,
    /secrets?\./i,
    /\.pem$/,
    /\.key$/,
  ]

  if (sensitivePatterns.some(pattern => pattern.test(realFilePath))) {
    throw new Error('Access denied: cannot read sensitive files')
  }

  return realFilePath
}
