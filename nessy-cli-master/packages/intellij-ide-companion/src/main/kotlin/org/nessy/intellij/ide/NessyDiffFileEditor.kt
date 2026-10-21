package org.nessy.intellij.ide

import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.Key
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.LightVirtualFile
import com.intellij.ui.EditorNotificationPanel
import java.beans.PropertyChangeListener
import java.nio.file.Path
import javax.swing.JComponent
import javax.swing.JPanel
import java.awt.BorderLayout

class NessyDiffVirtualFile(
  val filePath: String,
  val diffRequest: SimpleDiffRequest,
  val proposedDocument: Document,
  val onAccepted: () -> Unit,
  val onRejected: () -> Unit,
) : LightVirtualFile("Diff: ${Path.of(filePath).fileName}") {
  init {
    isWritable = false
  }

  override fun equals(other: Any?): Boolean {
    if (this === other) return true
    if (other !is NessyDiffVirtualFile) return false
    return filePath == other.filePath
  }

  override fun hashCode() = filePath.hashCode()
}

class NessyDiffEditorProvider : FileEditorProvider, DumbAware {
  override fun accept(project: Project, file: VirtualFile) = file is NessyDiffVirtualFile

  override fun createEditor(project: Project, file: VirtualFile): FileEditor {
    return NessyDiffEditor(project, file as NessyDiffVirtualFile)
  }

  override fun getEditorTypeId() = "nessy-diff-editor"

  override fun getPolicy() = FileEditorPolicy.HIDE_DEFAULT_EDITOR
}

class NessyDiffEditor(
  private val project: Project,
  private val diffFile: NessyDiffVirtualFile,
) : FileEditor {
  private val userData = UserDataHolderBase()

  override fun <T : Any?> getUserData(key: Key<T>): T? = userData.getUserData(key)

  override fun <T : Any?> putUserData(key: Key<T>, value: T?) = userData.putUserData(key, value)
  private val disposable = Disposer.newDisposable("nessyDiffEditor")
  private val diffPanel = DiffManager.getInstance().createRequestPanel(project, disposable, null)
  private val mainPanel: JPanel

  init {
    diffPanel.setRequest(diffFile.diffRequest)

    val banner = EditorNotificationPanel().apply {
      text = "Proposed changes: ${Path.of(diffFile.filePath).fileName}"
      createActionLabel("Accept") {
        diffFile.onAccepted()
      }
      createActionLabel("Reject") {
        diffFile.onRejected()
      }
    }

    mainPanel = JPanel(BorderLayout()).apply {
      add(banner, BorderLayout.NORTH)
      add(diffPanel.component, BorderLayout.CENTER)
    }
  }

  override fun getComponent(): JComponent = mainPanel

  override fun getPreferredFocusedComponent(): JComponent = diffPanel.component

  override fun getName() = "Nessy Diff"

  override fun setState(state: FileEditorState) {}

  override fun isModified() = false

  override fun isValid() = true

  override fun addPropertyChangeListener(listener: PropertyChangeListener) {}

  override fun removePropertyChangeListener(listener: PropertyChangeListener) {}

  override fun getFile() = diffFile

  override fun dispose() {
    Disposer.dispose(disposable)
  }
}
