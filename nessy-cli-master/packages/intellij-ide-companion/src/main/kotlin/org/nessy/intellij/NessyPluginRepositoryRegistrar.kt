package org.nessy.intellij

import com.intellij.ide.ApplicationInitializedListener
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.updateSettings.impl.UpdateSettings
import kotlinx.coroutines.CoroutineScope
import org.nessy.intellij.settings.NessySettingsState

class NessyPluginRepositoryRegistrar : ApplicationInitializedListener {
  @Deprecated("Use [execute]", replaceWith = ReplaceWith("execute()"))
  override fun componentsInitialized() {
    registerPluginRepository()
  }

  @Suppress("unused")
  suspend fun execute() {
    registerPluginRepository()
  }

  override suspend fun execute(asyncScope: CoroutineScope) {
    registerPluginRepository()
  }

  private fun registerPluginRepository() {
    notifyOnPluginUpdate()

    val updateSettings = UpdateSettings.getInstance()
    val hosts = updateSettings.storedPluginHosts
    if (!hosts.contains(PLUGIN_REPOSITORY_URL)) {
      try {
        hosts.add(PLUGIN_REPOSITORY_URL)
        updateSettings.setPluginsCheckNeeded(true)
      } catch (error: Exception) {
        LOG.warn("Failed to register custom plugin repository: $PLUGIN_REPOSITORY_URL", error)
        return
      }
    }
  }

  private companion object {
    private val LOG = Logger.getInstance(NessyPluginRepositoryRegistrar::class.java)
    private const val PLUGIN_REPOSITORY_URL =
      "https://s3-msk.tinkoff.ru/nestor-companion/release/jetbrains/updatePlugin.xml"
    private const val NOTIFICATION_GROUP_ID = "nessy"
    private const val PLUGIN_ID = "org.nessy.intellij"
  }

  private fun notifyOnPluginUpdate() {
    val plugin = PluginManagerCore.getPlugin(PluginId.getId(PLUGIN_ID)) ?: return
    val currentVersion = plugin.version
    if (currentVersion.isNullOrBlank()) {
      return
    }

    val settings = NessySettingsState.getInstance()
    if (settings.lastNotifiedPluginVersion == currentVersion) {
      return
    }

    settings.lastNotifiedPluginVersion = currentVersion

    ApplicationManager.getApplication().invokeLater {
      val notificationGroup = NotificationGroupManager.getInstance()
        .getNotificationGroup(NOTIFICATION_GROUP_ID)
      val message = "Nessy CLI updated to version $currentVersion."
      val notification = notificationGroup.createNotification(
        message,
        NotificationType.INFORMATION
      )
      notification.addAction(
        NotificationAction.createSimple("Open plugin settings") {
          ShowSettingsUtil.getInstance().showSettingsDialog(null, "Plugins")
          notification.expire()
        }
      )
      notification.notify(null)
    }
  }
}
