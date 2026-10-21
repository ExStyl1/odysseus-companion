import { stat } from 'fs/promises'

/**
 * The documented filename enum for `CLAUDE_CODE_GIT_BASH_PATH`
 * (troubleshoot-install.md: "Claude Code accepts only a file named `bash.exe`,
 * `sh.exe`, `bash`, or `sh`"). Case-insensitive; membership is tested on the
 * basename.
 */
const ACCEPTED_GIT_BASH_FILENAMES = new Set(['bash.exe', 'sh.exe', 'bash', 'sh'])

/**
 * Basename-in-enum validation for Git Bash executable paths
 * (troubleshoot-install.md's four accepted names). Splits BOTH separators by
 * hand — `path.basename` does not split `\` on POSIX, and the cross-platform
 * tests rely on Windows-style paths validating everywhere.
 */
export function isGitBashExecutablePath(filePath: string): boolean {
  const base = filePath.trim().split(/[\\/]/).pop() ?? ''
  return ACCEPTED_GIT_BASH_FILENAMES.has(base.toLowerCase())
}

/**
 * Validate a user-provided Git Bash executable path.
 * Enforces the documented filename enum and existence on disk. The existence
 * half deliberately stays strict: the bundled Claude Agent SDK still
 * `process.exit(1)`s on a missing path, so refusing here is protective.
 */
export async function validateGitBashPath(filePath: string): Promise<{ valid: true; path: string } | { valid: false; error: string }> {
  const trimmedPath = filePath.trim()

  if (!isGitBashExecutablePath(trimmedPath)) {
    return { valid: false, error: 'Path must point to bash.exe, sh.exe, bash, or sh' }
  }

  try {
    const info = await stat(trimmedPath)
    if (!info.isFile()) {
      return { valid: false, error: 'Path must point to a file' }
    }
    return { valid: true, path: trimmedPath }
  } catch {
    return { valid: false, error: 'File does not exist at the specified path' }
  }
}

/**
 * Check if a Git Bash path is usable without returning UI-facing errors.
 */
export async function isUsableGitBashPath(filePath: string): Promise<boolean> {
  const result = await validateGitBashPath(filePath)
  return result.valid
}
