package org.nessy.intellij.ide

import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import java.util.UUID

/**
 * Provides environment variables for the integrated terminal
 * to help CLI detect that it's running inside IntelliJ IDEA.
 */
@Service(Service.Level.PROJECT)
class IdeEnvironmentProvider(private val project: Project) : Disposable {
  private val logger = Logger.getInstance(IdeEnvironmentProvider::class.java)
  
  /**
   * Unique session ID for this terminal session
   */
  val terminalSessionId: String = UUID.randomUUID().toString()
  
  /**
   * Name of the IDE (IntelliJ IDEA, WebStorm, PyCharm, etc.)
   */
  val ideName: String = System.getProperty("idea.product.name", "IntelliJ IDEA")
  
  /**
   * Get environment variables that should be set in the integrated terminal
   */
  fun getEnvironmentVariables(): Map<String, String> {
    return mapOf(
      "JB_IDE_NAME" to ideName,
      "JB_TERMINAL_SESSION_ID" to terminalSessionId
    )
  }
  
  override fun dispose() {
    // Cleanup if needed
  }
}
