export async function restoreSessionFileWatch(
  sessionId: string,
  reloadFiles: () => Promise<void>,
  rootPath?: string,
): Promise<void> {
  try {
    await window.electronAPI.watchSessionFiles(sessionId, rootPath)
  } catch (error) {
    console.error(`[SessionFiles] Failed to restore file watch for ${sessionId}:`, error)
  }

  try {
    await reloadFiles()
  } catch (error) {
    console.error(`[SessionFiles] Failed to reload files for ${sessionId} after reconnect:`, error)
  }
}
