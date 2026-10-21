package org.nessy.intellij

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.wm.ex.ToolWindowManagerListener
import com.intellij.ui.content.Content
import com.intellij.ui.content.ContentFactory
import com.intellij.util.messages.MessageBusConnection

class NessyToolWindowFactory : ToolWindowFactory {
  override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
    val (content, panel) = createPanel(project, toolWindow)
    toolWindow.contentManager.addContent(content)
    toolWindow.contentManager.setSelectedContent(content, true)
    panel.requestNewSession(clearHistory = true)
    installEmptyContentWatcher(project, toolWindow)
  }

  private fun createPanel(
    project: Project,
    toolWindow: ToolWindow,
  ): Pair<Content, NessyToolWindowPanel> {
    var contentRef: Content? = null
    lateinit var panel: NessyToolWindowPanel
    val newTabHandler = {
      val (newContent, newPanel) = createPanel(project, toolWindow)
      toolWindow.contentManager.addContent(newContent)
      toolWindow.contentManager.setSelectedContent(newContent, true)
      newPanel.requestNewSession(clearHistory = true)
    }
    panel = NessyToolWindowPanel(project, { title ->
      contentRef?.displayName = title
      toolWindow.title = title
    }, newTabHandler)
    val content = ContentFactory.getInstance().createContent(panel, "New Chat", false)
    content.isCloseable = true
    contentRef = content
    content.setDisposer(panel)
    return content to panel
  }

  private fun installEmptyContentWatcher(project: Project, toolWindow: ToolWindow) {
    val contentManager = toolWindow.contentManager
    var wasVisible = toolWindow.isVisible
    val connection: MessageBusConnection = project.messageBus.connect(toolWindow.disposable)
    connection.subscribe(
      ToolWindowManagerListener.TOPIC,
      object : ToolWindowManagerListener {
        override fun stateChanged(toolWindowManager: ToolWindowManager) {
          val current = toolWindowManager.getToolWindow(toolWindow.id) ?: return
          val isVisible = current.isVisible
          if (!wasVisible && isVisible && contentManager.contentCount == 0) {
            val (newContent, newPanel) = createPanel(project, toolWindow)
            contentManager.addContent(newContent)
            contentManager.setSelectedContent(newContent, true)
            newPanel.requestNewSession(clearHistory = true)
          }
          wasVisible = isVisible
        }
      },
    )
  }
}
