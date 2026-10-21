package org.nessy.intellij

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.reflect.TypeToken
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.DumbService
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectRootManager
import com.intellij.openapi.startup.StartupManager
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.CaretEvent
import com.intellij.openapi.editor.event.CaretListener
import com.intellij.openapi.editor.event.SelectionEvent
import com.intellij.openapi.editor.event.SelectionListener
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.ui.ColorUtil
import com.intellij.ui.JBColor
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.util.ui.UIUtil
import com.intellij.util.Alarm
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import java.awt.BorderLayout
import java.awt.Color
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import java.util.ArrayDeque
import java.util.Locale
import java.util.jar.JarFile
import java.net.JarURLConnection
import java.net.URI
import java.net.URL
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.UIManager
import kotlin.collections.iterator
import org.nessy.intellij.ide.IdeMcpServerService
import org.nessy.intellij.types.UsageStatsPayload
import org.nessy.intellij.types.UsageStats
import org.nessy.intellij.types.ModelInfo

class NessyToolWindowPanel(
  private val project: Project,
  private val titleUpdater: ((String) -> Unit)? = null,
  private val newTabHandler: (() -> Unit)? = null,
) :
  JPanel(BorderLayout()),
  AcpUiListener,
  Disposable {
  private val logger = Logger.getInstance(NessyToolWindowPanel::class.java)
  private val client = project.getService(AcpClientService::class.java)
  private val gson = Gson()
  private val sessionMessages = mutableMapOf<String, MutableList<JsonObject>>()
  private val sessionTitles = mutableMapOf<String, String>()
  private val sessionMetadata = mutableMapOf<String, JsonObject>()
  private val pendingMessages = mutableListOf<JsonObject>()
  private var currentSessionId: String? = null
  private var isTitleSet = false
  private var streamActive = false
  private val streamBuffer = StringBuilder()
  private var browser: JBCefBrowser? = null
  private var jsQuery: JBCefJSQuery? = null
  private var initialMessagesSent = false
  private var initialConnectStarted = false
  private var agentConnectedSent = false
  private var webviewReady = false
  private var pendingAgentError: String? = null
  private var authState: Boolean? = null
  private var pendingModeInfo: JsonObject? = null
  private var webviewAssetsBaseUrl: String? = null
  private var pendingNewSession = false
  private var pendingNewSessionClearHistory = true
  private var initialized = false
  private var lastModelState: JsonObject? = null
  private var cachedAvailableCommands: JsonArray? = null
  private var rehydratingSessionId: String? = null  // Track session rehydration
  private var requestCounter: Long = 0
  private var currentRequestId: String? = null
  private val webviewReadyAlarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)

  init {
    initializeWhenIdeReady()
  }

  private fun initializeWhenIdeReady() {
    add(JLabel("Loading Nessy CLI..."), BorderLayout.CENTER)
    val app = ApplicationManager.getApplication()
    val initializeIfReady = Runnable {
      if (project.isDisposed || Disposer.isDisposed(this)) {
        return@Runnable
      }
      initialize()
    }

    if (project.isInitialized) {
      app.invokeLater(initializeIfReady)
    } else {
      StartupManager.getInstance(project).runAfterOpened {
        app.invokeLater(initializeIfReady)
      }
    }
  }

  private fun initialize() {
    if (initialized) {
      return
    }
    initialized = true
    removeAll()
    if (!JBCefApp.isSupported()) {
      add(JLabel("JCEF is not supported in this IDE build."), BorderLayout.CENTER)
      return
    }

    val jcefBrowser = JBCefBrowser()
    browser = jcefBrowser
    jsQuery = JBCefJSQuery.create(jcefBrowser as JBCefBrowserBase)
    enableDevTools(jcefBrowser)

    val query = jsQuery
    if (query == null) {
      add(JLabel("Failed to initialize JCEF bridge."), BorderLayout.CENTER)
      return
    }
    query.addHandler { request ->
      handleWebviewMessage(request)
      null
    }
    Disposer.register(this, query)

    val webviewScript = loadWebviewScript()
    if (webviewScript == null) {
      add(JLabel("Webview bundle not found. Run the webview build first."), BorderLayout.CENTER)
      return
    }

    val html = buildHtml(webviewScript, query.inject("request"))
    jcefBrowser.loadHTML(html)

    jcefBrowser.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
      override fun onLoadEnd(browser: CefBrowser?, frame: CefFrame?, httpStatusCode: Int) {
        schedulePostLoadWork()
      }
    }, jcefBrowser.cefBrowser)

    add(jcefBrowser.component, BorderLayout.CENTER)

    client.addListener(this)
    subscribeEditorEvents()
  }

  override fun dispose() {
    jsQuery?.dispose()
    browser?.dispose()
  }

  private fun buildHtml(webviewScript: String, queryInjection: String): String {
    val safeScript = webviewScript.replace("</script>", "<\\/script>")
    val themeClass = if (isDarkTheme()) "vscode-dark" else "vscode-light"
    val themeCss = buildThemeCss()
    val extensionUri = resolveWebviewAssetsBaseUrl()?.let { escapeHtmlAttribute(it) } ?: ""
    return """
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Nessy CLI</title>
        $themeCss
      </head>
      <body class="$themeClass" data-extension-uri="$extensionUri">
        <div id="root"></div>
        <script>
          (function() {
            const state = { value: undefined };
            window.intellijBridge = {
              postMessage: function(message) {
                try {
                  const request = typeof message === 'string' ? message : JSON.stringify(message);
                  ${queryInjection};
                } catch (err) {
                  console.error('Failed to send message to host', err);
                }
              }
            };
            window.acquireVsCodeApi = () => ({
              postMessage: (message) => window.intellijBridge.postMessage(message),
              getState: () => state.value,
              setState: (value) => { state.value = value; }
            });
            // Surface uncaught JS errors back to the host log (idea.log) for debugging.
            window.addEventListener('error', function (event) {
              window.intellijBridge.postMessage({ type: 'webviewJsError', data: { message: String(event.message || ''), source: String(event.filename || ''), line: event.lineno || 0, column: event.colno || 0, stack: event.error && event.error.stack ? String(event.error.stack) : '' } });
            });
            window.addEventListener('unhandledrejection', function (event) {
              var reason = event.reason;
              window.intellijBridge.postMessage({ type: 'webviewJsError', data: { message: String(reason && reason.message ? reason.message : reason), stack: reason && reason.stack ? String(reason.stack) : '' } });
            });
          })();
        </script>
        <script>${safeScript}</script>
        <script>
          window.addEventListener('load', () => {
            if (window.intellijBridge) {
              window.intellijBridge.postMessage({ type: 'webviewReady', data: {} });
            }
          });
        </script>
      </body>
      </html>
    """.trimIndent()
  }

  private fun enableDevTools(jcefBrowser: JBCefBrowser) {
    val browserBase: JBCefBrowserBase = jcefBrowser
    val methodNames = listOf("openDevTools", "openDevtools")
    val method = methodNames.firstNotNullOfOrNull { name ->
      runCatching { browserBase.javaClass.getMethod(name) }.getOrNull()
    }
    if (method == null) {
      logger.warn("JCEF DevTools API not available on this IDE build")
      return
    }
    runCatching {
      method.invoke(browserBase)
      logger.info("JCEF DevTools opened")
    }.onFailure { error ->
      logger.warn("Failed to open JCEF DevTools", error)
    }
  }

  private fun loadWebviewScript(): String? {
    val resource = javaClass.classLoader.getResourceAsStream("webview/webview.js")
    if (resource != null) {
      return resource.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
    }

    val fallback = project.basePath?.let {
      Path.of(it, "packages", "vscode-ide-companion", "dist", "webview.js")
    } ?: return null

    return try {
      Files.readString(fallback)
    } catch (_: Exception) {
      null
    }
  }

  private fun resolveWebviewAssetsBaseUrl(): String? {
    webviewAssetsBaseUrl?.let { return it }
    val resourceUrl = javaClass.classLoader.getResource("assets/icon.png")
    if (resourceUrl != null) {
      when (resourceUrl.protocol) {
        "file" -> {
          val iconPath = Path.of(resourceUrl.toURI())
          val baseDir = iconPath.parent?.parent
          if (baseDir != null) {
            webviewAssetsBaseUrl = baseDir.toUri().toString()
            return webviewAssetsBaseUrl
          }
        }
        "jar" -> {
          val extractedDir = extractBundledAssetsFromJar(resourceUrl)
          if (extractedDir != null) {
            webviewAssetsBaseUrl = extractedDir.toUri().toString()
            return webviewAssetsBaseUrl
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

    for (root in roots) {
      val candidate = findAssetsRoot(root)
      if (candidate != null) {
        webviewAssetsBaseUrl = candidate.toUri().toString()
        return webviewAssetsBaseUrl
      }
    }
    return null
  }

  private fun extractBundledAssetsFromJar(resourceUrl: URL): Path? {
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

    val tempDir = Files.createTempDirectory("nessy-webview-")
    tempDir.toFile().deleteOnExit()
    jarFile.use { jar ->
      val entries = jar.entries()
      while (entries.hasMoreElements()) {
        val entry = entries.nextElement()
        val name = entry.name
        if (!name.startsWith("assets/") || entry.isDirectory) continue
        val relative = name.removePrefix("assets/")
        val target = tempDir.resolve("assets").resolve(relative)
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

  private fun findAssetsRoot(root: Path): Path? {
    var current: Path? = root
    var steps = 0
    while (current != null && steps < 8) {
      val extensionRoot = current.resolve(
        Path.of("packages", "vscode-ide-companion"),
      )
      val iconPath = extensionRoot.resolve(Path.of("assets", "icon.png"))
      if (Files.exists(iconPath)) {
        return extensionRoot
      }
      current = current.parent
      steps += 1
    }
    return null
  }

  private fun escapeHtmlAttribute(value: String): String {
    return value
      .replace("&", "&amp;")
      .replace("<", "&lt;")
      .replace(">", "&gt;")
      .replace("\"", "&quot;")
      .replace("'", "&#39;")
  }

  private fun buildThemeCss(): String {
    val scheme = EditorColorsManager.getInstance().globalScheme
    val editorBg = scheme.defaultBackground
    val editorFg = scheme.defaultForeground
    val panelBg = UIUtil.getPanelBackground()
    val panelFg = UIUtil.getLabelForeground()
    val border = JBColor.border()
    val descFg = UIUtil.getContextHelpForeground()
    val inputBg = UIUtil.getTextFieldBackground()
    val inputFg = UIUtil.getTextFieldForeground()
    val inactiveText = UIUtil.getInactiveTextColor()
    val listBg = UIUtil.getListBackground()
    val listFg = UIUtil.getListForeground()
    val listSelBg = JBColor.namedColor("List.selectionBackground", listBg)
    val listSelFg = JBColor.namedColor("List.selectionForeground", listFg)
    val buttonBg = UIManager.getColor("Button.background") ?: panelBg
    val buttonFg = UIManager.getColor("Button.foreground") ?: panelFg
    val buttonHover = UIManager.getColor("Button.select") ?: buttonBg
    val linkFg = UIManager.getColor("Link.activeForeground")
      ?: UIManager.getColor("linkForeground")
      ?: if (isDarkTheme()) Color(0x4e8cff) else Color(0x0066cc)
    val widgetShadow = if (isDarkTheme()) {
      "rgba(0,0,0,0.35)"
    } else {
      "rgba(0,0,0,0.18)"
    }
    val codeBg = colorToRgba(editorBg, if (isDarkTheme()) 0.35 else 0.08)

    return """
      <style>
        :root {
          --vscode-foreground: ${colorToHex(editorFg)};
          --vscode-sideBar-background: ${colorToHex(panelBg)};
          --vscode-sideBarActivityBarTop-border: ${colorToHex(border)};
          --vscode-descriptionForeground: ${colorToHex(descFg)};
          --vscode-input-foreground: ${colorToHex(inputFg)};
          --vscode-input-background: ${colorToHex(inputBg)};
          --vscode-inlineChatInput-border: ${colorToHex(border)};
          --vscode-inputOption-activeBorder: ${colorToHex(border)};
          --vscode-input-placeholderForeground: ${colorToHex(inactiveText)};
          --vscode-menu-background: ${colorToHex(listBg)};
          --vscode-menu-foreground: ${colorToHex(listFg)};
          --vscode-menu-selectionBackground: ${colorToHex(listSelBg)};
          --vscode-menu-selectionForeground: ${colorToHex(listSelFg)};
          --vscode-list-hoverBackground: ${colorToHex(listSelBg)};
          --vscode-list-activeSelectionBackground: ${colorToHex(listSelBg)};
          --vscode-list-activeSelectionForeground: ${colorToHex(listSelFg)};
          --vscode-button-foreground: ${colorToHex(buttonFg)};
          --vscode-button-background: ${colorToHex(buttonBg)};
          --vscode-button-hoverBackground: ${colorToHex(buttonHover)};
          --vscode-toolbar-hoverBackground: ${colorToHex(listSelBg)};
          --vscode-textCodeBlock-background: ${codeBg};
          --vscode-textLink-foreground: ${colorToHex(linkFg)};
          --vscode-textLink-activeForeground: ${colorToHex(linkFg)};
          --vscode-editorWidget-border: ${colorToHex(border)};
          --vscode-widget-shadow: ${widgetShadow};
        }
      </style>
    """.trimIndent()
  }

  private fun colorToHex(color: Color?): String {
    val safe = color ?: Color(0, 0, 0)
    return "#${ColorUtil.toHex(safe)}"
  }

  private fun colorToRgba(color: Color?, alpha: Double): String {
    val safe = color ?: Color(0, 0, 0)
    val clamped = alpha.coerceIn(0.0, 1.0)
    val formatted = String.format(Locale.US, "%.2f", clamped)
    return "rgba(${safe.red}, ${safe.green}, ${safe.blue}, $formatted)"
  }

  private fun isDarkTheme(): Boolean {
    return JBColor.isBright() == false
  }

  private fun handleWebviewMessage(raw: String): String? {
    logger.info("Webview message received (raw length=${raw.length})")
    val payload = runCatching { gson.fromJson(raw, JsonObject::class.java) }.getOrNull() ?: return null
    val type = payload.get("type")?.asString ?: return null
    val data = payload.get("data")?.asJsonObject

    logger.info("Webview message type=$type, data=${data?.toString()?.take(100)}")
    when (type) {
      "sendMessage" -> handleSendMessage(data)
      "getActiveEditor" -> sendActiveEditor()
      "getWorkspaceFiles" -> sendWorkspaceFiles(data)
      "openFile" -> openFile(data)
      "openDiff" -> openDiff(data)
      "createAndOpenTempFile" -> createAndOpenTempFile(data)
      "attachFile", "showContextPicker" -> showFilePicker()
      "openNewChatTab" -> {
        if (newTabHandler != null) {
          ApplicationManager.getApplication().invokeLater {
            newTabHandler.invoke()
          }
        } else {
          startNewSession(clearHistory = true)
        }
      }
      "switchNessySession" -> switchSession(data)
      "getNessySessions" -> sendSessionList(data)
      "saveSession" -> saveSession(data)
      "setApprovalMode" -> setApprovalMode(data)
      "cancelStreaming" -> cancelStreaming()
      "permissionResponse" -> handlePermissionResponse(data)
      "askUserQuestionResponse" -> handleAskUserQuestionResponse(data)
      "deleteSession" -> handleDeleteSession(data)
      "renameSession" -> handleRenameSession(data)
      "rewindSession" -> handleRewindSession(data)
      "login" -> handleLogin()
      "focusActiveEditor" -> focusActiveEditor()
      "webviewReady" -> handleWebviewReady()
      "webviewJsError" -> handleWebviewJsError(data)
      "updatePanelTitle" -> handlePanelTitleUpdate(data)
      "requestModelState" -> sendCachedModelState()
      "setModel" -> handleSetModel(data)
    }

    return null
  }

  private fun handleSendMessage(data: JsonObject?) {
    val text = data?.get("text")?.asString?.trim().orEmpty()
    if (text.isEmpty()) return

    val context = data?.getAsJsonArray("context")
    val formatted = formatMessageWithContext(text, context)
    val fileContext = data?.getAsJsonObject("fileContext")

    val timestamp = System.currentTimeMillis()
    val userMessage = JsonObject().apply {
      addProperty("role", "user")
      addProperty("content", text)
      addProperty("timestamp", timestamp)
      if (fileContext != null) {
        add("fileContext", fileContext)
      }
    }

    appendMessageToSession(userMessage)
    sendToWebView("message", userMessage)

    if (!isTitleSet) {
      val title = if (text.length > 50) "${text.substring(0, 50)}..." else text
      currentSessionId?.let { sessionId ->
        sessionTitles[sessionId] = title
        sendToWebView(
          "sessionTitleUpdated",
          JsonObject().apply {
            addProperty("sessionId", sessionId)
            addProperty("title", title)
          },
        )
        isTitleSet = true
      }
    }

    // Generate unique requestId for correlating streamStart/streamEnd events
    requestCounter += 1
    currentRequestId = "req-${requestCounter}-${System.currentTimeMillis()}"
    val myRequestId = currentRequestId

    ApplicationManager.getApplication().executeOnPooledThread {
      if (!client.connectIfNeeded()) {
        sendAgentConnectionError("CLI not configured or failed to start.")
        sendStreamEnd("error", myRequestId)
        return@executeOnPooledThread
      }
      ensureSession()
      sendToWebView(
        "streamStart",
        JsonObject().apply {
          addProperty("timestamp", timestamp)
          addProperty("requestId", myRequestId)
        },
        sync = true,
      )
      streamActive = true
      streamBuffer.setLength(0)
      val stopReason = client.sendPrompt(formatted)
      if (stopReason == null) {
        sendStreamEnd("error", myRequestId)
      } else {
        sendStreamEnd(stopReason, myRequestId)
      }
    }
  }

  private fun ensureSession() {
    if (client.hasActiveSession()) {
      currentSessionId = client.getSessionId()
      return
    }
    val sessionId = client.createNewSession()
    if (sessionId != null) {
      currentSessionId = sessionId
      isTitleSet = false
      sessionTitles.putIfAbsent(sessionId, "New Chat")
      if (pendingMessages.isNotEmpty()) {
        sessionMessages[sessionId] = pendingMessages.toMutableList()
        pendingMessages.clear()
      } else {
        sessionMessages.putIfAbsent(sessionId, mutableListOf())
      }
      refreshModelStateFromClient()
      sendCachedModelState()
      sendToWebView(
        "nessySessionSwitched",
        JsonObject().apply {
          addProperty("sessionId", sessionId)
          add("messages", gson.toJsonTree(sessionMessages[sessionId] ?: emptyList<JsonObject>()))
        },
      )
    }
  }

  private fun formatMessageWithContext(text: String, context: JsonArray?): String {
    if (context == null || context.size() == 0) {
      return text
    }
    val contextLines = context.mapNotNull { item ->
      val ctx = item.asJsonObject
      val rawValue = ctx.get("value")?.asString?.trim().orEmpty()
      if (rawValue.isEmpty()) return@mapNotNull null
      val startLine = ctx.get("startLine")?.asInt
      val endLine = ctx.get("endLine")?.asInt
      val value = if (rawValue.startsWith("@")) {
        rawValue
      } else {
        "@$rawValue"
      }
      if (startLine != null && endLine != null && !value.contains("#")) {
        if (startLine == endLine) "$value#$startLine" else "$value#$startLine-$endLine"
      } else {
        value
      }
    }
    return contextLines.joinToString("\n").trim().let { ctx ->
      if (ctx.isEmpty()) text else "$ctx\n\n$text"
    }
  }

  private fun sendStreamEnd(reason: String, forRequestId: String? = null) {
    // Check if this streamEnd is for a stale request
    if (forRequestId != null && currentRequestId != forRequestId) {
      logger.info("Ignoring stale streamEnd: forRequestId=$forRequestId, currentRequestId=$currentRequestId")
      return
    }
    
    logger.info("sendStreamEnd: reason=$reason, forRequestId=$forRequestId, bufferLength=${streamBuffer.length}")
    
    if (streamBuffer.isNotEmpty()) {
      val assistantMessage = JsonObject().apply {
        addProperty("role", "assistant")
        addProperty("content", streamBuffer.toString())
        addProperty("timestamp", System.currentTimeMillis())
      }
      appendMessageToSession(assistantMessage)
      logger.info("Sending final assistant message: contentLength=${streamBuffer.length}")
    }
    streamBuffer.setLength(0)
    val data = JsonObject().apply {
      addProperty("timestamp", System.currentTimeMillis())
      addProperty("reason", reason)
      if (forRequestId != null) {
        addProperty("requestId", forRequestId)
      }
    }
    sendToWebView("streamEnd", data)
    streamActive = false
  }

  private fun sendAgentConnected() {
    sendAuthState(true)
    sendToWebView("agentConnected", JsonObject())
  }

  private fun sendAgentConnectionError(message: String) {
    sendToWebView("agentConnectionError", JsonObject().apply { addProperty("message", message) })
  }

  private fun sendAuthState(state: Boolean?) {
    authState = state
    val payload = JsonObject()
    if (state == null) {
      payload.add("authenticated", JsonNull.INSTANCE)
    } else {
      payload.addProperty("authenticated", state)
    }
    sendToWebView("authState", payload)
  }

  private fun handleWebviewReady() {
    if (webviewReady) {
      return
    }
    logger.info("Webview ready received")
    webviewReady = true
    scheduleWebviewReadyDispatch()
  }

  private fun handleWebviewJsError(data: JsonObject?) {
    val message = data?.get("message")?.asString ?: "unknown JS error"
    val stack = data?.get("stack")?.asString?.take(500).orEmpty()
    logger.error("Webview JS error: $message${if (stack.isNotBlank()) "\n$stack" else ""}")
  }

  private fun scheduleWebviewReadyDispatch() {
    webviewReadyAlarm.cancelAllRequests()
    webviewReadyAlarm.addRequest({
      if (!webviewReady || project.isDisposed || Disposer.isDisposed(this)) {
        return@addRequest
      }
      val pending = pendingAgentError
      if (pending != null) {
        pendingAgentError = null
        sendAgentConnectionError(pending)
        return@addRequest
      }
      authState?.let { sendAuthState(it) }
      pendingModeInfo?.let {
        pendingModeInfo = null
        sendToWebView("modeInfo", it)
      }
      sendCachedModelState()
      // Send cached commands if available, or retry until client is connected
      val commands = cachedAvailableCommands
      if (commands != null && commands.size() > 0) {
        sendToWebView("availableCommands", JsonObject().apply { add("commands", commands) })
      } else if (client.isConnected()) {
        // Client connected, create session to get commands
        ApplicationManager.getApplication().executeOnPooledThread {
          ensureSession()
        }
      } else {
        // Client not connected yet, retry later
        scheduleCommandsRetry()
      }
      if (pendingNewSession) {
        val clearHistory = pendingNewSessionClearHistory
        pendingNewSession = false
        startNewSession(clearHistory)
      }
      maybeSendAgentConnected()
    }, 150)
  }

  private fun scheduleCommandsRetry() {
    webviewReadyAlarm.addRequest({
      if (project.isDisposed || Disposer.isDisposed(this) || !webviewReady) {
        return@addRequest
      }
      val commands = cachedAvailableCommands
      if (commands != null && commands.size() > 0) {
        sendToWebView("availableCommands", JsonObject().apply { add("commands", commands) })
      } else if (client.isConnected()) {
        ApplicationManager.getApplication().executeOnPooledThread {
          ensureSession()
        }
      } else {
        // Still not connected, retry again (max ~10 sec total based on connectIfNeeded timeout)
        scheduleCommandsRetry()
      }
    }, 500)
  }

  private fun scheduleWebviewReadyFallback() {
    val app = ApplicationManager.getApplication()
    app.invokeLater {
      if (!webviewReady && !project.isDisposed && !Disposer.isDisposed(this)) {
        logger.info("Webview ready fallback triggered on load end")
        handleWebviewReady()
      }
    }
  }

  private fun schedulePostLoadWork() {
    val app = ApplicationManager.getApplication()
    val run = Runnable {
      if (project.isDisposed || Disposer.isDisposed(this)) {
        return@Runnable
      }
      if (!initialMessagesSent) {
        initialMessagesSent = true
        sendActiveEditor()
      }
      if (!webviewReady) {
        scheduleWebviewReadyFallback()
      }
      if (!initialConnectStarted) {
        initialConnectStarted = true
        ApplicationManager.getApplication().executeOnPooledThread {
          if (!client.connectIfNeeded()) {
            queueAgentConnectionError("CLI not configured or failed to start.")
            return@executeOnPooledThread
          }
          sendAuthState(true)
          maybeSendAgentConnected()
        }
      }
    }

    val dumbService = DumbService.getInstance(project)
    if (dumbService.isDumb) {
      dumbService.runWhenSmart { app.invokeLater(run) }
    } else {
      app.invokeLater(run)
    }
  }

  private fun maybeSendAgentConnected() {
    logger.info("maybeSendAgentConnected: ready=$webviewReady sent=$agentConnectedSent connected=${client.isConnected()}")
    if (!webviewReady || agentConnectedSent) return
    if (client.isConnected()) {
      agentConnectedSent = true
      sendAgentConnected()
    }
  }

  private fun queueAgentConnectionError(message: String) {
    if (webviewReady) {
      sendAgentConnectionError(message)
    } else {
      pendingAgentError = message
    }
  }

  private fun sendActiveEditor() {
    val editor = FileEditorManager.getInstance(project).selectedTextEditor
    val document = editor?.document
    val file = document?.let { FileDocumentManager.getInstance().getFile(it) }

    val data = JsonObject().apply {
      if (file != null) {
        addProperty("fileName", file.name)
        addProperty("filePath", file.path)
        val selection = editor.selectionModel
        if (selection.hasSelection()) {
          val startOffset = selection.selectionStart
          val endOffset = selection.selectionEnd
          val startLine = document.getLineNumber(startOffset) + 1
          val inclusiveEndOffset = (endOffset - 1).coerceAtLeast(startOffset)
          val endLine = document.getLineNumber(inclusiveEndOffset) + 1
          add("selection", JsonObject().apply {
            addProperty("startLine", startLine)
            addProperty("endLine", endLine)
          })
        }
      } else {
        add("fileName", JsonNull.INSTANCE)
        add("filePath", JsonNull.INSTANCE)
        add("selection", JsonNull.INSTANCE)
      }
    }
    sendToWebView("activeEditorChanged", data)
  }

  private fun subscribeEditorEvents() {
    val bus = project.messageBus.connect(this)
    bus.subscribe(
      FileEditorManagerListener.FILE_EDITOR_MANAGER,
      object : FileEditorManagerListener {
        override fun selectionChanged(event: FileEditorManagerEvent) {
          sendActiveEditor()
        }
      },
    )

    val caretListener = object : CaretListener {
      override fun caretPositionChanged(event: CaretEvent) {
        sendActiveEditor()
      }
    }
    EditorFactory.getInstance().eventMulticaster.addCaretListener(caretListener, this)

    val selectionListener = object : SelectionListener {
      override fun selectionChanged(event: SelectionEvent) {
        sendActiveEditor()
      }
    }
    EditorFactory.getInstance().eventMulticaster.addSelectionListener(selectionListener, this)
  }

  private fun sendWorkspaceFiles(data: JsonObject?) {
    val query = data?.get("query")?.asString?.trim()
    val files = collectWorkspaceFiles(query)
    val payload = JsonObject().apply {
      add("files", files)
    }
    sendToWebView("workspaceFiles", payload)
  }

  private fun collectWorkspaceFiles(query: String?): JsonArray {
    val roots = ProjectRootManager.getInstance(project).contentRoots
    val results = JsonArray()
    val limit = 2000
    val lowerQuery = query?.trim()?.lowercase(Locale.US)?.removePrefix("@")
    val skipNames = setOf(".git", ".idea", "node_modules", "dist", "build")
    val baseRoot = project.basePath?.let { basePath ->
      LocalFileSystem.getInstance().findFileByPath(basePath)
    }

    for (root in roots) {
      val stack = ArrayDeque<VirtualFile>()
      stack.add(root)
      while (stack.isNotEmpty() && results.size() < limit) {
        val file = stack.removeFirst()
        if (file.name in skipNames) {
          continue
        }
        if (file.isDirectory) {
          stack.addAll(file.children)
        }
        val relPath = when {
          baseRoot != null -> VfsUtilCore.getRelativePath(file, baseRoot, '/')
          else -> VfsUtilCore.getRelativePath(file, root, '/')
        } ?: file.path
        val name = file.name
        if (!lowerQuery.isNullOrEmpty()) {
          val normalizedQuery = lowerQuery.replace('\\', '/')
          val normalizedRel = relPath.replace('\\', '/').lowercase(Locale.US)
          val nameMatch = name.lowercase(Locale.US).contains(normalizedQuery)
          val pathMatch = normalizedRel.contains(normalizedQuery)
          if (normalizedQuery.contains("/")) {
            if (!pathMatch) continue
          } else if (!nameMatch && !pathMatch) {
            continue
          }
        }
        val entry = JsonObject().apply {
          addProperty("id", file.path)
          addProperty("label", name)
          addProperty("description", relPath)
          addProperty("path", file.path)
          addProperty("type", if (file.isDirectory) "folder" else "file")
        }
        results.add(entry)
      }
    }
    return results
  }

  private fun showFilePicker() {
    ApplicationManager.getApplication().invokeLater {
      val descriptor = FileChooserDescriptorFactory.createSingleFileDescriptor()
      FileChooser.chooseFile(descriptor, project, null) { file ->
        val data = JsonObject().apply {
          addProperty("id", "file-${Instant.now().toEpochMilli()}")
          addProperty("type", "file")
          addProperty("name", file.name)
          addProperty("value", file.path)
        }
        sendToWebView("fileAttached", data)
      }
    }
  }

  private fun openFile(data: JsonObject?) {
    val path = data?.get("path")?.asString ?: return
    val file = LocalFileSystem.getInstance().findFileByPath(path) ?: return
    ApplicationManager.getApplication().invokeLater {
      FileEditorManager.getInstance(project).openFile(file, true)
    }
  }

  private fun openDiff(data: JsonObject?) {
    if (data == null) return
    val oldText = data.get("oldText")?.asString ?: return
    val newText = data.get("newText")?.asString ?: return
    val path = data.get("path")?.asString ?: return

    try {
      project.getService(IdeMcpServerService::class.java).showDiff(path, oldText, newText)
    } catch (e: Exception) {
      Messages.showErrorDialog(project, "Failed to open diff: ${e.message}", "Nessy CLI")
    }
  }

  private fun createAndOpenTempFile(data: JsonObject?) {
    if (data == null) return
    val content = data.get("content")?.asString ?: return
    val fileName = data.get("fileName")?.asString ?: "temp"
    val extension = data.get("fileExtension")?.asString ?: ".txt"

    ApplicationManager.getApplication().executeOnPooledThread {
      val tempFile = Files.createTempFile(fileName, extension)
      Files.writeString(tempFile, content)
      val vf = LocalFileSystem.getInstance().refreshAndFindFileByPath(tempFile.toString())
      if (vf != null) {
        ApplicationManager.getApplication().invokeLater {
          FileEditorManager.getInstance(project).openFile(vf, true)
        }
      }
    }
  }

  private fun focusActiveEditor() {
    val editor = FileEditorManager.getInstance(project).selectedTextEditor ?: return
    ApplicationManager.getApplication().invokeLater {
      editor.contentComponent.requestFocus()
    }
  }

  private fun sendSessionList(data: JsonObject?) {
    // Webview historically uses a numeric cursor; protocol uses opaque string.
    // Accept either at the boundary, forward as string per ACP spec.
    val rawCursor = data?.get("cursor")
    val cursor: String? = when {
      rawCursor == null || rawCursor.isJsonNull -> null
      rawCursor.isJsonPrimitive -> rawCursor.asString
      else -> null
    }
    val size = data?.get("size")?.asInt
    val append = cursor != null
    ApplicationManager.getApplication().executeOnPooledThread {
      val result = client.listSessions(cursor, size)
      if (result == null) {
        sendSessionListFallback()
        return@executeOnPooledThread
      }
      // ACP spec: result has `sessions: SessionInfo[]` and optional `nextCursor`.
      // Tolerate legacy shape (`items`, `mtime`, `prompt`, ...) for forward/backward compat.
      val rawItems = result.getAsJsonArray("sessions")
        ?: result.getAsJsonArray("items")
        ?: JsonArray()
      val sessions = JsonArray()
      for (item in rawItems) {
        val obj = item.asJsonObject
        val sessionId = obj.get("sessionId")?.asString
          ?: obj.get("id")?.asString
          ?: continue
        val title = obj.get("title")?.asString
          ?: obj.get("name")?.asString
          ?: obj.get("prompt")?.asString
          ?: sessionTitles[sessionId]
          ?: "Untitled Session"
        sessionTitles[sessionId] = title
        sessionMetadata[sessionId] = obj

        val meta = obj.getAsJsonObject("_meta")
        val entry = JsonObject().apply {
          addProperty("id", sessionId)
          addProperty("sessionId", sessionId)
          addProperty("title", title)
          addProperty("name", title)
          obj.get("startTime")?.takeUnless { it.isJsonNull }?.let { add("startTime", it) }
          // Prefer ACP `updatedAt`, fall back to legacy `mtime`/`lastUpdated`.
          val lastUpdated = obj.get("updatedAt")
            ?: obj.get("mtime")
            ?: obj.get("lastUpdated")
          if (lastUpdated != null && !lastUpdated.isJsonNull) add("lastUpdated", lastUpdated)
          val messageCount = meta?.get("messageCount")
            ?: obj.get("messageCount")
          if (messageCount != null && !messageCount.isJsonNull) add("messageCount", messageCount)
          obj.get("filePath")?.takeUnless { it.isJsonNull }?.let { add("filePath", it) }
          obj.get("cwd")?.takeUnless { it.isJsonNull }?.let { add("cwd", it) }
        }
        sessions.add(entry)
      }
      val nextCursorEl = result.get("nextCursor")
      val nextCursor = if (nextCursorEl == null || nextCursorEl.isJsonNull) {
        JsonNull.INSTANCE
      } else {
        nextCursorEl
      }
      val hasMore = nextCursorEl != null && !nextCursorEl.isJsonNull
      val response = JsonObject().apply {
        add("sessions", sessions)
        addProperty("append", append)
        add("nextCursor", nextCursor)
        addProperty("hasMore", hasMore)
      }
      sendToWebView("nessySessionList", response)
    }
  }

  private fun sendSessionListFallback() {
    val sessions = JsonArray()
    for ((sessionId, title) in sessionTitles) {
      val entry = JsonObject().apply {
        addProperty("id", sessionId)
        addProperty("sessionId", sessionId)
        addProperty("title", title)
        addProperty("name", title)
      }
      sessions.add(entry)
    }
    val response = JsonObject().apply {
      add("sessions", sessions)
      addProperty("append", false)
      add("nextCursor", JsonNull.INSTANCE)
      addProperty("hasMore", false)
    }
    sendToWebView("nessySessionList", response)
  }

  private fun switchSession(data: JsonObject?) {
    val sessionId = data?.get("sessionId")?.asString ?: return

    // Cache hit — replay from in-memory cache, no ACP call needed.
    val localMessages = sessionMessages[sessionId]
    if (localMessages != null && client.getSessionId() == sessionId) {
      currentSessionId = sessionId
      isTitleSet = sessionTitles[sessionId]?.let { it != "New Chat" && it.isNotBlank() } ?: false
      val response = JsonObject().apply {
        addProperty("sessionId", sessionId)
        add("messages", gson.toJsonTree(localMessages))
        val title = sessionTitles[sessionId]
        if (title != null) {
          add("session", JsonObject().apply { addProperty("title", title) })
        }
      }
      sendToWebView("nessySessionSwitched", response)
      sendToWebView(
        "sessionLoadComplete",
        JsonObject().apply { addProperty("sessionId", sessionId) },
      )
      return
    }

    ApplicationManager.getApplication().executeOnPooledThread {
      if (!client.connectIfNeeded()) {
        sendAgentConnectionError("CLI not configured or failed to start.")
        return@executeOnPooledThread
      }

      // Step 1: tell the webview to clear the current chat & switch context
      // BEFORE history replay starts — otherwise replayed `message` events
      // arriving during loadSession would land in the previously open chat.
      val title = sessionTitles.getOrPut(sessionId) { "Untitled Session" }
      sendToWebView(
        "nessySessionSwitched",
        JsonObject().apply {
          addProperty("sessionId", sessionId)
          add("messages", JsonArray())
          add("session", JsonObject().apply { addProperty("title", title) })
        },
      )

      // Step 2: arm rehydration routing so onAssistantChunk forwards each
      // replay event as a discrete `message` instead of a stream chunk.
      // Reset the cache so we don't accumulate stale entries on re-load.
      sessionMessages[sessionId] = mutableListOf()
      rehydratingSessionId = sessionId
      currentSessionId = sessionId
      isTitleSet = false
      logger.info("Starting session rehydration for: $sessionId")

      // Step 3: ACP session/load — per spec the agent replays the entire
      // conversation via session/update notifications and only THEN responds
      // to the original load request.
      val metadata = sessionMetadata[sessionId]
      val cwd = metadata?.get("cwd")?.asString
      val loaded = client.loadSession(sessionId, cwd)

      // Step 4: replay is finished by the time loadSession returns.
      // Always clear the flag so subsequent prompts route as stream chunks.
      rehydratingSessionId = null

      if (!loaded) {
        logger.warn("Failed to load session: $sessionId")
      } else {
        logger.info("Session loaded; history replay complete")
      }

      // Step 5: signal the webview that history finished loading regardless
      // of success — UI can drop its loading state and let user interact.
      sendToWebView(
        "sessionLoadComplete",
        JsonObject().apply { addProperty("sessionId", sessionId) },
      )

      refreshModelStateFromClient()
      sendCachedModelState()
    }
  }

  private fun startNewSession(clearHistory: Boolean) {
    ApplicationManager.getApplication().executeOnPooledThread {
      if (!client.connectIfNeeded()) {
        sendAgentConnectionError("CLI not configured or failed to start.")
        return@executeOnPooledThread
      }
      val sessionId = client.createNewSession()
      if (sessionId != null) {
        currentSessionId = sessionId
        isTitleSet = false
        sessionTitles.putIfAbsent(sessionId, "New Chat")
        sessionMessages.putIfAbsent(sessionId, mutableListOf())
        pendingMessages.clear()
        refreshModelStateFromClient()
        sendCachedModelState()
        if (clearHistory) {
          sendToWebView("conversationCleared", JsonObject())
        }
        sendToWebView(
          "nessySessionSwitched",
          JsonObject().apply {
            addProperty("sessionId", sessionId)
            add("messages", JsonArray())
          },
        )
      }
    }
  }

  fun requestNewSession(clearHistory: Boolean = true) {
    pendingNewSession = true
    pendingNewSessionClearHistory = clearHistory
    if (webviewReady) {
      pendingNewSession = false
      startNewSession(clearHistory)
    }
  }

  private fun saveSession(data: JsonObject?) {
    val tag = data?.get("tag")?.asString?.trim().orEmpty()
    if (tag.isEmpty()) return
    ApplicationManager.getApplication().executeOnPooledThread {
      val command = "/chat save \"$tag\""
      val success = client.sendPrompt(command) != null
      val response = JsonObject().apply {
        addProperty("success", success)
        if (success) {
          addProperty("message", "Session saved with tag: $tag")
        } else {
          addProperty("message", "Failed to save session")
        }
      }
      sendToWebView("saveSessionResponse", response)
    }
  }

  private fun setApprovalMode(data: JsonObject?) {
    val modeId = data?.get("modeId")?.asString ?: return
    client.setMode(modeId)
  }

  private fun refreshModelStateFromClient() {
    lastModelState = client.getLastModelState()
  }

  private fun sendCachedModelState() {
    refreshModelStateFromClient()
    val state = lastModelState ?: return

    // Extract availableModels array from state and send in expected format
    val availableModels = state.getAsJsonArray("availableModels")
    if (availableModels != null && availableModels.size() > 0) {
      sendToWebView("availableModels", JsonObject().apply {
        add("models", availableModels)
      })
    }

    // Also send current model ID if available
    val currentModelId = state.get("currentModelId")?.asString
    if (!currentModelId.isNullOrBlank()) {
      val currentModel = availableModels?.firstOrNull {
        it.asJsonObject?.get("modelId")?.asString == currentModelId
      }
      if (currentModel != null) {
        sendToWebView("modelInfo", currentModel)
      }
    }
  }

  private fun handleSetModel(data: JsonObject?) {
    val modelId = data?.get("modelId")?.asString?.trim().orEmpty()
    if (modelId.isBlank()) return
    ApplicationManager.getApplication().executeOnPooledThread {
      val success = client.setModel(modelId)
      ApplicationManager.getApplication().invokeLater {
        sendToWebView("setModelResponse", JsonObject().apply {
          addProperty("success", success)
          addProperty("modelId", modelId)
        })
        if (success) {
          // Refresh model state from client
          refreshModelStateFromClient()
          sendCachedModelState()
          // Also send immediate modelInfo update to ensure webview has the latest model
          // This is needed because getLastModelState() might return stale cached data
          sendToWebView("modelInfo", JsonObject().apply {
            addProperty("modelId", modelId)
            addProperty("name", modelId)
          })
        }
      }
    }
  }

  private fun cancelStreaming() {
    if (streamActive) {
      client.cancelSession()
      sendStreamEnd("user_cancelled", currentRequestId)
    }
  }

  private fun handlePermissionResponse(data: JsonObject?) {
    if (data == null) return
    val cancelled = data.get("cancelled")?.asBoolean ?: false
    val optionId = if (cancelled) "cancel" else (data.get("optionId")?.asString ?: return)
    val answers = if (cancelled) null else data.getAsJsonObject("answers")
    client.resolvePermission(optionId, answers)
    project.getService(IdeMcpServerService::class.java).closeAllDiffs()
    sendToWebView("permissionResolved", JsonObject())
  }

  private fun handleAskUserQuestionResponse(data: JsonObject?) {
    if (data == null) return
    val cancelled = data.get("cancelled")?.asBoolean ?: false
    val optionId = if (cancelled) "cancel" else (data.get("optionId")?.asString ?: "proceed_once")
    val answers = if (cancelled) null else data.getAsJsonObject("answers")
    client.resolvePermission(optionId, answers)
    sendToWebView("askUserQuestionResolved", JsonObject().apply {
      addProperty("optionId", optionId)
    })
  }

  private fun handleDeleteSession(data: JsonObject?) {
    if (data == null) return
    val sessionId = data.get("sessionId")?.asString ?: return
    val success = client.deleteSession(sessionId)
    sendToWebView("deleteSessionResponse", JsonObject().apply {
      addProperty("success", success)
      addProperty("sessionId", sessionId)
    })
  }

  private fun handleRenameSession(data: JsonObject?) {
    if (data == null) return
    val sessionId = data.get("sessionId")?.asString ?: return
    val title = data.get("title")?.asString ?: return
    val success = client.renameSession(sessionId, title)
    sendToWebView("renameSessionResponse", JsonObject().apply {
      addProperty("success", success)
      addProperty("sessionId", sessionId)
      addProperty("title", title)
    })
  }

  private fun handleRewindSession(data: JsonObject?) {
    if (data == null) return
    val targetTurnIndex = data.get("targetTurnIndex")?.asInt ?: return
    val result = client.rewindSession(targetTurnIndex)
    sendToWebView("rewindSessionResponse", JsonObject().apply {
      addProperty("success", result != null)
      if (result != null) add("result", result)
    })
  }

  private fun handleLogin() {
    ApplicationManager.getApplication().executeOnPooledThread {
      client.authenticate()
      sendAuthState(true)
      sendToWebView("loginSuccess", JsonObject())
    }
  }

  private fun handlePanelTitleUpdate(data: JsonObject?) {
    val title = data?.get("title")?.asString?.trim().orEmpty()
    if (title.isBlank()) return
    val app = ApplicationManager.getApplication()
    if (app.isDispatchThread) {
      titleUpdater?.invoke(title)
    } else {
      app.invokeLater { titleUpdater?.invoke(title) }
    }
  }

  private fun sendToWebView(type: String, data: JsonElement?, sync: Boolean = false) {
    val payload = JsonObject().apply {
      addProperty("type", type)
      if (data != null) {
        add("data", data)
      }
    }
    postToWebView(payload, sync)
  }

  private fun postToWebView(message: JsonObject, sync: Boolean) {
    val browserRef = browser ?: return
    val json = gson.toJson(message)
    val script = "window.postMessage($json, '*');"
    val app = ApplicationManager.getApplication()
    if (sync && app.isDispatchThread) {
      browserRef.cefBrowser.executeJavaScript(script, browserRef.cefBrowser.url, 0)
      return
    }
    if (sync) {
      app.invokeLater {
        browserRef.cefBrowser.executeJavaScript(script, browserRef.cefBrowser.url, 0)
      }
      return
    }
    app.invokeLater {
      browserRef.cefBrowser.executeJavaScript(script, browserRef.cefBrowser.url, 0)
    }
  }

  private fun appendMessageToSession(message: JsonObject) {
    val sessionId = currentSessionId
    if (sessionId == null) {
      pendingMessages.add(message)
      return
    }
    sessionMessages.getOrPut(sessionId) { mutableListOf() }.add(message)
  }

  override fun onAssistantChunk(text: String, isThought: Boolean, sessionId: String?) {
    // During session rehydration, route messages as discrete messages instead of stream chunks
    // Check sessionId match to ensure we're replaying history for the correct session
    if (rehydratingSessionId != null && sessionId == rehydratingSessionId) {
      // This is history replay - add as a regular message
      val role = if (text.startsWith("User: ")) "user" else "assistant"
      val content = if (text.startsWith("User: ")) text.substring(6) else text

      val message = JsonObject().apply {
        addProperty("role", role)
        addProperty("content", content)
        addProperty("timestamp", System.currentTimeMillis())
      }

      // Cache the message
      sessionMessages.getOrPut(rehydratingSessionId!!) { mutableListOf() }.add(message)

      // Send to WebView as a discrete message
      logger.info("Sending rehydrated message: role=$role, content=${content.take(50)}...")
      sendToWebView("message", message)
      return
    }

    // Normal streaming mode
    val data = JsonObject().apply { addProperty("chunk", text) }
    if (isThought) {
      logger.info("Sending thoughtChunk: ${text.take(50)}...")
      sendToWebView("thoughtChunk", data)
    } else {
      streamBuffer.append(text)
      logger.info("Sending streamChunk: ${text.take(50)}... (buffer size=${streamBuffer.length})")
      sendToWebView("streamChunk", data)
    }
  }

  override fun onInitialized(info: JsonObject) {
    val modes = info.getAsJsonObject("modes") ?: return
    val payload = JsonObject().apply {
      val currentMode = modes.get("currentModeId")
      val available = modes.get("availableModes")
      if (currentMode != null) {
        add("currentModeId", currentMode)
      }
      if (available != null) {
        add("availableModes", available)
      }
    }
    if (!webviewReady) {
      pendingModeInfo = payload
      return
    }
    sendToWebView("modeInfo", payload)
  }

  override fun onAuthUpdate(uri: String) {
    logger.info("ACP auth update: $uri")
    sendAuthState(false)
  }

  override fun onError(message: String) {
    logger.warn("ACP error: $message")
    sendToWebView("error", JsonObject().apply { addProperty("message", message) })
    val lower = message.lowercase()
    if (lower.contains("authentication required") || lower.contains("unauthorized")) {
      sendAuthState(false)
    }
    if (lower.contains("failed to start cli") || lower.contains("bundled cli not found")) {
      queueAgentConnectionError(message)
    }
  }

  override fun onStatus(message: String) {
    logger.info("ACP status: $message")
    if (message.equals("Connected", ignoreCase = true)) {
      maybeSendAgentConnected()
    }
  }

  override fun onSessionUpdate(update: JsonObject) {
    val updateContent = update.getAsJsonObject("update") ?: return
    val type = updateContent.get("sessionUpdate")?.asString ?: return
    val meta = updateContent.getAsJsonObject("_meta")

    when (type) {
      "agent_message_chunk", "agent_thought_chunk" -> {
        // Extract and send usage stats from metadata
        if (meta != null) {
          val usage = meta.getAsJsonObject("usage")
          // Map field names from CLI (inputTokens, outputTokens, etc.) to plugin format
          val promptTokens = usage?.get("inputTokens")?.asInt
          val completionTokens = usage?.get("outputTokens")?.asInt
          val thoughtsTokens = usage?.get("thoughtTokens")?.asInt
          val totalTokens = usage?.get("totalTokens")?.asInt
          val cachedTokens = usage?.get("cachedReadTokens")?.asInt
          
          val durationMs = meta.get("durationMs")?.asLong
          val tokenLimit = meta.get("tokenLimit")?.asInt
          
          val usageStats = UsageStats(
            promptTokens = promptTokens,
            completionTokens = completionTokens,
            thoughtsTokens = thoughtsTokens,
            totalTokens = totalTokens,
            cachedTokens = cachedTokens
          )
          
          val payload = UsageStatsPayload(
            usage = usageStats,
            durationMs = durationMs,
            tokenLimit = tokenLimit
          )
          
          // Send usage stats directly to webview
          sendToWebView("usageStats", gson.toJsonTree(payload))

          // Extract and send model info if available
          val modelId = meta.get("modelId")?.asString
          val modelName = meta.get("modelName")?.asString
          val metaInfo = meta.getAsJsonObject("_meta")

          val modelMetaMap = if (metaInfo != null) {
            val mapType = object : TypeToken<Map<String, Any>>() {}.type
            gson.fromJson<Map<String, Any>>(metaInfo, mapType)
          } else {
            null
          }

          val hasModelId = !modelId.isNullOrBlank()
          val hasModelName = !modelName.isNullOrBlank()
          if (hasModelId || hasModelName) {
            val modelInfo = ModelInfo(
              modelId = modelId,
              name = modelName,
              _meta = modelMetaMap
            )
            
            // Send model info directly to webview
            sendToWebView("modelInfo", gson.toJsonTree(modelInfo))
          }
        }
      }
      "tool_call", "tool_call_update" -> {
        // Add explicit type field for VSCode webview compatibility
        val toolCallData = JsonObject().apply {
          addProperty("type", type)  // 'tool_call' or 'tool_call_update'
          // Copy all fields from updateContent
          updateContent.entrySet().forEach { entry ->
            add(entry.key, entry.value)
          }
        }
        sendToWebView("toolCall", toolCallData)
      }
      "plan" -> {
        sendToWebView("plan", JsonObject().apply {
          add("entries", updateContent.get("entries"))
        })
      }
      "current_mode_update" -> {
        val modeId = updateContent.get("modeId")?.asString ?: return
        sendToWebView("modeChanged", JsonObject().apply { addProperty("modeId", modeId) })
      }
      "current_model_update" -> {
        val model = updateContent.getAsJsonObject("model") ?: return
        sendToWebView("modelInfo", model)
        val modelId = model.get("modelId")?.asString
        if (!modelId.isNullOrBlank()) {
          lastModelState?.addProperty("currentModelId", modelId)
        }
      }
      "available_commands_update" -> {
        val commands = updateContent.getAsJsonArray("availableCommands") ?: JsonArray()
        cachedAvailableCommands = commands
        sendToWebView("availableCommands", JsonObject().apply { add("commands", commands) })
      }
      "confirm_action" -> {
        val prompt = updateContent.get("prompt")?.asString
          ?: "This action requires confirmation. Proceed?"
        val originalInvocation = updateContent.getAsJsonObject("originalInvocation")
          ?: JsonObject()
        sendToWebView("confirm_action", JsonObject().apply {
          addProperty("prompt", prompt)
          add("originalInvocation", originalInvocation)
        })
      }
    }
  }

  override fun onPermissionRequest(request: JsonObject) {
    // Check if this is an ask_user_question wrapped in permission request
    val options = request.getAsJsonArray("options")
    val optionWithQuestions = options
      ?.mapNotNull { it as? JsonObject }
      ?.firstOrNull { opt ->
        val q = opt.getAsJsonArray("questions")
        q != null && q.size() > 0
      }

    if (optionWithQuestions != null) {
      // Delegate to onAskUserQuestion
      onAskUserQuestion(request)
    } else {
      // Regular permission request
      sendToWebView("permissionRequest", request)
    }
  }

  override fun onPermissionResolved(optionId: String) {
    sendToWebView("permissionResolved", JsonObject().apply {
      addProperty("optionId", optionId)
    })
  }

// [nessy-fork] acp-elicitation-ask-user-question
override fun onAskUserQuestion(request: JsonObject) {
    val sessionId = request.get("sessionId")?.asString
    // [nessy-fork] acp-elicitation-ask-user-question
    // Questions may arrive top-level (elicitation path) or nested under
    // `toolCall.rawInput.questions` (legacy `session/ask_user_question` /
    // `session/request_permission` path, matching the VSCode plugin).
    var questions = request.getAsJsonArray("questions")
    if (questions == null || questions.size() == 0) {
      val rawInput = request.getAsJsonObject("toolCall")?.getAsJsonObject("rawInput")
      questions = rawInput?.getAsJsonArray("questions")
    }
    val metadata = request.getAsJsonObject("metadata")
      ?: request.getAsJsonObject("toolCall")?.getAsJsonObject("rawInput")?.getAsJsonObject("metadata")

    val payload = JsonObject().apply {
      if (sessionId != null) addProperty("sessionId", sessionId)
      if (questions != null && questions.size() > 0) add("questions", questions)
      if (metadata != null) add("metadata", metadata)
    }
    sendToWebView("askUserQuestion", payload)
  }
}
