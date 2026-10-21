package org.nessy.intellij.ide

import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

/**
 * Initializes the IdeMcpServerService when a project is opened.
 * This ensures the MCP server starts and creates the lock file immediately.
 */
class IdeStartupActivity : ProjectActivity {
  private val logger = Logger.getInstance(IdeStartupActivity::class.java)

  override suspend fun execute(project: Project) {
    try {
      // Force initialization of the MCP server service
      val mcpServer = project.getService(IdeMcpServerService::class.java)
      logger.info("IdeMcpServerService initialized on port ${mcpServer.getPort()}")
    } catch (e: Exception) {
      logger.warn("Failed to initialize IdeMcpServerService: ${e.message}", e)
    }
  }
}
