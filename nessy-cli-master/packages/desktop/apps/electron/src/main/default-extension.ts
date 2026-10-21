const DEFAULT_EXTENSION_SOURCE = '@nestor/nessy-cli-extensions'

// [nessy-fork] desktop-first-run-setup
export function hasDefaultExtension(output: string): boolean {
  try {
    const extensions: unknown = JSON.parse(output)
    return (
      Array.isArray(extensions) &&
      extensions.some(
        (extension) =>
          extension !== null &&
          typeof extension === 'object' &&
          'source' in extension &&
          extension.source === DEFAULT_EXTENSION_SOURCE,
      )
    )
  } catch {
    return false
  }
}
