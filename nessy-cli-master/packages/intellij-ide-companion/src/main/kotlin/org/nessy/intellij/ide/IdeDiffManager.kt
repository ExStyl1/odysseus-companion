package org.nessy.intellij.ide

import com.intellij.diff.DiffContentFactory
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.util.SlowOperations
import com.intellij.openapi.fileTypes.FileTypeRegistry
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap

class IdeDiffManager(
  private val project: Project,
  private val onAccepted: (filePath: String, content: String) -> Unit,
  private val onRejected: (filePath: String) -> Unit,
  private val onClosed: (filePath: String, content: String?) -> Unit,
) {
  private val sessions = ConcurrentHashMap<String, DiffSession>()

  init {
    project.messageBus.connect().subscribe(
      FileEditorManagerListener.FILE_EDITOR_MANAGER,
      object : FileEditorManagerListener {
        override fun fileClosed(source: FileEditorManager, file: VirtualFile) {
          if (file is NessyDiffVirtualFile) {
            val session = sessions.remove(file.filePath)
            if (session != null) {
              onClosed(file.filePath, file.proposedDocument.text)
            }
          }
        }
      },
    )
  }

  fun showDiff(filePath: String, newContent: String) {
    showDiff(filePath, null, newContent)
  }

  fun showDiff(filePath: String, oldContentOverride: String?, newContent: String) {
    ApplicationManager.getApplication().invokeLater {
      val normalizedPath = normalizePath(filePath)
      val existing = sessions[normalizedPath]
      if (existing != null) {
        FileEditorManager.getInstance(project).openFile(existing.virtualFile, true)
        return@invokeLater
      }

      val oldContent = oldContentOverride ?: readOldContent(normalizedPath)
      val document = EditorFactory.getInstance().createDocument(newContent)
      val request = buildDiffRequest(normalizedPath, oldContent, document)
      lateinit var diffFile: NessyDiffVirtualFile
      diffFile = NessyDiffVirtualFile(
        normalizedPath, request, document,
        onAccepted = {
          sessions.remove(normalizedPath)
          onAccepted(normalizedPath, document.text)
          ApplicationManager.getApplication().invokeLater {
            FileEditorManager.getInstance(project).closeFile(diffFile)
            // Schedule a delayed refresh so the CLI has time to write the file to disk
            scheduleFileRefresh(normalizedPath)
          }
        },
        onRejected = {
          sessions.remove(normalizedPath)
          onRejected(normalizedPath)
          ApplicationManager.getApplication().invokeLater {
            FileEditorManager.getInstance(project).closeFile(diffFile)
          }
        },
      )
      sessions[normalizedPath] = DiffSession(diffFile, document)
      FileEditorManager.getInstance(project).openFile(diffFile, true)
    }
  }

  fun closeDiff(filePath: String, suppressNotification: Boolean): String? {
    val normalizedPath = normalizePath(filePath)
    val session = sessions.remove(normalizedPath) ?: return null
    val content = session.document.text
    ApplicationManager.getApplication().invokeLater {
      FileEditorManager.getInstance(project).closeFile(session.virtualFile)
    }
    if (!suppressNotification) {
      onClosed(normalizedPath, content)
    }
    return content
  }

  fun closeAll(suppressNotification: Boolean) {
    val openSessions = sessions.entries.toList()
    for ((filePath, session) in openSessions) {
      if (!sessions.remove(filePath, session)) continue

      val content = session.document.text
      ApplicationManager.getApplication().invokeLater {
        FileEditorManager.getInstance(project).closeFile(session.virtualFile)
      }
      if (!suppressNotification) {
        onClosed(filePath, content)
      }
    }
  }

  private fun buildDiffRequest(filePath: String, oldContent: String, document: com.intellij.openapi.editor.Document): SimpleDiffRequest {
    val contentFactory = DiffContentFactory.getInstance()
    val fileType = FileTypeRegistry.getInstance().getFileTypeByFileName(filePath)
    val oldDiff = contentFactory.create(project, oldContent, fileType)
    val newDiff = contentFactory.create(project, document, fileType)
    val title = Path.of(filePath).fileName.toString()
    return SimpleDiffRequest(title, oldDiff, newDiff, "Original", "Proposed")
  }

  private fun readOldContent(filePath: String): String {
    return SlowOperations.allowSlowOperations<String, Exception> {
      val virtualFile = LocalFileSystem.getInstance().findFileByPath(filePath)
      if (virtualFile != null && virtualFile.exists()) {
        return@allowSlowOperations runCatching { String(virtualFile.contentsToByteArray()) }.getOrDefault("")
      }
      runCatching { Files.readString(Path.of(filePath)) }.getOrDefault("")
    }
  }

  private fun normalizePath(filePath: String): String {
    val path = Path.of(filePath)
    val resolvedPath = if (path.isAbsolute) {
      path
    } else {
      project.basePath?.let { Path.of(it).resolve(path) } ?: path
    }
    return resolvedPath.normalize().toString()
  }

  private fun scheduleFileRefresh(filePath: String) {
    // CLI writes the file after receiving the diffAccepted notification,
    // so we need to wait briefly before refreshing the VirtualFile
    com.intellij.util.Alarm(com.intellij.util.Alarm.ThreadToUse.POOLED_THREAD, project).addRequest({
      ApplicationManager.getApplication().invokeLater {
        LocalFileSystem.getInstance().findFileByPath(filePath)?.refresh(false, false)
      }
    }, 500)
  }

  private data class DiffSession(
    val virtualFile: NessyDiffVirtualFile,
    val document: com.intellij.openapi.editor.Document,
  )
}
