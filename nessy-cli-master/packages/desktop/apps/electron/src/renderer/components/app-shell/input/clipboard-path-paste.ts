// [nessy-fork] desktop-clipboard-path-paste
interface ClipboardPathApi {
  getFilePath?(file: File): string | null;
  getClipboardFilePaths?(): string[];
}

function isAbsolutePath(path: string): boolean {
  return (
    path.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith('\\\\')
  );
}

export function resolveClipboardPathPaste(
  files: File[],
  api: ClipboardPathApi | undefined,
  isLocalWorkspace: boolean,
): string[] | null {
  if (!isLocalWorkspace || !api) return null;

  const directPaths = files.map((file) => api.getFilePath?.(file) ?? null);
  if (
    directPaths.length > 0 &&
    directPaths.every(
      (path): path is string => path !== null && isAbsolutePath(path),
    )
  ) {
    return directPaths;
  }
  if (directPaths.some((path) => path !== null)) return null;

  try {
    const clipboardPaths = api.getClipboardFilePaths?.() ?? [];
    return clipboardPaths.length > 0 && clipboardPaths.every(isAbsolutePath)
      ? clipboardPaths
      : null;
  } catch {
    return null;
  }
}
