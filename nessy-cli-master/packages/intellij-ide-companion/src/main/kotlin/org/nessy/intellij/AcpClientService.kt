package org.nessy.intellij

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import com.intellij.openapi.diagnostic.Logger
import org.nessy.intellij.acp.AcpConnection
import org.nessy.intellij.ide.IdeMcpServerService
import org.nessy.intellij.settings.NessySettingsState
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.net.JarURLConnection
import java.net.URI
import java.net.URL
import java.util.Locale
import java.util.jar.JarFile
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicReference

@Service(Service.Level.PROJECT)
class AcpClientService(private val project: Project) {
  private val logger = Logger.getInstance(AcpClientService::class.java)
  private val listeners = CopyOnWriteArrayList<AcpUiListener>()
  private val pendingPermission = AtomicReference<CompletableFuture<JsonObject>?>()
  private val pendingPermissionKind = AtomicReference<PendingPermissionKind?>()
  private var bundledCliPath: String? = null
  private var startupErrorNotified = false
  private val connection = AcpConnection(
    onAssistantChunk = { text, sessionId -> notifyAssistant(text, false, sessionId) },
    onThoughtChunk = { text -> notifyAssistant(text, true) },
    onAuthUpdate = { uri -> notifyAuth(uri) },
    onInitialized = { info -> notifyInitialized(info) },
    onStatus = { message -> notifyStatus(message) },
    onError = { error -> notifyError(error) },
    onSessionUpdate = { update -> notifySessionUpdate(update) },
    onPermissionRequest = { request -> handlePermissionRequest(request) },
    onAskUserQuestion = { request -> handleAskUserQuestion(request) },
  )

  fun addListener(listener: AcpUiListener) {
    listeners.add(listener)
  }

  fun sendPrompt(text: String): String? {
    if (!ensureConnected()) {
      notifyError("CLI is not connected.")
      return null
    }
    ensureSession()
    return connection.sendPrompt(text)
  }

  fun createNewSession(): String? {
    if (!ensureConnected()) {
      notifyError("CLI is not connected.")
      return null
    }
    val cwd = project.basePath ?: System.getProperty("user.dir")
    return connection.newSession(cwd)
  }

  fun loadSession(sessionId: String, cwd: String? = null): Boolean {
    if (!ensureConnected()) {
      notifyError("CLI is not connected.")
      return false
    }
    val resolvedCwd = cwd ?: project.basePath ?: System.getProperty("user.dir")
    return connection.loadSession(sessionId, resolvedCwd)
  }

  fun listSessions(cursor: String?, size: Int?): JsonObject? {
    if (!ensureConnected()) {
      notifyError("CLI is not connected.")
      return null
    }
    val cwd = project.basePath ?: System.getProperty("user.dir")
    return connection.listSessions(cwd, cursor, size)
  }

  fun cancelSession() {
    connection.cancelSession()
  }

  fun authenticate(methodId: String? = null) {
    ensureConnected()
    connection.authenticate(methodId)
  }

  fun setMode(modeId: String) {
    connection.setMode(modeId)
  }

  fun resolvePermission(optionId: String, answers: JsonObject? = null): Boolean {
    val future = pendingPermission.getAndSet(null) ?: return false
    pendingPermissionKind.set(null)
    val resolution = JsonObject().apply {
      addProperty("optionId", optionId)
      if (answers != null && !answers.isJsonNull && answers.entrySet().isNotEmpty()) {
        add("answers", answers)
      }
    }
    future.complete(resolution)
    return true
  }

  fun resolvePendingPermissionFromDiff(optionId: String): Boolean {
    if (pendingPermissionKind.get() != PendingPermissionKind.PERMISSION) {
      return false
    }
    val resolved = resolvePermission(optionId)
    if (resolved) {
      listeners.forEach { it.onPermissionResolved(optionId) }
    }
    return resolved
  }

  fun getSessionId(): String? = connection.getSessionId()
  fun getLastModelState(): JsonObject? = connection.getLastModelState()

  fun hasActiveSession(): Boolean = connection.hasActiveSession()

  fun isConnected(): Boolean = connection.isConnected()

  fun connectIfNeeded(): Boolean {
    return ensureConnected()
  }

  // Extended methods (VSCode compatibility)
  fun deleteSession(sessionId: String): Boolean {
    return connection.deleteSession(sessionId)
  }

  fun renameSession(sessionId: String, title: String): Boolean {
    return connection.renameSession(sessionId, title)
  }

  fun rewindSession(targetTurnIndex: Int): JsonObject? {
    return connection.rewindSession(targetTurnIndex)
  }

  fun restoreSessionHistory(history: JsonArray): Boolean {
    return connection.restoreSessionHistory(history)
  }

  fun getAccountInfo(): JsonObject? {
    return connection.getAccountInfo()
  }

  fun setModel(modelId: String): Boolean {
    return connection.setModel(modelId)
  }

  private fun ensureConnected(): Boolean {
    if (!connection.isConnected()) {
      val settings = NessySettingsState.getInstance()
      val cliPath = resolveBundledCliPath()
      if (cliPath == null) {
        notifyError("Bundled CLI not found. Rebuild the plugin distribution.")
        notifyStartupError("Bundled CLI not found. Rebuild the plugin distribution.")
        return false
      }
      val resolvedNodePath = resolveNodePath(settings.nodePath)
      if (resolvedNodePath == null) {
        val message = "Node.js not found. Configure Node.js path in Settings | Nessy CLI."
        notifyError(message)
        notifyStartupError(message)
        return false
      }

      val cwd = project.basePath ?: System.getProperty("user.dir")
      val ideServer = project.getService(IdeMcpServerService::class.java)
      val envOverrides = mutableMapOf(
        "NESSY_CLI_IDE_SERVER_PORT" to ideServer.getPort().toString(),
        "NESSY_CLI_IDE_WORKSPACE_PATH" to ideServer.getWorkspacePath(),
        "NESSY_CLI_IDE_NAME" to "jetbrains",
        "NESSY_CLI_IDE_DISPLAY_NAME" to "JetBrains IDE",
      )
      val homeDir = System.getProperty("user.home").orEmpty()
      if (homeDir.isNotBlank()) {
        envOverrides["HOME"] = homeDir
      }
      val nodePath = Path.of(resolvedNodePath)
      if (nodePath.isAbsolute) {
        val nodeDir = nodePath.parent?.toString().orEmpty()
        if (nodeDir.isNotBlank()) {
          val currentPath = System.getenv("PATH").orEmpty()
          envOverrides["PATH"] = listOf(nodeDir, currentPath)
            .filter { it.isNotBlank() }
            .joinToString(File.pathSeparator)
        }
      }
      logger.info("ensureConnected: starting CLI at $cliPath (cwd=$cwd)")
      connection.connect(
        cliPath = cliPath,
        nodePath = resolvedNodePath,
        workingDir = cwd,
        envOverrides = envOverrides,
      )
    } else {
      logger.info("ensureConnected: already connected")
    }
    if (!connection.awaitInitialized()) {
      notifyError("CLI failed to initialize.")
      return false
    }
    return connection.isConnected()
  }

  private fun resolveNodePath(configuredPath: String): String? {
    val trimmed = configuredPath.trim()
    if (trimmed.isNotEmpty()) {
      val path = Path.of(trimmed)
      if (path.isAbsolute) {
        if (Files.isExecutable(path)) {
          return path.toString()
        }
        notifyStartupError("Configured Node.js path not found or not executable: $trimmed")
        return null
      }
      return trimmed
    }

    val osName = System.getProperty("os.name").lowercase(Locale.US)
    val nodeBinary = if (osName.contains("win")) "node.exe" else "node"
    val candidates = mutableListOf<Path>()
    val pathEnv = System.getenv("PATH").orEmpty()
    if (pathEnv.isNotBlank()) {
      pathEnv.split(File.pathSeparator).forEach { entry ->
        if (entry.isNotBlank()) {
          candidates.add(Path.of(entry, nodeBinary))
        }
      }
    }
    val known = when {
      osName.contains("mac") -> listOf(
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
      )
      osName.contains("win") -> listOf(
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\Program Files (x86)\\nodejs\\node.exe",
      )
      else -> listOf(
        "/usr/local/bin/node",
        "/usr/bin/node",
      )
    }
    known.forEach { candidates.add(Path.of(it)) }

    return candidates.firstOrNull { Files.isExecutable(it) }?.toString()
  }

  private fun resolveBundledCliPath(): String? {
    bundledCliPath?.let { return it }
    val resourceUrl = javaClass.classLoader.getResource("cli/cli.js")
    if (resourceUrl != null) {
      when (resourceUrl.protocol) {
        "file" -> {
          val cliPath = Path.of(resourceUrl.toURI())
          logger.info("Using bundled CLI from resources: ${cliPath}")
          bundledCliPath = cliPath.toString()
          return bundledCliPath
        }
        "jar" -> {
          val extractedDir = extractBundledCliFromJar(resourceUrl)
          if (extractedDir != null) {
            val cliPath = extractedDir.resolve("cli.js")
            logger.info("Using bundled CLI from jar: ${cliPath}")
            bundledCliPath = cliPath.toString()
            return bundledCliPath
          }
        }
      }
    }

    val roots = mutableListOf<Path>()
    project.basePath?.let { roots.add(Path.of(it)) }
    val userDir = System.getProperty("user.dir")
    if (!userDir.isNullOrBlank()) {
      roots.add(Path.of(userDir))
    }
    val codeSource = runCatching {
      javaClass.protectionDomain.codeSource.location.toURI()
    }.getOrNull()
    if (codeSource != null) {
      roots.add(Path.of(codeSource))
    }

    logger.info(
      "Bundled CLI resource missing; probing roots: " +
        roots.joinToString(", ") { it.toString() },
    )
    for (root in roots) {
      val candidate = findCliCandidate(root)
      if (candidate != null) {
        logger.info("Using CLI fallback at: ${candidate}")
        bundledCliPath = candidate.toString()
        return bundledCliPath
      }
    }
    logger.warn("CLI fallback paths not found.")

    return null
  }

  private fun extractBundledCliFromJar(resourceUrl: URL): Path? {
    val jarConnection = runCatching { resourceUrl.openConnection() }.getOrNull()
    val jarFile = if (jarConnection is JarURLConnection) {
      jarConnection.jarFile
    } else {
      val spec = resourceUrl.toString()
      val separator = spec.indexOf("!/")
      if (!spec.startsWith("jar:") || separator == -1) {
        return null
      }
      val jarPath = spec.substring(4, separator)
      JarFile(Path.of(URI.create(jarPath)).toFile())
    }

    val tempDir = Files.createTempDirectory("nessy-cli-")
    tempDir.toFile().deleteOnExit()
    jarFile.use { jar ->
      val entries = jar.entries()
      while (entries.hasMoreElements()) {
        val entry = entries.nextElement()
        val name = entry.name
        if (!name.startsWith("cli/") || entry.isDirectory) continue
        val relative = name.removePrefix("cli/")
        val target = tempDir.resolve(relative)
        Files.createDirectories(target.parent)
        jar.getInputStream(entry).use { input ->
          Files.newOutputStream(target).use { output ->
            input.copyTo(output)
          }
        }
      }
    }
    return tempDir
  }

  private fun findCliCandidate(root: Path): Path? {
    var current: Path? = root
    var steps = 0
    while (current != null && steps < 8) {
      val dirCandidate = current.resolve(
        Path.of(
          "packages",
          "vscode-ide-companion",
          "dist",
          "nessy-cli",
        ),
      )
      val cliCandidate = dirCandidate.resolve("cli.js")
      if (Files.exists(cliCandidate)) {
        return cliCandidate
      }
      current = current.parent
      steps += 1
    }
    return null
  }

  private fun ensureSession() {
    if (connection.hasActiveSession()) return
    val cwd = project.basePath ?: System.getProperty("user.dir")
    connection.newSession(cwd)
  }

  private fun notifyAssistant(text: String, isThought: Boolean, sessionId: String? = null) {
    listeners.forEach { it.onAssistantChunk(text, isThought, sessionId) }
  }

  private fun notifyInitialized(info: JsonObject) {
    listeners.forEach { it.onInitialized(info) }
  }

  private fun notifyAuth(uri: String) {
    listeners.forEach { it.onAuthUpdate(uri) }
    NotificationGroupManager.getInstance()
      .getNotificationGroup("nessy")
      .createNotification(
        "Authentication required",
        uri,
        NotificationType.INFORMATION,
      )
      .notify(project)
  }

  private fun notifyError(message: String) {
    listeners.forEach { it.onError(message) }
    val lower = message.lowercase(Locale.US)
    if (
      lower.contains("failed to start cli") ||
      lower.contains("bundled cli not found") ||
      lower.contains("node.js not found")
    ) {
      notifyStartupError(message)
    }
  }

  private fun notifyStatus(message: String) {
    listeners.forEach { it.onStatus(message) }
  }

  private fun notifySessionUpdate(update: JsonObject) {
    listeners.forEach { it.onSessionUpdate(update) }
  }

  private fun notifyStartupError(message: String) {
    if (startupErrorNotified) return
    startupErrorNotified = true
    NotificationGroupManager.getInstance()
      .getNotificationGroup("nessy")
      .createNotification(
        "Nessy CLI",
        message,
        NotificationType.ERROR,
      )
      .notify(project)
  }

  private fun handlePermissionRequest(request: JsonObject): JsonObject {
    val future = CompletableFuture<JsonObject>()
    pendingPermission.set(future)
    pendingPermissionKind.set(PendingPermissionKind.PERMISSION)
    listeners.forEach { it.onPermissionRequest(request) }
    return try {
      future.get()
    } catch (e: Exception) {
      logger.warn("handlePermissionRequest error: ${e.message}")
      JsonObject().apply { addProperty("optionId", "allow_once") }
    }
  }

  private fun handleAskUserQuestion(request: JsonObject): JsonObject {
    val future = CompletableFuture<JsonObject>()
    pendingPermission.set(future)
    pendingPermissionKind.set(PendingPermissionKind.ASK_USER_QUESTION)
    listeners.forEach { it.onAskUserQuestion(request) }
    return try {
      future.get()
    } catch (e: Exception) {
      logger.warn("handleAskUserQuestion error: ${e.message}")
      JsonObject().apply { addProperty("optionId", "cancel") }
    }
  }

  private enum class PendingPermissionKind {
    PERMISSION,
    ASK_USER_QUESTION,
  }
}
