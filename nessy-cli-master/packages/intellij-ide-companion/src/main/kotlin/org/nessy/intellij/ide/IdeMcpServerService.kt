package org.nessy.intellij.ide

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectRootManager
import java.io.BufferedWriter
import java.io.OutputStreamWriter
import java.net.InetSocketAddress
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import org.nessy.intellij.AcpClientService
import java.io.File

@Service(Service.Level.PROJECT)
class IdeMcpServerService(private val project: Project) : Disposable {
  private val logger = Logger.getInstance(IdeMcpServerService::class.java)
  private val gson = Gson()
  private val sessions = ConcurrentHashMap<String, Session>()
  private val authToken = UUID.randomUUID().toString()
  private var server: HttpServer? = null
  private var port: Int = 0
  private val executor = Executors.newCachedThreadPool()
  private val openFilesManager = IdeOpenFilesManager(project, this)
  private val diffManager = IdeDiffManager(
    project,
    onAccepted = { path, content -> notifyDiffAccepted(path, content) },
    onRejected = { path -> notifyDiffRejected(path) },
    onClosed = { path, content -> notifyDiffClosed(path, content) },
  )

  init {
    openFilesManager.addListener { broadcastIdeContext() }
    start()
  }

  fun getPort(): Int = port

  fun getAuthToken(): String = authToken

  fun getWorkspacePath(): String {
    val roots = ProjectRootManager.getInstance(project).contentRoots
    if (roots.isEmpty()) {
      return project.basePath ?: ""
    }
    return roots.joinToString(separator = File.pathSeparator) { it.path }
  }

  fun showDiff(filePath: String, oldContent: String?, newContent: String) {
    diffManager.showDiff(filePath, oldContent, newContent)
  }

  fun closeAllDiffs(suppressNotification: Boolean = true) {
    diffManager.closeAll(suppressNotification)
  }

  override fun dispose() {
    stop()
    executor.shutdownNow()
  }

  private fun start() {
    if (server != null) return
    // Use dynamic port (0) to support multiple projects
    val address = InetSocketAddress("127.0.0.1", 0)
    val httpServer = HttpServer.create(address, 0)
    httpServer.executor = executor
    httpServer.createContext("/mcp") { exchange -> handleRequest(exchange) }
    httpServer.start()
    server = httpServer
    port = httpServer.address.port
    writeLockFile()
    logger.info("IDE MCP server listening on http://127.0.0.1:$port")
  }

  private fun stop() {
    server?.stop(0)
    server = null
    // Don't delete lock file here - CLI will clean up stale files via ppid check
    // This prevents race conditions where CLI tries to connect while file is being deleted
    // deleteLockFile()
  }

  private fun handleRequest(exchange: HttpExchange) {
    try {
      if (!isAuthorized(exchange)) {
        sendPlain(exchange, 401, "Unauthorized")
        return
      }
      when (exchange.requestMethod.uppercase()) {
        "POST" -> handlePost(exchange)
        "GET" -> handleGet(exchange)
        else -> sendJson(
          exchange,
          405,
          errorResponse(-32000, "Method not allowed"),
        )
      }
    } catch (e: Exception) {
      logger.warn("Failed to handle MCP request: ${e.message}", e)
      sendJson(
        exchange,
        500,
        errorResponse(-32603, "Internal server error"),
      )
    }
  }

  private fun handlePost(exchange: HttpExchange) {
    val accept = exchange.requestHeaders.getFirst("Accept") ?: ""
    if (!accept.contains("application/json") || !accept.contains("text/event-stream")) {
      sendJson(exchange, 406, errorResponse(-32000, "Not Acceptable: missing Accept header"))
      return
    }
    val contentType = exchange.requestHeaders.getFirst("Content-Type") ?: ""
    if (!contentType.contains("application/json")) {
      sendJson(exchange, 415, errorResponse(-32000, "Unsupported Media Type"))
      return
    }

    val body = exchange.requestBody.readBytes().toString(StandardCharsets.UTF_8)
    val payload = runCatching { gson.fromJson(body, JsonElement::class.java) }.getOrNull()
    if (payload == null) {
      sendJson(exchange, 400, errorResponse(-32700, "Parse error: Invalid JSON"))
      return
    }

    val messages = when {
      payload.isJsonArray -> payload.asJsonArray.toList()
      payload.isJsonObject -> listOf(payload)
      else -> emptyList()
    }
    if (messages.isEmpty()) {
      sendJson(exchange, 400, errorResponse(-32600, "Invalid JSON-RPC message"))
      return
    }

    val isInit = messages.any { it.isJsonObject && it.asJsonObject.get("method")?.asString == "initialize" }
    val sessionIdHeader = exchange.requestHeaders.getFirst("mcp-session-id")
    if (!isInit) {
      if (sessionIdHeader.isNullOrEmpty()) {
        sendJson(exchange, 400, errorResponse(-32000, "Missing mcp-session-id header"))
        return
      }
      if (!sessions.containsKey(sessionIdHeader)) {
        sendJson(exchange, 404, errorResponse(-32000, "Invalid session"))
        return
      }
      val protocolVersion = exchange.requestHeaders.getFirst("mcp-protocol-version")
      if (protocolVersion.isNullOrEmpty()) {
        sendJson(exchange, 400, errorResponse(-32000, "Missing mcp-protocol-version header"))
        return
      }
    }

    val responses = JsonArray()
    for (message in messages) {
      val obj = message.asJsonObject
      val id = obj.get("id")
      if (id == null || id.isJsonNull) {
        handleNotification(obj)
        continue
      }
      val response = handleRequestMessage(obj)
      responses.add(response)
    }

    if (responses.size() == 0) {
      exchange.sendResponseHeaders(202, -1)
      exchange.close()
      return
    }

    val responsePayload = if (responses.size() == 1) responses[0] else responses
    val headers = mutableMapOf<String, String>()
    if (isInit) {
      val newSessionId = UUID.randomUUID().toString()
      sessions.putIfAbsent(newSessionId, Session(newSessionId))
      headers["mcp-session-id"] = newSessionId
    }
    sendJson(exchange, 200, responsePayload, headers)
  }

  private fun handleGet(exchange: HttpExchange) {
    val accept = exchange.requestHeaders.getFirst("Accept") ?: ""
    if (!accept.contains("text/event-stream")) {
      sendJson(exchange, 406, errorResponse(-32000, "Not Acceptable: client must accept text/event-stream"))
      return
    }
    val sessionId = exchange.requestHeaders.getFirst("mcp-session-id")
    if (sessionId.isNullOrEmpty() || !sessions.containsKey(sessionId)) {
      sendJson(exchange, 400, errorResponse(-32000, "Invalid or missing session ID"))
      return
    }

    exchange.responseHeaders.add("Content-Type", "text/event-stream")
    exchange.responseHeaders.add("Cache-Control", "no-cache")
    exchange.responseHeaders.add("Connection", "keep-alive")
    exchange.responseHeaders.add("mcp-session-id", sessionId)
    exchange.sendResponseHeaders(200, 0)
    val writer = BufferedWriter(OutputStreamWriter(exchange.responseBody, StandardCharsets.UTF_8))
    val session = sessions[sessionId]
    if (session != null) {
      session.attachStream(writer, exchange)
      broadcastIdeContext()
    }
  }

  private fun handleNotification(message: JsonObject) {
    when (message.get("method")?.asString) {
      "notifications/initialized" -> broadcastIdeContext()
    }
  }

  private fun handleRequestMessage(message: JsonObject): JsonObject {
    val method = message.get("method")?.asString ?: ""
    val id = message.get("id")

    val result = when (method) {
      "initialize" -> buildInitializeResult(message.getAsJsonObject("params"))
      "tools/list" -> buildToolsList()
      "tools/call" -> handleToolCall(message.getAsJsonObject("params"))
      "ping" -> JsonObject()
      else -> return errorResponse(-32601, "Method not found", id)
    }

    return JsonObject().apply {
      addProperty("jsonrpc", "2.0")
      add("id", id)
      add("result", result)
    }
  }

  private fun buildInitializeResult(params: JsonObject?): JsonObject {
    val protocolVersion = params?.get("protocolVersion")?.asString ?: "2025-03-26"
    return JsonObject().apply {
      addProperty("protocolVersion", protocolVersion)
      add(
        "capabilities",
        JsonObject().apply {
          add("tools", JsonObject())
        },
      )
      add(
        "serverInfo",
        JsonObject().apply {
          addProperty("name", "nessy-jetbrains-mcp")
          addProperty("version", "1.0.0")
        },
      )
    }
  }

  private fun buildToolsList(): JsonObject {
    val tools = JsonArray()
    tools.add(
      JsonObject().apply {
        addProperty("name", "openDiff")
        addProperty(
          "description",
          "(IDE Tool) Open a diff view to create or modify a file.",
        )
        add(
          "inputSchema",
          JsonObject().apply {
            addProperty("type", "object")
            add(
              "properties",
              JsonObject().apply {
                add("filePath", JsonObject().apply { addProperty("type", "string") })
                add("newContent", JsonObject().apply { addProperty("type", "string") })
              },
            )
            add(
              "required",
              JsonArray().apply {
                add("filePath")
                add("newContent")
              },
            )
          },
        )
      },
    )
    tools.add(
      JsonObject().apply {
        addProperty("name", "closeDiff")
        addProperty(
          "description",
          "(IDE Tool) Close an open diff view for a specific file.",
        )
        add(
          "inputSchema",
          JsonObject().apply {
            addProperty("type", "object")
            add(
              "properties",
              JsonObject().apply {
                add("filePath", JsonObject().apply { addProperty("type", "string") })
                add(
                  "suppressNotification",
                  JsonObject().apply { addProperty("type", "boolean") },
                )
              },
            )
            add(
              "required",
              JsonArray().apply {
                add("filePath")
              },
            )
          },
        )
      },
    )
    tools.add(
      JsonObject().apply {
        addProperty("name", "openFile")
        addProperty(
          "description",
          "(IDE Tool) Open a file in the editor, optionally navigating to a specific line and column.",
        )
        add(
          "inputSchema",
          JsonObject().apply {
            addProperty("type", "object")
            add(
              "properties",
              JsonObject().apply {
                add("filePath", JsonObject().apply { addProperty("type", "string") })
                add("line", JsonObject().apply { addProperty("type", "number") })
                add("column", JsonObject().apply { addProperty("type", "number") })
              },
            )
            add(
              "required",
              JsonArray().apply {
                add("filePath")
              },
            )
          },
        )
      },
    )
    tools.add(
      JsonObject().apply {
        addProperty("name", "setCommitMessage")
        addProperty(
          "description",
          "(IDE Tool) Set the commit message in the IDE's commit panel.",
        )
        add(
          "inputSchema",
          JsonObject().apply {
            addProperty("type", "object")
            add(
              "properties",
              JsonObject().apply {
                add("message", JsonObject().apply { addProperty("type", "string") })
              },
            )
            add(
              "required",
              JsonArray().apply {
                add("message")
              },
            )
          },
        )
      },
    )
    return JsonObject().apply {
      add("tools", tools)
    }
  }

  private fun handleToolCall(params: JsonObject?): JsonObject {
    val name = params?.get("name")?.asString ?: return toolError("Missing tool name")
    val args = params.getAsJsonObject("arguments")
    return when (name) {
      "openDiff" -> {
        val filePath = args?.get("filePath")?.asString
        val newContent = args?.get("newContent")?.asString
        if (filePath.isNullOrEmpty() || newContent == null) {
          toolError("Missing filePath or newContent")
        } else {
          diffManager.showDiff(filePath, newContent)
          JsonObject().apply { add("content", JsonArray()) }
        }
      }
      "closeDiff" -> {
        val filePath = args?.get("filePath")?.asString
        if (filePath.isNullOrEmpty()) {
          toolError("Missing filePath")
        } else {
          val suppress = args?.get("suppressNotification")?.asBoolean ?: false
          val content = diffManager.closeDiff(filePath, suppress)
          val payload = JsonObject().apply {
            if (content == null) {
              add("content", JsonNull.INSTANCE)
            } else {
              addProperty("content", content)
            }
          }
          JsonObject().apply {
            add(
              "content",
              JsonArray().apply {
                add(
                  JsonObject().apply {
                    addProperty("type", "text")
                    addProperty("text", gson.toJson(payload))
                  },
                )
              },
            )
          }
        }
      }
      "openFile" -> {
        val filePath = args?.get("filePath")?.asString
        if (filePath.isNullOrEmpty()) {
          toolError("Missing filePath")
        } else {
          val line = args?.get("line")?.asInt
          val column = args?.get("column")?.asInt
          openFileInEditor(filePath, line, column)
        }
      }
      "setCommitMessage" -> {
        val message = args?.get("message")?.asString
        if (message.isNullOrEmpty()) {
          toolError("Missing message")
        } else {
          setCommitMessageInIde(message)
        }
      }
      else -> toolError("Unknown tool: $name")
    }
  }

  private fun openFileInEditor(filePath: String, line: Int?, column: Int?): JsonObject {
    val virtualFile = com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByPath(filePath)
      ?: return toolError("File not found: $filePath")
    val latch = java.util.concurrent.CountDownLatch(1)
    com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
      try {
        val editors = com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(virtualFile, true)
        if (line != null) {
          val textEditor = editors.firstOrNull { it is com.intellij.openapi.fileEditor.TextEditor } as? com.intellij.openapi.fileEditor.TextEditor
          textEditor?.editor?.let { editor ->
            val logicalLine = (line - 1).coerceAtLeast(0)
            val logicalColumn = ((column ?: 1) - 1).coerceAtLeast(0)
            editor.caretModel.moveToLogicalPosition(com.intellij.openapi.editor.LogicalPosition(logicalLine, logicalColumn))
            editor.scrollingModel.scrollToCaret(com.intellij.openapi.editor.ScrollType.CENTER)
          }
        }
      } finally {
        latch.countDown()
      }
    }
    latch.await(5, java.util.concurrent.TimeUnit.SECONDS)
    return JsonObject().apply { add("content", JsonArray()) }
  }

  private fun setCommitMessageInIde(message: String): JsonObject {
    val latch = java.util.concurrent.CountDownLatch(1)
    var errorMsg: String? = null
    com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
      try {
        val toolWindow = com.intellij.openapi.wm.ToolWindowManager.getInstance(project).getToolWindow("Commit")
        if (toolWindow == null) {
          errorMsg = "Commit tool window not found"
          return@invokeLater
        }
        toolWindow.activate {
          val commitMessages = com.intellij.util.ui.UIUtil.findComponentsOfType(
            toolWindow.component,
            com.intellij.openapi.vcs.ui.CommitMessage::class.java,
          )
          val commitMessage = commitMessages.firstOrNull()
          if (commitMessage != null) {
            commitMessage.setCommitMessage(message)
          } else {
            errorMsg = "CommitMessage component not found in Commit panel"
          }
        }
      } catch (e: Exception) {
        errorMsg = "Failed to set commit message: ${e.message}"
      } finally {
        latch.countDown()
      }
    }
    latch.await(5, java.util.concurrent.TimeUnit.SECONDS)
    return if (errorMsg != null) {
      toolError(errorMsg!!)
    } else {
      JsonObject().apply { add("content", JsonArray()) }
    }
  }

  private fun toolError(message: String): JsonObject {
    return JsonObject().apply {
      addProperty("isError", true)
      add(
        "content",
        JsonArray().apply {
          add(
            JsonObject().apply {
              addProperty("type", "text")
              addProperty("text", message)
            },
          )
        },
      )
    }
  }

  private fun notifyDiffAccepted(filePath: String, content: String) {
    sendNotification(
      JsonObject().apply {
        addProperty("jsonrpc", "2.0")
        addProperty("method", "ide/diffAccepted")
        add(
          "params",
          JsonObject().apply {
            addProperty("filePath", filePath)
            addProperty("content", content)
          },
        )
      },
    )
    val resolved = project.getService(AcpClientService::class.java)
      .resolvePendingPermissionFromDiff("allow")
    if (resolved) {
      logger.info("Resolved pending ACP permission after diff accept: $filePath")
    }
  }

  private fun notifyDiffRejected(filePath: String) {
    sendNotification(
      JsonObject().apply {
        addProperty("jsonrpc", "2.0")
        addProperty("method", "ide/diffRejected")
        add(
          "params",
          JsonObject().apply {
            addProperty("filePath", filePath)
          },
        )
      },
    )
    val resolved = project.getService(AcpClientService::class.java)
      .resolvePendingPermissionFromDiff("cancel")
    if (resolved) {
      logger.info("Resolved pending ACP permission after diff reject: $filePath")
    }
  }

  private fun notifyDiffClosed(filePath: String, content: String?) {
    sendNotification(
      JsonObject().apply {
        addProperty("jsonrpc", "2.0")
        addProperty("method", "ide/diffClosed")
        add(
          "params",
          JsonObject().apply {
            addProperty("filePath", filePath)
            if (content != null) {
              addProperty("content", content)
            }
          },
        )
      },
    )
  }

  private fun broadcastIdeContext() {
    sendNotification(
      JsonObject().apply {
        addProperty("jsonrpc", "2.0")
        addProperty("method", "ide/contextUpdate")
        add("params", openFilesManager.toJson())
      },
    )
  }

  private fun sendNotification(notification: JsonObject) {
    sessions.values.forEach { it.send(notification, gson) }
  }

  private fun isAuthorized(exchange: HttpExchange): Boolean {
    val authHeader = exchange.requestHeaders.getFirst("Authorization") ?: return false
    val parts = authHeader.split(" ")
    return parts.size == 2 && parts[0] == "Bearer" && parts[1] == authToken
  }

  private fun errorResponse(code: Int, message: String, id: JsonElement? = JsonNull.INSTANCE): JsonObject {
    return JsonObject().apply {
      addProperty("jsonrpc", "2.0")
      add(
        "error",
        JsonObject().apply {
          addProperty("code", code)
          addProperty("message", message)
        },
      )
      add("id", id ?: JsonNull.INSTANCE)
    }
  }

  private fun sendPlain(exchange: HttpExchange, code: Int, body: String) {
    exchange.sendResponseHeaders(code, body.toByteArray().size.toLong())
    exchange.responseBody.use { it.write(body.toByteArray()) }
  }

  private fun sendJson(
    exchange: HttpExchange,
    code: Int,
    payload: JsonElement,
    headers: Map<String, String> = emptyMap(),
  ) {
    val bytes = gson.toJson(payload).toByteArray(StandardCharsets.UTF_8)
    exchange.responseHeaders.add("Content-Type", "application/json")
    headers.forEach { (key, value) -> exchange.responseHeaders.add(key, value) }
    exchange.sendResponseHeaders(code, bytes.size.toLong())
    exchange.responseBody.use { it.write(bytes) }
  }

  private fun writeLockFile() {
    val lockFile = getLockFilePath()
    logger.info("Writing lock file to: $lockFile")
    
    val ideProductName = System.getProperty("idea.product.name", "IntelliJ IDEA")
    val ideDisplayName = when {
      ideProductName.contains("IntelliJ", ignoreCase = true) -> "IntelliJ IDEA"
      ideProductName.contains("WebStorm", ignoreCase = true) -> "WebStorm"
      ideProductName.contains("PyCharm", ignoreCase = true) -> "PyCharm"
      ideProductName.contains("GoLand", ignoreCase = true) -> "GoLand"
      ideProductName.contains("RubyMine", ignoreCase = true) -> "RubyMine"
      ideProductName.contains("PhpStorm", ignoreCase = true) -> "PhpStorm"
      ideProductName.contains("CLion", ignoreCase = true) -> "CLion"
      ideProductName.contains("Rider", ignoreCase = true) -> "Rider"
      ideProductName.contains("DataGrip", ignoreCase = true) -> "DataGrip"
      else -> "JetBrains IDE"
    }
    logger.info("IDE product name: $ideProductName, display name: $ideDisplayName")
    
    val content = JsonObject().apply {
      addProperty("port", port)
      addProperty("workspacePath", getWorkspacePath())
      addProperty("ppid", ProcessHandle.current().pid())
      addProperty("authToken", authToken)
      add(
        "ideInfo",
        JsonObject().apply {
          addProperty("name", "jetbrains")
          addProperty("displayName", ideDisplayName)
        },
      )
      addProperty("ideName", ideDisplayName)
    }
    val contentStr = gson.toJson(content)
    logger.info("Lock file content: $contentStr")
    
    try {
      Files.createDirectories(lockFile.parent)
      logger.info("Created directories: ${lockFile.parent}")
      Files.writeString(lockFile, contentStr)
      logger.info("Successfully wrote lock file: $lockFile")
    } catch (e: Exception) {
      logger.error("Failed to write IDE lock file: ${e.message}", e)
    }
  }

  private fun deleteLockFile() {
    val lockFile = getLockFilePath()
    runCatching { Files.deleteIfExists(lockFile) }
  }

  private fun getLockFilePath(): Path {
    val home = System.getProperty("user.home")
    val baseDir = if (!home.isNullOrBlank()) Path.of(home, ".nessy") else Path.of(System.getProperty("java.io.tmpdir"), ".nessy")
    return baseDir.resolve("ide").resolve("$port.lock")
  }

  private data class Session(
    val id: String,
  ) {
    @Volatile private var writer: BufferedWriter? = null
    @Volatile private var exchange: HttpExchange? = null
    private val gson = Gson()

    fun attachStream(writer: BufferedWriter, exchange: HttpExchange) {
      this.writer = writer
      this.exchange = exchange
    }

    fun send(notification: JsonObject, gson: Gson) {
      val currentWriter = writer ?: return
      try {
        val payload = gson.toJson(notification)
        currentWriter.write("event: message\n")
        currentWriter.write("data: $payload\n\n")
        currentWriter.flush()
      } catch (_: Exception) {
        close()
      }
    }
    
    /**
     * Send a message to the webview
     */
    fun sendMessage(type: String, data: Any?) {
      val currentWriter = writer ?: return
      try {
        val message = JsonObject().apply {
          addProperty("type", type)
          if (data != null) {
            add("data", gson.toJsonTree(data))
          } else {
            add("data", JsonNull.INSTANCE)
          }
        }
        val payload = gson.toJson(message)
        currentWriter.write("event: message\n")
        currentWriter.write("data: $payload\n\n")
        currentWriter.flush()
      } catch (_: Exception) {
        close()
      }
    }

    private fun close() {
      try {
        exchange?.close()
      } catch (_: Exception) {
        // ignore
      }
      writer = null
      exchange = null
    }
  }
}
