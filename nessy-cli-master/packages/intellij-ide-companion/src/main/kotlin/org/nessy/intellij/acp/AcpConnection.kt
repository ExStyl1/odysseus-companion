package org.nessy.intellij.acp

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.openapi.diagnostic.Logger
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class AcpConnection(
  private val onAssistantChunk: (String, String?) -> Unit,
  private val onThoughtChunk: (String) -> Unit,
  private val onAuthUpdate: (String) -> Unit,
  private val onInitialized: (JsonObject) -> Unit,
  private val onStatus: (String) -> Unit,
  private val onError: (String) -> Unit,
  private val onSessionUpdate: (JsonObject) -> Unit,
  private val onPermissionRequest: (JsonObject) -> JsonObject,
  private val onAskUserQuestion: (JsonObject) -> JsonObject,
  private val defaultCwd: String = System.getProperty("user.dir"),
) {
  private val logger = Logger.getInstance(AcpConnection::class.java)
  private val gson = Gson()
  private val nextId = AtomicInteger(1)
  private val pending = ConcurrentHashMap<Int, CompletableFuture<JsonObject>>()
  private val executor = Executors.newCachedThreadPool()
  private val listSessionsInFlight =
    AtomicReference<CompletableFuture<JsonObject?>?>()

  @Volatile private var connected = false
  @Volatile private var initialized = false

  private var process: Process? = null
  private var writer: BufferedWriter? = null
  private val writeLock = Any()
  private var sessionId: String? = null
  private var lastModelState: JsonObject? = null
  private val initFuture = CompletableFuture<Boolean>()

  fun connect(
    cliPath: String,
    nodePath: String?,
    workingDir: String,
    envOverrides: Map<String, String> = emptyMap(),
  ) {
    if (connected) return

    val command = nodePath?.ifEmpty { "node" } ?: "node"
    val args = listOf(cliPath, "--acp", "--channel=JetBrains")
    val env = buildMap {
      put("JB_IDE_NAME", System.getProperty("idea.product.name", "IntelliJ IDEA"))
      put("JB_TERMINAL_SESSION_ID", java.util.UUID.randomUUID().toString())
      put("NESSY_RUNTIME_DIR", "${System.getProperty("user.home")}/.nessy")
      putAll(envOverrides)
    }

    try {
      val builder = ProcessBuilder(listOf(command) + args)
        .directory(File(workingDir))
        .redirectInput(ProcessBuilder.Redirect.PIPE)
        .redirectOutput(ProcessBuilder.Redirect.PIPE)
        .redirectError(ProcessBuilder.Redirect.PIPE)
      builder.environment().putAll(env)

      val cliProcess = builder.start()
      process = cliProcess
      writer = BufferedWriter(
        OutputStreamWriter(cliProcess.outputStream, StandardCharsets.UTF_8),
      )
      connected = true
      startStdoutReader(cliProcess)
      startStderrReader(cliProcess)
      startExitWatcher(cliProcess)
    } catch (e: Exception) {
      onError("Failed to start CLI: ${e.message}")
      completeInitialization(false)
      return
    }

    onStatus("CLI started: ${(listOf(command) + args).joinToString(" ")}")

    val initOk = initialize()
    initialized = initOk
    completeInitialization(initOk)
  }

  fun isConnected(): Boolean = connected

  fun hasActiveSession(): Boolean = sessionId != null

  fun getSessionId(): String? = sessionId

  fun getLastModelState(): JsonObject? = lastModelState

  fun isInitialized(): Boolean = initialized

  fun awaitInitialized(timeoutMs: Long = 10000): Boolean {
    if (initialized) return true
    return try {
      initFuture.get(timeoutMs, TimeUnit.MILLISECONDS)
    } catch (_: Exception) {
      false
    }
  }

  fun newSession(cwd: String): String? {
    val params = JsonObject().apply {
      addProperty("cwd", cwd)
      add("mcpServers", gson.toJsonTree(emptyList<Any>()))
    }

    val result = sendRequest(AcpProtocol.AgentMethods.SESSION_NEW, params)
    if (result == null) {
      onError("Failed to create session.")
      return null
    }

    sessionId = result.get("sessionId")?.asString
    result.getAsJsonObject("models")?.let { lastModelState = it }
    onStatus("Session created: ${sessionId ?: "unknown"}")
    return sessionId
  }

  fun loadSession(sessionId: String, cwd: String): Boolean {
    val params = JsonObject().apply {
      addProperty("sessionId", sessionId)
      addProperty("cwd", cwd)
      add("mcpServers", gson.toJsonTree(emptyList<Any>()))
    }

    val result = sendRequest(
      AcpProtocol.AgentMethods.SESSION_LOAD,
      params,
      timeoutSeconds = null,
    )
      ?: run {
        onError("Failed to load session.")
        return false
      }

    this.sessionId = sessionId
    result.getAsJsonObject("models")?.let { lastModelState = it }
    onStatus("Session loaded: $sessionId")
    return true
  }

  fun listSessions(cwd: String, cursor: String?, size: Int?): JsonObject? {
    val coalesce = cursor == null
    if (coalesce) {
      val existing = listSessionsInFlight.get()
      if (existing != null) {
        return try {
          existing.get(60, TimeUnit.SECONDS)
        } catch (e: Exception) {
          logger.info("Coalesced listSessions wait failed: ${e.message}")
          null
        }
      }
    }

    val ownFuture = if (coalesce) CompletableFuture<JsonObject?>() else null
    if (ownFuture != null && !listSessionsInFlight.compareAndSet(null, ownFuture)) {
      val winner = listSessionsInFlight.get()
      if (winner != null) {
        return try {
          winner.get(60, TimeUnit.SECONDS)
        } catch (e: Exception) {
          logger.info("Coalesced listSessions wait failed: ${e.message}")
          null
        }
      }
    }

    val params = JsonObject().apply {
      addProperty("cwd", cwd)
      if (cursor != null) {
        addProperty("cursor", cursor)
      }
      if (size != null) {
        add("_meta", JsonObject().apply { addProperty("size", size) })
      }
    }

    val result = try {
      sendRequest(
        AcpProtocol.AgentMethods.SESSION_LIST,
        params,
        silent = true,
      )
    } finally {
      if (ownFuture != null) {
        listSessionsInFlight.compareAndSet(ownFuture, null)
      }
    }

    ownFuture?.complete(result)
    return result
  }

  fun sendPrompt(prompt: String): String? {
    val activeSession = sessionId
    if (activeSession == null) {
      onError("No active session. Create a session first.")
      return null
    }

    val textBlock = JsonObject().apply {
      addProperty("type", "text")
      addProperty("text", prompt)
    }
    val params = JsonObject().apply {
      addProperty("sessionId", activeSession)
      add("prompt", gson.toJsonTree(listOf(textBlock)))
    }

    val result = sendRequest(
      AcpProtocol.AgentMethods.SESSION_PROMPT,
      params,
      timeoutSeconds = null,
    )
      ?: run {
        onError("Prompt failed.")
        return null
      }
    val stopReason = result.get("stopReason")?.asString
      ?: result.get("stop_reason")?.asString
    return stopReason
  }

  fun authenticate(methodId: String? = null) {
    val params = JsonObject().apply {
      if (!methodId.isNullOrEmpty()) {
        addProperty("methodId", methodId)
      }
    }
    sendRequest(AcpProtocol.AgentMethods.AUTHENTICATE, params)
  }

  fun setMode(modeId: String) {
    val activeSession = sessionId ?: return
    val params = JsonObject().apply {
      addProperty("sessionId", activeSession)
      addProperty("modeId", modeId)
    }
    sendRequest(AcpProtocol.AgentMethods.SESSION_SET_MODE, params)
  }

  fun cancelSession() {
    val activeSession = sessionId ?: return
    val params = JsonObject().apply {
      addProperty("sessionId", activeSession)
    }
    try {
      sendNotification(AcpProtocol.AgentMethods.SESSION_CANCEL, params)
    } catch (e: Exception) {
      onError("Request failed: ${e.message}")
    }
  }

  fun deleteSession(sessionId: String): Boolean {
    val params = JsonObject().apply {
      addProperty("sessionId", sessionId)
      addProperty("cwd", defaultCwd)
    }
    return sendRequest(AcpProtocol.AgentMethods.SESSION_DELETE, params)
      ?.get("success")
      ?.asBoolean ?: false
  }

  fun renameSession(sessionId: String, title: String): Boolean {
    val params = JsonObject().apply {
      addProperty("sessionId", sessionId)
      addProperty("title", title)
      addProperty("cwd", defaultCwd)
    }
    return sendRequest(AcpProtocol.AgentMethods.SESSION_RENAME, params)
      ?.get("success")
      ?.asBoolean ?: false
  }

  fun rewindSession(targetTurnIndex: Int): JsonObject? {
    val activeSession = sessionId ?: return null
    val params = JsonObject().apply {
      addProperty("sessionId", activeSession)
      addProperty("targetTurnIndex", targetTurnIndex)
      addProperty("cwd", defaultCwd)
    }
    return sendRequest(AcpProtocol.AgentMethods.SESSION_REWIND, params)
  }

  fun restoreSessionHistory(history: JsonArray): Boolean {
    val activeSession = sessionId ?: return false
    val params = JsonObject().apply {
      addProperty("sessionId", activeSession)
      add("history", history)
      addProperty("cwd", defaultCwd)
    }
    return sendRequest(
      AcpProtocol.AgentMethods.SESSION_RESTORE_HISTORY,
      params,
    ) != null
  }

  fun getAccountInfo(): JsonObject? {
    val activeSession = sessionId ?: return null
    val params = JsonObject().apply {
      addProperty("sessionId", activeSession)
    }
    return sendRequest(AcpProtocol.AgentMethods.GET_ACCOUNT_INFO, params)
  }

  fun setModel(modelId: String): Boolean {
    val activeSession = sessionId ?: return false
    val params = JsonObject().apply {
      addProperty("sessionId", activeSession)
      addProperty("modelId", modelId)
    }
    return sendRequest(AcpProtocol.AgentMethods.SESSION_SET_MODEL, params) != null
  }

  private fun initialize(): Boolean {
    val params = JsonObject().apply {
      addProperty("protocolVersion", 1)
      add("clientCapabilities", JsonObject().apply {
        add("fs", JsonObject().apply {
          addProperty("readTextFile", true)
          addProperty("writeTextFile", true)
        })
        // The plugin renders `elicitation/create` (form mode) forms, so the
        // agent may use standard elicitation for `ask_user_question`.
        // [nessy-fork] acp-elicitation-ask-user-question
        add("elicitation", JsonObject().apply {
          add("form", JsonObject())
        })
      })
    }

    val result = sendRequest(AcpProtocol.AgentMethods.INITIALIZE, params)
      ?: run {
        onError("Failed to initialize ACP session.")
        return false
      }
    onInitialized(result)
    onStatus("Connected")
    return true
  }

  private fun sendRequest(
    method: String,
    params: JsonObject?,
    silent: Boolean = false,
    timeoutSeconds: Long? = 60,
  ): JsonObject? {
    val id = nextId.getAndIncrement()
    val request = JsonObject().apply {
      addProperty("jsonrpc", AcpProtocol.JSONRPC_VERSION)
      addProperty("id", id)
      addProperty("method", method)
      if (params != null) {
        add("params", params)
      }
    }

    val future = CompletableFuture<JsonObject>()
    pending[id] = future
    sendMessage(request)

    return try {
      val response = if (timeoutSeconds == null) {
        future.get()
      } else {
        future.get(timeoutSeconds, TimeUnit.SECONDS)
      }
      val error = response.getAsJsonObject("error")
      if (error != null) {
        val message = error.get("message")?.asString ?: "$method error"
        if (silent) {
          logger.info("$method returned error: $message")
        } else {
          onError(message)
        }
        return null
      }
      val result = response.get("result")
      if (result != null && result.isJsonObject) result.asJsonObject else JsonObject()
    } catch (e: Exception) {
      val message = requestFailureMessage(method, e)
      if (silent) {
        logger.info("Request '$method' failed silently: $message")
      } else {
        onError("Request failed: $message")
      }
      null
    } finally {
      pending.remove(id)
    }
  }

  private fun requestFailureMessage(method: String, e: Exception): String =
    when (e) {
      is TimeoutException -> "Request '$method' timed out."
      else -> e.message ?: e.javaClass.simpleName
    }

  private fun sendNotification(method: String, params: JsonObject?) {
    val notification = JsonObject().apply {
      addProperty("jsonrpc", AcpProtocol.JSONRPC_VERSION)
      addProperty("method", method)
      if (params != null) {
        add("params", params)
      }
    }
    sendMessage(notification)
  }

  private fun sendMessage(message: JsonObject) {
    val line = gson.toJson(message) + "\n"
    synchronized(writeLock) {
      try {
        writer?.write(line)
        writer?.flush()
      } catch (e: Exception) {
        onError("Failed to send message: ${e.message}")
      }
    }
  }

  private fun startStdoutReader(cliProcess: Process) {
    executor.execute {
      try {
        BufferedReader(
          InputStreamReader(cliProcess.inputStream, StandardCharsets.UTF_8),
        ).use { reader ->
          val buffer = StringBuilder()
          val chunk = CharArray(4096)
          var read: Int
          while (reader.read(chunk).also { read = it } != -1) {
            buffer.append(chunk, 0, read)
            var newlineIndex = buffer.indexOf("\n")
            while (newlineIndex >= 0) {
              val line = buffer.substring(0, newlineIndex)
              buffer.delete(0, newlineIndex + 1)
              handleJsonLine(line)
              newlineIndex = buffer.indexOf("\n")
            }
          }
          handleJsonLine(buffer.toString())
        }
      } catch (e: Exception) {
        logger.info("ACP stdout reader stopped: ${e.message}")
      }
    }
  }

  private fun handleJsonLine(line: String) {
    val trimmedLine = line.trim()
    if (trimmedLine.isEmpty()) return

    try {
      val json = gson.fromJson(trimmedLine, JsonObject::class.java)
      handleMessage(json)
    } catch (_: Exception) {
      onStatus("Non-JSON line (ignored): ${trimmedLine.take(200)}")
    }
  }

  private fun handleMessage(message: JsonObject) {
    if (message.has("method")) {
      handleRequestOrNotification(message)
    } else if (message.has("id")) {
      val id = message.get("id").asInt
      val future = pending[id]
      if (future != null) {
        future.complete(message)
      }
    }
  }

  private fun handleRequestOrNotification(message: JsonObject) {
    val method = message.get("method")?.asString ?: return
    val params = message.getAsJsonObject("params") ?: JsonObject()
    val id = message.get("id")?.asInt

    try {
      when (method) {
        AcpProtocol.ClientMethods.SESSION_UPDATE -> {
          handleSessionUpdate(params)
        }
        AcpProtocol.ClientMethods.AUTHENTICATE_UPDATE -> {
          val meta = params.getAsJsonObject("_meta")
          val uri = meta?.get("authUri")?.asString
          if (!uri.isNullOrEmpty()) {
            onAuthUpdate(uri)
          }
        }
        AcpProtocol.ClientMethods.SESSION_REQUEST_PERMISSION -> {
          if (id != null) sendResponse(id, handlePermissionRequest(params))
        }
        AcpProtocol.ClientMethods.SESSION_ASK_USER_QUESTION -> {
          if (id != null) sendResponse(id, handleAskUserQuestion(params))
        }
        // [nessy-fork] acp-elicitation-ask-user-question
        AcpProtocol.ClientMethods.SESSION_REQUEST_ELICITATION -> {
          if (id != null) sendResponse(id, handleElicitation(params))
        }
        AcpProtocol.ClientMethods.FS_READ_TEXT_FILE -> {
          if (id != null) {
            val path = params.get("path")?.asString.orEmpty()
            sendResponse(id, handleReadTextFile(path))
          }
        }
        AcpProtocol.ClientMethods.FS_WRITE_TEXT_FILE -> {
          if (id != null) {
            val path = params.get("path")?.asString.orEmpty()
            val content = params.get("content")?.asString.orEmpty()
            sendResponse(id, handleWriteTextFile(path, content))
          }
        }
        else -> {
          if (id != null) sendErrorResponse(id, -32601, "Method not supported: $method")
        }
      }
    } catch (e: Exception) {
      logger.warn("ACP handler failed for $method: ${e.message}")
      if (id != null) {
        sendErrorResponse(id, -32603, e.message ?: "Internal error")
      }
    }
  }

  private fun handlePermissionRequest(params: JsonObject): JsonObject {
    val resolution = try {
      handlePermissionRequestWithMapping(params)
    } catch (e: Exception) {
      logger.warn("handlePermissionRequest error: ${e.message}")
      JsonObject().apply { addProperty("optionId", "allow_once") }
    }
    val optionId = resolution.get("optionId")?.asString ?: "allow_once"
    val answers = resolution.getAsJsonObject("answers")
    return JsonObject().apply {
      add("outcome", JsonObject().apply {
        addProperty("outcome", "selected")
        addProperty("optionId", optionId)
      })
      if (answers != null && !answers.isJsonNull && answers.entrySet().isNotEmpty()) {
        add("answers", answers)
      }
    }
  }

  private fun handleAskUserQuestion(params: JsonObject): JsonObject {
    val resolution = try {
      onAskUserQuestion(params)
    } catch (e: Exception) {
      logger.warn("handleAskUserQuestion error: ${e.message}")
      JsonObject().apply { addProperty("optionId", "cancel") }
    }
    val optionId = resolution.get("optionId")?.asString ?: "cancel"
    val answers = resolution.getAsJsonObject("answers")
    return JsonObject().apply {
      addProperty("optionId", optionId)
      if (answers != null && !answers.isJsonNull && answers.entrySet().isNotEmpty()) {
        add("answers", answers)
      }
    }
  }

  /**
   * ACP `elicitation/create` (form mode) — the standard mechanism the agent
   * uses for `ask_user_question` when the client advertises
   * `clientCapabilities.elicitation.form`. Converts `requestedSchema` back
   * into the `questions` shape the existing dialog renders, then returns an
   * `{ action, content? }` response.
   */
  // [nessy-fork] acp-elicitation-ask-user-question
  private fun handleElicitation(params: JsonObject): JsonObject {
    // [nessy-fork] acp-elicitation-ask-user-question
    val mode = params.get("mode")?.asString
    if (mode != "form" || !params.has("sessionId")) {
      return JsonObject().apply { addProperty("action", "cancel") }
    }
    val schema = params.getAsJsonObject("requestedSchema")
    val questions = schema?.let { requestedSchemaToQuestions(it) } ?: JsonArray()
    val askParams = JsonObject().apply {
      params.get("sessionId")?.let { add("sessionId", it) }
      add("questions", questions)
    }
    val resolution = try {
      onAskUserQuestion(askParams)
    } catch (e: Exception) {
      logger.warn("handleElicitation error: ${e.message}")
      return JsonObject().apply { addProperty("action", "cancel") }
    }
    val optionId = resolution.get("optionId")?.asString
    if (optionId == null || optionId == "cancel" || optionId.contains("reject")) {
      return JsonObject().apply { addProperty("action", "cancel") }
    }
    val answers = resolution.getAsJsonObject("answers")
    return JsonObject().apply {
      addProperty("action", "accept")
      if (answers != null && !answers.isJsonNull && answers.entrySet().isNotEmpty()) {
        add("content", answers)
      }
    }
  }

  /** Inverse of the CLI's JSON Schema mapping: schema properties → questions. */
  private fun requestedSchemaToQuestions(schema: JsonObject): JsonArray {
    val properties = schema.getAsJsonObject("properties") ?: JsonObject()
    val questions = JsonArray()
    for ((key, value) in properties.entrySet()) {
      if (!value.isJsonObject) continue
      val prop = value.asJsonObject
      val type = prop.get("type")?.asString
      val title = prop.get("title")?.asString ?: key
      val description = prop.get("description")?.asString ?: title
      val options = JsonArray()
      prop.getAsJsonArray("enum")?.forEach { label ->
        if (label.isJsonPrimitive && label.asString.isNotBlank()) {
          options.add(JsonObject().apply {
            addProperty("label", label.asString)
            addProperty("description", label.asString)
          })
        }
      }
      questions.add(JsonObject().apply {
        addProperty("question", description)
        addProperty("header", title)
        add("options", options)
        if (type == "array") addProperty("multiSelect", true)
      })
    }
    return questions
  }

  /**
   * Handle permission request with kind -> optionId mapping.
   * VSCode compatibility: map "allow_once" kind to actual optionId from options array.
   */
  private fun handlePermissionRequestWithMapping(params: JsonObject): JsonObject {
    val options = params.getAsJsonArray("options")
    if (options != null) {
      for (i in 0 until options.size()) {
        val option = options.get(i).asJsonObject
        val questions = option.getAsJsonArray("questions")
        if (questions != null && questions.size() > 0) {
          return onAskUserQuestion(params)
        }
      }
    }

    val resolution = onPermissionRequest(params)
    val requestedOptionId = resolution.get("optionId")?.asString
      ?: params.get("preferredKind")?.asString
      ?: "allow_once"
    val resolvedOptionId = resolvePermissionOptionId(params, requestedOptionId)

    return resolution.deepCopy().apply {
      addProperty("optionId", resolvedOptionId)
    }
  }

  /**
   * Resolve optionId from kind, matching VSCode behavior.
   * Searches options array for matching kind or optionId.
   */
  private fun resolvePermissionOptionId(
    params: JsonObject,
    preferredKind: String = "allow_once",
  ): String {
    val options = params.getAsJsonArray("options") ?: return "allow_once"

    for (i in 0 until options.size()) {
      val option = options.get(i).asJsonObject
      val optionId = option.get("optionId")?.asString
      if (optionId == preferredKind) {
        return optionId
      }
      val kind = option.get("kind")?.asString
      if (kind == preferredKind) {
        return optionId ?: kind
      }
    }

    for (i in 0 until options.size()) {
      val option = options.get(i).asJsonObject
      val optionId = option.get("optionId")?.asString ?: continue
      if (optionId.contains("proceed_once") || optionId.contains("allow_once")) {
        return optionId
      }
    }

    return options.get(0).asJsonObject.get("optionId")?.asString ?: "allow_once"
  }

  private fun handleSessionUpdate(params: JsonObject?) {
    if (params == null) return

    val updateElement = params.get("update") ?: return
    val activeSessionId = params.get("sessionId")?.asString
    val type = if (updateElement.isJsonObject) {
      updateElement.asJsonObject.get("sessionUpdate")?.asString
    } else {
      null
    }

    logger.info("Session update: type=$type, sessionId=$activeSessionId")

    onSessionUpdate(params)

    if (!updateElement.isJsonObject) {
      logger.info("Session update with non-JsonObject update field, skipping detailed handling")
      return
    }

    val update = updateElement.asJsonObject
    val updateType = update.get("sessionUpdate")?.asString ?: return

    when (updateType) {
      "agent_message_chunk" -> {
        val content = update.getAsJsonObject("content")
        val text = content?.get("text")?.asString
        logger.info("Agent message chunk: text=${text?.take(50)}...")
        if (!text.isNullOrEmpty()) onAssistantChunk(text, activeSessionId)
      }
      "agent_thought_chunk" -> {
        val content = update.getAsJsonObject("content")
        val text = content?.get("text")?.asString
        logger.info("Agent thought chunk: text=${text?.take(50)}...")
        if (!text.isNullOrEmpty()) onThoughtChunk(text)
      }
      "user_message_chunk" -> {
        val content = update.getAsJsonObject("content")
        val text = content?.get("text")?.asString
        if (!text.isNullOrEmpty()) {
          logger.info("User message chunk (replay): text=${text.take(50)}...")
          onAssistantChunk("User: $text", activeSessionId)
        }
      }
      "tool_call", "tool_call_update" -> {
        logger.info("Tool call update: type=$updateType")
      }
      else -> {
        logger.info("Unhandled session update type: $updateType")
      }
    }
  }

  private fun handleReadTextFile(path: String): JsonObject {
    return try {
      val content = Files.readString(Path.of(path))
      JsonObject().apply {
        addProperty("content", content)
      }
    } catch (e: Exception) {
      val errorContent = when (e) {
        is java.nio.file.NoSuchFileException -> "ERROR: ENOENT: $path"
        else -> "ERROR: ${e.message ?: "Failed to read file"}"
      }
      JsonObject().apply {
        addProperty("content", errorContent)
      }
    }
  }

  private fun handleWriteTextFile(path: String, content: String): JsonObject {
    return try {
      Files.writeString(Path.of(path), content)
      JsonObject().apply {
        addProperty("ok", true)
      }
    } catch (e: Exception) {
      JsonObject().apply {
        addProperty("error", e.message ?: "Failed to write file")
      }
    }
  }

  private fun completeInitialization(ok: Boolean) {
    if (!initFuture.isDone) {
      initFuture.complete(ok)
    }
  }

  private fun startStderrReader(cliProcess: Process) {
    executor.execute {
      try {
        BufferedReader(
          InputStreamReader(cliProcess.errorStream, StandardCharsets.UTF_8),
        ).useLines { lines ->
          lines.forEach { line ->
            val trimmed = line.trim()
            if (trimmed.isNotEmpty()) {
              onStatus(trimmed)
            }
          }
        }
      } catch (e: Exception) {
        logger.info("ACP stderr reader stopped: ${e.message}")
      }
    }
  }

  private fun startExitWatcher(cliProcess: Process) {
    val thread = Thread({
      try {
        cliProcess.waitFor()
      } catch (e: Exception) {
        logger.info("ACP process watcher stopped: ${e.message}")
      } finally {
        connected = false
        initialized = false
        pending.forEach { (_, future) ->
          future.completeExceptionally(IllegalStateException("ACP process exited"))
        }
        pending.clear()
        try {
          writer?.close()
        } catch (_: Exception) {
        }
        process = null
        writer = null
        sessionId = null
      }
    }, "nessy-acp-process-watcher")
    thread.isDaemon = true
    thread.start()
  }

  private fun sendResponse(id: Int, result: JsonObject) {
    val response = JsonObject().apply {
      addProperty("jsonrpc", AcpProtocol.JSONRPC_VERSION)
      addProperty("id", id)
      add("result", result)
    }
    sendMessage(response)
  }

  private fun sendErrorResponse(id: Int, code: Int, message: String) {
    val response = JsonObject().apply {
      addProperty("jsonrpc", AcpProtocol.JSONRPC_VERSION)
      addProperty("id", id)
      add("error", JsonObject().apply {
        addProperty("code", code)
        addProperty("message", message)
      })
    }
    sendMessage(response)
  }
}
