package org.nessy.intellij.settings

import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel

class NessySettingsConfigurable : Configurable {
  private var mainPanel: JPanel? = null
  private val nodePathField = JBTextField()

  override fun getDisplayName(): String = "Nessy CLI"

  override fun createComponent(): JComponent {
    val panel = FormBuilder.createFormBuilder()
      .addLabeledComponent("Node path (optional)", nodePathField)
      .panel
    mainPanel = panel
    return panel
  }

  override fun isModified(): Boolean {
    val settings = NessySettingsState.getInstance()
    return nodePathField.text != settings.nodePath
  }

  override fun apply() {
    val settings = NessySettingsState.getInstance()
    settings.nodePath = nodePathField.text.trim()
  }

  override fun reset() {
    val settings = NessySettingsState.getInstance()
    nodePathField.text = settings.nodePath
  }

  override fun disposeUIResources() {
    mainPanel = null
  }
}
