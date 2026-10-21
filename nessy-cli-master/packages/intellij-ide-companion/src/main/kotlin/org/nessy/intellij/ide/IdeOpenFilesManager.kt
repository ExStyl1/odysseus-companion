package org.nessy.intellij.ide

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.openapi.Disposable
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.CaretEvent
import com.intellij.openapi.editor.event.CaretListener
import com.intellij.openapi.editor.event.SelectionEvent
import com.intellij.openapi.editor.event.SelectionListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.fileEditor.TextEditor
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.math.min

class IdeOpenFilesManager(
  private val project: Project,
  private val parentDisposable: Disposable,
) {
  private val logger = Logger.getInstance(IdeOpenFilesManager::class.java)
  private val listeners = CopyOnWriteArrayList<() -> Unit>()
  private val openFilesLock = Any()
  private val openFiles = ArrayList<JsonObject>()

  init {
    subscribeListeners()
    syncOpenFiles()
    addActiveEditor()
  }

  fun addListener(listener: () -> Unit) {
    listeners.add(listener)
  }

  fun removeListener(listener: () -> Unit) {
    listeners.remove(listener)
  }

  fun toJson(): JsonObject {
    val files = JsonArray()
    val snapshot = synchronized(openFilesLock) {
      openFiles.map { it.deepCopy() as JsonObject }
    }
    for (entry in snapshot) {
      files.add(entry)
    }

    return JsonObject().apply {
      add(
        "workspaceState",
        JsonObject().apply {
          add("openFiles", files)
        },
      )
    }
  }

  private fun notifyChanged() {
    listeners.forEach { listener ->
      runSafely("open files listener") {
        listener.invoke()
      }
    }
  }

  private fun subscribeListeners() {
    val bus = project.messageBus.connect(parentDisposable)
    bus.subscribe(
      FileEditorManagerListener.FILE_EDITOR_MANAGER,
      object : FileEditorManagerListener {
        override fun fileOpened(source: FileEditorManager, file: VirtualFile) {
          runSafely("fileOpened") {
            if (file.isInLocalFileSystem) {
              addFileIfMissing(file.path)
              notifyChanged()
            }
          }
        }

        override fun selectionChanged(event: FileEditorManagerEvent) {
          runSafely("selectionChanged") {
            val editor = (event.newEditor as? TextEditor)?.editor
              ?: FileEditorManager.getInstance(project).selectedTextEditor
            updateActiveEditor(editor)
          }
        }

        override fun fileClosed(source: FileEditorManager, file: VirtualFile) {
          runSafely("fileClosed") {
            if (file.isInLocalFileSystem) {
              removeFile(file.path)
              notifyChanged()
            }
          }
        }
      },
    )

    val caretListener = object : CaretListener {
      override fun caretPositionChanged(event: CaretEvent) {
        runSafely("caretPositionChanged") {
          updateActiveEditor(event.editor)
        }
      }
    }
    EditorFactory.getInstance().eventMulticaster.addCaretListener(caretListener, parentDisposable)

    val selectionListener = object : SelectionListener {
      override fun selectionChanged(event: SelectionEvent) {
        runSafely("editorSelectionChanged") {
          updateActiveEditor(event.editor)
        }
      }
    }
    EditorFactory.getInstance().eventMulticaster.addSelectionListener(selectionListener, parentDisposable)
  }

  private fun addActiveEditor() {
    val editor = FileEditorManager.getInstance(project).selectedTextEditor
    updateActiveEditor(editor)
  }

  private fun syncOpenFiles() {
    val editorManager = FileEditorManager.getInstance(project)
    editorManager.openFiles.filter { it.isInLocalFileSystem }.forEach { file ->
      addFileIfMissing(file.path)
    }
  }

  private fun updateActiveEditor(editor: Editor?) {
    val app = com.intellij.openapi.application.ApplicationManager.getApplication()
    if (!app.isDispatchThread && !app.isReadAccessAllowed) {
      app.runReadAction { updateActiveEditor(editor) }
      return
    }

    val document = editor?.document
    val file = document?.let { FileDocumentManager.getInstance().getFile(it) }
    if (file == null || !file.isInLocalFileSystem) {
      clearActiveFlags()
      notifyChanged()
      return
    }

    val caret = editor.caretModel.logicalPosition
    val cursor = JsonObject().apply {
      addProperty("line", caret.line + 1)
      addProperty("character", caret.column + 1)
    }
    val selectedText = truncateSelection(editor.selectionModel.selectedText)

    moveToFront(file.path, isActive = true, cursor = cursor, selectedText = selectedText)
    notifyChanged()
  }

  private fun moveToFront(
    path: String,
    isActive: Boolean,
    cursor: JsonObject?,
    selectedText: String?,
  ) {
    synchronized(openFilesLock) {
      clearActiveFlagsLocked()
      val existingIndex = openFiles.indexOfFirst { it.pathValue() == path }
      if (existingIndex != -1) {
        openFiles.removeAt(existingIndex)
      }
      openFiles.add(0, createFileEntry(path, isActive, cursor, selectedText))
      trimOpenFilesLocked()
    }
  }

  private fun addFileIfMissing(path: String) {
    synchronized(openFilesLock) {
      val existingIndex = openFiles.indexOfFirst { it.pathValue() == path }
      if (existingIndex != -1) {
        return
      }
      openFiles.add(createFileEntry(path, isActive = false, cursor = null, selectedText = null))
      trimOpenFilesLocked()
    }
  }

  private fun clearActiveFlags() {
    synchronized(openFilesLock) {
      clearActiveFlagsLocked()
    }
  }

  private fun removeFile(path: String) {
    synchronized(openFilesLock) {
      val idx = openFiles.indexOfFirst { it.pathValue() == path }
      if (idx != -1) {
        openFiles.removeAt(idx)
      }
    }
  }

  private fun clearActiveFlagsLocked() {
    openFiles.forEach { entry ->
      entry.remove("isActive")
      entry.remove("cursor")
      entry.remove("selectedText")
    }
  }

  private fun trimOpenFilesLocked() {
    if (openFiles.size > MAX_FILES) {
      openFiles.subList(MAX_FILES, openFiles.size).clear()
    }
  }

  private fun createFileEntry(
    path: String,
    isActive: Boolean,
    cursor: JsonObject?,
    selectedText: String?,
  ): JsonObject {
    return JsonObject().apply {
      addProperty("path", path)
      addProperty("timestamp", System.currentTimeMillis())
      if (isActive) addProperty("isActive", true)
      if (cursor != null) add("cursor", cursor)
      if (selectedText != null) addProperty("selectedText", selectedText)
    }
  }

  private fun JsonObject.pathValue(): String? = get("path")?.asString

  private fun runSafely(action: String, block: () -> Unit) {
    try {
      block()
    } catch (e: ProcessCanceledException) {
      throw e
    } catch (t: Throwable) {
      logger.warn("Failed to handle $action", t)
    }
  }

  private fun truncateSelection(selection: String?): String? {
    if (selection.isNullOrEmpty()) {
      return null
    }
    if (selection.length <= MAX_SELECTED_TEXT_LENGTH) {
      return selection
    }
    val truncated = selection.substring(0, min(selection.length, MAX_SELECTED_TEXT_LENGTH))
    return "$truncated... [TRUNCATED]"
  }

  private companion object {
    private const val MAX_FILES = 10
    private const val MAX_SELECTED_TEXT_LENGTH = 16_384
  }
}
